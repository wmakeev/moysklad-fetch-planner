## B0 — исходная разведка

- Критерий: фактический baseline и red-наблюдения до изменений; production/test/config не менять.
- Исполнитель B0/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-B0-1-research` · done
- Бриф: /tmp/orchestrate-fetch-planner-003/B0-1/brief.md
- Журнал: journal/B0.md

## T10 — управляемый offline harness и стабильный jitter

- Вид: тесты.
- Источник: ../01-plan.md, T10; F02,F08,F10; A6.
- Критерий: по плану ../01-plan.md, раздел T10.
- Файлы: test/index.test.ts, test/helpers/runtime.ts, test/pacing.test.ts, package.json(test:unit), при необходимости src/index.ts и src/runtime.ts только внутренний seam времени/random без изменения политики.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T10/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T10-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T10-1/brief.md
- Верификатор T10/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T10-1-verifier` · V1 отдельно · passed; отчёт journal/T10.accept-1.md; приёмка поведенческая, та же модель из-за недоступности Claude
- Журнал: journal/T10.md

## T20 — чистая pacing/header policy и безопасные числовые границы

- Вид: правка кода.
- Источник: ../01-plan.md, T20; F03,F10,F12; D07; выбранный контракт.
- Критерий: по плану ../01-plan.md, раздел T20.
- Файлы: src/pacing.ts, src/response-policy.ts, src/index.ts, test/pacing.test.ts, test/response-policy.test.ts, test/index.test.ts.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T20/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T20-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T20-1/brief.md
- Верификатор T20/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T20-1-verifier` · V2 отдельно · passed; отчёт journal/T20.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T20.md

## T30 — единый lifecycle action и обработка исключений

- Вид: правка кода.
- Источник: ../01-plan.md, T30; F03,F10; D01–D04; контракт observer выше.
- Критерий: по плану ../01-plan.md, раздел T30.
- Файлы: src/index.ts, src/action.ts(если нужен), test/lifecycle.test.ts, test/helpers/child.mjs.
- Риск: high · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 3
- Исполнитель T30/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T30-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T30-1/brief.md
- Верификатор T30/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T30-1-verifier` · V3 отдельно · passed; отчёт journal/T30.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T30.md

## T40 — общий serverNotBefore и единственный pump

- Вид: правка кода.
- Источник: ../01-plan.md, T40; F03,F12; D05; A3.
- Критерий: по плану ../01-plan.md, раздел T40.
- Файлы: src/index.ts, src/runtime.ts, test/scheduler.test.ts; package.json только test:unit, test/helpers/runtime.ts и минимальная адаптация трёх старых тестов test/index.test.ts к monotonic clock.
- Риск: high · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 3
- Исполнитель T40/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T40-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T40-1/brief.md
- Верификатор T40/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T40-1-verifier` · V4 отдельно · passed; отчёт journal/T40.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T40.md

## T50 — ограниченная correction и восстановление

- Вид: правка кода.
- Источник: ../01-plan.md, T50; F03; D06; A3.
- Критерий: по плану ../01-plan.md, раздел T50.
- Файлы: src/index.ts, test/parallel.test.ts.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T50/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T50-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T50-1/brief.md
- Верификатор T50/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T50-1-verifier` · V5 отдельно · passed; отчёт journal/T50.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T50.md

## T60 — владение и cleanup непереданных ответов

- Вид: правка кода.
- Источник: ../01-plan.md, T60; F04; D08; A4.
- Критерий: по плану ../01-plan.md, раздел T60.
- Файлы: src/index.ts, src/response-policy.ts, test/body-cleanup.test.ts, test/helpers/child.mjs.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T60/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T60-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T60-1/brief.md
- Верификатор T60/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T60-1-verifier` · V6 отдельно · passed; отчёт journal/T60.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T60.md

## T70 — выделить владельца scheduler и сохранить фасад

- Вид: правка кода.
- Источник: ../01-plan.md, T70; F03,F09,F10; исследование001 §8.
- Критерий: по плану ../01-plan.md, раздел T70 · словесный: да.
- Файлы: src/index.ts, src/planner.ts, src/pacing.ts, src/response-policy.ts, src/runtime.ts, scripts/check-coverage.mjs, test/index.test.ts, test/compatibility.test.ts; knip.json при необходимости обновить entry для внутренних модулей без исключения их из анализа.
- Риск: high · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 3
- Исполнитель T70/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T70-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T70-1/brief.md
- Верификатор T70/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T70-1-verifier` · V7 отдельно · passed; отчёт journal/T70.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T70.md

## T80 — исследовать совместимый Fetch type contract

- Вид: исследование.
- Источник: ../01-plan.md, T80; F07; A5.
- Критерий: по плану ../01-plan.md, раздел T80.
- Файлы: docs/plans/003-core-refactor/evidence/fetch-contract.md, прототип только __temp/plan-core-refactor/types/.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T80/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T80-1-research` · done; бриф /tmp/orchestrate-fetch-planner-003/T80-1/brief.md
- Верификатор T80/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T80-1-verifier` · V8 отдельно · failed; отчёт journal/T80.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T80.md

- Не закрыто круга1: согласованность eventHandler/instance; устранено в круге2 и проверено V9.
- Разбор B1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T80-diagnose-1` · done; бриф /tmp/orchestrate-fetch-planner-003/T80-diagnose-1/brief.md

- Исполнитель T80/2: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T80-2-research` · done; бриф /tmp/orchestrate-fetch-planner-003/T80-2/brief.md

