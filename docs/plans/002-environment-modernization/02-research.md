# Основания плана окружения

Проверено 2026-10-30. Область чтения: текущий репозиторий; явно указанный пример `/home/mvv/Documents/_Git/moysklad-import`; публичные первичные документы инструментов. При подготовке ничего не устанавливалось в проект и настройки не менялись. Пробы подготовки записывались в игнорируемый `__temp/plan-environment/`. Исполнение T10 и отдельный изолированный набор в `__temp/environment-compat/` описаны ниже.

Таблицы ниже описывают исходное состояние и ход исследования. Актуальные решения владельца и итог локальной миграции приведены в разделе «Результат T100» в конце документа.

## Локальные факты

| ID | Факт и статус | Источник и проверка |
| --- | --- | --- |
| F01 | Проверено: ESM, `engines.node >=18`, main/types в build/src; runtime-импорт только node:assert, Fetch-типы из dev-only undici 7.3.0 | package.json; src/index.ts; установленный node_modules/undici/package.json |
| F02 | Проверено: npm lockfile отслеживается; прежний вывод исследования был ошибочен | `git ls-files --error-unmatch package-lock.json` → package-lock.json; `git check-ignore -v package-lock.json` → exit 1 без вывода; исключение находится в .npmignore; lockfileVersion=3, root version=3.2.0 |
| F03 | Проверено: рабочие Node 24.16.0, pnpm 12.3.4, TypeScript 5.7.3 | `node --version`, `pnpm --version`, `./node_modules/.bin/tsc --version` |
| F04 | Проверено: production tsconfig наследует include src/samples/test, build/test запускают ESLint --fix, обычный node --test обнаруживает stress.test.js | package.json, tsconfig.json, tsconfig.prod.json; test/stress.test.ts создаёт Piscina и запускает stress.worker; живой тест не выполнялся |
| F05 | Проверено: 13 существующих unit-тестов проходят без сети; высокий coverage не покрывает важные lifecycle ошибки | [прежние доказательства](../001-library-renewal/evidence/checks.txt), [матрица тестов](../001-library-renewal/02-research.md), раздел 10; повторять их при подготовке конфигурационного плана без изменений кода не требуется |
| F06 | Проверено: настройки примера — pnpm 12.3.4, TS 7.0.2, oxlint 1.87.0, tsgolint 7.0.2003, oxfmt 0.72.0, knip 6.39.0; команды check разделены; build для публикации включает только src | package.json, tsconfig.build.json, .oxlintrc.json, .oxfmtrc.json, knip.json, pnpm-workspace.yaml импортёра; версии четырёх CLI проверены их --version, без установки и исполнения команд проекта |
| F07 | Проверено: текущий проект компилируется TypeScript 7.0.2 без изменения файлов проекта | `/home/mvv/Documents/_Git/moysklad-import/node_modules/.bin/tsc -p tsconfig.prod.json --outDir __temp/plan-environment/ts7-build --incremental false` → exit 0; это проверка compiler с нынешними зависимостями, не всей будущей комбинации |
| F08 | Проверено: строгому потребителю недоступен dev-only undici из декларации | [проба D11](../001-library-renewal/evidence/consumer-types.json): TS2307; точные команды и исходник пробы сохранены в плане 001 |
| F09 | Проверено: перенос импорта в undici-types 7.3.0 сохраняет текст fetch.d.ts, но не устраняет уже имеющийся конфликт с native fetch | Публичный tarball undici-types 7.3.0 распакован только в __temp; `diff -q node_modules/undici/types/fetch.d.ts __temp/plan-environment/type-probe/node_modules/undici-types/fetch.d.ts` → exit 0; TS 7 проверил исходную и изменённую декларации со strict/skipLibCheck=false; [диагностика](evidence/type-probe.json) |
| F10 | Проверено: локальный np не объявлен, prepare/prepack отсутствуют; CI только push master, Node 22, npm test с MOYSKLAD_TOKEN | package.json; .github/workflows/main.yml |
| F11 | Проверено: ESLint сейчас имеет 0 ошибок, 2 предупреждения в samples; samples/demo.ts содержит @ts-nocheck, ряд подавлений существует и до миграции | `eslint src test samples --no-fix --format json`; диагностика без изменения исходников. Нельзя объявлять полное покрытие samples typecheck только по exit 0 |

