# Архитектура и проверенные границы

Состояние реализации после T10–T120 плана 003; документация актуализирована 31.10.2026. Публичное использование, defaults и датированные ссылки на правила API находятся в [README](../README.md). Это описание локально проверенного поведения, не результат live stress и не разрешение на выпуск.

## Владение состоянием

1. `src/index.ts` — фасад: экспорт FetchPlanner, wrapFetch и публичные типы событий/опций. Runtime-экспорты фасада — FetchPlanner и wrapFetch.
2. `src/planner.ts` — единственный владелец actionsQueue, inflight, slot waiters, serverNotBefore и scheduling timeout. Все пути enqueue/completion сходятся в pump. Protected hook `checkFreeRequestSlotTrigger`, protected поля лимитов и публичные getters сохранены.
3. `src/pacing.ts` — чистые расчёты: валидация чисел, таблица 101 шага, адаптивная задержка и безопасная арифметика времени. Не управляет очередью, transport или таймерами.
4. `src/response-policy.ts` — чистое чтение status/headers. Не читает body и не владеет scheduler state.
5. `src/runtime.ts` — внутренние монотонные часы и предел одного timer chunk 2147483647 мс. Публичного runtime adapter нет.
6. `src/fetch-types.ts` — только типы Transport, UndiciFetch и Scheduled; runtime-счётчики для него не требуются.

Сохраняется собственный scheduler: замена общей очередью добавила бы второго владельца темпа, оставив response policy и lifecycle собственными [ALT, SURFACE]. Выделение модулей устраняет смешение расчётов и переходов состояния [ROOT].

## Lifecycle и владение transport

Action проходит `queued → running → terminal` либо `running → queued` при повторяемом 429. Только settleAction выполняет terminal resolve/reject; terminal action больше не ставится в очередь. На каждый отправленный transport приходится одно освобождение inflight после его settlement. FIFO сохраняется для ожидающих actions, retry помещается в начало.

Синхронная ошибка transport и rejected transport отвергают action без retry. Request observer вызывается после вызова transport. Если observer бросил исключение, action уже terminal, но transport остаётся наблюдаемым и занимает inflight до settlement. Его поздний Response очищается, поздняя ошибка не завершает action повторно.

После headers planner разбирает policy и обновляет полученные значения, затем синхронно вызывает response observer до resolve/requeue. Throw этого observer или ошибка разбора заголовков отвергают action и исключают повтор. Ошибка проходит через fetch-error. Если fetch-error observer тоже бросает, исходная ошибка сохраняется, а защищённая диагностика выдаёт только фиксированное `FetchPlanner observer failed`; ошибка самой диагностики перехватывается. Async listeners не поддерживаются как ожидаемые scheduler callbacks.

`OK` в response policy — любой HTTP-статус кроме 429. Поэтому 404/503 возвращаются как Response, а не как transport error. Приложение само проверяет HTTP-успех и бизнес-ошибки.

## Владение Response и телом

До передачи потребителю Response принадлежит planner. Любой непереданный ответ — 429, ответ с ошибкой headers/observer или поздний ответ terminal action — идёт через best-effort cleanup: вызов `body.cancel()` при наличии body, с перехватом синхронных ошибок и rejected Promise. Planner не ждёт окончания cancel. Зависший cancel не блокирует очередь, но успешное освобождение стороннего ресурса в таком случае не гарантировано.

После resolve потребитель получает тот же объект Response с непрочитанным body. Planner не читает, не клонирует и не отменяет переданный body. Inflight заканчивается на transport settlement/headers, без ожидания чтения тела потребителем; getter может ещё показывать занятый слот в job, который получил resolve, до завершения внутреннего finally. Это локальный предел ожидания headers, не предел всех открытых загрузок или серверных операций.

## Pump, время и параллелизм

Pump владеет одним scheduling timeout. Он учитывает максимум адаптивной задержки и оставшейся общей serverNotBefore-паузы. Новые 429 hints продлевают serverNotBefore максимумом абсолютных deadline; enqueue, reentrant callbacks, поздние headers и успешные ответы не сокращают уже полученную паузу. Устаревший callback проверяет владение таймером перед стартом. Пустая очередь не удерживает scheduling timeout.

Интервалы измеряются монотонными часами; события используют Date.now(), а getNextRequestTime переводит оставшийся интервал в текущий Unix timestamp либо возвращает 0 без таймера. Длинные безопасные интервалы сохраняются полностью и ждутся кусками не более 2147483647 мс. Небезопасная арифметика отвергается явно.

При поддержанном использовании correction лежит в `[1 - maxParallelLimit, 0]`, effective parallelism — в `[1, maxParallelLimit]`. Уменьшение лимита не отменяет уже отправленные transport; новые старты ждут ёмкости. Восстановление происходит при обработке работы, с прежней формулой периода и jitter, не отдельным постоянным interval.

