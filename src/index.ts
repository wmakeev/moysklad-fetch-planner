import type { RequestInfo, RequestInit, Response } from 'node-fetch'

export interface EventHandler {
  emit(eventName: string, data: any): void
}

/**
 * Параметры планировщика запросов
 */
export interface FetchPlannerParams {
  eventHandler: EventHandler
}

/**
 * [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
 */
type Fetch = (url: RequestInfo, init?: RequestInit) => Promise<Response>

/**
 * Параметры http запроса для отправки в очередь планировщика
 */
interface FetchAction {
  actionId: number
  url: RequestInfo
  options?: RequestInit
  resolve: (val: unknown) => void
  reject: (err: Error) => void
}

/**
 * Тип результата выполнения запроса
 */
enum ResponseType {
  /** Запрос пыполнен без ошибок */
  OK = 'OK',

  /** Запрос не выполнен по причине превышения лимита `X-RateLimit-Limit` */
  RATE_LIMIT_OVERFLOW = 'RATE_LIMIT_OVERFLOW',

  /** Запрос не выполнен по причине превышения лимита параллельных запросов */
  PARALLEL_LIMIT_OVERFLOW = 'PARALLEL_LIMIT_OVERFLOW'
}

/**
 * Общий интерфейс для элемента в истории запросов и ответов
 */
interface TimelineItem {
  requestId: number
  time: number
}

/**
 * Интерфейс для элемента в истории запросов
 */
interface RequestTimeline extends TimelineItem {}

/**
 * Интерфейс для элемента в истории ответов
 */
interface ResponseTimeline extends TimelineItem {
  responseType: ResponseType
}

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
    if (timeline[i].time > toTime) {
      itemsCount = i
      break
    }
  }

  if (itemsCount > 0) timeline.splice(0, itemsCount)
}

/**
 * Класс планировщика запросов
 */
class FetchPlanner {
  /**
   * Максимальное кол-во параллельных запросов (по умолчанию `5`)
   */
  private maxParallelLimit = 5

  /**
   * Наличие непрерывного потока запросов
   *
   * - `true` - идет непрерывный поток запросов
   * - `false` - непрерывный поток не зафиксирован
   *
   * Последовательность запросов называется непрерывной, когда есть хотя бы один
   * запрос за ближайший промежуток времени указанный в
   * `correctionRevisionTimeFrame` либо значение `X-RateLimit-Remaining` ниже
   * порога определяемого значением в `rateLimitRemainingThreshold`.
   *
   * В первом случае мы смотрим на собственную скорость запросов, во втором,
   * на глобальную картину, например, когда общий лимит делят между собой
   * несколько разных одновременно работающих приложений/процессов.
   *
   * К примеру, если наше приложение не делало запросов за последние несколько
   * секунд (или эти запросы были очень редкими), а уровень
   * `X-RateLimit-Remaining` ниже порога, то такая картина может означать, что
   * где-то параллельно работает другое приложение и задействует часть лимита.
   * Поэтому планировщик будет считать, что идет непрерывный поток запросов.
   */
  private sprintStarted: boolean = false

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
   * Значение заголовка `X-RateLimit-Remaining` из последнего
   * полученного ответа сервера.
   * */
  private rateLimitRemaining: number | null = null

  /**
   * Погоровое значение `X-RateLimit-Remaining` ниже которого планировщик
   * будет считать что начат непрерывный поток запросов.
   *
   * Указывается как доля от `X-RateLimit-Remaining`.
   *
   * По умолчанию - `0.5` (50%)
   * */
  private rateLimitRemainingLowThreshold = 0.5

  /**
   * Погоровое значение `X-RateLimit-Remaining` выше которого планировщик
   * будет считать что непрерывный поток запросов окончен.
   *
   * Указывается как доля от `X-RateLimit-Remaining`.
   *
   * По умолчанию - `0.9` (90%)
   * */
  private rateLimitRemainingHighThreshold = 0.9

  /**
   * Текущее кол-во одновременно выполняемых запросов
   */
  private requestsInProgress = 0

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
   * Временной промежуток за который планировщик анализирует картину запросов
   * и ответов и вводит соответствующие корректировки в размер таймаутов между
   * запросами для предотвращения превышения порога лимитов заданых сервером.
   */
  private correctionRevisionTimeFrame = 500

  /**
   * Время последнего пресмотра корректировок для текущего потока запросов
   */
  private correctionRevisedTime = 0