- Верификатор T80/2: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T80-2-verifier` · V9 отдельно · passed; отчёт journal/T80.accept-2.md; свежий контекст, та же модель из-за недоступности Claude

## T90 — реализовать доказанную Fetch совместимость

- Вид: правка кода.
- Источник: ../01-plan.md, T90; F07, выходT80; A5.
- Критерий: по плану ../01-plan.md, раздел T90.
- Файлы: src/index.ts, src/planner.ts, внутренние type helpers, test/package/fixtures/native.ts, test/package/fixtures/without-undici.ts, test/package/fixtures/with-undici.ts, scripts/check-package.mjs, при необходимости @types/node в package.json/pnpm-lock.yaml только по доказанномуT80 контракту.
- Риск: high · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 3
- Исполнитель T90/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T90-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T90-1/brief.md
- Верификатор T90/1: ступень 4 · gpt-6.1-sol (high) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T90-1-verifier` · V10 отдельно · passed; отчёт journal/T90.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T90.md

## T100 — runtime Fetch, metadata и границы replay

- Вид: тесты.
- Источник: ../01-plan.md, T100; F04,F05,F10; D10; A5,A6.
- Критерий: по плану ../01-plan.md, раздел T100.
- Файлы: test/fetch-contract.test.ts, test/package/fixtures/runtime.mjs, src/index.ts/src/planner.ts только нормализация metadata.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T100/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T100-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T100-1/brief.md
- Верификатор T100/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T100-1-verifier` · V11 отдельно · passed; отчёт journal/T100.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T100.md

## T110 — зафиксировать D12 и публичную совместимость

- Вид: тесты.
- Источник: ../01-plan.md, T110; F05,F06,F10; A6,A7.
- Критерий: по плану ../01-plan.md, раздел T110.
- Файлы: test/compatibility.test.ts, test/index.test.ts; src не менять ради завершения errorLimits.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T110/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T110-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T110-1/brief.md
- Верификатор T110/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T110-1-verifier` · V12 отдельно · passed; отчёт journal/T110.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T110.md

## T120 — устранить два прежних sample warnings

- Вид: правка кода.
- Источник: ../01-plan.md, T120; F02; A1.
- Критерий: по плану ../01-plan.md, раздел T120 · словесный: да.
- Файлы: samples/wait-for-request-slot-1.ts.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T120/1: ступень 2 · gpt-6.1-sol (low) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T120-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T120-1/brief.md
- Верификатор T120/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T120-1-verifier` · V13 отдельно · passed; отчёт journal/T120.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T120.md

## T130 — документация фактических гарантий и лимитов

- Вид: текст.
- Источник: ../01-plan.md, T130; F04–F12; A7.
- Критерий: по плану ../01-plan.md, раздел T130 · словесный: да.
- Файлы: README.md, docs/architecture.md.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный
- Вес: 2
- Исполнитель T130/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T130-1-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T130-1/brief.md
- Верификатор T130/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T130-1-verifier` · V14 отдельно · passed; отчёт journal/T130.accept-1.md; свежий контекст, та же модель из-за недоступности Claude
- Журнал: journal/T130.md

- Исполнитель T130/2: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T130-2-implementation` · done; бриф /tmp/orchestrate-fetch-planner-003/T130-2/brief.md.
- Возврат: публичный JSDoc обещает универсальную скорость; исправить только комментарии по исходной цели003, не оставлять внеscopeдолгом.

- Верификатор T130/2: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T130-2-verifier` · V16 отдельно · passed; отчёт journal/T130.accept-2.md.

## T140 — сквозная приёмка003 и передача этапу4

- Критерий: по плану ../01-plan.md, раздел T140 и A1–A7; словесный: A7/передача.
- Файлы: run/journal/plan.md; карту/передачу завершает оркестратор после вердикта.
- Риск: normal · пишет в боевую систему: нет · приёмка: отдельно · объём: полный.
- Верификатор T140/1: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T140-1-verifier` · V15 сквозная приёмка · partial; отчёт journal/plan.md.
- Бриф: /tmp/orchestrate-fetch-planner-003/T140-v1/brief.md.
- Приёмка поведенческая; отдельный исполнитель не требуется, задача сама является приёмкой.

- Верификатор T140/2: ступень 3 · gpt-6.1-sol (medium) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-T140-2-verifier` · V17 сквозная приёмка · passed; отчёт journal/plan.md; прежний partial journal/plan-1.md.
- Бриф повторной приёмки: /tmp/orchestrate-fetch-planner-003/T140-v2/brief.md.

## C0 — техническое уплотнение карточек

- Критерий: tasks.md <=30000 байт без утраты вызовов/кругов/taskId/границ; критерии по ссылкам на первичный план.
- Исполнитель C0/1: ступень 2 · gpt-6.1-sol (low) · t3 `node:delegated-task:command%3Amcp%3A2c6a6d24-3803-4f36-89a0-5f5bf3bedaaf%3Adelegate-task%3A003-C0-1-cleanup` · done; бриф /tmp/orchestrate-fetch-planner-003/C0-1/brief.md.

- Закрытие прогона: все14задач приняты; итоговаяприёмка journal/plan.md, передача .agents/HANDOFF.md.
