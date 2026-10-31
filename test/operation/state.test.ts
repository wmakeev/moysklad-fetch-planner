import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallbackContext } from '../../src/callback-context.js'
import { OperationState } from '../../src/operation-state.js'
import type { Event, ResourceSummary, Snapshot } from '../../src/operation-types.js'
import { deferred } from './helpers.js'

function stamps() {
  let sequence = 0
  return () => ({ sequence: ++sequence, epochTime: 1000 - sequence, elapsedMs: sequence })
}

test('State handle has stable real Promises and is nonthenable', async () => {
  const state = new OperationState<number>(1)
  const handle = state.handle
  const stamp = stamps()
  assert.ok(handle.result instanceof Promise)
  assert.ok(handle.resourcesDone instanceof Promise)
  assert.strictEqual(handle.result, state.handle.result)
  assert.strictEqual(handle.resourcesDone, state.handle.resourcesDone)
  assert.notStrictEqual(handle.result, handle.resourcesDone)
  assert.equal('then' in handle, false)
  assert.equal(Object.isFrozen(handle), true)
  assert.strictEqual(await Promise.resolve(handle), handle)
  assert.deepEqual(handle.snapshot(), {
    id: 1,
    sequence: 0,
    phase: 'queued',
    outcome: 'pending',
    resultCommitted: false,
    resources: 'pending',
    attempts: 0,
    dispatchCalls: 0,
    dispatchEntered: false
  })
  assert.equal('status' in handle.snapshot(), false)
  state.commit({ value: 42 }, 200, stamp())
  state.succeed('released', stamp())
  state.settleResources({ resources: 'released' }, stamp())
  assert.equal((await handle.result).value, 42)
  assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
})

test('State commits scalar fields before notifying a working subscriber', () => {
  const state = new OperationState<number>(1)
  const stamp = stamps()
  const observed: { event: Event; snapshot: Snapshot }[] = []
  const attachment = state.handle.observe(event => {
    observed.push({ event, snapshot: state.handle.snapshot() })
  })
  assert.equal(observed.length, 0)
  state.transition(
    'headers-received',
    {
      phase: 'consuming',
      attempts: 1,
      dispatchCalls: 1,
      dispatchEntered: true,
      status: 200
    },
    stamp()
  )
  assert.equal(observed.length, 1)
  const first = observed[0]
  assert.ok(first)
  assert.equal(first.event.status, 200)
  assert.equal(first.event.phase, 'consuming')
  assert.equal(first.event.attempts, 1)
  assert.equal(first.event.dispatchCalls, 1)
  assert.equal(first.event.dispatchEntered, true)
  assert.equal(first.snapshot.status, first.event.status)
  assert.equal(first.snapshot.phase, first.event.phase)
  assert.equal(first.snapshot.sequence, first.event.sequence)
  assert.ok(first.event.sequence > attachment.snapshot.sequence)
  assert.equal(attachment.snapshot.phase, 'queued')
  attachment.unsubscribe()
  attachment.unsubscribe()
  state.transition('phase-changed', { phase: 'cleanup' }, stamp())
  assert.equal(observed.length, 1)
})

test('State atomic attachment inside delivery sees only future sequences', () => {
  const state = new OperationState<number>(1)
  const stamp = stamps()
  const seen: number[] = []
  const attachments: ReturnType<typeof state.handle.observe>[] = []
  const first = state.handle.observe(() => {
    attachments.push(
      state.handle.observe(event => {
        seen.push(event.sequence)
      })
    )
  })
  state.transition('phase-changed', { phase: 'preparing' }, stamp())
  const attached = attachments[0]
  assert.ok(attached)
  assert.equal(attached.snapshot.sequence, 1)
  assert.deepEqual(seen, [])
  first.unsubscribe()
  state.transition('phase-changed', { phase: 'ready' }, stamp())
  assert.deepEqual(seen, [2])
  attached.unsubscribe()
  attached.unsubscribe()
})

