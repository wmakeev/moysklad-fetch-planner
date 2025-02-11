/* eslint-disable no-var */

import assert from 'node:assert'
// eslint-disable-next-line n/no-unpublished-import
import type { RequestInfo, RequestInit, Request, Response } from 'undici'

//#region debug function
var debug: ((scope: string, msg: string) => void) | null = null
const DEBUG = process.env['DEBUG']

const MODULE_NAME = 'moysklad-fetch-planner'

/* c8 ignore start */
if (typeof DEBUG === 'string' && DEBUG.includes(MODULE_NAME)) {
  const items = DEBUG.split(',')
    .map(it => it.trim())
    .filter(it => it !== '' && it.startsWith(MODULE_NAME))

  if (items[0] === `${MODULE_NAME}:noop`) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    debug = () => {}
  }
  //
  else if (items.length > 0) {
    debug = (scope, msg) => {
      console.debug(`[${MODULE_NAME}:${scope}] ${msg}`)
    }
  }
}
/* c8 ignore stop */
//#endregion

/**
 * Код для ошибки `Превышено ограничение на одновременное количество запросов`.
 * Этот код передается в заголовке ответа `X-Lognex-Auth`
 */
const LOGNEX_PARALLEL_LIMIT_OVERFLOW_ERROR_CODE = '429005'

/**
 * `Превышено ограничение на количество запросов в единицу времени`
 */
// const LOGNEX_RATE_LIMIT_OVERFLOW_ERROR_CODE = '429002'

// TODO Нужно еще учитывать PARALLEL_LIMIT_OVERFLOW и накидывать определенный
// коэффициент на задержку если были ошибки в неком окне в прошлом и запрещать
// увеличивать лимит при пересмотре.

/**
 * Тип результата выполнения запроса
 */
const ResponseTypes = {
  /** Запрос выполнен без ошибок */
  OK: 'OK',

  /** Запрос не выполнен по причине превышения лимита `X-RateLimit-Limit` */
  RATE_LIMIT_OVERFLOW: 'RATE_LIMIT_OVERFLOW',

  /** Запрос не выполнен по причине превышения лимита параллельных запросов */
  PARALLEL_LIMIT_OVERFLOW: 'PARALLEL_LIMIT_OVERFLOW'
} as const

type ResponseType = keyof typeof ResponseTypes

/**
 * Параметры http запроса (Action) для отправки в очередь планировщика
 */
interface FetchAction {
  actionId: number
  url: RequestInfo
  options?: RequestInit | undefined
  resolve: (val: unknown) => void
  reject: (err: Error) => void
}

/**
 * Параметры триггера который должен вызывать функцию `resolve` в момент когда
 * появляются свободные слоты в очереди запросов `actionsQueue`.
 */
interface RequestSlotHandler {
  /** Приоритет триггера (меньше число - выше приоритет) */
  priority: number

  /** Разрешить promise на стороне ожидающей триггер */
  resolve: (value: unknown) => void

  /** Выбросить ошибку на стороне ожидающей триггер */
  reject: (err: Error) => void
}

/** Событие с информацией о выполняемом запросе */
export interface RequestEvent {
  /** Id задачи в планировщике */
  actionId: number

  /**
   * Id отдельного запроса.
   * Одна задача может выполнятся несколько раз при повторе в случае ошибки
   */
  requestId: number

  /** Строка запроса */
  url: string | URL | Request

  /** Время начала запроса */
  startTime: number
}

/** Событие с информацией о выполненном запросе */
export interface ResponseEvent extends RequestEvent {
  /**
   * Тип запроса:
   *
   * - `OK` - успешный запрос
   * - `RATE_LIMIT_OVERFLOW` - ошибка 429 TooManyRequests
   * - `PARALLEL_LIMIT_OVERFLOW` - ошибка превышения лимита параллельных запросов
   */
  responseType: ResponseType

  /** Время получения ответа */
  endTime: number
}

