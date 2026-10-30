# T15: минимум Node 24 и пересмотр U2

Основание: решение владельца «да, поднимай» в [run/decisions.md](../run/decisions.md). В package.json и корневой metadata package-lock.json теперь только engines.node = `>=24`; граф зависимостей, name/version/main/types не менялись. Это заменяет прежний runtime >=18 в плане, но не разрешает удаление Node-проверок. Итоговые README, матрица 24/26 и major release остаются следующим задачам; здесь версия не повышается. Compiler target не менялся.

## Фактическая регрессия

Проверено локальным `__temp/environment-compat/node_modules/node/bin/node`, версия v24.22.2. Прежний TS5 emit завершился с exit 0; явный offline entrypoint дал 13 tests / 13 pass / 0 fail / 0 skipped. Исходник src/index.ts сохранил SHA256 `64955f53f496e347d4dbe3271876a7b7a976dcf6f70d5e4635ff79e9b65672e1`. Чужая errorLimits не менялась.

Итоговая независимая проверка немутирующим ESLint завершилась с exit 0, 0 errors, **2 warnings**: только исходные samples/wait-for-request-slot-1.ts:105,130. При первом запуске T15 было третье предупреждение о ненужном `eslint-disable n/no-unsupported-features/node-builtins` в test/index.test.ts:2. После повышения floor Node test API больше не требует этого подавления; директива точечно удалена, повторная проверка подтвердила восстановление baseline. Конфигурация линтера не ослаблена. Результаты compiler, 13 offline тестов и baseline hash также независимо подтверждены в [отчёте приёмки](../run/journal/T15.accept-1.md).

## Что снял новый floor

В src есть один runtime import: `node:assert`, используются assert.ok; импорт undici — type-only. Поиск по src, Node-проверки на текущем TS без type information и на его emitted JS, а также runtime smoke assert.ok/assert.throws на Node 24 дали успешный результат. Прочие используемые Node globals (process.env, timers, setImmediate) также прошли проверку прежними Node-правилами. Нового несовместимого runtime API в текущем src не обнаружено; это не проверка всех будущих изменений.

Базовый fs.globSync доступен и стабилен с Node 24.0.0 по [истории Node API](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsglobsyncpattern-options); локальный smoke на 24.22.2 прошёл. Поэтому пример T10 больше не доказывает нарушение принятого runtime-контракта. Но eslint-plugin-n **17.15.1** продолжает выдавать experimental diagnostic и при >=18, и при >=24: в его локальной таблице fs.globSync указан только `experimental: ["22.0.0"]`, без версии стабилизации. Это устаревшая таблица плагина, а не оставшееся основание поддерживать Node 18 [ROOT, VERIFY]. Глобальное allowExperimental ради этого не предлагается. Если владелец выберет Node guard, его данные потребуют отдельной проверки/актуализации в T50; здесь зависимости не обновляются.

Node 24.22.2 smoke не доказывает работу на самом раннем 24.0.0: например, у globSync есть опции, добавленные внутри ветки 24. Проверка границы 24.0.0 остаётся будущему runtime gate; другой runtime в T15 не устанавливался. Сохраняются ES2022 target и нынешние типы Node 22; ни target, ни типы не являются полным ограничителем всех Node API/опций.

## Все 14 потерь: что осталось после floor24

Проверки выполнялись установленными CLI и API ESLint Linter; отрицательные fixtures не добавлялись в рабочие исходники. «Риск» означает возможность регрессии в публикуемом пакете, а не найденный новый дефект scheduler.

