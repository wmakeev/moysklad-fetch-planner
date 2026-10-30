# T140/2 — повторная сквозная приёмка плана 003

ИТОГ: passed.

ПРОВЕРЕНО: свежие pnpm check и coverage — по 108 pass, 0 fail/cancelled/skipped/todo; полная package matrix TS5/TS7 × bare/undici; один свежий tarball на Node 24.0.0/24.22.2/26.13.0; четыре самостоятельные стыковые пробы; 16 negative LCOV gates; исправленный публичный JSDoc в source и declarations; отсутствие изменения emitted runtime/types после удаления комментариев.

НЕ ЗАКРЫТО: в согласованном объёме 003 — нет. D09, полная политика D10 и реализация D12 намеренно остаются этапу 4; passed не означает готовность к выпуску или защиту аккаунта.

ПОБОЧНОЕ: ущерба проекту нет; единственная запись в проекте — этот отчёт.

ЗАМЕЧАНИЯ: свежий контекст той же GPT-модели из-за недоступности Claude ограничивает независимость. Live и настоящий Actions-run не выполнялись. Следующий шаг — оркестратору закрыть прогон 003 и обновить его статус; этап 4 здесь не начинался.

Дата: 31.10.2026. История первого partial и прежняя находка B1 сохранены в [plan-1.md](plan-1.md). Его вердикт и старый tarball не использовались как основание passed. Все указанные ниже запуски сделаны заново в этом круге. Historical red взят из разрешённых сырых T20/T30/T40/T50/T60.md и отделён от свежего green. Прочитаны целиком бриф, определение plan-verifier, 00-context/01-plan/02-research/03-plan-review; проверены decisions, README, architecture, source, tests, runners, HANDOFF и .github/workflows/main.yml. Tasks.md и *.accept-*.md не читались. Другие агенты/модели не запускались.

## Изоляция и окружение

