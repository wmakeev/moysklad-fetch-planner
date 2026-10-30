# T140 — независимая сквозная приёмка плана 003

ИТОГ: partial.

ПРОВЕРЕНО: pnpm check и coverage — по 108 pass,0 fail/skip/todo/cancelled; полная package matrix TS5/TS7×bare/undici — pass; один свежий tarball на Node24.0.0/24.22.2/26.13.0 — pass;4 независимых сценария стыка lifecycle/pump/cleanup и 16 negative LCOV probes — pass.

НЕ ЗАКРЫТО: буквальная цель «Документация больше не обещает универсальную скорость» не выполнена для публичного JSDoc src/index.ts:137–140, который попадает в декларации tarball. README/architecture исправлены, но декларации всё ещё обещают универсальное среднее время. Нужен отдельный узкий возврат на документацию, без изменения runtime и без старта этапа 4.

ПОБОЧНОЕ: ущерба вне области приёмки нет. В проекте записан только этот отчёт; исходные build/coverage не использовались. Существовавший ранее долг JSDoc перечислен ниже; он не внесён этой приёмкой.

ЗАМЕЧАНИЯ: свежий контекст той же GPT-модели из-за недоступности Claude ограничивает независимость; live/Actions не проверялись и не подменяются локальными результатами. D09, полная D10 и D12 остаются этапу 4.

Дата:31.10.2026. Прочитаны целиком brief.md и plan-verifier.md,00-context/01-plan/02-research/03-plan-review, decisions/knowledge и HANDOFF; tasks.md и прошлые accept-отчёты не читались. Из журналов исполнителей использованы разрешённые сырые red/green-доказательства T20/T30/T40/T50/T60. Загружен moysklad-api; правила лимитов сверены с его справочником. Серверные рекомендации навыка не перенесены в алгоритм: план явно сохраняет формулу/legacy-классификацию/retry [CONSIST, SURFACE]. Все новые проверки выполнены самим приёмщиком, без других агентов.

## Изоляция и фактическое окружение

Собственная копия: /tmp/orchestrate-fetch-planner-003/T140-v1/work/. Скопировано 64 разрешённых файла: только названные расширения src/test/samples/scripts, точные конфиги/README/LICENSE и package compiler fixtures *.ts.txt/diagnostics.json. Исключение .env/.env.* применено до чтения/копирования; секретные файлы не открывались и не хешировались. Node_modules — ссылка на уже установленный граф проекта. Project dependencies/lock/manifest/index не менялись; разрешённые consumer и Node tooling installs выполнены только во временных областях. Package runner прочитан до копирования и не менялся, его finally проверил неизменность входов своей копии и удалил consumer/sandbox каталоги.

Pinned PATH перед каждым pnpm-запуском:

```sh
export PATH="/home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/node/bin:/home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/.bin:$PATH"
```

Фактически node --version → v24.22.2; pnpm --version →12.16.1; pnpm exec tsc --version →Version7.0.2. Node24.0.0 и 26.13.0 установлены разрешённым registry tooling npm node@<version> в work/tools24 иwork/tools26, без смены project dependencies. Каждый проверочный процесс ограничен timeout 300; полного package run хватило, нарезка не потребовалась. Fake/loopback runtime не обращался в API МойСклад, live/stress/opt-in/sample не запускались.

## Команды и результаты

Все команды ниже выполнялись из собственной work-копии с pinned PATH; строки вывода сохранены дословно в нижних блоках.

