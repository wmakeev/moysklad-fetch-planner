# Подключение библиотеки агентом

Этот маршрут предназначен агенту, который пишет интеграцию в потребляющем приложении. Для изменения самой библиотеки начните с [AGENTS.md](../AGENTS.md) и [разработки](development.md). Полный контракт сосредоточен в [API](api.md); локальные планы и история чата для работы не требуются.

## Установить точную поставку

Ветка GitHub содержит новый major API; manifest ещё 3.2.0, опубликованная старая npm-версия имеет другой интерфейс. До нового релиза используйте tarball из успешного Actions run для выбранного commit. Совпадение номера версии не доказывает совпадения API.

1. Выберите commit, для которого завершён workflow Check and runtime compatibility. Сверьте headSha, conclusion=success и jobs, а не только зелёный badge ветки.
2. Получите artifact `runtime-package` этого run. Он содержит `package.tgz`, `runtime.mjs` и `SHA256SUMS`. Artifact хранится ограниченное время; если он истёк, не заменяйте его файлом от другого ref. Запросите проверенный кандидат либо согласуйте новый run нужного ref.
3. Проверьте контрольные суммы и запишите происхождение: commit, run URL и SHA256 package.tgz. Доверенная контрольная сумма передаётся вместе с выбранным источником; сам файл SHA256SUMS не удостоверяет автора.
4. Установите package.tgz в приложение, затем проверьте exports и типы своего consumer. Не используйте исходные `.ts` как runtime entrypoint.

Если есть авторизованный `gh`, RUN_ID задайте номером выбранного успешного run, ARTIFACT_DIR — новым абсолютным каталогом для скачивания:

```sh
gh run view "$RUN_ID" --repo wmakeev/moysklad-fetch-planner --json headSha,conclusion,url
gh run download "$RUN_ID" --repo wmakeev/moysklad-fetch-planner --name runtime-package --dir "$ARTIFACT_DIR"
(cd "$ARTIFACT_DIR" && sha256sum --check SHA256SUMS)
npm install "$ARTIFACT_DIR/package.tgz"
```

Эти команды не запускают приложенный runtime.mjs. Не импортируйте его ради чтения документации. После выхода нового major устанавливайте явно выбранную версию и читайте документацию соответствующего tag/commit. Ошибку установки или отсутствие прав не обходите установкой старого npm latest.

## Выбрать транспорт и область coordination

- Для native используйте конкретный `typeof globalThis.fetch`; для Undici7.3 — конкретный `typeof fetch` этой версии. Не объединяйте их в union и не исправляйте body/response typing приведениями.
- Один общий instance должен видеть операции одной выбранной области coordination. Несколько instances или процессов не образуют account-wide лимитер.
- Убедитесь, что transport не делает скрытых повторов. `dispatchCalls` считает входы в F; redirects и внутренние wire tries не становятся отдельными planner attempts.
- Собственный native dispatcher должен быть совместим с Undici внутри Node. Тестовые Agent7/Agent8 не являются production-адаптером библиотеки. Undici8 добавлен только для native test fixture; это не новая публичная Undici8 transport family.

## Собрать одну операцию

1. До submit зафиксируйте business identity, method, логический payload и обе replay flags. При отсутствии доказанной server/consume safety используйте false/false. Для PUT задайте стабильный entityKey одной сущности для всего instance.
2. В prepare создавайте fresh URL/init/body каждой attempt. Не задавайте init.method/init.signal. После приобретения ресурса сразу зарегистрируйте onDispose до следующего await; partial acquisition при ошибке до регистрации очищает сам callback.
3. В consume прочитайте тело до конца, проверьте HTTP, Content-Type, схему и бизнес-ошибки. Все non429 статусы, включая412 и500, принадлежат consume. Верните законченное значение, не Response/reader/stream.
4. Если consume создаёт временный результат, сразу зарегистрируйте onDiscard. Публикация файла, сообщения или бизнес-commit выполняется приложением после успешного result, чтобы проигравшая отмене работа не опубликовалась до commit.
5. Сохраните handle, обработайте result и отдельно resourcesDone. Handle не thenable; failed handle с id=0 тоже требует обработки result.

