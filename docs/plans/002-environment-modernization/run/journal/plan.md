# План 002 — сквозная приёмка V11

ИТОГ: passed

ПРОВЕРЕНО: локальная цель окружения достигнута: свежая strict/frozen установка, немутирующие check/coverage, самодостаточный актуальный tarball, типовые consumers, D1 и локальная runtime matrix прошли.

ОТЧЁТ: docs/plans/002-environment-modernization/run/journal/plan.md

НЕ ЗАКРЫТО: нет в принятом объёме локальной миграции. Настоящий Actions run обязателен до будущего выпуска и не входит в разрешённые действия сейчас.

ПОБОЧНОЕ: нет.

ЗАМЕЧАНИЯ: D01–D10/D12, native fetch, незавершённая errorLimits, jitter flake, lint-долги и документация лимитов остаются следующим этапам; они не были целью исправления окружения.

## Основание вердикта

T100 отдельно принят в T100.accept-1.md на этом же независимом прогоне. Изменения критериев из брифа применены явно: engines.node >=24, Node 24.22.2/pnpm 12.16.1, runtime 24.0.0/24.x/26.x, unit26; один oxlint без обещания полного alias/dependency/Node guard; TS7 и oxfmt; отсутствие разрешённого push/Actions run не блокирует завершение локальной миграции. Устаревшие предложения >=18 и Node18/20/22 в исходном плане не использованы как текущий контракт.

Дата: 2026-10-30. Независимая поведенческая приёмка V11, отдельный контекст той же модели GPT; проверки другим семейством не было. Прочитаны бриф T100-final-verifier и определение роли plan-verifier целиком, контекст/план/ревью 002, README, текущие конфигурации и scripts. Чужие *.accept-*.md, run/tasks.md, STATUS.md и decisions.md не читались. Журналы исполнителей использованы только для поиска исходных baseline/CLI, результаты воспроизведены самостоятельно. Рабочий проект read-only, кроме двух обязательных отчётов. Субагенты не запускались.

Создана новая allowlist-копия вне репозитория без node_modules/build/coverage и секретов. Копировались только src/test/samples/scripts, .github/workflows, .vscode и 15 именованных файлов конфигурации/README/LICENSE/manifest/lock/changelog. Файлы .env/.env.*, включая example, исключены по имени до открытия; они не читались, не копировались и не хешировались. Дочерним командам передавалось заново собранное окружение без унаследованных токенов, DEBUG, live opt-in и NODE_PATH; HOME и npm configs пустые и отдельные. Результирующий PATH содержит новые точные Node/pnpm, отдельный доступ к исходному npm и системные утилиты; глобальный np перед установкой зависимостей недоступен.

Установка инструментов повторяет npm --prefix из README с actual pins; вместо произвольного mktemp использован собственный именованный временный каталог. Рабочие версии: Node v24.22.2, pnpm 12.16.1, npm 11.13.0. Затем pnpm install --frozen-lockfile --strict-peer-dependencies. Последовательно один раз выполнены pnpm check, pnpm coverage, pnpm test:package, с остановкой при первом провале — эквивалент документированной цепочки &&. Для check/coverage registry и все proxy направлены на закрытый localhost:9, npm offline=true; package gate использует только разрешённые registry установки. Реальный API/opt-in live/публикация не запускались. Каждая потенциально долгая команда ограничена timeout 290s, kill-after=5s, внешний watchdog 298s; зависаний и timeout не было.

При настройке испытательного harness были ошибки до основных проверок: вызван отсутствующий alias python вместо установленного python3; первый собственный PATH не содержал npm (bootstrap exit 127), а два варианта проверки PATH обнаружили доступный np и сами завершились exit 1. Уточнены только собственный harness/PATH, README и код не менялись. После этого documented bootstrap exit 0 и финальная проверка отсутствия глобального np exit 0. Это ошибки методики подготовки, не провалы проверяемого продукта и не ретраи jitter.

## A1–A10

