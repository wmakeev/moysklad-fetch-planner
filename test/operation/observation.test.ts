import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { FetchPlanner, OperationError } from '../../src/index.js'
import {
  ObservationDiagnostics,
  ObservationSequence,
  OperationObservation
} from '../../src/operation-observation.js'
import { OperationState } from '../../src/operation-state.js'
import type { Event, Snapshot } from '../../src/operation-types.js'
import { createRuntime, deferred } from './helpers.js'

const replay = { serverSafe: false, consumeSafe: false }
const transport: typeof globalThis.fetch = () => Promise.resolve(new Response('ok'))
const snapshotKeys = [
  'id',
  'sequence',
  'phase',
  'outcome',
  'resultCommitted',
  'resources',
  'attempts',
  'dispatchCalls',
  'dispatchEntered'
]
function checkRecord(record: Event | Snapshot) {
  assert.equal(Object.isFrozen(record), true)
  const keys = [...snapshotKeys]
  if ('status' in record) keys.push('status')
  if ('failureCode' in record) keys.push('failureCode')
  if ('type' in record) keys.push('type', 'epochTime', 'elapsedMs')
  assert.deepEqual(Object.keys(record).sort(), keys.sort(), 'EXACT_RECORD_ALLOWLIST')
  assert.ok(
    Object.values(record).every(value => ['number', 'string', 'boolean'].includes(typeof value))
  )
  assert.equal(JSON.stringify(record).includes('CANARY'), false, 'NO_RAW_DETAILS')
}
function observationOf(target: object): OperationObservation {
  const value: unknown = Reflect.get(target, 'observation')
  assert.ok(value instanceof OperationObservation)
  return value
}
function sequenceOf(target: object): ObservationSequence {
  const value: unknown = Reflect.get(target, 'observationSequence')
  assert.ok(value instanceof ObservationSequence)
  return value
}
function stamps() {
  let sequence = 0
  return () => ({ sequence: ++sequence, epochTime: 1000 - sequence, elapsedMs: sequence })
}
function spec() {
  return {
    method: 'GET' as const,
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: (response: Response) => response.text()
  }
}

test('Public atomic observation commits all fields before callbacks and attaches without replay', async () => {
  const planner = new FetchPlanner(transport)
  const handle = planner.submit(spec())
  const seen: { event: Event; snapshot: Snapshot; plannerSequence: number }[] = []
  const late: Event[] = []
  const attachments: ReturnType<typeof handle.observe>[] = []
  const attachment = handle.observe(event => {
    seen.push({ event, snapshot: handle.snapshot(), plannerSequence: planner.snapshot().sequence })
    if (event.type === 'headers-received')
      attachments.push(
        handle.observe(next => {
          late.push(next)
        })
      )
  })
  assert.equal(Number(seen.length), 0, 'INITIAL_SNAPSHOT_IS_NOT_A_CALLBACK')
  await handle.result
  await handle.resourcesDone
  assert.ok(seen.length > 5)
  for (const { event, snapshot, plannerSequence } of seen) {
    for (const key of Object.keys(snapshot)) {
      assert.equal(Reflect.get(event, key), Reflect.get(snapshot, key), 'COMMIT_BEFORE_FANOUT')
    }
    assert.equal(event.sequence, plannerSequence)
    checkRecord(event)
    checkRecord(snapshot)
    assert.ok(event.sequence > attachment.snapshot.sequence)
  }
  const attached = attachments[0]
  assert.ok(attached)
  const headers = seen.find(item => item.event.type === 'headers-received')
  assert.ok(headers)
  assert.equal(headers.event.phase, 'classifying')
  assert.equal(headers.event.status, 200)
  assert.equal(headers.event.attempts, 1)
  assert.equal(headers.event.dispatchCalls, 1)
  assert.equal(headers.event.dispatchEntered, true)
  assert.equal(attached.snapshot.sequence, headers.event.sequence)
  assert.deepEqual(
    late.map(event => event.sequence),
    seen
      .filter(item => item.event.sequence > attached.snapshot.sequence)
      .map(item => item.event.sequence)
  )
  attachment.unsubscribe()
  attachment.unsubscribe()
  attached.unsubscribe()
  assert.equal(observationOf(planner).diagnostics.snapshot().OBSERVER_FAILED, 0)
})

