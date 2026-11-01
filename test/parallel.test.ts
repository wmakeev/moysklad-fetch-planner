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
const overflow = (duration?: number) =>
  new Response(null, {
    status: 429,
    headers: {
      'x-lognex-auth': '429005',
      ...(duration === undefined ? {} : { 'x-lognex-retry-after': String(duration) })
    }
  })
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

function assertLimit(planner: FetchPlanner<Fetch>, max: number, correction: number) {
  const effective = planner.snapshot().effectiveParallelism
  assert.equal(effective - max, correction, 'CORRECTION_AT_PUBLIC_RECEIPT')
  assert.ok(effective - max >= 1 - max && effective - max <= 0, 'CORRECTION_CLAMP')
  assert.ok(effective >= 1 && effective <= max, 'EFFECTIVE_BOUND')
}
for (const max of [1, 2, 4]) {
  test(`Migrated D06 repeated parallel overflow at max ${max} clamps correction and preserves FIFO admission`, async t => {
    // Explicit finite retry budget preserves the old repeated-overflow axis without
    // restoring the removed infinite retry/default zero-delay policy [ALT, CONSIST].
    const f = fixture(t, {
      maxParallelLimit: max,
      maxAttempts: max + 5,
      parallelLimitCorrectionPeriodMs: 1_000_000,
      deadlineMs: 500_000
    })
    const { runtime, calls, planner, submit, reply } = f
    try {
      const retry = submit('retry', { replay })
      await runtime.advance(0)
      for (let attempt = 1; attempt <= max + 3; attempt++) {
        reply(calls.length - 1, overflow())
        await runtime.flush()
        assertLimit(planner, max, Math.max(1 - max, -attempt))
        assert.equal(planner.snapshot().queued, 1, 'RETRY_WAIT_OWNS_RESERVATION')
        assert.equal(planner.snapshot().leasedAttempts, 0, 'NO_LEASE_DURING_BACKOFF')
        const count = calls.length
        const delay = Math.min(30000, 3000 * 2 ** Math.min(4, attempt - 1))
        await runtime.advance(delay - 1)
        assert.equal(calls.length, count, 'NO_EARLY_RETRY')
        await runtime.advance(1)
        assert.equal(calls.length, count + 1)
        assert.equal(entry(calls, count).url, 'retry', 'RETRY_PAYLOAD_PRESERVED')
        assert.equal(retry.snapshot().attempts, attempt + 1)
      }
      const queued = [
        ...Array.from({ length: max + 2 }, (_, index) => `queued-${index}`),
        'low',
        'high'
      ]
      for (const url of queued) submit(url)
      const before = calls.length
      await runtime.advance(0)
      assert.equal(calls.length, before, 'ENQUEUE_CANNOT_BYPASS_MINIMUM')
      for (let index = 0; index <= queued.length; index++) {
        assert.equal(planner.snapshot().sentActive, 1, 'ONE_TRANSPORT_AT_MINIMUM')
        reply(calls.length - 1)
        await runtime.advance(0)
      }
      assert.deepEqual(
        calls.slice(before).map(call => call.url),
        queued,
        'QUEUED_PAYLOAD_FIFO_REPLACES_PRIORITY_WAITERS'
      )
      const results = await Promise.all(f.handles.map(handle => handle.result))
      assert.ok(results.every(result => result.cleanup === 'released'))
      assertLimit(planner, max, 1 - max)
      assert.equal(retry.snapshot().dispatchCalls, max + 4)
    } finally {
      await f.finish()
    }
  })
}
for (const max of [2, 4]) {
  test(`Migrated Late responses at max ${max} retain sent transports while new and reentrant work waits`, async t => {
    const f = fixture(t, { maxParallelLimit: max })
    const { runtime, planner, calls, submit, reply } = f
    let reentered = false
    let reentrant: Handle<string> | undefined
    const attachment = planner.observe(event => {
      if (event.type === 'headers-received' && event.status === 429 && !reentered) {
        reentered = true
        reentrant = submit('reentrant')
      }
    })
    try {
      const originals = Array.from({ length: max }, (_, index) =>
        submit(`original-${index}`, { replay })
      )
      await runtime.advance(0)
      assert.equal(calls.length, max)
      for (let index = 1; index < max; index++) {
        reply(index - 1, overflow())
        await runtime.advance(0)
        assertLimit(planner, max, -index)
        assert.equal(
          planner.snapshot().sentActive,
          max - index,
          'SENT_RETAINS_TOKEN_AFTER_REDUCTION'
        )
        assert.ok(
          calls.slice(index, max).every(call => !call.signal.aborted),
          'PENDING_SENT_NOT_ABORTED'
        )
        assert.ok(
          originals
            .slice(index)
            .every(
              handle =>
                handle.snapshot().dispatchCalls === 1 && handle.snapshot().outcome === 'pending'
            ),
          'PENDING_NOT_RELABELED_OR_REACQUIRED'
        )
        assert.equal(calls.length, max, 'NO_REPLACEMENT_AT_REDUCED_LIMIT')
      }
      const late = submit('late-enqueue')
      await runtime.advance(0)
      assert.equal(calls.length, max)
      reply(max - 1)
      await runtime.advance(0)
      assertLimit(planner, max, 1 - max)
      assert.equal(calls.length, max + 1)
      assert.equal(entry(calls, max).url, 'reentrant', 'UNRELATED_FIFO_PRECEDES_INELIGIBLE_RETRIES')
      reply(max, overflow())
      await runtime.advance(0)
      assertLimit(planner, max, 1 - max)
      assert.equal(entry(calls, max + 1).url, 'late-enqueue')
      reply(max + 1)
      await runtime.advance(3000)
      for (let index = 0; index < max - 1; index++) {
        const callIndex = max + 2 + index
        assert.equal(calls.length, callIndex + 1)
        assert.equal(
          entry(calls, callIndex).url,
          `original-${index}`,
          'RETRY_FIFO_PRESERVES_ORIGINAL_PAYLOAD'
        )
        reply(callIndex)
        await runtime.advance(0)
      }
      assert.ok(reentrant)
      await assert.rejects(reentrant.result, { code: 'HTTP_FAILED', status: 429 })
      await reentrant.resourcesDone
      await Promise.all([...originals, late].map(handle => expectValue(handle)))
      assert.equal(planner.snapshot().sentActive, 0)
    } finally {
      attachment.unsubscribe()
      await f.finish()
    }
  })
}
for (const max of [1, 2, 4]) {
  for (const random of [0, 0.5, 1]) {
    for (const jitter of [0, 0.3]) {
      for (const basePeriod of [1000, 10000]) {
        test(`Migrated Recovery at max ${max} random ${random} jitter ${jitter} period ${basePeriod} is strict and one step`, async t => {
          const f = fixture(t, {
            maxParallelLimit: max,
            parallelLimitCorrectionPeriodMs: basePeriod,
            jitter
          })
          const { runtime, calls, planner, submit, reply } = f
          runtime.setRandom(random)
          try {
            // Independent finite operations keep every receipt at the same interval time;
            // recovery is then measured from that receipt, without a retry floor confound.
            for (let index = 0; index < max + 1; index++) {
              const operation = submit(`overflow-${index}`)
              await runtime.advance(0)
              reply(calls.length - 1, overflow())
              await assert.rejects(operation.result, { code: 'HTTP_FAILED' })
              await operation.resourcesDone
              assertLimit(planner, max, Math.max(1 - max, -index - 1))
            }
            const at = performance.now()
            async function burst(expected: number, label: string) {
              const before = calls.length
              const probes = Array.from({ length: max + 1 }, (_, index) =>
                submit(`${label}-${index}`)
              )
              await runtime.advance(0)
              assert.equal(calls.length - before, expected, 'RECOVERY_EARLY_ACTUAL_TRANSPORT')
              assertLimit(planner, max, expected - max)
              assert.ok(calls.slice(before).every(call => call.at === performance.now()))
              // Each release admits one FIFO successor, never more than effective capacity.
              for (let index = 0; index < probes.length; index++) {
                reply(before + index)
                await runtime.advance(0)
                assert.ok(planner.snapshot().sentActive <= expected, 'RECOVERY_RESOURCE_BOUND')
              }
              assert.deepEqual(
                calls.slice(before).map(call => call.url),
                probes.map((_, index) => `${label}-${index}`)
              )
              for (const probe of probes) assert.equal((await probe.result).value, 'value')
            }
            for (const jump of [10_000_000, -20_000_000]) {
              runtime.jumpWall(jump)
              await burst(1, `wall-${jump}`)
              assert.equal(performance.now(), at, 'WALL_JUMP_DOES_NOT_RECOVER')
            }
            // Independent contract oracle: no production function/output is consulted.
            const period = basePeriod * (1 + 2 * random * jitter)
            for (let effective = 1; effective < max; effective++) {
              await runtime.advance(period - 1)
              await burst(effective, 'before')
              await runtime.advance(1)
              await burst(effective, 'equality')
              await runtime.advance(1)
              await burst(effective + 1, 'after')
            }
            await runtime.advance(period * 5 + 1)
            await burst(max, 'restored')
            await runtime.advance(period + 1)
            await burst(max, 'clamped-zero')
          } finally {
            await f.finish()
          }
        })
      }
    }
  }
}
// No idle recovery loop: even a very overdue review changes correction once.
test('Migrated Recovery after many idle periods advances only one step toward zero', async t => {
  const f = fixture(t, { maxParallelLimit: 4 })
  const { runtime, planner, calls, submit, reply } = f
  try {
    for (let index = 0; index < 4; index++) {
      const handle = submit('overflow')
      await runtime.advance(0)
      reply(calls.length - 1, overflow())
      await assert.rejects(handle.result, { code: 'HTTP_FAILED' })
      await handle.resourcesDone
    }
    await runtime.advance(100001)
    for (let index = 0; index < 4; index++) submit(`probe-${index}`)
    await runtime.advance(0)
    assertLimit(planner, 4, -2)
    assert.equal(calls.length, 6, 'IDLE_RECOVERY_ONE_STEP_ACTUAL_TRANSPORT')
  } finally {
    await f.finish()
  }
})