| Критерий | Вердикт | Независимое доказательство |
| --- | --- | --- |
| A1 | passed | Новая копия, документированный npm bootstrap, node v24.22.2/pnpm12.16.1; frozen strict install exit0, check exit0; pnpm-lock.yaml отслеживается, package-lock отсутствует; глобальный np недоступен |
| A2 | passed | 32 точных allowlist SHA256 совпадают до/после install/check/coverage/package в копии и оригинале; после мутаций восстановлены. Check не содержит fix. Исходное дерево не является чистым checkout, git diff --exit-code для него не подменял хеши |
| A3 | passed | Check/coverage по 13 pass, 0 fail/skip; LCOV только original src/index.ts, LH1016/LF1051, FNH29/FNF30, wrapFetch hits2; empty/zero/no-wrap/foreign отказы; command/direct import live guard exit1 до Piscina/worker/fetch |
| A4 | passed | Отсутствующий build → только index.js/index.d.ts/index.js.map в build/src; test emit отдельный; сломанный sample не мешает build, typecheck даёт TS1109; ES2022/NodeNext/strict/checkJs/skipLibCheck=false сохранены |
| A5 | passed с принятым ограничением guard | Type-aware lint реально анализирует14 files/134 rules. Проба даёт 7 нужных errors; форматтер ловит runtime fixture; Knip ловит недостижимый script и unused dependency. Прежние2 warnings/5 hints не новые дефекты. Полнота прежних Node/dependency guards не заявляется |
| A6 | passed | test:package проверил pnpm/npm pack absent/stale, побайтовую свежесть JS/declarations/maps/source и состав tarball, README/LICENSE; test/samples/coverage/docs/секреты не опубликованы |
| A7 | passed локально | Один workflow tarball с проверкой обоих checksum прошёл на24.0.0/24.22.2/26.13.0. Изолированный consumer без undici/dev graph; root/deep ESM, GET/POST, Response identity. main/types/files сохранены, exports отсутствует. Настоящий Actions transport ещё не проверен |
| A8 | passed | Bare и undici7.3.0 consumers, TS5.7.3/7.0.2, strict/skipLibCheck=false; точные негативные TS2307/2345/2322. D11 только dependency closure; native fetch остаётся блокером |
| A9 | passed локально | actionlint exit0; YAML/матрица/порядок/inputs exact-ref action.yml проверены; frozen installs, нет token/dotenv/live/publish/secrets/continue-on-error/Codecov. Реального GitHub runner/post/upload/download запуска не было |
| A10 | passed | README/editor/research соответствуют командам и ограничениям; версия3.2.0 и changelog сохранены. Следующие этапы/интеграция импортёра/выпуск не начаты |

## Команды и результаты

| Команда / проба | Exit | Последняя строка вывода | Результат |
| --- | --- | --- | --- |
| bootstrap | 0 | added 4 packages in 15s | passed; ожидаемый exit 0; 15.82 с |
| versions | 0 | 11.13.0 | passed; ожидаемый exit 0; 0.09 с |
| install | 0 | Done in 13.2s using pnpm v12.16.1 | passed; ожидаемый exit 0; 13.22 с |
| check | 0 | ℹ duration_ms 10229.947747 | passed; ожидаемый exit 0; 12.38 с |
| coverage | 0 | LCOV verified: original src/index.ts, executed lines/functions/wrapFetch, no test/samples | passed; ожидаемый exit 0; 11.54 с |
| test-package | 0 | A6–A8 passed. Native fetch type incompatibility remains for stage 3; no native type compatibility claimed. | passed; ожидаемый exit 0; 28.35 с |
| build | 0 | $ rm -rf build/ && tsc -p tsconfig.prod.json | passed; ожидаемый exit 0; 0.3 с |
| sample-build | 0 | $ rm -rf build/ && tsc -p tsconfig.prod.json | passed; ожидаемый exit 0; 0.24 с |
| sample-typecheck | 1 | [ELIFECYCLE] Command failed with exit code 1. | passed; ожидаемый exit 1; 0.11 с |
| live-command | 1 | [ELIFECYCLE] Command failed with exit code 1. | passed; ожидаемый exit 1; 0.31 с |
| live-import | 1 | Node.js v24.22.2 | passed; ожидаемый exit 1; 0.03 с |
| coverage-empty | 1 | Node.js v24.22.2 | passed; ожидаемый exit 1; 0.03 с |
| coverage-zero | 1 | Node.js v24.22.2 | passed; ожидаемый exit 1; 0.03 с |
| coverage-no-wrap | 1 | Node.js v24.22.2 | passed; ожидаемый exit 1; 0.03 с |
| coverage-foreign | 1 | Node.js v24.22.2 | passed; ожидаемый exit 1; 0.04 с |
| lint-mutation | 1 | [ELIFECYCLE] Command failed with exit code 1. | passed; ожидаемый exit 1; 0.31 с |
| format-mutation | 1 | [ELIFECYCLE] Command failed with exit code 1. | passed; ожидаемый exit 1; 0.1 с |
| knip-mutation | 1 | [ELIFECYCLE] Command failed with exit code 1. | passed; ожидаемый exit 1; 0.62 с |
| lint-restored | 0 | Finished in 203ms on 14 files with 134 rules using 4 threads. | passed; ожидаемый exit 0; 0.26 с |
| format-restored | 0 | Finished in 10ms on 23 files using 4 threads. | passed; ожидаемый exit 0; 0.09 с |
| knip-restored | 0 | scripts/check-package.mjs     knip.json  Remove redundant entry pattern | passed; ожидаемый exit 0; 0.55 с |
| editor-format | 0 | Finished in 4ms on 3 files using 4 threads. | passed; ожидаемый exit 0; 0.08 с |
| actionlint | 0 | (вывод пуст) | passed; ожидаемый exit 0; 0.03 с |
| d1-original | 0 | /tmp/orchestrate-fetch-planner-002/V11/d1-original/runtime-artifact/moysklad-fetch-planner-3.2.0.tgz | passed; ожидаемый exit 0; 0.28 с |
| d1-alias | 1 | /tmp/orchestrate-fetch-planner-002/V11/d1-alias/runtime-artifact/moysklad-fetch-planner-3.2.0.tgz | passed; ожидаемый exit 1; 0.27 с |
| runtime-floor | 0 | Runtime smoke: root/deep imports, GET/POST, original Response identity | passed; ожидаемый exit 0; 0.4 с |
| runtime-24 | 0 | Runtime smoke: root/deep imports, GET/POST, original Response identity | passed; ожидаемый exit 0; 0.39 с |
| runtime-26 | 0 | Runtime smoke: root/deep imports, GET/POST, original Response identity | passed; ожидаемый exit 0; 0.39 с |
| unit-26 | 0 | ℹ duration_ms 9957.399638 | passed; ожидаемый exit 0; 10.29 с |
| baseline-format-normalization | 0 | Finished in 16ms on 7 files using 4 threads. | passed; ожидаемый exit 0; 0.08 с |

