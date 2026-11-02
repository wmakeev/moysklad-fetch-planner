# Разработка и проверки библиотеки

Инструкция для агента в обычном клоне. Правила изменений — [AGENTS.md](../AGENTS.md), контракт — [API](api.md), выбор suites по модулям — [архитектура](architecture.md). Команды ниже не обращаются к аккаунту МойСклад; установка dependencies/package tooling скачивает пакеты из registry.

## Подготовить чистый клон

Нужны Node24.22.2 из `.node-version`, pnpm12.16.1 из packageManager и npm для подготовки tooling. Если инструмента нет, сообщите владельцу точную недостачу и предложите установку; не устанавливайте global toolchain автоматически. Проверьте фактические версии до выполнения gates.

В локальной compatibility-среде, если она уже установлена владельцем, используйте её PATH из корня проекта перед командами. Отсутствие этого локального каталога в обычном клоне нормально; он не поставляется в Git.

```sh
export PATH="$PWD/__temp/environment-compat/node_modules/node/bin:$PWD/__temp/environment-compat/node_modules/.bin:$PATH"
```

```sh
node --version
pnpm --version
npm --version
pnpm install --frozen-lockfile
```

Compiler fixtures также требуют TS5.7.3 по историческому пути. Это явный prerequisite существующего runner, а не transitive dependency, которая обязана появиться от root install. Подготовка совпадает с check/unit jobs workflow:

```sh
compiler="$PWD/node_modules/.pnpm/typescript@5.7.3"
mkdir -p "$compiler"
printf '{"private":true}\n' > "$compiler/package.json"
npm install --prefix "$compiler" --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact typescript@5.7.3
node "$compiler/node_modules/typescript/bin/tsc" --version
```

Вывод последней команды должен быть `Version 5.7.3`. Текущий основной compiler — TS7.0.2. TS5.7.3 проверяет совместимость публичных типов и диагностик потребителя. Не подменяйте отсутствующий compiler текущим и не создавайте фиктивный receipt. Долг зависимости от внутреннего пути `.pnpm` ограничен существующим harness; его смена требует отдельного изменения dependency declaration и всех compiler references.

## Выбрать проверку по изменению

| Изменение | Проверка |
| --- | --- |
| Только Markdown, ссылки, ignore rules | Прочитать результат, проверить пути/якоря и отсутствие приватных зависимостей; runtime gates не нужны |
| Типы или публичная сигнатура | typecheck, relevant compiler fixtures и package consumers |
| Coordinator, callbacks, cleanup, retry или policy | Relevant operation suites, затем необходимые полные gates |
| Manifest, prepack, compiler/package runner | Fresh isolated package gate; старый artifact/finished state не переиспользовать |
| Samples | Compile-only audit/typecheck и knip; не исполнять и не импортировать |

Стандартные полные gates после source change, если scope требует полной приёмки:

```sh
pnpm check
pnpm coverage
node .github/scripts/package-ci.mjs
```

`check` объединяет strict typecheck, lint, format check, knip и полный offline test graph. `coverage` повторяет тот же graph под c8 и проверяет LCOV всех15 executable source modules и executed public submit; fetch-types — type-only. Не повторяйте эти команды без изменённых inputs или конкретного отказа. Во время чужой параллельной работы не запускайте широкий workload из документальной задачи.

Для отдельной operation suite используйте имя из registry в test/operation/run.mjs. Команда сама компилирует operation graph; public/types/hook-types selectors дополнительно выполняют свои compiler phases.

```sh
node test/operation/run.mjs http-integration
```

## Выполнить package gate

В чистом клоне не вызывайте один `pnpm test:package` без подготовки: он требует fresh внешние state/work/tooling/cache. Штатная обёртка выше создаёт новый owned TMPDIR, устанавливает npm11.13.0, отдельные bare/undici leaves с TS5.7.3/TS7.0.2 и Node24.0.0/24.22.2/26.13.0, затем вызывает неизменённый полный test:package и удаляет свои ресурсы.

Она проверяет четыре cold/stale pack cases, четыре compiler/family slices, runtime profiles и finish по одному frozen artifact. Bare consumer не получает runtime Undici; Undici family использует7.3.0. Wrapper не публикует npm-пакет, но требует сетевого чтения registry, GNU tar и прав создать/удалить свой scratch. Ошибка setup не является отказом product assertion; сохраняйте исходный error и лог.

Для отдельного локального кандидата `pnpm pack` выполняет prepack/build. Один успешный pack не равен package acceptance. Порядок получения проверенного Actions artifact — [руководство агента](agent-guide.md); условия финального релизного кандидата — [выпуск](releasing.md).

## Матрица CI

| Job | Что проверяет |
| --- | --- |
| check, Node24.22.2 | Полные check и coverage |
| unit, Node26.x | Полный test graph на старшей Node |
| package, Node24.22.2 | Fresh isolated package gate с pinned profiles/compilers |
| artifact | Одна сборка package и runtime fixture с SHA256SUMS |
| runtime, Node24.0.0/24.x/26.x | Тот же artifact без development dependencies, root/deep smoke |

Точные команды и action refs — [.github/workflows/main.yml](../.github/workflows/main.yml). TS5.7/TS7 и native/Undici families — разные оси. Dev alias undici8@8.12.2 нужен только matching native dispatcher в Node26 tests; explicit Undici7.3 family сохраняется. Не заменяйте transport cast-ом, не отключайте assert ради green и не повышайте budgets без доказанного основания.

## Границы безопасного запуска

Не исполняйте и не импортируйте samples, stress, launchers или workers ради документации/обычной проверки, даже в opt-out режиме. Test runner сам запускает назначенные finite offline/loopback fixtures; это не разрешение запускать произвольный файл samples/stress. `test:live` и работа с аккаунтами требуют отдельного явного поручения.

Не читайте/копируйте/хешируйте `.env` и `.env.*`, включая example, и не обходите `.explain`. Для поиска используйте rg/fd в проекте с исключениями до traversal. Не выводите окружение, credentials или HTTP debug headers. Version/changelog/tag/push/publish/release и внешние CI actions выполняются только в разрешённом задании. `.agents`, `.vscode`, `.plans`, `.explain`, `.reports`, `__temp`, build и coverage — локальное состояние и не force-add-ятся в Git.
