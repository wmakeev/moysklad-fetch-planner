# Архитектура operation API

Библиотека Node ≥24/ESM координирует законченные HTTP-операции `submit → handle`. Публичная поверхность задана [index.ts](../src/index.ts), [operation-types.ts](../src/operation-types.ts) и [реализацией](../src/planner.ts); практический вход — [README](../README.md), переход — [миграция](migration.md). Локальные source/type и fake/loopback проверки не равны package acceptance, эксплуатации под нагрузкой или оптимальности pacing. Общая приёмка нового пакета ещё не завершена.

## Карта модулей и единственный владелец

Все 16 source modules ниже образуют один coordinator; вспомогательные stores и чистые policies не создают scheduler.

| Модуль | Ответственность и зависимости |
| --- | --- |
| [index.ts](../src/index.ts) | Runtime exports FetchPlanner и OperationError; публичные type exports из operation-types |
| [planner.ts](../src/planner.ts) | Единственный coordinator admission/dispatch/retry, active/ready, commands, одного timer, deadlines, hooks и physical ownership; соединяет остальные механизмы |
| [operation-types.ts](../src/operation-types.ts) | Spec/Handle/Completed/contexts/snapshots/decisions, OperationError и внутренний ConsumeReadFailure; использует fetch-types |
| [fetch-types.ts](../src/fetch-types.ts) | Только типы Transport/UndiciFetch, без runtime; native либо undici-types |
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

## Переходы и accounting

Основной путь: queued → preparing → ready → sending → classifying → consuming → cleanup → terminal. Перехваченный 429 пропускает consume; безопасный отказ после cleanup может перейти в retry-wait → queued. Логический terminal может наступить раньше физического resources-settled; late receipts по-прежнему обновляют HTTP policy/guard и безопасные факты, не завершают result повторно.

`queued` включает reservations отложенных команд и retries. `leasedAttempts ≤ maxParallelLimit` ограничивает подготовку и физически незавершённую работу, проверка `sentActive < effectiveParallelism` управляет допуском новых отправок (снижение effective не отменяет текущие). Sent token держится через consume и HTTP/resource cleanup; CPU/БД в consume также занимают ёмкость. Admission повторяет актуальные ограничения перед фактическим входом F; один monotonic timer лишь будит pump, длинный deadline ждётся безопасными chunks. Ограничение количества операций не доказывает общего предела памяти.

## Типы и граница HTTP

`FetchPlanner<F>` выбирает одну конкретную функцию транспорта: native `typeof globalThis.fetch` либо undici 7.3. `Init<F>` и `ResponseOf<F>` связаны с тем же F; `OneTransport<F>` исключает union семейств. Native FormData/File/stream и undici body/Response нельзя смешивать приведением типов. Native Response имеет `bytes()`, undici 7.3 использует `arrayBuffer()`. Совместимые расширения одной семьи возможны; сохранение произвольных overloads и callable properties не обещано.

`prepare` возвращает `{url: string | URL, init}`, не Request. Method задаётся в spec заглавными буквами; PUT требует стабильный `entityKey` длиной 1–128 символов без URL/секретов, остальные методы его не принимают. `init.method` и `init.signal` запрещены: coordinator добавляет method и новый AbortController каждой попытки. Тип метода не гарантирует поддержку endpoint или transport. Каждая попытка заново вызывает prepare: свежие init/body с тем же payload и той же business identity приложения; clone/buffering библиотека не делает.

Все ответы кроме перехваченного 429 передаются в consume непрочитанными, включая 412 с errors[].code/parameter, частичный bulk и HTML. Приложение проверяет HTTP, Content-Type, схему и бизнес-ошибки, читает тело и возвращает законченное T. Живые Response/reader/stream не являются законченным результатом; generic T не проверяет это автоматически. Fulfilled result не означает обязательный HTTP2xx или бизнес-commit.

## Commit, отмена и ресурсы

