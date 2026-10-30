# Карточки задач

## T10 — проверить совместимость кандидатов и миграцию проверок

- Критерий: отчёт содержит версии/engines/peer constraints, exit codes компиляции и диагностик, таблицу правил «сохранено/эквивалент/потеря», воспроизводимые команды и решение U1–U3. Ни один провал не обозначен успехом из-за пустого списка файлов. Любое новое требование менять API выделено до T20. Словесный критерий: достаточность таблицы оценивается ревьюером, сами утверждения проверяются CLI/tsc.
- Файлы: `02-research.md`, `evidence/toolchain-compatibility.md`; прототипы/изолированные установки только `__temp/environment-compat/`.
- Вид/source/deps: ../01-plan.md, T10.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T10.md`
- Исполнитель T10/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A7ed5933d-0a92-414a-b976-974d9e66189b%3Adelegate-task%3Afetch-planner-002-T10-1-implementation`.
- Верификатор T10/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A7ed5933d-0a92-414a-b976-974d9e66189b%3Adelegate-task%3Afetch-planner-002-T10-1-verifier` · V1 отдельно · passed · отчёт `journal/T10.accept-1.md`; ограничение независимости: та же модель.

## T15 — минимум Node 24 и пересмотр U2

- Критерий: package.json engines.node = >=24; root engines в существующем package-lock.json согласован. name/version/main/types и алгоритмы не изменены. Компиляция и все 13 offline тестов проходят на закреплённом рабочем Node 24.22.2. Отчёт отделяет снятые ограничения Node 18 от остающихся потерь Node-правил; каждой рекомендации есть воспроизводимая проба и альтернативное решение. Дополнительный lint pipeline и молчаливое принятие потерь не вводятся.
- Файлы: package.json, package-lock.json (только engines), test/index.test.ts (одна unused-disable строка), evidence/node24-floor.md.
- Вид: правка кода и исследование · source: решение владельца «да, поднимай» · deps: T10.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: journal/T15.md.
- Исполнитель T15/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T15-1-implementation`; пересмотр основания U2 после изменения публичного минимума.
- Верификатор T15/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T15-1-verifier` · V2 отдельно · partial (только описание результатов), текст исправлен оркестратором; код независимо прошёл · отчёт `journal/T15.accept-1.md`; ограничение независимости: та же модель.

## T20 — перейти на закреплённый pnpm и локальные инструменты

- Критерий: в новой временной копии без node_modules `pnpm install --frozen-lockfile` проходит; повторная установка не меняет lock; CLI запускаются через pnpm exec; manifest содержит прежние name/version/main/types и принятый engines >=24; единственный lock — pnpm. Состав зависимостей сопоставлен с T10, случайных массовых upgrades нет.
- Файлы: package.json, pnpm-lock.yaml, package-lock.json (удаление), .node-version, .gitignore/.npmignore; pnpm-workspace.yaml только при нужных настройках.
- Вид/source/deps: ../01-plan.md, T20.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T20.md`
- Исполнитель T20/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T20-1-implementation`.
- Верификатор T20/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T20-1-verifier` · V3 отдельно · passed · отчёт `journal/T20.accept-1.md`; ограничение независимости: та же модель.

## T30 — разделить проверку типов, production и test build

- Критерий: `pnpm typecheck`, `pnpm build`, `pnpm build:test` проходят; после свежего build в build нет test/samples, пути main/types существуют. В копии проекта добавить намеренно неверный sample: build проходит, typecheck завершается ошибкой с именем sample; убрать пробу. Декларации и JS сравнить с baseline T10: разрешены compiler emit и type-only packaging, изменение алгоритмов запрещено.
- Файлы: tsconfig.json, tsconfig.prod.json, новый tsconfig.test.json; package.json; небольшой scripts/clean.mjs при необходимости.
- Вид/source/deps: ../01-plan.md, T30.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T30.md`
- Исполнитель T30/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T30-1-implementation`.
- Верификатор T30/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T30-1-verifier` · V4 отдельно · passed · отчёт journal/T30.accept-1.md; ограничение независимости: та же модель.

## T40 — выделить offline тесты и закрыть неявный live запуск

- Критерий: `pnpm test` и `pnpm coverage` без токенов/загрузки dotenv выполняют все 13 исходных тестов; LCOV содержит src/index.ts, положительные hit counts строк/функций, включая wrapFetch, и не содержит test/samples. Проверка отчёта отвергает пустой LCOV и нулевое исполнение src. Запуск test:live без opt-in и импорт compiled stress entrypoint в изолированном child дают понятный отказ до workers. Реальный opt-in и live запросы не запускаются. Проверить список фактически запущенных test files, а не только exit code.
- Файлы: package.json; test/stress.test.ts; scripts/run-live.mjs при необходимости; конфигурация c8.
- Вид/source/deps: ../01-plan.md, T40.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T40.md`
- Исполнитель T40/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T40-1-implementation`.
- Верификатор T40/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T40-1-verifier` · V5 отдельно · passed · отчёт journal/T40.accept-1.md; ограничение независимости: та же модель.

## T50 — перенести существенные правила в type-aware oxlint

