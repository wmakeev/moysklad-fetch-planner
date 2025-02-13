import asyncTimers from 'node:timers/promises'
import { Piscina } from 'piscina'

const TASKS = 5
const STEP_TIME_GAP = 6000

const STEP_TIMEOUT = (TASKS + 1) * STEP_TIME_GAP

const piscina = new Piscina({
  // The URL must be a file:// URL
  filename: new URL('./stress.worker.js', import.meta.url).href
})

const promises = []

console.time(`Stress test time`)

for (let i = 0; i < TASKS; i++) {
  promises.push(
    piscina.run(
      {
        process: i + 1,
        duration: STEP_TIMEOUT
      },
      { name: 'stressTest' }
    )
  )
  await asyncTimers.setTimeout(STEP_TIME_GAP)
}

const results = await Promise.all(promises)

console.timeEnd(`Stress test time`)

console.log(results)
