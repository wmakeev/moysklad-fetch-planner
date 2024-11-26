/* eslint-disable-next-line */
import type { RequestInfo, RequestInit, Response } from 'undici'

// TODO Нужно еще учитывать PARALLEL_LIMIT_OVERFLOW и накидывать определенный
// коэфициент на задержку если были ошибки в неком окне в прошлом и запрещать
// увеличивать лимит при пересмотре.

export type RetryStrategyFunction = <
  U,
  T extends (...agrs: any[]) => Promise<U>
>(
  thunk: T
) => Promise<U>

/**
 * Общий интерфейс для элемента в истории запросов и ответов
 */
interface TimelineItem {
  requestId: number
  startTime: number
}

/**
 * Тип результата выполнения запроса
 */
const ResponseTypes = {
  /** Запрос пыполнен без ошибок */
  OK: 'OK',

  /** Запрос не выполнен по причине превышения лимита `X-RateLimit-Limit` */
  RATE_LIMIT_OVERFLOW: 'RATE_LIMIT_OVERFLOW',

  /** Запрос не выполнен по причине превышения лимита параллельных запросов */
  PARALLEL_LIMIT_OVERFLOW: 'PARALLEL_LIMIT_OVERFLOW'
} as const

type ResponseType = keyof typeof ResponseTypes

/**
 * Интерфейс для элемента в истории запросов
 */
type RequestTimeline = TimelineItem

/**
 * Интерфейс для элемента в истории ответов
 */
interface ResponseTimeline extends TimelineItem {
  responseType: ResponseType
  endTime: number
}

/**
 * Параметры http запроса для отправки в очередь планировщика
 */
interface FetchAction {
  actionId: number
  url: RequestInfo
  options?: RequestInit | undefined
  resolve: (val: unknown) => void
  reject: (err: Error) => void
}

/**
 * Триггер который должен разрешаться в момент когда есть свободный слот
 * на выполнение запросов
 */
interface FreeRequestSlotTrigger {
  /** Приоритет триггера (сначала обрабатываются с наибольшим приоритетом) */
  priority?: number | undefined

  /** Разрешить промис на стороне ожидающего триггер */
  resolve: (value: unknown) => void
}

export interface ResponseEvent extends ResponseTimeline {
  actionId: number
}

export interface RateLimitEvent {
  'X-RateLimit-Limit': number
  'X-RateLimit-Remaining': number
  'X-Lognex-Retry-TimeInterval': number
}

export interface LimitOverflowEvent {
  responseType: ResponseType
  actionId: number
  url: RequestInfo
}

export interface RequestDelayEvent {
  delay: number
  calculatedDelay: number
}

export interface EventHandler {
  emit(eventName: 'response', data: ResponseEvent): void
  emit(eventName: 'delay', data: RequestDelayEvent): void
  emit(eventName: 'trigger', data: undefined): void
  emit(eventName: 'parallel-limit', data: number): void // TODO Нигде не используется
  emit(eventName: 'rate-limit', data: RateLimitEvent): void
  emit(eventName: 'limit-overflow', data: LimitOverflowEvent): void
}

// FIXME Согласовать интерфейсы DOM и node-fetch
/**
 * [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
 */
type Fetch = (url: RequestInfo, init?: RequestInit) => Promise<Response>

/**
 * Обрезает историю запросов, удаляя все элементы истории со временем ранее
 * указанного
 *
 * @param timeline Массив истории запросов или ответов
 * @param toTime Время до которого нужно обрезать историю запросов
 */
function trimTimeline(timeline: TimelineItem[], toTime: number) {
  /** Кол-во элементов с начала массива которые необходимо обрезать */
  let itemsCount = 0

  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i]!.startTime > toTime) {
      itemsCount = i
      break
    }
  }

  if (itemsCount > 0) timeline.splice(0, itemsCount)
}

/**
 * Параметры планировщика запросов
 */
export interface FetchPlannerParams {
  // TODO Добавить возможность переназначать опциональные параметры внутренней конфигурации

  eventHandler?: EventHandler

