# T100: сквозная локальная проверка

2026-10-30, Linux. Проверка исполнителя, окончательная независимая приёмка плана сюда не включена. Копия: /tmp/orchestrate-fetch-planner-002/T100-1/checkout. До установки в ней нет build/node_modules/.env; перенос только allowlist, исключение .env/.env.* до чтения/копирования. Настоящие live/API не запускались. HOME отдельный, npm user/global configs — разные пустые файлы, окружение дочерних процессов собрано из явного allowlist без переменных приложения и opt-in.

Bootstrap сначала использует уже существующие pinned Node/pnpm из __temp/environment-compat, затем воспроизводит README: npm install --prefix отдельного временного каталога для node@значение-.node-version и pnpm из packageManager; PATH сначала node/bin, затем .bin. Версии проверены командами. Никаких глобальных установок. npm для pack берётся из исходного PATH. После установки инструментов pnpm install --frozen-lockfile --strict-peer-dependencies устанавливает новый node_modules, не использует старый build и не меняет lockfile.

Runner и точный allowlist сохранены в [t100-verify.py.txt](t100-verify.py.txt), итоговые хеши — [t100-input-hashes.json](t100-input-hashes.json). Каждая команда ограничена 280 секундами; максимальная фактическая длительность 60.77 секунды. Последняя полная цепочка выполнялась без одновременных проб после очистки build/test-build/coverage: exit 0, 49.00 секунд. Первый успешный прогон сохранён отдельно: во время него ошибочно запустились дополнительные пробы в той же копии, поэтому итог опирается на последовательный повтор. Никаких падений jitter в T100 не было; это не снимает ранее обнаруженную нестабильность V8.

Offline check/coverage дополнительно выполнены с npm_config_offline=true, registry и proxy на недоступном 127.0.0.1:9. Это проверка без доступного registry; системная блокировка всех сокетов здесь не устанавливалась. Unit fixture использует MockAgent.disableNetConnect; полная инструментация запрета сети/workers ранее подтверждена T40.accept-1. Пакетная установка, в отличие от unit, использует registry; runtime/type assertions работают локально.

## A1–A10

| Критерий | Подтверждение | Граница |
| --- | --- | --- |
| A1 | T100: новый node_modules, закреплённые Node/pnpm, strict frozen install и check exit 0; только pnpm-lock.yaml | Без глобального np, .env и секретов |
| A2 | T100: 32 явных входа совпадают до/после и с оригиналом, включая src/test/samples/scripts, workflow/editor configs, README, manifest, lock и changelog | Docs/evidence — выход этой задачи; проверка не является git diff всего общего дерева |
| A3 | T100: check и coverage по 13 pass / 0 fail / 0 skip; свежий LCOV src/wrapFetch; отказ live без opt-in exit 1 | Реальный live запрещён; контрольные повреждения LCOV и отказ до workers ранее проверены T40.accept-1 |
| A4 | T100: build содержит только src JS/declaration/map; синтаксическая ошибка sample не ломает build, ломает общий typecheck | Emit и сохранение строгих опций независимо проверены T30.accept-1 |
| A5 | T100: lint/format/knip exit 0, 2 прежних warnings и 5 hints; format README/editor configs exit 0 | Мутационные promise/unsafe/process.exit проверки — T50.accept-1, format — T60.accept-1, knip — T70.accept-1; здесь повторно не заявляются |
| A6 | T100: четыре упаковки pnpm/npm absent/stale, точные байты JS/declaration/map, разрешённый состав пакета | Проверяется реальный tarball; package consumers убираются finally |
| A7 | T100: внешние root/deep ESM consumers, GET/POST, identity Response; paths/files сохранены | Один tarball на 24.0.0/24.22.2/26.13.0 проверен T90.accept-1; Actions matrix не запускалась |
| A8 | T100: bare и undici@7.3.0 consumers, strict/skipLibCheck=false на TS 5.7.3/7.0.2; негативные TS2307/2345/2322 | Native fetch несовместим, не исправлен; строка лога node@22.20.5 означает basename аргумента @types/node, а не смену runtime |
| A9 | Workflow прочитан: frozen install, PR/push master, без .env/token/live/publish; версии Actions/inputs независимо сверены в T90.accept-1 | T100 проверил финальный D1: исходный fixture exit 0, deepAlias exit 1; настоящие runner/upload/download и весь Actions run не проверены |
| A10 | README: setup, gates, offline/live, упаковка, compatibility и запрещённый пока major release; VS Code запускает build/test без envFile | GUI VS Code не запускался: проверены JSON/команды и выполнение соответствующих pnpm scripts; версия/changelog не менялись |

