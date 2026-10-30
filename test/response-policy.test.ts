import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Headers, Response } from 'undici'
import { FetchPlanner } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'
import { parseResponsePolicy } from '../src/response-policy.js'

const headers = [
  ['x-ratelimit-limit', 'limit', false],
  ['x-ratelimit-remaining', 'remaining', true],
  ['x-lognex-retry-timeInterval', 'retryTimeInterval', false],
  ['x-lognex-retry-after', 'retryAfterMs', true]
] as const

for (const [name, field, zeroAllowed] of headers) {
  test(`Header policy validates ${name} without changing its input`, () => {
    const input = new Headers()
    assert.equal(parseResponsePolicy(429, input)[field], null)
    for (const raw of [
      '0',
      '7',
      '7ms',
      'NaN',
      'Infinity',
      '-Infinity',
      '-1',
      '9007199254740992',
      'invalid',
      ''
    ]) {
      input.set(name, raw)
      const before = [...input]
      if (raw === '7' || raw === '7ms' || (raw === '0' && zeroAllowed)) {
        assert.equal(parseResponsePolicy(429, input)[field], raw === '0' ? 0 : 7)
      } else {
        assert.throws(() => parseResponsePolicy(429, input), /Некорректный формат заголовка/)
      }
      assert.deepEqual([...input], before)
    }
    input.set(name, String(Number.MAX_SAFE_INTEGER))
    assert.equal(parseResponsePolicy(429, input)[field], Number.MAX_SAFE_INTEGER)
  })
}

test('Header policy preserves missing and partial updates and raw remaining above limit', () => {
  assert.deepEqual(parseResponsePolicy(200, new Headers()), {
    limit: null,
    remaining: null,
    retryTimeInterval: null,
    retryAfterMs: null,
    responseType: 'OK'
  })
  assert.deepEqual(parseResponsePolicy(200, new Headers({ 'x-ratelimit-remaining': '12' })), {
    limit: null,
    remaining: 12,
    retryTimeInterval: null,
    retryAfterMs: null,
    responseType: 'OK'
  })
  assert.equal(
    parseResponsePolicy(
      200,
      new Headers({
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '12'
      })
    ).remaining,
    12
  )
})

test('Response classification preserves legacy 429 and all other HTTP statuses', () => {
  for (const status of [200, 400, 401, 403, 404, 412, 500, 503]) {
    const policy = parseResponsePolicy(
      status,
      new Headers({
        'x-lognex-auth': '429005',
        'x-lognex-retry-after': 'invalid'
      })
    )
    assert.equal(policy.responseType, 'OK')
    assert.equal(policy.retryAfterMs, null)
  }
  assert.equal(
    parseResponsePolicy(
      429,
      new Headers({
        'x-lognex-auth': '429005',
        'x-lognex-retry-after': 'invalid'
      })
    ).responseType,
    'PARALLEL_LIMIT_OVERFLOW'
  )
  for (const auth of ['', '429002', '1073']) {
    const policy = parseResponsePolicy(
      429,
      new Headers({ 'x-lognex-auth': auth, 'x-lognex-reset': '1000' })
    )
    assert.equal(policy.responseType, 'RATE_LIMIT_OVERFLOW')
    assert.equal(policy.retryAfterMs, null)
  }
  assert.equal(
    parseResponsePolicy(429, new Headers({ 'x-lognex-retry-after': '0' })).retryAfterMs,
    0
  )
  assert.throws(() => parseResponsePolicy(429, new Headers({ 'x-lognex-retry-after': 'invalid' })))
})

test('Planner applies partial headers, preserves missing state and returns non-429 responses', async t => {
  const runtime = createRuntime(t)
  const responses = [
    new Response(null, { headers: { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '10' } }),
    new Response(null, { status: 412, headers: { 'x-ratelimit-remaining': '12items' } }),
    new Response(null, { status: 503 })
  ]
  const events: string[] = []
  let index = 0
  const planner = new FetchPlanner(
    () => {
      const response = responses[index++]
      assert.ok(response)
      return Promise.resolve(response)
    },
    {
      eventHandler: {
        emit(name, data) {
          if (name === 'response' && 'responseType' in data) events.push(data.responseType)
        }
      }
    }
  )
  for (const response of responses) {
    const pending = planner.getFetch()('http://offline.test/policy')
    await runtime.advance(0)
    assert.equal(await pending, response)
    assert.equal(planner.getRateLimit(), 10)
    assert.equal(planner.getRateLimitRemaining(), response === responses[0] ? 10 : 12)
  }
  assert.deepEqual(events, ['OK', 'OK', 'OK'])
  assert.equal(planner.getActionsQueueLength(), 0)
  assert.equal(planner.getCurInflightRequestsCount(), 0)
})

test('Parsing valid and invalid headers cannot mutate a pending planner queue', async t => {
  const runtime = createRuntime(t)
  const response = new Response(null)
  const planner = new FetchPlanner(() => Promise.resolve(response))
  const pending = planner.getFetch()('http://offline.test/pending')
  assert.equal(planner.getActionsQueueLength(), 1)
  assert.equal(
    parseResponsePolicy(429, new Headers({ 'x-lognex-retry-after': '7ms' })).retryAfterMs,
    7
  )
  assert.throws(() => parseResponsePolicy(429, new Headers({ 'x-lognex-retry-after': 'invalid' })))
  assert.equal(planner.getActionsQueueLength(), 1)
  assert.equal(planner.getRateLimit(), null)
  assert.equal(planner.getRateLimitRemaining(), null)
  await runtime.advance(0)
  assert.equal(await pending, response)
  assert.equal(planner.getActionsQueueLength(), 0)
})
