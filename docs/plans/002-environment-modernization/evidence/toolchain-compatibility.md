# T10: совместимость инструментов

Проверено 2026-10-30 на Linux x64. Разделы T10 ниже сохраняют исторический результат исследования до решений владельца. Текущее состояние: runtime >=24 принят в T15, потеря оставшихся Node/dependency проверок явно принята владельцем в [run/decisions.md](../run/decisions.md), T50 внедрил один type-aware oxlint и TS7. Зелёные package/runtime tests не являются полным эквивалентом прежних статических Node-проверок. Итог T50 и пределы запрета process.exit приведены в конце документа.

## Решение U1–U3

- **U1 — совместимость compiler/type-aware инструментов подтверждена в исследованной области.** Node 24.22.2, pnpm 12.16.1, TS 7.0.2, @types/node 22.20.5, oxlint 1.90.0 + oxlint-tsgolint 7.0.2005 установлены локально. Compiler обрабатывает 9 файлов src/test/samples; strict=true, skipLibCheck=false, NodeNext, target ES2022. На pinned Node компиляция exit 0, все 13 offline tests выполнены без skip. Форматтер и knip запускаются и выдают реальные диагностики; их настройка остаётся T60/T70. Полный будущий pnpm lock и check ещё не созданы.
- **U2 — полная замена ESLint не подтверждена, зависимую миграцию остановить.** Из 148 включённых правил 128 имеют одноимённый порт, 5 extension rules переходят в базовые, no-octal заменён диагностикой parser/TS1121, 14 Node-правил теряются. Существенная потеря n/no-unsupported-features/node-builtins подтверждена контрольным fs.globSync: ESLint exit 1, oxlint exit 0 при 1 реально проверенном файле. @types/node 22 не ограничивает API ранним Node 18; runtime smoke проверяет исполненные ветви и не эквивалентен статическому guard. Рекомендация владельцу: разрешить узкий дополнительный ESLint guard для runtime/Node-правил с отдельной совместимой TS 5.7.3 parser-средой; альтернатива — явно принять потерю этих проверок. Первая альтернатива сохраняет проверки, но отступает от одного pipeline [ALT, SURFACE]; вторая ослабляет принятый критерий. Ни одна не реализована и не принята молча. Решение меняет план, его принимает владелец до T20.
- **U3 — зеркальная замена type-only импорта допустима.** undici 7.3.0 и undici-types 7.3.0 имеют побайтово одинаковый fetch.d.ts. Старый и зеркальный контракты принимают FetchPlanner/wrapFetch, Request, RequestInit, Promise<Response> на TS 5.7.3 и 7.0.2; отрицательные method:number и transport:Promise<number> отвергнуты через @ts-expect-error без TS2578. Native fetch уже несовместим: DOM Request.bytes, без DOM FormData/File. Нового требования менять API не обнаружено; починка native fetch остаётся этапу 3, публикация этим исследованием не разрешается.

## Версии, engines и peers

Первичный источник каждой строки — точный version endpoint публичного npm registry. «Нет» означает, что поле не объявлено, а не обещание поддержки всех Node. Peers перечислены полностью; все peers oxlint/oxfmt/c8 optional по peerDependenciesMeta.

