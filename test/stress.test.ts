import { Piscina } from 'piscina'
import asyncTimers from 'node:timers/promises'

const TASKS = 5
const TIMEOUT_STEP = 10000

const piscina = new Piscina({
  // The URL must be a file:// URL
  filename: new URL('./stress.worker.js', import.meta.url).href
})

const promises = []

for (let i = 0; i < TASKS; i++) {
  promises.push(
    piscina.run(
      {
        workerName: `stress-${i + 1}`,
        duration: 2 * TIMEOUT_STEP * (TASKS - i)
      },
      { name: 'stressTest' }
    )
  )
  await asyncTimers.setTimeout(TIMEOUT_STEP)
}

console.time(`Stress test time`)
const results = await Promise.all(promises)
console.timeEnd(`Stress test time`)

console.log(results)
