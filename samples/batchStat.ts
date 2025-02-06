import Moysklad from 'moysklad'
import { fetch } from 'undici'
import { DocumentCollection } from './types.js'
import asyncTimers from 'node:timers/promises'

const SAMPLE_DOCS_SIZE = 200
const MEASURE_COUNT = 10

const MEASURE_DELAY = (3000 / 45) * MEASURE_COUNT * 1.2

const ms = Moysklad({ fetch })

const ENTITY_TYPE = 'customerorder'

const ordersColl = (await ms.GET(`entity/${ENTITY_TYPE}`, {
  limit: SAMPLE_DOCS_SIZE
})) as DocumentCollection

const ids = ordersColl.rows.map(it => it.id)

const batchSizes = [1, 2, 3, 5, 10, 15, 20, 30, 50, 100, 150, 180]

for (const size of batchSizes) {
  const batchIds = ids.slice(0, size)

  const sampleMeasures = []

  let i = 0
  while (i++ < MEASURE_COUNT) {
    const timeStart = performance.now()

    await ms.GET(`entity/${ENTITY_TYPE}`, {
      filter: {
        id: batchIds
      }
    })

    const total = performance.now() - timeStart

    await asyncTimers.setTimeout(100)

    sampleMeasures.push(total)
  }

  await asyncTimers.setTimeout(MEASURE_DELAY)

  const measureAvg =
    sampleMeasures.reduce((res, it) => res + it, 0) / sampleMeasures.length

  console.log(JSON.stringify({ batch: size, time: measureAvg }))
}