/**
 * Обработчик событий
 */
export interface FetchPlannerEventHandler {
  /**
   * Событие `request` вызывается в момент выполнения запроса
   *
   * @see {@link RequestEvent}
   */
  emit(eventName: 'request', data: RequestEvent, instance: FetchPlanner): void

  /**
   * Событие `response` вызывается после получения ответа на запрос
   *
   * @see {@link ResponseEvent}
   */
  emit(eventName: 'response', data: ResponseEvent, instance: FetchPlanner): void
}

export interface FetchPlannerEventMap {
  request: [RequestEvent, FetchPlanner]
  response: [ResponseEvent, FetchPlanner]
}

/**
 * [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
 */
type Fetch = (url: RequestInfo, init?: RequestInit) => Promise<Response>

const RateLimitHeaderSetterByName = {
  'x-lognex-retry-timeInterval': function (val) {
    this.retryTimeInterval = val
  },
  'x-ratelimit-limit': function (val) {
    this.rateLimit = val
  },
  'x-ratelimit-remaining': function (val) {
    this.rateLimitRemaining = val
  }
} satisfies Record<string, (this: FetchPlanner, value: number) => void>

/**
 * Параметры планировщика запросов
 */
export interface FetchPlannerOptions {
  /**
   * Обработчик событий планировщика.
   *
   * Должен соответствовать следующему минимальному интерфейсу:
   *
   * ```typescript
   * interface EventHandler {
   *   emit(eventName: string, data?: any): void
   * }
   * ```
   *
   * Можно использовать для логирования, сбора статистики и анализа нагрузки
   * на API.
   *
   * @see {@link FetchPlannerEventHandler} детальное описание событий
   */
  eventHandler?: FetchPlannerEventHandler | undefined

  /**
   * Коэффициент регулирующий интенсивность тротлинга запросов в зависимости
   * от доступных в текущий момент лимитов.
   *
   * *Процент оставшегося лимита запросов можно рассчитать как отношение значений
   * в заголовках ответа API `X-RateLimit-Remaining` к `X-RateLimit-Limit`.*
   *
   * При минимальном значении коэффициента `throttlingCoefficient` равном `1`
   * задержка нарастает линейно от `0` мс при 100% лимита до
   * `maxRequestDelayTimeMs` мс при 0% лимита.
   *
   * При значении коэффициента больше `1`, задержка начинает нарастать нелинейно,
   * уменьшая задержку при лимитах близких к 100% и увеличивая при уменьшении
   * лимита.
   *
   * Например если коэффициент равен `10`, то тротлинга практически не будет
   * вплоть до ~20% от лимита, а далее начнется резкое увеличение задержки до
   * `maxRequestDelayTimeMs`.
   *
   * **По умолчанию:** `5` (допускается значение от 1 до 10)
   *
   * **Рекомендации:**
   *
   * - Если известно, что приложение будет работать в окружении других параллельных
   * задач, разделяющих между собой лимит запросов, то имеет смысл установить
   * меньший коэффициент в диапазоне от 1 до 4.
   *
   * - Если приложение самостоятельно разделяет доступные лимиты и важна
   * максимальная производительность для серий последовательных запросов, когда
   * задержка минимальна в первые секунды и начинает нарастать уже при сохранении
   * нагрузки, то можно увеличивать коэффициент.
   *
   * Важно понимать, что, вне зависимости от размера коэффициента, при постоянной
   * интенсивной нагрузке на API задержка всегда выходит на одно и то же среднее
   * значение примерно равное отношению `X-Lognex-Retry-TimeInterval` /
   * `X-RateLimit-Limit`.
   */
  throttlingCoefficient: number