test('State duplicate callback attachments unsubscribe independently', () => {
  const state = new OperationState<number>(1)
  const stamp = stamps()
  let calls = 0
  const listener = () => {
    calls++
  }
  const first = state.handle.observe(listener)
  const second = state.handle.observe(listener)
  first.unsubscribe()
  first.unsubscribe()
  state.transition('phase-changed', { phase: 'preparing' }, stamp())
  assert.equal(calls, 1)
  second.unsubscribe()
})

test('State snapshots and records are frozen detached allowlisted copies', async () => {
  const state = new OperationState<{ secret: string }>(1)
  const stamp = stamps()
  const before = state.handle.snapshot()
  const records: Event[] = []
  state.handle.observe(event => {
    records.push(event)
  })
  const value = { secret: 'CANARY_VALUE' }
  state.commit({ value }, 201, stamp())
  state.succeed('pending', stamp())
  const current = state.handle.snapshot()
  assert.equal(before.resultCommitted, false)
  assert.equal(current.resultCommitted, true)
  assert.equal(current.outcome, 'succeeded')
  assert.notStrictEqual(current, state.handle.snapshot())
  assert.equal(Reflect.set(current, 'status', 999), false)
  assert.equal(Reflect.set(before, 'phase', 'sending'), false)
  for (const event of records) {
    assert.equal(Object.isFrozen(event), true)
    assert.equal(Reflect.set(event, 'value', value), false)
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        'id',
        'sequence',
        'phase',
        'outcome',
        'resultCommitted',
        'resources',
        'attempts',
        'dispatchCalls',
        'dispatchEntered',
        'status',
        'type',
        'epochTime',
        'elapsedMs'
      ].sort()
    )
  }
  assert.equal(JSON.stringify([before, current, ...records]).includes('CANARY'), false)
  assert.equal((await state.handle.result).value, value)
  assert.equal(state.handle.snapshot().status, 201)
  state.settleResources({ resources: 'released' }, stamp())
  await state.handle.resourcesDone
})

test('State result settles once while resources remain pending until a real barrier', async () => {
  const state = new OperationState<object>(1)
  const stamp = stamps()
  const gate = deferred<undefined>()
  const resourceDeliveries: ResourceSummary[] = []
  let deliveries = 0
  let settlementEvents = 0
  let resourceEvents = 0
  state.handle.observe(event => {
    if (event.type === 'operation-settled') settlementEvents++
    if (event.type === 'resources-settled') resourceEvents++
  })
  const result = state.handle.result.then(completed => {
    deliveries++
    return completed
  })
  const done = state.handle.resourcesDone.then(summary => {
    resourceDeliveries.push(summary)
  })
  const cleanup = gate.promise.then(() => {
    state.settleResources({ resources: 'released' }, stamp())
  })
  const value = { identity: 1 }
  try {
    assert.equal(state.commit({ value }, 200, stamp()), true)
    assert.equal(state.handle.snapshot().outcome, 'pending')
    assert.equal(state.fail('ABORTED', new Error('late abort'), stamp()), false)
    assert.equal(state.commit({ value: {} }, 500, stamp()), false)
    assert.equal(state.succeed('pending', stamp()), true)
    assert.equal(state.succeed('failed', stamp()), false)
    assert.equal(state.fail('DEADLINE', new Error('late deadline'), stamp()), false)
    const completed = await result
    assert.strictEqual(completed.value, value)
    assert.equal(completed.cleanup, 'pending')
    assert.equal(deliveries, 1)
    assert.equal(
      settlementEvents,
      1,
      'one observer delivery, independently of Promise once semantics'
    )
    assert.equal(resourceDeliveries.length, 0)
    assert.equal(state.handle.snapshot().resources, 'pending')
    gate.resolve(undefined)
    await cleanup
    await done
    const repeatedResources = state.settleResources({ resources: 'failed' }, stamp())
    assert.equal(resourceEvents, 1, 'one resource observer delivery despite repeated settlement')
    assert.equal(repeatedResources, false)
    assert.deepEqual(resourceDeliveries, [{ resources: 'released' }])
    assert.equal(completed.cleanup, 'pending')
    assert.equal(state.handle.snapshot().resources, 'released')
  } finally {
    gate.resolve(undefined)
    await cleanup
    await done
  }
})

