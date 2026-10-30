import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Response } from 'undici'
import { FetchPlanner, type FetchPlannerEventMap } from '../src/index.js'
import { createRuntime, trackTimeouts } from './helpers/runtime.js'

const overflow = () => new Response(null, { status: 429, headers: { 'X-Lognex-Auth': '429005' } })

class ObservedPlanner extends FetchPlanner {
  slotChecks = 0

  protected override checkFreeRequestSlotTrigger() {
    this.slotChecks++
    super.checkFreeRequestSlotTrigger()
  }
}

function assertLimit(planner: FetchPlanner, max: number, expected: number) {
  const correction = planner.getParallelLimitCorrection()
  assert.equal(correction, expected, 'Correction is clamped at the state transition')
  assert.ok(correction >= 1 - max && correction <= 0, 'Correction stays in [1-max, 0]')
  assert.ok(max + correction >= 1 && max + correction <= max, 'Effective limit stays in [1, max]')
}

function deferredTransport() {
  const pending: { resolve: (response: Response) => void; url: unknown }[] = []
  let starts = 0
  return {
    pending,
    starts: () => starts,
    fetch: (url: unknown) => {
      starts++
      return new Promise<Response>(resolve => pending.push({ resolve, url }))
    },
    reply(response = new Response(null)) {
      const attempt = pending.shift()
      assert.ok(attempt, 'An inflight attempt exists')
      attempt.resolve(response)
    }
  }
}

for (const max of [1, 2, 4]) {
  test(`D06 repeated parallel overflow at max ${max} clamps correction and preserves priority admission`, async t => {
    const runtime = createRuntime(t)
    const timers = trackTimeouts(t)
    const transport = deferredTransport()
    const planner = new ObservedPlanner(transport.fetch, { maxParallelLimit: max, jitter: 0 })
    const fetch = planner.getFetch()
    const results = [fetch('http://offline.test/retry')]
    await runtime.advance(0)
    for (let attempt = 1; attempt <= max + 3; attempt++) {
      transport.reply(overflow())
      await runtime.flush()
      assertLimit(planner, max, Math.max(1 - max, -attempt))
      assert.equal(planner.getActionsQueueLength(), 1, 'Overflow retries the same queued action')
      await runtime.advance(0)
      assert.equal(transport.pending.length, 1)
    }

    for (let index = 0; index < max + 2; index++) {
      results.push(fetch(`http://offline.test/queued-${index}`))
    }
    const admitted: number[] = []
    const low = planner.waitForFreeRequestSlot(10).then(() => {
      admitted.push(10)
      results.push(fetch('http://offline.test/low'))
    })
    const high = planner.waitForFreeRequestSlot(-10).then(() => {
      admitted.push(-10)
      results.push(fetch('http://offline.test/high'))
    })
    const starts = transport.starts()
    await runtime.advance(0)
    assert.equal(
      transport.starts(),
      starts,
      'Enqueue and slot waits cannot bypass the minimum limit'
    )
    assert.deepEqual(admitted, [])

    for (let index = 0; index < max + 3; index++) {
      assert.equal(transport.pending.length, 1, 'Only one transport runs at the minimum limit')
      transport.reply()
      await runtime.advance(0)
    }
    await high
    await runtime.advance(0)
    assert.deepEqual(
      admitted,
      [-10],
      'The higher priority waiter enqueues before the next slot check'
    )
    assert.equal(planner.getRequestSlotHandlersCount(), 1)
    assert.equal(transport.pending.length, 1)
    transport.reply()
    await runtime.advance(0)
    await low
    await runtime.advance(0)
    assert.deepEqual(admitted, [-10, 10])
    assert.equal(transport.pending.length, 1)
    transport.reply()
    await runtime.flush()
    await Promise.all(results)
    assertLimit(planner, max, 1 - max)
    assert.ok(planner.slotChecks >= max + 5, 'The protected slot hook remains active')
    assert.equal(planner.getCurInflightRequestsCount(), 0)
    assert.equal(planner.getActionsQueueLength(), 0)
    assert.equal(timers.maximum(), 1)
    assert.equal(timers.active.size, 0)
  })
}