## Версии-кандидаты

Это проверенные значения публичного registry на дату подготовки, а не обещание совместимости всех пакетов друг с другом. Снимок engines/peerDependencies: [registry.json](evidence/registry.json). Первые задачи проверяют совместимость и закрепляют итоговый набор. Не используются beta, next, alpha и floating latest в коммитируемой конфигурации.

| Инструмент | Кандидат | Решение |
| --- | --- | --- |
| Node для разработки | 24.22.2 | .node-version — одна локальная pin; CI основного check читает её |
| pnpm | 12.16.1 | Точная packageManager; один pnpm-lock.yaml |
| TypeScript | 7.0.2 | tsc, NodeNext, target ES2022; перенос Compiler API здесь не нужен |
| @types/node | 22.20.5 | Начальный кандидат для исходников/тестов, не latest 26; отдельно проверяем старый runtime и потребителей |
| oxlint + oxlint-tsgolint | 1.90.0 + 7.0.2005 | Пара соответствует объявленному peer minimum; обе закрепляются |
| oxfmt | 0.75.0 | Имеющийся стиль и proseWrap=never |
| knip | 6.44.0 | Явные entrypoints, без автоматического удаления публичных экспортов |
| c8 | 12.0.0 | Сохранить покрытие node:test, измерять только build/src |
| np | 12.1.1 | Локальный devDependency; запуск выпуска вне этого плана |
| undici | Сначала существующий 7.3.0 | Не соединять миграцию инструментов с изменением transport-контракта; более новый dev-only 7.x допустим только после отдельной проверки T10 |
| undici-types | 7.3.0 | Чистая зависимость опубликованных типов, соответствующая существующей декларации; без добавления HTTP runtime зависимости |

Registry показывает TypeScript 7.0.2 и ограничение latest typescript-eslint `>=4.8.4 <6.1.0`: их совместную поддержку предполагать нельзя. Новые oxlint/oxfmt/knip/c8 требуют современный Node; это требование процесса разработки, не автоматически библиотеки.

## Первичные источники и выводы

