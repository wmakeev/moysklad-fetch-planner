import asyncTimers from 'node:timers/promises'
import type { StressRequest, StressResult } from './stress.worker.js'

if (process.env['MOYSKLAD_LIVE_STRESS'] !== '1') {
  throw new Error(
    'Live stress is disabled. Set MOYSKLAD_LIVE_STRESS=1 explicitly and supply credentials externally to enable live requests.'
  )
}

const { Piscina } = await import('piscina')

const TASKS = 5
const STEP_TIME_GAP = 6000
const STEP_TIMEOUT = (TASKS + 1) * STEP_TIME_GAP
const workerName = 'stressTest' satisfies keyof typeof import('./stress.worker.js')

const piscina = new Piscina<StressRequest, StressResult>({
  filename: new URL('./stress.worker.js', import.meta.url).href,
  maxThreads: TASKS,
  minThreads: 1,
  maxQueue: TASKS
})

const poolState = { failed: false }
piscina.on('error', () => {
  poolState.failed = true
})

// Attach rejection handlers at dispatch, before the stagger delay or next task.
const pending: Promise<PromiseSettledResult<StressResult>>[] = []
console.time('Stress test time')
try {
  for (let index = 0; index < TASKS; index++) {
    pending.push(
      piscina.run({ process: index + 1, duration: STEP_TIMEOUT }, { name: workerName }).then(
        value => ({ status: 'fulfilled', value }) as const,
        () => ({ status: 'rejected', reason: new Error('STRESS_TASK_FAILED') }) as const
      )
    )
    await asyncTimers.setTimeout(STEP_TIME_GAP)
  }
  const outcomes = await Promise.all(pending)
  if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('STRESS_TASK_FAILED')
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') console.log(outcome.value)
  }
} finally {
  // Drain known tasks before closing the pool; close owns worker termination.
  await Promise.all(pending)
  await piscina.close()
  console.timeEnd('Stress test time')
}

if (poolState.failed) throw new Error('STRESS_POOL_FAILED')