1. `submit` синхронно возвращает handle; ожидать нужно `handle.result`, у handle нет then. Отказ принятия возвращает failed handle с id=0, без индивидуальной истории; ошибки конструктора и лимита подписок синхронны. Принятые IDs начинаются с 1, sequence общая для planner, переполнение явно закрывает новые действия.
2. Регистрируйте `ctx.onDispose` сразу после acquisition, до следующего await; частичное приобретение до регистрации callback очищает сам. `ctx.onDiscard` принадлежит consume и уничтожает временный результат при throw или отмене до commit. Регистрации действуют только внутри своего активного callback; discard и disposal выполняются LIFO, один раз на регистрацию. Disposers ждут фактического возврата владельца prepare/consume.
3. После consume coordinator заново проверяет время/отмену и атомарно фиксирует value: `resultCommitted=true`, discard снимается. До этой точки поздний value проигравшего отмене callback уничтожается через discard. После commit abort, timeout и failed/pending cleanup сохраняют успешный value; повтор HTTP для него запрещён. Публикация, rename, сообщение и commit в БД принадлежат приложению после result.
4. `result` возвращает `{value, status, cleanup}`. Cleanup равен released/failed/pending на момент выдачи, unknown отображается здесь как failed. После commit ожидание ограничено `min(cleanupGraceMs, остаток общего deadline)`; abort может сократить ожидание, сохранив успех. Это grace ожидания результата, не физический timeout очистки.
5. `resourcesDone` отдельно завершается `{resources: released | failed | unknown}` после всех известных работ. Пока callback/upload/disposer физически pending, accounting сохраняется, даже после логического result. Failed/unknown не означают доказанного освобождения. Зависший callback удерживает lease и может навсегда оставить resourcesDone pending; forced stop чужого кода не обещан.

`planner.stop()` запрещает новые отправки и повторы, отменяет неотправленное; уже sent POST продолжает текущую попытку. `handle.abort()` и deadline завершают результат логически и сигнализируют отмену. Ни abort, ни timeout не доказывают отсутствия серверной записи: неизвестный исход требует прикладной сверки, это не rollback и не exactly-once. `OperationError` сохраняет code/phase/operationId/attemptNumber/dispatchEntered, известный status и serverOutcome; cause доступен caller, не observation. При HTTP200 с обрывом чтения статус остаётся 200; serverOutcome описывает наличие HTTP-ответа, а не подтверждение бизнесрезультата.

## Retry и cooperative upload

Обязательные `replay: {serverSafe, consumeSafe}` разрешают повтор только при обеих true. Метод и статус сами по себе безопасность не доказывают. Нужны подходящий failure, успешная известная cleanup и оставшиеся бюджеты; default maxAttempts=3 считает начатые prepare, общий deadline не перезапускается, retry занимает reservation и возвращается в хвост FIFO.

Кандидаты: перехваченный 429, ошибка отправленного transport до известного ответа и HTTP2xx с `throw ctx.retryableReadFailure(cause)` из своего точного активного consume. Brand привязан к этой lifetime, его нельзя переносить между callbacks/операциями. Произвольный TypeError, ошибка JSON/схемы/БД, prepare, hooks, timeout и cleanup не разрешают replay. Non2xx кроме 429 никогда не automatic candidate, даже с brand и обеими flags; 500/503 автоматически не повторяются.

Локальная проверка реального errored body при HTTP200 (T70) подтверждает terminal исход при failed/unknown cleanup даже с brand. Положительный случай того же набора — exact active brand на 2xx, обе flags, released cleanup и бюджеты. Это не универсальная поддержка replay после любого wire read failure: ошибка чтения и доказанная очистка — разные условия.

Ранний Response, EOF ответа и abort не доказывают окончания исходящего upload. Request-disposer должен активно остановить принадлежащий приложению producer и дождаться всех известных pull/чтений/handles: stop-and-wait. До этого следующая попытка запрещена и accounting удерживается. Core доверяет этому обязательству; arbitrary producer со скрытой работой не становится безопасным от одного signal или body.cancel().

