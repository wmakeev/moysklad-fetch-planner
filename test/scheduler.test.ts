import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Response } from 'undici'
import { FetchPlanner, type FetchPlannerEventMap } from '../src/index.js'
import { createRuntime, trackTimeouts } from './helpers/runtime.js'

function entry<T>(items: readonly T[], index: number): T {
  const value = items[index]
  assert.notEqual(value, undefined)
  assert.ok(value !== undefined)
  return value
}

for (const disturbance of ['success', 'enqueue']) {
  test(`D05 shared pause survives ${disturbance} until the 400ms boundary`, async t => {
    const runtime = createRuntime(t)
    const starts: number[] = []
    const replies: ((response: Response) => void)[] = []
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () => {
        starts.push(performance.now())
        return new Promise(resolve => replies.push(resolve))
      },
      { jitter: 0 }
    )
    const fetch = planner.getFetch()
    const results = [fetch('http://offline.test/a'), fetch('http://offline.test/b')]
    await runtime.advance(0)
    await runtime.advance(0)
    assert.equal(starts.length, 2)
    entry(
      replies,
      0
    )(new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '400' } }))
    await runtime.flush()
    if (disturbance === 'success') entry(replies, 1)(new Response(null))
    else results.push(fetch('http://offline.test/c'))
    await runtime.flush()
    await runtime.advance(399)
    assert.equal(starts.length, 2, 'No start before receipt + 400ms')
    await runtime.advance(1)
    assert.equal(
      starts.length,
      disturbance === 'enqueue' ? 4 : 3,
      'Retry starts at receipt + 400ms'
    )
    entry(replies, 1)(new Response(null))
    entry(replies, 2)(new Response(null))
    await runtime.advance(0)
    if (disturbance === 'enqueue') entry(replies, 3)(new Response(null))
    await runtime.flush()
    await Promise.all(results)
    assert.equal(planner.getNextRequestTime(), 0)
  })
}

for (const jump of [10_000_000, -900_000]) {
  test(`Wall clock jump ${jump} preserves the monotonic server pause and Unix getter`, async t => {
    const runtime = createRuntime(t)
    let starts = 0
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () => {
        starts++
        return Promise.resolve(
          starts === 1
            ? new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '400' } })
            : new Response(null)
        )
      },
      { jitter: 0 }
    )
    const result = planner.getFetch()('http://offline.test/a')
    await runtime.advance(0)
    assert.equal(planner.getNextRequestTime(), Date.now() + 400)
    runtime.jumpWall(jump)
    assert.equal(performance.now(), 1_000_000)
    assert.equal(planner.getNextRequestTime(), Date.now() + 400)
    await runtime.advance(399)
    assert.equal(starts, 1)
    assert.equal(planner.getNextRequestTime(), Date.now() + 1)
    await runtime.advance(1)
    await result
    assert.equal(starts, 2)
    assert.equal(planner.getNextRequestTime(), 0)
  })
}

for (const duration of [2_147_483_647, 2_147_483_648]) {
  test(`Server deadline ${duration} uses bounded chunks without losing the remainder`, async t => {
    const runtime = createRuntime(t)
    const timers = trackTimeouts(t)
    const warnings: string[] = []
    const onWarning = (warning: Error) => warnings.push(warning.name)
    process.on('warning', onWarning)
    t.after(() => process.off('warning', onWarning))
    let starts = 0
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () => {
        starts++
        return Promise.resolve(
          starts === 1
            ? new Response(null, {
                status: 429,
                headers: { 'X-Lognex-Retry-After': String(duration) }
              })
            : new Response(null)
        )
      },
      { jitter: 0 }
    )
    const result = planner.getFetch()('http://offline.test/a')
    await runtime.advance(0)
    assert.equal(planner.getNextRequestTime(), Date.now() + duration)
    await runtime.advance(2_147_483_646)
    assert.equal(starts, 1, 'No start before the first bounded chunk expires')
    await runtime.advance(1)
    assert.equal(starts, duration === 2_147_483_647 ? 2 : 1)
    if (duration > 2_147_483_647) {
      assert.equal(planner.getNextRequestTime(), Date.now() + 1)
      assert.equal(timers.active.size, 1)
      await runtime.advance(1)
    }
    await result
    await runtime.flush()
    assert.equal(starts, 2)
    assert.ok(timers.delays.every(delay => delay >= 0 && delay <= 2_147_483_647))
    assert.equal(timers.maximum(), 1)
    assert.equal(timers.active.size, 0)
    assert.equal(planner.getNextRequestTime(), 0)
    assert.ok(!warnings.includes('TimeoutOverflowWarning'))
  })
}

for (const secondPause of [100, 500]) {
  test(`Two 429 receipts retain the maximum absolute deadline with later hint ${secondPause}`, async t => {
    const runtime = createRuntime(t)
    const timers = trackTimeouts(t)
    const replies: ((response: Response) => void)[] = []
    const starts: string[] = []
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      url => {
        assert.equal(typeof url, 'string')
        assert.ok(typeof url === 'string')
        starts.push(url)
        return new Promise(resolve => replies.push(resolve))
      },
      { jitter: 0, maxParallelLimit: 2 }
    )
    const fetch = planner.getFetch()
    const results = [fetch('http://offline.test/a'), fetch('http://offline.test/b')]
    await runtime.advance(0)
    entry(
      replies,
      0
    )(new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '400' } }))
    await runtime.flush()
    const obsolete = entry(timers.callbacks, timers.callbacks.length - 1)
    await runtime.advance(100)
    entry(
      replies,
      1
    )(new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': String(secondPause) } }))
    await runtime.flush()
    const remaining = Math.max(300, secondPause)
    assert.equal(planner.getNextRequestTime(), Date.now() + remaining)
    obsolete()
    assert.equal(starts.length, 2, 'Canceled wake cannot start an action')
    assert.equal(timers.active.size, 1)
    await runtime.advance(remaining - 1)
    assert.equal(starts.length, 2)
    await runtime.advance(1)
    assert.equal(starts.length, 4)
    assert.deepEqual(
      starts.slice(2),
      ['http://offline.test/b', 'http://offline.test/a'],
      'Retry unshift order is preserved'
    )
    entry(replies, 2)(new Response(null))
    entry(replies, 3)(new Response(null))
    await runtime.flush()
    await Promise.all(results)
    assert.equal(timers.active.size, 0)
    assert.equal(timers.maximum(), 1)
    obsolete()
    assert.equal(starts.length, 4, 'Stale wake after drain cannot start an action')
  })
}

