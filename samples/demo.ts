/* eslint-disable */
// @ts-nocheck
// node -r dotenv/config ./build/test/demo.test.js -p 1

import fs from 'fs'
import Moysklad from 'moysklad'
import path from 'path'
import undici from 'undici'
import { FetchPlanner, type FetchPlannerOptions } from '../src/index.js'

const TEST_REQUESTS_COUNT = 100

export const generateRequest = () => {
  return {
    // url: 'entity/project/metadata',
    url: 'entity/invoiceout',
    query: {}
  }
}

async function stage(procNum: number, reqCount: number) {
  const eventObjects: Record<string, any>[] = []

  let curEventObject: any = {}

  const eventHandler: FetchPlannerOptions['eventHandler'] = {
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

  const fetchPlanner = new FetchPlanner(undici.fetch, {
    eventHandler,
    maxParallelLimit: 5,
    maxRequestDelayTimeMs: 3000,
    parallelLimitCorrectionPeriodMs: 1000,
    throttlingCoefficient: 5
  })

  const fetch = fetchPlanner.getFetch()
  const trigger = fetchPlanner.waitForFreeRequestSlot()

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

  const reportHeaders = [
    ...eventObjects
      .reduce<Set<any>>((res, it) => {
        Object.keys(it).forEach(key => res.add(key))
        return res
      }, new Set())
      .values()
  ].sort()

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
  throw new Error('Process arg is not number')
}

const rCountParamIndex = process.argv.indexOf('-r')

let rCount = TEST_REQUESTS_COUNT

if (rCountParamIndex !== -1) {
  rCount = Number(process.argv[rCountParamIndex + 1] ?? '100')
}

if (Number.isNaN(rCount)) {
  throw new Error('Requests count arg is not number')
}

stage(proc, rCount).catch(err => {
  console.log(err)
})