Полная регрессия выполнена последовательно один раз на pinned Node. Две успешные команды check/coverage используют одни и те же 13 исходных тестов, без скрытых skips/ретраев; отдельный unit26 — обязательная строка CI matrix. Все неуспешные контрольные команды имеют ожидаемый exit1. Дополнительное форматирование baseline выполнялось только над собственными временными копиями и не является частью немутирующего check.

## Ответы Q1–Q9

1. **Q1 — подтверждено.** .github/workflows/main.yml:82–93, точный artifact block извлечён Ruby YAML parser, без переписывания shell-кода. Запуск bash --noprofile --norc -e -o pipefail: original exit0, namespace и обращения deep→deepAlias в своей копии exit1. При провале runtime.mjs имеет два root imports, не имеет deep import, SHA256SUMS не создан. Grep на строках90–91 самостоятельные, не защищены shell-условиями; checksum и upload идут позже. По умолчанию последующий Actions upload не получает успех failed step. Настоящий upload не делался.
2. **Q2 — подтверждено в Linux.** Bootstrap и frozen strict install воспроизведены; np отсутствовал в финальном PATH, пустые HOME/npm configs, без унаследованных credentials/.env. Хеши32 inputs неизменны. Editor JSON имеет ровно pnpm build/test и без envFile/live. README:422/470/474/478 прямо называет POSIX/Linux, непроверенные Windows/macOS/Actions и nativeFetch/release blockers. GUI VSCode не проверен и не обещан.
3. **Q3 — подтверждено.** Production/test include и outDir разделены, production чистится именованным build и не запускает lint/fix. Только три publish outputs. Sample syntax mutation → build0/typecheck1 TS1109. Сохранены strict, noUncheckedIndexedAccess/noImplicitOverride/noImplicitReturns/checkJs, skipLibCheck=false, ES2022. Сохранённый pre-plan source __temp/environment-compat/src/index.ts и baseline emit сравнивались с текущими source/JS/declaration после одинакового oxfmt и только разрешённых замен lint directives/type-only undici→undici-types; байты совпали. Изменений выражений/алгоритма нет.
4. **Q4 — подтверждено.** c8 исполняет __temp/test-build/src и remap в original src; не пустой/нулевой LCOV, wrapFetch hits2. Отдельно empty, all-zero, zero wrapFetch и foreign test record дают exit1. test:live и direct import без opt-in дают понятный отказ. Direct import дополнительно шёл под registerHooks, запрещающим разрешение piscina/stress.worker, и poison global fetch: ни один маркер запрещённого вызова не сработал. Настоящий live не запускался.
5. **Q5 — подтверждено в принятом объёме.** Явные package fixtures/scripts entrypoints и project globs присутствуют; Knip mutation обнаруживает scripts/v11-unreachable.mjs и v11-unused-dependency. Pnpm при временном рассогласовании manifest/lock также печатает preflight frozen-lockfile warning, но затем реальный Knip запускается и даёт оба точных собственных diagnostics; результат не засчитан только по общему exit. После восстановления Knip0. Typed lint mutation в src обнаружила no-floating-promises, no-misused-promises, await-thenable, unsafe-assignment/call/member-access и no-restricted-properties(process.exit), 7 errors. Форматная проба в runtime fixture даёт format:check1. Восстановленные lint/format/knip0; широких новых suppressions нет. Сопоставление rules есть в evidence/toolchain-compatibility.md, утрата остальных guards принята владельцем и явно описана в README:472.
6. **Q6 — подтверждено.** test:package самостоятельно исполнен, а не взят прежний вердикт. Все4 combinations pnpm/npm+absent/stale сравнивают JS/.d.ts/map с новой production build и source с исходным файлом; tarball-only consumers размещены вне repo и проверяют ancestors/NODE_PATH. Bare не содержит undici; второй явно ставит7.3.0. Каждый compiler strict/skipLibCheckfalse; подмена dev-only undici в declaration реально компилируется с ожидаемым единственным TS2307 (scripts/check-package.mjs:285–296), negative transport/init имеют ровно TS2345/TS2322. Runtime transport локальный, Response identity и deep/root равенство проверяются assertions, без fetch в сеть.
7. **Q7 — подтверждено локально.** Пин24.22.2/pnpm12.16.1/engines>=24 и setup-node node-version-file согласованы. Runtime matrix24.0.0/24.x/26.x, unit26. Exact-ref vendor action.yml snapshots из явно указанной области T90 машинно проверены для каждого with input; actionlint0. artifact tarball/fixture/checksum сгенерированы один раз для положительной матрицы, затем один и тот же exact runtime shell block выполнен на24.0.0/24.22.2/26.13.0 с package.tgz/runtime.mjs OK на каждой строке. Отдельно unit26 —13pass/0skip. Реальные Actions installation/post steps, runner и upload/download не утверждаются проверенными.
8. **Q8 — подтверждено.** HEAD не использовался как требование к source: git diff показывает прежнюю unfinished errorLimits, которую нельзя откатывать. Baseline source и emitted JS/declarations подтверждают только директивы/формат/type-only packaging в миграции, errorLimits сохранён. README:470–472 и исследование различают исправленный D11 dependency closure и нерешённый API конфликт nativeFetch. Символы Request.bytes/FormData/File и незавершённая защита остаются следующему этапу, её поведение не чинилось.
9. **Q9 — подтверждено.** Сверены реестр исследования001 D01–D10/D12, README:472 и финальная часть research002. Их не объявляют закрытыми: D01–D08/границыD10 идут в этап3, D09/новый replay при необходимости в4, судьбаD12 до выпуска. Два lint warnings воспроизведены в samples:105/130; jitter в этих прогонах прошёл, но threshold не менялся и успешный запуск не доказательство детерминизма. Документация лимитов/errorLimits не исправлена и явно передана долгом.

