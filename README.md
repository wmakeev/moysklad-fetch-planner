# moysklad-fetch-planner

[![npm](https://img.shields.io/npm/v/moysklad-fetch-planner.svg?cacheSeconds=1800&style=flat-square)](https://www.npmjs.com/package/moysklad-fetch-planner) [![GitHub Actions](https://img.shields.io/github/actions/workflow/status/wmakeev/moysklad-fetch-planner/main.yml?style=flat-square)](https://github.com/wmakeev/moysklad-fetch-planner/actions/workflows/main.yml)

Библиотека Node ≥24/ESM для очереди законченных HTTP-операций к МойСклад. `prepare` создаёт свежий запрос каждой попытки, `consume` полностью обрабатывает ответ, `handle.result` выдаёт готовое значение, `handle.resourcesDone` отдельно завершает учёт ресурсов. Один instance координирует отправки, повторы и локальные ограничения.

## Начать агенту

| Задача | Читать |
| --- | --- |
| Подключить библиотеку к приложению | [Руководство для агента](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/agent-guide.md) |
| Найти точный контракт, defaults, ошибки или hooks | [Справочник API](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/api.md) |
| Изменить библиотеку и выбрать проверки | [AGENTS.md](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/AGENTS.md) и [разработка](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/development.md) |
| Понять внутренние зависимости | [Архитектура](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/architecture.md) |
| Перенести потребителя старого API | [Миграция](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/migration.md) |
| Подготовить эксплуатацию массового обмена | [Интеграция](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/integration-guide.md) и [обоснование](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/high-load-rationale.md) |
| Подготовить выпуск | [Проверка перед выпуском](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/releasing.md) |

Ссылки ведут на текущую ветку GitHub и доступны также из npm README. Для установленной версии выбирайте соответствующий tag или commit документации. Локальные планы, передачи и отчёты не нужны для чтения публичного контракта.

## Статус поставки и установка

Ветка содержит новый major API `submit → handle`. Подготовлен кандидат 4.0.0; он ещё не опубликован, а npm badge относится к опубликованному старому API. Установка `moysklad-fetch-planner@latest` сейчас не гарантирует наличие описанного здесь интерфейса.

До выхода нового релиза используйте проверенный tarball нужного commit; как установить происхождение артефакта, описано в [руководстве агента](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/agent-guide.md). Из каталога с таким файлом:

```sh
npm install ./package.tgz
```

Runtime Undici не является зависимостью библиотеки. Для явного transport `undici.fetch` потребитель отдельно устанавливает совместимую версию Undici; проверенный runtime — Undici 7.30.1; совместимость старой типовой family сохраняется через `undici-types@7.3.0` без установки старого runtime. Для native fetch собственный dispatcher должен быть совместим с Undici внутри выбранного Node.

## Минимальный пример без сети

Функция использует локальный fake transport и выполняется только при явном вызове. В реальном приложении передайте `globalThis.fetch` и свой URL; обработку HTTP и прикладной схемы сохраните в consume.

```ts
import { FetchPlanner } from 'moysklad-fetch-planner'

export async function example() {
  const transport: typeof globalThis.fetch = async () => new Response('ready')
  const planner = new FetchPlanner(transport)
  const handle = planner.submit({
    method: 'GET',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({ url: 'https://example.invalid/data', init: {} }),
    async consume(response) {
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return text
    }
  })
  try {
    const completed = await handle.result
    return completed.value
  } finally {
    await handle.resourcesDone
    planner.stop()
  }
}
```

Handle не является Promise: не пишите `await planner.submit(...)`. В этом конечном fake-примере известная работа завершается; в приложении произвольный зависший callback может оставить resourcesDone pending. Для shutdown задайте собственное окно ожидания, не объявляя pending ресурсы освобождёнными.

## Гарантии и ограничения

- Повтор требует обеих явных replay flags, подходящей ошибки, успешной известной cleanup и оставшихся budgets. HTTP method или status сами по себе безопасность не доказывают; 500/503 автоматически не повторяются.
- Все non429 ответы передаются в consume непрочитанными. Приложение проверяет HTTP, JSON и бизнес-ошибки; живой Response/reader/stream нельзя выдавать как законченное значение.
- Abort/timeout не доказывает остановки callback или отсутствия записи на сервере. После успешного commit готовое значение сохраняется при failed/pending cleanup.
- Очередь, guard и pacing ограничены одним instance. Account-wide ограничения, exactly-once и оптимальная скорость не обещаны.
- `wrapFetch/getFetch`, прозрачная Fetch-подстановка в SDK, EventEmitter и старые slot waiters отсутствуют.

Полные условия и примеры — в [API](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/api.md). Более сложные compile-only сценарии — в [samples](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/samples/README.md). Лицензия — [MIT](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/LICENSE).