  /**
   * Стратегия повтора запроса при возникновении ошибки в процессе вызова fetch.
   * Например ошибки соединения не связанные с API МойСклад.
   *
   * Обрабатывать запросы с кодом `429` внутри функции не нужно, т.к. планировщик
   * самостоятельно выполняет повторные запросы при возникновении ошибки `HTTP 429 Too Many Requests`.
   *
   * Пример использования совместно с библиотекой [p-retry](https://github.com/sindresorhus/p-retry):
   *
   * ```ts
   * import pRetry from 'p-retry'
   * import { FetchPlanner, type RetryStrategyFunction } from 'moysklad-fetch-planner'
   *
   * const fetchRetryStrategy: RetryStrategyFunction = async thunk => {
   *   return await pRetry(thunk, {
   *    onFailedAttempt: error => {
   *       console.log(
   *         `[FETCH ERROR] ${error.message} (retry ${error.attemptNumber} left ${error.retriesLeft})`
   *       )
   *     },
   *     retries: 2
   *   })
   * }
   *
   * const fetchPlanner = new FetchPlanner(fetch, {
   *   retry: fetchRetryStrategy
   * })
   *
   * const ms = Moysklad({
   *   fetch: fetchPlanner.getFetch(),
   *   userAgent: 'my-app'
   * })
   * ```
   *
   * @param thunk Функция без аргументов которую передает планировщик. При
   * выполнении данной функции выполняется очередной HTTP-запрос.
   */
  retry?: RetryStrategyFunction
}

export class FetchPlanner {
  // TODO Часть параметров являются константами - различать от параметров состояния

  /**
   * Коэфициент для формулы экспоненциальной задержки в зависимости от значения
   * `X-RateLimit-Remaining`.
   */
  private exponentDelayRaito = 2

  /**
   * Максимальное кол-во параллельных запросов.
   *
   * По умолчанию: `4`
   *
   * API позволяет до 5 параллельных запросов, но для большей надежности
   * лучше оставлять небольшой запас.
   */
  private maxParallelLimit = 4

  /**
   * Значение заголовка `X-Lognex-Retry-TimeInterval` из последнего
   * полученного ответа сервера.
   *
   * Например: `3000` (3 секунды)
   * */
  private retryTimeInterval: number | null = null

  /**
   * Значение заголовка `X-RateLimit-Limit` из последнего
   * полученного ответа сервера.
   *
   * Например: `45` (45 запросов на один интервал `retryTimeInterval`)
   * */
  private rateLimit: number | null = null

  /**
   * Максимальное время задержки перед выполнением следующего запроса.
   *
   * Устанавливается в случае если расчетное время задержки превышает указаное
   * значение.
   *
   * Такая ситуация может произойти если:
   * - работает слишком ного параллельных приложений
   * - какое-либо паралельное приложение не контролирует лимиты
   *
   * По умолчанию `10000` (10 секунд)
   */
  private maxRequestDelayTimeMs = 10000

  /**
   * Значение заголовка `X-RateLimit-Remaining` из последнего
   * полученного ответа сервера.
   * */
  private rateLimitRemaining: number | null = null

  /**
   * Текущее кол-во одновременно выполняемых запросов
   */
  private requestsInProgress = 0

  /**
   * Текущая коррекция кол-ва допустимых параллельных запросов.
   *
   * Подобная коррекция может потребоваться если параллельно
   * работает другое приложение которое использует часть лимита параллельных
   * запросов.
   * */
  private parallelLimitCorrection = 0

  /**
   * Время когда было произведено изменение `parallelLimitCorrection`
   */
  private parallelLimitCorrectionTime = 0

  /**
   * Период в (мс) через которые происходим пересмотр `parallelLimitCorrection`
   */
  private parallelLimitCorrectionPeriod = 30000

  /**
   * Шаг с которым вводится корректировка для `parallelLimitCorrection`
   */
  private parallelLimitCorrectionStep = 1

  /**
   * Очередь запросов
   */
  private actionsQueue: FetchAction[] = []

  /**
   * История последовательности запросов к серверу
   */
  private requestTimeline: RequestTimeline[] = []

