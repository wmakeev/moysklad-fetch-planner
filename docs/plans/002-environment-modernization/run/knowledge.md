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