  /**
   * Максимальное кол-во параллельных запросов.
   *
   * API позволяет до 5 параллельных запросов, но для большей надежности
   * лучше оставлять небольшой запас.
   *
   * Планировщик умеет определять ситуации, когда приложение сталкивается с
   * лимитом на кол-во параллельных запросов, постепенно уменьшая указанный
   * лимит. Но если на одном аккаунте работает много приложений или приложение интенсивно
   * использует API, то лучше сразу явно ограничить кол-во параллельных запросов
   * до 2-3 или даже меньше.
   *
   * **По умолчанию:** `4` (максимальное значение `5`)
   */
  maxParallelLimit: number

  /**
   * Максимальное время задержки перед выполнением следующего запроса.
   *
   * Устанавливается в случае когда оставшийся лимит равен нулю (либо произошла ошибка превышения лимита на кол-во запросов в единицу времени).
   *
   * Такая ситуация может произойти если:
   * - работает слишком много параллельных приложений
   * - какое-либо параллельное приложение не контролирует лимиты
   *
   * Задержка между запросами всегда лежит в диапазоне от 0 до `maxRequestDelayTimeMs`.
   *
   * **По умолчанию:** `3000` (3 секунды)
   */
  maxRequestDelayTimeMs: number

  /**
   * Доля от значения `maxRequestDelayTimeMs` в пределах которой будет случайным образом изменено значение `maxRequestDelayTimeMs` при расчете величины задержки между запросами.
   *
   * Указание jitter'a (дрожания) способствует более равномерному распределению запросов при одновременной параллельной работе нескольких приложений.
   *
   * **По умолчанию:** `0.1` (Например: Если для `maxRequestDelayTimeMs` указано значение `3000`, то при расчете задержки значение `maxRequestDelayTimeMs` будет случайным образом определяться в диапазоне от `2850` до `3150`)
   */
  jitter: number

  /**
   * Период через который происходим пересмотр допустимого кол-ва параллельных
   * запросов.
   *
   * Лимит уменьшается при каждой ошибке превышения кол-ва параллельных запросов с шагом `1`.
   *
   * Лимит постепенно увеличивается снова до `maxParallelLimit` с шагом `1`
   * через указанный промежуток времени.
   *
   * **По умолчанию:** `10000` (10 секунд)
   */
  parallelLimitCorrectionPeriodMs: number
}

export class FetchPlanner {
  /**
   * Предварительно рассчитанная функция затухания для расчета времени задержки
   * в зависимости от текущего лимита.
   */
  private readonly attenuationFnSteps: number[]

  /**
   * Опции планировщика запросов
   */
  private readonly options: FetchPlannerOptions

  /**
   * Интервал в миллисекундах, в течение которого можно сделать кол-во запросов
   * указанных в заголовке `X-RateLimit-Limit`.
   *
   * Значение приходит в заголовке `X-Lognex-Retry-TimeInterval`.
   */
  protected retryTimeInterval = 3000

  /**
   * Значение заголовка `X-RateLimit-Limit` из последнего
   * полученного ответа сервера.
   *
   * Например: `45` (45 запросов на один интервал `retryTimeInterval`)
   * */
  protected rateLimit: number | null = null

  /**
   * Значение заголовка `X-RateLimit-Remaining` из последнего
   * полученного ответа сервера.
   * */
  protected rateLimitRemaining: number | null = null

  /**
   * Текущее кол-во выполняемых запросов
   */
  private curInflightRequestsCount = 0

  /**
   * Текущая коррекция кол-ва допустимых параллельных запросов.
   *
   * Подобная коррекция может потребоваться если параллельно
   * работает другое приложение которое использует часть лимита параллельных
   * запросов.
   *
   * Принимает значение меньше либо равное нулю.
   */
  private parallelLimitCorrection = 0

  /**
   * Время когда было произведено изменение `parallelLimitCorrection`
   */
  private parallelLimitCorrectionTime = 0

  /**
   * Шаг с которым вводится корректировка для `parallelLimitCorrection`
   */
  private parallelLimitCorrectionStep = 1

  /**
   * Очередь запросов
   */
  private actionsQueue: FetchAction[] = []

