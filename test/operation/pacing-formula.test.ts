import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateRequestDelay, createAttenuationSteps, requestDeadline } from '../../src/pacing.js'

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
