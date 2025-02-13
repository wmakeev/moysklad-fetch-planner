import { stringify } from 'csv-stringify'
import Moysklad from 'moysklad'
import EventEmitter from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import pRetry from 'p-retry'
import { fetch } from 'undici'
import {
  FetchErrorEvent,
  FetchPlanner,
  FetchPlannerEventMap,
  RequestEvent,
  ResponseEvent
} from '../src/index.js'
import assert from 'node:assert/strict'

const createEvent = (
  type: string,
  processNumber: number,
  ev: RequestEvent | ResponseEvent | FetchErrorEvent,
  planner: FetchPlanner
) => ({
  process: processNumber,
  type,
  response_type:
    'responseType' in ev ? ev.responseType : 'error' in ev ? 'ERROR' : '',
  time: Date.now(),
  action_id: ev.actionId,
  request_id: ev.requestId,
  start_time: ev.startTime,
  end_time:
    'endTime' in ev ? ev.endTime : 'errorTime' in ev ? ev.errorTime : '',
  queue_length: planner.getActionsQueueLength(),
  inflight: planner.getCurInflightRequestsCount(),
  last_delay: planner.getLastRequestDelay(),
  next_request_time: planner.getNextRequestTime(),
  rate_limit: planner.getRateLimit(),
  rate_limit_remaining: planner.getRateLimitRemaining(),
  parallel_limit_correction: planner.getParallelLimitCorrection(),
  error_message:
    'error' in ev
      ? `${ev.error.name}: ${ev.error.message}` +
        (ev.error.cause != null &&
        typeof ev.error.cause === 'object' &&
        'message' in ev.error.cause
          ? ` (${ev.error.cause.message})`
          : '')
      : ''
})

export async function stressTest(params: {
  process: number
  duration: number
}) {
  const { process: processNumber, duration } = params

  const eventHandler = new EventEmitter<FetchPlannerEventMap>()

  const fetchPlanner = new FetchPlanner(fetch, {
    eventHandler,
    maxParallelLimit: 5,
    parallelLimitCorrectionPeriodMs: 5000
  })

  const eventsStream = new PassThrough({
    objectMode: true
  })

  eventHandler.on('request', (ev, planner) => {
    eventsStream.write(createEvent('request', processNumber, ev, planner))
  })

  eventHandler.on('response', (ev, planner) => {
    eventsStream.write(createEvent('response', processNumber, ev, planner))
  })

  eventHandler.on('fetch-error', (ev, planner) => {
    console.log(`worker ${processNumber} request error - ${ev.error.message}`)
    eventsStream.write(createEvent('fetch-error', processNumber, ev, planner))
  })

  const reportFolderPath = path.join(
    process.cwd(),
    `__temp/stress-test/${processNumber}/`
  )

  await mkdir(reportFolderPath, { recursive: true })

  const writeStream = createWriteStream(
    path.join(reportFolderPath, 'report.csv')
  )

  const pipelinePromise = pipeline(
    eventsStream,
    stringify({
      header: true
    }),
    writeStream
  )

  const ms = Moysklad({
    fetch: fetchPlanner.getFetch(),
    retry: (thunk, signal) => {
      return pRetry(thunk, {
        retries: 1,
        shouldRetry: Moysklad.shouldRetryError,
        onFailedAttempt: error => {
          console.log(
            `worker ${processNumber} error - ${error.message}` +
              ` (attempt ${error.attemptNumber} failed /` +
              ` ${error.retriesLeft} retries left)`
          )
        },
        signal
      })
    }
  })

  const promises = []

  let isActive = true

  setTimeout(() => {
    isActive = false
  }, duration)

  const expands = [
    undefined,
    'agent',
    'organization',
    'positions',
    'positions',
    'positions.assortment',
    'positions.assortment.productFolder',
    'agent,positions',
    'agent,positions.assortment',
    'agent,positions.assortment.productFolder',
    'organization,agent,positions',
    'organization,agent,positions.assortment',
    'organization,agent,positions.assortment.productFolder'
  ]

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  for (let i = 0; isActive; i++) {
    console.log(`worker ${processNumber} send request ${i}`)

    await fetchPlanner.waitForFreeRequestSlot()

    const rndChoice = Math.random()

    // Эмулируем HTTP-ошибку
    if (rndChoice > 0.99) {
      ms.fetchUrl(`https://example_${i}`).catch((err: unknown) => {
        assert.ok(err instanceof Error)
      })
    }

    // Генерируем МойСклад ошибку
    else if (rndChoice > 0.97) {
      ms.GET(`foo_${i}`).catch((err: unknown) => {
        assert.ok(err instanceof Error)
      })
    }

    // Генерируем 503 ошибку
    else if (rndChoice > 0.95) {
      ms.fetchUrl(
        `https://online.moysklad.ru/api/remap/1.0/entity/foo${i}`
      ).catch((err: unknown) => {
        assert.ok(err instanceof Error)
      })
    }

    //
    else {
      const resultPromise = ms.GET('entity/demand', {
        limit: Math.round(Math.random() * 20),
        offset: 1 + Math.round(Math.random() * 10),
        expand: expands[Math.round(Math.random() * expands.length)]
      })

      promises.push(resultPromise)
    }
  }

  await Promise.all(promises)

  eventsStream.end()

  await pipelinePromise

  return `${processNumber} OK - ${promises.length}`
}