- Критерий: `pnpm lint` проходит на выбранной строгой конфигурации. В копии source/test добавить соответственно необработанный Promise, async callback в синхронном месте, await не-Promise и unsafe вызов; каждое нарушение даёт нужное правило, после удаления пробы lint снова проходит. Нет потери существенной проверки без явного решения и нет широкого lint-disable. Dependency graph не содержит удалённого ESLint после полной замены.
- Файлы: .oxlintrc.json, eslint.config.mjs (удаление после сравнения), package.json/pnpm-lock.yaml, точечные lint-directives src/test/samples; evidence/toolchain-compatibility.md.
- Вид/source/deps: ../01-plan.md, T50.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T50.md`
- Исполнитель T50/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T50-1-implementation`.
- Верификатор T50/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T50-1-verifier` · V6 отдельно · passed · отчёт journal/T50.accept-1.md; ограничение независимости: та же модель.

## T60 — закрепить форматирование отдельной командой

- Критерий: `pnpm format:check` проходит; второй `pnpm format` не меняет входы; специально испорченный пробел/кавычка в копии файла обнаруживается check и исправляется format. Разница src/test/samples только механическая; все существующие unit тесты проходят. В Markdown абзацы не разбиты по ширине.
- Файлы: .oxfmtrc.json, package.json; src/test/samples/config/README и Markdown, если нуждаются в механическом формате.
- Вид/source/deps: ../01-plan.md, T60.
- Риск: high · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T60.md`
- Исполнитель T60/1: ступень 2 · gpt-6.1-sol (low) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T60-1-implementation`.
- Верификатор T60/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3Aa507b654-c3da-4647-a87e-8cb1e9a713e5%3Adelegate-task%3Afetch-planner-002-T60-1-verifier` · V7 отдельно · passed · отчёт journal/T60.accept-1.md; ограничение независимости: та же модель.

## T70 — добавить knip и собрать немутирующий check

- Критерий: `pnpm knip` и `pnpm check` проходят. В копии добавить недостижимый служебный файл и зависимость без употреблений: соответствующие Knip diagnostics появляются; публичные FetchPlanner/wrapFetch и event types не удалены. Хеши входов до/после check совпадают, а ошибки любого шага дают общий ненулевой exit. Игнорируемый build не делает analysis пустым.
- Файлы: knip.json, package.json, pnpm-lock.yaml; README/отчёт долга только для объяснения исключений.
- Вид/source/deps: ../01-plan.md, T70.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T70.md`
- Исполнитель: ступень 3, gpt-6.1-sol (medium).
- Верификатор: ступень 3, gpt-6.1-sol (medium); свежий контекст, ограничение независимости: та же модель.

## T80 — исправить замыкание зависимостей типов и проверить tarball

- Критерий: `pnpm test:package` проверяет A6–A8, strict/skipLibCheck=false, без cast-to-any; отрицательные cases дают ожидаемую type error и не маскируют остальные ошибки. При подмене declaration на старую с dev-only undici consumer без undici падает TS2307. При подмене JS в старом build упаковка восстанавливает актуальный исходник. Runtime smoke использует Response/local transport без внешней сети, проверяет GET/POST и возврат исходного Response. Не заявлять native fetch типовую совместимость; известный пробел явно записан. Ошибка старого undici контракта не лечится новой сигнатурой в этом плане.
- Файлы: src/index.ts (только type-only import и обоснованная lint-directive), package.json/pnpm-lock.yaml; scripts/check-package.mjs, test/package/fixtures/** или эквивалентные небольшие consumer fixtures.
- Вид/source/deps: ../01-plan.md, T80.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T80.md`
- Исполнитель: ступень 4, gpt-6.1-sol (high).
- Верификатор: ступень 3, gpt-6.1-sol (medium); свежий контекст, ограничение независимости: та же модель.

## T90 — обновить CI и матрицу совместимости

- Критерий: все shell-команды workflow воспроизведены локально в доступной среде; JSON/YAML структуры, Actions inputs и порядок установки проверены. При разрешённом будущем запуске Actions все обязательные jobs зелёные, пакет тот же по checksum во всей runtime matrix; на этом шаге push не выполняют. Недоступные локально runtime и отсутствие фактического CI-run названы как непроверенные, а не passed. MOYSKLAD_TOKEN/dotenv/live отсутствуют в default workflow.
- Файлы: .github/workflows/main.yml; scripts/package runtime smoke, если нужно отделить от сборки; package.json только при нужном alias.
- Вид/source/deps: ../01-plan.md, T90.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T90.md`
- Исполнитель: ступень 3, gpt-6.1-sol (medium).
- Верификатор: ступень 3, gpt-6.1-sol (medium); свежий контекст, ограничение независимости: та же модель.

## T100 — описать разработку и выполнить сквозную приёмку

- Критерий: из новой временной копии без build/node_modules повторяется documented setup и `pnpm check && pnpm coverage && pnpm test:package`; входные файлы не изменяются. Словесный критерий: инструкция достаточна без знания диалога, перечень непроверенного и долгов этапа 3 соответствует реальным результатам. Версия/changelog не изменены, выпуск и интеграция импортёра не начаты.
- Файлы: README.md (разработка/проверки/выпуск), .vscode/launch.json/settings.json при нужной замене npm tasks; docs/plans/002-environment-modernization/02-research.md и evidence итоговых проверок.
- Вид/source/deps: ../01-plan.md, T100.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Журнал: `journal/T100.md`
- Исполнитель: ступень 3, gpt-6.1-sol (medium).
- Верификатор: ступень 3, gpt-6.1-sol (medium); свежий контекст, ограничение независимости: та же модель.
