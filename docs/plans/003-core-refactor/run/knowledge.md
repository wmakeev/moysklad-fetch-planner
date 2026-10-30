## Внешние системы

- Live запрещён, лимиты сервера в этом прогоне не исследуются.

## Код и контракты

- Исходная рабочая заготовка errorLimits принадлежит владельцу и сохраняется.
- Baseline B0: typecheck/lint/format:check/knip/test/check проходят, 13 pass; два прежних sample warnings и пять подсказок knip, новых не вносить → journal/B0.md.
- Исходные D01–D08 подтверждены offline; F07 native type и T10 harness/entrypoint assertions красные → journal/B0.md.

- T10 принята: offline entrypoint включает два suite, harness находится в test/helpers/runtime.ts без production injection API → journal/T10.accept-1.md.

## План и требования: расхождения

- Нет.

## Процесс: уроки и промахи

- Allowlist до чтения: секретные .env и .env.* включая example не открывать, не копировать и не хешировать.