test('Both scopes capture the entire fanout and detach a frozen record per listener', () => {
  const planner = new OperationObservation()
  const state = new OperationState<number>(1, undefined, planner)
  const stamp = stamps()
  const seen: Event[] = []
  const late: Event[] = []
  const attachments: ReturnType<typeof state.handle.observe>[] = []
  const first = planner.attach(
    () => {
      second.unsubscribe()
      attachments.push(
        state.handle.observe(event => {
          late.push(event)
        })
      )
    },
    () => state.snapshot()
  )
  planner.attach(
    event => {
      seen.push(event)
    },
    () => state.snapshot()
  )
  const second = state.handle.observe(event => {
    seen.push(event)
  })
  state.transition(
    'headers-received',
    { phase: 'consuming', status: 200, attempts: 1, dispatchCalls: 1, dispatchEntered: true },
    stamp()
  )
  assert.equal(seen.length, 2, 'UNSUBSCRIBE_AFFECTS_NEXT_RECORD')
  assert.notStrictEqual(seen[0], seen[1], 'DETACHED_RECORD_PER_LISTENER')
  for (const record of seen) {
    checkRecord(record)
    assert.equal(Reflect.set(record, 'status', 999), false)
  }
  assert.equal(state.snapshot().status, 200)
  assert.equal(late.length, 0, 'ATTACH_DURING_FANOUT_HAS_NO_CURRENT_RECORD')
  assert.equal(attachments[0]?.snapshot.sequence, 1)
  first.unsubscribe()
  state.transition('phase-changed', { phase: 'cleanup' }, stamp())
  assert.equal(seen.length, 3)
  assert.deepEqual(
    late.map(event => event.sequence),
    [2]
  )
})

test('Observer throws, rejected promises and hostile thenables cannot affect public policy', async () => {
  const planner = new FetchPlanner(transport)
  const events: Event[] = []
  const faults: ((event: Event) => unknown)[] = [
    () => {
      throw new Error('CANARY_THROW')
    },
    () => Promise.reject(new Error('CANARY_REJECTION')),
    () => ({
      get then() {
        throw new Error('CANARY_THEN_GETTER')
      }
    }),
    () => ({
      then(_resolve: unknown, reject: (error: Error) => void) {
        reject(new Error('CANARY_THENABLE'))
        throw new Error('CANARY_SECOND')
      }
    }),
    event => Object.assign(event, { status: 999 })
  ]
  for (const fault of faults)
    planner.observe(event => {
      if (event.type === 'headers-received') return fault(event)
      return undefined
    })
  planner.observe(event => {
    events.push(event)
    return { type: 'deny', code: 'CANARY_VETO' }
  })
  const handle = planner.submit(spec())
  assert.equal((await handle.result).value, 'ok')
  await handle.resourcesDone
  await setImmediate()
  assert.equal(observationOf(planner).diagnostics.snapshot().OBSERVER_FAILED, faults.length)
  assert.equal(events.filter(event => event.type === 'headers-received').length, 1)
  assert.equal(events.find(event => event.type === 'headers-received')?.status, 200)
  assert.equal(handle.snapshot().outcome, 'succeeded')
  events.forEach(checkRecord)
  assert.equal(
    events.length,
    new Set(events.map(event => event.sequence)).size,
    'NO_DIAGNOSTIC_EVENT_STORM'
  )
})

test('All real records omit URL, body, key, metadata, raw value and error details', async () => {
  const planner = new FetchPlanner(transport)
  const records: Event[] = []
  planner.observe(event => {
    records.push(event)
  })
  const value = { secret: 'CANARY_VALUE', metadata: 'CANARY_METADATA' }
  const success = planner.submit({
    method: 'PUT',
    entityKey: 'CANARY_KEY',
    replay,
    prepare: () => ({
      url: 'https://CANARY_URL.invalid',
      init: { body: 'CANARY_BODY', headers: { secret: 'CANARY_HEADER' } }
    }),
    consume: async response => {
      await response.text()
      return value
    }
  })
  assert.strictEqual((await success.result).value, value)
  await success.resourcesDone
  const cause = new Error('CANARY_MESSAGE', { cause: 'CANARY_CAUSE' })
  const failed = planner.submit({
    ...spec(),
    prepare: () => {
      throw cause
    }
  })
  await assert.rejects(
    failed.result,
    error => error instanceof OperationError && error.cause === cause
  )
  await failed.resourcesDone
  const late: Event[] = []
  failed.observe(event => {
    late.push(event)
  })
  assert.deepEqual(late, [])
  for (const record of [...records, success.snapshot(), failed.snapshot()]) checkRecord(record)
  assert.ok(
    records.some(
      event => event.type === 'operation-settled' && event.failureCode === 'PREPARE_FAILED'
    )
  )
  assert.ok(records.some(event => event.type === 'resources-settled'))
})

