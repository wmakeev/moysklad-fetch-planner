import Moysklad from 'moysklad'
import { fetch } from 'undici'
import { FetchPlanner } from '../src/index.js'
import _H from 'highland'
import {
  orderlessParallel,
  promiseToStream,
  throughputProbe,
  ThroughputProbeEvent,
  ThroughputProbeHandler,
  isNil
} from '@wmakeev/highland-tools'
import assert from 'node:assert'
import * as csv from 'csv-stringify/sync'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Document, DocumentRef, DocumentCollection } from './types.js'

/** Кол-во идентификаторов в источнике данных */
const SAMPLE_DOCS_SIZE = 1000

/** Кол-во элементов по которым формируется отчет по пропускной способности */
const SAMPLE_BATCH_SIZE = 100

/** Номер текущего примера */
const CASE_NUM = 1

/** Группировка при массовой загрузке */
const MAX_BATCH_SIZE = 20

/** Задержка на 1 элемент в источнике */
const SOURCE_DELAY_MS = 5

/** Лимит на кол-во параллельных запросов */
const PARALLEL_LIMIT = 4

/** Включен ли режим триггера по свободным слотам */
const IS_SLOT_WAIT_ON = true

const fetchPlanner = new FetchPlanner(fetch, {
  maxParallelLimit: PARALLEL_LIMIT
})

const ms = Moysklad({ fetch: fetchPlanner.getFetch() })

//#region Подготовка данных для теста

const extractDocumentInfo = (doc: Document): DocumentRef => ({
  type: doc.meta.type,
  id: doc.id
})

console.log('Loading sample docs..')

// Получим 1000 заказов и возьмем у них идентификаторы
const ordersColl = (await ms.GET('entity/customerorder', {
  limit: SAMPLE_DOCS_SIZE
})) as DocumentCollection

const ordersInfo = ordersColl.rows.map(extractDocumentInfo)

//#endregion

async function sample1(items: DocumentRef[]) {
  const throughputEvents = [] as ThroughputProbeEvent[]

  const throughputHandler: ThroughputProbeHandler = ev => {
    const throughput = (ev.timeEnd - ev.timeStart) / ev.size

    console.log(
      `${ev.type === 'inbound' ? '🔽' : '🔼'} ${ev.label} ${ev.type} throughput ${throughput.toFixed(3)} ms/it`
    )

    throughputEvents.push(ev)
  }

  /**
   * Общий поток с идентификаторами документов
   */
  const docs$ = _H(items)

  /**
   * Формируем отдельный поток только для заказов.
   * > В нашем примере это не важно, т.к. есть только один тип документа.
   */
  const orderIds$ = docs$.fork().filter(it => it.type === 'customerorder')

  /**
   * Группы документов сформированные по принципу:
   * - в группе не больше 50 элементов (для большего кол-ва будет слишком
   * большой url фильтра)
   * - ожидание наполнения группы не дольше 1 секунды (если ждать слишком
   * долго мы теряем время на выполнение запроса)
   */
  const ordersBatches$ = orderIds$
    .fork()
    .ratelimit(1, SOURCE_DELAY_MS)
    .consume<DocumentRef[]>(
      (() => {
        let consumeBuffer = [] as DocumentRef[]
        let isWaiting = false

        return (err, it, push, next) => {
          // error
          if (err) {
            push(err)
            next()
          }

          // end of stream
          else if (isNil(it)) {
            if (consumeBuffer.length > 0) {
              push(null, consumeBuffer)
            }
            consumeBuffer = []
            push(null, it)
          }

          // push data
          else {
            consumeBuffer.push(it)

            if (consumeBuffer.length >= MAX_BATCH_SIZE) {
              push(null, consumeBuffer)
              consumeBuffer = []
            }

            next()

            if (!isWaiting && IS_SLOT_WAIT_ON) {
              isWaiting = true

              fetchPlanner
                .waitForFreeRequestSlot()
                .then(() => {
                  isWaiting = false

                  const bufferLen = consumeBuffer.length

                  if (bufferLen > 0) {
                    push(null, consumeBuffer)
                    consumeBuffer = []
                  }
                })
                .catch((err: unknown) => {
                  console.log(err)
                })
            }
          }
        }
      })()
    )

  /**
   * Поток содержащий статистику по массовой загрузке документов:
   * - кол-во загруженных документов за один запрос
   * - время начала запроса
   * - время окончания запроса
   *
   * > Время может не отражать реальную длительность запроса, т.к. запрос
   * может находится какое-то время в очереди планировщика.
   */
  const fetchedOrders$ = ordersBatches$
    .map(async batch => {
      assert.ok(batch[0])

      const type = batch[0].type

      console.log(`fetching batch of ${batch.length} items`)

      await fetchPlanner.waitForFreeRequestSlot()

      const docsColl = (await ms.GET(`entity/${type}`, {
        filter: {
          id: batch.map(it => it.id)
        }
      })) as DocumentCollection

      return docsColl.rows
    })
    .map(promiseToStream)

    // Запросы делаем параллельно с максимально установленным лимитом + 1, чтобы
    // в очереди планировщика всегда был один доступный для выполнения запрос
    .through(orderlessParallel(PARALLEL_LIMIT + 1))
    .sequence()
    .through(
      throughputProbe('fetchedOrders$', 0, SAMPLE_BATCH_SIZE, throughputHandler)
    )

  const ids = await fetchedOrders$
    .map(it => it.id)
    .collect()
    .toPromise(Promise)

  assert.equal(ids.length, items.length)

  return throughputEvents
}

console.time(`Case ${CASE_NUM}`)
const stat = await sample1(ordersInfo)
console.timeEnd(`Case ${CASE_NUM}`)

const STAT_FOLDER_PATH = path.join(
  process.cwd(),
  `__temp/samples/waitForRequestSlot/PARALLEL_LIMIT=${PARALLEL_LIMIT}/BATCH_SIZE=${MAX_BATCH_SIZE}/`
)

await mkdir(STAT_FOLDER_PATH, { recursive: true })

await writeFile(
  path.join(STAT_FOLDER_PATH, 'fetched-docs.csv'),
  csv.stringify(stat)
)