  /**
   * Время последней ошибки превышения лимита параллельных запросов
   */
  private lastParallelLimitOverflowTime: number | null = null

  /**
   * Триггеры ожидающие свободных запросов
   */
  private requestSlotHandlers: RequestSlotHandler[] = []

  /**
   * Время и таймер на которые внутри планировка запланирована очередная обработка
   * очереди запросов
   */
  private processActionPlanedTimeout: {
    time: number
    timeout: NodeJS.Timeout
  } | null = null

  /**
   * Порядковый номер последнего запроса отправленного планировщиком к серверу
   */
  private lastRequestNum = 0

  /**
   * Время начала последнего запроса
   */
  private lastRequestStartTime = 0

  /**
   * Порядковый номер последней запроса отправленного пользователем в
   * планировщик
   */
  private lastActionNum = 0

  /**
   * Последняя рассчитанная задержка для запроса. Поле для статистики.
   */
  private lastRequestDelay = 0

  /**
   * Время на которое запланирован следующий запрос.
   * Может изменяться в процессе обработки текущий запросов.
   */
  private nextRequestTime = 0

  /**
   * Конструктор планировщика запросов
   *
   * @param fetchApi Функция с интерфейсом Fetch API, которую будет использовать
   * планировщик для выполнения запросов к серверу
   * @param params Опциональные параметры планировщика
   */
  constructor(
    private fetchApi: Fetch,
    params?: Partial<FetchPlannerOptions>
  ) {
    const optionsDefault: FetchPlannerOptions = {
      eventHandler: undefined,
      throttlingCoefficient: 5,
      maxParallelLimit: 4,
      maxRequestDelayTimeMs: 3000,
      jitter: 0.1,
      parallelLimitCorrectionPeriodMs: 10000
    }

    if (params?.eventHandler != null) {
      assert.ok(
        typeof params.eventHandler === 'object' &&
          'emit' in params.eventHandler &&
          typeof params.eventHandler.emit === 'function',
        'Опция "eventHandler" должна быть объектом с методом "emit"'
      )
      optionsDefault.eventHandler = params.eventHandler
    }

    if (params?.maxParallelLimit !== undefined) {
      assert.ok(
        typeof params.maxParallelLimit === 'number' &&
          params.maxParallelLimit > 0,
        'Опция "maxParallelLimit" должна быть целым числом больше нуля'
      )
      optionsDefault.maxParallelLimit = Math.round(params.maxParallelLimit)
    }

    if (params?.maxRequestDelayTimeMs !== undefined) {
      assert.ok(
        typeof params.maxRequestDelayTimeMs === 'number' &&
          params.maxRequestDelayTimeMs > 0,
        'Опция "maxRequestDelayTimeMs" должна быть целым числом больше 0'
      )
      optionsDefault.maxRequestDelayTimeMs = Math.round(
        params.maxRequestDelayTimeMs
      )
    }

    if (params?.jitter !== undefined) {
      assert.ok(
        typeof params.jitter === 'number' &&
          params.jitter >= 0 &&
          params.jitter <= 0.3,
        'Опция "jitter" должна быть целым числом от 0 до 0.3'
      )
      optionsDefault.jitter = params.jitter
    }

    if (params?.parallelLimitCorrectionPeriodMs !== undefined) {
      assert.ok(
        typeof params.parallelLimitCorrectionPeriodMs === 'number' &&
          params.parallelLimitCorrectionPeriodMs >= 1000,
        'Опция "parallelLimitCorrectionPeriodMs" должна быть целым числом больше либо равным 1000'
      )
      optionsDefault.parallelLimitCorrectionPeriodMs = Math.round(
        params.parallelLimitCorrectionPeriodMs
      )
    }

    if (params?.throttlingCoefficient !== undefined) {
      assert.ok(
        typeof params.throttlingCoefficient === 'number' &&
          params.throttlingCoefficient >= 1 &&
          params.throttlingCoefficient <= 20,
        'Опция "throttlingCoefficient" должна быть числом от 1 до 20'
      )
      optionsDefault.throttlingCoefficient = params.throttlingCoefficient
    }

    this.options = optionsDefault

    this.attenuationFnSteps = Array.from({ length: 101 }, (_, i) =>
      Math.pow(1 - i / 100, optionsDefault.throttlingCoefficient)
    )
  }