test('Late HTTP and resources remain visible after logical failure without leaking cause', async () => {
  const receipt = deferred<Response>()
  const sent = deferred<undefined>()
  const delayed: typeof globalThis.fetch = () => {
    sent.resolve(undefined)
    return receipt.promise
  }
  const planner = new FetchPlanner(delayed)
  const records: Event[] = []
  planner.observe(event => {
    records.push(event)
  })
  const handle = planner.submit(spec())
  try {
    await sent.promise
    handle.abort(new Error('CANARY_ABORT'))
    await assert.rejects(
      handle.result,
      error => error instanceof OperationError && error.code === 'ABORTED'
    )
    assert.equal(handle.snapshot().resources, 'pending')
    assert.equal(planner.snapshot().sentActive, 1)
    receipt.resolve(Object.assign(new Response('CANARY_BODY'), { metadata: 'CANARY_METADATA' }))
    await handle.resourcesDone
    assert.equal(handle.snapshot().outcome, 'failed')
    assert.equal(handle.snapshot().status, 200)
    records.forEach(checkRecord)
    checkRecord(handle.snapshot())
    assert.equal(planner.snapshot().sentActive, 0)
  } finally {
    receipt.resolve(new Response())
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Default subscriber bound is 64 per scope and overflow is a typed synchronous rejection', async () => {
  const planner = new FetchPlanner(transport)
  const handle = planner.submit(spec())
  const attachments = Array.from({ length: 64 }, () => planner.observe(() => undefined))
  const operations = Array.from({ length: 64 }, () => handle.observe(() => undefined))
  for (const attach of [
    () => planner.observe(() => undefined),
    () => handle.observe(() => undefined)
  ]) {
    assert.throws(
      attach,
      error => error instanceof OperationError && error.code === 'SUBSCRIBER_LIMIT'
    )
  }
  attachments[0]?.unsubscribe()
  operations[0]?.unsubscribe()
  planner.observe(() => undefined).unsubscribe()
  handle.observe(() => undefined).unsubscribe()
  await handle.result
  await handle.resourcesDone
  // Final handle stores no subscriptions, even after many late attachments.
  for (let index = 0; index < 100; index++) handle.observe(() => undefined)
  const state = new OperationState<number>(1)
  for (let index = 0; index < 64; index++) state.handle.observe(() => undefined)
  const stamp = stamps()
  state.fail('ABORTED', new Error('CANARY'), stamp())
  state.settleResources({ resources: 'released' }, stamp())
  for (let index = 0; index < 100; index++) state.handle.observe(() => undefined)
  const listeners: unknown = Reflect.get(observationOf(state), 'listeners')
  assert.ok(listeners instanceof Set)
  assert.equal(listeners.size, 0)
})

test('Subscriber validation, independent registrations and retirement preserve capacity', () => {
  for (const maxSubscribers of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new FetchPlanner(transport, { maxSubscribers }),
      error => error instanceof OperationError && error.code === 'INVALID_ARGUMENT'
    )
  }
  const planner = new FetchPlanner(transport, { maxSubscribers: 1 })
  assert.throws(
    () => Reflect.apply(planner.observe.bind(planner), planner, [null]),
    error => error instanceof OperationError && error.code === 'INVALID_ARGUMENT'
  )
  const scope = new OperationObservation(2)
  let calls = 0
  const callback = () => {
    calls++
  }
  const first = scope.attach(callback, () => 0)
  scope.attach(callback, () => 0)
  first.unsubscribe()
  first.unsubscribe()
  const state = new OperationState<number>(1, undefined, scope)
  state.transition('created', {}, stamps()())
  assert.equal(calls, 1)
})

test('Diagnostic codes and rejection counters saturate without retaining faults', () => {
  const diagnostics = new ObservationDiagnostics()
  const counts: unknown = Reflect.get(diagnostics, 'counts')
  const rejections: unknown = Reflect.get(diagnostics, 'rejections')
  assert.ok(counts && typeof counts === 'object')
  assert.ok(rejections && typeof rejections === 'object')
  for (const code of ['OBSERVER_FAILED', 'INVALID_HINT', 'LATE_COMPLETION'] as const) {
    Reflect.set(counts, code, Number.MAX_SAFE_INTEGER)
    diagnostics.increment(code)
  }
  Reflect.set(rejections, 'QUEUE_FULL', Number.MAX_SAFE_INTEGER)
  diagnostics.reject('QUEUE_FULL')
  assert.deepEqual(diagnostics.snapshot(), {
    OBSERVER_FAILED: Number.MAX_SAFE_INTEGER,
    INVALID_HINT: Number.MAX_SAFE_INTEGER,
    LATE_COMPLETION: Number.MAX_SAFE_INTEGER,
    rejections: { QUEUE_FULL: Number.MAX_SAFE_INTEGER }
  })
  const scope = new OperationObservation(64, diagnostics)
  const state = new OperationState<number>(1, undefined, scope)
  state.transition('late-completion', {}, stamps()())
  assert.equal(diagnostics.snapshot().LATE_COMPLETION, Number.MAX_SAFE_INTEGER)
})

test('Planner IDs never wrap and rejected sentinel handles allocate no events', async () => {
  const planner = new FetchPlanner(transport)
  Reflect.set(planner, 'nextId', Number.MAX_SAFE_INTEGER)
  const events: Event[] = []
  planner.observe(event => {
    events.push(event)
  })
  const accepted = planner.submit(spec())
  const count = events.length
  const rejected = planner.submit(spec())
  assert.equal(accepted.id, Number.MAX_SAFE_INTEGER)
  assert.equal(rejected.id, 0)
  assert.equal(events.length, count)
  await assert.rejects(
    rejected.result,
    error => error instanceof OperationError && error.code === 'ID_EXHAUSTED'
  )
  await accepted.result
  await Promise.all([accepted.resourcesDone, rejected.resourcesDone])
  assert.equal(Reflect.get(planner, 'nextId'), Number.MAX_SAFE_INTEGER)
  checkRecord(rejected.snapshot())
})

