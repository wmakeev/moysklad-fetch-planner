import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Response } from 'undici'
import {
  FetchPlanner,
  type FetchPlannerOptions,
  type Handle,
  type MethodSpec,
  type Spec,
  type Init,
  type Event
} from '../src/index.js'
import { createRuntime, trackTimeouts } from './helpers/runtime.js'
import { deferred } from './operation/helpers.js'

type Fetch = typeof import('undici').fetch
const replay = { serverSafe: true, consumeSafe: true }
const noReplay = { serverSafe: false, consumeSafe: false }
function entry<T>(items: readonly T[], index: number): T {
  const value = items[index]
  assert.ok(value !== undefined)
  return value
}
async function expectValue(handle: Handle<string>, value = 'value') {
  const completed = await handle.result
  assert.equal(completed.value, value, 'EXPECTED_OPERATION_VALUE')
  assert.equal(completed.status, 200, 'EXPECTED_OPERATION_STATUS')
  assert.equal(completed.cleanup, 'released', 'EXPECTED_OPERATION_CLEANUP')
  assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
}
function fixture(t: TestContext, options: Partial<FetchPlannerOptions> = {}) {
  const runtime = createRuntime(t)
  const timers = trackTimeouts(t)
  const calls: {
    url: string
    at: number
    wall: number
    signal: AbortSignal
    reply: (response: Response) => void
    done: boolean
  }[] = []
  const handles: Handle<string>[] = []
  const releases: (() => void)[] = []
  const events: Event[] = []
  const transportFailures: unknown[] = []
  const planner = new FetchPlanner<Fetch>(
    (url, init) => {
      try {
        assert.ok(typeof url === 'string' || url instanceof URL)
        assert.ok(init?.signal instanceof AbortSignal)
        const work = deferred<Response>()
        calls.push({
          url: typeof url === 'string' ? url : url.href,
          at: performance.now(),
          wall: Date.now(),
          signal: init.signal,
          reply: work.resolve,
          done: false
        })
        const snapshot = planner.snapshot()
        assert.ok(
          snapshot.sentActive <= snapshot.effectiveParallelism,
          'ACTUAL_SEND_WITHIN_EFFECTIVE'
        )
        assert.ok(snapshot.sentActive <= snapshot.leasedAttempts, 'SENT_WITHIN_LEASES')
        return work.promise
      } catch (error) {
        transportFailures.push(error)
        throw error
      }
    },
    { jitter: 0, ...options }
  )
  const subscription = planner.observe(event => {
    events.push(event)
  })
  function submit(
    url: string,
    patch: Partial<Omit<Spec<Init<Fetch>, Response, string>, 'method' | 'entityKey'>> = {},
    method: MethodSpec = { method: 'GET' }
  ) {
    const handle = planner.submit({
      ...method,
      replay: noReplay,
      prepare: () => ({ url, init: {} }),
      consume: response => response.text(),
      ...patch
    })
    handles.push(handle)
    void handle.result.catch(() => undefined)
    return handle
  }
  function reply(index: number, response = new Response('value')) {
    const call = entry(calls, index)
    assert.equal(call.done, false, 'REPLY_ONCE')
    call.done = true
    call.reply(response)
  }
  async function finish() {
    planner.stop()
    releases.forEach(release => {
      release()
    })
    for (const call of calls)
      if (!call.done) {
        call.done = true
        call.reply(new Response(null))
      }
    await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
    subscription.unsubscribe()
    await runtime.flush()
    assert.equal(planner.snapshot().queued, 0, 'NO_RETAINED_QUEUE')
    assert.equal(planner.snapshot().leasedAttempts, 0, 'NO_RETAINED_LEASE')
    assert.equal(planner.snapshot().sentActive, 0, 'NO_RETAINED_SENT')
    assert.equal(timers.active.size, 0, 'NO_TIMER_AFTER_PHYSICAL_CLEANUP')
    assert.ok(timers.maximum() <= 1, 'ONE_COORDINATOR_TIMER')
    assert.deepEqual(transportFailures, [], 'NO_SWALLOWED_TRANSPORT_ASSERTIONS')
  }
  return { runtime, timers, calls, handles, releases, events, planner, submit, reply, finish }
}

