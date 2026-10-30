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

## План и требования: расхождения

- Нет.

## Процесс: уроки и промахи

- Allowlist до чтения: секретные .env и .env.* включая example не открывать, не копировать и не хешировать.