## Мутационные и краевые пробы

| Мутация только в собственной копии | Обнаружившая проверка | Наблюдение |
| --- | --- | --- |
| deep→deepAlias namespace и обращения | Точный artifact shell | exit1, checksum отсутствует; оба импорта root не дают ложного green |
| Syntax error sample | build + typecheck | build0, typecheck1 TS1109 |
| Empty/zero/no-wrap/foreign LCOV | check-coverage.mjs | Каждый exit1 с конкретным assertion |
| Floating/misused Promise, await number, JSON.parse unsafe, process.exit | Type-aware oxlint | 7errors по нужным правилам |
| Формат const calls=[]; в runtime fixture | format:check | exit1 с адресом fixture |
| Новый unreachable script + unused dependency | Knip | Оба точных diagnostics, exit1 |
| Pack build absent/stale, pnpm/npm | test:package | Все4 tarball актуальны |
| Declaration с from undici у bare consumer | TS5/TS7 внутри test:package | Ровно TS2307, не скрытый другой отказ |
| Invalid transport / init method | TS5/TS7 внутри test:package | Ровно TS2345/TS2322 |
| Live command/direct import без opt-in | Guard перед worker creation | exit1 Live stress is disabled; Piscina/fetch traps не вызваны |

## Сырой вывод

### Check, полный список тестов и итог

```text
$ pnpm run build:test && pnpm run test:unit
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
$ node --test --enable-source-maps __temp/test-build/test/index.test.js
✔ wrapFetch (simple) (13.207735ms)
✔ wrapFetch (with options) (6.918473ms)
✔ FetchPlanner (simple GET) (1.690428ms)
✔ FetchPlanner (event handler) (5749.586454ms)
✔ FetchPlanner (EventEmitter as event handler) (2.543242ms)
✔ FetchPlanner (simple POST) (5.326031ms)
✔ FetchPlanner (jitter) (89.477499ms)
✔ FetchPlanner (delay reduce) (2515.713374ms)
✔ FetchPlanner (POST with RateLimit) (3.868277ms)
✔ FetchPlanner (waitForRequestSlot) (379.590783ms)
✔ FetchPlanner (parallel limit and throttling) (2.849788ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (2.498132ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1016.874944ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10229.947747
```

### Coverage

```text
✔ FetchPlanner (jitter) (39.833086ms)
✔ FetchPlanner (delay reduce) (2512.335787ms)
✔ FetchPlanner (POST with RateLimit) (3.876339ms)
✔ FetchPlanner (waitForRequestSlot) (368.626451ms)
✔ FetchPlanner (parallel limit and throttling) (3.107438ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (2.974917ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1009.209856ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10300.631812
----------|---------|----------|---------|---------|------------------------------------------------
File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s                              
----------|---------|----------|---------|---------|------------------------------------------------
All files |   96.66 |    83.17 |   96.66 |   96.66 |                                                
 index.ts |   96.66 |    83.17 |   96.66 |   96.66 | ...750,767-770,794-795,861-862,885-903,985-986 
----------|---------|----------|---------|---------|------------------------------------------------
$ node scripts/check-coverage.mjs
LCOV verified: original src/index.ts, executed lines/functions/wrapFetch, no test/samples
```

### Tarball и consumers

