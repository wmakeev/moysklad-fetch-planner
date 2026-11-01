# Переход на submit → handle

Это чистая смена major API для Node ≥24/ESM. Нужна явная передача владения HTTP в библиотеку, затем законченного значения в приложение. Текущую поверхность проверяйте по [index.ts](../src/index.ts), [operation-types.ts](../src/operation-types.ts) и [coordinator](../src/planner.ts). Устройство модулей подробнее в [архитектуре](architecture.md); общая package/final acceptance нового API ещё не завершена.

## Что заменить

| Старое использование | Новый путь |
| --- | --- |
| wrapFetch/getFetch, передача facade в SDK fetch option | Явный planner.submit с prepare/consume и ожиданием handle.result; адаптера совместимости нет |
| Возврат raw Response после headers | Consume читает тело, завершает работу и возвращает готовое значение |
| Повтор прежнего init/body/Request | Fresh prepare каждой attempt, прежняя business identity приложения |
| EventEmitter/events и управление через listeners | Read-only observe; veto/defer отдельно через beforeDispatch/beforeRetry |
| Protected hooks и поля подкласса | Публичные typed hooks spec, без extension scheduler |
| Диагностические getters и slot waiters | Snapshot/atomic observe и bounded submit; уведомление не резервирует permit |
| Legacy errorLimits | Работающие локальные receipt/PUT guards с новой семантикой, без обещания account-level защиты |

Не оборачивайте Fetch SDK новым compatibility helper. Если SDK сам владеет отправкой и разбором Response, его внутренний fetch option не выражает новый контракт: перенесите конкретную операцию в prepare/consume. Прикладной parser, ошибки, business identity и публикация остаются у приложения. Observation и управление не возвращают старое владение headers-only.

Новый graph состоит из 16 модулей: index — публичные exports; planner — единственный coordinator; operation-types и type-only fetch-types — контракт и transport families; callback-context — owning ALS; operation-capacity — reservations/leases/sent tokens; operation-state — commit/settlement/handle; operation-resources — owner barrier и cleanup; operation-observation — detached fanout/sequence; operation-hooks — guarded validation; response-policy — headers; response-classifier — bounded429 reader; retry-policy — чистая eligibility; guard — rolling windows; pacing — формула; runtime — monotonic clocks/deadlines. Эти stores не становятся отдельными schedulers; второй queue layer не решает владение ресурсами [ALT, ROOT].

## Пример явной операции

Функция ниже не запускается при импорте. PUT entityKey стабилен для одной бизнес-сущности во всём instance; его нельзя генерировать заново на retry. JSON.stringify выполняется в prepare каждой attempt, body/init свежие; replay выключен. После result приложение проверяет данные и публикует их само. Для реального API приложение также передаёт свои headers/auth и проверяет прикладную схему.

```ts
import { FetchPlanner } from 'moysklad-fetch-planner'

const planner = new FetchPlanner(globalThis.fetch, {
  attemptTimeoutMs: 90_000,
  deadlineMs: 180_000,
  cleanupGraceMs: 5_000
})

export async function updateEntity(url: URL, entityKey: string, payload: unknown) {
  const handle = planner.submit({
    method: 'PUT',
    entityKey,
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({
      url,
      init: { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } }
    }),
    async consume(response) {
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
      return text
    }
  })
  try {
    return await handle.result
  } finally {
    await handle.resourcesDone
  }
}
```

Такой finally пригоден для кооперативных конечных ресурсов: он может ждать бесконечно при зависшем callback. Для bounded shutdown используйте собственное окно ожидания, сохраняя честное pending. Abort не доказывает rollback PUT.

Для undici используйте его собственную FormData/Response; runtime undici устанавливает потребитель, библиотека использует undici-types для деклараций. Root и deep import ведут к одному классу, source TypeScript не runtime entrypoint.

```ts
import { fetch, FormData } from 'undici'
import { FetchPlanner } from 'moysklad-fetch-planner/build/src/planner.js'
import type { Handle, Init } from 'moysklad-fetch-planner'

const planner = new FetchPlanner<typeof fetch>(fetch)

export function sendForm(url: URL, value: string): Handle<number> {
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

Это только пример family typing, не формат формы JSON API. Caller обязан обработать result и resourcesDone возвращённого handle, как в предыдущем примере.

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

## Порядок переноса потребителя

1. Зафиксируйте business identity, прикладную схему/ошибки и последствия неизвестного server outcome; отдельно обоснуйте обе replay flags. Без основания оставьте обе false.
2. Перенесите создание descriptor/init/body в fresh prepare, зарегистрируйте disposal до следующего await; для streaming подготовьте cooperative stop-and-wait producer. Чтение и временные результаты перенесите в consume/onDiscard, публикацию — после result.
3. Перенесите диагностику в detached observe, управление — в typed hooks. Не ожидайте разрешения отправки от callback, timer или snapshot и не submit-ьте зависимую работу внутри owning callback на том же planner.
4. Проверьте свои budgets тяжёлой операции и shutdown, затем strict types и локальные переходы с fake/loopback. Не считайте source compile приёмкой установленного пакета, hidden transport tries или эксплуатации у лимитов.

Проверенные локальные границы можно сопоставить с [commit](../test/operation/commit.test.ts), [C5](../test/operation/observation.test.ts), [T70/T71](../test/operation/http-integration.test.ts) и [hooks](../test/operation/hooks-integration.test.ts). План миграции не разрешает live/stress/аккаунты, запуск samples или package runtime fixtures. Fresh package consumers, общий coverage/entrypoint, финальная приёмка и Actions имеют отдельные gates; прежний tarball не подтверждает новый API. Для последующей интеграции используйте [руководство](integration-guide.md) и [обоснование](high-load-rationale.md), не принимая предложенную telemetry за готовую возможность.
