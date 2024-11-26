import fs from 'fs'
import Moysklad from 'moysklad'
import pRetry from 'p-retry'
import path from 'path'
import undici from 'undici'
import {
  FetchPlanner,
  type RetryStrategyFunction,
  type FetchPlannerParams
} from '../src/index.js'

const TEST_REQUESTS_COUNT = 200

export const generateRequest = () => {
  return {
    url: 'entity/project/metadata',
    query: {}
  }
}

async function stage(procNum: number, reqCount: number) {
  const eventObjects: any[] = []

  let curEventObject: any = {}

  const eventHandler: FetchPlannerParams['eventHandler'] = {
    emit(eventName, data) {
      curEventObject = {
        ...curEventObject,
        ...fetchPlanner.getInternalState(),
        ...(typeof data === 'object'
          ? data
          : data != null
          ? { [eventName]: data }
          : {}),
        time: Date.now() - startTime
      }

      eventObjects.push(curEventObject)
    }
  }

  const fetchRetry: RetryStrategyFunction = async thunk => {
    return await pRetry(thunk, {
      onFailedAttempt: error => {
        console.log(
          `[FETCH ERROR] ${
            (error as any).cause?.message ?? error.message
          } (retry ${error.attemptNumber} left ${error.retriesLeft})`
        )
      },
      retries: 1
    })
  }

  const fetchPlanner = new FetchPlanner(undici.fetch, {
    eventHandler,
    retry: fetchRetry
  })

  const fetch = fetchPlanner.getFetch()
  const trigger = fetchPlanner.getTrigger()

  const ms = Moysklad({
    apiVersion: '1.2',
    fetch
  })

  const promises = []

  const startTime = Date.now()

  for (let i = 1; i <= reqCount; i++) {
    const req = generateRequest()

    await trigger()

    const promise = ms.GET(req.url, req.query).then(() => {
      console.log(`Запрос ${i}`)
    })

    promises.push(promise)
  }

  await Promise.all(promises)

  const endTime = Date.now()

  const reportHeaders = Object.keys(
    eventObjects.reduce((res, it) => {
      return Object.keys(it).length > Object.keys(res).length ? it : res
    })
  )

  const reportLines = [reportHeaders]

  for (const event of eventObjects) {
    const line = reportHeaders.reduce((line, header) => {
      line.push(event[header])
      return line
    }, [] as string[])

    reportLines.push(line)
  }

  fs.writeFileSync(
    path.join(process.cwd(), `__temp/fetch-planner/report-proc${procNum}.csv`),
    reportLines.map(l => l.join()).join('\n') + '\n'
  )

  const duration = Math.round(endTime - startTime)
  const avgRequestDuration = Math.round(duration / reqCount)

  console.log(`DONE (${duration}ms, ${avgRequestDuration}ms/req).`)
}

const procParamIndex = process.argv.indexOf('-p')

let proc = 1

if (procParamIndex !== -1) {
  proc = Number(process.argv[procParamIndex + 1] ?? '1')
}

if (Number.isNaN(proc)) {
  throw new Error('Procees arg is not number')
}

const rcountParamIndex = process.argv.indexOf('-r')

let rcount = TEST_REQUESTS_COUNT

if (rcountParamIndex !== -1) {
  rcount = Number(process.argv[rcountParamIndex + 1] ?? '100')
}

if (Number.isNaN(rcount)) {
  throw new Error('Requests count arg is not number')
}

stage(proc, rcount).catch(err => {
  console.log(err)
})
