# Архитектура operation API

Один coordinator управляет admission, dispatch, retry, временем и физическим владением работой. Публичный контракт находится в [API](api.md); сценарии подключения — в [руководстве агента](agent-guide.md). Этот документ нужен при изменении реализации.

## Карта модулей и единственный владелец

Все 16 source modules ниже образуют один coordinator; вспомогательные stores и чистые policies не создают scheduler.

| Модуль | Ответственность и зависимости |
| --- | --- |
| [index.ts](../src/index.ts) | Runtime exports FetchPlanner и OperationError; публичные type exports из operation-types |
| [planner.ts](../src/planner.ts) | Единственный coordinator admission/dispatch/retry, active/ready, commands, одного timer, deadlines, hooks и physical ownership; соединяет остальные механизмы |
| [operation-types.ts](../src/operation-types.ts) | Spec/Handle/Completed/contexts/snapshots/decisions, OperationError и внутренние ConsumeReadFailure/ConsumeHttpFailure; использует fetch-types |
| [fetch-types.ts](../src/fetch-types.ts) | Только типы Transport/UndiciFetch, без runtime; native либо declarations Undici7/8 |
| [callback-context.ts](../src/callback-context.ts) | ALS lifetime, detached observer delivery и guarded value boxes; отдельные owner/consume scopes у planner |
| [operation-capacity.ts](../src/operation-capacity.ts) | Reservation FIFO, leases и sent tokens, effective limit; без clocks/callbacks/scheduling |
| [operation-state.ts](../src/operation-state.ts) | Handle, single result commit/settlement, snapshots, resource settlement и publication через observation; не admission |
| [operation-resources.ts](../src/operation-resources.ts) | Attempt-local owner barrier, LIFO discard/disposal, общий cleanup Promise; использует callback context |
| [operation-observation.ts](../src/operation-observation.ts) | Atomic attachment/captured fanout, scalar diagnostics и sequence; Promise isolation, без policy |
| [operation-hooks.ts](../src/operation-hooks.ts) | Frozen HookContext, full-chain guarded decision materialization/validation; deadline и применение решения остаются planner |
| [response-policy.ts](../src/response-policy.ts) | Чистый status/header parsing, независимые hints и absolute pause через runtime; body не читает |
| [response-classifier.ts](../src/response-classifier.ts) | Bounded 429 reader/1073 и knownWork; не решает dispatch/retry |
| [retry-policy.ts](../src/retry-policy.ts) | Чистые candidate/eligibility/backoff по фактам, exact consume brand и budgets; не отправляет |
| [guard.ts](../src/guard.ts) | Синхронные rolling receipt/PUT windows и key capacity; coordinator задаёт время и момент charge |
| [pacing.ts](../src/pacing.ts) | Чистая таблица затухания, delay и проверяемая арифметика; не очередь |
| [runtime.ts](../src/runtime.ts) | Monotonic millisecond clock, safe absolute deadlines, timer chunk 2147483647 мс |

Сохраняется собственный coordinator: общая queue library добавила бы второго владельца, оставив HTTP policy и cleanup нерешёнными [ALT, ROOT]. Observation read-only и hooks control разделены явно [EXPLICIT]; facade, middleware и второй scheduler не нужны для текущей границы [SURFACE].

## Порядок выполнения

1. Submit валидирует spec и синхронно резервирует queued capacity; handle возвращается сразу.
2. Lease разрешает начать prepare. Owning callback создаёт descriptor/init/body и регистрирует cleanup; перед отправкой может выполниться beforeDispatch.
3. Coordinator повторно проверяет stop/abort/deadline, server pause, pacing, guard и effective parallelism. Последняя проверка, accounting и вход в transport выполняются без await между ними.
4. HTTP receipt обновляет policy/guard даже при позднем ответе. Только429 читает bounded classifier; остальные ответы получает consume.
5. До result commit проигравшее отмене значение проходит discard. После commit value сохраняется; известные reader/upload/callback/disposal работы заканчиваются отдельно.
6. Retry допускается после успешной cleanup и актуальной проверки safety/budgets. BeforeRetry удерживает owning lifetime; retry возвращается в FIFO и заново выполняет prepare.

Timer будит coordinator, но не выдаёт permit. Store, observer и callback также не владеют разрешением dispatch. Не добавляйте вторую очередь или scheduler вокруг отдельных попыток.

## Учёт физических ресурсов

`queued` включает pending submit reservations и retries. `leasedAttempts ≤ maxParallelLimit` ограничивает подготовку и физически незавершённую работу. `sentActive < effectiveParallelism` проверяется для новых отправок; снижение effective не отменяет уже отправленное. Consume с CPU/БД работой тоже занимает ёмкость.

Логический terminal может наступить до physical resources-settled. До фактического завершения известной работы lease/accounting нельзя освобождать внешним timeout. Request disposal останавливает cooperative producer до ожидания его завершения; reader cleanup и upload cleanup — разные barriers. Полные правила commit, discard и result conservation находятся в [API](api.md).

## Границы callbacks

Prepare/consume/dispose/discard/control hooks выполняются внутри owning AsyncLocalStorage lifetime, включая async/thenable assimilation, getters и извлечение результата. Зависимый submit того же planner запрещён до фактического выхода owner. Observation detached и read-only; команды listener проходят после полного fanout через FIFO command path. Повреждённый Promise constructor/species остаётся отдельной caller boundary и не ослабляет owning hooks.

HTTP marker и read marker имеют раздельную identity своего active consume lifetime. Coordinator извлекает исходную HTTP cause отдельно от retry eligibility, затем использует прежние cleanup barrier, общий budget и FIFO. Новая HTTP policy не создаёт scheduler; точные условия и backoff — [API](api.md#явный-http-retry).

## Карта проверок

| Область изменения | Основные suites |
| --- | --- |
| Admission, FIFO и ограничения | [admission](../test/operation/admission.test.ts), [capacity](../test/operation/capacity.test.ts), [commands](../test/operation/commands.test.ts) |
| Commit, отмена и ресурсы | [commit](../test/operation/commit.test.ts), [cancellation](../test/operation/cancellation.test.ts), [resources](../test/operation/resources.test.ts), [ownership](../test/operation/ownership.test.ts) |
| Transport, классификация и upload | [http-integration](../test/operation/http-integration.test.ts), [classifier](../test/operation/classifier.test.ts), [upload](../test/operation/upload.test.ts) |
| Управление и observation | [hooks-integration](../test/operation/hooks-integration.test.ts), [observation](../test/operation/observation.test.ts), [reentry](../test/operation/reentry.test.ts) |
| HTTP policy и pacing | [hints](../test/operation/hints.test.ts), [guard](../test/operation/guard.test.ts), [retry](../test/operation/retry.test.ts), [safe-http-retry](../test/operation/safe-http-retry.test.ts), [pacing](../test/operation/pacing.test.ts) |

Как подготовить среду и запустить suites — [разработка](development.md). Source/type, fake/loopback, package acceptance, Actions и эксплуатация — разные уровни проверки. Причины выбранных границ и условия их пересмотра — [обоснование](high-load-rationale.md).