| Проверка/команда | Exit | Результат | Оценка |
|---|---:|---|---|
| timeout 300 pnpm check |0|108 pass,0 fail/cancelled/skipped/todo; typecheck/lint/format/knip проходят|pass|
| timeout 300 pnpm coverage |0|108 pass; LCOV verified для index/planner/pacing/response-policy/runtime иwrapFetch|pass|
| timeout 300 pnpm test:package |0|A5–A8 passed: native and undici Fetch contracts verified on fresh tarball.|pass|
| timeout 300 npm install --prefix tools24 --no-save --package-lock=false --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000 node@24.0.0 |0|added2packages|pass|
| timeout 300 npm install --prefix tools26 --no-save --package-lock=false --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000 node@26.13.0 |0|added2packages|pass|
| timeout 300 npm install --prefix runtime-consumer --ignore-scripts --omit=dev --no-audit --no-fund --package-lock=false --fetch-retries=0 --fetch-timeout=20000 <absolute-tarball> |0|added2packages; local runtime undici absent|pass|
| timeout 300 <Node24.0.0> --unhandled-rejections=strict runtime-consumer/runtime.mjs |0|root/deep/GET/POST/native/one-shot smoke|pass|
| timeout 300 <pinned Node24.22.2> --unhandled-rejections=strict runtime-consumer/runtime.mjs |0|root/deep/GET/POST/native/one-shot smoke|pass|
| timeout 300 <Node26.13.0> --unhandled-rejections=strict runtime-consumer/runtime.mjs |0|root/deep/GET/POST/native/one-shot smoke|pass|
| timeout 300 node --unhandled-rejections=strict --test independent-junction.test.mjs |0|4 pass,0 fail/skip/todo|pass|
| timeout 300 node independent-coverage.mjs, исправленная собственная проба |0|Coverage negative probes:16 rejected|pass|
| timeout 300 pnpm build; timeout 300 pnpm knip |0/0|Production compile; ровно 5 прежних informational Knip hints|pass|
| Статический scan src/test/scripts, включая negative fixtures |0|45 files,0 skip/todo/only; все 9 offline suites включены|pass|
| Словесное ревью README/architecture/HANDOFF/workflow |—|Границы replay/errorLimits/cancellation/release названы явно|pass|
| Ревью JSDoc и извлечение index.d.ts из свежего tarball |0|Универсальное обещание среднего темпа осталось в пакете|не закрыто|

Сначала check в копии без production build показал 7 informational Knip hints:5 прежних и 2 о ещё отсутствующих build/src/index.js/index.d.ts. Это не lint warnings и не отключение checks. После собственной production-сборки knip показал ровно 5 прежних hints. Typecheck/lint дали 0 errors/0 warnings; strict=true, skipLibCheck=false сохранены, новых отключений правил нет. Старые debug c8 ignores и lint directives перенесены со старым кодом; они не скрывают новые исполняемые модули.

## Package и один artifact для runtime matrix

Принятый неизменённый check-package.mjs полностью выполнил pnpm/npm pack×absent/stale build, проверку свежих JS/declarations/map/source и состава tarball, isolated consumers TS5.7.3/TS7.0.2×bare/undici7.3.0, точную negative diagnostic matrix, event boundary и missing declaration dependency gate. Bare consumer не получил runtime undici; direct undici-types7.3.0 сохранился. Положительные fixtures не используют any/cast/ts-ignore/skipLibCheck для обхода совместимости. Внутренние generic casts реализации не являются ослаблением consumer fixtures.

Для всех трёх runtime использован один и тот же последний свежий tarball этого runner, без перепаковки между запусками:

```text
/tmp/orchestrate-fetch-planner-003/T140-v1/work/__temp/package-check/moysklad-fetch-planner-3.2.0.tgz
SHA256 c1dd9ce33d42f968e2eb41bbbcd047bcdfa8ff535bbb3a6a6ceb2958cd9045f8
```

Checksum снят до и после matrix, совпал. Runtime consumer установлен из этого artifact с omit=dev/ignore-scripts; runtime.mjs взят из текущего fixture, заменены только root/deep import specifiers, deep namespace import проверен явно. Реальные пути Node и версии:

```text
/tmp/orchestrate-fetch-planner-003/T140-v1/work/tools24/node_modules/node/bin/node → v24.0.0
/home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/node/bin/node → v24.22.2
/tmp/orchestrate-fetch-planner-003/T140-v1/work/tools26/node_modules/node/bin/node → v26.13.0
```