  /**
   * Создает идентификатор для очередного запроса пользователя (порядковый номер)
   * @returns Идентификатор запроса
   */
  private getNewActionId() {
    this.lastActionNum++
    return this.lastActionNum
  }

  /**
   * Создает идентификатор для очередного запроса планировщика (порядковый номер)
   * @returns Идентификатор запроса
   */
  private getNewRequestId() {
    this.lastRequestNum++
    return this.lastRequestNum
  }

  /**
   * Возвращает задержку которую необходимо выдержать перед отправкой
   * очередного запроса на сервер
   *
   * @returns Интервал ожидания ms
   */
  private calculateRequestDelayTime() {
    // Если текущие значения X-Lognex-Retry-TimeInterval, X-RateLimit-Limit,
    // X-RateLimit-Remaining не получены, то вероятно мы еще не отправляли
    // запросов. В ожидании нет необходимости.
    if (this.rateLimit === null || this.rateLimitRemaining === null) {
      debug?.('calculateRequestDelayTime', 'no known rate limit')
      return 0
    }

    // Необходимо уменьшать задержку с течением времени после получения
    // последних актуальных заголовков RateLimit
    const timeFromLastRequest = Date.now() - this.lastRequestStartTime
    debug?.(
      'calculateRequestDelayTime',
      `timeFromLastRequest - ${timeFromLastRequest}`
    )

    // Прошло достаточно времени чтобы отменить задержку для запроса
    if (timeFromLastRequest >= this.retryTimeInterval) return 0

    const waterlineCorrection = timeFromLastRequest / this.retryTimeInterval
    debug?.(
      'calculateRequestDelayTime',
      `waterlineCorrection - ${waterlineCorrection}`
    )

    /**
     * Процент оставшегося лимита
     *
     * - `0` - 0% лимита (`X-RateLimit-Remaining = 0`)
     * - `1` - 100% лимита (`X-RateLimit-Remaining = 45`)
     */
    const waterline = this.rateLimitRemaining / this.rateLimit
    debug?.(
      'calculateRequestDelayTime',
      `rateLimitRemaining[${this.rateLimitRemaining}] / rateLimit[${this.rateLimit}] = waterline[${waterline}]`
    )

    const attenuationFnStep = Math.round(
      (waterline + waterlineCorrection) * 100
    )
    debug?.(
      'calculateRequestDelayTime',
      `attenuationFnStep - ${attenuationFnStep}`
    )

    // После корректировки задержка минимальна
    if (attenuationFnStep > 100) {
      debug?.('calculateRequestDelayTime', 'delay - 0')
      return 0
    }

    const k =
      this.attenuationFnSteps[attenuationFnStep] /* c8 ignore next */ ?? 1

    const jitterRange = this.options.maxRequestDelayTimeMs * this.options.jitter

    const jitter = jitterRange / 2 - Math.random() * jitterRange
    debug?.('calculateRequestDelayTime', `jitter - ${jitter}`)

    const delayMs = Math.round(
      k * (this.options.maxRequestDelayTimeMs + jitter)
    )

    debug?.('calculateRequestDelayTime', `delayMs - ${delayMs}`)

    return delayMs
  }

