import { FetchPlanner } from './planner.js'
import type { parseResponsePolicy } from './response-policy.js'
import type { RequestInfo, RequestInit, Request, Response } from 'undici-types'

export { FetchPlanner }

type ResponseType = ReturnType<typeof parseResponsePolicy>['responseType']

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

  /** HTTP-метод запроса */
  method: RequestInit['method']

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

/** Событие с ошибкой вызванной вызовом fetch */
export interface FetchErrorEvent extends RequestEvent {
  /**
   * Ошибка
   */
  error: Error

  /** Время получения ошибки */
  errorTime: number
}

export type FetchPlannerEvents = RequestEvent | ResponseEvent | FetchErrorEvent

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

  /**
   * Событие `response` вызывается после получения ответа на запрос
   *
   * @see {@link FetchErrorEvent}
   */
  emit(eventName: 'fetch-error', data: FetchErrorEvent, instance: FetchPlanner): void
}

export interface FetchPlannerEventMap {
  'request': [RequestEvent, FetchPlanner]
  'response': [ResponseEvent, FetchPlanner]
  'fetch-error': [FetchErrorEvent, FetchPlanner]
}

/**
 * [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
 */
type Fetch = (url: RequestInfo, init?: RequestInit) => Promise<Response>

/**
 * Параметры планировщика запросов
 */
export interface FetchPlannerOptions {
  /**
   * Обработчик событий планировщика.
   *
   * Должен соответствовать следующему минимальному интерфейсу:
   *
   * ```ts
   * interface EventHandler {
   *   emit(eventName: string, data?: any): void
   * }
   * ```
   *
   * Можно использовать для логирования, сбора статистики и анализа нагрузки
   * на API.
   *
   * ```ts
   * const eventHandler = new EventEmitter<FetchPlannerEventMap>()
   *
   * eventHandler.on('response', (ev, planner) => {
   *   if (ev.responseType !== 'OK') {
   *     console.log(ev.responseType, planner.getRateLimitRemaining())
   *   }
   * })
   *
   * const fetchPlannerEventHandler = new FetchPlanner(fetch, { eventHandler })
   * ```
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

  /**
   * Ограничения на кол-во запросов, за превышение которых МойСклад блокирует доступ к API.
   */
  errorLimits: {
    /**
     * Максимальное кол-во идентичных запросов за минуту, которые завершились ошибкой, в течение последнего часа.
     */
    sameRequestsErrorPerMinuteLimit: number

    /**
     * Максимальное кол-во идентичных запросов за минуту, которые завершились ошибкой, в течение последнего часа.
     */
    tooManyRequestsErrorPerMinuteLimit: number

    /**
     * Максимальное кол-во PUT запросов к одной и той же сущности за минуту в течение последнего часа.
     */
    sameEntityPutRequestsPerMinuteLimit: number
  }
}

/**
 * Создает экземпляр планировщика и возвращает обернутый fetch
 */
export function wrapFetch(fetchApi: Fetch, options?: Partial<FetchPlannerOptions>) {
  return new FetchPlanner(fetchApi, options).getFetch()
}