Приёмки предыдущих задач находятся в ../run/journal/T<N>.accept-1.md. Их результаты здесь отделены от повторных запусков T100; исторический Node>=18 в исходном плане заменён принятым Node>=24, полные Node guards — принятым синтаксическим process.exit и явной потерей прочих проверок.

## Покрытие

SF:src/index.ts; FNF:30; FNH:29; FNDA:1,debug; FNDA:1,debug; FNDA:137,x-lognex-retry-timeInterval; FNDA:137,x-ratelimit-limit; FNDA:137,x-ratelimit-remaining; FNDA:14,FetchPlanner; FNDA:140,getNewActionId; FNDA:144,getNewRequestId; FNDA:168,calculateRequestDelayTime; FNDA:428,planProcessAction; FNDA:161,checkFreeRequestSlotTrigger; FNDA:432,parseNumberHeader; FNDA:432,parseRateLimitHeader; FNDA:144,reviewParallelLimitCorrection; FNDA:2,reduceParallelLimit; FNDA:145,shouldProcessAction; FNDA:144,processAction; FNDA:140,fetch; FNDA:14,getFetch; FNDA:9,waitForFreeRequestSlot; FNDA:0,getOptions; FNDA:8,getRateLimit; FNDA:6,getRateLimitRemaining; FNDA:8,getActionsQueueLength; FNDA:1,getRequestSlotHandlersCount; FNDA:4,getParallelLimitCorrection; FNDA:13,getCurInflightRequestsCount; FNDA:117,getLastRequestDelay; FNDA:5,getNextRequestTime; FNDA:2,wrapFetch; LF:1051; LH:1016

Локальный LCOV содержит только src/index.ts; показатели приведены как наблюдение, порог или дополнительные тесты ради процентов не вводились.

## Сырой вывод

### bootstrap

```text
{"command": ["npm", "install", "--prefix", "/tmp/orchestrate-fetch-planner-002/T100-1/tools", "--no-save", "--package-lock=false", "node@24.22.2", "pnpm@12.16.1"], "exit": 0, "seconds": 14.39, "expected": 0}

added 4 packages in 14s
```

### node-version

```text
{"command": ["node", "--version"], "exit": 0, "seconds": 0.01, "expected": 0}
v24.22.2
```

### pnpm-version

```text
{"command": ["pnpm", "--version"], "exit": 0, "seconds": 0.02, "expected": 0}
12.16.1
```

### install

```text
{"command": ["pnpm", "install", "--frozen-lockfile", "--strict-peer-dependencies"], "exit": 0, "seconds": 17.97, "expected": 0}
? Verifying lockfile against supply-chain policies (539 entries)...
Progress: resolved 423, reused 0, downloaded 1, added 0
Packages are hard linked from the content-addressable store to the virtual store.
  Content-addressable store is at: /tmp/orchestrate-fetch-planner-002/T100-1/home/.local/share/pnpm/store/v11
  Virtual store is at:             node_modules/.pnpm
Progress: resolved 423, reused 0, downloaded 46, added 45
Downloading @oxlint-tsgolint/linux-x64@7.0.2005: 0.00 B/7.83 MB
Downloading @typescript/typescript-linux-x64@7.0.2: 0.00 B/9.66 MB
Progress: resolved 423, reused 0, downloaded 274, added 273
Downloading @oxlint/binding-linux-x64-gnu@1.90.0: 0.00 B/6.40 MB
Progress: resolved 423, reused 0, downloaded 360, added 359
Downloading @typescript/typescript-linux-x64@7.0.2: 1.57 MB/9.66 MB
Downloading @oxlint-tsgolint/linux-x64@7.0.2005: 4.88 MB/7.83 MB
Downloading @oxlint-tsgolint/linux-x64@7.0.2005: 6.00 MB/7.83 MB
✓ Lockfile passes supply-chain policies (539 entries in 11.9s)
Lockfile is up to date, resolution step is skipped
Downloading @typescript/typescript-linux-x64@7.0.2: 4.78 MB/9.66 MB
Downloading @typescript/typescript-linux-x64@7.0.2: 6.25 MB/9.66 MB
Downloading @typescript/typescript-linux-x64@7.0.2: 8.62 MB/9.66 MB
Packages: +423
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 423, reused 0, downloaded 423, added 423, done

dependencies:
+ undici-types 7.3.0

devDependencies:
+ @types/highland 2.13.0
+ @types/node 22.20.5
+ @wmakeev/highland-tools 3.1.0
+ auto-changelog 2.5.0
+ c8 12.0.0
+ csv-stringify 6.5.2
+ dotenv 16.4.7
+ highland 2.13.5
+ knip 6.44.0
+ moysklad 0.20.0
+ np 12.1.1
+ oxfmt 0.75.0
+ oxlint 1.90.0
+ oxlint-tsgolint 7.0.2005
+ p-retry 6.2.1
+ piscina 5.0.0-alpha.0
+ typescript 7.0.2
+ undici 7.3.0

Done in 17.9s using pnpm v12.16.1
```