Собственная allowlist-копия: `/tmp/orchestrate-fetch-planner-003/T140-v2/work/`. Скопированы 64 разрешённых файла: src/**/*.ts, test/**/*.ts/mjs, samples/**/*.ts, scripts/**/*.mjs, именованные конфиги/manifest/lock/README/LICENSE, test/package/fixtures/*.ts.txt и diagnostics.json. Файлы .env/.env.* исключались до read/copy/hash; секреты не открывались, не копировались, не хешировались и не выводились. Node_modules — symlink на установленный граф; project packages не устанавливались. Разрешённые isolated consumer dependencies и Node tooling установлены только во временные каталоги. Штатный package runner прочитан до копирования, не менялся; его finally удалил свои consumers/sandbox и проверил неизменность входов.

Pinned PATH перед всеми pnpm/Node-tooling командами:

```sh
export PATH="/home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/node/bin:/home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/.bin:$PATH"
```

Фактически: node --version → v24.22.2; pnpm --version → 12.16.1; pnpm exec tsc --version → Version 7.0.2. Поиск дополнительных binaries ограничен checkout/__temp; найдена закреплённая версия. Недостающие две версии получены разрешённым registry tooling node@24.0.0/node@26.13.0 внутри work/tools24 и work/tools26. Каждый проверочный процесс ограничен timeout 300; полный package run уложился, slices не потребовались. Live/stress/opt-in/sample/API аккаунта не запускались. Сборки/coverage исходного проекта не использовались и не менялись.

## Команды и результаты

Все относительные пути ниже отсчитываются от собственной work-копии. Каждая строка с exit 0 действительно выполнена в этом круге.

| Команда/проверка | Exit | Итог вывода | Результат |
|---|---:|---|---|
| timeout 300 pnpm check | 0 | 108 pass; 0 fail/cancelled/skipped/todo; typecheck/lint/format/knip проходят | pass |
| timeout 300 pnpm coverage | 0 | 108 pass; LCOV verified для index/planner/pacing/response-policy/runtime и wrapFetch | pass |
| timeout 300 pnpm test:package | 0 | A5–A8 passed: native and undici Fetch contracts verified on fresh tarball. | pass |
| timeout 300 npm install --prefix tools24 --no-save --package-lock=false --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000 node@24.0.0 | 0 | added 2 packages in 6s | pass |
| timeout 300 npm install --prefix tools26 --no-save --package-lock=false --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000 node@26.13.0 | 0 | added 2 packages in 4s | pass |
| timeout 300 npm install --prefix runtime-consumer --ignore-scripts --omit=dev --no-audit --no-fund --package-lock=false --fetch-retries=0 --fetch-timeout=20000 "$PWD/__temp/package-check/moysklad-fetch-planner-3.2.0.tgz" | 0 | added 2 packages; runtime undici отсутствует | pass |
| timeout 300 tools24/node_modules/node/bin/node --unhandled-rejections=strict runtime.mjs, cwd runtime-consumer | 0 | root/deep GET/POST/native/one-shot | pass |
| timeout 300 /home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/node/bin/node --unhandled-rejections=strict runtime.mjs, cwd runtime-consumer | 0 | root/deep GET/POST/native/one-shot | pass |
| timeout 300 tools26/node_modules/node/bin/node --unhandled-rejections=strict runtime.mjs, cwd runtime-consumer | 0 | root/deep GET/POST/native/one-shot | pass |
| timeout 300 node --unhandled-rejections=strict --test junction.test.mjs | 0 | 4 pass, 0 fail/skip/todo | pass |
| timeout 300 node coverage-negative.mjs | 0 | Coverage negative probes: 16 rejected | pass |
| timeout 300 node node_modules/typescript/bin/tsc -p tsconfig.prod.json --removeComments --sourceMap false --outDir compare-current | 0 | текущие JS/declarations без комментариев | pass |
| timeout 300 node node_modules/typescript/bin/tsc -p before-comments/tsconfig.prod.json --removeComments --sourceMap false --outDir ../compare-before | 0 | предыдущие JS/declarations без комментариев; затем перенесены внутрь work | pass |
| Побайтовое сравнение двух emitted graphs без комментариев | 0 | 12 files equal | pass |
| timeout 300 pnpm build; timeout 300 pnpm knip | 0/0 | production compile; ровно 5 прежних informational hints | pass |
| Статический scan, сравнение allowlist-входов с checkout | 0 | 50 source/fixture файлов неизменны; 9 suites включены; strict=true/skipLibCheck=false; положительные consumers без cast/any/suppressions | pass |
| Извлечение index.d.ts/planner.d.ts из свежего tarball | 0 | исправленный JSDoc включён, старое обещание скорости отсутствует | pass |
| Ревью README/architecture/HANDOFF/workflow/decisions и исторических diff | — | A7 и сохранение согласованных адаптаций подтверждены | pass |

Check в чистой копии без build показал 7 informational Knip hints: пять прежних и два про ещё отсутствующие package entry files build/src/index.js/index.d.ts. После production build остаются ровно пять прежних. Это не lint warnings; lint дал пустой диагностический вывод, 0 errors/warnings. Strict/rules не отключались для зелени; прежние debug c8 ignores не скрывают новые исполняемые модули. Полную unit/coverage/package regression повторно не гонял [PARETO].

Две ошибки собственной проверочной обвязки исправлены без изменения проекта: первая проверка путей сравнения ожидала compare-before внутри work, тогда как CLI outDir был разрешён от cwd на один уровень выше; созданный мной output перемещён внутрь work и удалён вместе с ним. На сборку/сравниваемые данные это не повлияло. Первый статический regex ошибочно принял import alias `fetch as uf` за cast; после различения import alias и assertions весь scan прошёл. Эти отказы не выдаются за дефекты библиотеки или незапущенные gates.

## Свежий artifact и три Node

Штатный runner полностью проверил npm/pnpm pack × absent/stale build, актуальность JS/declarations/maps/source, состав tarball и отсутствие секретов/лишних файлов, strict isolated consumers TS5.7.3/TS7.0.2 × bare/undici7.3.0. Положительные native/legacy/custom/subclass/events fixtures прошли; отрицательные transport/body/method/event/bytes fixtures дали точную матрицу diagnostic file/line/code. Missing declaration dependency в bare consumer подтверждена обязательным TS2307. Bare consumer не получает runtime undici, direct undici-types7.3.0 сохранён. Дополнительные исторические типовые prototype-пробы не повторялись: основание A5 — настоящие consumers текущего tarball.

Во всех трёх дополнительных runtime-запусках использован один и тот же последний свежий tarball штатного runner, без перепаковки между версиями:

```text
/tmp/orchestrate-fetch-planner-003/T140-v2/work/__temp/package-check/moysklad-fetch-planner-3.2.0.tgz
SHA256 ee3643881d008e4065fe64000d16141796c99d2143694f18a714aaf223cdf416
```

Checksum до и после runtime matrix совпал. Runtime fixture взят из текущего test/package/fixtures/runtime.mjs; изменены только root/deep import specifiers, deep namespace import проверен явно. Consumer установлен с omit=dev/ignore-scripts, локальный undici отсутствует. Реальные пути/версии приведены в сыром выводе ниже. На каждой версии действительно выполнены root/deep imports, fake GET/POST с forwarding/Response identity, native URL/Request/POST/init override, string/Buffer/FormData/File/stream payload, HTTP404/503 как OK, replay string/Buffer и шесть one-shot режимов Request/stream retry/disturbed/locked. У one-shot проверены error identity, один settlement/error, конечный transport error без вечного retry и успешный следующий action. Loopback connections/server закрыты finally. Это локальный smoke 003, не Actions-run и не повтор приёмки 002.

## Матрица D01–D12 и red/green

Historical red ниже сверены с сырыми журналами, заново на старой реализации в этом круге не запускались. Fresh green — текущие check/coverage/package и самостоятельные стыковые пробы, а не прежние вердикты.

| Дефект | Historical red: именованная команда и assertion | Свежий green / граница |
|---|---|---|
| D01 invalid Retry-After requeue | T30.md: timeout 300 node --test d01-original.mjs на pre-T20; Rejected action must never start again, actual3/expected1 | lifecycle D01 terminal action never restarts after invalid-header: starts1/settlement1, queue/inflight0. Устранён T20, отдельный red между принятыми задачами не нужен |
| D02 response observer requeue | T30.md: timeout 300 pnpm test до lifecycle fix; тот же assertion actual3/expected1 | lifecycle D02 и reentrant response throw; terminal не повторяется |
| D03 fetch-error observer escape | T30.md: timeout 300 pnpm test; Finite child must exit naturally, actual1/expected0, secondary failure | strict child0; original error сохранён; защищённая фиксированная warning без payload/URL |
| D04 sync transport/request observer | T30.md: та же команда, два child1/expected0 с original failure | оба strict child0; request throw + late response/rejection удерживает inflight до settlement; reentry не повторяет terminal |
| D05 shared pause | T40.md: timeout 300 pnpm test до pump; No start before receipt +400ms, success actual3/enqueue4, expected2 | scheduler success/enqueue/lateheaders/reentry/max-deadlines/stale wake проходят; старт на400, не399 |
| D06 correction sign | T50.md: pnpm run build:test && node --test --enable-source-maps --test-name-pattern="D06 repeated" __temp/test-build/test/parallel.test.js; correction actual1/expected-1 и actual3/expected-3 | max1/2/4: clamp [1-max,0], effective [1,max], pending/reentry/priority и recovery проходят |
| D07 maxParallelLimit0.1 | T20.md: timeout 300 pnpm test; Missing expected exception: A parallel limit rounding to zero must fail before an action can remain pending | pacing D07: синхронный reject;0.6→1; numeric/header safe boundaries проверены |
| D08 discarded bodies | T60.md: timeout 30 node --test --test-name-pattern='(header\|observer) discards\|finite cancel$' baseline.test.mjs на исходной реализации; семь AssertionError cancel0/expected1 | HTTP429/200/500 × header/observer/late cancel1; finite/rejected/hanging/sync/null, delivered untouched; strict natural-exit loopback. Cleanup введён T30, закреплён T60 |
| D09 queued cancellation/stop | Не входит в closure 003 | Отсутствие planner cancellation/stop явно названо; этап 4 |
| D10 replay | Не заявляется полным исправлением | string/Buffer replay; one-shot transport error и продолжение очереди проверены; body factory/clone/buffering нет; полная политика этап 4 |
| D11 declarations/native Fetch | В этом круге runner намеренно меняет declaration import undici-types→undici в bare consumer и требует TS2307 | TS5/TS7 × bare/undici + native bytes и честный undici Response; exact negatives проходят |
| D12 errorLimits | Characterization незавершённой опции, не red желаемого guard | supplied1/2/3→100/100/100;101 HTTP500/PUT и101429 не останавливаются guard. Форма/defaults владельца сохранены, защиты нет |

Все 13 полезных старых сценариев сохранены: 12 остались в index suite, jitter перенесён в pacing suite с независимой формулой и random0/0.5/1. delaysDiffAvg<10 отсутствует, threshold не увеличивался, случайных повторов до успеха нет. Read-only исторический diff T40 подтверждает неизменённые assertions трёх старых тестов: заменены clocks/ticks и реальные700/300мс ожидания на управляемые с теми же значениями. Diff T90 для index suite меняет generic-аннотации handlers и форматирование, без изменения runtime assertions.

## Ответы на восемь вопросов

1. Подтверждено. Самостоятельные четыре сценария junction.test.mjs сочетают два inflight, request observer enqueue+throw, второй429 с общей паузой400, response callback enqueue с throw/без, late terminal HTTP500 с invalid header и rejected/hanging cancel. До transport settlement inflight остаётся занят, releases0 при двух inflight; поздний response очищен1раз, без parsing/retry/второго terminal. После паузы очередь завершена, settlements каждого action1, releases равны starts, timers максимум1/после drain0. Процесс запущен с strict unhandled-rejections; ошибок нет. Source подтверждает единственный settleAction/finally/discardResponse, отсутствие второго владельца release.
2. Подтверждено. Свежие scheduler/parallel suites проверяют serverNotBefore и correction, поздний success/header update, enqueue/reentry, два429 с коротким/длинным hint, stale callbacks и queue recovery. Общая пауза берёт максимум абсолютных deadline. При снижении effective limit уже отправленные transport сохраняют slots, новые ждут; recovery до max проходит. Собственная стыковая проба добавляет независимые Date jumps во время общей паузы и terminal cleanup.
3. Подтверждено. HTTP200/500 × invalid header/observer/late в body-cleanup дают cancel1, terminal не повторяется; delivered Response сохраняет identity, bodyUsed=false и cancel0. Hanging/rejected/sync cancel не удерживают scheduler. Strict finite child использует реальный single-connection undici Agent и незавершающиеся server bodies;15requests/7cancel calls/7settled cancels/7server closes, finally cleanup и natural exit0. Watchdog проваливает тест; process.exit/unref/private timer access для успешного завершения нет.
4. Подтверждено. scheduler tests для2147483647/2147483648 проверяют первый chunk, остаток1мс, отсутствие раннего старта и TimeoutOverflowWarning; все delays≤2147483647. Numeric options/headers сохраняют safeinteger-длительности без int32 clamp; unsafe absolute deadline отвергается до scheduling. Response policy сохраняет remaining>limit для getter, pacing ограничивает только нормализованный level; partial/missing/prefix semantics сохранены.
5. Подтверждено. Harness jumpWall меняет Date offset независимо от timer/interval time. Свежие scheduler tests двигают Date на+10000000/-900000 без продвижения performance.now; getter равен текущему Date.now()+remaining, старт только на400мс, после drain0. Parallel recovery отдельно проверяет +10000000/-20000000 без изменения correction и восстановление лишь после period+1 монотонного времени. Это различает monotonic и старый Date.now. Собственный junction повторяет оба направления в одном активном сценарии.
6. Подтверждено. Gate требует executed lines/functions всех index/planner/pacing/response-policy/runtime и executed wrapFetch; fetch-types.ts содержит только type declarations, его emitted JS — пустой module marker. Самостоятельно удалён record, обнулены DA и FNDA каждого из пяти модулей:15 целевых отказов; отдельная wrapFetch mutation с ненулевым unrelated counter даёт целевой отказ wrapFetch. Все16 negative probes отвергнуты нужным assertion. Исполняемый модуль не исключён под видом type-only.
7. Подтверждено. Настоящие consumers current tarball TS5.7.3/TS7.0.2 × bare/undici7.3.0 проверили native Request/Response.bytes и undici Response без bytes, matching EventEmitter и exact cross-family/event-method/overload negatives. Consumer compatibility не достигается casts/any/suppressions/skipLibCheck. Runtime fixture и fetch-contract suite подтверждают init.method→Request.method→undefined metadata, forwarding и one-shot error/replay границы. README/architecture и свежие declarations этим границам соответствуют; ложного обещания bytes чужому listener нет.
8. Подтверждено. Decisions сохраняют A1–A7: явный entrypoint подключает новые suites, monotonic harness не ослабляет три старых теста, типовые адаптации не меняют их runtime assertions. ErrorLimits сохранена как исходная незавершённая работа владельца без counters/window/guard; свежий characterization подтверждает это. HANDOFF перечисляет D09/D10/D12,1073 без legacy,no-hints429,stop и настоящий зелёный Actions releasegate, без git status/hash/branch. Его статус ожидания итогового вердикта допустим. Прежний B1 исправлен в source и опубликованных declarations; узкая commentfix сохраняет emitted JS и declarations без комментариев побайтово в12файлах. Ограничение прежнего comment scope не использовано для ослабления цели [ROOT, EXPLICIT, VERIFY].

## Документация и границы релиза

Повторно прочитан исправленный JSDoc src/index.ts/src/planner.ts и извлечены package/build/src/index.d.ts/planner.d.ts из свежего artifact. Универсальное среднее Retry-TimeInterval/RateLimit больше не обещано; явно названы headers feedback, единицы бюджета/веса, отсутствие гарантии темпа/защиты, coefficient1..20, отсутствие runtime ceiling5, jitter/server pause выше maxRequestDelayTimeMs, non429 HTTP errors как OK и незавершённая errorLimits. README/architecture согласованы с lifecycle/ownership/headers-only inflight/slot notification/replay/mutable options. B1 и связанные старые неточности первого partial закрыты в текущей документации, не оставлены долгом.

Загружен навык moysklad-api и его открытый feedback/справочник limits; конфликтующие рекомендации о новой retry policy не перенесены в003: план сохраняет текущий алгоритм [CONSIST, SURFACE]. Свежим read-only открытием сверены публичные [ограничения](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_restrictions.md) и [заголовки/ошибки](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_general.md); датированные оговорки README соответствуют источникам. Вживую не проверено: реальные429/1073, аккаунтные лимиты и эффективность pacing; такие действия запрещены. Дефектов навыка в рамках проверки не выявлено.

Defect closure: D01–D08 закрыты историческими assertion red и свежим green; D11 native/declaration compatibility подтверждена current package matrix. D09 остаётся этапу4; D10 здесь только replayable/one-shot characterization; D12 сохранена без защитного эффекта. Passed003 не доказывает оптимальность, полную защиту от429/отключения API или безопасность повторного бизнес-действия.

До выпуска обязательны отдельные решения этапа4 по D09/stop, полной D10, D12 counters/window/guard,1073 без legacy и429 без временных hints; настоящий зелёный Actions-run со всей runtime matrix/artifact; отдельное разрешение владельца на major/version/changelog/tag/push/publish. Workflow прочитан, не запускался. Следующий этап не начинался; внешних записей, push/tag/version/live/release нет.

## Сырой вывод текущего круга

### check начало

```text
$ pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run knip && pnpm run test
$ tsc --noEmit -p tsconfig.json
$ oxlint --type-aware --report-unused-disable-directives src test samples scripts
$ oxfmt --check "src/**/*.ts" "test/**/*.ts" "test/**/*.mjs" "samples/**/*.ts" "scripts/**/*.mjs" package.json knip.json tsconfig.json tsconfig.prod.json tsconfig.test.json .oxlintrc.json .oxfmtrc.json pnpm-workspace.yaml README.md
Checking formatting...