На каждой версии выполнены root/deep imports, fake GET/POST с identity input/init/Response, native URL/Request/POST/init override, string/Buffer/FormData/File/stream payload, HTTP404/503 как responseType OK, replay string/Buffer и 6 one-shot режимов Request/stream retry/disturbed/locked. Для one-shot проверены transport error identity,1 settlement/error, отсутствие вечного requeue и успешный следующий action. Loopback server/connections очищаются finally, child завершился естественно; force exit/unref/private timer access не добавлялись. Это свежий локальный smoke версии 003, не повтор доказательств 002 и не Actions-run.

## Матрица дефектов и red/green

Historical red ниже сверены по сырым журналам; не выдаются за новые baseline-запуски этой приёмки. Current green получен заново полными check/coverage, а не пересказом старых 13 pass.

| Дефект | Исполняемое доказательство red и команда | Свежий green/граница |
|---|---|---|
| D01 invalid Retry-After requeue | T30.md: timeout 300 node --test d01-original.mjs на исходнике доT20; Rejected action must never start again, actual3/expected1 | lifecycle: D01 terminal action never restarts after invalid-header; starts1/settlement1/queue0/inflight0. Фактически исправленT20, не требуется новый red между принятыми задачами |
| D02 response observer requeue | T30.md: timeout 300 pnpm test до lifecycle fix; тот же assertion, starts3 вместо 1 | lifecycle D02 и reentrant response throw; terminal не повторяется |
| D03 fetch-error observer escape | T30.md: timeout 300 pnpm test; Finite child must exit naturally, child1 вместо 0, secondary failure | strict child exit0, fixed diagnostic без URL/error secrets, исходная ошибка сохранена |
| D04 sync transport/request observer | T30.md: та же команда; два child1 вместо 0, original failure | оба strict child0; reentrant request throw удерживает inflight до late response/rejection, повторного settlement нет |
| D05 shared server pause | T40.md: timeout 300 pnpm test до pump fix; No start before receipt +400ms, success actual3/enqueue4 вместо 2 | scheduler tests: starts отсутствуют до 399ms, разрешены на 400ms; late headers/reentrant/two429/max deadlines/stale wake проходят |
| D06 correction sign | T50.md: pnpm run build:test и node --test --enable-source-maps --test-name-pattern="D06 repeated" .../parallel.test.js; actual1/expected-1 приmax2, actual3/expected-3 приmax4 | max1/2/4 repeated overflows; correction[1-max,0], effective[1,max], recovery и slot priority проходят |
| D07 maxParallelLimit0.1 | T20.md: timeout 300 pnpm test до production fix; Missing expected exception: A parallel limit rounding to zero must fail before an action can remain pending | pacing D07 и numeric options reject unsafe values; constructor synchronous error,0.6→1 |
| D08 discarded bodies | T60.md: timeout 30 node --test --test-name-pattern='(header\|observer) discards\|finite cancel$' baseline.test.mjs на исходной реализации;7 AssertionError cancel0/expected1 | body-cleanup HTTP429/200/500×header/observer/late cancel1, finite/rejected/hanging/sync/null cleanup, delivered body untouched, strict real loopback natural exit. Cleanup введёнT30 и закреплёнT60 |
| D09 queued cancellation/stop | В003 не закрывается, live/watchdog abort probe не запускается | README/architecture/HANDOFF честно сохраняют отсутствие planner cancellation иstop; этап 4 |
| D10 replay | Не объявляется полным исправлением | fake/native/undici иtarball matrix доказывают string/Buffer replay и transport error для one-shot; body factory/clone/buffering не добавлены; полная политика этап 4 |
| D11 declaration closure/native contract | Closure начата 002; в 003 package runner намеренно заменяет declaration import undici-types→missing undici и требует TS2307 bare consumer | TS5/TS7 bare+undici, native Request/Response/bytes и честный undici Response проходят; ошибочные body/method/transport/events/bytes отвергнуты |
| D12 errorLimits | Это characterization незавершённой чужой опции, не red ожидаемого guard | test/compatibility.test.ts: supplied1/2/3→defaults100/100/100;101 HTTP500/PUT и 101429 retries проходят безguard. Форма/defaults сохранены; защиты нет |