  /**
   * Значение заголовка `X-RateLimit-Remaining` для предыдушего периода
   * (заданного в `correctionRevisionTimeFrame`) пересмотра корректировок.
   *
   * Значение за прошлый период сохраняется с целью отследить общий тренд
   * на повышение или понижение значения `X-RateLimit-Remaining` от периода
   * к периоду.
   * */
  private rateLimitRemainingOnLastRevision: number | null = null

  /**
   * Текущее время коррекции в мс, которое добавляется к стандартной задержке
   * в случае, если времени сдандартной задержки не достаточно чтобы
   * сбалансировать показатель `X-RateLimit-Remaining`.
   *
   * Подобная добавочная коррекция может потребоваться если параллельно
   * работает другое приложение которое использует часть лимита запросов.
   *
   * Стандарная задержка расчитывается как:
   *
   * `[X-Lognex-Retry-TimeInterval] / [X-RateLimit-Limit]`
   *
   * Например: `3000 ms / 45 = 67 ms`
   */
  private timeIntervalCorrection = 0 // 35ms для _rateLimitBoost = 3

  /**
   * Шаг с которым вводится корректировка для `timeIntervalCorrection`
   */
  private timeIntervalCorrectionStep = 2

  /**
   * Текущая коррекция кол-ва допустимых параллельных запросов.
   *
   * Подобная коррекция может потребоваться если параллельно
   * работает другое приложение которое использует часть лимита параллельных
   * запросов.
   * */
  private parallelLimitCorrection = 0

  /**
   * Шаг с которым вводится корректировка для `timeIntervalCorrection`
   */
  private parallelLimitCorrectionStep = 1

  /**
   * Время на которое внутри планировка запланирована очередная обработка
   * очереди запросов
   * */
  private planedProcessActionsTime = 0

  /**
   * Таймер установленный на время следующей обработки очереди запросов
   */
  private planedProcessActionsTimeout: NodeJS.Timeout | null = null

  /** DEBUG */
  private eventHandler: EventHandler | null = null

  /**
   * Порядковый номер последнего запроса отправленного планировщиком к серверу
   */
  private lastRequestNum = 0

  /**
   * Порядковый номер последней запроса отправленного пользователем в
   * планировщик
   */
  private lastActionNum = 0