All matched files use the correct format.
Finished in 5ms on 43 files using 4 threads.
$ knip
Configuration hints (7)
test/index.test.ts            knip.json     Remove redundant entry pattern
test/stress.test.ts           knip.json     Remove redundant entry pattern
test/stress.worker.ts         knip.json     Remove redundant entry pattern
scripts/check-coverage.mjs    knip.json     Remove redundant entry pattern
scripts/check-package.mjs     knip.json     Remove redundant entry pattern
build/src/index.js            package.json  Package entry file not found  
build/src/index.d.ts          package.json  Package entry file not found  
$ pnpm run build:test && pnpm run test:unit
$ rm -rf __temp/test-build/ && tsc -p tsconfig.test.json
```

### check итог

```text
✔ Unsafe absolute retry deadline rejects before scheduling a timer (2.561863ms)
ℹ tests 108
ℹ suites 0
ℹ pass 108
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9451.99223
```

### coverage итог

```text
✔ Two 429 receipts retain the maximum absolute deadline with later hint 500 (2.945077ms)
✔ Response callback enqueue and late success headers cannot shorten a received pause (7.49763ms)
✔ Adaptive pacing can delay a retry beyond the server boundary (2.028828ms)
✔ Empty queue owns no timer while a terminal observer retains the server boundary for later enqueue (2.439528ms)
✔ Unsafe absolute retry deadline rejects before scheduling a timer (26.402699ms)
ℹ tests 108
ℹ suites 0
ℹ pass 108
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10263.965032
--------------------|---------|----------|---------|---------|---------------------
File                | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s   
--------------------|---------|----------|---------|---------|---------------------
All files           |   99.49 |    97.15 |     100 |   99.49 |                     
 index.ts           |     100 |      100 |     100 |     100 |                     
 pacing.ts          |     100 |      100 |     100 |     100 |                     
 planner.ts         |   99.27 |    96.45 |     100 |   99.27 | 404-405,463-464,562 
 response-policy.ts |     100 |      100 |     100 |     100 |                     
 runtime.ts         |     100 |      100 |     100 |     100 |                     