test('Sequence exhaustion fails closed, cleans resources and freezes the last safe sequence', async () => {
  const planner = new FetchPlanner(transport)
  const gate = deferred<undefined>()
  const entered = deferred<undefined>()
  let dispatches = 0
  const localTransport: typeof globalThis.fetch = () => {
    dispatches++
    return transport('', {})
  }
  const pending = new FetchPlanner(localTransport)
  const records: Event[] = []
  pending.observe(event => {
    records.push(event)
  })
  const handle = pending.submit({
    ...spec(),
    prepare: async () => {
      entered.resolve(undefined)
      await gate.promise
      return { url: '', init: {} }
    }
  })
  try {
    await entered.promise
    const allocator = sequenceOf(pending)
    Reflect.set(allocator, 'sequence', Number.MAX_SAFE_INTEGER)
    gate.resolve(undefined)
    await assert.rejects(
      handle.result,
      error => error instanceof OperationError && error.code === 'SEQUENCE_EXHAUSTED'
    )
    await handle.resourcesDone
    assert.equal(dispatches, 0)
    assert.equal(handle.snapshot().resources, 'released')
    assert.equal(pending.snapshot().leasedAttempts, 0)
    assert.equal(pending.snapshot().sequence, Number.MAX_SAFE_INTEGER)
    assert.ok(records.every(event => event.sequence < Number.MAX_SAFE_INTEGER))
    const rejected = pending.submit(spec())
    await assert.rejects(
      rejected.result,
      error => error instanceof OperationError && error.code === 'SEQUENCE_EXHAUSTED'
    )
    assert.equal(rejected.id, 0)
    await rejected.resourcesDone
    const sequence = sequenceOf(planner)
    Reflect.set(sequence, 'sequence', Number.MAX_SAFE_INTEGER - 1)
    assert.equal(sequence.stamp(0, 0).sequence, Number.MAX_SAFE_INTEGER)
    assert.equal(sequence.stamp(0, 1).emit, false)
    assert.equal(sequence.current, Number.MAX_SAFE_INTEGER)
  } finally {
    gate.resolve(undefined)
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Wall clock jumps change epoch only while elapsed and planner sequence stay monotonic', async t => {
  const runtime = createRuntime(t)
  const planner = new FetchPlanner(transport)
  const gate = deferred<undefined>()
  const events: Event[] = []
  planner.observe(event => {
    events.push(event)
  })
  const handle = planner.submit({
    ...spec(),
    prepare: async () => {
      await gate.promise
      return { url: '', init: {} }
    }
  })
  try {
    await runtime.flush()
    runtime.jumpWall(-100_000)
    runtime.tick(5)
    gate.resolve(undefined)
    await handle.result
    await handle.resourcesDone
    assert.ok(
      events.some(
        (event, index) => index > 0 && event.epochTime < (events[index - 1]?.epochTime ?? 0)
      )
    )
    for (let index = 1; index < events.length; index++) {
      const current = events[index]
      const previous = events[index - 1]
      assert.ok(current && previous)
      assert.ok(current.sequence > previous.sequence)
      assert.ok(current.elapsedMs >= previous.elapsedMs)
    }
  } finally {
    gate.resolve(undefined)
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Strict finite observer child exits naturally after rejected and hostile async returns', () => {
  const source = `
    import { FetchPlanner } from './__temp/operation-build/src/index.js';
    import { setImmediate } from 'node:timers/promises';
    const planner = new FetchPlanner(async () => new Response('ok'));
    planner.observe(() => Promise.reject(new Error('CANARY')));
    planner.observe(() => ({ get then() { throw new Error('CANARY') } }));
    const handle = planner.submit({method:'GET', replay:{serverSafe:false,consumeSafe:false},prepare:()=>({url:'',init:{}}),consume:r=>r.text()});
    await handle.result; await handle.resourcesDone; await setImmediate();
  `
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 10_000 }
  )
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.equal(child.signal, null)
})

test('Planner attachment inside fanout receives only future records across operation scopes', async () => {
  const planner = new FetchPlanner(transport)
  const future: Event[] = []
  const attachments: ReturnType<typeof planner.observe>[] = []
  const first = planner.observe(event => {
    if (event.type === 'created')
      attachments.push(
        planner.observe(next => {
          future.push(next)
        })
      )
  })
  const handle = planner.submit(spec())
  const attachment = attachments[0]
  assert.ok(attachment)
  assert.equal(Number(future.length), 0)
  assert.equal(attachment.snapshot.sequence, handle.snapshot().sequence)
  await handle.result
  await handle.resourcesDone
  assert.ok(future.length > 0)
  assert.ok(future.every(event => event.sequence > attachment.snapshot.sequence))
  assert.equal(new Set(future.map(event => event.sequence)).size, future.length)
  first.unsubscribe()
  attachment.unsubscribe()
})