for (const disturbance of ['success', 'enqueue']) {
  test(`Migrated D05 shared pause survives ${disturbance} until the 400ms boundary`, async t => {
    const f = fixture(t)
    const { runtime, calls, planner, submit, reply } = f
    try {
      const a = submit('a', { replay })
      submit('b')
      await runtime.advance(0)
      assert.equal(calls.length, 2)
      reply(0, new Response(null, { status: 429, headers: { 'x-lognex-retry-after': '400' } }))
      await runtime.flush()
      if (disturbance === 'success') reply(1)
      else submit('c')
      await runtime.flush()
      assert.equal(planner.snapshot().serverNotBefore, 1_000_400)
      await runtime.advance(399)
      assert.equal(calls.length, 2, 'NO_SEND_BEFORE_SERVER_BOUNDARY')
      await runtime.advance(1)
      assert.equal(
        calls.length,
        disturbance === 'enqueue' ? 3 : 2,
        'UNRELATED_SEND_ONLY_AT_SERVER_BOUNDARY'
      )
      if (disturbance === 'enqueue') {
        reply(1)
        reply(2)
      }
      await runtime.flush()
      await runtime.advance(2599)
      assert.equal(a.snapshot().dispatchCalls, 1, 'RETRY_FLOOR_IS_SEPARATE_FROM_SHARED_PAUSE')
      await runtime.advance(1)
      assert.equal(entry(calls, calls.length - 1).url, 'a')
      reply(calls.length - 1)
      for (const handle of f.handles) await expectValue(handle)
    } finally {
      await f.finish()
    }
  })
}
for (const jump of [10_000_000, -900_000]) {
  test(`Migrated Wall clock jump ${jump} preserves monotonic pause and dispatch wall records`, async t => {
    const f = fixture(t)
    const { runtime, planner, submit, reply, calls } = f
    try {
      const a = submit('a', { replay })
      await runtime.advance(0)
      reply(0, new Response(null, { status: 429, headers: { 'x-lognex-retry-after': '400' } }))
      await runtime.flush()
      const b = submit('b')
      runtime.jumpWall(jump)
      assert.equal(performance.now(), 1_000_000)
      assert.equal(planner.snapshot().serverNotBefore, 1_000_400)
      await runtime.advance(399)
      assert.equal(calls.length, 1)
      await runtime.advance(1)
      assert.equal(entry(calls, 1).at, 1_000_400)
      assert.equal(entry(calls, 1).wall, 1_000_400 + jump)
      reply(1)
      await expectValue(b)
      await runtime.advance(2600)
      assert.equal(entry(calls, 2).at, 1_000_000 + 3000)
      assert.equal(entry(calls, 2).wall, 1_000_000 + 3000 + jump)
      reply(2)
      await expectValue(a)
    } finally {
      await f.finish()
    }
  })
}
for (const duration of [2_147_483_647, 2_147_483_648]) {
  test(`Migrated Server deadline ${duration} uses bounded chunks without losing the remainder`, async t => {
    const f = fixture(t, { deadlineMs: duration + 10000, attemptTimeoutMs: duration + 1000 })
    const { runtime, timers, calls, planner, submit, reply } = f
    const warnings: string[] = []
    const onWarning = (warning: Error) => {
      warnings.push(warning.name)
    }
    process.on('warning', onWarning)
    try {
      const a = submit('a', { replay })
      await runtime.advance(0)
      reply(
        0,
        new Response(null, { status: 429, headers: { 'x-lognex-retry-after': String(duration) } })
      )
      await runtime.flush()
      assert.equal(planner.snapshot().serverNotBefore, 1_000_000 + duration)
      await runtime.advance(2_147_483_646)
      assert.equal(calls.length, 1, 'NO_SEND_BEFORE_BOUNDED_CHUNK')
      await runtime.advance(1)
      assert.equal(calls.length, duration === 2_147_483_647 ? 2 : 1)
      if (duration > 2_147_483_647) {
        assert.equal(timers.active.size, 1)
        await runtime.advance(1)
      }
      assert.equal(entry(calls, 1).at, 1_000_000 + duration, 'LONG_DEADLINE_REMAINDER')
      reply(1)
      await expectValue(a)
      await a.resourcesDone
      assert.ok(timers.delays.every(delay => delay >= 0 && delay <= 2_147_483_647))
      assert.equal(timers.maximum(), 1)
      assert.equal(timers.active.size, 0)
      assert.ok(!warnings.includes('TimeoutOverflowWarning'))
    } finally {
      process.off('warning', onWarning)
      await f.finish()
    }
  })
}
for (const secondPause of [100, 500]) {
  test(`Migrated Two 429 receipts retain maximum absolute deadline with later hint ${secondPause}`, async t => {
    const f = fixture(t, { maxParallelLimit: 2 })
    const { runtime, timers, calls, planner, submit, reply } = f
    try {
      const a = submit('a', { replay })
      const b = submit('b', { replay })
      await runtime.advance(0)
      reply(0, new Response(null, { status: 429, headers: { 'x-lognex-retry-after': '400' } }))
      await runtime.flush()
      const obsolete = entry(timers.callbacks, timers.callbacks.length - 1)
      await runtime.advance(100)
      reply(
        1,
        new Response(null, {
          status: 429,
          headers: { 'x-lognex-retry-after': String(secondPause) }
        })
      )
      await runtime.flush()
      const remaining = Math.max(300, secondPause)
      assert.equal(planner.snapshot().serverNotBefore, performance.now() + remaining)
      const c = submit('c')
      const d = submit('d')
      obsolete()
      await runtime.flush()
      assert.equal(calls.length, 2, 'STALE_WAKE_IS_NOT_PERMIT')
      assert.equal(timers.active.size, 1)
      await runtime.advance(remaining - 1)
      assert.equal(calls.length, 2)
      await runtime.advance(1)
      assert.deepEqual(
        calls.slice(2).map(call => call.url),
        ['c', 'd'],
        'UNRELATED_FIFO_AT_MAXIMUM_PAUSE'
      )
      reply(2)
      reply(3)
      await Promise.all([expectValue(c), expectValue(d)])
      await runtime.advance(3000 - (performance.now() - 1_000_000))
      assert.equal(entry(calls, 4).url, 'a', 'RETRY_FIFO_USES_ELIGIBILITY_NOT_LEGACY_UNSHIFT')
      reply(4)
      await expectValue(a)
      await runtime.advance(100)
      assert.equal(entry(calls, 5).url, 'b')
      reply(5)
      await expectValue(b)
      await runtime.flush()
      assert.equal(timers.active.size, 0)
      obsolete()
      await runtime.flush()
      assert.equal(calls.length, 6, 'STALE_WAKE_AFTER_DRAIN_NO_SEND')
    } finally {
      await f.finish()
    }
  })
}
test('Migrated Response callback enqueue and late success headers cannot shorten a received pause', async t => {
  const f = fixture(t)
  const { runtime, calls, planner, submit, reply } = f
  const attachment = planner.observe(event => {
    if (event.type === 'headers-received' && event.status === 429) submit('c')
  })
  try {
    const a = submit('a', { replay })
    submit('b')
    await runtime.advance(0)
    reply(0, new Response(null, { status: 429, headers: { 'x-lognex-retry-after': '400' } }))
    await runtime.flush()
    await runtime.advance(100)
    reply(
      1,
      new Response('late', {
        headers: {
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '10',
          'x-lognex-retry-timeinterval': '1000'
        }
      })
    )
    await runtime.flush()
    assert.equal(planner.snapshot().serverNotBefore, 1_000_400)
    await runtime.advance(299)
    assert.equal(calls.length, 2)
    await runtime.advance(1)
    assert.equal(entry(calls, 2).at, 1_000_400)
    reply(2)
    await runtime.advance(2600)
    assert.equal(entry(calls, 3).at, 1_000_000 + 3000)
    reply(3)
    await expectValue(a)
    await expectValue(entry(f.handles, 1), 'late')
    await expectValue(entry(f.handles, 2))
  } finally {
    attachment.unsubscribe()
    await f.finish()
  }
})
test('Migrated Adaptive pacing can delay a retry beyond the server boundary', async t => {
  const f = fixture(t, { maxRequestDelayTimeMs: 1000, throttlingCoefficient: 1 })
  const { runtime, calls, submit, reply } = f
  try {
    const a = submit('a', { replay })
    await runtime.advance(0)
    reply(
      0,
      new Response(null, {
        status: 429,
        headers: {
          'x-lognex-retry-after': '400',
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '0',
          'x-lognex-retry-timeinterval': '10000'
        }
      })
    )
    await runtime.flush()
    const unrelated = submit('unrelated')
    await runtime.advance(400)
    assert.equal(calls.length, 1)
    await runtime.advance(599)
    assert.equal(calls.length, 1)
    await runtime.advance(1)
    assert.equal(entry(calls, 1).at, 1_001_000, 'ADAPTIVE_BEYOND_SERVER')
    reply(1)
    await runtime.advance(1999)
    assert.equal(calls.length, 2)
    await runtime.advance(1)
    // At retry eligibility, elapsed2000/10000 gives level.20, hence800ms.
    assert.equal(calls.length, 2, 'RETRY_RECHECKS_ADAPTIVE_AFTER_FALLBACK')
    await runtime.advance(799)
    assert.equal(calls.length, 2)
    await runtime.advance(1)
    assert.equal(entry(calls, 2).at, 1_003_800)
    reply(2)
    await expectValue(a)
    await expectValue(unrelated)
  } finally {
    await f.finish()
  }
})
test('Migrated Empty queue owns no timer while a terminal observer retains the server boundary for later enqueue', async t => {
  const f = fixture(t)
  const { runtime, timers, calls, planner, submit, reply } = f
  let observerFailures = 0
  const attachment = planner.observe(event => {
    if (event.type === 'headers-received') {
      observerFailures++
      throw new Error('observer failed')
    }
  })
  try {
    const a = submit('terminal')
    await runtime.advance(0)
    reply(0, new Response(null, { status: 429, headers: { 'x-lognex-retry-after': '400' } }))
    await assert.rejects(a.result, { code: 'HTTP_FAILED' })
    await a.resourcesDone
    await runtime.flush()
    assert.equal(observerFailures, 1, 'INTENTIONAL_OBSERVER_FAILURE_WAS_EXERCISED')
    assert.equal(timers.active.size, 0)
    assert.equal(planner.snapshot().serverNotBefore, 1_000_400)
    await runtime.advance(100)
    const b = submit('later')
    await runtime.advance(299)
    assert.equal(calls.length, 1)
    await runtime.advance(1)
    assert.equal(entry(calls, 1).at, 1_000_400)
    reply(1)
    assert.equal((await b.result).value, 'value')
  } finally {
    attachment.unsubscribe()
    await f.finish()
  }
})
test('Migrated Unsafe absolute retry deadline rejects before scheduling a timer', async t => {
  // C4 strict parsing ignores an unsafe absolute hint; it cannot schedule an unsafe timer.
  const f = fixture(t)
  const { runtime, timers, planner, submit, reply, calls } = f
  try {
    const a = submit('unsafe')
    await runtime.advance(0)
    reply(
      0,
      new Response(null, {
        status: 429,
        headers: { 'x-lognex-retry-after': String(Number.MAX_SAFE_INTEGER) }
      })
    )
    await assert.rejects(a.result, { code: 'HTTP_FAILED' })
    await a.resourcesDone
    assert.equal(planner.snapshot().serverNotBefore, 0)
    assert.ok(timers.delays.every(delay => delay >= 0 && delay <= 2_147_483_647))
    assert.equal(timers.active.size, 0)
    assert.equal(planner.snapshot().queued, 0)
    const b = submit('after-invalid')
    await runtime.advance(0)
    assert.equal(calls.length, 2, 'INVALID_ABSOLUTE_HINT_CANNOT_BLOCK_LATER_SEND')
    reply(1)
    await expectValue(b)
  } finally {
    await f.finish()
  }
})