for (const max of [2, 4]) {
  test(`Late responses at max ${max} retain sent transports while new and reentrant work waits`, async t => {
    const runtime = createRuntime(t)
    const transport = deferredTransport()
    const events = new EventEmitter<FetchPlannerEventMap<typeof import('undici').fetch>>()
    const planner = new ObservedPlanner(transport.fetch, {
      maxParallelLimit: max,
      jitter: 0,
      eventHandler: events
    })
    const fetch = planner.getFetch()
    const results = Array.from({ length: max }, (_, index) => fetch(`http://offline.test/${index}`))
    let reentered = false
    events.on('response', event => {
      if (event.responseType === 'PARALLEL_LIMIT_OVERFLOW' && !reentered) {
        reentered = true
        results.push(fetch('http://offline.test/reentrant'))
      }
    })
    await runtime.advance(0)
    assert.equal(transport.starts(), max)
    for (let index = 1; index < max; index++) {
      transport.reply(overflow())
      await runtime.advance(0)
      assertLimit(planner, max, -index)
      assert.equal(
        planner.getCurInflightRequestsCount(),
        max - index,
        'Sent transports retain their slots'
      )
      assert.equal(transport.pending.length, max - index, 'Sent transports are not canceled')
      assert.equal(
        transport.starts(),
        max,
        'No replacement while inflight equals the reduced limit'
      )
    }
    results.push(fetch('http://offline.test/late-enqueue'))
    await runtime.advance(0)
    assert.equal(transport.starts(), max)
    transport.reply() // The final original transport returns a late success.
    await runtime.advance(0)
    assertLimit(planner, max, 1 - max)
    assert.equal(transport.starts(), max + 1, 'Exactly one retry starts after the late response')
    assert.equal(transport.pending.length, 1)
    transport.reply(overflow()) // Repeated overflow at the minimum must stay there.
    await runtime.advance(0)
    assertLimit(planner, max, 1 - max)
    for (let index = 0; index < max + 1; index++) {
      assert.equal(transport.pending.length, 1)
      transport.reply()
      await runtime.advance(0)
    }
    await Promise.all(results)
    assert.equal(planner.getCurInflightRequestsCount(), 0)
    assert.equal(planner.getActionsQueueLength(), 0)
    assert.ok(planner.slotChecks > max)
  })
}

for (const max of [1, 2, 4]) {
  for (const random of [0, 0.5, 1]) {
    test(`Recovery at max ${max} with random ${random} uses monotonic periods and the existing jitter formula`, async t => {
      const runtime = createRuntime(t)
      runtime.setRandom(random)
      const timers = trackTimeouts(t)
      const transport = deferredTransport()
      const planner = new FetchPlanner<typeof import('undici').fetch>(transport.fetch, {
        maxParallelLimit: max,
        parallelLimitCorrectionPeriodMs: 1000,
        jitter: 0.3
      })
      const fetch = planner.getFetch()
      const first = fetch('http://offline.test/retry')
      await runtime.advance(0)
      for (let index = 0; index < max + 1; index++) {
        transport.reply(overflow())
        await runtime.advance(0)
      }
      assertLimit(planner, max, 1 - max)
      transport.reply()
      await runtime.flush()
      await first

      async function probe(expected: number) {
        const result = fetch('http://offline.test/probe')
        await runtime.advance(0)
        assertLimit(planner, max, expected)
        transport.reply()
        await runtime.flush()
        await result
      }

      const monotonic = performance.now()
      for (const jump of [10_000_000, -20_000_000]) {
        runtime.jumpWall(jump)
        await probe(1 - max)
        assert.equal(performance.now(), monotonic, 'Date jumps do not advance interval time')
      }
      const period = 1000 * (1 + 2 * random * 0.3)
      for (let correction = 1 - max; correction < 0; correction++) {
        await runtime.advance(period)
        await probe(correction) // Preserve the existing strict period comparison.
        await runtime.advance(1)
        await probe(correction + 1)
      }
      await runtime.advance(period + 1)
      await probe(0)
      await runtime.advance(period + 1)
      await probe(0)

      const results = Array.from({ length: max + 1 }, (_, index) =>
        fetch(`http://offline.test/restored-${index}`)
      )
      await runtime.advance(0)
      assert.equal(transport.pending.length, max, 'Recovery restores admission up to max')
      for (let index = 0; index < max + 1; index++) {
        transport.reply()
        await runtime.advance(0)
        assert.ok(transport.pending.length <= max)
      }
      await Promise.all(results)
      assertLimit(planner, max, 0)
      assert.equal(planner.getActionsQueueLength(), 0)
      assert.equal(timers.maximum(), 1)
      assert.equal(timers.active.size, 0)
    })
  }
}
