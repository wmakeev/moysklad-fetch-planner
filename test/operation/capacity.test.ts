import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallbackContext } from '../../src/callback-context.js'
import { OperationCapacity } from '../../src/operation-capacity.js'
import { OperationResources } from '../../src/operation-resources.js'
import { OperationState } from '../../src/operation-state.js'
import type { Spec } from '../../src/operation-types.js'
import { deferred } from './helpers.js'

function spec(value: number): Spec<RequestInit, Response, number> {
  return {
    method: 'GET',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: () => ({ url: 'https://offline.invalid', init: {} }),
    consume: () => value
  }
}

/** Inspect actual storage, including erroneous retained entries beyond reported counters. */
function retained<T>(capacity: OperationCapacity<T>): unknown[] {
  const entries: unknown = Reflect.get(capacity, 'reservations')
  assert.ok(entries instanceof Map)
  const values: unknown[] = []
  for (const entry of entries.values()) {
    const item: unknown = entry
    assert.ok(typeof item === 'object' && item !== null && 'value' in item)
    values.push(item.value)
  }
  return values
}

test('Capacity reserves before retaining a burst of actual specs', () => {
  const capacity = new OperationCapacity<Spec<RequestInit, Response, number>>(2, 1)
  const specs = Array.from({ length: 100 }, (_, index) => spec(index))
  const accepted = specs.flatMap(value => {
    const reservation = capacity.reserve(value)
    return reservation ? [reservation] : []
  })
  assert.equal(accepted.length, 2)
  const stored = retained(capacity)
  assert.equal(stored.length, 2, 'retained specs must be bounded before drain')
  assert.equal(stored[0], specs[0])
  assert.equal(stored[1], specs[1])
  assert.equal(capacity.snapshot().queued, 2)
  for (const reservation of accepted) assert.equal(reservation.enqueue(), true)
  for (const value of specs.slice(0, 2)) {
    const taken = capacity.take()
    assert.ok(taken)
    assert.equal(taken.value, value)
    assert.equal(taken.lease.release(), true)
  }
  assert.deepEqual(retained(capacity), [])
  assert.equal(capacity.take(), undefined)
})

test('Capacity reservations include pending commands and retry wait without blocking ready FIFO', () => {
  const capacity = new OperationCapacity<object>(3, 1)
  const retry = {}
  const first = {}
  const second = {}
  const waiting = capacity.reserve(retry)
  const a = capacity.reserve(first)
  const b = capacity.reserve(second)
  assert.ok(waiting && a && b)
  assert.equal(a.enqueue(), true)
  assert.equal(a.enqueue(), false)
  assert.equal(b.enqueue(), true)
  assert.equal(capacity.reserve({}), undefined)
  const taken = capacity.take()
  assert.ok(taken)
  assert.equal(taken.value, first)
  assert.equal(capacity.snapshot().queued, 2)
  assert.equal(capacity.take(), undefined, 'full lease does not dequeue or evict')
  assert.equal(waiting.enqueue(), true, 'ready retry joins the tail')
  taken.lease.release()
  for (const value of [second, retry]) {
    const next = capacity.take()
    assert.ok(next)
    assert.equal(next.value, value)
    next.lease.release()
  }
  assert.equal(waiting.release(), false)
  assert.equal(waiting.enqueue(), false)
})

test('Capacity Q1 and L1 are independent and reservation release is once', () => {
  const capacity = new OperationCapacity<object>(1, 1)
  const first = capacity.reserve({})
  assert.ok(first)
  assert.equal(capacity.take(), undefined, 'unapplied reservation is not ready')
  first.enqueue()
  const active = capacity.take()
  assert.ok(active)
  const queued = capacity.reserve({})
  assert.ok(queued)
  queued.enqueue()
  assert.equal(capacity.reserve({}), undefined)
  assert.equal(capacity.take(), undefined)
  assert.deepEqual(capacity.snapshot(), {
    queued: 1,
    leasedAttempts: 1,
    sentActive: 0,
    effectiveParallelism: 1
  })
  assert.equal(queued.release(), true)
  assert.equal(queued.release(), false)
  assert.equal(queued.enqueue(), false)
  assert.equal(capacity.snapshot().queued, 0)
  assert.equal(active.lease.release(), true)
  assert.equal(active.lease.release(), false)
  assert.equal(active.lease.trySend(), undefined)
  assert.equal(capacity.snapshot().leasedAttempts, 0)
  const again = capacity.reserve({})
  assert.ok(again)
  again.enqueue()
  const next = capacity.take()
  assert.ok(next)
  next.lease.release()
})

