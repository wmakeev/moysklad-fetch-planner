# moysklad-fetch-planner <!-- omit in toc -->

[![npm](https://img.shields.io/npm/v/moysklad-fetch-planner.svg?cacheSeconds=1800&style=flat-square)](https://www.npmjs.com/package/moysklad-fetch-planner) [![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/wmakeev/moysklad-fetch-planner/main.yml?style=flat-square)](https://github.com/wmakeev/moysklad-fetch-planner/actions/workflows/main.yml) [![Codecov](https://img.shields.io/codecov/c/github/wmakeev/moysklad-fetch-planner?style=flat-square)](https://app.codecov.io/gh/wmakeev/moysklad-fetch-planner/tree/master/)

> Планировщик запросов для API МойСклад

Добавляет очередь, адаптивную задержку по заголовкам ответа и локальное ограничение параллелизма к переданному fetch. Повторяет 429, но не гарантирует отсутствие 429, заданную скорость или защиту аккаунта от отключения API. Между процессами нет общего счётчика или координатора.

Минимальный runtime — Node 24. Устройство и границы реализации: [docs/architecture.md](docs/architecture.md).

## Быстрый старт

### С использованием native fetch

```ts
import { FetchPlanner, wrapFetch } from 'moysklad-fetch-planner'

const planner = new FetchPlanner(globalThis.fetch)
const scheduled: typeof globalThis.fetch = planner.getFetch()
// Сокращённый вариант без доступа к getters:
const wrapped: typeof globalThis.fetch = wrapFetch(globalThis.fetch)

// Токен передаёт вызывающее приложение; планировщик его не создаёт.
export async function loadOrders(token: string) {
  const response: Response = await scheduled(
    new URL('https://api.moysklad.ru/api/remap/1.2/entity/customerorder?limit=100'),
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept-Encoding': 'gzip' } }
  )
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data: unknown = await response.json()
  return data // Форму JSON проверяет вызывающее приложение.
}

void wrapped
```

Возвращается исходный Response; JSON не разбирается автоматически. Входы Request/URL и init принадлежат выбранному transport. Для native fetch проверены Request, FormData, File, string/Buffer и stream; поддержка первой отправки тела не означает возможность его повтора после 429.

### С использованием библиотеки moysklad

```ts
import Moysklad from 'moysklad'
import { wrapFetch } from 'moysklad-fetch-planner'

// Аутентификацию настраивает приложение через Moysklad.
const ms = Moysklad({ fetch: wrapFetch(globalThis.fetch) })
const result = await ms.GET('entity/customerorder', { limit: 100 })
console.log(result.rows[0]?.name)
```

## Принцип работы

`new FetchPlanner(transport, options).getFetch()` и `wrapFetch(transport, options)` создают новую функцию для постановки запросов в очередь. У каждого экземпляра независимая очередь. Без данных о лимитах адаптивная задержка равна нулю, но локальный предел параллелизма действует.

По `X-RateLimit-Limit`, `X-RateLimit-Remaining` и `X-Lognex-Retry-TimeInterval` рассчитывается задержка с учётом времени с последнего старта, таблицы затухания из 101 шага и jitter. Это обратная связь по полученным заголовкам, а не резервирование серверного бюджета. Оптимальный темп и равномерное распределение между приложениями не гарантируются.

### Повторы и параллелизм

429 возвращает action в начало очереди перед остальными FIFO-запросами. Повторы не ограничены числом попыток. Для `RATE_LIMIT_OVERFLOW` значение `X-Lognex-Retry-After` задаёт общую паузу в миллисекундах: новый hint может продлить deadline, а успешный или поздний ответ не может сократить его. Адаптивная задержка может отложить старт ещё дальше.

Только HTTP 429 с `X-Lognex-Auth: 429005` классифицируется как `PARALLEL_LIMIT_OVERFLOW`: локальный предел уменьшается с шагом 1, оставаясь не ниже 1, затем постепенно восстанавливается до `maxParallelLimit`. Для этой legacy-ветки Retry-After не используется. JSON-код 1073 не читается; `X-Lognex-Reset` и стандартный HTTP `Retry-After` не участвуют в планировании. При 429 без `X-Lognex-Retry-After` или с его нулевым значением дополнительного fallback backoff нет: остаётся только текущая адаптивная задержка, которая может быть нулевой.

Inflight учитывает ожидание transport до получения Response (заголовков), а не чтение body потребителем. Медленная загрузка тела может продолжаться после освобождения локального слота. Даже если request observer уже отверг action, отправленный transport занимает слот до своего завершения.

### Владение ответом и replay

При передаче потребителю planner сохраняет идентичность Response и не читает и не отменяет body. Потребитель сам читает или освобождает тело. Любой непереданный Response, включая перехваченный 429, ошибки заголовков/observer и поздний ответ terminal action, получает best-effort `body.cancel()`. Синхронная ошибка, rejection или зависание cancel не блокируют очередь; завершение стороннего cancel не гарантируется.

При повторе используются те же input/init/body. Нет автоматического clone, buffering или body factory. Повтор string/Buffer проверен; потреблённый либо locked Request/stream может завершиться ошибкой transport. Такая ошибка отвергает action один раз и не ретраится. Повторяемость произвольного тела и безопасность повторного бизнес-действия определяет приложение.

Signal передаётся transport без отдельной planner cancellation. Прерывание ещё стоящего в очереди action не удаляет его и не освобождает waiter немедленно (D09). Публичного stop нет.

## Лимиты API МойСклад

Актуальность: **31.10.2026**, повторно прочитаны публичные первоисточники [ограничений](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_restrictions.md) и [заголовков/ошибок](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_general.md), без проверки на аккаунте. Правила могут меняться.

С 16.02.2026 бюджет считается отдельно для пользователя и решения, а не для аккаунта целиком. Номинал 45 единиц за 3 секунды расходуется с весом запроса:

| Аутентификация / endpoint | Вес запроса по документации |
| --- | --- |
| Токен публичного/приватного решения, обычные endpoints | 1 |
| Токен решения «Черновик» / «На модерации» с 13.04.2026 | 4 |
| Логин/пароль или токен пользователя | 2 с 12.05.2026; 3 с 01.09.2026; 4 с 01.12.2026 |
| GET report/stock/all и report/stock/bystore при любой аутентификации | 5 |

Поэтому 45 единиц не означают универсальные 45 HTTP-запросов за 3 секунды. `X-RateLimit-Limit` и `Remaining` нужно читать с учётом весов. Отдельно действуют до 5 параллельных запросов на пользователя/решение и до 20 на аккаунт; заголовки бюджета эту параллельность не показывают. В документации её превышение обозначено HTTP 429 с JSON-кодом 1073. Библиотека пока распознаёт только legacy-заголовок, описанный выше.

Первоисточник также описывает автоматическое отключение API при более 200 идентичных ошибочных запросов в минуту, более 200 ответов 429 в минуту или более 100 PUT к одной сущности в минуту в течение последнего часа. Планировщик не ведёт защитные счётчики этих условий и не предотвращает отключение. Несколько экземпляров могут видеть расход одного identity через заголовки, но это не обеспечивает общий предел или защиту от соседней нагрузки.

## Конфигурация

Все поля `options` опциональны; передавайте их конструктору или `wrapFetch`. Нечисловые значения, NaN, бесконечности и небезопасные числа отклоняются согласно границам ниже.

| Опция | Default | Допустимые значения и смысл |
| --- | --- | --- |
| `eventHandler` | `undefined` | Синхронный объект с `emit`, тип `FetchPlannerEventHandler<F>`; пример ниже |
| `throttlingCoefficient` | 5 | Конечное число от 1 до 20; степень затухания |
| `maxParallelLimit` | 4 | Округляется до безопасного целого ≥1; runtime не ограничивает сверху числом 5 |
| `maxRequestDelayTimeMs` | 3000 | Округляется до безопасного целого ≥1; масштаб адаптивной задержки в мс |
| `jitter` | 0.1 | Конечная доля от 0 до 0.3 |
| `parallelLimitCorrectionPeriodMs` | 10000 | Округляется до безопасного целого ≥1000; период восстановления параллелизма в мс |
| `errorLimits` | Три поля по 100 | Незавершённая чужая заготовка, защитного эффекта нет |

Значение `maxParallelLimit` выбирает приложение с учётом серверных ограничений и соседних запросов. Округление сохраняется: например, 0.6 становится 1, а 0.1 отвергается. Конечность и безопасность арифметики deadline дополнительно проверяются перед таймером.

При `jitter: 0.1` масштаб 3000 мс меняется от 2850 до 3150 мс по формуле `maximum = maxRequestDelayTimeMs * (1 + jitter / 2 - random * jitter)`. Поэтому `maxRequestDelayTimeMs` не является жёстким потолком ожидания: jitter и серверная пауза могут его превысить. Восстановление параллелизма использует прежнюю формулу периода `period * (1 + 2 * random * jitter)`.

`errorLimits` содержит `sameRequestsErrorPerMinuteLimit`, `tooManyRequestsErrorPerMinuteLimit`, `sameEntityPutRequestsPerMinuteLimit`. Сейчас переданные значения 1/2/3 игнорируются и `getOptions()` возвращает defaults 100/100/100. Нет counters/window/guard, retry budget или stop. Судьба заготовки D12 остаётся этапу 4; не используйте её как защитную настройку.

## Методы FetchPlanner

| Метод | Результат |
| --- | --- |
| `getFetch()` | Новая вызываемая функция с параметрами выбранного transport и Promise его Response; callable properties transport не копируются |
| `waitForFreeRequestSlot(priority = 0)` | Promise уведомления о свободной ёмкости; меньшее число приоритета обслуживается раньше |
| `getOptions()` | Тот же mutable объект опций, не snapshot; mutation не поддерживается как конфигурирование, таблица коэффициентов не пересчитывается |
| `getRateLimit()` / `getRateLimitRemaining()` | Последние полученные значения соответствующих заголовков либо null до первого значения |
| `getActionsQueueLength()` | Число ожидающих actions |
| `getRequestSlotHandlersCount()` | Число ожидающих уведомления handlers |
| `getParallelLimitCorrection()` | Коррекция в диапазоне от `1 - maxParallelLimit` до 0 при поддержанном использовании |
| `getCurInflightRequestsCount()` | Число незавершённых transport-попыток до headers, включая transport terminal action |
| `getLastRequestDelay()` | Последняя рассчитанная задержка старта в мс |
| `getNextRequestTime()` | Unix timestamp в мс для запланированного пробуждения либо 0, если таймера нет |

`waitForFreeRequestSlot` проверяет сумму queue + inflight относительно эффективного параллелизма. Это уведомление без permit: оно не резервирует ёмкость, не удерживает блокировку и не гарантирует немедленную отправку в обход общей серверной паузы. Несколько производителей должны учитывать, что уведомление не ограничивает размер очереди само по себе.

## События

```ts
import { EventEmitter } from 'node:events'
import { FetchPlanner, type FetchPlannerEventMap } from 'moysklad-fetch-planner'

const eventHandler = new EventEmitter<FetchPlannerEventMap<typeof globalThis.fetch>>()
eventHandler.on('response', (event, planner) => {
  console.log(event.actionId, event.responseType, planner.getRateLimitRemaining())
})
const planner = new FetchPlanner(globalThis.fetch, { eventHandler })
void planner
```

Используйте один и тот же тип transport `F` в planner, `FetchPlannerEventMap<F>`, `RequestEvent<F>`, `ResponseEvent<F>` и `FetchErrorEvent<F>`. Собственный handler должен соответствовать экспортированному `FetchPlannerEventHandler<F>`: `emit` получает коррелированный tuple имени события, данных и `FetchPlanner<F>`. В типизированном обработчике `emit(...[name, event, planner])` проверка имени позволяет сузить тип данных; произвольный набор overloads не заменяет этот контракт.

| Событие       | Данные                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `request`     | `actionId`, `requestId`, исходный `url: Parameters<F>[0]`, `method`, `startTime` |
| `response`    | Поля request плюс `responseType` и `endTime`                                     |
| `fetch-error` | Поля request плюс `error: Error` и `errorTime`                                   |

`actionId` относится к одному пользовательскому action, `requestId` меняется с каждой попыткой. Времена событий — `Date.now()`. `method` берётся из `init.method`, иначе из Request; для строкового URL без init остаётся undefined, хотя transport может отправить GET.

`responseType: 'OK'` означает любой статус кроме 429, включая 4xx/5xx; проверяйте `response.ok` и тело самостоятельно. Другие значения — `RATE_LIMIT_OVERFLOW` и legacy `PARALLEL_LIMIT_OVERFLOW`. HTTP-ошибка сама по себе не вызывает `fetch-error`; оно относится к transport, разбору заголовков или синхронному исключению observer.

Transport вызывается перед `request` observer; после получения headers и их обработки `response` observer вызывается до resolve или requeue. Синхронный throw request/response observer отвергает action и отменяет его retry. Поздний результат уже завершённого action очищается, не выдаётся повторно. Throw fetch-error observer сохраняет исходную ошибку action; вторичная диагностируется фиксированным `FetchPlanner observer failed` через защищённый `process.emitWarning`. Async listeners и обработка их rejected Promise не входят в контракт; обработчики должны быть синхронными и не читать/менять тела через внешние ссылки.

## Исключения Knip

`knip.json` сохраняет публичные экспорты входных файлов: библиотечный `src/index.ts`, unit/live, worker, исполняемые samples и служебные scripts перечислены явно. Новые служебные файлы входят в `project`, но становятся входами только при реальном подключении. Подсказки Knip о повторном объявлении некоторых входов ожидаемы: эти файлы также обнаруживаются через package scripts и встроенные плагины.

Точные исключения: `dotenv` используется при ручном запуске sample через `node -r dotenv/config` (комментарий в `samples/demo.ts`), а не через импорт; обычный `check` его не загружает. `report` — подкоманда в `c8 report` из `coverage:report`, которую Knip 6.44.0 ошибочно считает отдельным бинарником. Удалить соответствующее исключение при отказе от ручной загрузки dotenv или после исправления распознавания подкоманды c8.

## Разработка и проверки

Для разработки используйте Node из `.node-version` и pnpm из `packageManager` в `package.json`: это единственные источники точных версий. Минимальный runtime библиотеки — Node 24; следующий выпуск с этим изменением будет major. Проверки ниже выполнялись на Linux; Windows и macOS пока не проверены. Команды используют POSIX shell и утилиты `rm` и `tar`.

### Свежая установка

Нужен доступный Node/npm для первоначальной установки инструментов. Из корня checkout можно установить закреплённые Node и pnpm в отдельный временный каталог без глобальной установки; npm входит в исходную установку Node и также нужен для проверки упаковки:

```sh
planner_tools="$(mktemp -d)"
npm install --prefix "$planner_tools" --no-save --package-lock=false "node@$(cat .node-version)" "$(node -p 'require("./package.json").packageManager')"
export PATH="$planner_tools/node_modules/node/bin:$planner_tools/node_modules/.bin:$PATH"
node --version
pnpm --version
pnpm install --frozen-lockfile --strict-peer-dependencies
```

Сохраните этот PATH для следующих команд и запуска VS Code из того же терминала. Установка инструментов и зависимостей обращается к registry; `.env`, токены и глобальный `np` не нужны. Не копируйте `.env` для настройки разработки. При уже установленных точных Node/pnpm достаточно последней команды. Frozen lockfile запрещает незаметное обновление графа зависимостей; конфликт peer dependencies должен завершать установку ошибкой.

### Обычные проверки

Полная локальная проверка перед передачей изменений:

```sh
pnpm check && pnpm coverage && pnpm test:package
```

`pnpm check` последовательно запускает общий typecheck, type-aware oxlint, проверку формата, Knip и offline unit-тесты. После установки зависимостей `pnpm test`, `pnpm check` и `pnpm coverage` работают без сети, секретов и API МойСклад. Проверки не переписывают входные файлы; сгенерированные `build`, `__temp` и `coverage` допустимы. Линтер проходит без предупреждений; подсказки Knip об избыточных entry patterns описаны выше.

`pnpm coverage` пересобирает тесты и измеряет реально исполняемый `__temp/test-build/src`; sourcemaps отображают результат на исходные модули `src`. Gate требует исполненные строки и функции в index/planner/pacing/response-policy/runtime и исполнение `wrapFetch`, запрещает test/samples в LCOV. `src/fetch-types.ts` содержит только типы и не требует runtime counters. `pnpm coverage:report` пересоздаёт отчёт из уже собранных данных.

`pnpm build` очищает `build` и собирает только библиотечный src в `build/src`, включая JavaScript, declarations и sourcemaps. `pnpm build:test` отдельно собирает src/test в `__temp/test-build`; `pnpm test` делает эту сборку и запускает явный unit entrypoint. Samples проверяются общим `pnpm typecheck`, но не входят в production build; существующий `@ts-nocheck` в demo ограничивает проверку его тела.

`pnpm test:package` проверяет свежесть tarball при отсутствующей и устаревшей сборке через pnpm и npm, состав пакета, root/deep ESM imports, локальные GET/POST и строгие типовые consumers с TS 5.7.3 и TS 7. Он может обращаться к registry при установке tooling/consumer dependencies; runtime assertions используют локальный transport без API МойСклад. `pnpm pack` тоже собирает актуальный src через `prepack`. Пути `build/src/index.js`, `build/src/index.d.ts` и исходники `src` сохраняются; runtime import TypeScript не обещается.

Исправления запускаются отдельно и меняют файлы:

```sh
pnpm lint:fix
pnpm format
```

Для отдельных немутирующих проверок доступны `pnpm typecheck`, `pnpm lint`, `pnpm format:check` и `pnpm knip`. В VS Code конфигурации Build library и Offline unit tests запускают `pnpm build` и `pnpm test`; секреты автоматически не загружаются.

### Живой stress

`pnpm test:live` требует явного opt-in `MOYSKLAD_LIVE_STRESS=1` и credentials, переданных снаружи в окружение. Без точного значения `1` команда отказывает до создания Piscina/workers и сетевых запросов. Это отдельная нагрузка на настоящий API, её нет в test/check/coverage и CI. Не включайте её для обычной проверки checkout.

### Границы совместимости и долги

Публичные типы используют прямую зависимость `undici-types@7.3.0`; consumers без установленного undici и с `undici@7.3.0` проверены на TS 5.7.3 и TS 7. Это устраняет ссылку деклараций на dev-only undici. Типовые fixtures покрывают native Request/URL/FormData/File и bytes, локальный runtime — payload, metadata, Response и replay; точные границы сигнатуры описаны в [архитектуре](docs/architecture.md#типовой-контракт). Runtime-зависимость undici не добавлена; `undici-types` остаётся прямой зависимостью деклараций.

Один oxlint сохраняет принятый синтаксический запрет `process.exit`; полного анализа aliases нет. Потеря остальных прежних статических Node/dependency guards принята отдельно. Регрессии D01–D08 проверяют lifecycle, общий deadline, параллелизм, числовые границы и cleanup; jitter проверяется детерминированно по формуле. Открыты D09 (planner cancellation), полная политика replay D10 и `errorLimits` D12. Их наличие не скрывается зелёными локальными проверками.

Ранее локально проверены unit на Node 26 и runtime smoke одного tarball на Node 24.0.0, 24.22.2 и 26.13.0. Настоящие GitHub Actions jobs, runner и передача artifact ещё не проверены; YAML и локальные проверки не заменяют зелёный Actions run.

## Будущий выпуск

Сейчас выпуск запрещён. Перед ним необходимо:

1. Завершить сквозную приёмку этапа 3 и решения этапа 4: D09, политику replay D10, `errorLimits` D12, stop, классификацию 1073 без legacy-заголовка и поведение 429 без временных hints.
2. Получить зелёные `pnpm check`, `pnpm coverage`, `pnpm test:package` и реальный Actions run со всей runtime matrix и передачей artifact.
3. Получить отдельное разрешение владельца на major-выпуск с минимумом Node 24, изменением версии/changelog, tag, push и публикацией.
4. Только после разрешения запускать закреплённый локальный инструмент `pnpm exec np` из установленного checkout. Глобальный np не требуется.