```text
$ node scripts/check-package.mjs
A6: pnpm pack / absent: current JS, declarations, map, source and package contents
A6: pnpm pack / stale: current JS, declarations, map, source and package contents
A6: npm pack / absent: current JS, declarations, map, source and package contents
A6: npm pack / stale: current JS, declarations, map, source and package contents
Installing bare consumer: moysklad-fetch-planner-3.2.0.tgz
Installing bare consumer: node@22.20.5
Installing bare consumer: ts5@npm:typescript@5.7.3
Installing bare consumer: ts7@npm:typescript@7.0.2
Runtime smoke: root/deep imports, GET/POST, original Response identity
A8: TS 5.7.3, undici=false: strict positive and exact negative diagnostics passed
A8: TS 7.0.2, undici=false: strict positive and exact negative diagnostics passed
Installing undici consumer: moysklad-fetch-planner-3.2.0.tgz
Installing undici consumer: node@22.20.5
Installing undici consumer: ts5@npm:typescript@5.7.3
Installing undici consumer: ts7@npm:typescript@7.0.2
Installing undici consumer: undici@7.3.0
Runtime smoke: root/deep imports, GET/POST, original Response identity
A8: TS 5.7.3, undici=true: strict positive and exact negative diagnostics passed
A8: TS 7.0.2, undici=true: strict positive and exact negative diagnostics passed
A6–A8 passed. Native fetch type incompatibility remains for stage 3; no native type compatibility claimed.
```

### D1 исходный fixture

```text
. prepack$ pnpm run build
. prepack: $ pnpm run compile
. prepack: $ rm -rf build/ && tsc -p tsconfig.prod.json
. prepack: Done
package: moysklad-fetch-planner@3.2.0
Tarball Contents
build/src/index.d.ts
build/src/index.js
build/src/index.js.map
LICENSE
package.json
README.md
src/index.ts
Tarball Details
/tmp/orchestrate-fetch-planner-002/V11/d1-original/runtime-artifact/moysklad-fetch-planner-3.2.0.tgz
```

### D1 mutation — ожидаемый exit1, до checksum

```text
. prepack$ pnpm run build
. prepack: $ pnpm run compile
. prepack: $ rm -rf build/ && tsc -p tsconfig.prod.json
. prepack: Done
package: moysklad-fetch-planner@3.2.0
Tarball Contents
build/src/index.d.ts
build/src/index.js
build/src/index.js.map
LICENSE
package.json
README.md
src/index.ts
Tarball Details
/tmp/orchestrate-fetch-planner-002/V11/d1-alias/runtime-artifact/moysklad-fetch-planner-3.2.0.tgz
```

Сгенерированные import statements ошибочного fixture:

```js
import assert from 'node:assert/strict'
import { FetchPlanner, wrapFetch } from 'moysklad-fetch-planner'
import * as deepAlias from 'moysklad-fetch-planner'
```

Самостоятельное утверждение после запуска: SHA256SUMS не существует. Обязательные исходные gates:

```sh
grep -Eq "^import .+ from 'moysklad-fetch-planner'$" "$artifact/runtime.mjs"
grep -Eq "^import .+ from 'moysklad-fetch-planner/build/src/index[.]js'$" "$artifact/runtime.mjs"
```

### Один tarball на локальной runtime matrix

```text
package.tgz: OK
runtime.mjs: OK

added 2 packages in 285ms
v24.0.0
Runtime smoke: root/deep imports, GET/POST, original Response identity
```
```text
package.tgz: OK
runtime.mjs: OK

added 2 packages in 266ms
v24.22.2
Runtime smoke: root/deep imports, GET/POST, original Response identity
```
```text
package.tgz: OK
runtime.mjs: OK

added 2 packages in 244ms
v26.13.0
Runtime smoke: root/deep imports, GET/POST, original Response identity
```

### Негативный LCOV

```text
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: LCOV src/index.ts must have executed lines
    at file:///tmp/orchestrate-fetch-planner-002/V11/checkout/scripts/check-coverage.mjs:25:8 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v24.22.2
```

### Knip с контрольными нарушениями

```text
Error: ERR_PNPM_OUTDATED_LOCKFILE

  × installing dependencies
  ╰─▶ Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up
      to date with package.json.
      
        Failure reason:
        specifiers in the lockfile don't match specifiers in package.json:
      * in importers["."]:
      * 1 dependency was added: v11-unused-dependency@1.0.0
  help: Regenerate the lockfile with `pnpm install --lockfile-only` so that
        pnpm-lock.yaml reflects the current package.json, then re-run `pnpm
        install --frozen-lockfile`.

[WARN] The install that runs before scripts failed, so your node_modules may be out of sync with your lockfile. Set "verifyDepsBeforeRun: false" to skip this install.
$ knip
Unused files (1)
scripts/v11-unreachable.mjs
Unused devDependencies (1)
v11-unused-dependency  package.json
Configuration hints (5)
test/index.test.ts            knip.json  Remove redundant entry pattern
test/stress.test.ts           knip.json  Remove redundant entry pattern
test/stress.worker.ts         knip.json  Remove redundant entry pattern
scripts/check-coverage.mjs    knip.json  Remove redundant entry pattern
scripts/check-package.mjs     knip.json  Remove redundant entry pattern
[ELIFECYCLE] Command failed with exit code 1.
```

### Baseline source/JS/declarations

```text
PASS baseline source, JS and declarations identical after formatting and exact authorized directive/type-import substitutions
PASS 32 original and checkout input hashes unchanged
```

## Неизменность входов

Все перечисленные ниже исходные SHA256 совпали до/после установки и всех gates, после восстановления мутаций и непосредственно перед записью отчётов. Генерируемые build/__temp/coverage разрешены. Документы отчётов не входят в эту allowlist. Секретов среди входов нет.

