import Moysklad from 'moysklad'
import { fetch } from 'undici'
import { FetchPlanner } from '../src/index.js'
import asyncTimers from 'node:timers/promises'

/** Кол-во тестовых запросов */
const SAMPLE_REQUEST_COUNT = 100

/** Лимит на кол-во параллельных запросов */
const PARALLEL_LIMIT = 4

const fetchPlanner = new FetchPlanner(fetch, {
  maxParallelLimit: PARALLEL_LIMIT
})

const ms = Moysklad({ fetch: fetchPlanner.getFetch() })

const groupLabel = (caseNum: number) => `Пример №${caseNum}`
const timeLabel = `Время выполнения ${SAMPLE_REQUEST_COUNT} запросов`

//#region Пример №1 - Без контроля над заполнением очереди

// Нет контроля над заполнением очереди
console.group(groupLabel(1))

let case1_maхQueueLength = 0

console.time(timeLabel)

const case1_results = []

for (let i = 1; i < SAMPLE_REQUEST_COUNT; i++) {
  const result = ms.GET('entity/product', {
    offset: Math.round(Math.random() * 100) + 1,
    limit: 1
  })

  case1_results.push(result)

  const curQueueLength = fetchPlanner.getActionsQueueLength()

  if (case1_maхQueueLength < curQueueLength) {
    case1_maхQueueLength = curQueueLength
  }
}

await Promise.all(case1_results)

console.timeEnd(timeLabel)

console.log(`Длина очереди - ${case1_maхQueueLength}`)

console.groupEnd()
//#endregion

await asyncTimers.setTimeout(3500)

//#region Пример №2 - Контроль над заполнением очереди

// Нет контроля над заполнением очереди
console.group(groupLabel(2))

let case2_maхQueueLength = 0

console.time(timeLabel)

const case2_results = []

for (let i = 1; i < SAMPLE_REQUEST_COUNT; i++) {
  await fetchPlanner.waitForFreeRequestSlot()

  const result = ms.GET('entity/product', {
    offset: Math.round(Math.random() * 100) + 1,
    limit: 1
  })

  case2_results.push(result)

  const curQueueLength = fetchPlanner.getActionsQueueLength()

  if (case2_maхQueueLength < curQueueLength) {
    case2_maхQueueLength = curQueueLength
  }
}

await Promise.all(case2_results)

console.timeEnd(timeLabel)

console.log(`Длина очереди - ${case2_maхQueueLength}`)

console.groupEnd()
//#endregion
