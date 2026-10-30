/* oxlint-disable no-var */

import assert from 'node:assert'
import { MAX_TIMEOUT_MS, monotonicNow } from './runtime.js'
import {
  calculateRequestDelay,
  createAttenuationSteps,
  requestDeadline,
  roundPositiveOption,
  safeTime
} from './pacing.js'
import { parseResponsePolicy } from './response-policy.js'
import type { Scheduled, Transport, UndiciFetch } from './fetch-types.js'

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
    // oxlint-disable-next-line no-empty-function
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

import type { FetchPlannerOptions } from './index.js'

/**
 * Параметры http запроса (Action) для отправки в очередь планировщика
 */
interface FetchAction<F extends Transport> {
  state: 'queued' | 'running' | 'terminal'
  actionId: number
  url: Parameters<F>[0]
  options?: Parameters<F>[1]
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

export class FetchPlanner<F extends Transport = UndiciFetch> {
  /**
   * Предварительно рассчитанная функция затухания для расчета времени задержки
   * в зависимости от текущего лимита.
   */
  private readonly attenuationFnSteps: number[]

  /**
   * Опции планировщика запросов
   */
  private readonly options: FetchPlannerOptions<F>

  /**
   * Интервал бюджета в миллисекундах. `X-RateLimit-Limit` задаёт единицы
   * бюджета; число запросов зависит от их веса.
   *
   * Значение приходит в заголовке `X-Lognex-Retry-TimeInterval`.
   */
  protected retryTimeInterval = 3000

  /**
   * Значение заголовка `X-RateLimit-Limit` из последнего
   * полученного ответа сервера.
   *
   * Например: `45` единиц бюджета на интервал `retryTimeInterval`.
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
  private actionsQueue: FetchAction<F>[] = []

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
  private serverNotBefore = 0

  /**
   * Конструктор планировщика запросов
   *
   * @param fetchApi Функция с интерфейсом Fetch API, которую будет использовать
   * планировщик для выполнения запросов к серверу
   * @param params Опциональные параметры планировщика
   */
  constructor(
    private fetchApi: F,
    params?: Partial<FetchPlannerOptions<F>>
  ) {
    const optionsDefault: FetchPlannerOptions<F> = {
      eventHandler: undefined,
      throttlingCoefficient: 5,
      maxParallelLimit: 4,
      maxRequestDelayTimeMs: 3000,
      jitter: 0.1,
      parallelLimitCorrectionPeriodMs: 10000,
      errorLimits: {
        sameEntityPutRequestsPerMinuteLimit: 100,
        sameRequestsErrorPerMinuteLimit: 100,
        tooManyRequestsErrorPerMinuteLimit: 100
      }
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
      optionsDefault.maxParallelLimit = roundPositiveOption(
        params.maxParallelLimit,
        1,
        'maxParallelLimit'
      )
    }

    if (params?.maxRequestDelayTimeMs !== undefined) {
      optionsDefault.maxRequestDelayTimeMs = roundPositiveOption(
        params.maxRequestDelayTimeMs,
        1,
        'maxRequestDelayTimeMs'
      )
    }

    if (params?.jitter !== undefined) {
      assert.ok(
        typeof params.jitter === 'number' &&
          Number.isFinite(params.jitter) &&
          params.jitter >= 0 &&
          params.jitter <= 0.3,
        'Опция "jitter" должна быть целым числом от 0 до 0.3'
      )
      optionsDefault.jitter = params.jitter
    }

    if (params?.parallelLimitCorrectionPeriodMs !== undefined) {
      optionsDefault.parallelLimitCorrectionPeriodMs = roundPositiveOption(
        params.parallelLimitCorrectionPeriodMs,
        1000,
        'parallelLimitCorrectionPeriodMs'
      )
    }

    if (params?.throttlingCoefficient !== undefined) {
      assert.ok(
        typeof params.throttlingCoefficient === 'number' &&
          Number.isFinite(params.throttlingCoefficient) &&
          params.throttlingCoefficient >= 1 &&
          params.throttlingCoefficient <= 20,
        'Опция "throttlingCoefficient" должна быть числом от 1 до 20'
      )
      optionsDefault.throttlingCoefficient = params.throttlingCoefficient
    }

    this.options = optionsDefault

    this.attenuationFnSteps = createAttenuationSteps(optionsDefault.throttlingCoefficient)
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
    return calculateRequestDelay(
      {
        limit: this.rateLimit,
        remaining: this.rateLimitRemaining,
        retryTimeInterval: this.retryTimeInterval,
        elapsed: monotonicNow() - this.lastRequestStartTime
      },
      this.options,
      this.attenuationFnSteps,
      Math.random()
    )
  }