Полезные 13 исходных сценариев сохранены:12 остаются в index suite, jitter перенесён в pacing suite с детерминированными random0/0.5/1 иформулой. Read-only diff трёх адаптированных T40 тестов подтверждает сохранённые assertions/scenarios; заменены средства продвижения clocks, добавлены необходимые ticks после enqueue, реальное ожидание recovery заменено управляемым. Threshold не увеличивался, delaysDiffAvg<10 отсутствует. Typing-адаптации event handlers T90 не меняли runtime assertions.

## Ответы на 8 вопросов оркестратора

1. Подтверждено. Помимо текущих lifecycle/body-cleanup suites написаны 4 независимых стыковых пробы:2 inflight; request observer enqueue+throw; второй transport429 сpause400; response observer enqueue сthrow/без; первый terminal transport приходит поздно на 100ms с HTTP500 иinvalid header; cancel rejected/hanging. До late settlement inflight/release не освобождается, поздний terminal Response не парсится/не ретраится иcancel вызывается 1 раз. После pause очередь продолжает работу, каждый action settles1 раз, release равен числу transport starts, unhandled нет под strict. Observerthrow второго action также не стирает уже полученную паузу.
2. Подтверждено. scheduler suite и parallel suite исполняются в check/coverage: enqueue/success/late headers/reentrant не сокращают serverNotBefore, два 429 берут максимум абсолютных deadline, obsolete callbacks не стартуют. Correction clamp применяется в переходе состояния, не только getter. Уже отправленные transport остаются inflight при снижении, новые ждут; recovery допускает снова max. Date jumps не меняют interval time. Дополнительная стыковая проба подтверждает совместную паузу при двух terminal/cleanup путях.
3. Подтверждено. HTTP200/500×invalid header/observer/late дают cancel1, terminal cleanup повторно не выполняется; delivered HTTP200/500 Response сохраняет identity/bodyUsed=false/cancel0. Rejected/hanging/sync cancel не блокирует retry/next. Strict finite child с реальным single-connection undici Agent, незавершающимися server bodies,7 cancellations/closures и 15requests выходит естественно после finally cleanup; watchdog означает fail.
4. Подтверждено. scheduler duration2147483647/2147483648 проверяет границу первогоchunk иостаток 1ms, максимум одного активного timer, все переданные delay≤2147483647, отсутствие TimeoutOverflowWarning. Numeric/policy tests отдельно сохраняют safeinteger durations, reject unsafe/fractional deadlines ине сводят опции кint32. Remaining>Limit сохраняется вgetter, clamp применяется только кнормализованной доле формулы.
5. Подтверждено. createRuntime.jumpWall меняет только Date.now offset, performance.now остаётся фиксированным. scheduler проверяет независимые+10000000/-900000 прыжки и Unix getter Date.now()+remaining; parallel recovery отдельно+10000000/-20000000 безmonotonic advance, затемperiod иperiod+1. Это отличает монотонный контракт от прежнего Date.now. Getter0 послеdrain проверен.
6. Подтверждено. Реальных исполняемых modules5: index/planner/pacing/response-policy/runtime; fetch-types.ts содержит только import type/type aliases. Все 5 имеют executed lines/functions, wrapFetch выполнен. Самостоятельно удалён LCOV record каждого модуля, отдельно обнулены DA и FNDA —15 отказов по соответствующему assertion. Ещё 1 проба обнулила wrapFetch при ненулевом постороннем FNDA — отказ именно wrapFetch gate. Собственная первая версия этой последней пробы ожидала wrapFetch assertion, но раньше сработал общий index functions gate, поскольку wrapFetch — единственная runtime function фасада; probe уточнён добавлением unrelated FNDA, production gate не менялся. Это ошибка ожидания тестовой обвязки, не дефект проекта.
7. Подтверждено в реализованном type/runtime контракте. Native Request/Response.bytes доступны, undici7.3 Response.bytes не обещан и negative fixture отвергается. Matching EventEmitter/handler проходят, cross-family native-handler→undici transport иобратная несовместимая карта не дают ложныйbytes. Tuple-union emit иexact diagnostic line/code matrix сохранены. Request metadata берётinit.method, затем Request.method, иначеundefined; payload/one-shot поведение совпадает с README/architecture. Остаточный старый JSDoc оскорости/потолке/OK не относится кtype inference, но перечислен отдельно какдокументационный долг.
8. Адаптации runtime/types/test entrypoint не ослабили A1–A6; A7 в README/architecture/HANDOFF выполнен. Три старых T40 теста сохранены без ослабления assertions, T90 — типовые адаптации, errorLimits — прежняя форма/defaults безguard. HANDOFF содержитD09/D10/D12,1073 безlegacy,no-hints429,stop иреальный зелёный Actions releasegate, безсостоянияgit. Однако ограничение comment scope T130 оставило публичное обещание универсального среднего в src/index.ts:137–140; оно несовместимо с буквальной сквозной целью 003. Самостоятельно считать его отменой исходной цели нельзя [EXPLICIT, VERIFY]. Поэтому общий итог partial, несмотря на зелёные A1–A6 икорректные основные документы.