test('State failure settles once and retains terminal outcome through late HTTP facts', async () => {
  const aborts: unknown[] = []
  const state = new OperationState<object>(1, reason => {
    aborts.push(reason)
  })
  const stamp = stamps()
  const cause = new Error('CANARY_ERROR')
  const events: Event[] = []
  let rejections = 0
  state.handle.observe(event => {
    events.push(event)
  })
  const result = state.handle.result.catch((error: unknown) => {
    rejections++
    assert.strictEqual(error, cause)
  })
  state.handle.abort('request')
  assert.deepEqual(aborts, ['request'])
  state.transition('dispatch-started', { phase: 'sending', dispatchEntered: true }, stamp())
  assert.equal(state.fail('ABORTED', cause, stamp()), true)
  const repeatedFailure = state.fail('DEADLINE', new Error('second'), stamp())
  assert.equal(state.commit({ value: { secret: 'CANARY_LATE_VALUE' } }, 200, stamp()), false)
  assert.equal(state.succeed('released', stamp()), false)
  state.handle.abort('ignored')
  state.transition('late-completion', { phase: 'consuming', status: 200 }, stamp())
  await result
  assert.equal(rejections, 1)
  assert.equal(events.filter(event => event.type === 'operation-settled').length, 1)
  assert.equal(repeatedFailure, false)
  assert.equal(state.handle.snapshot().outcome, 'failed')
  assert.equal(state.handle.snapshot().phase, 'terminal')
  assert.equal(state.handle.snapshot().status, 200)
  assert.equal(state.handle.snapshot().failureCode, 'ABORTED')
  assert.deepEqual(aborts, ['request'])
  assert.equal(JSON.stringify(events).includes('CANARY'), false)
  state.settleResources({ resources: 'failed' }, stamp())
  assert.deepEqual(await state.handle.resourcesDone, { resources: 'failed' })
})

test('State final snapshot is bounded and subscriptions retire after both settlements', async () => {
  const state = new OperationState<number>(1)
  const stamp = stamps()
  const events: Event[] = []
  state.handle.observe(event => {
    events.push(event)
  })
  state.commit({ value: 1 }, 200, stamp())
  state.settleResources({ resources: 'released' }, stamp())
  const repeatedResources = state.settleResources({ resources: 'failed' }, stamp())
  assert.equal(
    events.filter(event => event.type === 'resources-settled').length,
    1,
    'one resource observer delivery before result settlement'
  )
  assert.equal(repeatedResources, false)
  state.succeed('released', stamp())
  await state.handle.result
  await state.handle.resourcesDone
  assert.deepEqual(
    events.map(event => event.type),
    ['phase-changed', 'resources-settled', 'operation-settled']
  )
  const final = state.handle.snapshot()
  const attachment = state.handle.observe(event => {
    events.push(event)
  })
  assert.deepEqual(attachment.snapshot, final)
  state.transition('late-completion', { status: 500 }, stamp())
  assert.deepEqual(state.handle.snapshot(), final)
  assert.equal(events.length, 3)
  assert.equal('value' in final, false)
  assert.equal('cause' in final, false)
  assert.equal('events' in final, false)
  // Internal retention seam; no additional public diagnostics or test exports.
  const listeners: unknown = Reflect.get(state, 'listeners')
  const committed: unknown = Reflect.get(state, 'committed')
  const abortRequest: unknown = Reflect.get(state, 'abortRequest')
  assert.ok(listeners instanceof Set)
  assert.equal(listeners.size, 0)
  assert.equal(committed, undefined)
  assert.equal(abortRequest, undefined)
  attachment.unsubscribe()
  attachment.unsubscribe()
})

