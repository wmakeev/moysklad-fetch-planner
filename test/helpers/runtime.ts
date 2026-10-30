import type { TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'

/** Test-scoped clocks and randomness. The real immediate drains promise jobs without advancing time. */
export function createRuntime(t: TestContext, now = 1_000_000) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now })
  const timerDateNow = Date.now.bind(Date)
  let wallOffset = 0
  t.mock.method(Date, 'now', () => timerDateNow() + wallOffset)
  let monotonic = now
  t.mock.method(performance, 'now', () => monotonic)
  const random = t.mock.method(Math, 'random', () => 0.5)

  // TestContext also restores these automatically; explicit cleanup documents ownership.
  t.after(() => {
    t.mock.timers.reset()
    t.mock.restoreAll()
  })

  return {
    tick(ms: number) {
      monotonic += ms
      t.mock.timers.tick(ms)
    },
    jumpWall(ms: number) {
      wallOffset += ms
    },
    setRandom(value: number) {
      random.mock.mockImplementation(() => value)
    },
    async flush() {
      await setImmediate()
    },
    async advance(ms: number) {
      await setImmediate()
      monotonic += ms
      t.mock.timers.tick(ms)
      await setImmediate()
    }
  }
}

/** Observe the internal scheduler through test-scoped timer mocks, never planner internals. */
export function trackTimeouts(t: TestContext) {
  const active = new Set<NodeJS.Timeout>()
  const callbacks: (() => void)[] = []
  const delays: number[] = []
  let maximum = 0
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  t.mock.method(
    globalThis,
    'setTimeout',
    Object.assign((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const invoke = () => {
        callback(...args)
      }
      callbacks.push(invoke)
      delays.push(delay ?? 0)
      const timer = originalSet(() => {
        active.delete(timer)
        invoke()
      }, delay)
      active.add(timer)
      maximum = Math.max(maximum, active.size)
      return timer
    }, originalSet)
  )
  t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
    if (typeof timer === 'object') active.delete(timer)
    originalClear(timer)
  })
  return { active, callbacks, delays, maximum: () => maximum }
}
