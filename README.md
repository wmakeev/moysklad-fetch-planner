# moysklad-fetch-planner <!-- omit in toc -->

[![npm](https://img.shields.io/npm/v/moysklad-fetch-planner.svg?cacheSeconds=1800&style=flat-square)](https://www.npmjs.com/package/moysklad-fetch-planner) [![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/wmakeev/moysklad-fetch-planner/main.yml?style=flat-square)](https://github.com/wmakeev/moysklad-fetch-planner/actions/workflows/main.yml) [![Codecov](https://img.shields.io/codecov/c/github/wmakeev/moysklad-fetch-planner?style=flat-square)](https://app.codecov.io/gh/wmakeev/moysklad-fetch-planner/tree/master/)

> Планировщик законченных HTTP-операций для API МойСклад

Node ≥24, ESM. Библиотека координирует очередь, отправки, повторы, адаптацию к заголовкам и очистку ресурсов одного экземпляра. Приложение создаёт свежий запрос в `prepare`, полностью обрабатывает ответ в `consume` и получает готовое значение через `handle.result`.

Текущая модель — `submit → handle`, без прозрачной подстановки в Fetch SDK. Общая локальная приёмка нового пакета ещё не завершена; опубликованная версия на badge не подтверждает наличие этого API. Причины выбранной границы: [обоснование](docs/high-load-rationale.md); подключение к внешней системе: [руководство интеграции](docs/integration-guide.md).

## Быстрый старт: native fetch

```ts
import { FetchPlanner, OperationError } from 'moysklad-fetch-planner'

const planner = new FetchPlanner(globalThis.fetch)

export async function loadOrders(token: string) {
  const handle = planner.submit({
    method: 'GET',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: () => ({
      url: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder?limit=100',
      init: {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept-Encoding': 'gzip' }
      }
    }),
    async consume(response) {
      // Все non429 ответы доступны приложению, включая HTTP-ошибки и HTML.
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
      const data: unknown = JSON.parse(text)
      return data // Проверку прикладной схемы добавляет приложение.
    }
  })
  try {
    const completed = await handle.result
    console.log(completed.status, completed.cleanup)
    return completed.value
  } catch (error) {
    if (error instanceof OperationError) {
      console.error(error.code, error.status, error.serverOutcome)
    }
    throw error
  } finally {
    const resources = await handle.resourcesDone
    console.log(resources.resources)
  }
}
```

Пример только объявляет функцию. Токен передаёт приложение; библиотека его не получает из окружения. `handle` не имеет `then`: ожидать нужно `handle.result`. Ожидание `resourcesDone` в `finally` подходит для кооперативных ресурсов и может остаться незавершённым при зависшем callback; для shutdown приложение задаёт собственное окно ожидания, не объявляя ресурсы освобождёнными по его истечении.

### Типы, method и transport family

`FetchPlanner<F>` связывает `Init<F>` и `ResponseOf<F>` с одной конкретной функцией транспорта. `prepare` возвращает `{url: string | URL, init}`; готовый `Request` не принимается. `method` задаётся в spec заглавными буквами: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, TRACE или CONNECT. Для PUT обязателен `entityKey`, для остальных методов он запрещён. `init.method` и `init.signal` запрещены: coordinator добавляет method и свежий signal сам. Поддержка метода типом не означает, что выбранный transport или endpoint его разрешает.

Native body использует native FormData/File/stream; undici — своё семейство. Не объединяйте transports в union и не расширяйте типы body/response приведением. Совместимое расширение одной семьи может вывести собственный `F`; произвольные overloads и callable properties не обещаны. Native `Response.bytes()` и undici 7.3 `Response.arrayBuffer()` различаются.

Deep import того же класса с явно выбранным undici 7.3:

```ts
import { fetch, FormData } from 'undici'
import { FetchPlanner } from 'moysklad-fetch-planner/build/src/planner.js'
import type { Handle, Init } from 'moysklad-fetch-planner'

const planner = new FetchPlanner<typeof fetch>(fetch)

export function submitForm(url: URL, field: string): Handle<number> {
  return planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare() {
      const body = new FormData()
      body.set('field', field)
      const init: Init<typeof fetch> = { body }
      return { url, init }
    },
    async consume(response) {
      const bytes = await response.arrayBuffer()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return bytes.byteLength
    }
  })
}
```

Это пример transport typing, не рецепт формы JSON API. Приложение обрабатывает `result` и `resourcesDone` возвращённого handle, как в первом примере. Runtime undici устанавливает использующий его потребитель; сама библиотека зависит только от `undici-types@7.3.0` для деклараций. Root import — `moysklad-fetch-planner`, deep — `moysklad-fetch-planner/build/src/planner.js`; исходные `.ts` не являются runtime entrypoint.

## Результат и владение ресурсами

1. `submit` синхронно возвращает handle с `id`, `result`, `resourcesDone`, `snapshot()`, `observe()` и `abort()`. Отказ принятия, например QUEUE_FULL, приходит через failed handle с sentinel `id=0`, без отдельной истории событий. Ошибки конструктора и превышение лимита подписок бросаются синхронно.
2. Каждая attempt вызывает `prepare` заново: свежие init/body, новый coordinator AbortController, то же логическое содержание и та же business identity приложения. Библиотека не клонирует и не буферизует payload. Ресурсы регистрируют через `ctx.onDispose` сразу после приобретения, до следующего await; частичный acquisition до регистрации очищает сам callback.
3. `consume` заимствует Response, await-ит чтение и всю свою работу, возвращает законченное T. Живые Response/reader/stream не являются законченным результатом; generic T не проверяет это автоматически. Временный результат регистрируют через `ctx.onDiscard`: при throw или отмене до commit он уничтожается. Регистрации действуют только внутри своего активного callback; cleanup/discard выполняются LIFO, один раз на регистрацию.
4. Coordinator проверяет отмену и бюджеты, затем атомарно принимает value (`resultCommitted=true`) и снимает discard. После этого cleanup failure, abort или истечение времени сохраняют успех и value. До commit проигравший отмене поздний value уходит в discard. Бизнес-публикацию, rename, сообщение или commit в БД выполняет приложение после `result`.
5. `result` выдаёт `Completed<T> = {value, status, cleanup}`. `cleanup` — released, failed или pending на момент выдачи; unknown ресурсов отображается здесь как failed. Ожидание очистки после commit ограничено `min(cleanupGraceMs, остаток operation deadline)`; abort сокращает его, сохраняя успех. Это не предел времени физической очистки.
6. `resourcesDone` отдельно завершается `{resources: 'released' | 'failed' | 'unknown'}` после окончания всех известных работ. Failed/unknown не доказывают освобождения всех ресурсов. Пока callback/upload/disposer реально не завершился, ресурсы pending и accounting удерживается, даже если `result` уже окончен. Disposers не запускаются одновременно с ещё работающим prepare/consume.

Fulfilled `result` означает законченный consume, а не обязательный HTTP2xx или успешный бизнес-commit. Все ответы кроме перехваченного 429 передаются consume непрочитанными: приложение разбирает JSON errors[].code/parameter, HTML и частичный массовый результат либо бросает прикладную ошибку. Ошибка обёрнута в `OperationError` с `cause` только для caller. Поля `code`, `phase`, `operationId`, `attemptNumber`, `dispatchEntered`, известный `status` и `serverOutcome` сохраняют факты отказа. HTTP200 при обрыве чтения остаётся известным HTTP200.

### Тяжёлый bulk и upload

Default `attemptTimeoutMs=30000` отсчитывается от начала prepare и не является универсальным HTTP timeout. Тяжёлой операции нужны обоснованные бюджеты подготовки/отправки/consume, общий deadline с учётом очереди и повторов, а также disposal. Например, следующий рецепт выбирает 90 секунд на attempt, 180 секунд общего deadline и 5 секунд ожидания cleanup после commit; эти числа — пример настройки, не оценка времени сервера.

`openUpload` ниже — функция приложения: каждый вызов создаёт новый поток с тем же payload и устойчивой business identity. Его `stopAndWait` активно останавливает producer, затем ждёт все известные pull/чтения/handles; функция приобретения сама убирает частично созданные ресурсы при ошибке. Только наличие такого barrier делает источник пригодным для учёта; replay записи всё равно выключен.

```ts
import { ReadableStream } from 'node:stream/web'
import { FetchPlanner } from 'moysklad-fetch-planner'

interface Upload {
  body: ReadableStream<Uint8Array>
  stopAndWait(): Promise<void>
}

const bulkPlanner = new FetchPlanner(globalThis.fetch, {
  attemptTimeoutMs: 90_000,
  deadlineMs: 180_000,
  cleanupGraceMs: 5_000
})

export function submitBulk(
  url: URL,
  token: string,
  openUpload: (signal: AbortSignal) => Promise<Upload>
) {
  return bulkPlanner.submit({
    method: 'POST',
    deadlineMs: 180_000,
    replay: { serverSafe: false, consumeSafe: false },
    async prepare(ctx) {
      const upload = await openUpload(ctx.signal)
      ctx.onDispose(() => upload.stopAndWait())
      return {
        url,
        init: {
          body: upload.body,
          duplex: 'half',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json'
          }
        }
      }
    },
    consume: response => response.text()
  })
}
```

Ранний Response, EOF ответа и abort не подтверждают окончания исходящего upload. Новая attempt не начинается до успешной известной очистки, включая producer. Core доверяет обязательству `stopAndWait`, не умеет останавливать произвольную скрытую работу. Локальные cooperative upload проверки не доказывают replay любого stream, поведения default pool, TLS/HTTP2 или exactly-once. Предел числа операций также не ограничивает произвольный размер body, замыканий и registrations.

## Повторы, темп и локальная защита

`replay` обязателен: отсутствие неявного разрешения («default false») выражается явными `{serverSafe:false, consumeSafe:false}`. Для безопасного чтения без внешних эффектов consume можно явно выбрать обе true, как в быстром старте. Метод GET/POST или один HTTP-статус не доказывают безопасность повторного бизнес-действия. Обе flags true необходимы вместе с подходящим failure, известной успешной cleanup и оставшимися budgets.

Кандидаты: перехваченный 429, ошибка отправленного transport до известного HTTP-ответа и явно помеченный в своём активном consume `throw ctx.retryableReadFailure(cause)` при HTTP2xx. Помечайте только установленную ошибку чтения, не schema/JSON/БД error. Non2xx кроме 429 никогда не автоматический retry candidate, даже при обеих flags и такой пометке; 500/503 автоматически не повторяются. Реальный errored response body может дать failed/unknown cleanup и terminal отказ даже при HTTP200 и пометке. Ошибки prepare, timeout, hooks и cleanup не превращаются в transient. Default maxAttempts=3 включает первую подготовку; общий deadline не перезапускается. Повтор встаёт в хвост FIFO.

429 body принадлежит coordinator: JSON-код 1073 разбирается с пределом 65536 принятых байт и 250 мс; поддержан также legacy `X-Lognex-Auth: 429005`. Malformed/nonJSON/oversize/read failure дают generic429 с сохранением status/hints; частичное тело в consume не попадает. Предел classifier не ограничивает размер chunk, уже выделенного transport. Parallel overflow понижает effective parallelism до минимума 1, затем он постепенно восстанавливается.

Общая пауза учитывает vendor `X-Lognex-Retry-After`/`X-Lognex-Reset` в мс, стандартный `Retry-After` в секундах или HTTP date и адаптивный pacing. Каждый hint проверяется отдельно; числовые hints требуют полного decimal safe integer. Для 429 всегда есть положительный fallback: `min(30000, 3000 * 2^(ordinal-1)) * factor`, factor от 0.8 до 1.2, cap до множителя. Поздний success не сокращает уже принятую server pause. По rate-limit заголовкам, затуханию и jitter рассчитывается локальный темп; оптимальная скорость и отсутствие 429 не обещаны.

`leasedAttempts` ограничивает подготовку и физически незавершённую работу configured `maxParallelLimit`; `sentActive` держится через consume и cleanup и ограничивает новые отправки effective parallelism. CPU/БД внутри consume тоже занимают sentActive. Готовая попытка удерживает lease, но перед отправкой заново проверяются stop/abort/deadline, pause, pacing, concurrency и guard. Пробуждение таймера не является permit.

Guard одного instance считает rolling 60000 мс: все HTTP≥400 receipts (default 100), отдельно 429 (100), включая поздние ответы; достижение порога навсегда останавливает новые отправки с GUARD_OPEN. PUT ограничен 60 dispatch на `entityKey` в том же окне: следующий получает PUT_LIMIT без общего stop. Ключ задаёт приложение, неизменный для той же сущности во всём instance, 1–128 символов, без raw URL и секретов. При заполнении 1024 живых keys новая сущность получает GUARD_CAPACITY; живая история не вытесняется. Retries тоже считаются.

Это консервативные локальные defaults, не копия правил отключения МойСклад. Другие instances/процессы/интеграции не координируются. Актуальные веса и ограничения задаёт [документация МойСклад](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_restrictions.md), заголовки и ошибки — [первичный справочник](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_general.md). Dispatch counter считает входы в переданный transport, не wire sends: скрытые transport retries недопустимы для точного учёта, redirects отдельно не считаются. Защита аккаунта от отключения не гарантируется.

## Stop, abort и deadline

`planner.stop(reason?)` окончателен: запрещает submit, новые dispatch и retries, отклоняет queued/retry-wait/preparing/ready; preparing получает abort signal и позднюю очистку. Уже отправленная операция продолжает текущую attempt до своего deadline, включая consume; сам stop её не abort-ит. `stop` возвращает void, это не drain. Для планового завершения сначала остановите producer, учтите все handles и выберите, ждать принятую очередь до stop или сразу запретить отправки.

`handle.abort(reason?)` и общий deadline до result commit завершают result отказом и сигналят transport/callback. Attempt timeout даёт ATTEMPT_TIMEOUT, общий — DEADLINE; они не доказывают физической остановки callback, upload или записи на сервере. После dispatch POST мог примениться: отмена не rollback, server outcome остаётся неизвестным без прикладной сверки. `serverOutcome='http-response'` означает известный HTTP-факт, а не гарантированный бизнес-результат; без ответа после dispatch это unknown, до dispatch — not-dispatched. Уже выданная ошибка не дополняется поздними фактами, snapshot может получить поздний status.

## Observation и управляющие hooks

### Наблюдение без управления

`planner.observe(listener)` и `handle.observe(listener)` атомарно возвращают `{snapshot, unsubscribe}`: начальный snapshot не приходит в callback, дальнейшие records имеют большую sequence; истории нет. Operation snapshot содержит phase/outcome/resultCommitted/resources, attempts/dispatchCalls/dispatchEntered, известный status и безопасный failureCode. Planner snapshot содержит только агрегаты queued/leasedAttempts/sentActive/effectiveParallelism, stopped/guardOpen/serverNotBefore и sequence. `serverNotBefore` — внутренняя монотонная отметка, не Unix timestamp.

Events: created, phase-changed, dispatch-deferred, dispatch-started, headers-received, retry-scheduled, operation-settled, resources-settled, late-completion. Реальные переходы определяет coordinator; не каждая фаза обязана встречаться в каждом сценарии. Records detached/frozen и скалярны: без URL, headers, body, signal, Error/cause, entityKey и value. EpochTime служит отображению, elapsedMs — монотонному времени от старта planner, sequence — порядку внутри instance.

Возврат observer не управляет policy; async result не ожидается. Синхронный throw, rejection обычного async/Promise и ошибки стандартной thenable assimilation изолированы. Genuine Promise с повреждёнными собственными `then`/`catch` тоже поддержан: handler присоединяется intrinsic `Promise.prototype.then`, минуя эти свойства. Fulfillment value отбрасывается. Внутренний OBSERVER_FAILED не создаёт рекурсивного события и не является публичным счётчиком telemetry.

```ts
import { FetchPlanner, type Event } from 'moysklad-fetch-planner'

export function attachObservers(
  planner: FetchPlanner<typeof globalThis.fetch>,
  exportEvent: (event: Event) => Promise<void>
) {
  const ordinaryListener: (event: Event) => unknown = async event => {
    await exportEvent(event)
  }
  const poisonedListener: (event: Event) => unknown = event => {
    const work = exportEvent(event)
    void Object.defineProperties(work, {
      then: { value: () => { throw new Error('OWN_THEN') } },
      catch: { value: () => { throw new Error('OWN_CATCH') } }
    })
    return work // Genuine Promise, constructor/species остаются стандартными.
  }
  const ordinary = planner.observe(ordinaryListener)
  const poisonedOwn = planner.observe(poisonedListener)
  return () => {
    ordinary.unsubscribe()
    poisonedOwn.unsubscribe()
  }
}
```

Тип возврата listener `unknown` явно отмечает игнорируемое значение для type-aware lint; async работа по-прежнему возвращает настоящий Promise. Пример предполагает обычные Promise от `exportEvent`. Повреждённые constructor, `Symbol.species` или `NewPromiseCapability` — другая граница: они могут сорвать attachment либо породить опасную derived chain. Caller заранее отвечает за original, derived и будущие rejection. Без prehandler host process может завершиться; catch ошибки attachment не заменяет handler. `Promise.resolve(damaged)` и `await damaged` не являются универсальным ремонтом.

Безопасный рецепт для собственного кода, которому необходимо менять этот протокол: присоединить handlers ДО повреждения, обработать свою работу и вернуть undefined; альтернатива — вернуть безопасную обычную цепочку, созданную и обработанную заранее. Одного handler на original недостаточно, если пользовательский species сам создаёт необработанные derived/future rejection.

```ts
import { FetchPlanner, type Event } from 'moysklad-fetch-planner'

export function attachPrehandled(
  planner: FetchPlanner<typeof globalThis.fetch>,
  exportEvent: (event: Event) => Promise<void>
) {
  return planner.observe(event => {
    const original = Promise.resolve().then(() => exportEvent(event))
    // Обе реакции ставятся на обычный Promise ДО изменения constructor.
    const safe = original.then(() => undefined, () => undefined)
    void Object.defineProperty(original, 'constructor', {
      get() { throw new Error('BROKEN_CONSTRUCTOR') }
    })
    void safe // Эта обычная derived chain всегда fulfilled; handlers не бросают.
    return undefined // Повреждённый original не отдаём observer machinery.
  })
}
```

Это обработка rejection, не гарантия доставки telemetry: exporter учитывает свои ошибки сам. Скрытые Promise произвольного thenable также остаются ответственностью caller. Эти исключения observation не ослабляют полное владение prepare/consume/dispose/discard/control callbacks.

Текущий fanout всегда доставляется всем уже выбранным listeners; изменения подписок действуют со следующего события. Команды submit/stop/abort из observers применяются после fanout FIFO с доставкой порождённых событий до следующей команды. Submit сразу резервирует queued capacity; excess QUEUE_FULL не удерживает spec и не создаёт backlog отдельных команд/events. Stop коалесцируется с первой причиной, abort — один на принятый незавершённый handle. Default maxSubscribers=64 на planner и handle; unsubscribe идемпотентен, operation subscriptions снимаются после окончательного resources-settled. Это bounds bookkeeping конечного burst, не предел произвольной памяти caller; синхронный observer всё ещё может блокировать JS.

### Два опциональных control hooks

Обе возможности реализованы: `beforeDispatch` и `beforeRetry`; указывать их в каждом submit не требуется. Context — frozen snapshot, signal, attemptNumber, dispatchCalls и известный status, без payload. Один hook на точку возвращает allow, deny с единственным code POLICY_DENIED или defer с положительным safe integer delayMs. Default hook budget=1000 мс ограничен общим deadline и действующим attempt budget; throw, invalid return и hook timeout дают HOOK_FAILED, deny — HOOK_DENIED. Поздний ответ не возобновляет terminal операцию.

```ts
import { FetchPlanner } from 'moysklad-fetch-planner'

export function submitControlled(
  planner: FetchPlanner<typeof globalThis.fetch>,
  url: URL,
  dispatchAllowed: boolean,
  retryDelayMs: number
) {
  return planner.submit({
    method: 'GET',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: () => ({ url, init: {} }),
    consume: response => response.text(),
    beforeDispatch: () => dispatchAllowed
      ? { type: 'allow' }
      : { type: 'deny', code: 'POLICY_DENIED' },
    beforeRetry: () => retryDelayMs > 0
      ? { type: 'defer', delayMs: retryDelayMs }
      : { type: 'allow' }
  })
}
```

`beforeDispatch` вызывается один раз на attempt после prepare, defer задаёт монотонный notBefore от завершения решения; timer не вызывает hook заново. `beforeRetry` вызывается только для уже безопасного внутреннего candidate после успешной cleanup, включая upload. Он не делает unsafe failure повторяемым. Allow не снижает policy floor, defer берётся по max с зафиксированным внутренним retry floor; ожидание hook не пересэмплирует fallback и не перезапускает deadline. Новые receipts могут только увеличить server floor. После await hook и перед реальной отправкой safety checks повторяются.

Owning guard действует через полный async/thenable lifetime, повторную assimilation, getters и материализацию descriptor/decision, включая позднее завершение после timeout. `submit` того же planner из prepare/consume/dispose/discard/hook получает REENTRANT_OPERATION, в том числе после await и fire-and-forget до фактического выхода. Зависимые операции запускают после result снаружи callback. Observer callbacks отделены от owner и могут submit через command path. Зависший hook после logical timeout удерживает lease и resourcesDone до фактического завершения; для beforeRetry sentActive уже может быть освобождён после HTTP/cleanup. Callback нельзя принудительно прервать обычным таймером.

## Настройки

Все поля второго аргумента конструктора опциональны, spec может переопределить только `deadlineMs`. Новые durations/counts — положительные safe integers; invalid options отклоняются явно. Настройки копируются, публичного mutable options object нет.

| Опция                           | Default | Назначение                                           |
| ------------------------------- | ------- | ---------------------------------------------------- |
| maxParallelLimit                | 4       | Предел leases; верхняя граница effective отправок    |
| maxQueuedOperations             | 1024    | Queued, retry-wait и pending submit reservations     |
| maxSubscribers                  | 64      | Подписки на planner и отдельно на handle             |
| deadlineMs                      | 120000  | Вся операция от принятия, включая очередь            |
| attemptTimeoutMs                | 30000   | Работа attempt от prepare до result commit           |
| cleanupGraceMs                  | 5000    | Ожидание cleanup после commit, не физический timeout |
| maxAttempts                     | 3       | Включая первую подготовку                            |
| hookTimeoutMs                   | 1000    | Бюджет одного control hook                           |
| errorPerMinuteLimit             | 100     | Все HTTP≥400 receipts                                |
| rateLimitPerMinuteLimit         | 100     | Отдельный счётчик HTTP429                            |
| entityPutPerMinuteLimit         | 60      | PUT dispatch на один entityKey                       |
| maxEntityKeys                   | 1024    | Живые PUT keys без вытеснения истории                |
| throttlingCoefficient           | 5       | Степень затухания, конечное число 1–20               |
| maxRequestDelayTimeMs           | 3000    | Масштаб adaptive delay, не жёсткий потолок           |
| jitter                          | 0.1     | Конечная доля 0–0.3                                  |
| parallelLimitCorrectionPeriodMs | 10000   | Базовый период восстановления параллелизма           |

Три существующие pacing/count опции сохраняют округление: maxParallelLimit и maxRequestDelayTimeMs до safe integer ≥1, parallelLimitCorrectionPeriodMs до ≥1000. Остальные count/duration не округляются. Jitter меняет масштаб delay по `maxRequestDelayTimeMs * (1 + jitter / 2 - random * jitter)`; восстановление использует `period * (1 + 2 * random * jitter)`, строгий elapsed > period и один шаг к нулевой correction. Серверная пауза может быть длиннее adaptive delay.

## Миграция и разработка

Удалены wrapFetch/getFetch, EventEmitter/events, protected extension API, диагностические getters, slot waiters и legacy errorLimits. Вместо SDK `fetch` injection перенесите владение HTTP в явный submit/prepare/consume. Snapshot заменяет getters, observe — диагностические события, hooks — veto/defer. Совместимого facade/helper рядом нет.

Для разработки точные версии задают `.node-version` и `packageManager` в `package.json`. В подготовленном compatibility checkout используйте закреплённый PATH:

```sh
export PATH="$PWD/__temp/environment-compat/node_modules/node/bin:$PWD/__temp/environment-compat/node_modules/.bin:$PATH"
```

Установку зависимостей выполняют отдельно с закреплённым pnpm и frozen lockfile. Немутирующие source gates:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm knip
```

Текущая отдельная operation-регрессия (команды последовательно):

```sh
node node_modules/typescript/bin/tsc -p test/operation/tsconfig.json
node_modules/.bin/oxlint --config .oxlintrc.json --type-aware --tsconfig test/operation/tsconfig.json --deny-warnings src test/operation test/helpers/runtime.ts
node test/operation/run.mjs all
```

`pnpm build` собирает библиотеку в build/src с declarations/maps, `pnpm build:test` — src/test в __temp/test-build, общий typecheck включает samples. `test:unit` сначала запускает существующий operation runner со всеми 27 наборами и compiler-проверками, затем девять migrated offline suites по явному списку; stress в него не входит. `pnpm coverage` запускает этот же entrypoint под c8 и проверяет LCOV всех 15 рабочих модулей по исходным src, включая публичный submit; type-only fetch-types не требует runtime coverage. Новая изолированная package acceptance и финальная приёмка ещё впереди: общий `pnpm check && pnpm coverage && pnpm test:package` не означает, что новый пакет уже принят. Source snippet compile не заменяет проверку установленного tarball, реальных consumers или нагрузки.

Samples, stress и package runtime fixtures не запускаются для проверки README. `test:live` — отдельная нагрузка, требующая явного разрешения; обычные проверки не требуют credentials/API МойСклад. Настоящий Actions run и выпуск также требуют отдельных gates и разрешений; version/changelog/push/tag/publish этим обновлением не меняются. Устройство текущего API: [архитектура](docs/architecture.md); переход со старого интерфейса: [миграция](docs/migration.md).