| Прежнее правило | Фактическая проба / результат | Остающийся смысл |
| --- | --- | --- |
| n/no-deprecated-api | SlowBuffer: Node rule диагностирует; type-aware oxlint также даёт typescript/no-deprecated | Частичное пересечение есть; равенство таблицы Node и JSDoc types не доказано |
| n/no-extraneous-import | import semver из транзитивной установки: Node rule диагностирует | Реальный риск зависимости от hoisting; floor24 его не снимает |
| n/no-extraneous-require | require semver: Node rule диагностирует в CommonJS fixture | Тот же риск; текущий src — ESM, require сейчас отсутствует |
| n/no-missing-import | import './absent.js': Node rule диагностирует; oxlint на fixture молчит | TS закрывает часть статических TS imports; JS/динамические пути и упаковка требуют отдельных проверок |
| n/no-missing-require | require './absent.js': Node rule диагностирует | TypeScript не является универсальной проверкой require resolution; текущий src его не использует |
| n/no-process-exit | process.exit(1): Node rule диагностирует; oxlint и TS7 + runtime smoke пропускают dormant branch | Существенный риск завершения процесса потребителя, не зависит от версии Node |
| n/no-unpublished-bin | bin cli.js исключён из files: Node rule диагностирует | Сейчас bin отсутствует, немедленной проблемы нет; проверка будущего CLI/упаковки теряется |
| n/no-unpublished-import | runtime import undici из devDependencies в публикуемом JS: Node rule диагностирует | Существенный риск неполного пакета; type-only зависимости деклараций дополнительно требуют T80 |
| n/no-unpublished-require | require undici из devDependencies: Node rule диагностирует | Аналогичный риск; CommonJS сейчас отсутствует |
| n/no-unsupported-features/es-builtins | toSorted и regexp /d при >=24 проходят | Для пробы сняты старые ограничения; сохранение всех будущих гарантий не доказано |
| n/no-unsupported-features/es-syntax | Та же проба при >=24 проходит | ES2022 emit ограничивает синтаксис; runtime smoke не проверяет неисполненные ветви и все API |
| n/no-unsupported-features/node-builtins | Текущий src проходит; globSync ошибочно помечен experimental старым plugin | Прежний конкретный блокер снят, контроль будущих API сам по себе не заменён |
| n/process-exit-as-throw | meta.supported=false в установленном ESLint 9; consistent-return с правилом и без даёт одинаковую диагностику | Это модификатор control flow, не самостоятельный запрет exit; в данной baseline уже не работает, считать новой существенной потерей нельзя |
| n/hashbang | bin cli.js без shebang: Node rule диагностирует | Сейчас нет bin, низкая текущая значимость; floor24 не заменяет проверку |

В объединённой oxlint-пробе проверены **6 файлов**, не пустой набор. Найдены только deprecated/unsafe диагностики SlowBuffer, нет диагностики для missing/extraneous/unpublished imports и process.exit. Отдельная чистая TS-проба dormant process.exit проверена 1 файлом: oxlint exit 0. Файл опубликованного fixture важен: Node no-unpublished-import закономерно молчит, если сам проверяемый файл исключён из files. Первая такая неудачная настройка пробы исправлена перед итогом; её нельзя трактовать как отсутствие функции правила.

## Нужен ли отдельный TS5 parser

Нет основания требовать отдельный **TS5 compiler/type-aware parser** для самих Node-правил. Воспроизводимая проба текущего src с @typescript-eslint/parser `project:false` прошла; type information этим правилам не понадобилась. Это не снимает peer constraint установленного parser относительно TS7 и не разрешает force/legacy-peer-deps.

Отдельная проба всех включённых Node-правил на настоящем emitted src/index.js прошла через стандартный Espree без TS parser. Отрицательные JS-пробы из таблицы также диагностируются без него. Проверка emitted JS сохраняет наблюдение над runtime calls, но не видит стёртые type-only imports; для import resolution существенны итоговый путь и package metadata. Такой guard не заменяет независимый consumer деклараций T80, не сохраняет автоматически исходные TS-директивы/позиции и требует сборки до проверки. В исследовательском subset ненужные disable warnings отключены только внутри in-memory Linter: правила остальных TS checks там не запускались. Полный root ESLint проверялся отдельно без этого отключения.

## Сравнение решений перед T20