test('Response callback enqueue and late success headers cannot shorten a received pause', async t => {
  const runtime = createRuntime(t)
  const timers = trackTimeouts(t)
  const events = new EventEmitter<FetchPlannerEventMap<typeof import('undici').fetch>>()
  const replies: ((response: Response) => void)[] = []
  const starts: number[] = []
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () => {
      starts.push(performance.now())
      return new Promise(resolve => replies.push(resolve))
    },
    { jitter: 0, eventHandler: events }
  )
  const fetch = planner.getFetch()
  const results = [fetch('http://offline.test/a'), fetch('http://offline.test/b')]
  events.on('response', data => {
    if (data.responseType === 'RATE_LIMIT_OVERFLOW') results.push(fetch('http://offline.test/c'))
  })
  await runtime.advance(0)
  entry(replies, 0)(new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '400' } }))
  await runtime.flush()
  await runtime.advance(100)
  entry(
    replies,
    1
  )(
    new Response(null, {
      headers: {
        'X-RateLimit-Limit': '10',
        'X-RateLimit-Remaining': '10',
        'X-Lognex-Retry-TimeInterval': '1000'
      }
    })
  )
  await runtime.flush()
  assert.equal(planner.getNextRequestTime(), Date.now() + 300)
  await runtime.advance(299)
  assert.equal(starts.length, 2)
  await runtime.advance(1)
  assert.deepEqual(starts.slice(2), [1_000_400, 1_000_400])
  entry(replies, 2)(new Response(null))
  entry(replies, 3)(new Response(null))
  await runtime.flush()
  await Promise.all(results)
  assert.equal(timers.maximum(), 1)
  assert.equal(timers.active.size, 0)
})

test('Adaptive pacing can delay a retry beyond the server boundary', async t => {
  const runtime = createRuntime(t)
  let starts = 0
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () => {
      starts++
      return Promise.resolve(
        starts === 1
          ? new Response(null, {
              status: 429,
              headers: {
                'X-Lognex-Retry-After': '400',
                'X-RateLimit-Limit': '10',
                'X-RateLimit-Remaining': '0',
                'X-Lognex-Retry-TimeInterval': '1000'
              }
            })
          : new Response(null)
      )
    },
    { jitter: 0, maxRequestDelayTimeMs: 1000, throttlingCoefficient: 1 }
  )
  const result = planner.getFetch()('http://offline.test/a')
  await runtime.advance(0)
  assert.equal(planner.getNextRequestTime(), Date.now() + 1000)
  await runtime.advance(400)
  assert.equal(starts, 1)
  await runtime.advance(599)
  assert.equal(starts, 1)
  await runtime.advance(1)
  await result
  assert.equal(starts, 2)
  assert.equal(planner.getLastRequestDelay(), 1000)
})

test('Empty queue owns no timer while a terminal observer retains the server boundary for later enqueue', async t => {
  const runtime = createRuntime(t)
  const timers = trackTimeouts(t)
  const events = new EventEmitter<FetchPlannerEventMap<typeof import('undici').fetch>>()
  const failure = new Error('observer failed')
  events.once('response', () => {
    throw failure
  })
  let starts = 0
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () => {
      starts++
      return Promise.resolve(
        starts === 1
          ? new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '400' } })
          : new Response(null)
      )
    },
    { jitter: 0, eventHandler: events }
  )
  const failed = assert.rejects(
    planner.getFetch()('http://offline.test/a'),
    error => error === failure
  )
  await runtime.advance(0)
  await failed
  assert.equal(timers.active.size, 0)
  assert.equal(planner.getNextRequestTime(), 0)
  await runtime.advance(100)
  const result = planner.getFetch()('http://offline.test/b')
  assert.equal(planner.getNextRequestTime(), Date.now() + 300)
  await runtime.advance(299)
  assert.equal(starts, 1)
  await runtime.advance(1)
  await result
  assert.equal(starts, 2)
  assert.equal(timers.active.size, 0)
})

test('Unsafe absolute retry deadline rejects before scheduling a timer', async t => {
  const runtime = createRuntime(t)
  const timers = trackTimeouts(t)
  const planner = new FetchPlanner<typeof import('undici').fetch>(() =>
    Promise.resolve(
      new Response(null, {
        status: 429,
        headers: { 'X-Lognex-Retry-After': String(Number.MAX_SAFE_INTEGER) }
      })
    )
  )
  const failed = assert.rejects(
    planner.getFetch()('http://offline.test/a'),
    /Небезопасное значение времени/
  )
  await runtime.advance(0)
  await failed
  assert.deepEqual(timers.delays, [0])
  assert.equal(timers.active.size, 0)
  assert.equal(planner.getActionsQueueLength(), 0)
})