- Из документации: [расписание Node](https://github.com/nodejs/Release#release-schedule); версии дополнительно проверены публичным `https://nodejs.org/dist/index.json`, результат в registry.json. Node 18/20 EOL не является разрешением молча поднять engines существующего пакета.
- Из документации: [установка pnpm](https://pnpm.io/installation), [CI](https://pnpm.io/continuous-integration), [action-setup](https://github.com/pnpm/action-setup). Поддерживается pnpm 12; для GitHub Actions можно использовать action-setup и setup-node. Версию pnpm берём из packageManager; установка frozen явная; обязательный Corepack не добавляем.
- Из документации: [pnpm pack](https://pnpm.io/cli/pack) выполняет prepack/prepare и умеет JSON-вывод; проверять надо настоящий tarball. Это не основание предполагать одинаковую обработку lifecycle scripts npm и pnpm: обе упаковки проверяются локально в T80.
- Из документации: [настройки pnpm](https://pnpm.io/settings) содержатся в pnpm-workspace.yaml; .npmrc относится к registry/auth/TLS/proxy. Не копировать устаревшие настройки pnpm из памяти. При необходимости настройки единственного пакета используют этот YAML без создания монорепозитория.
- Из документации: [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [NodeNext](https://www.typescriptlang.org/tsconfig/moduleResolution.html). Локальная компиляция F07 проверяет нужный здесь tsc путь; CLI-пробы с перечнем файлов заменяем на `-p` временного tsconfig, поскольку TS 7 отдельно диагностирует такой запуск при соседнем tsconfig.
- Из документации: [type-aware oxlint](https://oxc.rs/docs/guide/usage/linter/type-aware.html), [проект мигратора](https://github.com/oxc-project/oxlint-migrate), [директивы](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html). Нужны tsgolint и реальная проверка правил. Старые eslint-directives понимаются, но имена правил требуют сопоставления. Автомиграция не доказывает сохранение проверок.
- Из документации: [Knip entry files](https://knip.dev/explanations/entry-files); main/types/package scripts тоже дают точки входа. Явные src/index.ts, samples, unit/live entrypoints и scripts нужны для проекта с игнорируемым build. Публичный экспорт не становится мёртвым от отсутствия внутреннего вызова.

## Что осталось проверить при исполнении

Совместимость полного набора новых инструментов, новый lockfile и его чистая установка; сохранение полезных lint-правил; declarations с новым compiler и строго типизированными потребителями; соответствие готового JS Node 18.0.0. Они не проверены установкой и не выдаются за готовый результат.

Полноценная совместимость native fetch — отдельная подтверждённая проблема типа Fetch. В пробе с DOM это несовпадение Request.bytes, с lib ES2022 также обнаруживается несовпадение FormData/File. Статус «исправлены зависимости типов» нельзя подменять статусом «исправлен весь Fetch API». Публикация остаётся заблокированной будущими этапами.

Для повторения F09 скопировать `evidence/type-probe.mjs.txt` в `__temp/plan-environment/type-probe.mjs` и выполнить из корня проекта; compiler передан явно, пример использует уже установленный в импортёре CLI только для чтения. Скрипт не запускает consumer-код и не обращается к API: адрес example.invalid присутствует только в компилируемом тексте.

```sh
node __temp/plan-environment/type-probe.mjs /home/mvv/Documents/_Git/moysklad-import/node_modules/.bin/tsc docs/plans/002-environment-modernization/evidence/type-probe.json
```

Ненулевые статусы compiler для consumer здесь — собранная диагностика существующей проблемы, не зелёный тест. Родительский скрипт сообщает результаты и не выдаёт эти ошибки за успешную проверку типов.

## Результат T10 — 2026-10-30

Подробные проверяемые результаты, полный перенос 148 активных правил, версии/engines/peers, exit codes и команды: [toolchain-compatibility.md](evidence/toolchain-compatibility.md). Журнал исполнения: [T10](run/journal/T10.md).

U1 подтверждён для исследованного набора: Node 24.22.2, pnpm 12.16.1, TS 7.0.2, @types/node 22.20.5, oxlint 1.90.0 + tsgolint 7.0.2005; strict/skipLibCheck=false, 9 файлов, 13 выполненных offline tests. Прежние 2 warnings воспроизводятся, новых нет. Oxfmt/Knip работают, но пока закономерно дают diagnostics, а не готовые зелёные команды будущего check.

U2 выявил блокер зависимой миграции: 14 Node-правил отсутствуют в oxlint. Контроль fs.globSync отвергается прежним n/no-unsupported-features/node-builtins и проходит oxlint. Полного эквивалента для runtime >=18 нет; удалять старый guard молча нельзя. До T20 владелец должен разрешить узкий дополнительный guard (рекомендуется) либо явно принять потерю проверок; оба решения меняют принятые границы. Второй pipeline не добавлен.

U3: зеркальный type-only импорт undici-types 7.3.0 сохраняет проверенный undici 7.3.0 контракт на TS 5.7.3 и 7.0.2, включая отрицательные cases. Native fetch остаётся несовместимым по Request.bytes/FormData/File; новый API не требуется для этой миграции. Независимые tarball consumers вне дерева и TS2307 gate остаются T80, местный барьер undici — только исследовательская проба.

Baseline emit для T30 сохранён в __temp/environment-compat/baseline-emit, исходный errorLimits не изменён; hash и результаты регрессии — в evidence. Исследование завершено, готовность T20 не объявлена из-за U2. Старое описание «что осталось проверить» выше относится к моменту подготовки; установку и ограниченную совместимость заменяют факты T10, pnpm lock/build/package/CI gates остаются последующим задачам.

## Результат T100 — 2026-10-30

Инструкция разработки и будущего выпуска добавлена в README; VS Code использует pnpm build/test без автоматического подключения .env. Точная рабочая версия берётся из .node-version (24.22.2), pnpm — из packageManager (12.16.1); локальная установка инструментов не требует глобального np и секретов. Доказательства итоговой проверки, команды и хеши разрешённых входов: [t100-final-checks.md](evidence/t100-final-checks.md); журнал задачи: [T100.md](run/journal/T100.md).

Принятые владельцем решения заменяют прежние предложения этой папки: engines.node >=24, будущий выпуск major, runtime matrix 24.0.0/24.x/26.x. Один oxlint, синтаксический запрет process.exit и принятая потеря остальных статических Node/dependency guards; полного alias analysis не заявляем. Дополнительный ESLint pipeline не вводится [CONSIST, SURFACE].

Свежая копия вне репозитория без build/node_modules/.env установлена с frozen lockfile и strict peers на закреплённых Node/pnpm. Цепочка pnpm check && pnpm coverage && pnpm test:package проходит; исходные 13 unit-тестов исполняются без skip, LCOV содержит реально исполненный src/index.ts и wrapFetch. Два прежних lint warnings и пять подсказок Knip сохранены. Немутирующие проверки, сборки и упаковка сохраняют хеши явного allowlist входов. Coverage не означает покрытия известных краевых ошибок scheduler [VERIFY].

A1–A10 подтверждены локальными проверками T100 и ранее принятыми адресными проверками T20–T90 в объёме, указанном в evidence. D1 из приёмки T90 дополнительно проверен на фактическом shell-фрагменте workflow: исходный fixture проходит, переименование deep в deepAlias даёт отказ до checksum при потере deep import. Это локальная проверка, окончательная независимая приёмка плана остаётся оркестратору.

Фактические GitHub Actions jobs, runner и artifact upload/download не запускались: push не разрешался. Локальные unit на Node 26 и один tarball на 24.0.0/24.22.2/26.13.0 ранее подтверждены T90; Windows/macOS не проверены. Зелёный реальный Actions run всей matrix обязателен до будущего выпуска, локальная готовность окружения его не подменяет.

D11 закрыт только в части dev-only зависимости деклараций: direct undici-types@7.3.0 и strict consumers без undici/с undici@7.3.0 на TS 5.7.3/7 проходят. Native fetch по Request.bytes/FormData/File остаётся блокером этапа 3 и выпуска. Чужая errorLimits сохранена незавершённой: это не готовая функция защиты.

Следующему отдельно планируемому этапу передаются D01–D08 (терминальность action, ошибки callbacks/transport, общий Retry-After, bounds correction, дробный parallel limit, освобождение тела 429), D10 (границы replay одноразового тела), Fetch-совместимость, граничная валидация/getters/метаданные и lint-долги. Jitter-test уже падал на delaysDiffAvg<10 в V8: успешные повторы не устраняют нестабильность; threshold здесь не меняется. D09 (abort/stop) остаётся этапу 4; судьба D12/errorLimits и политика лимитов ошибок требуют решения до выпуска. Документация лимитов API остаётся долгом исследования 001 и здесь не исправляется.

Версия/changelog, git index, теги и публикация не менялись. Этапы 3–4 и интеграция импортёра не начинались. Будущий major-выпуск требует завершения этих этапов, локальных gates, настоящего Actions run и отдельного разрешения владельца; инструмент выпуска — pnpm exec np.