Same-operation early429 проверка T71 охватывает native и undici с отдельным собственным Agent и cooperative producer: свежие stream/init, полный одинаковый payload, barrier чтения ответа и barrier producer/disposal до следующей попытки, release/await/close в finally. Это не доказательство для default pool, произвольного upload, TLS/HTTP2, аккаунта целиком или скрытых wire tries/redirects внутри transport. Счётчик dispatchCalls считает входы в F, не все сетевые попытки. Выбранный transport обязан не делать скрытых retries; redirects не учитываются как отдельные attempts.

Тяжёлый bulk требует явно выбранных `attemptTimeoutMs`, `deadlineMs` и `cleanupGraceMs` плюс disposal. Default 30000 мс на attempt начинается с prepare и не универсален; deadline включает очередь, prepare, HTTP, consume, cleanup и hooks. Например, 90000/180000/5000 — только прикладной выбор бюджета, не измеренное время сервера. Даже такой бюджет не заменяет cooperative producer; для shutdown приложение учитывает handles/resourcesDone и собственное окно ожидания, не объявляя pending ресурсы освобождёнными.

## Control hooks и owning lifetime

Оба hooks реализованы и опциональны в spec: `beforeDispatch` и `beforeRetry`. Контекст — frozen detached snapshot, signal, attemptNumber, dispatchCalls и известный status, без payload. Решения: `{type:'allow'}`, `{type:'deny',code:'POLICY_DENIED'}` или `{type:'defer',delayMs}`. Deny даёт terminal HOOK_DENIED; throw, invalid return и timeout — HOOK_FAILED без retry. Delay должен быть положительным finite safe integer, без лишних полей. Default hookTimeoutMs=1000 в пределах общего deadline; late answer после логического окончания не управляет dispatch.

BeforeDispatch вызывается один раз на attempt после prepare; defer задаёт monotonic notBefore, timer не вызывает hook заново. После await и непосредственно перед transport повторно проверяются stop/abort/deadline, server pause, pacing, effective parallelism и guard. Материализация descriptor/init/getters происходит до последнего admission; финальная проверка, accounting и вход в F идут синхронно без await и observer fanout между ними. Пробуждение timer и возврат listener не являются permit.

BeforeRetry вызывается только для уже безопасного кандидата после успешной reader/upload/discard/disposal cleanup и проверки budgets/replay. Он не делает unsafe failure повторяемым. Внутренний выбранный policy floor заморожен на время hook: allow его не сокращает, defer берётся максимумом, новые receipts могут только увеличить обязательную паузу. После await заново проверяются terminal state и актуальные replay flags; backoff не начинается заново от конца hook.

Owning callbacks prepare/consume/dispose/discard/hooks защищены полным AsyncLocalStorage lifetime: await, рекурсивная Promise/thenable assimilation, then getters и извлечение/materialization результата включены. Вложенный submit на том же planner получает REENTRANT_OPERATION, в том числе после await и после логического timeout, пока владелец фактически не вернулся. Это не sandbox для произвольного JS. BeforeRetry после законченной HTTP cleanup может освободить sentActive, но держит физическую lease и resourcesDone до полного settlement hook. Pending hook при maxParallelLimit=1 не даёт следующему prepare начаться даже после HOOK_FAILED/abort/stop; поздний allow не отправляет запрос.

## Detached observation и граница Promise

`planner.observe` и `handle.observe` атомарно возвращают snapshot+unsubscribe; initial snapshot не доставляется callback, дальнейшие records имеют большую sequence, история не replay-ится. Каждый listener получает отдельный frozen scalar record после commit всех полей. Нет raw URL/headers/body/signal/Error/cause/value/entityKey. EpochTime — wall clock для отображения, elapsedMs — monotonic, serverNotBefore также monotonic, sequence задаёт порядок.

Operation snapshot содержит id/sequence, phase/outcome/resultCommitted/resources, attempts/dispatchCalls/dispatchEntered, известный status/failureCode. Planner snapshot содержит sequence, stopped/guardOpen, queued/leasedAttempts/sentActive/effectiveParallelism и serverNotBefore, без active list. Event type закрыт: created, phase-changed, dispatch-deferred, dispatch-started, headers-received, retry-scheduled, operation-settled, resources-settled, late-completion; фактический путь не обязан проходить каждый тип.