test('State rejected sentinel handles allocate no sequence or observer events', async () => {
  for (const code of [
    'QUEUE_FULL',
    'STOPPED',
    'REENTRANT_OPERATION',
    'INVALID_ARGUMENT'
  ] as const) {
    const error = new Error(`CANARY_${code}`)
    const handle = OperationState.rejected<number>(code, error)
    const seen: Event[] = []
    const attachment = handle.observe(event => {
      seen.push(event)
    })
    handle.abort('ignored')
    await assert.rejects(handle.result, failure => failure === error)
    assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
    assert.equal(handle.id, 0)
    assert.equal(handle.snapshot().sequence, 0)
    assert.equal(handle.snapshot().failureCode, code)
    assert.equal(handle.snapshot().attempts, 0)
    assert.equal(handle.snapshot().outcome, 'failed')
    assert.equal('status' in handle.snapshot(), false)
    assert.equal(JSON.stringify(handle.snapshot()).includes('CANARY'), false)
    assert.deepEqual(seen, [])
    attachment.unsubscribe()
    attachment.unsubscribe()
  }
})

test('State keeps guarded raw values inside Completed without another then read', async () => {
  const context = new CallbackContext()
  const state = new OperationState<object>(1)
  const stamp = stamps()
  let thenReads = 0
  const raw = Object.defineProperty({}, 'then', {
    get() {
      thenReads++
      throw new Error('unguarded raw assimilation')
    }
  })
  const boxed = await context.run(
    () => 1,
    () => raw
  )
  state.commit(boxed, 200, stamp())
  state.succeed('released', stamp())
  state.settleResources({ resources: 'released' }, stamp())
  const completed = await state.handle.result
  assert.strictEqual(completed.value, raw)
  assert.equal(thenReads, 0)
  assert.equal(Object.isFrozen(completed), true)
  await state.handle.resourcesDone
})

test('State successful values survive failed cleanup and unknown resources', async () => {
  const state = new OperationState<number>(1)
  const stamp = stamps()
  state.commit({ value: 42 }, 200, stamp())
  state.settleResources({ resources: 'unknown' }, stamp())
  state.succeed('failed', stamp())
  assert.equal((await state.handle.result).value, 42)
  assert.equal((await state.handle.result).cleanup, 'failed')
  assert.deepEqual(await state.handle.resourcesDone, { resources: 'unknown' })
  assert.equal(state.handle.snapshot().outcome, 'succeeded')
})

test('State defers delivery while committing ordered facts and atomic attachment snapshots', async () => {
  const state = new OperationState<number>(1)
  const stamp = stamps()
  const seen: Event[] = []
  const attached: Event[] = []
  state.handle.observe(event => {
    seen.push(event)
  })
  const cause = new Error('synchronous abort')
  assert.throws(
    () =>
      state.deferDelivery(() => {
        state.transition(
          'dispatch-started',
          { phase: 'sending', dispatchEntered: true, dispatchCalls: 1 },
          stamp()
        )
        assert.equal(state.snapshot().phase, 'sending')
        assert.equal(state.snapshot().dispatchCalls, 1)
        assert.deepEqual(seen, [])
        const attachment = state.handle.observe(event => {
          attached.push(event)
        })
        assert.equal(attachment.snapshot.sequence, 1)
        assert.equal(attachment.snapshot.dispatchEntered, true)
        state.fail('ABORTED', cause, stamp())
        assert.equal(state.snapshot().outcome, 'failed')
        assert.deepEqual(seen, [])
        assert.deepEqual(attached, [])
        throw cause
      }),
    error => error === cause
  )
  assert.deepEqual(
    seen.map(event => [event.sequence, event.type]),
    [
      [1, 'dispatch-started'],
      [2, 'operation-settled']
    ]
  )
  assert.deepEqual(
    attached.map(event => event.sequence),
    [2]
  )
  state.settleResources({ resources: 'released' }, stamp())
  await assert.rejects(state.handle.result, error => error === cause)
  await state.handle.resourcesDone
  assert.deepEqual(
    seen.map(event => event.sequence),
    [1, 2, 3]
  )
  assert.deepEqual(
    attached.map(event => event.sequence),
    [2, 3]
  )
})