--------------------|---------|----------|---------|---------|---------------------
$ node scripts/check-coverage.mjs
LCOV verified: original src modules (index, planner, pacing, response-policy, runtime), executed lines/functions/wrapFetch, no test/samples
```

### package gates

```text
A6: pnpm pack / absent: current JS, declarations, map, source and package contents
A6: pnpm pack / stale: current JS, declarations, map, source and package contents
A6: npm pack / absent: current JS, declarations, map, source and package contents
A6: npm pack / stale: current JS, declarations, map, source and package contents
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries
A5: ts5, undici=false: native/legacy/custom/subclass/events positives passed
A5: TS 5.7.3, undici=false: exact transport/body/method/event/bytes negatives and declaration closure passed
A5: ts7, undici=false: native/legacy/custom/subclass/events positives passed
A5: TS 7.0.2, undici=false: exact transport/body/method/event/bytes negatives and declaration closure passed
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries
A5: ts5, undici=true: native/legacy/custom/subclass/events positives passed
A5: TS 5.7.3, undici=true: exact transport/body/method/event/bytes negatives and declaration closure passed
A5: ts7, undici=true: native/legacy/custom/subclass/events positives passed
A5: TS 7.0.2, undici=true: exact transport/body/method/event/bytes negatives and declaration closure passed
A5–A8 passed: native and undici Fetch contracts verified on fresh tarball.
```

### junction

```text
✔ Observer reentry, shared pause, late response and reject cleanup; response throw false (10.904989ms)
✔ Observer reentry, shared pause, late response and reject cleanup; response throw true (4.085981ms)
✔ Observer reentry, shared pause, late response and hang cleanup; response throw false (2.214183ms)
✔ Observer reentry, shared pause, late response and hang cleanup; response throw true (1.631549ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 137.289622
```

### coverage-negative

```text
index missing: rejected
index zero-lines: rejected
index zero-functions: rejected
planner missing: rejected
planner zero-lines: rejected
planner zero-functions: rejected
pacing missing: rejected
pacing zero-lines: rejected
pacing zero-functions: rejected
response-policy missing: rejected
response-policy zero-lines: rejected
response-policy zero-functions: rejected
runtime missing: rejected
runtime zero-lines: rejected
runtime zero-functions: rejected
Coverage negative probes: 16 rejected
```

### comment-equivalence

```text
Comment-stripped emitted JS and declarations equal before comment fix: 12 files
```

### static

```text
Static scan: 50 source/fixture files unchanged; no skip/todo/only; 9 offline suites explicit; strict=true/skipLibCheck=false; positive consumer fixtures no casts/any/suppressions (import alias allowed); named configs/lock unchanged
```

### runtime-24.0.0

```text
/tmp/orchestrate-fetch-planner-003/T140-v2/work/tools24/node_modules/node/bin/node
v24.0.0
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries

EXIT=0
```

### runtime-24.22.2

```text
/home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/node/bin/node
v24.22.2
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries

EXIT=0
```

### runtime-26.13.0

```text
/tmp/orchestrate-fetch-planner-003/T140-v2/work/tools26/node_modules/node/bin/node
v26.13.0
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries

EXIT=0
```

### knip

```text
$ knip
Configuration hints (5)
test/index.test.ts            knip.json  Remove redundant entry pattern
test/stress.test.ts           knip.json  Remove redundant entry pattern
test/stress.worker.ts         knip.json  Remove redundant entry pattern
scripts/check-coverage.mjs    knip.json  Remove redundant entry pattern
scripts/check-package.mjs     knip.json  Remove redundant entry pattern
```

## Воспроизводимость самостоятельных проб

Ниже исходники временных проб этого круга; в проект они не добавлялись. Выполнять в allowlist-копии после её build:test/coverage на pinned PATH.

### junction.test.mjs

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {EventEmitter} from 'node:events'
import {Response} from 'undici'
import {FetchPlanner} from './__temp/test-build/src/index.js'
import {createRuntime,trackTimeouts} from './__temp/test-build/test/helpers/runtime.js'
for (const cleanup of ['reject','hang']) for (const throwResponse of [false,true]) {
 test(`Observer reentry, shared pause, late response and ${cleanup} cleanup; response throw ${throwResponse}`,async t=>{
  const rt=createRuntime(t), timers=trackTimeouts(t), events=new EventEmitter()
  const starts=[], pending=[], results=[], settlements=new Map(), errors=[]
  let releases=0,cancels=0
  class Observed extends FetchPlanner {checkFreeRequestSlotTrigger(){releases++;super.checkFreeRequestSlotTrigger()}}
  const planner=new Observed(url=>{starts.push(url);return new Promise(resolve=>pending.push(resolve))},{maxParallelLimit:2,jitter:0,eventHandler:events})
  const enqueue=url=>{const promise=planner.getFetch()(url).then(x=>{settlements.set(url,(settlements.get(url)||0)+1);return x},e=>{settlements.set(url,(settlements.get(url)||0)+1);return e});results.push(promise);return promise}
  const original=new Error('request observer'), secondary=new Error('response observer')
  events.once('request',()=>{enqueue('c');throw original})
  events.on('fetch-error',event=>errors.push(event.error))
  events.once('response',()=>{enqueue('d');if(throwResponse)throw secondary})
  const first=enqueue('a');enqueue('b');await rt.advance(0)
  assert.equal(await first,original);assert.equal(starts.length,2);assert.equal(releases,0);assert.equal(planner.getCurInflightRequestsCount(),2)
  pending[1](new Response(null,{status:429,headers:{'X-Lognex-Retry-After':'400'}}));await rt.flush()
  assert.equal(releases,1);assert.equal(planner.getCurInflightRequestsCount(),1)
  rt.jumpWall(10_000_000);await rt.advance(100)
  const late=new Response('late',{status:500,headers:{'X-RateLimit-Limit':'invalid'}})
  t.mock.method(late.body,'cancel',()=>{cancels++;return cleanup==='reject'?Promise.reject(new Error('cancel')):new Promise(()=>{})})
  pending[0](late);await rt.flush()
  assert.equal(cancels,1);assert.equal(releases,2);assert.equal(planner.getCurInflightRequestsCount(),0)
  assert.equal(planner.getNextRequestTime(),Date.now()+300)
  rt.jumpWall(-20_000_000);assert.equal(planner.getNextRequestTime(),Date.now()+300)
  await rt.advance(299);assert.equal(starts.length,2)
  await rt.advance(1);assert.equal(starts.length,4)
  let answered=2
  for(let round=0;round<4;round++) {while(answered<pending.length)pending[answered++](new Response(null));await rt.advance(0)}
  await Promise.all(results);await rt.advance(1000)
  assert.equal(starts.filter(x=>x==='a').length,1);assert.equal(starts.filter(x=>x==='b').length,throwResponse?1:2)
  assert.deepEqual([...settlements.values()],[1,1,1,1]);assert.equal(errors.length,throwResponse?2:1)
  assert.equal(cancels,1);assert.equal(releases,starts.length);assert.equal(planner.getActionsQueueLength(),0);assert.equal(planner.getCurInflightRequestsCount(),0)
  assert.equal(timers.maximum(),1);assert.equal(timers.active.size,0)
 })
}
```

### coverage-negative.mjs

```js
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const input=readFileSync('coverage/lcov.info','utf8'),records=input.split('end_of_record').filter(x=>x.trim())
let count=0
for(const name of ['index','planner','pacing','response-policy','runtime']) for(const kind of ['missing','zero-lines','zero-functions']) {
 const modified=records.map(record=>!record.includes(`SF:src/${name}.ts\n`)?record:kind==='missing'?'':record.replace(kind==='zero-lines'?/^(DA:\d+,)\d+/gm:/^(FNDA:)\d+/gm,(_,prefix)=>prefix+'0')).filter(x=>x.trim()).map(x=>x+'end_of_record').join('\n')
 writeFileSync('coverage/negative.info',modified)
 const r=spawnSync(process.execPath,['scripts/check-coverage.mjs','coverage/negative.info'],{encoding:'utf8'})
 assert.equal(r.status,1);assert.match(r.stderr,new RegExp(`LCOV (must contain src/${name}\\.ts|src/${name}\\.ts must have executed)`))
 console.log(`${name} ${kind}: rejected`);count++
}
writeFileSync('coverage/negative.info',input.replace(/^(FNDA:)\d+(,wrapFetch)$/gm,(_,a,b)=>a+'0'+b).replace('SF:src/index.ts\n','SF:src/index.ts\nFNDA:1,unrelated\n'))
const r=spawnSync(process.execPath,['scripts/check-coverage.mjs','coverage/negative.info'],{encoding:'utf8'})
assert.equal(r.status,1);assert.match(r.stderr,/must include executed wrapFetch/)
console.log(`Coverage negative probes: ${count+1} rejected`)
```

## Уборка

После сохранения результатов собственная work-копия, Node tooling, runtime consumer, сравниваемые outputs и временные пробы удалены; чужие tooling/prototypes и plan-1.md сохранены. Внешние consumers/sandbox штатного package runner удалены его finally. Единственный изменённый файл проекта — актуальный run/journal/plan.md.

## Закрытие оркестратором

- Итогpassed принят, T140 ивесь003закрыты. ReleaseграницыD09/D10/D12/1073/no-hints429/stop/ActionsсохраненывHANDOFF; этап4не запускался. Ограничениенезависимости(свежиеGPTагентыодногосемейства) учтено, внешнегоревьюне заказывали.