  /**
   * Планирует обработку запроса из очереди в будущем (тротлинг)
   *
   * @param implicitDelayMs Явное указание времени на которое нужно отложить обработку
   * запроса
   */
  private planProcessAction(implicitDelayMs = 0) {
    if (this.actionsQueue.length === 0) {
      debug?.('planProcessAction', 'canceled (empty queue)')
      return
    }

    const calculatedDelayMs = this.calculateRequestDelayTime()

    const delayMs = Math.max(implicitDelayMs, calculatedDelayMs)

    const planTime = Date.now() + delayMs

    debug?.('planProcessAction', `planned after ${delayMs}`)

    this.nextRequestTime = planTime

    if (this.processActionPlanedTimeout) {
      clearTimeout(this.processActionPlanedTimeout.timeout)
    }

    const timeout = setTimeout(() => {
      if (this.processActionPlanedTimeout?.timeout === timeout) {
        this.processActionPlanedTimeout = null
      }

      if (this.nextRequestTime === planTime) {
        this.nextRequestTime = 0
      }

      if (!this.shouldProcessAction()) {
        debug?.('planProcessAction', 'processAction skipped')
        return
      }

      this.lastRequestDelay = delayMs

      this.processAction()
    }, delayMs)

    this.processActionPlanedTimeout = {
      time: planTime,
      timeout
    }
  }

  /**
   * Вызывает триггеры ожидающие свободные слоты для выполнения запросов
   */
  protected checkFreeRequestSlotTrigger() {
    if (this.requestSlotHandlers[0] == null) return

    /** Общее кол-во выполняемых запросов и запросов ожидающих очереди */
    const totalIncompleteRequests =
      this.actionsQueue.length + this.curInflightRequestsCount

    // Есть место для нового запроса?
    if (
      totalIncompleteRequests >=
      this.options.maxParallelLimit + this.parallelLimitCorrection
    ) {
      return
    }

    let handlerIndex = 0
    let handlerPriority = this.requestSlotHandlers[0].priority

    for (const [index, h] of this.requestSlotHandlers.entries()) {
      if (h.priority < handlerPriority) {
        handlerIndex = index
        handlerPriority = h.priority
      }
    }

    this.requestSlotHandlers.splice(handlerIndex, 1)[0]?.resolve(undefined)

    if (this.requestSlotHandlers.length > 0) {
      setImmediate(() => {
        this.checkFreeRequestSlotTrigger()
      })
    }
  }

  private rejectFreeRequestSlotTriggers(err: Error) {
    this.requestSlotHandlers.forEach(it => {
      it.reject(err)
    })
  }

  private parseNumberHeader(headers: Response['headers'], headerName: string) {
    const headerValue = headers.get(headerName)

    if (headerValue == null) return null

    const parsedHeaderValue = Number.parseInt(headerValue)

    if (Number.isNaN(parsedHeaderValue)) {
      throw new Error(
        `Некорректный формат заголовка ${headerName} - "${headerValue}"`
      )
    }

    return parsedHeaderValue
  }

  private parseRateLimitHeader(
    headers: Response['headers'],
    headerName: keyof typeof RateLimitHeaderSetterByName
  ) {
    const setter = RateLimitHeaderSetterByName[headerName]

    const value = this.parseNumberHeader(headers, headerName)

    if (value == null) return

    setter.call(this, value)
  }

  /**
   * Увеличивает лимит параллельных запросов, если он был ранее занижен по
   * причине превышения лимита.
   */
  private reviewParallelLimitCorrection() {
    const now = Date.now()

    const periodStart =
      now -
      this.options.parallelLimitCorrectionPeriodMs *
        // Jitter для равномерного распределения времени коррекции между разными
        // экземплярами планировщика, которые могут работать параллельно
        (1 + 2 * Math.random() * this.options.jitter)

    /** Пора ли провести коррекцию? */
    const shouldCorrect =
      this.parallelLimitCorrection < 0 &&
      this.parallelLimitCorrectionTime < periodStart

    if (!shouldCorrect) return

    this.parallelLimitCorrectionTime = now

    // За прошлый период была ошибка. Отмена коррекции.
    if (
      this.lastParallelLimitOverflowTime != null &&
      this.lastParallelLimitOverflowTime > periodStart
    ) {
      return
    }

    // Увеличить кол-во параллельных запросов на 1
    this.parallelLimitCorrection++
  }