test('Migrated Two PUT keys recheck real late pause and correction after prepare before accounting', async t => {
  const f = fixture(t, { maxParallelLimit: 3, entityPutPerMinuteLimit: 1 })
  const prepare = deferred<undefined>()
  f.releases.push(() => {
    prepare.resolve(undefined)
  })
  const { runtime, calls, planner, submit, reply } = f
  const delayed = (url: string) => async () => {
    await prepare.promise
    return { url, init: {} }
  }
  try {
    const a = submit('a', { prepare: delayed('a') }, { method: 'PUT', entityKey: 'A' })
    const b = submit('b', { prepare: delayed('b') }, { method: 'PUT', entityKey: 'B' })
    const receipt = submit('receipt')
    await runtime.advance(0)
    assert.equal(calls.length, 1)
    reply(0, overflow(400))
    await assert.rejects(receipt.result, { code: 'HTTP_FAILED' })
    await receipt.resourcesDone
    assertLimit(planner, 3, -1)
    await runtime.advance(100)
    prepare.resolve(undefined)
    await runtime.flush()
    assert.ok([a, b].every(handle => handle.snapshot().phase === 'ready'))
    assert.equal(calls.length, 1, 'PREPARE_RETURN_RECHECKS_RECEIPT')
    await runtime.advance(299)
    assert.equal(calls.length, 1)
    await runtime.advance(1)
    assert.deepEqual(
      calls.slice(1).map(call => call.url),
      ['a', 'b'],
      'BOTH_KEYS_CHARGED_ONLY_AT_ACTUAL_DISPATCH'
    )
    assert.equal(planner.snapshot().sentActive, 2)
    reply(1)
    reply(2)
    await Promise.all([expectValue(a), expectValue(b)])
    for (const key of ['A', 'B']) {
      const rejected = submit(`duplicate-${key}`, {}, { method: 'PUT', entityKey: key })
      await assert.rejects(rejected.result, { code: 'PUT_LIMIT' })
      assert.equal(rejected.snapshot().dispatchCalls, 0, 'PER_KEY_LIMIT_CHECKED_BEFORE_TRANSPORT')
    }
    const c = submit('c', {}, { method: 'PUT', entityKey: 'C' })
    await runtime.advance(0)
    assert.equal(entry(calls, 3).url, 'c', 'KEY_LIMIT_DOES_NOT_STOP_OTHER_ENTITIES')
    reply(3)
    await expectValue(c)
    assert.equal(planner.snapshot().stopped, false)
  } finally {
    await f.finish()
  }
})
test('Migrated Late error receipt opens guard before ready work can dispatch', async t => {
  const f = fixture(t, { maxParallelLimit: 2, errorPerMinuteLimit: 2 })
  const prepare = deferred<undefined>()
  f.releases.push(() => {
    prepare.resolve(undefined)
  })
  try {
    const first = f.submit('first')
    const late = f.submit('late')
    await f.runtime.advance(0)
    f.reply(0, overflow(400))
    await assert.rejects(first.result, { code: 'HTTP_FAILED' })
    const blocked = f.submit('blocked', {
      prepare: async () => {
        await prepare.promise
        return { url: 'blocked', init: {} }
      }
    })
    await f.runtime.flush()
    late.abort()
    await assert.rejects(late.result, { code: 'ABORTED' })
    f.reply(1, new Response(null, { status: 500, headers: { 'x-lognex-retry-after': 'invalid' } }))
    await f.runtime.flush()
    prepare.resolve(undefined)
    await assert.rejects(blocked.result, { code: 'GUARD_OPEN' })
    await f.runtime.advance(400)
    assert.equal(f.calls.length, 2, 'LATE_GUARD_RECEIPT_PREVENTS_ACTUAL_DISPATCH')
    assert.equal(f.planner.snapshot().guardOpen, true)
  } finally {
    await f.finish()
  }
})
