# Миграция на submit и handle

Контракт4.1.0 сохраняет submit → handle из4.0.0 и добавляет opt-in HTTP retry и поддержку Undici8.11.2/8.12.2. Переход с3.x требует major-миграции ниже. Сначала выберите точную поставку по [руководству агента](agent-guide.md); условия retry хранятся в [API](api.md#явный-http-retry). Исторический tag v4.0.0 не меняется.

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
      const body = await response.arrayBuffer()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return body.byteLength
    }
  })
}
```

Это только пример family typing, не формат формы JSON API. Caller обязан обработать result и resourcesDone возвращённого handle, как в предыдущем примере.

## Порядок переноса потребителя

1. Зафиксируйте business identity, схему результата и действия при неизвестном исходе записи. Обоснуйте serverSafe и consumeSafe отдельно; без основания обе flags false.
2. Перенесите создание descriptor/init/body в prepare. Зарегистрируйте disposal сразу после acquisition; streaming producer должен поддерживать stop-and-wait. Чтение и временный результат перенесите в consume/onDiscard.
3. Обрабатывайте каждый result и resourcesDone. Публикация business value остаётся приложению после result; cleanup failure не разрешает повтор уже зафиксированного значения.
4. Перенесите диагностику в observe, управление — в hooks. Не запускайте зависимый submit внутри owning callback того же planner. Внешнюю отмену связывайте с handle.abort, не через init.signal.
5. Проверьте typed consumers и локальные success/error/retry/cancellation/cleanup сценарии. Не проверяйте миграцию live-записями или запуском samples/stress.

Для готовых условий retry, non429 ошибок, Promise boundary, budgets и shutdown используйте [API](api.md) и [интеграцию](integration-guide.md). Проверки самой библиотеки описаны в [разработке](development.md).

Конечные рецепты [окон, ошибок коллекции и остановки](integration-guide.md#11-конечные-рецепты-приложения) используют существующий API. HTTP retry включается явно по [API](api.md#явный-http-retry); per-spec attemptTimeout и дополнительные diagnostics не добавлены; полной миграции SDK эти рецепты не обещают.
