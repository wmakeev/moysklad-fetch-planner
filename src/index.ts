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
   * Классификация ответа по HTTP-статусу и заголовкам:
   *
   * - `OK` - любой ответ со статусом не 429, включая HTTP-ошибки
   * - `RATE_LIMIT_OVERFLOW` - HTTP 429 без `X-Lognex-Auth: 429005`
   * - `PARALLEL_LIMIT_OVERFLOW` - HTTP 429 с `X-Lognex-Auth: 429005`
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
   * Синхронный FetchPlannerEventHandler<F>: emit получает коррелированный tuple
   * имени события, данных и FetchPlanner<F>. Async listeners не ожидаются.
   *
   * Можно использовать для логирования, сбора статистики и анализа нагрузки
   * на API.
   *
   * ```ts
   * const eventHandler = new EventEmitter<FetchPlannerEventMap<typeof globalThis.fetch>>()
   *
   * eventHandler.on('response', (ev, planner) => {
   *   if (ev.responseType !== 'OK') {
   *     console.log(ev.responseType, planner.getRateLimitRemaining())
   *   }
   * })
   *
   * const fetchPlanner = new FetchPlanner(globalThis.fetch, { eventHandler })
   * ```
   *
   * @see {@link FetchPlannerEventHandler} детальное описание событий
   */
  eventHandler?: FetchPlannerEventHandler<F> | undefined

  /**
   * Степень затухания адаптивной задержки по полученным заголовкам бюджета.
   *
   * Уровень рассчитывается из `X-RateLimit-Remaining / X-RateLimit-Limit`
   * с учётом времени с последнего старта и `X-Lognex-Retry-TimeInterval`,
   * ограничивается единицей и округляется до одного из 101 шагов.
   * Множитель задержки равен `(1 - step / 100) ** throttlingCoefficient`.
   * При коэффициенте `1` зависимость линейная; больший коэффициент уменьшает
   * задержку при том же промежуточном уровне бюджета.
   *
   * Это обратная связь по headers, без учёта веса каждого inflight-запроса.
   * Универсальный средний темп, оптимальная скорость и защита аккаунта
   * не гарантируются. Границы алгоритма и датированные правила API — в README.
   *
   * **По умолчанию:** `5` (конечное число от `1` до `20` включительно)
   */
  throttlingCoefficient: number

  /**
   * Локальный предел параллельных transport, ожидающих ответа до headers.
   * Чтение тела потребителем в этот счётчик не входит.
   *
   * При `PARALLEL_LIMIT_OVERFLOW` локальный предел уменьшается с шагом `1`,
   * оставаясь не ниже `1`, затем восстанавливается до `maxParallelLimit`.
   * Уже отправленные запросы при уменьшении предела не отменяются.
   * Значение выбирает приложение с учётом серверных ограничений и соседней нагрузки.
   *
   * **По умолчанию:** `4` (округляется до безопасного целого не меньше `1`;
   * верхнего ограничения числом `5` в валидаторе нет)
   */
  maxParallelLimit: number

  /**
   * Базовый масштаб адаптивной задержки в миллисекундах.
   *
   * Масштаб умножается на `1 + jitter / 2 - random * jitter`, затем на
   * коэффициент затухания; результат округляется. При неизвестном limit/remaining
   * или истёкшем Retry-TimeInterval адаптивная задержка равна нулю.
   * Планирование учитывает максимум адаптивной задержки и оставшейся серверной
   * паузы. Jitter и серверная пауза могут превысить `maxRequestDelayTimeMs`:
   * это не жёсткий потолок всего ожидания.
   *
   * **По умолчанию:** `3000` (округляется до безопасного целого не меньше `1`)
   */
  maxRequestDelayTimeMs: number

  /**
   * Доля от значения `maxRequestDelayTimeMs` в пределах которой будет случайным образом изменено значение `maxRequestDelayTimeMs` при расчете величины задержки между запросами.
   *
   * Случайное изменение масштаба не гарантирует равномерного распределения нагрузки.
   *
   * **По умолчанию:** `0.1` (конечная доля от `0` до `0.3` включительно).
   * При базовом масштабе `3000` и jitter `0.1` масштаб формулы лежит
   * в диапазоне от `2850` до `3150` мс.
   */
  jitter: number

  /**
   * Базовый период восстановления локального предела параллельных запросов.
   *
   * Лимит уменьшается при каждой ошибке превышения кол-ва параллельных запросов с шагом `1`.
   *
   * При обработке работы лимит восстанавливается до `maxParallelLimit` с шагом `1`,
   * когда прошло больше `period * (1 + 2 * random * jitter)` мс.
   * Отдельного постоянного таймера восстановления нет.
   *
   * **По умолчанию:** `10000` (округляется до безопасного целого не меньше `1000`)
   */
  parallelLimitCorrectionPeriodMs: number

  /**
   * Незавершённая заготовка: переданные значения игнорируются, каждый default
   * равен `100`. Счётчиков, окна и guard нет; защита от отключения API не реализована.
   */
  errorLimits: {
    /**
     * Неиспользуемый порог идентичных ошибочных запросов; default `100`.
     */
    sameRequestsErrorPerMinuteLimit: number

    /**
     * Неиспользуемый порог ответов 429; default `100`.
     */
    tooManyRequestsErrorPerMinuteLimit: number

    /**
     * Неиспользуемый порог PUT к одной сущности; default `100`.
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