  /**
   * Конструктор планировщика запросов
   *
   * @param fetchApi Функция с интерфейсом Fetch API, которую будет использовать
   * планировщик для выполнения запросов к серверу
   * @param params Опциональные параметры планировщика
   */
  constructor(private fetchApi: Fetch, params?: FetchPlannerParams) {
    if (params?.eventHandler) {
      this.eventHandler = params.eventHandler
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
   * Сбрасывает показатели характеризующие текущий поток запросов.
   * Вызывается в случае, если планировщик зафиксировал окончание потока запросов.
   */
  private finishSprint() {
    this.sprintStarted = false
    this.rateLimitRemaining = null
    this.rateLimitRemainingOnLastRevision = null
    this.parallelLimitCorrection = 0
    this.timeIntervalCorrection = 0
  }

  /**
   * Обрезает историю запросов и ответов сервера. Сбрасывает состояние текущего
   * потока запросов при определенных условиях.
   *
   * @param time Время до которого необходимо обрезать историю запросов и ответов
   * сервера
   */
  private trimTimeline(time: number) {
    trimTimeline(this.requestTimeline, time - this.correctionRevisionTimeFrame)
    trimTimeline(this.responseTimeline, time - this.correctionRevisionTimeFrame)

    if (
      this.requestTimeline.length === 0 &&
      this.rateLimitRemaining !== null &&
      this.rateLimit !== null &&
      this.rateLimitRemaining >=
        this.rateLimit * this.rateLimitRemainingHighThreshold
    ) {
      this.finishSprint()
    }
  }

  /** Добавляет элемент в историю запросов к серверу */
  private addRequestTimeline(item: RequestTimeline) {
    this.trimTimeline(item.time)
    this.requestTimeline.push(item)
  }

  /** Добавляет элемент в историю ответов сервера */
  private addResponseTimeline(item: ResponseTimeline) {
    this.trimTimeline(item.time)
    this.responseTimeline.push(item)
  }

  /**
   * Кол-во запросов которые превысили лимиты с указанного промежутка времени
   *
   * @param type Тип ошибки
   * @param from Время
   * @returns Кол-во запросов
   */
  private getLimitOverflowFrom(
    type:
      | ResponseType.PARALLEL_LIMIT_OVERFLOW
      | ResponseType.RATE_LIMIT_OVERFLOW,
    from: number
  ) {
    return this.responseTimeline.filter(
      it => it.responseType === type && it.time >= from
    ).length
  }

  /**
   * Возвращает интервал времени который необходимо выждать перед отправкой
   * очередного запроса к серверу
   *
   * @returns Интервал ожидания ms
   */
  private getRequestTimeInterval() {
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

    /**
     * Погоровое значение X-RateLimit-Remaining ниже которого считаем что
     * начат непрерывный поток запросов.
     * */
    const rateLimitRemainingLowThreshold =
      this.rateLimit * this.rateLimitRemainingLowThreshold

    // Поток запросов не начат и X-RateLimit-Remaining выше порогового уровня.
    // В ожидании нет необходимости.
    if (
      this.sprintStarted === false &&
      this.rateLimitRemaining >= rateLimitRemainingLowThreshold
    ) {
      return 0
    }

    this.sprintStarted = true

    const now = Date.now()

    const limitsOverflowStartPeriod = now - this.correctionRevisionTimeFrame

    // Пересмотр корректировок
    if (this.correctionRevisedTime < limitsOverflowStartPeriod) {
      this.correctionRevisedTime = now

      /** Изменение rateLimitRemaining с последней ревизии */
      const rateLimitRemainingTrend =
        this.rateLimitRemaining -
        (this.rateLimitRemainingOnLastRevision ??
          rateLimitRemainingLowThreshold)

      this.rateLimitRemainingOnLastRevision = this.rateLimitRemaining

      // Корректировка по timeInterval
      const rateLimitOverflow = this.getLimitOverflowFrom(
        ResponseType.RATE_LIMIT_OVERFLOW,
        limitsOverflowStartPeriod
      )

      // TODO Добавить экспоненциальное изменение в зависимости от доли 429 запросов
      // TODO Оставим один для поддержания актуальности (подумать)
      if (
        (rateLimitOverflow > 1 ||
          this.rateLimitRemaining < rateLimitRemainingLowThreshold) &&
        rateLimitRemainingTrend < 0
      ) {
        this.timeIntervalCorrection += this.timeIntervalCorrectionStep
      } else if (
        this.timeIntervalCorrection > 0 &&
        rateLimitRemainingTrend >= 0
      ) {
        this.timeIntervalCorrection -=
          this.timeIntervalCorrection >= this.timeIntervalCorrectionStep
            ? this.timeIntervalCorrectionStep
            : 0
      }

      // Корректировка по parallelLimit
      const parallelLimitOverflow = this.getLimitOverflowFrom(
        ResponseType.PARALLEL_LIMIT_OVERFLOW,
        limitsOverflowStartPeriod
      )

      // TODO Наличие одной ошибки за период допустимо (???)
      if (parallelLimitOverflow > 1) {
        if (this.maxParallelLimit + this.parallelLimitCorrection > 1) {
          this.parallelLimitCorrection -= this.parallelLimitCorrectionStep
        }
      } else if (
        parallelLimitOverflow === 0 &&
        this.parallelLimitCorrection < 0
      ) {
        this.parallelLimitCorrection += this.parallelLimitCorrectionStep
      }
    }

    return (
      Math.ceil(this.retryTimeInterval / this.rateLimit) +
      this.timeIntervalCorrection
    )
  }

  private getNextRequestTime() {
    if (this.requestTimeline.length > 0) {
      const lastRequestTime =
        this.requestTimeline[this.requestTimeline.length - 1].time
      return lastRequestTime + this.getRequestTimeInterval()
    } else {
      return Date.now()
    }
  }

  private planProcessActions(time = 0) {
    const nextRequestTime = this.getNextRequestTime()

    const planTime = Math.max(time, nextRequestTime)

    if (this.planedProcessActionsTime < planTime) {
      const wait = planTime - Date.now()

      if (this.planedProcessActionsTimeout !== null) {
        clearTimeout(this.planedProcessActionsTimeout)
      }

      this.planedProcessActionsTime = planTime

      const timeout = setTimeout(
        () => {
          if (this.planedProcessActionsTimeout === timeout) {
            this.planedProcessActionsTimeout = null
          }

          this.processActions()
        },
        wait > 0 ? wait : 0
      )

      this.planedProcessActionsTimeout = timeout
    }
  }

  private shouldProcessActions() {
    return (
      this.requestsInProgress <
        this.maxParallelLimit + this.parallelLimitCorrection &&
      this.actionsQueue.length > 0 &&
      this.planedProcessActionsTimeout === null
    )
  }

  private emitRequestInternalStat(param: {
    actionId: number
    requestId: number
    requestStartTime: number
  }) {
    if (this.eventHandler) {
      this.eventHandler.emit('request', {
        ...param,
        actionsQueueLength: this.actionsQueue.length,
        requestsInProgress: this.requestsInProgress,
        parallelLimit: this.maxParallelLimit + this.parallelLimitCorrection,
        rateLimit: this.rateLimit,
        retryTimeInterval: this.retryTimeInterval,
        timeIntervalCorrection: this.timeIntervalCorrection,
        rateLimitRemainingOnLastRevision: this.rateLimitRemainingOnLastRevision,
        rateLimitRemaining: this.rateLimitRemaining,
        planedProcessActionsTime: this.planedProcessActionsTime
      })
    }
  }

  private emitResponseStat(params: {
    type: string
    requestId: number
    requestStartTime: number
    requestDuration: number
    actionId: number
  }) {
    if (this.eventHandler) {
      this.eventHandler.emit('response', params)
    }
  }

  private processActions() {
    if (this.shouldProcessActions()) {
      this.requestsInProgress++

      const action = this.actionsQueue.shift()

      // наличие сообщений в очереди проверяется в shouldProcessActions
      if (action === undefined) {
        throw new Error('Внутренняя ошибка FetchPlanner - очередь пуста')
      }

      const requestId = this.getNewRequestId()
      const requestStartTime = Date.now()

      this.fetchApi(action.url, action.options)
        .then(resp => {
          const requestEndTime = Date.now()
          const requestDuration = requestEndTime - requestStartTime

          this.requestsInProgress--

          let responseType: ResponseType

          const rateLimit = resp.headers.get('X-RateLimit-Limit')
          if (rateLimit) {
            this.rateLimit = Number.parseInt(rateLimit)
          }

          const retryTimeInterval = resp.headers.get(
            'X-Lognex-Retry-TimeInterval'
          )
          if (retryTimeInterval) {
            this.retryTimeInterval = Number.parseInt(retryTimeInterval)
          }

          const rateLimitRemaining = resp.headers.get('X-RateLimit-Remaining')
          if (rateLimitRemaining) {
            this.rateLimitRemaining = Number.parseInt(rateLimitRemaining)
          }

          if (resp.status === 429) {
            // Возвращаем запрос в очередь
            this.actionsQueue = [action, ...this.actionsQueue]

            // Превышен лимит за временной промежуток
            const retryAfter = resp.headers.get('X-Lognex-Retry-After')

            if (retryAfter) {
              responseType = ResponseType.RATE_LIMIT_OVERFLOW

              this.addResponseTimeline({
                requestId,
                time: Date.now(),
                responseType: responseType
              })

              const retryAfterMs = Number.parseInt(retryAfter)

              this.planProcessActions(requestEndTime + retryAfterMs)
            }

            // Превышен лимит параллельных запросов
            else {
              responseType = ResponseType.PARALLEL_LIMIT_OVERFLOW

              this.addResponseTimeline({
                requestId,
                time: Date.now(),
                responseType
              })

              this.planProcessActions()
            }
          } else {
            responseType = ResponseType.OK

            this.addResponseTimeline({
              requestId,
              time: Date.now(),
              responseType
            })

            this.planProcessActions()

            action.resolve(resp)
          }

          this.emitResponseStat({
            actionId: action.actionId,
            type: responseType,
            requestId,
            requestStartTime,
            requestDuration
          })
        })
        .catch(err => {
          const requestDuration = Date.now() - requestStartTime

          this.requestsInProgress--

          this.planProcessActions()

          action.reject(err)

          this.emitResponseStat({
            actionId: action.actionId,
            type: 'ERROR',
            requestId,
            requestStartTime,
            requestDuration
          })
        })

      this.addRequestTimeline({
        requestId,
        time: requestStartTime
      })

      this.emitRequestInternalStat({
        actionId: action.actionId,
        requestId,
        requestStartTime
      })

      if (this.shouldProcessActions()) this.planProcessActions()
    }
  }

  fetch(url: RequestInfo, init?: RequestInit) {
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

    this.planProcessActions()

    return fetchPromise as Promise<Response>
  }
}

export function wrapFetchApi(fetchApi: Fetch, params?: FetchPlannerParams) {
  const planner = new FetchPlanner(fetchApi, params)
  return planner.fetch.bind(planner)
}
