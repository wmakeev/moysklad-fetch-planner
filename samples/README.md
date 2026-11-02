# Compile only примеры интеграции

Эти функции демонстрируют использование текущего `submit → handle` API и входят в typecheck. Не запускайте и не импортируйте их ради чтения документации или проверки проекта: они содержат обращения к настоящему API, а некоторые записывают локальные CSV. Token передаётся явно при вызове функции; автоматического запуска при импорте нет, но это не разрешает импорт ради проверки.

| Файл | Сценарий |
| --- | --- |
| [demo.ts](demo.ts) | Конечные окна страниц invoiceout и scalar observation |
| [batchStat.ts](batchStat.ts) | Прикладное измерение разных batch sizes customerorder; не benchmark библиотеки |
| [wait-for-request-slot-1.ts](wait-for-request-slot-1.ts) | Document batching и backpressure producer через Highland |
| [wait-for-request-slot-2.ts](wait-for-request-slot-2.ts) | Сравнение конечных producer windows при одном planner на сценарий |
| [types.ts](types.ts) | Минимальные projections, законченный consume и отдельное ожидание resourcesDone |

Имена wait-for-request-slot сохранены как исторические имена файлов; удалённого slot API в коде нет. Для нового интеграционного кода начинайте с [руководства агента](../docs/agent-guide.md) и [API](../docs/api.md), а не с массового запуска этих сценариев. Модели и правила vendor API сверяются отдельно с актуальными первичными источниками.