```json
{
  "src/index.ts": "51552a0dba50f18d7a094f1407a85eda477e127c25baa54984865c5c75efee93",
  "test/index.test.ts": "2804ee985d3baeb04593e686efeed2412016d8477d19c3c1bb06e16bc7dcdb8a",
  "test/stress.test.ts": "2ac547622531ecddc1eb937f81a741cdfbe35220e2004bf5fbe20cc672dc1c17",
  "test/stress.worker.ts": "210954b10c8f49171d8eebae4137f9090b2dd7065eeec5f891d524c3a9f3f194",
  "test/package/fixtures/runtime.mjs": "5280a4429f2afdad0431910aa5f3d12f1e342fb7e999fc591b4ccf537b3cfca5",
  "test/package/fixtures/with-undici.ts": "48665bfc65216c50a3cda3e0cac9b8d27885aed03240ede8396b7d9107be5a2a",
  "test/package/fixtures/without-undici.ts": "a8d471cc2ca57173db9c643acf400eb026f6deb5086795b651411b6e4fc1ba11",
  "samples/batchStat.ts": "0914adb32d6cbb1840b3ffe99c102a25e496019c2ed016cac871dbabe95f95df",
  "samples/demo.ts": "7c23837c40e2380a8a2c8411132c1d91df9cdbe4b10a3ba1b5ce7d1857027845",
  "samples/types.ts": "cc6344ab52711c1f8227221126b42991c3611afe2213a613af1e3c21d3a35016",
  "samples/wait-for-request-slot-1.ts": "866dbc7a4b0393f5a005c0e3212beb948adc5a4690f3d322504278df0a5152b8",
  "samples/wait-for-request-slot-2.ts": "2736d0c155a49bf15bfe072c052fee4447e1705f1e5d86966dad8c63c17625d9",
  "scripts/check-coverage.mjs": "1168d9d7bbdb2bde915ae3f2fc447b09bd193aa1eeaf39c3ed0a9bcfbd35dbe4",
  "scripts/check-package.mjs": "2b750aa9607966d34aeb519512a64a165b7b02be35a00c55d9e85c982b9e7883",
  ".github/workflows/main.yml": "fe0af522f794d744047a64e7ea17654bb43ba3f1efabc8acb8c575560985444e",
  ".vscode/launch.json": "52a8e7c55cac1e4cbb2e4b2161c7342b0248c363c96fc6ef09aeab63da144099",
  ".vscode/settings.json": "edb3cf7838bf84508746873cdaeb75386f1012845c48d1d077a56b9549ff1863",
  "package.json": "49daf70064c3d36153ab1d2dd81560a86da785f81d23db9c40f5f4bf5fdb54a1",
  "pnpm-lock.yaml": "977576d187736ebf71ea8b6bf4a41f3850d22328cb2d0b8b0837a457a38aaa88",
  "pnpm-workspace.yaml": "baac9fc7b38c1133f340838f575acbc497cd83b3a5f3e427d6d44421a755c72b",
  ".node-version": "9185b9f67843cabfa8054f65ce47ce0b52036b0bfe07ae5a6b834d97cc127140",
  "tsconfig.json": "fdf1937af92cec36a2812b41cbbd2edb1e4fea46e4e34694e29ff90a17c2fcb4",
  "tsconfig.prod.json": "9cc0c2fe02093ba7c4424b1b040609bc4dce784c4a094c3282137c56c9ac8d45",
  "tsconfig.test.json": "87653d7629e8faeac2508ed3f46af7485363787f550bdd6a1807e9662e11d01f",
  "knip.json": "094d49a0479f43548b55b27f820ee1cbe8749a065a80f90e69b00526009a255b",
  ".oxlintrc.json": "cd884ed78c0587827375fe76694f55462331fa707e191dea2722078628954777",
  ".oxfmtrc.json": "55e2aef57a1c7fc095a7ab7a4d3e514d1a6519ce51fed059f682829bb850bfbe",
  "README.md": "d8697f948798eaa3d9dd41e4aac192695c53b4df33b4f26331abe2c8915c6c06",
  "LICENSE": "0003a6fb3883460adf7b471cb9a621c1afb854077c6e2867a63c0a879d383f65",
  ".npmignore": "70c178cc94aabc9ee7a348bd3b12d1f3acdc73eea7d914c516d00c6998c37c88",
  ".gitignore": "4b43f57d796df2376bb63de5fb63cf06b0348282435e196f5ed85b0c32d45502",
  "CHANGELOG.md": "6635ad8eaf2487749167e92b28ee4a3ae8b6700f1d80564f7c4c673702bb80ab"
}
```

## Ограничения и передача

Новых дефектов в разрешённой миграции не найдено. Технической read-only песочницы нет, поэтому приёмка поведенческая; независимость ограничена тем же семейством GPT и отдельным контекстом. Вердикты прежних приёмок не читались. Настоящий GitHub Actions run, runner/post-steps, artifact upload/download, Windows/macOS и VSCode GUI не проверены. CI run остаётся обязательным gate до будущего выпуска, а не выполненным результатом.

