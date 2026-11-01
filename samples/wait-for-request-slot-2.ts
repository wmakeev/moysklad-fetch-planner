// Compile-only comparison of two finite producer windows, using the same planner.
import { fetch } from 'undici'
import { FetchPlanner } from '../src/index.js'
import { consumeDocuments, finishedDocuments } from './types.js'

const SAMPLE_REQUEST_COUNT = 100
const PARALLEL_LIMIT = 4
const MAX_WINDOW = PARALLEL_LIMIT + 1

export async function compareProducerWindows(accessToken: string) {
  // Preselect logical offsets once so the two cases request identical pages.
  const offsets = Array.from(
    { length: SAMPLE_REQUEST_COUNT },
    () => Math.round(Math.random() * 100) + 1
  )
  const results: { window: number; maxQueued: number; durationMs: number }[] = []
  for (const window of [1, MAX_WINDOW]) {
    const planner = new FetchPlanner(fetch, {
      maxParallelLimit: PARALLEL_LIMIT,
      maxQueuedOperations: MAX_WINDOW
    })
    let maxQueued = 0
    const observation = planner.observe(() => {
      maxQueued = Math.max(maxQueued, planner.snapshot().queued)
    })
    const startedAt = performance.now()
    try {
      // Both cases are bounded. Window 1 serializes production; window 5 keeps a
      // small backlog. Neither submits the whole dataset to Promise.all.
      for (let first = 0; first < offsets.length; first += window) {
        const pending = offsets.slice(first, first + window).map(offset =>
          finishedDocuments(
            planner.submit({
              method: 'GET',
              replay: { serverSafe: true, consumeSafe: true },
              prepare: () => {
                const url = new URL('https://api.moysklad.ru/api/remap/1.2/entity/product')
                url.search = new URLSearchParams({
                  offset: String(offset),
                  limit: '1',
                  order: 'id,asc'
                }).toString()
                // Fresh init/headers; GET has no body. Coordinator owns method/signal.
                return {
                  url,
                  init: {
                    headers: {
                      'Authorization': `Bearer ${accessToken}`,
                      'Accept-Encoding': 'gzip'
                    },
                    redirect: 'error'
                  }
                }
              },
              consume: consumeDocuments
            })
          )
        )
        const outcomes = await Promise.allSettled(pending)
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            throw new Error('Product page failed', { cause: outcome.reason })
          }
        }
      }
      const result = { window, maxQueued, durationMs: Math.round(performance.now() - startedAt) }
      results.push(result)
      console.log(result)
    } finally {
      planner.stop()
      observation.unsubscribe()
    }
  }
  return results
}