test('Capacity sent tokens are once and a decreased effective limit preserves active work', () => {
  const capacity = new OperationCapacity<number>(1, 3)
  const attempts = Array.from({ length: 3 }, (_, value) => {
    const reservation = capacity.reserve(value)
    assert.ok(reservation)
    reservation.enqueue()
    const taken = capacity.take()
    assert.ok(taken)
    return taken
  })
  const [a, b, c] = attempts
  assert.ok(a && b && c)
  const sentA = a.lease.trySend()
  const sentB = b.lease.trySend()
  assert.ok(sentA && sentB)
  capacity.setEffectiveParallelism(1)
  assert.equal(capacity.snapshot().sentActive, 2)
  assert.equal(c.lease.trySend(), undefined)
  assert.throws(() => a.lease.release(), /SENT_WORK_PENDING/)
  assert.equal(sentA.release(), true)
  assert.equal(sentA.release(), false)
  assert.equal(capacity.snapshot().sentActive, 1)
  assert.equal(c.lease.trySend(), undefined)
  assert.equal(a.lease.trySend(), undefined)
  assert.equal(sentB.release(), true)
  const sentC = c.lease.trySend()
  assert.ok(sentC)
  assert.equal(capacity.snapshot().leasedAttempts, 3, 'sent release retains lease')
  sentC.release()
  assert.equal(sentC.release(), false)
  for (const attempt of attempts) {
    assert.equal(attempt.lease.release(), true)
    assert.equal(attempt.lease.release(), false)
  }
  assert.equal(capacity.snapshot().sentActive, 0)
  assert.equal(capacity.snapshot().leasedAttempts, 0)
})

test('Capacity rejects zero fractional nonfinite unsafe and excessive limits without mutation', () => {
  for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new OperationCapacity(invalid, 1), /INVALID_CAPACITY_LIMIT/)
    assert.throws(() => new OperationCapacity(1, invalid), /INVALID_CAPACITY_LIMIT/)
  }
  const capacity = new OperationCapacity(1, 2)
  for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 3]) {
    assert.throws(() => {
      capacity.setEffectiveParallelism(invalid)
    }, /INVALID_CAPACITY_LIMIT/)
    assert.equal(capacity.snapshot().effectiveParallelism, 2)
  }
  assert.doesNotThrow(() => new OperationCapacity(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))
  const snapshot = capacity.snapshot()
  capacity.setEffectiveParallelism(1)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(snapshot.effectiveParallelism, 2)
})

test('Capacity logical terminal and unrelated settlement retain a pending owner lease and sent token', async () => {
  const capacity = new OperationCapacity<Spec<RequestInit, Response, number>>(1, 1)
  const reservation = capacity.reserve(spec(1))
  assert.ok(reservation)
  reservation.enqueue()
  const attempt = capacity.take()
  assert.ok(attempt)
  const sent = attempt.lease.trySend()
  assert.ok(sent)
  const owner = deferred<undefined>()
  const resources = new OperationResources(new CallbackContext())
  const state = new OperationState<number>(1)
  const stamp = { sequence: 1, epochTime: 0, elapsedMs: 0 }
  const work = resources.runOwner(
    'consume',
    () => owner.promise,
    () => undefined
  )
  const cleanup = resources.cleanup(true).then(() => {
    sent.release()
    attempt.lease.release()
    state.settleResources({ resources: 'released' }, { ...stamp, sequence: 2 })
  })
  try {
    state.fail('ABORTED', new Error('aborted'), stamp)
    await assert.rejects(state.handle.result, /aborted/)
    const unrelated = new OperationState<number>(2)
    unrelated.fail('STOPPED', new Error('stopped'), stamp)
    unrelated.settleResources({ resources: 'released' }, stamp)
    await assert.rejects(unrelated.handle.result, /stopped/)
    await unrelated.handle.resourcesDone
    assert.equal(state.handle.snapshot().resources, 'pending')
    assert.equal(capacity.snapshot().leasedAttempts, 1)
    assert.equal(capacity.snapshot().sentActive, 1)
    const next = capacity.reserve(spec(2))
    assert.ok(next)
    next.enqueue()
    assert.equal(capacity.take(), undefined, 'pending owner forbids another lease')
  } finally {
    owner.resolve(undefined)
    await work
    await cleanup
  }
  assert.equal(capacity.snapshot().leasedAttempts, 0)
  assert.equal(capacity.snapshot().sentActive, 0)
  const next = capacity.take()
  assert.ok(next)
  next.lease.release()
  assert.deepEqual(retained(capacity), [])
})
