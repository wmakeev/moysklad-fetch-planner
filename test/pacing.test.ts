import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response } from 'undici'
import { calculateRequestDelay, createAttenuationSteps, requestDeadline } from '../src/pacing.js'
import { FetchPlanner } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'

const originalDate = Date
const originalTimeout = setTimeout
const originalInterval = setInterval
const originalRandom = Math.random

test('Runtime advances wall time, interval time, timers and promise jobs together', async t => {
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

test('Runtime restores globals and starts with a clean clock between tests', async t => {
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

test('FetchPlanner (jitter)', async t => {
  for (const jitter of [0, 0.3]) {
    for (const random of [0, 0.5, 1]) {
      await t.test(`jitter ${jitter} at random ${random}`, async t => {
        const runtime = createRuntime(t)
        runtime.setRandom(random)
        const starts: number[] = []
        const planner = new FetchPlanner(
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
        const first = planner.getFetch()('http://offline.test/first')
        await runtime.advance(0)
        await first
        assert.equal(planner.getCurInflightRequestsCount(), 0)

        // k = (1 - remaining / limit)^coefficient = 0.5, no elapsed interval yet.
        // Current jitter is ±jitterRange/2: random 0/0.5/1 gives upper/middle/lower.
        const expected = Math.round(0.5 * (1000 + 1000 * jitter * (0.5 - random)))
        const second = planner.getFetch()('http://offline.test/second')
        assert.equal(planner.getNextRequestTime() - Date.now(), expected)
        await runtime.advance(expected - 1)
        assert.equal(starts.length, 1)
        await runtime.advance(1)
        await second
        assert.equal(planner.getLastRequestDelay(), expected)
        assert.deepEqual(starts, [1_000_000, 1_000_000 + expected])
        assert.equal(planner.getCurInflightRequestsCount(), 0)
      })
    }
  }
})

test('Runtime elapsed interval reduces planner delay without real waiting', async t => {
  const runtime = createRuntime(t)
  const planner = new FetchPlanner(
    () =>
      Promise.resolve(
        new Response(null, {
          headers: {
            'X-RateLimit-Limit': '10',
            'X-RateLimit-Remaining': '5',
            'X-Lognex-Retry-TimeInterval': '1000'
          }
        })
      ),
    { jitter: 0, throttlingCoefficient: 1, maxRequestDelayTimeMs: 1000 }
  )
  const first = planner.getFetch()('http://offline.test/first')
  await runtime.advance(0)
  await first
  await runtime.advance(100)
  const second = planner.getFetch()('http://offline.test/second')
  // remaining/limit + elapsed/window = 0.5 + 0.1, so delay = 400.
  assert.equal(planner.getNextRequestTime() - Date.now(), 400)
  await runtime.advance(400)
  await second
  assert.equal(planner.getLastRequestDelay(), 400)
  assert.equal(planner.getCurInflightRequestsCount(), 0)
})

test('D07 rejects maxParallelLimit rounding to zero synchronously', () => {
  assert.throws(
    () => new FetchPlanner(() => Promise.resolve(new Response(null)), { maxParallelLimit: 0.1 }),
    /maxParallelLimit/,
    'A parallel limit rounding to zero must fail before an action can remain pending'
  )
})

test('Pacing preserves the 101 step formula across remaining, time, coefficient and random', () => {
  for (const coefficient of [1, 2.5, 5, 20]) {
    const table = createAttenuationSteps(coefficient)
    assert.equal(table.length, 101)
    for (const remaining of [0, 1, 25, 49, 50, 99, 100, 101, Number.MAX_SAFE_INTEGER]) {
      for (const elapsed of [0, 4, 5, 100, 499, 1000, 1001]) {
        for (const jitter of [0, 0.1, 0.3]) {
          for (const random of [0, 0.5, 1]) {
            const recoveredPercent = Math.min(
              100,
              Math.round((remaining / 100 + elapsed / 1000) * 100)
            )
            // Compute the attenuation independently, without using the production table.
            const attenuation = ((100 - recoveredPercent) / 100) ** coefficient
            const jitterOffset = 3000 * jitter * (0.5 - random)
            const expected = elapsed >= 1000 ? 0 : Math.round(attenuation * (3000 + jitterOffset))
            const actual = calculateRequestDelay(
              { limit: 100, remaining, retryTimeInterval: 1000, elapsed },
              { maxRequestDelayTimeMs: 3000, jitter },
              table,
              random
            )
            assert.equal(
              actual,
              expected,
              JSON.stringify({ coefficient, remaining, elapsed, jitter, random })
            )
            assert.ok(Number.isSafeInteger(actual) && actual >= 0)
          }
        }
      }
    }
  }
})

test('Pacing handles unknown, partial and over-limit state and clamps clock rollback', () => {
  const options = { maxRequestDelayTimeMs: 1000, jitter: 0 }
  const table = createAttenuationSteps(1)
  for (const [limit, remaining] of [
    [null, null],
    [10, null],
    [null, 0]
  ]) {
    assert.equal(
      calculateRequestDelay(
        { limit: limit ?? null, remaining: remaining ?? null, retryTimeInterval: 1000, elapsed: 0 },
        options,
        table,
        0.5
      ),
      0
    )
  }
  assert.equal(
    calculateRequestDelay(
      { limit: 10, remaining: 0, retryTimeInterval: 1000, elapsed: -100 },
      options,
      table,
      0.5
    ),
    1000
  )
  assert.equal(
    calculateRequestDelay(
      { limit: 10, remaining: 11, retryTimeInterval: 1000, elapsed: 0 },
      options,
      table,
      0.5
    ),
    0
  )
})

test('Pacing rejects unsafe arithmetic and preserves long safe deadlines', () => {
  for (const delay of [0, 2147483647, 2147483648]) {
    assert.equal(requestDeadline(1_000_000, delay), 1_000_000 + delay)
  }
  for (const delay of [NaN, Infinity, -Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requestDeadline(1_000_000, delay))
  }
  assert.throws(() => requestDeadline(Number.MAX_SAFE_INTEGER, 1))
  assert.throws(() => requestDeadline(Infinity, 0))
  assert.throws(
    () =>
      calculateRequestDelay(
        { limit: 1, remaining: 0, retryTimeInterval: 1000, elapsed: 0 },
        { maxRequestDelayTimeMs: Number.MAX_SAFE_INTEGER, jitter: 0.3 },
        createAttenuationSteps(1),
        0
      ),
    /Небезопасное/
  )
})