### gates-initial

```text
{"command": ["sh", "-c", "pnpm check && pnpm coverage && pnpm test:package"], "exit": 0, "seconds": 60.77, "expected": 0}
$ pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run knip && pnpm run test
$ tsc --noEmit -p tsconfig.json
$ oxlint --type-aware --report-unused-disable-directives src test samples scripts

  ⚠ typescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.
     ╭─[samples/wait-for-request-slot-1.ts:105:15]
 104 │           // error
 105 │           if (err) {
     ·               ───
 106 │             push(err)
     ╰────
  help: The checked value has type `Error`.

  ⚠ typescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.
     ╭─[samples/wait-for-request-slot-1.ts:130:31]
 129 │ 
 130 │             if (!isWaiting && IS_SLOT_WAIT_ON) {
     ·                               ───────────────
 131 │               isWaiting = true
     ╰────
  help: The checked value has type `true`.

Found 2 warnings and 0 errors.
Finished in 231ms on 14 files with 134 rules using 4 threads.
$ oxfmt --check "src/**/*.ts" "test/**/*.ts" "test/**/*.mjs" "samples/**/*.ts" "scripts/**/*.mjs" package.json knip.json tsconfig.json tsconfig.prod.json tsconfig.test.json .oxlintrc.json .oxfmtrc.json pnpm-workspace.yaml README.md
Checking formatting...

All matched files use the correct format.
Finished in 6ms on 23 files using 4 threads.
$ knip
Configuration hints (5)
test/index.test.ts            knip.json  Remove redundant entry pattern
test/stress.test.ts           knip.json  Remove redundant entry pattern
test/stress.worker.ts         knip.json  Remove redundant entry pattern
scripts/check-coverage.mjs    knip.json  Remove redundant entry pattern
scripts/check-package.mjs     knip.json  Remove redundant entry pattern
$ pnpm run build:test && pnpm run test:unit
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
$ node --test --enable-source-maps __temp/test-build/test/index.test.js
✔ wrapFetch (simple) (12.86329ms)
✔ wrapFetch (with options) (3.599531ms)
✔ FetchPlanner (simple GET) (1.5576ms)
✔ FetchPlanner (event handler) (6054.754259ms)
✔ FetchPlanner (EventEmitter as event handler) (2.43123ms)
✔ FetchPlanner (simple POST) (2.723114ms)
✔ FetchPlanner (jitter) (38.291944ms)
✔ FetchPlanner (delay reduce) (2513.493626ms)
✔ FetchPlanner (POST with RateLimit) (8.089299ms)
✔ FetchPlanner (waitForRequestSlot) (382.558928ms)
✔ FetchPlanner (parallel limit and throttling) (7.497931ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (2.110533ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1007.306075ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10186.009564
$ pnpm run build:test && c8 pnpm run test:unit && pnpm run coverage:check
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
$ node --test --enable-source-maps __temp/test-build/test/index.test.js
✔ wrapFetch (simple) (16.459895ms)
✔ wrapFetch (with options) (3.556578ms)
✔ FetchPlanner (simple GET) (1.49136ms)
✔ FetchPlanner (event handler) (5906.725351ms)
✔ FetchPlanner (EventEmitter as event handler) (3.518244ms)
✔ FetchPlanner (simple POST) (2.947058ms)
✔ FetchPlanner (jitter) (32.331446ms)
✔ FetchPlanner (delay reduce) (2511.586191ms)
✔ FetchPlanner (POST with RateLimit) (1.531567ms)
✔ FetchPlanner (waitForRequestSlot) (369.674476ms)
✔ FetchPlanner (parallel limit and throttling) (3.052518ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (2.242503ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1008.312073ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10070.071766
----------|---------|----------|---------|---------|------------------------------------------------
File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s                              
----------|---------|----------|---------|---------|------------------------------------------------
All files |   96.66 |    83.17 |   96.66 |   96.66 |                                                
 index.ts |   96.66 |    83.17 |   96.66 |   96.66 | ...750,767-770,794-795,861-862,885-903,985-986 
----------|---------|----------|---------|---------|------------------------------------------------
$ node scripts/check-coverage.mjs
LCOV verified: original src/index.ts, executed lines/functions/wrapFetch, no test/samples
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

### live-guard

```text
{"command": ["pnpm", "test:live"], "exit": 1, "seconds": 0.31, "expected": 1}
$ pnpm run build:test && node --enable-source-maps __temp/test-build/test/stress.test.js
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
/tmp/orchestrate-fetch-planner-002/T100-1/checkout/test/stress.test.ts:4
  throw new Error(
        ^

Error: Live stress is disabled. Set MOYSKLAD_LIVE_STRESS=1 explicitly and supply credentials externally to enable live requests.
    at <anonymous> (/tmp/orchestrate-fetch-planner-002/T100-1/checkout/test/stress.test.ts:4:9)
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
    at async node:internal/modules/esm/loader:647:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v24.22.2
[ELIFECYCLE] Command failed with exit code 1.
```

### build

```text
{"command": ["pnpm", "build"], "exit": 0, "seconds": 0.23, "expected": 0}
$ pnpm run compile
$ rm -rf build/ && tsc -p tsconfig.prod.json
```

### sample-build

```text
{"command": ["pnpm", "build"], "exit": 0, "seconds": 0.28, "expected": 0}
$ pnpm run compile
$ rm -rf build/ && tsc -p tsconfig.prod.json
```

### sample-typecheck

```text
{"command": ["pnpm", "typecheck"], "exit": 1, "seconds": 0.18, "expected": 1}
$ tsc --noEmit -p tsconfig.json
samples/t100-probe.ts(1,24): error TS1109: Expression expected.
[ELIFECYCLE] Command failed with exit code 1.
```

### d1-original

```text
{"command": ["bash", "-c", "set -euo pipefail\nartifact=/tmp/orchestrate-fetch-planner-002/T100-1/artifact-probe\nsed \\\n  -e \"s|'../../../src/index.js'|'moysklad-fetch-planner'|\" \\\n  -e \"s|import \\* as deep from 'moysklad-fetch-planner'|import * as deep from 'moysklad-fetch-planner/build/src/index.js'|\" \\\n  test/package/fixtures/runtime.mjs > \"$artifact/runtime.mjs\"\ngrep -Eq \"^import .+ from 'moysklad-fetch-planner'$\" \"$artifact/runtime.mjs\"\ngrep -Eq \"^import .+ from 'moysklad-fetch-planner/build/src/index[.]js'$\" \"$artifact/runtime.mjs\"\n"], "exit": 0, "seconds": 0.01, "expected": 0}

```

### d1-alias

```text
{"command": ["bash", "-c", "set -euo pipefail\nartifact=/tmp/orchestrate-fetch-planner-002/T100-1/artifact-probe\nsed \\\n  -e \"s|'../../../src/index.js'|'moysklad-fetch-planner'|\" \\\n  -e \"s|import \\* as deep from 'moysklad-fetch-planner'|import * as deep from 'moysklad-fetch-planner/build/src/index.js'|\" \\\n  test/package/fixtures/runtime.mjs > \"$artifact/runtime.mjs\"\ngrep -Eq \"^import .+ from 'moysklad-fetch-planner'$\" \"$artifact/runtime.mjs\"\ngrep -Eq \"^import .+ from 'moysklad-fetch-planner/build/src/index[.]js'$\" \"$artifact/runtime.mjs\"\n"], "exit": 1, "seconds": 0.01, "expected": 1}

```

### gates

```text
{"command": ["sh", "-c", "pnpm check && pnpm coverage && pnpm test:package"], "exit": 0, "seconds": 49.0, "expected": 0}
$ pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run knip && pnpm run test
$ tsc --noEmit -p tsconfig.json
$ oxlint --type-aware --report-unused-disable-directives src test samples scripts

  ⚠ typescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.
     ╭─[samples/wait-for-request-slot-1.ts:105:15]
 104 │           // error
 105 │           if (err) {
     ·               ───
 106 │             push(err)
     ╰────
  help: The checked value has type `Error`.

  ⚠ typescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.
     ╭─[samples/wait-for-request-slot-1.ts:130:31]
 129 │ 
 130 │             if (!isWaiting && IS_SLOT_WAIT_ON) {
     ·                               ───────────────
 131 │               isWaiting = true
     ╰────
  help: The checked value has type `true`.

Found 2 warnings and 0 errors.
Finished in 220ms on 14 files with 134 rules using 4 threads.
$ oxfmt --check "src/**/*.ts" "test/**/*.ts" "test/**/*.mjs" "samples/**/*.ts" "scripts/**/*.mjs" package.json knip.json tsconfig.json tsconfig.prod.json tsconfig.test.json .oxlintrc.json .oxfmtrc.json pnpm-workspace.yaml README.md
Checking formatting...

All matched files use the correct format.
Finished in 5ms on 23 files using 4 threads.
$ knip
Configuration hints (5)
test/index.test.ts            knip.json  Remove redundant entry pattern
test/stress.test.ts           knip.json  Remove redundant entry pattern
test/stress.worker.ts         knip.json  Remove redundant entry pattern
scripts/check-coverage.mjs    knip.json  Remove redundant entry pattern
scripts/check-package.mjs     knip.json  Remove redundant entry pattern
$ pnpm run build:test && pnpm run test:unit
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
$ node --test --enable-source-maps __temp/test-build/test/index.test.js
✔ wrapFetch (simple) (17.293441ms)
✔ wrapFetch (with options) (5.534276ms)
✔ FetchPlanner (simple GET) (1.830983ms)
✔ FetchPlanner (event handler) (6063.780243ms)
✔ FetchPlanner (EventEmitter as event handler) (2.869575ms)
✔ FetchPlanner (simple POST) (4.12392ms)
✔ FetchPlanner (jitter) (39.052779ms)
✔ FetchPlanner (delay reduce) (2508.838824ms)
✔ FetchPlanner (POST with RateLimit) (1.680025ms)
✔ FetchPlanner (waitForRequestSlot) (378.282629ms)
✔ FetchPlanner (parallel limit and throttling) (2.578735ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (1.406188ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1009.962946ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10204.968765
$ pnpm run build:test && c8 pnpm run test:unit && pnpm run coverage:check
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
$ node --test --enable-source-maps __temp/test-build/test/index.test.js
✔ wrapFetch (simple) (18.439168ms)
✔ wrapFetch (with options) (4.687866ms)
✔ FetchPlanner (simple GET) (1.497997ms)
✔ FetchPlanner (event handler) (5755.989447ms)
✔ FetchPlanner (EventEmitter as event handler) (2.4548ms)
✔ FetchPlanner (simple POST) (2.961384ms)
✔ FetchPlanner (jitter) (36.107317ms)
✔ FetchPlanner (delay reduce) (2512.57973ms)
✔ FetchPlanner (POST with RateLimit) (1.456954ms)
✔ FetchPlanner (waitForRequestSlot) (372.35782ms)
✔ FetchPlanner (parallel limit and throttling) (2.676382ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (2.010612ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1009.08793ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9936.010387
----------|---------|----------|---------|---------|------------------------------------------------
File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s                              
----------|---------|----------|---------|---------|------------------------------------------------
All files |   96.66 |    83.17 |   96.66 |   96.66 |                                                
 index.ts |   96.66 |    83.17 |   96.66 |   96.66 | ...750,767-770,794-795,861-862,885-903,985-986 
----------|---------|----------|---------|---------|------------------------------------------------
$ node scripts/check-coverage.mjs
LCOV verified: original src/index.ts, executed lines/functions/wrapFetch, no test/samples
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

### offline-check

```text
{"command": ["pnpm", "check"], "exit": 0, "seconds": 11.63, "expected": 0}
$ pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run knip && pnpm run test
$ tsc --noEmit -p tsconfig.json
$ oxlint --type-aware --report-unused-disable-directives src test samples scripts

  ⚠ typescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.
     ╭─[samples/wait-for-request-slot-1.ts:105:15]
 104 │           // error
 105 │           if (err) {
     ·               ───
 106 │             push(err)
     ╰────
  help: The checked value has type `Error`.

  ⚠ typescript(no-unnecessary-condition): Unnecessary conditional, value is always truthy.
     ╭─[samples/wait-for-request-slot-1.ts:130:31]
 129 │ 
 130 │             if (!isWaiting && IS_SLOT_WAIT_ON) {
     ·                               ───────────────
 131 │               isWaiting = true
     ╰────
  help: The checked value has type `true`.

Found 2 warnings and 0 errors.
Finished in 254ms on 14 files with 134 rules using 4 threads.
$ oxfmt --check "src/**/*.ts" "test/**/*.ts" "test/**/*.mjs" "samples/**/*.ts" "scripts/**/*.mjs" package.json knip.json tsconfig.json tsconfig.prod.json tsconfig.test.json .oxlintrc.json .oxfmtrc.json pnpm-workspace.yaml README.md
Checking formatting...

All matched files use the correct format.
Finished in 4ms on 23 files using 4 threads.
$ knip
Configuration hints (5)
test/index.test.ts            knip.json  Remove redundant entry pattern
test/stress.test.ts           knip.json  Remove redundant entry pattern
test/stress.worker.ts         knip.json  Remove redundant entry pattern
scripts/check-coverage.mjs    knip.json  Remove redundant entry pattern
scripts/check-package.mjs     knip.json  Remove redundant entry pattern
$ pnpm run build:test && pnpm run test:unit
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
$ node --test --enable-source-maps __temp/test-build/test/index.test.js
✔ wrapFetch (simple) (13.639156ms)
✔ wrapFetch (with options) (3.972132ms)
✔ FetchPlanner (simple GET) (1.670037ms)
✔ FetchPlanner (event handler) (5864.003537ms)
✔ FetchPlanner (EventEmitter as event handler) (2.526002ms)
✔ FetchPlanner (simple POST) (4.070739ms)
✔ FetchPlanner (jitter) (32.802226ms)
✔ FetchPlanner (delay reduce) (2512.290136ms)
✔ FetchPlanner (POST with RateLimit) (5.343329ms)
✔ FetchPlanner (waitForRequestSlot) (377.493628ms)
✔ FetchPlanner (parallel limit and throttling) (3.294558ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (2.073266ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1008.155374ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9962.169197
```

### offline-coverage

```text
{"command": ["pnpm", "coverage"], "exit": 0, "seconds": 11.26, "expected": 0}
$ pnpm run build:test && c8 pnpm run test:unit && pnpm run coverage:check
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
$ node --test --enable-source-maps __temp/test-build/test/index.test.js
✔ wrapFetch (simple) (16.598764ms)
✔ wrapFetch (with options) (3.631429ms)
✔ FetchPlanner (simple GET) (1.503638ms)
✔ FetchPlanner (event handler) (6020.19643ms)
✔ FetchPlanner (EventEmitter as event handler) (2.288455ms)
✔ FetchPlanner (simple POST) (2.735207ms)
✔ FetchPlanner (jitter) (44.507434ms)
✔ FetchPlanner (delay reduce) (2514.65707ms)
✔ FetchPlanner (POST with RateLimit) (6.290356ms)
✔ FetchPlanner (waitForRequestSlot) (403.253439ms)
✔ FetchPlanner (parallel limit and throttling) (15.570003ms)
✔ FetchPlanner (retry 429 TooManyRequests error) (40.554808ms)
✔ FetchPlanner (retry 429 parallel limit overflow error) (1023.842343ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10321.209771
----------|---------|----------|---------|---------|------------------------------------------------
File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s                              
----------|---------|----------|---------|---------|------------------------------------------------
All files |   96.66 |    83.17 |   96.66 |   96.66 |                                                
 index.ts |   96.66 |    83.17 |   96.66 |   96.66 | ...750,767-770,794-795,861-862,885-903,985-986 
----------|---------|----------|---------|---------|------------------------------------------------
$ node scripts/check-coverage.mjs
LCOV verified: original src/index.ts, executed lines/functions/wrapFetch, no test/samples
```

### format-check

```text
{"command": ["pnpm", "exec", "oxfmt", "--check", "README.md", ".vscode/launch.json", ".vscode/settings.json"], "exit": 0, "seconds": 0.12, "expected": 0}
Checking formatting...

All matched files use the correct format.
Finished in 2ms on 3 files using 4 threads.
```