## Найденное и границы принятия

B1 — src/index.ts:137–140, переносится в package/build/src/index.d.ts:116–119. Фраза «при постоянной интенсивной нагрузке … задержка всегда выходит на одно и то же среднее … Retry-TimeInterval / RateLimit» продолжает обещать универсальный темп. Это именно цель 003, а не новая задача оптимизации. Основной README явно отрицает такую гарантию, объясняет веса иотдельные identity; потребитель деклараций всё ещё получает обратное утверждение. Упоминание известного долга в HANDOFF прозрачно, но не удаляет обещание из поставляемой документации. Нужен узкий возвратT130 на комментарий; source/runtime в этой приёмке не правился. До этого безусловный passed по всей цели 003 былбы слишком сильным.

Прочие связанные старые неточности, не runtime regressions: src/index.ts:124 пишет coefficient1..10 вместо 1..20; :156 пишет maximum parallel5, хотя валидатор не имеет такого ceiling; :169 обещает жёсткий maxRequestDelayTimeMs, хотя детерминированный расчёт приmax3000/jitter0.1/random0/remaining0 возвращает 3150, аserver pause может быть длиннее; :37 называет OK успешным, хотя 404/503 возвращаются как OK. Их происхождение старое, ограничения T130 comment scope известны, это не ущерб этой приёмки. Устранить рядом сB1 в отдельной документационной задаче; не менять policy, defaults илиruntime под ложный текст [ROOT].

Defect closure: D01–D08 подтверждены historical assertion red и свежим current green; архитектура единого owner иреальные cleanup/type/runtime boundaries подтверждены независимо. D11 compatibility подтверждена полным package runner. Полная защита от 429/отключения аккаунта/неидемпотентного replay не доказана и не заявляется.

Отложенное по принятомуобъёму: D09 cancellation/stop, полнаяD10 replay policy, D12 counters/window/guard,1073 безlegacy и 429 безвременныхhints. Обязательные releasegates: исправить документационный B1 ипринять 003; затем отдельные решенияэтапа 4, настоящий зелёный Actions-run совсейmatrix/artifact, разрешение владельца наmajor/version/changelog/tag/push/publish. Этап 4 здесь не начат, внешнихзаписей/push/tag/version/live/release нет.

## Сырой вывод ключевых проверок

### check: начало и итог

