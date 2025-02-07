import { stringify } from 'csv-stringify'
import Moysklad from 'moysklad'
import EventEmitter from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fetch } from 'undici'
import {
  FetchPlanner,
  FetchPlannerEventMap,
  RequestEvent,
  ResponseEvent
} from '../src/index.js'

const createEvent = (
  type: string,
  workerName: string,
  ev: RequestEvent | ResponseEvent,
  planner: FetchPlanner
) => ({
  workerName,
  type,
  response_type: 'responseType' in ev ? ev.responseType : null,
  time: Date.now(),
  action_id: ev.actionId,
  request_id: ev.requestId,
  start_time: ev.startTime,
  end_time: 'endTime' in ev ? ev.endTime : null,
  queue_length: planner.getActionsQueueLength(),
  inflight: planner.getCurInflightRequestsCount(),
  last_delay: planner.getLastRequestDelay(),
  next_request_time: planner.getNextRequestTime(),
  rate_limit: planner.getRateLimit(),
  rate_limit_remaining: planner.getRateLimitRemaining(),
  parallel_limit_correction: planner.getParallelLimitCorrection()
})

export async function stressTest(params: {
  workerName: string
  count: number
}) {
  const { workerName, count } = params

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
    eventsStream.write(createEvent('request', workerName, ev, planner))
  })

  eventHandler.on('response', (ev, planner) => {
    eventsStream.write(createEvent('response', workerName, ev, planner))
  })

  const reportFolderPath = path.join(
    process.cwd(),
    `__temp/stress-test/${workerName}/report.csv`
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

  const ms = Moysklad({ fetch: fetchPlanner.getFetch() })

  const promises = []

  for (let i = 0; i < count; i++) {
    console.log(`worker ${workerName} send request ${i}`)

    await fetchPlanner.waitForFreeRequestSlot()

    const resultPromise = ms.GET('entity/demand', {
      limit: 0,
      offset: 1 + Math.round(Math.random() * 10)
    })

    promises.push(resultPromise)
  }

  await Promise.all(promises)

  eventsStream.end()

  await pipelinePromise

  return `${workerName} OK - ${promises.length}`
}
