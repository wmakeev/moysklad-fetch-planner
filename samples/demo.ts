// Compile-only example. The owner supplies a token explicitly; no automatic execution.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetch } from 'undici'
import { FetchPlanner } from '../src/index.js'
import { consumeDocuments, finishedDocuments } from './types.js'

const TEST_REQUESTS_COUNT = 100
const PAGE_SIZE = 1000
const WINDOW = 6

export const generateRequest = (page: number) => ({
  url: 'https://api.moysklad.ru/api/remap/1.2/entity/invoiceout',
  query: { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), order: 'id,asc' }
})

export async function stage(accessToken: string, procNum = 1, reqCount = TEST_REQUESTS_COUNT) {
  if (!Number.isSafeInteger(reqCount) || reqCount < 1 || reqCount * PAGE_SIZE > 2147483647) {
    throw new Error('Invalid request count')
  }
  if (!Number.isSafeInteger(procNum) || procNum < 1) throw new Error('Invalid process number')

  const planner = new FetchPlanner(fetch, {
    maxParallelLimit: 5,
    maxQueuedOperations: WINDOW,
    maxRequestDelayTimeMs: 3000,
    parallelLimitCorrectionPeriodMs: 1000,
    throttlingCoefficient: 5
  })
  const startTime = performance.now()
  const events: (string | number)[][] = []
  const observation = planner.observe(event => {
    const state = planner.snapshot()
    // Only scalar lifecycle facts; no URL, body, headers, token, value or Error.
    events.push([
      event.sequence,
      event.id,
      event.type,
      event.phase,
      event.status ?? '',
      state.queued,
      state.sentActive,
      Math.round(performance.now() - startTime)
    ])
  })

  try {
    // Finite windows provide producer backpressure; planner alone schedules wire sends.
    for (let first = 0; first < reqCount; first += WINDOW) {
      const pending = Array.from({ length: Math.min(WINDOW, reqCount - first) }, (_, index) => {
        // Capture one logical page before prepare; every replay uses the same query.
        const request = generateRequest(first + index)
        return finishedDocuments(
          planner.submit({
            method: 'GET',
            replay: { serverSafe: true, consumeSafe: true },
            prepare: () => ({
              url: new URL(`${request.url}?${new URLSearchParams(request.query)}`),
              // Fresh init and headers each attempt. GET has no body/upload producer;
              // method and fresh attempt controller/signal belong to the coordinator.
              init: {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept-Encoding': 'gzip' },
                redirect: 'error'
              }
            }),
            consume: consumeDocuments
          })
        )
      })
      // Drain the entire window on failure before stopping; do not lose sibling rejections.
      const outcomes = await Promise.allSettled(pending)
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason
      }
    }
  } finally {
    planner.stop()
    observation.unsubscribe()
  }

  const headers = ['sequence', 'id', 'type', 'phase', 'status', 'queued', 'sentActive', 'time']
  const directory = path.join(process.cwd(), '__temp/fetch-planner')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, `report-proc${procNum}.csv`),
    [headers, ...events].map(line => line.join(',')).join('\n') + '\n'
  )
  const duration = Math.round(performance.now() - startTime)
  console.log(`DONE (${duration}ms, ${Math.round(duration / reqCount)}ms/req).`)
}