Долги runtime scheduler/nativeFetch/errorLimits/jitter/API docs сохранены без исправлений и без расширения объёма. Предлагаемый следующий шаг после решения владельца — отдельный план этапа3; эта приёмка его не начинает и не разрешает выпуск. Секреты не читались даже для hash; API МойСклад, live, root/global installs, публикация, git mutations/push и импортёр не затрагивались. Package consumers убраны finally/trap. Собственная V11 область удаляется после сохранения двух отчётов; чужие временные baseline/runtime/CLI оставлены на месте.

## Дополнительный сырой вывод контрольных отказов

### sample-typecheck (ожидаемый exit1)

```text
$ tsc --noEmit -p tsconfig.json
samples/v11-invalid.ts(1,24): error TS1109: Expression expected.
[ELIFECYCLE] Command failed with exit code 1.
```

### live-command (ожидаемый exit1)

```text
$ pnpm run build:test && node --enable-source-maps __temp/test-build/test/stress.test.js
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
/tmp/orchestrate-fetch-planner-002/V11/checkout/test/stress.test.ts:4
  throw new Error(
        ^

Error: Live stress is disabled. Set MOYSKLAD_LIVE_STRESS=1 explicitly and supply credentials externally to enable live requests.
    at <anonymous> (/tmp/orchestrate-fetch-planner-002/V11/checkout/test/stress.test.ts:4:9)
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
    at async node:internal/modules/esm/loader:647:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v24.22.2
[ELIFECYCLE] Command failed with exit code 1.
```

### live-import (ожидаемый exit1)

```text
file:///tmp/orchestrate-fetch-planner-002/V11/checkout/__temp/test-build/test/stress.test.js:3
    throw new Error('Live stress is disabled. Set MOYSKLAD_LIVE_STRESS=1 explicitly and supply credentials externally to enable live requests.');
          ^

Error: Live stress is disabled. Set MOYSKLAD_LIVE_STRESS=1 explicitly and supply credentials externally to enable live requests.
    at file:///tmp/orchestrate-fetch-planner-002/V11/checkout/__temp/test-build/test/stress.test.js:3:11
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
    at async node:internal/modules/esm/loader:647:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v24.22.2
```

### coverage-empty (ожидаемый exit1)

```text
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: LCOV must contain src/index.ts; an empty report is invalid
    at file:///tmp/orchestrate-fetch-planner-002/V11/checkout/scripts/check-coverage.mjs:24:8 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: undefined,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v24.22.2
```

### coverage-no-wrap (ожидаемый exit1)

```text
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: LCOV src/index.ts must include executed wrapFetch
    at file:///tmp/orchestrate-fetch-planner-002/V11/checkout/scripts/check-coverage.mjs:33:8 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v24.22.2
```

### coverage-foreign (ожидаемый exit1)

```text
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: LCOV must contain only original src files, found: test/invalid.ts
    at file:///tmp/orchestrate-fetch-planner-002/V11/checkout/scripts/check-coverage.mjs:16:12
    at Array.map (<anonymous>)
    at file:///tmp/orchestrate-fetch-planner-002/V11/checkout/scripts/check-coverage.mjs:11:4 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v24.22.2
```

### lint-mutation (ожидаемый exit1)