test('Faults after value commit and both settlements preserve milestones and release subscriptions', async () => {
  const planner = new FetchPlanner(transport)
  const handle = planner.submit(spec())
  const milestones: Event[] = []
  const faults: number[] = []
  handle.observe(event => {
    if (event.resultCommitted) {
      faults.push(event.sequence)
      throw new Error('CANARY_POST_COMMIT')
    }
  })
  handle.observe((event): unknown => {
    milestones.push(event)
    if (event.resultCommitted) return Promise.reject(new Error('CANARY_POST_COMMIT_ASYNC'))
    return undefined
  })
  assert.equal((await handle.result).value, 'ok')
  await handle.resourcesDone
  await setImmediate()
  assert.ok(milestones.some(event => event.type === 'operation-settled'))
  assert.ok(milestones.some(event => event.type === 'resources-settled'))
  assert.equal(observationOf(planner).diagnostics.snapshot().OBSERVER_FAILED, faults.length * 2)
  milestones.forEach(checkRecord)
  const scope = new OperationObservation()
  const state = new OperationState<number>(1, undefined, scope)
  const stamp = stamps()
  state.fail('ABORTED', new Error('CANARY'), stamp())
  assert.strictEqual(
    Reflect.get(state, 'plannerObservation'),
    scope,
    'PENDING_RESOURCES_REMAIN_VISIBLE'
  )
  state.settleResources({ resources: 'released' }, stamp())
  assert.equal(
    Reflect.get(state, 'plannerObservation'),
    undefined,
    'FINAL_HANDLE_DETACHES_PLANNER_SUBSCRIPTIONS'
  )
})

test('Reentrant random materialization cannot publish an older sequence after nested submit', async t => {
  const planner = new FetchPlanner(transport)
  const sequences: number[] = []
  planner.observe(event => {
    sequences.push(event.sequence)
  })
  const nested: ReturnType<typeof planner.submit>[] = []
  let once = false
  t.mock.method(Math, 'random', () => {
    if (!once) {
      once = true
      nested.push(planner.submit(spec()))
    }
    return 0.5
  })
  const handle = planner.submit(spec())
  await handle.result
  await handle.resourcesDone
  for (const next of nested) {
    await next.result
    await next.resourcesDone
  }
  for (let index = 1; index < sequences.length; index++) {
    const current = sequences[index]
    const previous = sequences[index - 1]
    assert.ok(current !== undefined && previous !== undefined)
    assert.ok(current > previous, 'PLANNER_WIDE_MONOTONIC_SEQUENCE')
  }
})

test('Nested transport submission cannot overtake the already committed dispatch record', async () => {
  let once = false
  const nested: ReturnType<typeof planner.submit>[] = []
  const localTransport: typeof globalThis.fetch = () => {
    if (!once) {
      once = true
      nested.push(planner.submit(spec()))
    }
    return Promise.resolve(new Response('ok'))
  }
  const planner = new FetchPlanner(localTransport)
  const sequences: number[] = []
  planner.observe(event => {
    sequences.push(event.sequence)
  })
  const handle = planner.submit(spec())
  await handle.result
  await handle.resourcesDone
  for (const next of nested) {
    await next.result
    await next.resourcesDone
  }
  for (let index = 1; index < sequences.length; index++) {
    const current = sequences[index]
    const previous = sequences[index - 1]
    assert.ok(current !== undefined && previous !== undefined)
    assert.ok(current > previous, 'CRITICAL_DELIVERY_REMAINS_PLANNER_WIDE')
  }
})

test('Late records and final snapshots apply the same scalar allowlist to unexpected details', async () => {
  const scope = new OperationObservation()
  const state = new OperationState<number>(1, undefined, scope)
  const records: Event[] = []
  scope.attach(
    event => {
      records.push(event)
    },
    () => state.snapshot()
  )
  const stamp = stamps()
  const cause = new Error('CANARY_MESSAGE', { cause: 'CANARY_CAUSE' })
  state.fail('ABORTED', cause, stamp())
  state.transition(
    'late-completion',
    Object.assign(
      { status: 202 },
      {
        url: 'CANARY_URL',
        body: 'CANARY_BODY',
        entityKey: 'CANARY_KEY',
        value: 'CANARY_VALUE',
        metadata: 'CANARY_METADATA',
        cause
      }
    ),
    stamp()
  )
  state.settleResources({ resources: 'unknown' }, stamp())
  await assert.rejects(state.handle.result, error => error === cause)
  await state.handle.resourcesDone
  records.forEach(checkRecord)
  checkRecord(state.snapshot())
  assert.equal(records.find(event => event.type === 'late-completion')?.status, 202)
  assert.equal(scope.diagnostics.snapshot().LATE_COMPLETION, 1)
})