1. **Runtime24 smoke + types:** минимальная поверхность, уже нужны плану. На TS7 строгая компиляция fixture с dormant process.exit и deprecated API прошла; runtime24 вызвал безопасную ветвь и тоже прошёл. Поэтому это не эквивалент Node-правилам: неисполненный аварийный путь остаётся незамеченным. При выборе нужно явно принять потерю статических dependency/Node проверок [ALT].
2. **Один oxlint + точный запрет process.exit:** проба no-restricted-properties увеличивает набор 133 → 134 rules и меняет чистый fixture с exit 0 на exit 1 с нужной диагностикой. Нового pipeline и TS5 не требует. Но не заменяет dependency/deprecation/API-version rules; дополнительное именованное ограничение не доказано как полный эквивалент n/no-process-exit для всех форм записи. Потери остальных правил остаются и требуют решения владельца. Tarball consumers T80 снижают часть рисков, но проверяют лишь свои сценарии [SURFACE].
3. **Узкий дополнительный Node guard на emitted JS:** локальные проверки доказали, что TS5/parser environment для runtime Node-правил не обязателен. Цена — дополнительный этап после emit, ESLint + plugin-n, актуальные API-таблицы, согласование путей/публикации и диагностики JS вместо TS. Это исключение из требования одного lint pipeline; type-only замыкание проверяется отдельно в T80. Здесь ничего из этого не внедрено.

Рекомендация после проб: если требуется сохранить статические Node/dependency гарантии, выбрать вариант 3, сократив прежнее предложение T10 с отдельной TS5-средой до проверки JS. Причина — реальные неперекрытые dependency и exit риски; рост floor их не снимает. Более дешёвая альтернатива — вариант 2 с явным принятием остаточных потерь. Вариант 1 недостаточен для прежнего критерия A5. Ни один вариант не разрешён автоматически ответом о Node 24; до решения владельца U2 и запуск зависимой миграции остаются открытыми. Обновление устаревших таблиц будущего guard ещё не проверялось и не объявляется готовым решением [VERIFY].

## Воспроизведение

Из корня проекта; установленные инструменты T10, без install, root scripts, секретов, .env и live. Все подробные команды, exits и результаты находятся в [журнале T15](../run/journal/T15.md). Локальные исследовательские scripts/logs сохранены в /tmp/orchestrate-fetch-planner-002/T15-1, fixtures — в __temp/environment-compat/T15. На этой машине повторение:

```sh
timeout 180 python3 /tmp/orchestrate-fetch-planner-002/T15-1/regression.py
timeout 60 __temp/environment-compat/node_modules/node/bin/node /tmp/orchestrate-fetch-planner-002/T15-1/probes.cjs
timeout 180 python3 /tmp/orchestrate-fetch-planner-002/T15-1/alternatives.py
```

regression.py утверждает фактически наблюдённые 3 warnings, не прежние 2; это воспроизведение результата, а не прохождение критерия отсутствия новых warnings. Исходные неуспешные assertions и исправления исследовательских fixtures описаны в журнале. Скрипты/fixtures игнорируются git и не являются поставляемым вторым lint pipeline. Для переноса на другую машину их надо сохранить вместе с точным прототипом T10; существенные независимые минимальные пробы приведены ниже.

```js
// Временный exit.ts: TS7 strict emit и обычный oxlint проходят;
// runtime smoke dormant() тоже проходит, опасная ветвь не выполнена.
export function dormant(run = false) {
  if (run) process.exit(1)
  return 1
}
```

```json
{
  "no-restricted-properties": ["error", {
    "object": "process",
    "property": "exit",
    "message": "Library code must not terminate the host process"
  }]
}
```

Для повторения проверки JS без TS parser из корня установленного проекта достаточно API ESLint ниже; каждое правило задаётся явно, filename должен принадлежать пакету с корректной metadata. Это исследовательский вызов, не новый файл настройки проекта.

```js
const { Linter } = require('eslint')
const n = require('eslint-plugin-n')
const messages = new Linter().verify('process.exit(1)', [{
  plugins: { n },
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  settings: { node: { version: '>=24' } },
  rules: { 'n/no-process-exit': 'error' }
}], { filename: 'src/probe.js' })
if (!messages.some(m => m.ruleId === 'n/no-process-exit')) throw Error('missing diagnostic')
```