```text
$ oxlint --type-aware --report-unused-disable-directives src test samples scripts

  [38;2;225;80;80;1m×[0m [38;2;225;80;80;1meslint(no-restricted-properties): 'process.exit' is restricted from being used.[0m
   ╭─[[38;2;92;157;255;1msrc/v11-lint.ts[0m:7:1]
 [2m6[0m │ unsafeValue.run()
 [2m7[0m │ process.exit(1)
   · [38;2;246;87;248m────────────[0m
 [2m8[0m │ }
   ╰────
[38;2;106;159;181m  help: [0mLibrary code must not terminate the host process

  [38;2;225;80;80;1m×[0m [38;2;225;80;80;1mtypescript(no-floating-promises): Promises must be awaited, add void operator to ignore.[0m
   ╭─[[38;2;92;157;255;1msrc/v11-lint.ts[0m:2:1]
 [2m1[0m │ export async function violations() {
 [2m2[0m │ Promise.resolve(1)
   · [38;2;246;87;248m─────────┬────────[0m[38;2;30;201;212m─[0m
   ·          [38;2;246;87;248m╰── [38;2;246;87;248mThis unhandled promise-like value has type `Promise<number>`.[0m[0m
 [2m3[0m │ ;[1].forEach(async () => { await Promise.resolve(1) })
   ╰────
[38;2;106;159;181m  help: [0mThe promise must end with a call to .catch, or end with a call to .then with a rejection handler, or be explicitly marked as ignored with the `void` operator.

  [38;2;225;80;80;1m×[0m [38;2;225;80;80;1mtypescript(no-misused-promises): Promise returned in function argument where a void return was expected.[0m
   ╭─[[38;2;92;157;255;1msrc/v11-lint.ts[0m:3:23]
 [2m2[0m │ Promise.resolve(1)
 [2m3[0m │ ;[1].forEach(async () => { await Promise.resolve(1) })
   · [38;2;246;87;248m                      ─┬[0m[38;2;30;201;212m─[0m
   ·                        [38;2;246;87;248m╰── [38;2;246;87;248mThis callback has type `() => Promise<void>`.[0m[0m
 [2m4[0m │ await 42
   ╰────

  [38;2;225;80;80;1m×[0m [38;2;225;80;80;1mtypescript(await-thenable): Unexpected `await` of a non-Promise (non-"Thenable") value.[0m
   ╭─[[38;2;92;157;255;1msrc/v11-lint.ts[0m:4:1]
 [2m3[0m │ ;[1].forEach(async () => { await Promise.resolve(1) })
 [2m4[0m │ await 42
   · [38;2;246;87;248m─────[0m[38;2;30;201;212m ─┬[0m
   ·   [38;2;246;87;248m│[0m    [38;2;30;201;212m╰── [38;2;30;201;212mThis expression is not Promise-like[0m[0m
 [2m5[0m │ const unsafeValue = JSON.parse('{}')
   ╰────
[38;2;106;159;181m  help: [0mRemove `await` if the value is synchronous, or change the expression to return a Promise or Thenable before awaiting it.

  [38;2;225;80;80;1m×[0m [38;2;225;80;80;1mtypescript(no-unsafe-assignment): Unsafe assignment of an any value.[0m
   ╭─[[38;2;92;157;255;1msrc/v11-lint.ts[0m:5:7]
 [2m4[0m │ await 42
 [2m5[0m │ const unsafeValue = JSON.parse('{}')
   · [38;2;246;87;248m      ──────────────────────────────[0m
 [2m6[0m │ unsafeValue.run()
   ╰────
[38;2;106;159;181m  help: [0mAssigned value has type `any`, so the target is also inferred as `any`. Use a safely typed value or `unknown`, and narrow it before use.

  [38;2;225;80;80;1m×[0m [38;2;225;80;80;1mtypescript(no-unsafe-call): Unsafe call of a(n) `any` typed value.[0m
   ╭─[[38;2;92;157;255;1msrc/v11-lint.ts[0m:6:1]
 [2m5[0m │ const unsafeValue = JSON.parse('{}')
 [2m6[0m │ unsafeValue.run()
   · [38;2;246;87;248m───────────────[0m
 [2m7[0m │ process.exit(1)
   ╰────

  [38;2;225;80;80;1m×[0m [38;2;225;80;80;1mtypescript(no-unsafe-member-access): Unsafe member access .run on an `any` value.[0m
   ╭─[[38;2;92;157;255;1msrc/v11-lint.ts[0m:6:13]
 [2m5[0m │ const unsafeValue = JSON.parse('{}')
 [2m6[0m │ unsafeValue.run()
   · [38;2;246;87;248m            ───[0m
 [2m7[0m │ process.exit(1)
   ╰────

  [38;2;244;191;117;1m⚠[0m [38;2;244;191;117;1mtypescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.[0m
     ╭─[[38;2;92;157;255;1msamples/wait-for-request-slot-1.ts[0m:105:15]
 [2m104[0m │           // error
 [2m105[0m │           if (err) {
     · [38;2;246;87;248m              ───[0m
 [2m106[0m │             push(err)
     ╰────
[38;2;106;159;181m  help: [0mThe checked value has type `Error`.

  [38;2;244;191;117;1m⚠[0m [38;2;244;191;117;1mtypescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.[0m
     ╭─[[38;2;92;157;255;1msamples/wait-for-request-slot-1.ts[0m:130:31]
 [2m129[0m │ 
 [2m130[0m │             if (!isWaiting && IS_SLOT_WAIT_ON) {
     · [38;2;246;87;248m                              ───────────────[0m
 [2m131[0m │               isWaiting = true
     ╰────
[38;2;106;159;181m  help: [0mThe checked value has type `true`.

Found 2 warnings and 7 errors.
Finished in 240ms on 15 files with 134 rules using 4 threads.
[ELIFECYCLE] Command failed with exit code 1.
```

### format-mutation (ожидаемый exit1)

```text
$ oxfmt --check "src/**/*.ts" "test/**/*.ts" "test/**/*.mjs" "samples/**/*.ts" "scripts/**/*.mjs" package.json knip.json tsconfig.json tsconfig.prod.json tsconfig.test.json .oxlintrc.json .oxfmtrc.json pnpm-workspace.yaml README.md
Checking formatting...

[38;2;244;191;117;1mtest/package/fixtures/runtime.mjs[0m (0ms)

Format issues found in above 1 files. Run without `--check` to fix.
Finished in 6ms on 23 files using 4 threads.
[ELIFECYCLE] Command failed with exit code 1.
```



## Разбор оркестратора

- Все итоговые критерии локальной миграции приняты. D1 и последние текстовые уточнения независимо перепроверены; предыдущие оговорки T15/T90 закрыты.
- Замечания о nativeFetch/errorLimits/jitter/D01–D10/D12/lint/документации — долг следующих этапов, а не выполненные исправления. Передача в knowledge.md,README и handoff-ссылку на эту папку; исходный план не переписывается.
- Реальный Actions-run остаётся отдельным gate перед выпуском, не выполнялся без разрешённого push.