Native, Undici, bulk/upload и hook snippets находятся в [API](api.md). Для МойСклад приложение само передаёт auth/gzip headers и разбирает ошибки API. Никогда не переносите token, raw body, URL с параметрами или cause в общую observation telemetry.

## Выбрать реакцию на отказ

| Ситуация | Действие агента |
| --- | --- |
| QUEUE_FULL | Замедлить producer; не увеличивать бесконтрольно число сохранённых specs |
| Неизвестный исход отправленной записи | Выполнить прикладную сверку по устойчивой identity; не resubmit вслепую |
| Ошибка JSON, схемы или БД | Оставить прикладной ошибкой; не маркировать как wire-read failure |
| Настоящая read failure на HTTP2xx | Только в своём consume использовать retryableReadFailure; проверить обе replay flags, cleanup и budgets |
| Result succeeded, cleanup pending/failed | Сохранить готовое value; отдельно учесть ресурсную проблему |
| GUARD_OPEN или STOPPED | Остановить producer; не пересоздавать instance для обхода защиты |
| Hook timeout при pending callback | Сохранить учёт lease/resources; не считать callback остановленным |

Внешний retry-loop не должен обходить эти решения. Даже обе true flags не разрешают автоматический повтор произвольного HTTP500/503, parser error, timeout или cleanup failure. Полная таблица кодов и исключений — [API](api.md).

## Ограничить producer и обработать отмену

Подавайте конечные окна работы. Сохраняйте handles окна, присоединяйте rejection handlers ко всем results сразу и при ошибке одного учитывайте остальных через allSettled. Размер очереди не ограничивает размер body/замыканий или память приложения. Сценарии producer windows описаны в [samples](../samples/README.md), но их нельзя запускать автоматически.

Для внешнего AbortSignal проверьте уже отменённый signal до submit. Сразу после получения handle поставьте abort listener, вызывающий handle.abort(signal.reason), затем повторно проверьте signal.aborted, чтобы не пропустить отмену при подключении. Снимите listener после нужного периода учёта. Отмена после фактической отправки не гарантирует отсутствия записи на сервере; результат гонки определяет handle, не последующий signal.aborted.

## Подключить observation или control

Observe возвращает атомарный initial snapshot и unsubscribe. События содержат только scalar факты, listener return игнорируется. Для корреляции используйте ограниченный внешний registry по handle.id, не включайте в Event business payload. Здоровье и ошибки exporter учитывайте отдельно.

Для решения allow/deny/defer используйте beforeDispatch/beforeRetry. Allow и пробуждение timer не являются permit: coordinator заново проверяет ограничения. Зависимый submit того же planner нельзя вызывать из prepare/consume/dispose/discard/hook, даже после await. Запускайте зависимые операции снаружи после результата. Особые Promise constructor/species boundaries описаны в [API](api.md).

## Завершить работу

Сначала прекратите producer. Для drain оставьте planner работающим и учитывайте results/resourcesDone принятых handles в собственном окне shutdown, затем вызовите stop. Для немедленного запрета новых отправок вызовите stop сразу: queued/retry-wait/preparing/ready операции будут отклонены. Уже sent попытка не abort-ится одним stop.

Stop возвращает void, не Promise drain. Истечение окна shutdown не превращает pending в released. Перед выходом приложения перечислите unresolved работу безопасными метаданными и примените согласованную политику host. Не потеряйте value уже зафиксированного результата из-за поздней отмены или очистки.

## Проверить интеграцию

Проверьте используемые пути с fake/loopback: успех, non429 error details, безопасный429 retry, отмену, pending/failed cleanup, backpressure и shutdown. Не используйте live-запись или повышенную нагрузку ради доказательства корректности примера. Для массового обмена добавьте выбранные сценарии и наблюдение из [интеграции](integration-guide.md); локальные tests и CI не доказывают оптимальность pacing или защиту всего аккаунта.