Полный текущий fanout завершается до FIFO drain команд; события каждой команды доставляются до следующей команды, recursive pump нет. Изменение подписок действует со следующего record, unsubscribe idempotent; уже захваченный listener вызывается. Observer detached от owning ALS и может submit через очередь. Reservation/id выделяются сразу до drain: pending submit учитывается в maxQueuedOperations; QUEUE_FULL не удерживает spec и не создаёт рекурсивный event backlog. Stop коалесцируется в одну команду planner, abort — в одну на принятый незавершённый handle, с первой причиной. Конечный burst ограничен bookkeeping, но синхронный бесконечный listener блокирует JS; latency isolation и общий предел памяти caller не обещаны.

Возврат observer не управляет policy и не await-ится. Поддержаны обычный async listener и genuine Promise с poisoned собственными then/catch: intrinsic `Promise.prototype.then` обходит эти свойства и отбрасывает fulfillment value. Синхронный throw и стандартные ошибки thenable assimilation изолируются; фиксированный OBSERVER_FAILED не порождает нового события. Это C5 read-only boundary, не ослабление полного owning lifetime C6.

Constructor, Symbol.species и NewPromiseCapability всё ещё участвуют в attachment. Их повреждение может сорвать присоединение handler или создать небезопасную derived chain. Catch ошибки attachment не заменяет rejection handler. Caller отвечает за original, derived и будущие rejection заранее, ДО poison; одного handler на original недостаточно против произвольной custom capability. После этого нужно вернуть undefined либо безопасную обычную цепочку, созданную до повреждения протокола. `Promise.resolve(damaged)` и `await damaged` не являются универсальным ремонтом; без prehandling нельзя обещать выживание host process. Скрытые Promise thenable, rejection которых не передаётся стандартной assimilation, также принадлежат caller.

Ниже рецепт для собственного ordinary Promise: безопасная цепочка присоединяется до изменения constructor, обе ветви завершаются undefined и не бросают. Повреждённый original не возвращается библиотеке; вместо safe можно вернуть undefined, сохранив предварительную обработку. Рецепт не изолирует произвольные побочные эффекты custom constructor/species.

```ts
import { FetchPlanner, type Event } from 'moysklad-fetch-planner'

export function attachSafeObserver(
  planner: FetchPlanner<typeof globalThis.fetch>,
  exportEvent: (event: Event) => Promise<void>
) {
  const listener: (event: Event) => unknown = event => {
    const work = exportEvent(event) // Обычный Promise, ещё с целым протоколом.
    const safe = work.then(() => undefined, () => undefined)
    void Object.defineProperty(work, 'constructor', { value: null })
    return safe // Обычная цепочка создана ДО poison; original уже обработан.
  }
  return planner.observe(listener)
}
```

После resourcesDone coordinator удаляет operation из active registry, handle сохраняет небольшой final snapshot, operation subscriptions освобождаются после последнего resources-settled. Бесконечно pending callbacks удерживают bounded leases; maxQueuedOperations ограничивает очередь, а не размер body, closure или количества registrations приложения.

## HTTP policy и область защиты

Coordinator перехватывает только 429: classifier читает JSON 1073 максимум 65536 принятых байт и 250 мс, поддержан также legacy X-Lognex-Auth: 429005. Malformed/nonJSON/oversize/read failure дают generic429 с сохранением status/hints; частичное тело consume не получает. Размер уже выделенного transport chunk этим не ограничен. Reader knownWork ждёт фактические read/cancel, отдельно от логического classifier result.

