import { FetchPlanner } from './planner.js'
import type { parseResponsePolicy } from './response-policy.js'
import type { Transport } from './fetch-types.js'

export { FetchPlanner }

type ResponseType = ReturnType<typeof parseResponsePolicy>['responseType']

/** Событие с информацией о выполняемом запросе */
export interface RequestEvent<F extends Transport = Transport> {
  /** Id задачи в планировщике */
  actionId: number

  /**
   * Id отдельного запроса.
   * Одна задача может выполнятся несколько раз при повторе в случае ошибки
   */
  requestId: number

  /** Строка запроса */
  url: Parameters<F>[0]

  /** HTTP-метод запроса */
  method: NonNullable<Parameters<F>[1]>['method']

  /** Время начала запроса */
  startTime: number
}

/** Событие с информацией о выполненном запросе */
export interface ResponseEvent<F extends Transport = Transport> extends RequestEvent<F> {
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
export interface FetchErrorEvent<F extends Transport = Transport> extends RequestEvent<F> {
  /**
   * Ошибка
   */
  error: Error

  /** Время получения ошибки */
  errorTime: number
}

export type FetchPlannerEvents<F extends Transport = Transport> =
  | RequestEvent<F>
  | ResponseEvent<F>
  | FetchErrorEvent<F>

/** Synchronous observers, correlated by the event map. */
export interface FetchPlannerEventHandler<F extends Transport = Transport> {
  emit: (
    ...args: {
      [K in keyof FetchPlannerEventMap<F>]: [name: K, ...args: FetchPlannerEventMap<F>[K]]
    }[keyof FetchPlannerEventMap<F>]
  ) => void
}

export interface FetchPlannerEventMap<F extends Transport = Transport> {
  'request': [RequestEvent<F>, FetchPlanner<F>]
  'response': [ResponseEvent<F>, FetchPlanner<F>]
  'fetch-error': [FetchErrorEvent<F>, FetchPlanner<F>]
}

/**
 * Параметры планировщика запросов
 */
export interface FetchPlannerOptions<F extends Transport = Transport> {
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
  eventHandler?: FetchPlannerEventHandler<F> | undefined

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
export function wrapFetch<F extends Transport>(
  fetchApi: F,
  options?: Partial<FetchPlannerOptions<F>>
) {
  return new FetchPlanner(fetchApi, options).getFetch()
}
