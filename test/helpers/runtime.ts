import type { TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'

/** Test-scoped clocks and randomness. The real immediate drains promise jobs without advancing time. */
export function createRuntime(t: TestContext, now = 1_000_000) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now })
  const random = t.mock.method(Math, 'random', () => 0.5)

  // TestContext also restores these automatically; explicit cleanup documents ownership.
  t.after(() => {
    t.mock.timers.reset()
    t.mock.restoreAll()
  })

  return {
    setRandom(value: number) {
      random.mock.mockImplementation(() => value)
    },
    async flush() {
      await setImmediate()
    },
    async advance(ms: number) {
      await setImmediate()
      t.mock.timers.tick(ms)
      await setImmediate()
    }
  }
}