  private reduceParallelLimit() {
    if (
      // Есть возможность снизить кол-во параллельных запросов?
      this.options.maxParallelLimit +
        this.parallelLimitCorrection -
        this.parallelLimitCorrectionStep >
      0
    ) {
      // Да - Снижаем кол-во параллельных запросов с указанным шагом
      this.parallelLimitCorrection -= this.parallelLimitCorrectionStep
    } else {
      // Нет - Устанавливаем минимальное кол-во параллельных запросов = 1
      // (максимальная коррекция).
      this.parallelLimitCorrection = this.options.maxParallelLimit - 1
    }
  }

  /**
   * Нужно ли обработать очередной запрос из очереди
   */
  private shouldProcessAction() {
    return (
      this.curInflightRequestsCount <
        this.options.maxParallelLimit + this.parallelLimitCorrection &&
      this.actionsQueue.length > 0 &&
      this.processActionPlanedTimeout === null
    )
  }

  /**
   * Запускает обработку очередного запроса из очереди запросов
   */
  private processAction() {
    this.reviewParallelLimitCorrection()

    // наличие сообщений в очереди проверяется в shouldProcessActions
    const action = this.actionsQueue.shift()
    if (action === undefined) {
      throw new Error('Внутренняя ошибка FetchPlanner - очередь пуста')
    }

    this.curInflightRequestsCount++

    const requestId = this.getNewRequestId()
    const requestStartTime = Date.now()
    let retryAfterMs: number | null = null

    const fetchApi = this.fetchApi

    debug?.('processAction', `requestStartTime - ${requestStartTime}`)
    this.lastRequestStartTime = requestStartTime

    fetchApi(action.url, action.options)
      .then(resp => {
        const requestEndTime = Date.now()

        let responseType: ResponseType

        // X-Lognex-Retry-TimeInterval
        this.parseRateLimitHeader(resp.headers, 'x-lognex-retry-timeInterval')

        // X-RateLimit-Limit
        this.parseRateLimitHeader(resp.headers, 'x-ratelimit-limit')

        // X-RateLimit-Remaining
        this.parseRateLimitHeader(resp.headers, 'x-ratelimit-remaining')

        // Запрос без ошибки
        if (resp.status !== 429) {
          responseType = ResponseTypes.OK
          action.resolve(resp)
        }

        // Ошибка превышения лимита
        else {
          responseType = ResponseTypes.RATE_LIMIT_OVERFLOW

          // Возвращаем запрос в начало очереди
          this.actionsQueue = [action, ...this.actionsQueue]

          const lognexAuthCode = resp.headers.get('x-lognex-auth')

          // Заголовок `X-Lognex-Retry-After` отсутствует когда ошибка вызвана
          // превышением кол-ва параллельных запросов.

          // Превышен лимит параллельных запросов
          if (lognexAuthCode === LOGNEX_PARALLEL_LIMIT_OVERFLOW_ERROR_CODE) {
            // Кто-то работает в параллельном процессе, снижаем наш maxParallelLimit
            this.reduceParallelLimit()

            this.lastParallelLimitOverflowTime = requestStartTime
            this.parallelLimitCorrectionTime = requestEndTime

            responseType = ResponseTypes.PARALLEL_LIMIT_OVERFLOW
          }

          // Превышен лимит за единицу времени
          else {
            // X-Lognex-Retry-After
            const retryAfterHeader = resp.headers.get('x-lognex-retry-after')

            if (retryAfterHeader != null) {
              const retryAfterHeaderNum = Number.parseInt(retryAfterHeader)

              if (Number.isNaN(retryAfterHeaderNum)) {
                throw new Error(
                  `Неверный формат X-Lognex-Retry-After - ${retryAfterHeader}`
                )
              }

              retryAfterMs = retryAfterHeaderNum
            }
          }
        }

        this.options.eventHandler?.emit(
          'response',
          {
            actionId: action.actionId,
            url: action.url,
            requestId,
            startTime: requestStartTime,
            endTime: requestEndTime,
            responseType
          },
          this
        )
      })

      .catch((err: unknown) => {
        const err_ =
          err instanceof Error
            ? err
            : new Error('Unknown error', { cause: err })

        action.reject(err_)

        setImmediate(() => {
          this.rejectFreeRequestSlotTriggers(err_)
        })
      })

      .finally(() => {
        this.checkFreeRequestSlotTrigger()

        this.planProcessAction(retryAfterMs ?? 0)

        // Уменьшаем показатель после планирования, т.к. фактически запрос еще
        // не выполнен (мы получили только заголовки)
        this.curInflightRequestsCount--
      })

    this.planProcessAction()

    this.options.eventHandler?.emit(
      'request',
      {
        actionId: action.actionId,
        url: action.url,
        requestId,
        startTime: requestStartTime
      },
      this
    )
  }

