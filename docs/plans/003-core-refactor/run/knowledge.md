## Внешние системы

- Live запрещён, лимиты сервера в этом прогоне не исследуются.

## Код и контракты

- Исходная рабочая заготовка errorLimits принадлежит владельцу и сохраняется.
- Baseline B0: typecheck/lint/format:check/knip/test/check проходят, 13 pass; два прежних sample warnings и пять подсказок knip, новых не вносить → journal/B0.md.
- Исходные D01–D08 подтверждены offline; F07 native type и T10 harness/entrypoint assertions красные → journal/B0.md.

- T10 принята: offline entrypoint включает два suite, harness находится в test/helpers/runtime.ts без production injection API → journal/T10.accept-1.md.

- T20 принята: pacing и response-policy чистые; D07 исправлен, формула и defaults сохранены. Long timer chunks ещё T40, lifecycle ещё T30 → journal/T20.accept-1.md.

- T30 принята: terminal lifecycle и observer exceptions проверены, red/green D01–D04 подтверждены; D01 фактически устранён уже T20 → journal/T30.accept-1.md, T30.з1.

- T40 принята: единый pump и monotonic deadline, независимые часы и bounded timer chunks проверены; D05 red/green подтверждён. Correction/recovery остаются T50 → journal/T40.accept-1.md.

- T50 принята: correction ограничена в переходе состояния, max1/2/4 и monotonic recovery проверены; D06 red/green подтверждён → journal/T50.accept-1.md.

- T60 принята: полная ownership/cleanup матрица, strict/loopback и естественный exit проверены; runtime cleanup уже реализован T30, T60 закрепляет D08 регрессиями → journal/T60.accept-1.md.

- T70 принята: фасад index и единственный scheduler owner в planner; все executable modules и wrapFetch включены в gate,32 независимые negative LCOV пробы отвергнуты → journal/T70.accept-1.md.

- T80 принята кругом2: generic Scheduled сохраняет transport input/result, single mapped tuple-union emit держит event/instance связь; @types/node24.19.2 для native bytes доказан отдельно, directundici-types7.3.0 сохраняется → evidence/fetch-contract.md и journal/T80.accept-2.md.

- T90 принята: реальный tarballTS5/TS7×bare/undici, F07red/green, generic/eventboundary контракты проверены; productionJS прежних5модулей идентичен, fetch-types толькоtype-only → journal/T90.accept-1.md.

- T100 принята: native/undici runtime, metadata Request/init и replay границы проверены; one-shot ошибка транспорта не выдаётся за успешный replay → journal/T100.accept-1.md.

- T110 принята: D12 errorLimits characterization и публичная совместимость закреплены, source не менялся → journal/T110.accept-1.md.

- T120 принята: sample warnings устранены, lint/typecheck0warnings/0errors без запуска sample → journal/T120.accept-1.md.

## План и требования: расхождения

- Нет.

## Процесс: уроки и промахи

- Allowlist до чтения: секретные .env и .env.* включая example не открывать, не копировать и не хешировать.