  /**
   * Единственный вход перепланирования: общий серверный deadline и адаптивный темп.
   */
  private pump() {
    if (this.processActionPlanedTimeout) {
      clearTimeout(this.processActionPlanedTimeout.timeout)
      this.processActionPlanedTimeout = null
    }
    if (!this.shouldProcessAction()) return

    const now = monotonicNow()
    const delayMs = Math.max(0, this.serverNotBefore - now, this.calculateRequestDelayTime())
    const deadline = requestDeadline(now, delayMs)
    this.scheduleWake(deadline, delayMs)
  }

  /** One owned wake, including bounded chunks of a longer absolute deadline. */
  private scheduleWake(deadline: number, delayMs: number) {
    const timeout = setTimeout(
      () => {
        // A canceled callback may already be queued: ownership must be checked first.
        if (this.processActionPlanedTimeout?.timeout !== timeout) return
        this.processActionPlanedTimeout = null
        if (!this.shouldProcessAction()) return
        const remaining = Math.max(deadline, this.serverNotBefore) - monotonicNow()
        if (remaining > 0) {
          this.scheduleWake(Math.max(deadline, this.serverNotBefore), delayMs)
          return
        }
        this.lastRequestDelay = delayMs
        this.processAction()
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(0, deadline - monotonicNow()))
    )
    this.processActionPlanedTimeout = { time: deadline, timeout }
  }

