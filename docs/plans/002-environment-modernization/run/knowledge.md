# Знание прогона

## Внешние системы

- Никаких live, секретов, push, публикации или изменений соседнего проекта.

## Код и контракты

- Baseline T10: 13 offline tests pass, 0 skipped; ESLint 0 errors, 2 прежних warnings samples/wait-for-request-slot-1.ts:105 и :130.
- Oxlint сохраняет 128/148 правил, 6 заменяются эквивалентами, 14 Node-правил потеряны; fs.globSync проходит новый lint, но отвергается прежним guard. → ../evidence/toolchain-compatibility.md
- ErrorLimits не завершать и не откатывать; native Fetch несовместимость остаётся этапу 3.

## План и требования: расхождения

- Нет.

## Процесс: уроки и промахи

- Нет.

- После Node floor24 новый lint warning устранён удалением лишней test-директивы; V2 подтвердил 2 прежних warnings и 13 tests. Node guard возможен на emitted JS без TS5 parser; однако это второй lint шаг. Один oxlint может запретить process.exit, но не заменяет все Node/dependency guards. → ../evidence/node24-floor.md

- T20: pnpm12 strict frozen clean/repeat приняты; version c8 проверять installed manifest/lock, не его --version из cwd root. TS5 и ESLint остаются только до T50. → journal/T20.accept-1.md

- T30: prod/test/typecheck разделены, emit src совпал с baseline. resolveJsonModule нужен декларациям Piscina при skipLibCheck=false; это не ослабление strictness. Demo @ts-nocheck остаётся прежним ограничением. → journal/T30.md

- T40: unit/coverage выполняют13тестов; LCOV измеряет реальное выполнение src и отбрасывает пустое/нулевое. Live guard внутри entrypoint до Piscina import; настоящее live не запускалось. Новый scripts/check-coverage.mjs включить в штатный lint в T50. → journal/T40.accept-1.md

- При копировании/хешировании применять allowlist известных входов; .env и другие секретные файлы исключать до open/read даже ради hash. V6 нарушил запрет, вывода значений не было, временная карта удалена. → journal/T50.accept-1.md
- T50 принят:134правила,TS7,ESLint удалён. Process.exit прямой/computed/destructure ловится,alias объекта не ловится; это измеренный предел синтаксического правила. → ../evidence/toolchain-compatibility.md