| Пакет | Точная версия | engines | peerDependencies |
| --- | --- | --- | --- |
| [node](https://registry.npmjs.org/node/24.22.2) | 24.22.2 | npm >=5.0.0 | нет |
| [pnpm](https://registry.npmjs.org/pnpm/12.16.1) | 12.16.1 | node >=18 | нет |
| [typescript](https://registry.npmjs.org/typescript/7.0.2) | 7.0.2 | node >=16.20.0 | нет |
| [@types/node](https://registry.npmjs.org/%40types%2Fnode/22.20.5) | 22.20.5 | нет | нет |
| [oxlint](https://registry.npmjs.org/oxlint/1.90.0) | 1.90.0 | node ^20.19.0 || >=22.12.0 | vite-plus *; oxlint-tsgolint >=7.0.2005 |
| [oxlint-tsgolint](https://registry.npmjs.org/oxlint-tsgolint/7.0.2005) | 7.0.2005 | нет | нет |
| [oxfmt](https://registry.npmjs.org/oxfmt/0.75.0) | 0.75.0 | node ^20.19.0 || >=22.12.0 | svelte ^5.0.0; vite-plus *; @astrojs/compiler-rs ^0.5.0 |
| [knip](https://registry.npmjs.org/knip/6.44.0) | 6.44.0 | node ^20.19.0 || >=22.12.0 | нет |
| [c8](https://registry.npmjs.org/c8/12.0.0) | 12.0.0 | node ^20.19.0 || ^22.12.0 || >=23 | monocart-coverage-reports ^2 |
| [np](https://registry.npmjs.org/np/12.1.1) | 12.1.1 | bun >=1; git >=2.11.0; npm >=10; node >=22; pnpm >=11; yarn >=1.7.0 | нет |
| [undici](https://registry.npmjs.org/undici/7.3.0) | 7.3.0 | node >=20.18.1 | нет |
| [undici-types](https://registry.npmjs.org/undici-types/7.3.0) | 7.3.0 | нет | нет |

Типы Node 22.20.5 дополнительно устанавливают собственный undici-types ~6.21.0; этот экземпляр сосуществует с прямым 7.3.0. Повышение версии dev-only undici не требуется. Не выбранные для обновления прямые devDependencies в конечном прототипе закреплены на фактически установленные исходные версии; начальная свободная установка обновила несколько из них, затем была заменена установкой с сохранением версий и повторной проверкой. Это не основание массово обновлять граф T20: сначала pnpm import текущего lock.

Первая установка с сохранённым typescript-eslint отказала ERESOLVE (peer TypeScript <6.1.0); force/legacy-peer-deps не применялись. Из целевого прототипа удалены старые eslint/@eslint/js/typescript-eslint/eslint-plugin-n/prettier, как предусматривает план замены. Общая установка exit 0; node/pnpm native installers выполнены штатным локальным npm rebuild. Глобальные инструменты не менялись. c8 --version в контексте прототипа напечатал версию корневого manifest 3.2.0; установленная версия подтверждена package.json/lock как 12.0.0, а работа — реальным offline coverage запуском. np запускался только с --version, выпуск не запускался.

## Baseline и состояние требований до миграции

До изменения даже исследовательских документов выполнены eslint --no-fix, отдельный tsc emit и явный offline entrypoint без dotenv. ESLint: exit 0, 0 errors, 2 warnings @typescript-eslint/no-unnecessary-condition в samples/wait-for-request-slot-1.ts:105:15 и :130:31. Compiler TS 5.7.3: exit 0. Unit: exit 0, tests=13, pass=13, fail=0, skipped=0; test/index.test.ts вызывает MockAgent.disableNetConnect(). Stress entrypoint не запускался.

Baseline emit для сравнения T30 сохранён в __temp/environment-compat/baseline-emit, включая JS/declarations/maps src/test/samples. SHA256 src/index.ts: 64955f53f496e347d4dbe3271876a7b7a976dcf6f70d5e4635ff79e9b65672e1. Существующая незавершённая errorLimits оставлена без правок. Проверка процессов по cwd и cmdline не обнаружила исполнителей build этого проекта; обнаружены два browser MCP процесса, не использующие build. Общий build всё равно не использовался и не очищался. Baseline и regression output раздельны.

Инвентаризация criteria-before.json даёт exit 1 для каждого ещё отсутствующего требования: packageManager pin, отдельный production include, test config, offline default coverage, live guard, прямая undici-types, prepack, oxlint/oxfmt/knip config. Эти проверки являются проверками конфигурации, не запуском опасных прежних npm scripts. Уже выполненные ESM и engines >=18 дают exit 0. Отсутствие файла/команды не обозначалось успехом. Полные A1–A10 относятся к последующим задачам, T10 их не объявляет выполненными.

## CLI и диагностические результаты

| Проба | Exit | Наблюдение |
| --- | --- | --- |
| Baseline eslint / TS5 emit / offline | 0 / 0 / 0 | 9 файлов; два прежних предупреждения; 13 pass, 0 skipped |
| TS7 --listFiles с новым сохранённым графом | 0 | Все 9 исходных файлов присутствуют в списке, не только declarations dependencies |
| Oxlint до переноса extension rules | 0 | 9 файлов, 128 правил, 0 errors / 2 прежних warnings |
| Oxlint конечный прототип | 0 | 9 файлов, 133 правила, 0 errors / 2 прежних warnings |
| Контроль promise/unsafe | 1 | no-floating-promises, no-misused-promises, await-thenable, no-unsafe-assignment/call/member-access/argument; отдельный no-unsafe-return также exit 1 |
| Контроль safe node:test | 1 общий probe | test('allowed known call') не имеет floating diagnostic; общий probe падает на реальных нарушениях; allowlist не отключает правило для тестов |
| Контроль octal | TS7 1 | TS1121; устаревший octal отвергается parser/compiler |
| Node API guard: прежний / новый | 1 / 0 | fs.globSync: старый n/no-unsupported-features/node-builtins срабатывает, oxlint не находит нарушения |
| Старый undici consumer TS5 / TS7 | 0 / 0 | Request/init/Response, FetchPlanner/wrapFetch и отрицательные cases |
| Зеркальный consumer TS5 / TS7 | 0 / 0 | Те же assertions с undici-types |
| Consumer с заблокированными undici exports TS5 / TS7 | 0 / 0 | Публичные typeof FetchPlanner/wrapFetch доступны через undici-types |
| Старый импорт в том же заблокированном consumer TS5 / TS7 | 2 / 1 | TS2305 по четырём импортируемым типам, контроль действительно падает |
| Native DOM consumer TS5 / TS7 | 2 / 1 | TS2345, Request.bytes; это ожидаемая диагностика известного дефекта, не успешный consumer |
| Native ES2022 consumer TS5 / TS7 | 2 / 1 | TS2345, FormData/File; не успешный consumer |
| Oxfmt --check src/index.ts | 1 | Один реальный файл с отличиями формата; не готовый format:check |
| Knip с явными entry/project | 1 | Обнаружены зависимости tooling без scripts и отсутствующие publish paths; это прототип без будущих scripts/build, не готовый knip |
| c8 с явным offline entrypoint | 0 | 13 tests pass, положительное покрытие исходного index.ts; финальная нормализация к src остаётся T40 |
| Регрессия прежними eslint / TS5 / offline | 0 / 0 / 0 | Прежние 2 warnings, 13 pass, 0 skipped, hash src совпал |

Директории внутри игнорируемого __temp дают oxlint «No files found» и exit 1 даже с --no-ignore; --rules/--print-config в этих попытках также не дали ожидаемого inventory. Это провалы выбора входов, не зелёные проверки. Исправлено передачей явных 9 путей; number_of_files проверяется в JSON. Инвентаризация поддержанных правил взята из поставляемого configuration_schema.json (definitions.DummyRuleMap.properties), а исполнимость конфигурации проверена CLI и контрольными нарушениями.

Consumer без undici в T10 моделируется локальным пакетом undici с пустыми exports/types: это перекрывает доступ к undici родительского репозитория. Без такого барьера ancestor resolution скрывал отсутствие зависимости. Исходная попытка импортировала непубличный Fetch и получила TS2459; fixture исправлен на публичные typeof exports, результаты перепроверены. TS2305 контролирует закрытые exports, а не буквально отсутствующий пакет TS2307. Настоящий consumer вне дерева, без undici/devDependencies, и TS2307 контроль остаются обязательными T80; здесь независимый tarball consumer не заявляется.

## Сопоставление всех активных правил

«Сохранено» означает наличие порта и принятие конфигурации CLI; полное семантическое тождество всех правил не заявляется. Значимые promise/unsafe правила дополнительно проверены нарушениями. Сохраняются прежние уровни: floating/ban-ts-comment/unnecessary-condition/unsafe-argument/assignment/call — warn, остальные согласно исходному resolved config. По no-unsafe-member-access и no-unsafe-return ошибки не ослаблялись. restrict-template-expressions остаётся прежним off и не входит в 148 активных правил.

| Старое правило | Целевая проверка | Статус |
| --- | --- | --- |
| for-direction | for-direction | сохранено |
| no-async-promise-executor | no-async-promise-executor | сохранено |
| no-case-declarations | no-case-declarations | сохранено |
| no-compare-neg-zero | no-compare-neg-zero | сохранено |
| no-cond-assign | no-cond-assign | сохранено |
| no-constant-binary-expression | no-constant-binary-expression | сохранено |
| no-constant-condition | no-constant-condition | сохранено |
| no-control-regex | no-control-regex | сохранено |
| no-debugger | no-debugger | сохранено |
| no-delete-var | no-delete-var | сохранено |
| no-dupe-else-if | no-dupe-else-if | сохранено |
| no-duplicate-case | no-duplicate-case | сохранено |
| no-empty | no-empty | сохранено |
| no-empty-character-class | no-empty-character-class | сохранено |
| no-empty-pattern | no-empty-pattern | сохранено |
| no-empty-static-block | no-empty-static-block | сохранено |
| no-ex-assign | no-ex-assign | сохранено |
| no-extra-boolean-cast | no-extra-boolean-cast | сохранено |
| no-fallthrough | no-fallthrough | сохранено |
| no-global-assign | no-global-assign | сохранено |
| no-invalid-regexp | no-invalid-regexp | сохранено |
| no-irregular-whitespace | no-irregular-whitespace | сохранено |
| no-loss-of-precision | no-loss-of-precision | сохранено |
| no-misleading-character-class | no-misleading-character-class | сохранено |
| no-nonoctal-decimal-escape | no-nonoctal-decimal-escape | сохранено |
| no-octal | TS1121 / ESM parser | эквивалент |
| no-prototype-builtins | no-prototype-builtins | сохранено |
| no-regex-spaces | no-regex-spaces | сохранено |
| no-self-assign | no-self-assign | сохранено |
| no-shadow-restricted-names | no-shadow-restricted-names | сохранено |
| no-sparse-arrays | no-sparse-arrays | сохранено |
| no-unexpected-multiline | no-unexpected-multiline | сохранено |
| no-unsafe-finally | no-unsafe-finally | сохранено |
| no-unsafe-optional-chaining | no-unsafe-optional-chaining | сохранено |
| no-unused-labels | no-unused-labels | сохранено |
| no-unused-private-class-members | no-unused-private-class-members | сохранено |
| no-useless-backreference | no-useless-backreference | сохранено |
| no-useless-catch | no-useless-catch | сохранено |
| no-useless-escape | no-useless-escape | сохранено |
| no-with | no-with | сохранено |
| require-yield | require-yield | сохранено |
| use-isnan | use-isnan | сохранено |
| valid-typeof | valid-typeof | сохранено |
| n/no-deprecated-api | нет в oxlint 1.90.0 | потеря |
| n/no-extraneous-import | нет в oxlint 1.90.0 | потеря |
| n/no-extraneous-require | нет в oxlint 1.90.0 | потеря |
| n/no-exports-assign | node/no-exports-assign | сохранено |
| n/no-missing-import | нет в oxlint 1.90.0 | потеря |
| n/no-missing-require | нет в oxlint 1.90.0 | потеря |
| n/no-process-exit | нет в oxlint 1.90.0 | потеря |
| n/no-unpublished-bin | нет в oxlint 1.90.0 | потеря |
| n/no-unpublished-import | нет в oxlint 1.90.0 | потеря |
| n/no-unpublished-require | нет в oxlint 1.90.0 | потеря |
| n/no-unsupported-features/es-builtins | нет в oxlint 1.90.0 | потеря |
| n/no-unsupported-features/es-syntax | нет в oxlint 1.90.0 | потеря |
| n/no-unsupported-features/node-builtins | нет в oxlint 1.90.0 | потеря |
| n/process-exit-as-throw | нет в oxlint 1.90.0 | потеря |
| n/hashbang | нет в oxlint 1.90.0 | потеря |
| no-var | no-var | сохранено |
| prefer-const | prefer-const | сохранено |
| prefer-rest-params | prefer-rest-params | сохранено |
| prefer-spread | prefer-spread | сохранено |
| @typescript-eslint/await-thenable | typescript/await-thenable | сохранено |
| @typescript-eslint/ban-ts-comment | typescript/ban-ts-comment | сохранено |
| @typescript-eslint/no-array-constructor | no-array-constructor | эквивалент |
| @typescript-eslint/no-array-delete | typescript/no-array-delete | сохранено |
| @typescript-eslint/no-base-to-string | typescript/no-base-to-string | сохранено |
| @typescript-eslint/no-confusing-void-expression | typescript/no-confusing-void-expression | сохранено |
| @typescript-eslint/no-deprecated | typescript/no-deprecated | сохранено |
| @typescript-eslint/no-duplicate-enum-values | typescript/no-duplicate-enum-values | сохранено |
| @typescript-eslint/no-duplicate-type-constituents | typescript/no-duplicate-type-constituents | сохранено |
| @typescript-eslint/no-dynamic-delete | typescript/no-dynamic-delete | сохранено |
| @typescript-eslint/no-empty-object-type | typescript/no-empty-object-type | сохранено |
| @typescript-eslint/no-explicit-any | typescript/no-explicit-any | сохранено |
| @typescript-eslint/no-extra-non-null-assertion | typescript/no-extra-non-null-assertion | сохранено |
| @typescript-eslint/no-extraneous-class | typescript/no-extraneous-class | сохранено |
| @typescript-eslint/no-floating-promises | typescript/no-floating-promises | сохранено |
| @typescript-eslint/no-for-in-array | typescript/no-for-in-array | сохранено |
| @typescript-eslint/no-implied-eval | typescript/no-implied-eval | сохранено |
| @typescript-eslint/no-invalid-void-type | typescript/no-invalid-void-type | сохранено |
| @typescript-eslint/no-meaningless-void-operator | typescript/no-meaningless-void-operator | сохранено |
| @typescript-eslint/no-misused-new | typescript/no-misused-new | сохранено |
| @typescript-eslint/no-misused-promises | typescript/no-misused-promises | сохранено |
| @typescript-eslint/no-misused-spread | typescript/no-misused-spread | сохранено |
| @typescript-eslint/no-mixed-enums | typescript/no-mixed-enums | сохранено |
| @typescript-eslint/no-namespace | typescript/no-namespace | сохранено |
| @typescript-eslint/no-non-null-asserted-nullish-coalescing | typescript/no-non-null-asserted-nullish-coalescing | сохранено |
| @typescript-eslint/no-non-null-asserted-optional-chain | typescript/no-non-null-asserted-optional-chain | сохранено |
| @typescript-eslint/no-non-null-assertion | typescript/no-non-null-assertion | сохранено |
| @typescript-eslint/no-redundant-type-constituents | typescript/no-redundant-type-constituents | сохранено |
| @typescript-eslint/no-require-imports | typescript/no-require-imports | сохранено |
| @typescript-eslint/no-this-alias | typescript/no-this-alias | сохранено |
| @typescript-eslint/no-unnecessary-boolean-literal-compare | typescript/no-unnecessary-boolean-literal-compare | сохранено |
| @typescript-eslint/no-unnecessary-condition | typescript/no-unnecessary-condition | сохранено |
| @typescript-eslint/no-unnecessary-template-expression | typescript/no-unnecessary-template-expression | сохранено |
| @typescript-eslint/no-unnecessary-type-arguments | typescript/no-unnecessary-type-arguments | сохранено |
| @typescript-eslint/no-unnecessary-type-assertion | typescript/no-unnecessary-type-assertion | сохранено |
| @typescript-eslint/no-unnecessary-type-constraint | typescript/no-unnecessary-type-constraint | сохранено |
| @typescript-eslint/no-unnecessary-type-parameters | typescript/no-unnecessary-type-parameters | сохранено |
| @typescript-eslint/no-unsafe-argument | typescript/no-unsafe-argument | сохранено |
| @typescript-eslint/no-unsafe-assignment | typescript/no-unsafe-assignment | сохранено |
| @typescript-eslint/no-unsafe-call | typescript/no-unsafe-call | сохранено |
| @typescript-eslint/no-unsafe-declaration-merging | typescript/no-unsafe-declaration-merging | сохранено |
| @typescript-eslint/no-unsafe-enum-comparison | typescript/no-unsafe-enum-comparison | сохранено |
| @typescript-eslint/no-unsafe-function-type | typescript/no-unsafe-function-type | сохранено |
| @typescript-eslint/no-unsafe-member-access | typescript/no-unsafe-member-access | сохранено |
| @typescript-eslint/no-unsafe-return | typescript/no-unsafe-return | сохранено |
| @typescript-eslint/no-unsafe-unary-minus | typescript/no-unsafe-unary-minus | сохранено |
| @typescript-eslint/no-unused-expressions | no-unused-expressions | эквивалент |
| @typescript-eslint/no-unused-vars | no-unused-vars | эквивалент |
| @typescript-eslint/no-useless-constructor | no-useless-constructor | эквивалент |
| @typescript-eslint/no-wrapper-object-types | typescript/no-wrapper-object-types | сохранено |
| @typescript-eslint/only-throw-error | typescript/only-throw-error | сохранено |
| @typescript-eslint/prefer-as-const | typescript/prefer-as-const | сохранено |
| @typescript-eslint/prefer-literal-enum-member | typescript/prefer-literal-enum-member | сохранено |
| @typescript-eslint/prefer-namespace-keyword | typescript/prefer-namespace-keyword | сохранено |
| @typescript-eslint/prefer-promise-reject-errors | typescript/prefer-promise-reject-errors | сохранено |
| @typescript-eslint/prefer-reduce-type-parameter | typescript/prefer-reduce-type-parameter | сохранено |
| @typescript-eslint/prefer-return-this-type | typescript/prefer-return-this-type | сохранено |
| @typescript-eslint/related-getter-setter-pairs | typescript/related-getter-setter-pairs | сохранено |
| @typescript-eslint/require-await | typescript/require-await | сохранено |
| @typescript-eslint/restrict-plus-operands | typescript/restrict-plus-operands | сохранено |
| @typescript-eslint/return-await | typescript/return-await | сохранено |
| @typescript-eslint/triple-slash-reference | typescript/triple-slash-reference | сохранено |
| @typescript-eslint/unbound-method | typescript/unbound-method | сохранено |
| @typescript-eslint/unified-signatures | typescript/unified-signatures | сохранено |
| @typescript-eslint/use-unknown-in-catch-callback-variable | typescript/use-unknown-in-catch-callback-variable | сохранено |
| @typescript-eslint/adjacent-overload-signatures | typescript/adjacent-overload-signatures | сохранено |
| @typescript-eslint/array-type | typescript/array-type | сохранено |
| @typescript-eslint/ban-tslint-comment | typescript/ban-tslint-comment | сохранено |
| @typescript-eslint/class-literal-property-style | typescript/class-literal-property-style | сохранено |
| @typescript-eslint/consistent-generic-constructors | typescript/consistent-generic-constructors | сохранено |
| @typescript-eslint/consistent-indexed-object-style | typescript/consistent-indexed-object-style | сохранено |
| @typescript-eslint/consistent-type-assertions | typescript/consistent-type-assertions | сохранено |
| @typescript-eslint/consistent-type-definitions | typescript/consistent-type-definitions | сохранено |
| @typescript-eslint/dot-notation | typescript/dot-notation | сохранено |
| @typescript-eslint/no-confusing-non-null-assertion | typescript/no-confusing-non-null-assertion | сохранено |
| @typescript-eslint/no-empty-function | no-empty-function | эквивалент |
| @typescript-eslint/no-inferrable-types | typescript/no-inferrable-types | сохранено |
| @typescript-eslint/non-nullable-type-assertion-style | typescript/non-nullable-type-assertion-style | сохранено |
| @typescript-eslint/prefer-find | typescript/prefer-find | сохранено |
| @typescript-eslint/prefer-for-of | typescript/prefer-for-of | сохранено |
| @typescript-eslint/prefer-function-type | typescript/prefer-function-type | сохранено |
| @typescript-eslint/prefer-includes | typescript/prefer-includes | сохранено |
| @typescript-eslint/prefer-nullish-coalescing | typescript/prefer-nullish-coalescing | сохранено |
| @typescript-eslint/prefer-optional-chain | typescript/prefer-optional-chain | сохранено |
| @typescript-eslint/prefer-regexp-exec | typescript/prefer-regexp-exec | сохранено |
| @typescript-eslint/prefer-string-starts-ends-with | typescript/prefer-string-starts-ends-with | сохранено |

Для no-missing/extraneous imports TypeScript ловит часть ошибок, но не правила публикации dependencies и не все require-пути; это частичное пересечение, потери намеренно не переклассифицированы в полный эквивалент. Для deprecated API есть другие проверки, но они не доказывают равенство n/no-deprecated-api. Потеря Node runtime guard существенна и требует выбора до удаления ESLint [VERIFY, FRAGILE].

## Существующие подавления

| Место | Что сохраняется / требует внимания T50 |
| --- | --- |
| src/index.ts:1 | File-level no-var для существующего debug; не расширять |
| src/index.ts:4 | n/no-unpublished-import на dev-only undici; после T80 прямой type dependency повод снять именно эту директиву |
| src/index.ts:20 | @typescript-eslint/no-empty-function; переносится к базовому no-empty-function, существующий пустой debug intentional |
| test/index.test.ts:1 | no-non-null-assertion в исходных assertions; сохранить область |
| test/index.test.ts:2 | Node builtins suppression для современных node:test APIs; src runtime и dev/test версии различаются |
| test/stress.worker.ts:146 | no-unnecessary-condition на существующей защите; оставить точечным |
| samples/demo.ts:1–2 | Полные eslint-disable и @ts-nocheck существовали до работы; sample присутствует во входах, но тело не получает полноценных lint/type гарантий |

allowForKnownSafeCalls перенесён из старого config: node:test test/it/skip/only и uint8array-extras.stringToUint8Array. Контрольный необработанный Promise рядом с node:test всё равно диагностируется. Новые широкие отключения, any для прохождения проекта или skipLibCheck=true не вводились. any в негативных fixtures — сознательный источник диагностик и не часть кода библиотеки.

## Выбранные compiler options

Самодостаточный прототип tsconfig.json: target ES2022; module/moduleResolution NodeNext; lib ES2023; strict=true; skipLibCheck=false; noUncheckedIndexedAccess, noImplicitOverride, noImplicitReturns, noPropertyAccessFromIndexSignature, noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch=true; allowUnusedLabels/allowUnreachableCode=false; isolatedModules/esModuleInterop=true; exactOptionalPropertyTypes=false сохраняет прежнее явное исключение, а не новую уступку; rootDir='.', declaration/sourceMap=true. В итоговом T30 сохранить также checkJs=true из прежнего strictest (в текущей области только .ts), а не потерять его при отказе от extends. Типы node явные. Прототип собирает src/test/samples вместе ради исследования; разделение prod/test остаётся T30. Runtime target и API не меняются.

## Воспроизведение

Все команды из корня репозитория; вывод только в __temp/environment-compat и личный /tmp/orchestrate-fetch-planner-002/T10-1. Каждая команда ограничена timeout, live никогда не запускается.

```sh
mkdir -p /tmp/orchestrate-fetch-planner-002/T10-1
# Исходная baseline, до миграции конфигов:
timeout 60 node_modules/.bin/eslint src test samples --no-fix --format json
timeout 60 node_modules/.bin/tsc -p tsconfig.prod.json --outDir __temp/environment-compat/baseline-emit --incremental false
timeout 60 node --test --enable-source-maps __temp/environment-compat/baseline-emit/test/index.test.js
sha256sum src/index.ts
# Сохранённый точный изолированный manifest/lock; никакой установки в корень:
timeout 180 npm ci --prefix __temp/environment-compat --ignore-scripts --no-audit --no-fund
timeout 120 npm rebuild --prefix __temp/environment-compat node pnpm
# Конечный прототип compiler/linter/offline/consumers:
timeout 180 python3 __temp/environment-compat/repro/verify-final.py
# Дополнительные отрицательные и диагностические пробы:
timeout 180 python3 __temp/environment-compat/repro/probes.py
timeout 180 python3 __temp/environment-compat/repro/types.py
timeout 120 python3 __temp/environment-compat/repro/more.py
timeout 180 python3 __temp/environment-compat/repro/final-probes.py
```

Последние скрипты собирают также ожидаемые ненулевые диагностики; их общий exit 0 не является утверждением, что все consumer/lint команды прошли. У каждой команды сохранены собственные exit/output в logs и runs.jsonl. Для конечного состояния после полного воспроизведения ещё раз выполнить more.py (восстанавливает исправленный no-undici fixture) и verify-final.py. Скрипт run.py — библиотека записи результатов; его первоначальный CLI-прогон прервался на штатном shebang-less pnpm до локального npm rebuild и не считается итоговым gate.

Прототипы/lock/логи игнорируются git и сохраняются для T20/T30, а не включаются в пакет; это локальное доказательство, не новый production pipeline. Для новой машины надо перенести эту папку прототипа или воссоздать её по зафиксированным manifest/config/fixtures. Это не готовая установка root checkout и не замена будущему test:package.

## Первичные документы

Проверены [type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html), [директивы](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html), [реестр правил](https://oxc.rs/docs/guide/usage/linter/rules.html), [no-floating-promises](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises.html), [NodeNext resolution](https://www.typescriptlang.org/tsconfig/moduleResolution.html), а также точные registry endpoints в таблице версий. Документация подтверждает отдельный tsgolint и поддержку ESLint-директив; реальные поддержанные правила и результат проверены установленным CLI. Несуществующий URL node/no-unsupported-features не использован как доказательство отсутствия: основание — schema и контроль CLI.

МойСклад API не вызывался; профильных предположений о нём не делалось. Для общих TypeScript/npm/oxlint операций применимого навыка в каталоге нет. Чужой репозиторий импортёра использован только как read-only пример конфигурации. Внешние действия ограничились скачиванием публичных npm/Node инструментов и первичной документации; никаких записей в аккаунты, push/tag/publish или изменения глобальных CLI.

## T50: внедрение принятого варианта

В корне включены TypeScript 7.0.2, oxlint 1.90.0 и oxlint-tsgolint 7.0.2005. Проверки выполнены на Node 24.22.2 и pnpm 12.16.1; shell Node 24.16.0 не использован для регрессии. `pnpm lint` немутирующий, `pnpm lint:fix` отдельно включает `--fix`. Анализируются 10 файлов src/test/samples/scripts, generated/build/coverage/evidence исключены. Конфигурация явно задаёт 134 правила, включая tsgolint и запрет `process.exit`. Прототип T10 использован вместо выбора нового набора preset [CONSIST]; второй ESLint guard не введён согласно решению владельца [ALT, SURFACE].

Все 148 строк таблицы T10 сверены с исходным resolved ESLint config: 133 целевых порта/эквивалента сохранены вместе с options; no-octal остаётся parser/compiler-проверкой; прежние 14 Node-правил имеют принятые ограничения из T15. Для `typescript/no-floating-promises`, `typescript/no-unsafe-argument`, `typescript/no-unsafe-assignment`, `typescript/no-unsafe-call` прежний warn повышен до error: отдельное нарушение теперь останавливает lint. `ban-ts-comment` и `no-unnecessary-condition` остаются warn; остальные уровни не ослаблены. Ровно два исходных предупреждения samples/wait-for-request-slot-1.ts:105,130 сохранены без подавления и изменения алгоритма. Включено сообщение о неиспользуемых disable-директивах; новых предупреждений нет.

В независимой копии вне репозитория отдельно для src и test проверены необработанный Promise, async callback в forEach, await числа, unsafe call/assignment/member-access/argument/return и process.exit: каждая проба exit 1 с ожидаемым правилом. После удаления проб lint exit 0 с прежними двумя warnings. Отдельные необработанные Promise в scripts/*.mjs и samples/*.ts также дают no-floating-promises, то есть область не ограничена перечислением файлов. Конкретные node:test test/it/skip/only разрешены прежним allowForKnownSafeCalls; соседний Promise всё равно диагностируется. Запрет Promise как синтаксической конструкции вместо type-aware проверки не используется.

`no-restricted-properties` обнаруживает `process.exit(1)`, `process['exit'](1)` и `const { exit } = process`. Вызов через объектный алиас `const alias = process; alias.exit(1)` не обнаруживается этим правилом (отдельная проба exit 0). Это синтаксический запрет с измеренным пределом, не полный эквивалент анализа алиасов и не универсальная гарантия отсутствия завершения процесса. Остальные потери dependency/Node-проверок из T15 приняты владельцем; обязательные tarball/type/runtime gates T80/T90 ещё предстоит внедрить и выполнить. Они проверят собственные сценарии, а не восстановят весь прежний static guard.

Узкие существующие directives переведены в oxlint-имена без расширения области. Удалена несуществующая в новом линтере n/no-unpublished-import директива; underlying type-only импорт undici остаётся прежним до T80. Новых подавлений false positive/дефектов не понадобилось. Исходная file-level no-var и no-non-null-assertion области сохранены. Существующий samples/demo.ts по-прежнему имеет полное lint-disable и @ts-nocheck; его наличие во входах не означает полноценных гарантий для тела. Для scripts/check-coverage.mjs добавлен только `/// <reference types="node" />`: standalone JS-программа tsgolint иначе не разрешала Node globals/imports и давала error-typed unsafe diagnostics. Явное подключение типов устраняет причину без suppressions и изменения выполнения [ROOT, EXPLICIT].

ESLint, @eslint/js, eslint-plugin-n, typescript-eslint и их parser/plugins полностью отсутствуют в dependency graph и lock: проверены `pnpm why eslint --depth 1000`, `pnpm list eslint @eslint/js eslint-plugin-n typescript-eslint @typescript-eslint/parser --depth 1000 --json` и текст lock. Пакетных additions только 21: TS7 и его platform binaries; удалены 82 старых compiler/ESLint пакета. Unrelated direct pins сохранены. Строгий frozen install в корне и свежей внешней копии без node_modules прошёл без force/legacy-peer-deps и изменения lock. Prettier и его конфигурация оставлены T60; knip/check/package consumers остаются T70/T80.

На закреплённом окружении прошли typecheck, build, build:test, test и coverage; test и coverage исполнили 13 tests / 13 pass / 0 skipped. LCOV проверен штатным coverage:check: исходный src/index.ts, исполненные строки/функции/wrapFetch, без test/samples. Сравнение src с сохранённой исходной копией подтверждает только изменения directives, включая сохранность чужой errorLimits. Немутирующий lint проверен сравнением SHA256 входов. Полные команды, коды, пути логов, контрольные диагностики и промежуточные ошибки harness — в [журнале T50](../run/journal/T50.md).
