import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response } from 'undici'
import { FetchPlanner, OperationError } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'

const originalDate = Date
const originalTimeout = setTimeout
const originalInterval = setInterval
const originalRandom = Math.random

test('Migrated Runtime advances wall time, interval time, timers and promise jobs together', async t => {
  const runtime = createRuntime(t)
  const start = Date.now()
  const events: string[] = []
  const interval = setInterval(() => events.push(`interval:${Date.now() - start}`), 10)
  setTimeout(() => {
    events.push(`timeout:${Date.now() - start}`)
    void Promise.resolve()
      .then(() => events.push('promise'))
      .then(() => events.push('nested promise'))
  }, 10)

  await runtime.advance(9)
  assert.equal(Date.now() - start, 9)
  assert.equal(events.length, 0)
  await runtime.advance(1)
  assert.equal(Date.now() - start, 10)
  assert.deepEqual(events, ['interval:10', 'timeout:10', 'promise', 'nested promise'])
  await runtime.advance(10)
  assert.equal(Date.now() - start, 20)
  assert.equal(events.at(-1), 'interval:20')
  clearInterval(interval)

  void Promise.resolve().then(() => events.push('flushed'))
  await runtime.flush()
  assert.equal(events.at(-1), 'flushed')
  assert.equal(Date.now() - start, 20)
  runtime.setRandom(1)
  assert.equal(Math.random(), 1)
  // Deliberately leave a timer pending: the next test proves it was discarded.
  setTimeout(() => assert.fail('Timer leaked from the previous test'), 1)
})

test('Migrated Runtime restores globals and starts with a clean clock between tests', async t => {
  assert.equal(Date, originalDate)
  assert.equal(setTimeout, originalTimeout)
  assert.equal(setInterval, originalInterval)
  assert.equal(Math.random, originalRandom)
  const runtime = createRuntime(t)
  assert.equal(Date.now(), 1_000_000)
  assert.equal(Math.random(), 0.5)
  await runtime.advance(100)
  assert.equal(Date.now(), 1_000_100)
})

test('Migrated FetchPlanner (jitter)', async t => {
  for (const jitter of [0, 0.3]) {
    for (const random of [0, 0.5, 1]) {
      await t.test(`jitter ${jitter} at random ${random}`, async t => {
        const runtime = createRuntime(t)
        runtime.setRandom(random)
        const starts: number[] = []
        const planner = new FetchPlanner<typeof import('undici').fetch>(
          () => {
            starts.push(Date.now())
            return Promise.resolve(
              new Response(null, {
                headers: {
                  'X-RateLimit-Limit': '10',
                  'X-RateLimit-Remaining': '5',
                  'X-Lognex-Retry-TimeInterval': '1000'
                }
              })
            )
          },
          {
            maxParallelLimit: 1,
            throttlingCoefficient: 1,
            maxRequestDelayTimeMs: 1000,
            jitter
          }
        )
        const spec = {
          method: 'GET' as const,
          replay: { serverSafe: false, consumeSafe: false },
          prepare: () => ({ url: 'http://offline.test/pacing', init: {} }),
          consume: () => 'finished'
        }
        const first = planner.submit(spec)
        const handles = [first]
        try {
          await runtime.advance(0)
          assert.equal((await first.result).value, 'finished')
          await first.resourcesDone
          assert.equal(planner.snapshot().sentActive, 0)

          // Independent oracle: k=0.5, with upper/middle/lower jitter endpoints.
          const expected = Math.round(0.5 * (1000 + 1000 * jitter * (0.5 - random)))
          const second = planner.submit(spec)
          handles.push(second)
          await runtime.advance(0)
          assert.equal(second.snapshot().phase, 'ready', 'JITTER_READY_WAITS')
          assert.equal(planner.snapshot().leasedAttempts, 1)
          assert.equal(planner.snapshot().sentActive, 0)
          await runtime.advance(expected - 1)
          assert.equal(starts.length, 1, 'JITTER_NO_EARLY_DISPATCH')
          assert.equal(second.snapshot().dispatchCalls, 0)
          await runtime.advance(1)
          assert.equal((await second.result).value, 'finished')
          await second.resourcesDone
          assert.deepEqual(starts, [1_000_000, 1_000_000 + expected], 'JITTER_EXACT_DISPATCH')
          assert.equal(second.snapshot().dispatchCalls, 1)
          assert.equal(planner.snapshot().sentActive, 0)
          assert.equal(planner.snapshot().leasedAttempts, 0)
        } finally {
          planner.stop()
          for (const handle of handles) handle.abort()
          await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
        }
      })
    }
  }
})

test('Migrated Runtime elapsed interval reduces planner delay without real waiting', async t => {
  const runtime = createRuntime(t)
  const starts: number[] = []
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () => {
      starts.push(Date.now())
      return Promise.resolve(
        new Response(null, {
          headers: {
            'X-RateLimit-Limit': '10',
            'X-RateLimit-Remaining': '5',
            'X-Lognex-Retry-TimeInterval': '1000'
          }
        })
      )
    },
    { jitter: 0, throttlingCoefficient: 1, maxRequestDelayTimeMs: 1000 }
  )
  const spec = {
    method: 'GET' as const,
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({ url: 'http://offline.test/elapsed', init: {} }),
    consume: () => 'finished'
  }
  const first = planner.submit(spec)
  const handles = [first]
  try {
    await runtime.advance(0)
    await first.result
    await first.resourcesDone
    await runtime.advance(100)
    const second = planner.submit(spec)
    handles.push(second)
    await runtime.advance(0)
    // remaining/limit + elapsed/window = 0.5 + 0.1, so delay = 400.
    assert.equal(second.snapshot().phase, 'ready')
    assert.equal(planner.snapshot().sentActive, 0)
    await runtime.advance(399)
    assert.equal(starts.length, 1, 'ELAPSED_400_NO_EARLY_DISPATCH')
    await runtime.advance(1)
    assert.equal((await second.result).value, 'finished')
    await second.resourcesDone
    assert.deepEqual(starts, [1_000_000, 1_000_500], 'ELAPSED_400_EXACT_DISPATCH')
    const secondStart = starts[1]
    assert.ok(secondStart !== undefined)
    assert.equal(secondStart - 1_000_100, 400)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().leasedAttempts, 0)
  } finally {
    planner.stop()
    for (const handle of handles) handle.abort()
    await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
  }
})

test('Migrated D07 rejects maxParallelLimit rounding to zero synchronously', () => {
  let calls = 0
  assert.throws(
    () =>
      new FetchPlanner<typeof import('undici').fetch>(
        () => {
          calls++
          return Promise.resolve(new Response(null))
        },
        { maxParallelLimit: 0.1 }
      ),
    error =>
      error instanceof OperationError &&
      error.code === 'INVALID_ARGUMENT' &&
      error.operationId === 0 &&
      error.attemptNumber === 0 &&
      !error.dispatchEntered,
    'A parallel limit rounding to zero must fail before an action can remain pending'
  )
  assert.equal(calls, 0, 'D07_REJECTED_BEFORE_ADMISSION')
})