```text
✓ Lockfile passes supply-chain policies (verified 51m ago)
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 222ms using pnpm v12.16.1
$ pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run knip && pnpm run test
$ tsc --noEmit -p tsconfig.json
$ oxlint --type-aware --report-unused-disable-directives src test samples scripts
$ oxfmt --check "src/**/*.ts" "test/**/*.ts" "test/**/*.mjs" "samples/**/*.ts" "scripts/**/*.mjs" package.json knip.json tsconfig.json tsconfig.prod.json tsconfig.test.json .oxlintrc.json .oxfmtrc.json pnpm-workspace.yaml README.md
Checking formatting...

All matched files use the correct format.
Finished in 18ms on 43 files using 4 threads.
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
...
✔ Unsafe absolute retry deadline rejects before scheduling a timer (2.591508ms)
ℹ tests 108
ℹ suites 0
ℹ pass 108
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9094.84367
```

### coverage: итог

```text
✔ Server deadline 2147483648 uses bounded chunks without losing the remainder (1.365239ms)
✔ Two 429 receipts retain the maximum absolute deadline with later hint 100 (2.770005ms)
✔ Two 429 receipts retain the maximum absolute deadline with later hint 500 (4.162548ms)
✔ Response callback enqueue and late success headers cannot shorten a received pause (1.946358ms)
✔ Adaptive pacing can delay a retry beyond the server boundary (1.456973ms)
✔ Empty queue owns no timer while a terminal observer retains the server boundary for later enqueue (1.79978ms)
✔ Unsafe absolute retry deadline rejects before scheduling a timer (4.681994ms)
ℹ tests 108
ℹ suites 0
ℹ pass 108
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9576.558323
--------------------|---------|----------|---------|---------|---------------------
File                | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s   
--------------------|---------|----------|---------|---------|---------------------
All files           |    99.5 |    97.15 |     100 |    99.5 |                     
 index.ts           |     100 |      100 |     100 |     100 |                     
 pacing.ts          |     100 |      100 |     100 |     100 |                     
 planner.ts         |   99.27 |    96.45 |     100 |   99.27 | 404-405,463-464,562 
 response-policy.ts |     100 |      100 |     100 |     100 |                     
 runtime.ts         |     100 |      100 |     100 |     100 |                     
--------------------|---------|----------|---------|---------|---------------------
$ node scripts/check-coverage.mjs
LCOV verified: original src modules (index, planner, pacing, response-policy, runtime), executed lines/functions/wrapFetch, no test/samples
```

