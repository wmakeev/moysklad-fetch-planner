import { Piscina } from 'piscina'
import asyncTimers from 'node:timers/promises'

const TASKS = 3
const COUNT = 100

const piscina = new Piscina({
  // The URL must be a file:// URL
  filename: new URL('./stress.worker.js', import.meta.url).href
})

const promises = []

for (let i = 0; i < TASKS; i++) {
  promises.push(
    piscina.run(
      { workerName: `stress-${i + 1}`, count: COUNT },
      { name: 'stressTest' }
    )
  )
  await asyncTimers.setTimeout(TASKS * COUNT * 5)
}

console.time(`Stress test time`)
const results = await Promise.all(promises)
console.timeEnd(`Stress test time`)

console.log(results)