for (const action of ['wake', 'stop']) {
  test(`Migrated Ready FIFO rechecks late pause and pacing without burst on ${action}`, async t => {
    const f = fixture(t, {
      maxParallelLimit: 4,
      maxRequestDelayTimeMs: 1000,
      throttlingCoefficient: 1
    })
    const { runtime, planner, calls, submit, reply, timers } = f
    try {
      const seed = submit('seed')
      const late = submit('late')
      await runtime.advance(0)
      reply(
        0,
        new Response('seed', {
          headers: {
            'x-ratelimit-limit': '10',
            'x-ratelimit-remaining': '5',
            'x-lognex-retry-timeinterval': '10000'
          }
        })
      )
      await expectValue(seed, 'seed')
      const a = submit('ready-a')
      const b = submit('ready-b')
      const c = submit('ready-c')
      await runtime.flush()
      assert.ok([a, b, c].every(handle => handle.snapshot().phase === 'ready'))
      assert.equal(calls.length, 2)
      const obsolete = entry(timers.callbacks, timers.callbacks.length - 1)
      await runtime.advance(499)
      reply(1, new Response(null, { status: 429, headers: { 'x-lognex-retry-after': '400' } }))
      await runtime.flush()
      await assert.rejects(late.result, { code: 'HTTP_FAILED', status: 429 })
      await late.resourcesDone
      assert.equal(planner.snapshot().serverNotBefore, 1_000_899)
      obsolete()
      await runtime.advance(1)
      assert.equal(calls.length, 2, 'CACHED_WAKE_CANNOT_BYPASS_LATE_RECEIPT')
      if (action === 'stop') {
        planner.stop()
        obsolete()
        await runtime.advance(400)
        assert.equal(calls.length, 2, 'PAUSED_STOP_NEVER_RESURRECTS')
        for (const handle of [a, b, c]) await assert.rejects(handle.result, { code: 'STOPPED' })
      } else {
        await runtime.advance(398)
        assert.equal(calls.length, 2)
        await runtime.advance(1)
        assert.equal(calls.length, 3, 'READY_HISTORY_NO_BURST')
        assert.equal(entry(calls, 2).url, 'ready-a')
        reply(2)
        // The next actual dispatch is a fresh 500ms pacing interval.
        await runtime.advance(499)
        assert.equal(calls.length, 3)
        await runtime.advance(1)
        assert.equal(entry(calls, 3).url, 'ready-b')
        reply(3)
        await runtime.advance(500)
        assert.equal(entry(calls, 4).url, 'ready-c')
        reply(4)
        for (const handle of [a, b, c]) await expectValue(handle)
      }
    } finally {
      await f.finish()
    }
  })
}
test('Migrated Queue and listener bounds include observer commands and release subscriptions', async t => {
  const f = fixture(t, { maxParallelLimit: 1, maxQueuedOperations: 2, maxSubscribers: 3 })
  const { runtime, planner, calls, submit, reply } = f
  let enqueued = false
  const delivered: Event[] = []
  const dispatchFacts: { id: number; transports: number; url: string | undefined }[] = []
  const queuedReservations: number[] = []
  const tail = planner.observe(event => {
    delivered.push(event)
    if (event.type === 'dispatch-started')
      dispatchFacts.push({ id: event.id, transports: calls.length, url: calls.at(-1)?.url })
  })
  const burst = planner.observe(event => {
    if (event.type === 'headers-received' && !enqueued) {
      enqueued = true
      for (let index = 0; index < 10; index++) submit(`command-${index}`)
      queuedReservations.push(planner.snapshot().queued)
    }
  })
  try {
    assert.throws(() => planner.observe(() => undefined), { code: 'SUBSCRIBER_LIMIT' })
    const first = submit('first')
    await runtime.advance(0)
    reply(0)
    await expectValue(first)
    await runtime.flush()
    assert.equal(
      f.handles.filter(handle => handle.snapshot().failureCode === 'QUEUE_FULL').length,
      8
    )
    assert.equal(calls.length, 2)
    reply(1)
    await runtime.flush()
    assert.equal(entry(calls, 2).url, 'command-1')
    reply(2)
    await Promise.all(
      f.handles.map(async handle => {
        if (handle.snapshot().dispatchCalls === 0) {
          await assert.rejects(handle.result, { code: 'QUEUE_FULL' })
          await handle.resourcesDone
        } else await expectValue(handle)
      })
    )
    assert.deepEqual(queuedReservations, [2], 'PENDING_COMMANDS_RESERVE_QUEUE_SYNCHRONOUSLY')
    assert.deepEqual(
      dispatchFacts,
      [
        { id: first.id, transports: 1, url: 'first' },
        { id: entry(f.handles, 1).id, transports: 2, url: 'command-0' },
        { id: entry(f.handles, 2).id, transports: 3, url: 'command-1' }
      ],
      'TRANSPORT_BEFORE_EACH_OBSERVATION'
    )
    assert.deepEqual(delivered, f.events, 'FULL_FANOUT_AND_QUEUE_PROGRESS')
    for (const handle of f.handles.filter(handle => handle.snapshot().dispatchCalls > 0)) {
      assert.equal((await handle.result).value, 'value', 'ACCEPTED_COMMAND_SUCCEEDED')
      await handle.resourcesDone
    }
    tail.unsubscribe()
    tail.unsubscribe()
    burst.unsubscribe()
    const replacement = planner.observe(() => undefined)
    replacement.unsubscribe()
    const handle = entry(f.handles, 0)
    let terminalDeliveries = 0
    const final = handle.observe(() => {
      terminalDeliveries++
    })
    assert.equal(final.snapshot.resources, 'released')
    await runtime.flush()
    assert.equal(terminalDeliveries, 0, 'TERMINAL_ATTACHMENT_DOES_NOT_DELIVER')
    final.unsubscribe()
    await runtime.flush()
    assert.equal(terminalDeliveries, 0, 'UNSUBSCRIBED_TERMINAL_ATTACHMENT_DOES_NOT_DELIVER')
  } finally {
    tail.unsubscribe()
    burst.unsubscribe()
    await f.finish()
  }
})
test('Migrated Sent POST stop retains body and disposer ownership until physical completion', async t => {
  const f = fixture(t, { maxParallelLimit: 1, cleanupGraceMs: 10 })
  const body = deferred<string>()
  const disposer = deferred<undefined>()
  f.releases.push(
    () => {
      body.resolve('completed')
    },
    () => {
      disposer.resolve(undefined)
    }
  )
  let disposed = 0
  try {
    const post = f.submit(
      'post',
      {
        prepare: ctx => {
          ctx.onDispose(async () => {
            disposed++
            await disposer.promise
          })
          return { url: 'post', init: { body: 'payload' } }
        },
        consume: () => body.promise,
        replay
      },
      { method: 'POST' }
    )
    await f.runtime.advance(0)
    f.reply(0)
    await f.runtime.flush()
    const queued = f.submit('queued')
    f.planner.stop()
    await assert.rejects(queued.result, { code: 'STOPPED' })
    assert.equal(f.calls.length, 1)
    assert.equal(entry(f.calls, 0).signal.aborted, false, 'STOP_SENT_POST_IS_NOT_ROLLBACK')
    assert.equal(f.planner.snapshot().sentActive, 1, 'HEADERS_DO_NOT_RELEASE_BODY')
    assert.equal(post.snapshot().resultCommitted, false)
    body.resolve('completed')
    await f.runtime.flush()
    assert.equal(disposed, 1)
    await f.runtime.advance(10)
    const completed = await post.result
    assert.equal(completed.value, 'completed')
    assert.equal(completed.status, 200)
    assert.equal(completed.cleanup, 'pending')
    assert.equal(f.planner.snapshot().sentActive, 1, 'LOGICAL_RESULT_DOES_NOT_RELEASE_DISPOSER')
    assert.equal(post.snapshot().resources, 'pending')
    disposer.resolve(undefined)
    await post.resourcesDone
    assert.equal(disposed, 1)
    assert.equal(post.snapshot().dispatchCalls, 1)
    assert.equal(f.calls.length, 1, 'STOP_NEVER_RETRIES_SENT_POST')
  } finally {
    await f.finish()
  }
})
