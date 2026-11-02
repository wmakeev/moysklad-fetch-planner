### Changelog

All notable changes to this project will be documented in this file. Dates are displayed in UTC.

Исторические записи созданы [`auto-changelog`](https://github.com/CookPete/auto-changelog); описание major-перехода подготовлено вручную.

#### 4.0.0 — кандидат, не опубликован

Новый контракт законченной HTTP-операции несовместим с API 3.x. Перед обновлением потребителя прочитайте [руководство миграции](https://github.com/wmakeev/moysklad-fetch-planner/blob/master/docs/migration.md).

Несовместимые изменения:

- Вместо `wrapFetch`/`getFetch` и передачи facade в Fetch SDK используется `planner.submit({ prepare, consume, ... }) → handle`. Автоматического адаптера старого API нет.
- `consume` возвращает полностью обработанное значение, а не raw Response/reader/stream. `handle.result` и `handle.resourcesDone` разделяют результат и физическое завершение ресурсов; после commit ошибка cleanup не отменяет готовое значение.
- Каждая попытка создаёт свежие init/body через `prepare`. Method и signal принадлежат coordinator; внешняя отмена подключается через `handle.abort`.
- Replay требует обеих явных гарантий `serverSafe` и `consumeSafe`, подходящего failure, успешной известной cleanup и оставшихся budgets. HTTP method/status сами по себе не разрешают повтор.
- Вместо EventEmitter/listeners и protected extension hooks используются read-only observation/snapshot и публичные typed hooks `beforeDispatch`/`beforeRetry`. Уведомление не резервирует permit.
- Legacy slot waiters и `errorLimits` заменены bounded admission и локальными receipt/PUT guards. Ограничения относятся к instance, не ко всему аккаунту.
- Требуется Node ≥24 и ESM. Runtime Undici не устанавливается библиотекой; explicit Undici transport потребитель предоставляет отдельно.

Также подготовлены самодостаточные инструкции для агентов, справочник API, руководство разработки и порядок проверки релизного кандидата. CI проверяет compiler families TS5.7/TS7, native/Undici7 consumers и runtime-совместимость Node24/26. Успешные offline/loopback проверки не означают проверку на реальном аккаунте или гарантию оптимальной скорости.

#### [v3.2.0](https://github.com/wmakeev/moysklad-fetch-planner/compare/v3.1.0...v3.2.0)

- fix(wrapFetch): options param typing [`71651a2`](https://github.com/wmakeev/moysklad-fetch-planner/commit/71651a2f2f197faf54a3409ec38fc60275293cbc)
- feat(api): add `method` field to RequestEvent [`9f38563`](https://github.com/wmakeev/moysklad-fetch-planner/commit/9f38563693eaaa128eaa229a5d3ef19538872464)
- docs: add license [`fd3f5dd`](https://github.com/wmakeev/moysklad-fetch-planner/commit/fd3f5dd957ecc1703389fa982354d820a76992a1)

#### [v3.1.0](https://github.com/wmakeev/moysklad-fetch-planner/compare/v3.0.2...v3.1.0)

> 13 February 2025

- feat(events): добавление события `fetch-error` [`f6e9056`](https://github.com/wmakeev/moysklad-fetch-planner/commit/f6e905633391bccc497f05b5af582d80babcf759)

#### [v3.0.2](https://github.com/wmakeev/moysklad-fetch-planner/compare/v3.0.1...v3.0.2)

> 12 February 2025

- fix(test): add retry function [`74dc568`](https://github.com/wmakeev/moysklad-fetch-planner/commit/74dc568aa9a16fb2a2e0b1c963c7276b3dfc65e5)

#### [v3.0.1](https://github.com/wmakeev/moysklad-fetch-planner/compare/v3.0.0...v3.0.1)

> 11 February 2025

- test: добавление end-to-end стресс-теста [`7fc6c82`](https://github.com/wmakeev/moysklad-fetch-planner/commit/7fc6c822a2f80bdd4bdf06d7efbe75d827c0fd6e)
- refactor: удаление лишней проверки в planProcessAction [`0ccf82b`](https://github.com/wmakeev/moysklad-fetch-planner/commit/0ccf82b78da9457ed9c6b93844d980b4ce51091d)
- docs [`369de6e`](https://github.com/wmakeev/moysklad-fetch-planner/commit/369de6eb5a23edaba452d366f531f4dc601029cb)

#### v3.0.0

> 8 February 2025

- initial [`4048992`](https://github.com/wmakeev/moysklad-fetch-planner/commit/4048992216759945ad9954be2d9a9cec27a6f06c)
- feat(refactoring)!: полностью переработанная логика работы [`2e49ee2`](https://github.com/wmakeev/moysklad-fetch-planner/commit/2e49ee23751daf0259d421a4b9bae11833418b21)
- env: удаление package-lock.json [`160089d`](https://github.com/wmakeev/moysklad-fetch-planner/commit/160089deb974a16c80e4022b5442437e04857a90)
