// Compile-only measurement of customerorder filter batches; never an account benchmark here.
import { fetch } from 'undici'
import { FetchPlanner } from '../src/index.js'
import { consumeDocuments, finishedDocuments } from './types.js'
import asyncTimers from 'node:timers/promises'

const SAMPLE_DOCS_SIZE = 200
const MEASURE_COUNT = 10
// Measurement cooldown only; planner owns all HTTP pacing/retries (weights vary).
const MEASURE_DELAY = (3000 / 45) * MEASURE_COUNT * 1.2
const batchSizes = [1, 2, 3, 5, 10, 15, 20, 30, 50, 100, 150, 180]

export async function batchStat(accessToken: string) {
  const planner = new FetchPlanner(fetch, {
    maxParallelLimit: 1,
    maxQueuedOperations: 1,
    // Heavy-read example budgets are finite and explicit. Vendor bulk requests may
    // take minutes; 30s is not a universal budget. No library default is changed.
    attemptTimeoutMs: 300000,
    deadlineMs: 660000,
    maxAttempts: 2,
    cleanupGraceMs: 5000
  })
  const loadOrders = async (query: Record<string, string>) => {
    const completed = await finishedDocuments(
      planner.submit({
        method: 'GET',
        replay: { serverSafe: true, consumeSafe: true },
        deadlineMs: 660000,
        prepare: () => {
          const url = new URL('https://api.moysklad.ru/api/remap/1.2/entity/customerorder')
          url.search = new URLSearchParams(query).toString()
          // Preserve the historical 180-id measurement only when the encoded URL fits.
          // A future larger input must be split explicitly rather than silently truncated.
          if (url.href.length > 8200) throw new Error('Document filter exceeds URL budget')
          return {
            url,
            init: {
              headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept-Encoding': 'gzip' },
              redirect: 'error'
            }
          }
        },
        // Fresh GET init/URL each attempt, no body producer/disposer required.
        // Decode and HTTP errors stay failures, never a successful empty collection.
        consume: consumeDocuments
      })
    )
    return completed.value
  }
  const measurements: { batch: number; time: number }[] = []
  try {
    const collection = await loadOrders({
      limit: String(SAMPLE_DOCS_SIZE),
      offset: '0',
      order: 'id,asc'
    })
    const ids = collection.rows.map(item => item.id)
    // Avoid silently labelling a smaller request as a 180-document measurement.
    if (ids.length < 180) throw new Error('At least 180 sample orders are required')
    for (const size of batchSizes) {
      // Capture business selection before attempts; no new identities/payloads on replay.
      const filter = ids
        .slice(0, size)
        .map(id => `id=${id}`)
        .join(';')
      const measures: number[] = []
      for (let index = 0; index < MEASURE_COUNT; index++) {
        const startedAt = performance.now()
        await loadOrders({ filter, limit: String(size), offset: '0', order: 'id,asc' })
        measures.push(performance.now() - startedAt)
        await asyncTimers.setTimeout(100)
      }
      await asyncTimers.setTimeout(MEASURE_DELAY)
      const measurement = {
        batch: size,
        time: measures.reduce((sum, time) => sum + time, 0) / measures.length
      }
      measurements.push(measurement)
      console.log(JSON.stringify(measurement))
    }
    return measurements
  } finally {
    // Every sequential operation has already awaited resourcesDone, also on failure.
    planner.stop()
  }
}