  /**
   * История последовательности ответов сервера
   */
  private responseTimeline: ResponseTimeline[] = []

  /**
   * Триггеры ожидающие свободных запросов
   */
  private freeRequestSlotTriggers: FreeRequestSlotTrigger[] = []

  /**
   * Время и таймер на которые внутри планировка запланирована очередная обработка
   * очереди запросов
   */
  private processActionsPlanedTimeout: {
    time: number
    timeout: NodeJS.Timeout
  } | null = null

  /**
   * Порядковый номер последнего запроса отправленного планировщиком к серверу
   */
  private lastRequestNum = 0

  /**
   * Порядковый номер последней запроса отправленного пользователем в
   * планировщик
   */
  private lastActionNum = 0

  /** DEBUG */
  private eventHandler: EventHandler | null = null

  private retry:
    | (<U, T extends (...agrs: any[]) => Promise<U>>(thunk: T) => Promise<U>)
    | null = null

  /**
   * Конструктор планировщика запросов
   *
   * @param fetchApi Функция с интерфейсом Fetch API, которую будет использовать
   * планировщик для выполнения запросов к серверу
   * @param params Опциональные параметры планировщика
   */
  constructor(
    private fetchApi: Fetch,
    params?: FetchPlannerParams
  ) {
    if (params?.eventHandler) {
      this.eventHandler = params.eventHandler
    }

    if (params?.retry) {
      this.retry = params.retry
    }
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
   * Обрезает историю запросов и ответов сервера. Сбрасывает состояние текущего
   * потока запросов при определенных условиях.
   *
   * @param time Время до которого необходимо обрезать историю запросов и ответов
   * сервера
   */
  private trimTimeline(time: number) {
    trimTimeline(this.requestTimeline, time - (this.retryTimeInterval ?? 0))
    trimTimeline(this.responseTimeline, time - (this.retryTimeInterval ?? 0))
  }

  /** Добавляет элемент в историю запросов к серверу */
  private addToRequestTimeline(item: RequestTimeline) {
    this.trimTimeline(item.startTime)
    this.requestTimeline.push(item)
  }

  /** Добавляет элемент в историю ответов сервера */
  private addToResponseTimeline(item: ResponseTimeline) {
    this.trimTimeline(item.startTime)
    this.responseTimeline.push(item)
  }

  /**
   * Возвращает задержку которую необходимо выдержать перед отправкой
   * очередного запроса на сервер
   *
   * @returns Интервал ожидания ms
   */
  private getRequestDelayTime() {
    // Если текущие значения X-Lognex-Retry-TimeInterval, X-RateLimit-Limit,
    // X-RateLimit-Remaining не получены, то вероятно мы еще не отправляли
    // запросов. В ожидании нет необходимости.
    if (
      this.retryTimeInterval === null ||
      this.rateLimit === null ||
      this.rateLimitRemaining === null
    ) {
      return 0
    }

    /** Условный уровень запросов */
    const waterline = this.rateLimitRemaining / this.rateLimit

    const stdDelay = this.retryTimeInterval / this.rateLimit

    const k = this.exponentDelayRaito * (1 / waterline - 1)

    const calculatedDelay = k * stdDelay
    let delay = calculatedDelay

    if (delay > this.maxRequestDelayTimeMs) {
      delay = this.maxRequestDelayTimeMs
    }

    this.eventHandler?.emit('delay', { delay, calculatedDelay })

    return delay
  }

  /**
   * Рассчитываем время выполнения сдедующего запроса
   *
   * @returns Время запроса
   */
  private getNextRequestTime() {
    if (this.requestTimeline.length > 0) {
      return Date.now() + this.getRequestDelayTime()
    } else {
      return Date.now()
    }
  }

  /**
   * Планирует обработку запроса из очереди в будущем (тротлинг)
   *
   * @param time Явное указание времени на которое нужно запланировать обработку
   * запроса
   */
  private planProcessAction(time = 0) {
    const nextRequestTime = this.getNextRequestTime()

    const planTime = Math.max(time, nextRequestTime)

    // Если другая обработка событий еще не запланирована
    // или запланирована раньше чем текущий план
    if (
      !this.processActionsPlanedTimeout ||
      this.processActionsPlanedTimeout.time < planTime
    ) {
      const wait = planTime - Date.now()

      if (this.processActionsPlanedTimeout) {
        clearTimeout(this.processActionsPlanedTimeout.timeout)
      }

      const timeout = setTimeout(
        () => {
          if (this.processActionsPlanedTimeout?.timeout === timeout) {
            this.processActionsPlanedTimeout = null
          }

          this.processAction()
        },
        wait > 0 ? wait : 0
      )

      this.processActionsPlanedTimeout = {
        time: planTime,
        timeout
      }
    }
  }

  /**
   * Вызывает триггеры ожидающие свободные слоты для выполнения запросов
   */
  protected checkFreeRequestSlotTrigger() {
    const curInflightRequests =
      this.actionsQueue.length + this.requestsInProgress

    // Есть место для нового запроса
    if (
      curInflightRequests <
      this.maxParallelLimit + this.parallelLimitCorrection
    ) {
      let trigger: FreeRequestSlotTrigger | null = null
      let triggerIndex: number | null = null
      let triggerPriority = -Infinity

      for (const [index, t] of this.freeRequestSlotTriggers.entries()) {
        if (trigger === null) {
          trigger = t
          triggerIndex = index
          triggerPriority = t.priority ?? -Infinity
          continue
        }

        if ((t.priority ?? -Infinity) > triggerPriority) {
          trigger = t
          triggerIndex = index
        }
      }

      if (trigger && triggerIndex != null) {
        this.freeRequestSlotTriggers.splice(triggerIndex, 1)
        trigger.resolve(undefined)
        this.eventHandler?.emit('trigger', undefined)
      }
    }
  }

  /**
   * Нужно ли обработать очередной запрос из очереди
   */
  private shouldProcessAction() {
    const now = Date.now()

    // Обратно увеличиваем кол-во параллельных запросов через определенный период
    if (
      this.parallelLimitCorrection < 0 &&
      this.parallelLimitCorrectionTime <
        now - this.parallelLimitCorrectionPeriod
    ) {
      this.parallelLimitCorrection++
      this.parallelLimitCorrectionTime = now

      this.eventHandler?.emit(
        'parallel-limit',
        this.maxParallelLimit + this.parallelLimitCorrection
      )
    }

    return (
      this.requestsInProgress <
        this.maxParallelLimit + this.parallelLimitCorrection &&
      this.actionsQueue.length > 0 &&
      this.processActionsPlanedTimeout === null
    )
  }

  /**
   * Запускает обработку очередного запроса из очереди запросов
   */
  private processAction() {
    if (!this.shouldProcessAction()) return

    this.requestsInProgress++

    const action = this.actionsQueue.shift()

    // наличие сообщений в очереди проверяется в shouldProcessActions
    if (action === undefined) {
      throw new Error('Внутренняя ошибка FetchPlanner - очередь пуста')
    }

    const requestId = this.getNewRequestId()
    const requestStartTime = Date.now()
    let requestEndTime: number
    let retryAfterMs: number | null = null

    const fetchApi = this.fetchApi

    fetchApi(action.url, action.options)
      .then(resp => {
        requestEndTime = Date.now()

        this.requestsInProgress--

        let responseType: ResponseType

        // X-RateLimit-Limit
        const rateLimit = resp.headers.get('X-RateLimit-Limit')
        if (rateLimit) {
          this.rateLimit = Number.parseInt(rateLimit)
        }

        // X-RateLimit-Remaining
        const rateLimitRemaining = resp.headers.get('X-RateLimit-Remaining')
        if (rateLimitRemaining) {
          this.rateLimitRemaining = Number.parseInt(rateLimitRemaining)
        }

        // X-Lognex-Retry-TimeInterval
        const retryTimeInterval = resp.headers.get(
          'X-Lognex-Retry-TimeInterval'
        )
        if (retryTimeInterval) {
          this.retryTimeInterval = Number.parseInt(retryTimeInterval)
        }

        if (
          this.rateLimitRemaining &&
          this.rateLimit &&
          this.retryTimeInterval
        ) {
          this.eventHandler?.emit('rate-limit', {
            'X-RateLimit-Limit': this.rateLimit,
            'X-RateLimit-Remaining': this.rateLimitRemaining,
            'X-Lognex-Retry-TimeInterval': this.retryTimeInterval
          })
        }

        let responseTimelineItem: ResponseTimeline

        if (resp.status === 429) {
          // Возвращаем запрос в очередь
          this.actionsQueue = [action, ...this.actionsQueue]

          // Превышен лимит за временной промежуток
          const retryAfterHeader = resp.headers.get('X-Lognex-Retry-After')

          if (retryAfterHeader) {
            responseType = ResponseTypes.RATE_LIMIT_OVERFLOW

            responseTimelineItem = {
              requestId,
              startTime: requestStartTime,
              endTime: requestEndTime,
              responseType: responseType
            }

            this.addToResponseTimeline(responseTimelineItem)

            retryAfterMs = Number.parseInt(retryAfterHeader)
          }

          // Превышен лимит параллельных запросов
          else {
            // Кто-то работает в параллельном процессе, снижаем наш maxParallelLimit
            if (
              this.maxParallelLimit +
                this.parallelLimitCorrection -
                this.parallelLimitCorrectionStep >
              0
            ) {
              this.parallelLimitCorrection -= this.parallelLimitCorrectionStep
            } else {
              this.parallelLimitCorrection = this.maxParallelLimit - 1

              this.eventHandler?.emit(
                'parallel-limit',
                this.maxParallelLimit + this.parallelLimitCorrection
              )
            }

            this.parallelLimitCorrectionTime = requestEndTime

            responseType = ResponseTypes.PARALLEL_LIMIT_OVERFLOW

            responseTimelineItem = {
              requestId,
              startTime: requestStartTime,
              endTime: requestEndTime,
              responseType
            }

            this.addToResponseTimeline(responseTimelineItem)
          }

          this.eventHandler?.emit('limit-overflow', {
            responseType,
            actionId: action.actionId,
            url: action.url
          })
        } else {
          responseType = ResponseTypes.OK

          responseTimelineItem = {
            requestId,
            startTime: requestStartTime,
            endTime: requestEndTime,
            responseType
          }

          this.addToResponseTimeline(responseTimelineItem)

          action.resolve(resp)
        }

        this.eventHandler?.emit('response', {
          actionId: action.actionId,
          ...responseTimelineItem
        })
      })
      .catch(err => {
        this.requestsInProgress--

        action.reject(err)
      })
      .finally(() => {
        this.checkFreeRequestSlotTrigger()

        if (retryAfterMs != null && requestEndTime) {
          this.planProcessAction(requestEndTime + retryAfterMs)
        } else {
          this.planProcessAction()
        }
      })

    this.addToRequestTimeline({
      requestId,
      startTime: requestStartTime
    })

    if (this.shouldProcessAction()) this.planProcessAction()
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

  getFetch() {
    const fetch: typeof this.fetch = async (url, init) => {
      if (this.retry) {
        const fetchAction = async () => await this.fetch(url, init)
        return this.retry(fetchAction)
      } else {
        return await this.fetch(url, init)
      }
    }

    return fetch
  }

  private trigger(priority?: number) {
    const triggerPromise = new Promise(resolve => {
      this.freeRequestSlotTriggers.push({
        priority,
        resolve
      })
    })

    this.checkFreeRequestSlotTrigger()

    return triggerPromise as Promise<void>
  }

  getTrigger() {
    const bindedTrigger = this.trigger.bind(this)
    return bindedTrigger
  }

  getInternalState() {
    return {
      actionsQueueLength: this.actionsQueue.length,
      freeRequestSlotTriggersLength: this.freeRequestSlotTriggers.length,
      parallelLimitCorrection: this.parallelLimitCorrection,
      requestsInProgress: this.requestsInProgress
    }
  }
}

export function wrapFetchApi(fetchApi: Fetch, params?: FetchPlannerParams) {
  const planner = new FetchPlanner(fetchApi, params)

  return planner.getFetch()
}