### package: все ключевые gates

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
✔ Cross-module late response and rejected cleanup with response throw false (10.626186ms)
✔ Cross-module late response and hanging cleanup with response throw false (3.645306ms)
✔ Cross-module late response and rejected cleanup with response throw true (1.923577ms)
✔ Cross-module late response and hanging cleanup with response throw true (1.734853ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 139.254992
```

### negative coverage

```text
index missing: rejected by target assertion
index zero-lines: rejected by target assertion
index zero-functions: rejected by target assertion
planner missing: rejected by target assertion
planner zero-lines: rejected by target assertion
planner zero-functions: rejected by target assertion
pacing missing: rejected by target assertion
pacing zero-lines: rejected by target assertion
pacing zero-functions: rejected by target assertion
response-policy missing: rejected by target assertion
response-policy zero-lines: rejected by target assertion
response-policy zero-functions: rejected by target assertion
runtime missing: rejected by target assertion
runtime zero-lines: rejected by target assertion
runtime zero-functions: rejected by target assertion
Coverage negative probes: 16 rejected
```

### runtime24.0.0

```text
/tmp/orchestrate-fetch-planner-003/T140-v1/work/tools24/node_modules/node/bin/node
v24.0.0
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries

EXIT=0
```

### runtime24.22.2

```text
/home/mvv/Documents/_Git/@moysklad/fetch-planner/__temp/environment-compat/node_modules/node/bin/node
v24.22.2
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries

EXIT=0
```

### runtime26.13.0

```text
/tmp/orchestrate-fetch-planner-003/T140-v1/work/tools26/node_modules/node/bin/node
v26.13.0
Runtime smoke: root/deep imports, GET/POST, original Response identity
Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries

EXIT=0
```

### knip after build

```text
$ knip
Configuration hints (5)
test/index.test.ts            knip.json  Remove redundant entry pattern
test/stress.test.ts           knip.json  Remove redundant entry pattern
test/stress.worker.ts         knip.json  Remove redundant entry pattern
scripts/check-coverage.mjs    knip.json  Remove redundant entry pattern
scripts/check-package.mjs     knip.json  Remove redundant entry pattern
```

### packed documentation probe

```text
Packed declaration: package/build/src/index.d.ts
117: интенсивной нагрузке на API задержка всегда выходит на одно и то же среднее
118: значение примерно равное отношению `X-Lognex-Retry-TimeInterval` /
146: Задержка между запросами всегда лежит в диапазоне от 0 до `maxRequestDelayTimeMs`.
JSDoc hard ceiling counterexample: maxRequestDelayTimeMs=3000, actual delay=3150
```

### Первая собственная LCOV-проба: уточнение ожидания

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /must include executed wrapFetch/.
AssertionError [ERR_ASSERTION]: LCOV src/index.ts must have executed functions
NEGATIVE_COVERAGE_EXIT=1
```

Это отказ собственной обвязки на ожидаемом отказе gate, не пропущенная отрицательная проверка. После сохранения ненулевого unrelated function counter targeted wrapFetch assertion сработал, все16 проб прошли.

### Публичные первоисточники

Свежим read-only открытием проверены [ограничения](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_restrictions.md) и [заголовки/ошибки](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_general.md): основные формулировки README о весах/identity/параллельности/отключении соответствуют опубликованным правилам. Вживую не проверено: реальные ответы429/1073, общие лимиты аккаунта и эффективность pacing; такие пробы запрещены.

### Источник дополнительных независимых сценариев

Эти временные проверки не добавлялись в проект. Сохранены здесь для воспроизведения после удаления собственной копии.

independent-junction.test.mjs

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {EventEmitter} from 'node:events'
import {Response} from 'undici'
import {FetchPlanner} from './__temp/test-build/src/index.js'
import {createRuntime,trackTimeouts} from './__temp/test-build/test/helpers/runtime.js'
for (const responseThrows of [false,true]) for(const cleanup of ['rejected','hanging']) {
 test(`Cross-module late response and ${cleanup} cleanup with response throw ${responseThrows}`,async t=>{
  const runtime=createRuntime(t);const timers=trackTimeouts(t)
  const events=new EventEmitter();const failure=new Error('request failure');const secondFailure=new Error('response failure')
  const starts=[];const deferred=[];const failures=[];const counts=new Map();let releases=0;let cancellations=0
  class Observed extends FetchPlanner {checkFreeRequestSlotTrigger(){releases++;super.checkFreeRequestSlotTrigger()}}
  const planner=new Observed(url=>{starts.push(url);return new Promise(resolve=>deferred.push({url,resolve}))},{maxParallelLimit:2,jitter:0,eventHandler:events})
  const results=[]
  const enqueue=url=>{const p=planner.getFetch()(url).then(value=>{counts.set(url,(counts.get(url)||0)+1);return value},error=>{counts.set(url,(counts.get(url)||0)+1);return error});results.push(p);return p}
  events.once('request',()=>{enqueue('http://offline.test/c');throw failure})
  events.on('fetch-error',event=>failures.push(event.error))
  events.once('response',()=>{enqueue('http://offline.test/d');if(responseThrows)throw secondFailure})
  const first=enqueue('http://offline.test/a');const second=enqueue('http://offline.test/b')
  await runtime.advance(0);assert.equal(await first,failure)
  assert.equal(starts.length,2);assert.equal(planner.getCurInflightRequestsCount(),2);assert.equal(releases,0)
  deferred[1].resolve(new Response('retry body',{status:429,headers:{'X-Lognex-Retry-After':'400'}}))
  await runtime.flush();assert.equal(planner.getCurInflightRequestsCount(),1);assert.equal(releases,1)
  await runtime.advance(100)
  const late=new Response('late body',{status:500,headers:{'X-Lognex-Retry-After':'0','X-RateLimit-Limit':'invalid'}})
  t.mock.method(late.body,'cancel',()=>{cancellations++;return cleanup==='rejected'?Promise.reject(new Error('cancel failure')):new Promise(()=>{})})
  deferred[0].resolve(late);await runtime.flush()
  assert.equal(cancellations,1);assert.equal(releases,2);assert.equal(planner.getCurInflightRequestsCount(),0)
  assert.equal(planner.getNextRequestTime(),Date.now()+300)
  await runtime.advance(299);assert.equal(starts.length,2)
  await runtime.advance(1);assert.equal(starts.length,4)
  for(let i=2;i<deferred.length;i++)deferred[i].resolve(new Response(null))
  await runtime.advance(0)
  for(let i=4;i<deferred.length;i++)deferred[i].resolve(new Response(null))
  await runtime.flush();await Promise.all(results);await runtime.advance(100)
  assert.equal(cancellations,1);assert.equal(starts.filter(url=>url.endsWith('/a')).length,1)
  assert.equal(starts.filter(url=>url.endsWith('/b')).length,responseThrows?1:2)
  assert.equal(failures.length,responseThrows?2:1);if(responseThrows)assert.equal(await second,secondFailure)
  assert.deepEqual([...counts.values()],[1,1,1,1]);assert.equal(releases,starts.length)
  assert.equal(planner.getActionsQueueLength(),0);assert.equal(planner.getCurInflightRequestsCount(),0);assert.equal(timers.active.size,0);assert.equal(timers.maximum(),1)
 })
}
```

independent-coverage.mjs

```js
import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const source=readFileSync('coverage/lcov.info','utf8')
const records=source.split('end_of_record').filter(s=>s.trim())
let probes=0
for(const name of ['index','planner','pacing','response-policy','runtime']) {
 for(const mutation of ['missing','zero-lines','zero-functions']) {
  const changed=records.map(record=>{
   if(!record.includes(`SF:src/${name}.ts\n`)) return record
   if(mutation==='missing') return ''
   return record.replace(mutation==='zero-lines'?/^(DA:\d+,)\d+/gm:/^(FNDA:)\d+/gm,'$10')
  }).filter(s=>s.trim()).map(s=>s+'end_of_record').join('\n')
  writeFileSync('coverage/negative.info',changed)
  const result=spawnSync(process.execPath,['scripts/check-coverage.mjs','coverage/negative.info'],{encoding:'utf8'})
  assert.equal(result.status,1,`${name} ${mutation}: gate accepted corruption`)
  assert.match(result.stderr,new RegExp(`LCOV src/${name}[.]ts must have executed|LCOV must contain src/${name}[.]ts`))
  console.log(`${name} ${mutation}: rejected by target assertion`); probes++
 }
}
writeFileSync('coverage/negative.info',source.replace(/^(FNDA:)\d+(,wrapFetch)$/gm,'$10$2').replace('SF:src/index.ts\n', 'SF:src/index.ts\nFNDA:1,unrelatedProbe\n'))
const wrap=spawnSync(process.execPath,['scripts/check-coverage.mjs','coverage/negative.info'],{encoding:'utf8'})
assert.equal(wrap.status,1);assert.match(wrap.stderr,/must include executed wrapFetch/)
console.log(`Coverage negative probes: ${probes+1} rejected`)
```

## Уборка

Собственная work-копия, Node tooling и runtime consumer удалены после сохранения доказательств в этом отчёте. Чужие tooling/prototypes не удалялись. Package runner удалил созданные им внешние consumer/sandbox каталоги в finally. Единственная запись в проекте от этой приёмки — обязательный plan.md.