  private fetch(url: RequestInfo, init?: RequestInit) {
    const fetchPromise = new Promise((resolve, reject) => {
      const actionId = this.getNewActionId()

      this.actionsQueue.push({
        actionId,
        url,
        options: init,
        resolve,
        reject
      })
    })

    this.planProcessAction()

    return fetchPromise as Promise<Response>
  }

  /**
   * Возвращает обернутый fetch для выполнения запросов через планировщик.
   * Исходный fetch передается в параметрах конструктора при создании экземпляра
   * FetchPlanner.
   */
  getFetch() {
    return this.fetch.bind(this)
  }

  /**
   * Ожидание фактического наличия свободного слота для выполнения запроса.
   *
   * @param priority Приоритет. Чем меньше число, тем раньше будет выделен слот
   * (по умолчанию - `0`)
   */
  waitForFreeRequestSlot(priority = 0) {
    const triggerPromise = new Promise((resolve, reject) => {
      this.requestSlotHandlers.push({
        priority,
        resolve,
        reject
      })
    })

    setImmediate(() => {
      this.checkFreeRequestSlotTrigger()
    })

    return triggerPromise as Promise<void>
  }

  /**
   * Возвращает параметры планировщика по умолчанию либо указанные при его создании
   */
  getOptions() {
    return this.options
  }

  /**
   * Возвращает текущее актуальное значение заголовка `X-RateLimit-Limit`
   */
  getRateLimit() {
    return this.rateLimit
  }

  /**
   * Возвращает текущее актуальное значение заголовка `X-RateLimit-Remaining`
   */
  getRateLimitRemaining() {
    return this.rateLimitRemaining
  }

  /**
   * Возвращает текущую длину очереди запросов
   */
  getActionsQueueLength() {
    return this.actionsQueue.length
  }

  /**
   * Возвращает количество обработчиков ожидающих свободного слота
   */
  getRequestSlotHandlersCount() {
    return this.requestSlotHandlers.length
  }

  /**
   * Возвращает текущую коррекцию кол-ва допустимых параллельных запросов
   */
  getParallelLimitCorrection() {
    return this.parallelLimitCorrection
  }

  /**
   * Возвращает текущее кол-во незавершенных запросов (ожидающих ответа сервера)
   */
  getCurInflightRequestsCount() {
    return this.curInflightRequestsCount
  }

  /**
   * Возвращает задержку последнего запроса (ms)
   */
  getLastRequestDelay() {
    return this.lastRequestDelay
  }

  /**
   * Возвращает время (Unix Timestamp ms) на которое запланирован следующий запрос
   * или `0`, если нет запланированных запросов.
   */
  getNextRequestTime() {
    return this.nextRequestTime
  }
}

/**
 * Создает экземпляр планировщика и возвращает обернутый fetch
 */
export function wrapFetch(fetchApi: Fetch, options?: FetchPlannerOptions) {
  return new FetchPlanner(fetchApi, options).getFetch()
}