  /**
   * Вызывает триггеры ожидающие свободные слоты для выполнения запросов
   */
  protected checkFreeRequestSlotTrigger() {
    if (this.requestSlotHandlers[0] == null) return

    /** Общее кол-во выполняемых запросов и запросов ожидающих очереди */
    const totalIncompleteRequests = this.actionsQueue.length + this.curInflightRequestsCount

    // Есть место для нового запроса?
    if (totalIncompleteRequests >= this.options.maxParallelLimit + this.parallelLimitCorrection) {
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

  /**
   * Увеличивает лимит параллельных запросов, если он был ранее занижен по
   * причине превышения лимита.
   */
  private reviewParallelLimitCorrection() {
    const now = monotonicNow()

    const periodStart = safeTime(
      now -
        safeTime(
          this.options.parallelLimitCorrectionPeriodMs *
            // Jitter для равномерного распределения времени коррекции между экземплярами
            (1 + 2 * Math.random() * this.options.jitter)
        )
    )

    /** Пора ли провести коррекцию? */
    const shouldCorrect =
      this.parallelLimitCorrection < 0 && this.parallelLimitCorrectionTime < periodStart

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
    this.parallelLimitCorrection = Math.max(
      1 - this.options.maxParallelLimit,
      this.parallelLimitCorrection - this.parallelLimitCorrectionStep
    )
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

  /** The sole terminal transition; a terminal action can never re-enter the queue. */
  private settleAction(action: FetchAction<F>, result: Awaited<ReturnType<F>> | Error) {
    if (action.state === 'terminal') return false
    action.state = 'terminal'
    if (result instanceof Error) action.reject(result)
    else action.resolve(result)
    return true
  }

  private warnObserverFailure() {
    try {
      process.emitWarning('FetchPlanner observer failed')
    } catch {
      // A diagnostic must never replace the original action error.
    }
  }

  /** Best-effort cleanup of an owned response; a pending cancel never holds a transport slot. */
  private discardResponse(response: Awaited<ReturnType<F>>) {
    try {
      void response.body?.cancel().catch(() => {
        // Rejected cleanup must not escape into the scheduler.
      })
    } catch {
      // Cleanup is best effort, including synchronous body/cancel failures.
    }
  }

  /** Starts one attempt; only its completion releases the transport slot. */
  private processAction() {
    this.reviewParallelLimitCorrection()
    const action = this.actionsQueue.shift()
    if (action?.state !== 'queued') {
      throw new Error('Внутренняя ошибка FetchPlanner - очередь пуста или action завершён')
    }
    action.state = 'running'
    this.curInflightRequestsCount++
    const requestId = this.getNewRequestId()
    const requestStartTime = Date.now()
    const requestStartMonotonic = monotonicNow()
    this.lastRequestStartTime = requestStartMonotonic
    const metadata = {
      actionId: action.actionId,
      url: action.url,
      method:
        action.options?.method ??
        (typeof action.url === 'object' && 'method' in action.url ? action.url.method : undefined),
      requestId,
      startTime: requestStartTime
    }

    const fail = (error: unknown) => {
      const original = error instanceof Error ? error : new Error('Unknown error', { cause: error })
      if (!this.settleAction(action, original)) return
      try {
        this.options.eventHandler?.emit(
          'fetch-error',
          { ...metadata, error: original, errorTime: Date.now() },
          this
        )
      } catch {
        this.warnObserverFailure()
      }
    }

    // The queue retains Parameters<F> and delivers the same transport response.
    // TS cannot correlate a constrained generic callable with its extracted tuple.
    const fetchApi = this.fetchApi as unknown as (
      url: Parameters<F>[0],
      init?: Parameters<F>[1]
    ) => Promise<Awaited<ReturnType<F>>>
    debug?.('processAction', `requestStartTime - ${requestStartTime}`)
    const run = async () => {
      let response: Awaited<ReturnType<F>> | undefined
      try {
        // Call transport before request observers, preserving successful event order.
        const transport = fetchApi(action.url, action.options)
        try {
          this.options.eventHandler?.emit('request', metadata, this)
        } catch (error) {
          fail(error)
        }
        // Even a terminal action retains its inflight slot until transport settles.
        response = await transport
        if (action.state === 'terminal') return

        const requestEndTime = Date.now()
        const receiptTime = monotonicNow()
        const policy = parseResponsePolicy(response.status, response.headers)
        if (policy.retryTimeInterval !== null) this.retryTimeInterval = policy.retryTimeInterval
        if (policy.limit !== null) this.rateLimit = policy.limit
        if (policy.remaining !== null) this.rateLimitRemaining = policy.remaining

        if (policy.retryAfterMs !== null) {
          this.serverNotBefore = Math.max(
            this.serverNotBefore,
            requestDeadline(receiptTime, policy.retryAfterMs)
          )
        }

        // Observer failure is terminal, so emit before either delivery or retry.
        this.options.eventHandler?.emit(
          'response',
          { ...metadata, endTime: requestEndTime, responseType: policy.responseType },
          this
        )
        if (policy.responseType === 'OK') {
          this.settleAction(action, response)
          response = undefined // Ownership passes to the consumer unchanged.
        } else {
          if (policy.responseType === 'PARALLEL_LIMIT_OVERFLOW') {
            this.reduceParallelLimit()
            this.lastParallelLimitOverflowTime = requestStartMonotonic
            this.parallelLimitCorrectionTime = receiptTime
          }
          action.state = 'queued'
          this.actionsQueue.unshift(action)
        }
      } catch (error) {
        fail(error)
      } finally {
        if (response !== undefined) this.discardResponse(response)
        // Preserve the existing getter timing for the consumer settlement job.
        await Promise.resolve()
        this.curInflightRequestsCount--
        this.checkFreeRequestSlotTrigger()
        this.pump()
      }
    }

    // Contain even failures in internal completion/diagnostic hooks.
    void run().catch(() => {
      this.warnObserverFailure()
    })
    this.pump()
  }

  private fetch(url: Parameters<F>[0], init?: Parameters<F>[1]) {
    const fetchPromise = new Promise((resolve, reject) => {
      const actionId = this.getNewActionId()

      this.actionsQueue.push({
        state: 'queued',
        actionId,
        url,
        options: init,
        resolve,
        reject
      })
    })

    this.pump()

    return fetchPromise as Promise<Awaited<ReturnType<F>>>
  }

  /**
   * Возвращает обернутый fetch для выполнения запросов через планировщик.
   * Исходный fetch передается в параметрах конструктора при создании экземпляра
   * FetchPlanner.
   */
  getFetch(): Scheduled<F> {
    return this.fetch.bind(this) as Scheduled<F>
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
   * Возвращает параметры планировщика по умолчанию либо указанные при его создании.
   * Объект остаётся изменяемым, но mutation не поддерживается как конфигурирование:
   * предварительно рассчитанная таблица коэффициентов при этом не обновляется.
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
    const deadline = this.processActionPlanedTimeout?.time
    return deadline === undefined
      ? 0
      : requestDeadline(Date.now(), Math.max(0, deadline - monotonicNow()))
  }
}
