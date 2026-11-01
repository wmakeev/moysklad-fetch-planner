// Compile-only document pipeline; the historical filename does not imply a slot API.
import { fetch } from 'undici'
import { FetchPlanner, type Completed } from '../src/index.js'
import _H from 'highland'
import {
  orderlessParallel,
  promiseToStream,
  throughputProbe,
  type ThroughputProbeEvent,
  type ThroughputProbeHandler
} from '@wmakeev/highland-tools'
import assert from 'node:assert/strict'
import * as csv from 'csv-stringify/sync'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  consumeDocuments,
  finishedDocuments,
  type Document,
  type DocumentRef,
  type DocumentCollection
} from './types.js'

const SAMPLE_DOCS_SIZE = 1000
const SAMPLE_BATCH_SIZE = 100
const CASE_NUM = 1
const MAX_BATCH_SIZE = 20
const SOURCE_DELAY_MS = 5
const PARALLEL_LIMIT = 4
const WINDOW = PARALLEL_LIMIT + 1

export async function sample1(accessToken: string) {
  const planner = new FetchPlanner(fetch, {
    maxParallelLimit: PARALLEL_LIMIT,
    maxQueuedOperations: WINDOW,
    // Local bulk-read recipe: five-minute attempt, two attempts within eleven minutes.
    // Finite choices for this workload, not new defaults or a server latency guarantee.
    attemptTimeoutMs: 300000,
    deadlineMs: 660000,
    maxAttempts: 2,
    cleanupGraceMs: 5000
  })
  const active = new Set<Promise<Completed<DocumentCollection>>>()
  const loadOrders = async (query: Record<string, string>) => {
    // Logical page/filter is fixed outside prepare; replay repeats only a read with
    // side-effect-free consume. Never infer safety for a future POST/PUT replacement.
    const handle = planner.submit({
      method: 'GET',
      replay: { serverSafe: true, consumeSafe: true },
      deadlineMs: 660000,
      prepare: () => ({
        url: new URL(
          `https://api.moysklad.ru/api/remap/1.2/entity/customerorder?${new URLSearchParams(query)}`
        ),
        init: {
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept-Encoding': 'gzip' },
          redirect: 'error'
        }
      }),
      consume: consumeDocuments
    })
    // No upload body/resources. Coordinator owns a fresh controller each attempt;
    // finishedDocuments waits for response cleanup separately from result settlement.
    const work = finishedDocuments(handle)
    active.add(work)
    try {
      return (await work).value
    } finally {
      active.delete(work)
    }
  }
  let pipeline: Highland.Stream<Document> | undefined
  try {
    const initial = await loadOrders({
      limit: String(SAMPLE_DOCS_SIZE),
      offset: '0',
      order: 'id,asc'
    })
    const extractDocumentInfo = (doc: Document): DocumentRef => ({
      type: doc.meta.type,
      id: doc.id
    })
    const items = initial.rows.map(extractDocumentInfo)
    const throughputEvents: ThroughputProbeEvent[] = []
    const throughputHandler: ThroughputProbeHandler = event => {
      const throughput = (event.timeEnd - event.timeStart) / event.size
      console.log(`${event.type} throughput ${throughput.toFixed(3)} ms/it`)
      throughputEvents.push(event)
    }

    // 5ms models arrival from the source, not a second HTTP/rate scheduler.
    // Flush on 20 refs or 1s. Downstream demand bounds submissions to WINDOW.
    const batches = _H(items)
      .filter(item => item.type === 'customerorder')
      .ratelimit(1, SOURCE_DELAY_MS)
      .batchWithTimeOrCount(1000, MAX_BATCH_SIZE)

    pipeline = batches
      .map(async batch => {
        assert.ok(batch[0])
        const collection = await loadOrders({
          // Repeated id equality conditions are OR; URLSearchParams encodes the filter.
          filter: batch.map(item => `id=${item.id}`).join(';'),
          limit: String(MAX_BATCH_SIZE),
          offset: '0',
          order: 'id,asc'
        })
        return collection.rows
      })
      .map(promiseToStream)
      .through(orderlessParallel(WINDOW))
      .sequence()
      .through(throughputProbe('fetchedOrders$', 0, SAMPLE_BATCH_SIZE, throughputHandler))

    console.time(`Case ${CASE_NUM}`)
    const ids = await pipeline
      .map(item => item.id)
      .collect()
      .toPromise(Promise)
    console.timeEnd(`Case ${CASE_NUM}`)
    assert.equal(ids.length, items.length)
    // Count alone could miss a duplicated/missing document in a batch.
    assert.deepEqual([...ids].sort(), items.map(item => item.id).sort())

    const directory = path.join(
      process.cwd(),
      `__temp/samples/waitForRequestSlot/PARALLEL_LIMIT=${PARALLEL_LIMIT}/BATCH_SIZE=${MAX_BATCH_SIZE}/`
    )
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'fetched-docs.csv'), csv.stringify(throughputEvents))
    return throughputEvents
  } finally {
    // Stop further production and dispatch, then drain already owned finite work.
    pipeline?.destroy()
    planner.stop()
    await Promise.allSettled([...active])
  }
}