Hints X-Lognex-Retry-After/Reset читаются как мс, стандартный Retry-After — секунды или HTTP date. Полные decimal safe integers проверяются независимо, invalid hint учитывается без потери остальных; поздний success не сокращает server pause. Положительный 429 fallback: `min(30000, 3000 * 2^(ordinal-1)) * factor`, factor 0.8–1.2, cap до множителя. Pacing использует remaining/limit, время, 101 шаг затухания и jitter; correction удерживает effective parallelism в пределах 1..maxParallelLimit и восстанавливает по одному шагу при обработке работы. Эти локальные формулы не доказывают оптимальность темпа.

Guard instance считает rolling 60000 мс: HTTP≥400 receipts default100 и отдельно 429 default100, включая поздние ответы. Достижение порога навсегда запрещает новые dispatch с GUARD_OPEN; ранее sent попытки могут дать новые receipts. PUT default60 dispatch на один entityKey, включая retries; следующий PUT_LIMIT без общего stop. При 1024 живых keys новый получает GUARD_CAPACITY, живая история не вытесняется. Одинаковой сущности нужен одинаковый ключ во всём instance; coordinator не может проверить это соглашение приложения.

Это консервативная локальная политика, не точная копия отключения МойСклад, не account-level защита других instances/процессов. Правила vendor проверяются по актуальным первичным [ограничениям API](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_restrictions.md); локальный guard не измеряет серверный часовой учёт и не координирует чужие интеграции.

## Проверяемые примеры семейства и бюджета

Пример только объявляет функцию bulk приложения. `openUpload` каждый раз создаёт fresh cooperative источник с тем же логическим payload; он сам очищает partial acquisition при ошибке. При успешном acquisition регистрация стоит до следующего await. Приложение обрабатывает result и resourcesDone возвращённого handle; replay записи выключен.

```ts
import { ReadableStream } from 'node:stream/web'
import { FetchPlanner } from 'moysklad-fetch-planner'

interface Upload {
  body: ReadableStream<Uint8Array>
  stopAndWait(): Promise<void>
}

const planner = new FetchPlanner(globalThis.fetch, {
  attemptTimeoutMs: 90_000,
  deadlineMs: 180_000,
  cleanupGraceMs: 5_000
})

export function submitBulk(url: URL, openUpload: (signal: AbortSignal) => Promise<Upload>) {
  return planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    async prepare(ctx) {
      const upload = await openUpload(ctx.signal)
      ctx.onDispose(() => upload.stopAndWait())
      return { url, init: { body: upload.body, duplex: 'half' } }
    },
    consume: response => response.text()
  })
}
```

Deep import выбирает тот же класс; undici body и response остаются своей семьёй. Пример FormData показывает typing, не формат JSON API МойСклад.

```ts
import { fetch, FormData } from 'undici'
import { FetchPlanner } from 'moysklad-fetch-planner/build/src/planner.js'
import type { Init } from 'moysklad-fetch-planner'

const planner = new FetchPlanner<typeof fetch>(fetch)

export function submitForm(url: URL, value: string) {
  return planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare() {
      const body = new FormData()
      body.set('value', value)
      const init: Init<typeof fetch> = { body }
      return { url, init }
    },
    async consume(response) {
      return (await response.arrayBuffer()).byteLength
    }
  })
}
```

## Снятая поверхность и предел доказательств

wrapFetch/getFetch, SDK fetch injection, EventEmitter/events, protected extension API, slot waiters/getters и legacy errorLimits удалены. Используйте explicit submit, snapshot/observe и hooks; compatibility helper нет. Старая граница headers-only и повтор использованного body не сохраняются.

Переходы проверяются в [operation tests](../test/operation/integration.test.ts), [commit](../test/operation/commit.test.ts), [C5](../test/operation/observation.test.ts), [HTTP T70/T71](../test/operation/http-integration.test.ts) и [hooks](../test/operation/hooks-integration.test.ts). Это локальные инварианты и ограниченные cooperative loopback proofs; source snippet compile не проверяет установленный tarball. Новый package/final acceptance, реальное использование и внешний Actions требуют своих gates. Причины и эксплуатационные гипотезы: [обоснование](high-load-rationale.md), [руководство](integration-guide.md); предлагаемые там измерения не являются уже реализованной telemetry.