Waiter проверяет `queue.length + inflight < effective parallelism`. Меньший числовой priority выбирается раньше; равные сохраняют порядок. Resolve — уведомление, не permit: ёмкость не резервируется, а общий deadline по-прежнему ограничивает отправку. Это не отдельный admission guard и не гарантия ограниченного размера очереди.

## Числа, headers и mutable options

Defaults и диапазоны options приведены в README и проверяются конструктором. GetOptions возвращает исходный mutable объект; изменение его полей не является поддержанным способом конфигурации. В частности, рассчитанная при создании таблица коэффициентов от mutation не обновляется. Диапазоны scheduler описаны для поддержанного использования, без такой mutation.

Отсутствующий header не обновляет соответствующее состояние. Числовые заголовки разбираются прежним parseInt с принятием числового prefix, затем проверяется безопасное целое: Limit > 0, Remaining ≥ 0, Retry-TimeInterval > 0 и Retry-After ≥ 0. Полностью нечисловые и небезопасные значения вызывают ошибку. Remaining > Limit сохраняется в getter; нормализованный уровень для формулы ограничивается единицей.

Адаптивная задержка использует `level = min(1, remaining / limit + elapsed / retryTimeInterval)`, округление level до одного из 101 шагов и коэффициент `(1 - step / 100) ** throttlingCoefficient`. Масштаб с jitter равен `maxRequestDelayTimeMs * (1 + jitter / 2 - random * jitter)`; результат округляется. При неизвестном limit/remaining или elapsed не меньше интервала задержка нулевая. Это прежний алгоритм обратной связи; он не измеряет вес каждого inflight-запроса и не доказывает оптимальную скорость.

## Типовой контракт

Transport — native `typeof globalThis.fetch` либо fetch из undici-types. Generic `F` связывает input/init, результат и события. Scheduled строит новую функцию из `Parameters<F>` с `Promise<Awaited<ReturnType<F>>>`. Проверены native и undici transports, а также совместимое расширение CustomInit/CustomResponse. Callable properties исходной функции не копируются. Произвольные generic-связи и все overloads пользовательского transport не обещаны: извлечение Parameters/ReturnType не равнозначно сохранению исходного типа F.

Для событий используйте `FetchPlannerEventMap<F>` и `FetchPlannerEventHandler<F>` с тем же F, что у planner; emit задаётся коррелированным union tuples. EventEmitter с соответствующей картой проверен; произвольный overload-only emitter автоматически совместимым не считается. В metadata method берётся из init.method, затем Request.method; для string/URL без init остаётся undefined.

Строгие package consumers проверяют TS 5.7.3 и TS 7, bare и undici 7.3.0, native Request/URL/FormData/File и bytes, исходный undici transport и отрицательные случаи несовместимых input/body/method/events. Декларации используют прямую undici-types 7.3.0; bare consumer не получает runtime undici. Проверены ESM root/deep imports; runtime import исходного TypeScript не обещан.

## Replay, cancellation и открытые решения до выпуска

Input, init и body передаются повторно без clone/buffering/body factory. Успешный string/Buffer retry проверен fake и native loopback transport. Первая отправка FormData/File/stream проверена отдельно и не доказывает replay любого тела. Потреблённый или locked Request/stream может вызвать transport error; action завершается один раз, очередь продолжает работу. Полная политика replay D10 остаётся этапу 4.

Signal остаётся собственностью transport. Немедленного удаления aborted queued action, освобождения его waiter и индивидуальной planner cancellation нет (D09). Публичного stop нет; его проектирование остаётся этапу 4.

ErrorLimits D12 — чужая незавершённая заготовка, сохранённая без counters/window/guard. Переданные 1/2/3 игнорируются, возвращаются defaults 100/100/100; даже эти defaults не останавливают повторные ошибки, PUT или 429. Защита от отключения API не реализована.

Классификация параллельности сохранена только для `HTTP 429 + X-Lognex-Auth: 429005`. JSON 1073 не разбирается. Только rate-overflow читает X-Lognex-Retry-After; Reset и стандартный Retry-After не используются. 429 без временных hints не получает отдельного backoff; retry может идти с нулевой адаптивной задержкой. Бессрочные корректные 429 retries сохранены. Решения о 1073 без legacy, fallback для no-hints 429, stop и errorLimits обязательны на этапе 4 до выпуска, текущий этап их не реализует.

Локальные fake/loopback, package и runtime checks не заменяют настоящий зелёный GitHub Actions run с runtime matrix и передачей artifact. Такой run ещё нужен до выпуска. Следующий major с минимумом Node 24 требует отдельного разрешения на version/changelog/tag/push/publish.