test('Sequence exhaustion preserves committed value and pending ownership until actual cleanup', async t => {
  const runtime = createRuntime(t)
  const gate = deferred<undefined>()
  const disposing = deferred<undefined>()
  const planner = new FetchPlanner(transport, { cleanupGraceMs: 5 })
  const handle = planner.submit({
    ...spec(),
    prepare: ctx => {
      ctx.onDispose(async () => {
        disposing.resolve(undefined)
        await gate.promise
      })
      return { url: '', init: {} }
    }
  })
  try {
    await disposing.promise
    assert.equal(handle.snapshot().resultCommitted, true)
    Reflect.set(sequenceOf(planner), 'sequence', Number.MAX_SAFE_INTEGER)
    await runtime.advance(5)
    const completed = await handle.result
    assert.equal(completed.value, 'ok')
    assert.equal(completed.cleanup, 'pending')
    assert.equal(handle.snapshot().resources, 'pending')
    assert.equal(planner.snapshot().leasedAttempts, 1)
    assert.equal(planner.snapshot().sentActive, 1)
    gate.resolve(undefined)
    await handle.resourcesDone
    assert.equal(handle.snapshot().outcome, 'succeeded')
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().sequence, Number.MAX_SAFE_INTEGER)
  } finally {
    gate.resolve(undefined)
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

/** Serialized only after TypeScript compilation; assertions run outside observer callbacks. */
async function returnedPromiseChild(mode: string, boundary: string, scope: string) {
  const planner = new FetchPlanner(transport)
  const handle = planner.submit(spec())
  const records: Event[] = []
  const sibling: Event[] = []
  const returned: { promise: Promise<unknown>; descriptors: PropertyDescriptorMap }[] = []
  let matched = 0
  let poisonedReads = 0
  const target = scope === 'planner' ? planner : handle
  target.observe((event): unknown => {
    records.push(event)
    if (
      !(boundary === 'commit'
        ? event.type === 'phase-changed' && event.resultCommitted
        : event.type === boundary)
    )
      return
    matched++
    if (mode === 'throwing-getter')
      return {
        get then() {
          throw new Error('CANARY_GETTER')
        }
      }
    if (mode === 'rejecting-thenable')
      return {
        then(_resolve: unknown, reject: (cause: unknown) => void) {
          reject(new Error('CANARY_THENABLE'))
          throw new Error('CANARY_AFTER_REJECT')
        }
      }
    if (mode === 'async-rejected')
      return (async () => {
        await Promise.resolve()
        throw new Error('CANARY_ASYNC')
      })()
    if (mode === 'cross-realm') {
      const foreign: unknown = runInNewContext("Promise.reject(new Error('CANARY_FOREIGN'))")
      return foreign
    }
    if (mode === 'pending-rejected') {
      return new Promise<unknown>((_resolve, reject) => {
        queueMicrotask(() => {
          reject(new Error('CANARY_FUTURE'))
        })
      })
    }
    class ObserverPromise extends Promise<unknown> {}
    const value = {}
    const fulfilled = Promise.resolve(value)
    // The promise already owns this value. Forwarding it into an unused chain
    // would read the newly hostile getter and orphan that chain's rejection.
    if (mode === 'fulfilled-hostile-value')
      Object.defineProperty(value, 'then', {
        get() {
          throw new Error('CANARY_FULFILLED_VALUE')
        }
      })
    const promise = mode.startsWith('subclass')
      ? new ObserverPromise((_resolve, reject) => {
          reject(new Error('CANARY_SUBCLASS'))
        })
      : mode.startsWith('fulfilled')
        ? fulfilled
        : Promise.reject(new Error('CANARY_REJECTION'))
    if (mode.includes('poisoned'))
      void Object.defineProperty(promise, mode.endsWith('catch') ? 'catch' : 'then', {
        get() {
          poisonedReads++
          throw new Error('CANARY_POISONED_METHOD')
        },
        configurable: true
      })
    if (mode === 'own-methods')
      for (const key of ['then', 'catch'])
        void Object.defineProperty(promise, key, {
          value() {
            poisonedReads++
            throw new Error('CANARY_POISONED_METHOD')
          }
        })
    returned.push({ promise, descriptors: Object.getOwnPropertyDescriptors(promise) })
    return promise
  })
  target.observe(event => {
    sibling.push(event)
  })
  assert.equal((await handle.result).value, 'ok')
  assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
  await setImmediate()
  assert.ok(matched >= 1, 'TARGET_BOUNDARY_REACHED')
  assert.equal(poisonedReads, 0, 'NATIVE_METHOD_PROPERTIES_NOT_READ')
  assert.deepEqual(sibling, records, 'SIBLING_DELIVERY_UNAFFECTED')
  assert.equal(new Set(records.map(event => event.sequence)).size, records.length)
  assert.ok(records.some(event => event.type === 'resources-settled'))
  records.forEach(checkRecord)
  assert.equal(handle.snapshot().outcome, 'succeeded')
  assert.equal(handle.snapshot().resources, 'released')
  assert.equal(planner.snapshot().leasedAttempts, 0)
  assert.equal(planner.snapshot().sentActive, 0)
  assert.equal(
    observationOf(planner).diagnostics.snapshot().OBSERVER_FAILED,
    mode.startsWith('fulfilled') ? 0 : matched
  )
  for (const { promise, descriptors } of returned) {
    assert.deepEqual(
      Object.getOwnPropertyDescriptors(promise),
      descriptors,
      'CALLER_PROMISE_UNCHANGED'
    )
  }
  console.log('PASS returned observer Promise isolated', scope, boundary, mode)
}

for (const scope of ['planner', 'handle']) {
  for (const boundary of ['dispatch-started', 'headers-received', 'commit', 'resources-settled']) {
    for (const mode of [
      'rejected',
      'fulfilled',
      'fulfilled-poisoned-then',
      'fulfilled-poisoned-catch',
      'fulfilled-hostile-value',
      'poisoned-then',
      'poisoned-catch',
      'throwing-getter',
      'rejecting-thenable',
      'subclass-poisoned-then',
      'subclass-poisoned-catch',
      ...(boundary === 'headers-received'
        ? ['async-rejected', 'pending-rejected', 'cross-realm', 'own-methods']
        : [])
    ]) {
      test(`Strict observer return isolation: ${scope} / ${boundary} / ${mode}`, () => {
        const source = `
          import assert from 'node:assert/strict';
          import { setImmediate } from 'node:timers/promises';
          import { runInNewContext } from 'node:vm';
          import { FetchPlanner } from ${JSON.stringify(new URL('../../src/index.js', import.meta.url).href)};
          import { OperationObservation } from ${JSON.stringify(new URL('../../src/operation-observation.js', import.meta.url).href)};
          const replay = { serverSafe: false, consumeSafe: false };
          const transport = () => Promise.resolve(new Response('ok'));
          ${spec.toString()}
          ${checkRecord.toString()}
          const snapshotKeys = ${JSON.stringify(snapshotKeys)};
          ${observationOf.toString()}
          await (${returnedPromiseChild.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(boundary)}, ${JSON.stringify(scope)});
        `
        const child = spawnSync(
          process.execPath,
          ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
          { encoding: 'utf8', timeout: 10_000 }
        )
        assert.ifError(child.error)
        assert.equal(child.signal, null)
        assert.equal(child.status, 0, child.stdout + child.stderr)
        assert.ok(child.stdout.includes('PASS returned observer Promise isolated'))
      })
    }
  }
}

/** Targeted public C5 boundary controls; expected-fatal cases are not isolation successes. */
async function protocolBoundaryChild(mode: string, recipe: string, scope: string) {
  const planner = new FetchPlanner(transport)
  const handle = planner.submit(spec())
  const records: Event[] = []
  const siblings: Event[] = []
  const pending = deferred<unknown>()
  const original =
    mode === 'pending-constructor' ? pending.promise : Promise.reject(new Error('ORIGINAL'))
  let handled = 0
  // Capture a plain safe chain before modifying the protocol; never repair it with resolve/await.
  const safe =
    recipe === 'unhandled'
      ? undefined
      : original.then(
          () => undefined,
          () => {
            handled++
          }
        )
  let capabilityCreated = 0
  const constructor =
    mode === 'species'
      ? Object.freeze({
          get [Symbol.species]() {
            throw new Error('ATTACHMENT')
          }
        })
      : mode === 'species-constructor'
        ? Object.freeze({
            [Symbol.species]: function () {
              throw new Error('ATTACHMENT')
            }
          })
        : mode === 'capability'
          ? Object.freeze({
              [Symbol.species]: function (
                executor: (resolve: () => void, reject: (cause: unknown) => void) => void
              ) {
                capabilityCreated++
                return new Promise<unknown>((_resolve, reject) => {
                  executor(() => {
                    reject(new Error('CAPABILITY_REJECTION'))
                  }, reject)
                })
              }
            })
          : undefined
  if (constructor) void Object.defineProperty(original, 'constructor', { value: constructor })
  else
    void Object.defineProperty(original, 'constructor', {
      get() {
        throw new Error('ATTACHMENT')
      }
    })
  Object.freeze(original)
  const descriptors = Object.getOwnPropertyDescriptors(original)
  const constructorDescriptors = constructor && Object.getOwnPropertyDescriptors(constructor)
  const target = scope === 'planner' ? planner : handle
  let invocations = 0
  target.observe((event): unknown => {
    records.push(event)
    if (event.type !== 'headers-received') return undefined
    invocations++
    return recipe === 'safe-plain' ? safe : recipe === 'undefined' ? undefined : original
  })
  target.observe(event => {
    siblings.push(event)
  })
  try {
    assert.equal((await handle.result).value, 'ok')
    assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
    assert.equal(invocations, 1)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(handle.snapshot().outcome, 'succeeded')
    assert.equal(handle.snapshot().resources, 'released')
    assert.deepEqual(siblings, records)
    for (let index = 0; index < records.length; index++) {
      const event = records[index]
      const sibling = siblings[index]
      assert.ok(event && sibling)
      assert.notStrictEqual(event, sibling, 'PROTOCOL_SIBLING_DETACHED')
      checkRecord(event)
      checkRecord(sibling)
    }
    assert.equal(new Set(records.map(event => event.sequence)).size, records.length)
    assert.equal(records.at(-1)?.type, 'resources-settled')
    assert.deepEqual(Object.getOwnPropertyDescriptors(original), descriptors)
    if (constructor)
      assert.deepEqual(Object.getOwnPropertyDescriptors(constructor), constructorDescriptors)
    assert.equal(capabilityCreated, mode === 'capability' && recipe === 'prehandled' ? 1 : 0)
    assert.equal(
      observationOf(planner).diagnostics.snapshot().OBSERVER_FAILED,
      recipe === 'safe-plain' || recipe === 'undefined' ? 0 : 1,
      'FIXED_ATTACHMENT_DIAGNOSTIC'
    )
    if (mode === 'capability') {
      assert.equal(handled, 1, 'ORIGINAL_PREHANDLER_IS_NOT_DERIVED_CHAIN_PROTECTION')
      console.log('SUCCESSFUL_ATTACHMENT')
    } else if (recipe !== 'safe-plain' && recipe !== 'undefined') console.log('CAUGHT_ATTACHMENT')
    console.log('DESCRIPTORS_UNCHANGED')
    if (mode === 'pending-constructor') {
      assert.equal(handled, 0)
      console.log('PENDING_BEFORE_REAL_REJECT')
      pending.reject(new Error('ORIGINAL'))
      console.log('REAL_REJECT')
    }
    // Fatal cases terminate here from strict unhandled rejection, never from an assertion.
    await setImmediate()
    assert.equal(handled, 1, 'PREHANDLER_ONCE')
    console.log('NATURAL_EXIT', handled)
  } finally {
    pending.resolve(undefined)
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
}

function strictProtocolChild(mode: string, recipe: string, scope: string) {
  const source = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { FetchPlanner } from ${JSON.stringify(new URL('../../src/index.js', import.meta.url).href)};
    import { OperationObservation } from ${JSON.stringify(new URL('../../src/operation-observation.js', import.meta.url).href)};
    const replay = { serverSafe: false, consumeSafe: false };
    const transport = () => Promise.resolve(new Response('ok'));
    const snapshotKeys = ${JSON.stringify(snapshotKeys)};
    ${spec.toString()}
    ${checkRecord.toString()}
    ${observationOf.toString()}
    ${deferred.toString()}
    await (${protocolBoundaryChild.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(recipe)}, ${JSON.stringify(scope)});
  `
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 10_000 }
  )
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  return child
}

for (const mode of ['constructor', 'species', 'species-constructor', 'pending-constructor']) {
  for (const scope of ['planner', 'handle']) {
    test(`Supported prehandled frozen protocol fault: ${scope} / ${mode}`, () => {
      const child = strictProtocolChild(mode, 'prehandled', scope)
      assert.equal(child.status, 0, child.stdout + child.stderr)
      assert.equal(child.stderr, '')
      assert.match(child.stdout, /CAUGHT_ATTACHMENT\nDESCRIPTORS_UNCHANGED/)
      assert.match(child.stdout, /NATURAL_EXIT 1/)
      if (mode === 'pending-constructor')
        assert.match(child.stdout, /PENDING_BEFORE_REAL_REJECT\nREAL_REJECT/)
    })
  }
  test(`Outside C5 boundary without prehandler: ${mode}`, () => {
    const child = strictProtocolChild(mode, 'unhandled', 'handle')
    assert.equal(child.status, 1, child.stdout + child.stderr)
    assert.match(child.stdout, /CAUGHT_ATTACHMENT\nDESCRIPTORS_UNCHANGED/)
    if (mode === 'pending-constructor')
      assert.match(child.stdout, /PENDING_BEFORE_REAL_REJECT\nREAL_REJECT/)
    assert.match(child.stderr, /Error: ORIGINAL/)
    assert.doesNotMatch(
      child.stderr,
      /ERR_ASSERTION|ERR_MODULE_NOT_FOUND|SyntaxError|CAPABILITY_REJECTION/
    )
    assert.doesNotMatch(child.stdout, /NATURAL_EXIT/)
  })
}

test('Outside C5 boundary: successful attachment may reject a custom derived capability', () => {
  const child = strictProtocolChild('capability', 'prehandled', 'planner')
  assert.equal(child.status, 1, child.stdout + child.stderr)
  assert.match(child.stdout, /SUCCESSFUL_ATTACHMENT\nDESCRIPTORS_UNCHANGED/)
  assert.match(child.stderr, /Error: CAPABILITY_REJECTION/)
  assert.doesNotMatch(
    child.stderr,
    /Error: ORIGINAL|ERR_ASSERTION|ERR_MODULE_NOT_FOUND|SyntaxError/
  )
  assert.doesNotMatch(child.stdout, /NATURAL_EXIT/)
})

for (const recipe of ['safe-plain', 'undefined']) {
  test(`Supported caller recipe before broken capability protocol: ${recipe}`, () => {
    const child = strictProtocolChild('capability', recipe, 'planner')
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.equal(child.stderr, '')
    assert.match(child.stdout, /DESCRIPTORS_UNCHANGED/)
    assert.match(child.stdout, /NATURAL_EXIT 1/)
  })
}
