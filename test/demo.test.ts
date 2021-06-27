import fs from 'fs'
import path from 'path'
import Moysklad from 'moysklad'
import nodeFetch from 'node-fetch'
import { wrapFetchApi } from '../src'

const TEST_REQUESTS_COUNT = 300

const addCsvLine = (
  lines: string[][],
  obj: { [key: string]: string | number }
) => {
  if (lines.length === 0) {
    lines.push(Object.keys(obj))
  }

  const headers = lines[0]

  lines.push(headers.map(h => (obj[h] ? String(obj[h]) : '')))
}

const generateRequest1 = () => {
  return {
    url: 'context/employee',
    query: {}
  }
}

const generateRequest2 = () => {
  const month = Math.round(Math.random() * 11)
  const days1 = Math.round(Math.random() * 28) + 1
  const days2 = Math.round(Math.random() * 28) + 1

  return {
    url: 'entity/customerorder',
    query: {
      filter: {
        updated: {
          $gt: new Date(2020, month, Math.min(days1, days2)),
          $lt: new Date(2020, month, Math.max(days1, days2), 23, 59, 59)
        }
      },
      limit: Math.round(Math.random() * 100) + 1
    }
  }
}

async function stage() {
  const requests = [] as string[][]
  const responses = [] as string[][]

  const fetch = wrapFetchApi(nodeFetch, {
    eventHandler: {
      emit(eventName, data) {
        if (eventName === 'request') {
          addCsvLine(requests, data)
        } else if (eventName === 'response') {
          addCsvLine(responses, data)
        }
      }
    }
  })

  const ms = Moysklad({
    apiVersion: '1.2',
    fetch
  })

  const promises = []

  for (let i = 1; i <= TEST_REQUESTS_COUNT; i++) {
    const req = Math.random() > 0.7 ? generateRequest1() : generateRequest2()

    const promise = ms.GET(req.url, req.query).then(() => {
      console.log(`Запрос ${i}`)
    })

    promises.push(promise)
  }

  await Promise.all(promises)

  fs.writeFileSync(
    path.join(process.cwd(), '__temp/requests-9.csv'),
    requests.map(l => l.join()).join('\n')
  )

  fs.writeFileSync(
    path.join(process.cwd(), '__temp/responses-9.csv'),
    responses.map(l => l.join()).join('\n')
  )

  console.log('DONE')
}

stage().catch(err => {
  console.log(err)
})
