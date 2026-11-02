import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FetchPlanner, OperationError, type Init, type Spec } from '../../src/index.js'
import { createRuntime, deferred } from './helpers.js'
import {
  finiteRun,
  bindStop,
  CollectionFailure,
  consumeCollection,
  normalizeCollection
} from './consumer-recipes.js'

function job(value: string): Spec<Init<typeof fetch>, Response, string> {
  return {
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({ url: 'https://example.invalid/', init: { body: value } }),
    consume: response => response.text()
  }
}

test('Finite windows publish committed values before cleanup and retain their bound', async t => {
  const clock = createRuntime(t)
  const cleanup = deferred<undefined>()
  let calls = 0
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      calls++
      return Promise.resolve(new Response('committed'))
    },
    { maxParallelLimit: 1, cleanupGraceMs: 10 }
  )
  const values: string[] = []
  const failures: unknown[] = []
  const run = finiteRun<string>(
    planner,
    value => {
      values.push(value)
    },
    error => {
      failures.push(error)
    },
    () => undefined
  )
  const first = job('first')
  first.prepare = ctx => {
    ctx.onDispose(() => cleanup.promise)
    return { url: 'https://example.invalid/', init: {} }
  }
  const work = run.windows([first, job('second'), job('third')], 1)
  try {
    await clock.advance(10)
    assert.deepEqual(values, ['committed'])
    assert.equal(calls, 1)
    await clock.advance(50)
    assert.equal(calls, 1, 'Pending resources must block the next window')
    const final = run.finalize(5)
    await clock.advance(5)
    assert.equal((await final)[0]?.resources, 'pending')
    assert.deepEqual(values, ['committed'], 'Finalizer retains committed partial success')
    run.softStop()
    cleanup.resolve(undefined)
    assert.equal(await work, 1)
    assert.deepEqual(failures, [])
    assert.deepEqual(await run.finalize(10), [])
  } finally {
    cleanup.resolve(undefined)
    run.forceAbort()
    await work
  }
})

test('Queue rejection handles with id zero are all observed without resubmission', async t => {
  const clock = createRuntime(t)
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response('ok')), {
    maxQueuedOperations: 1
  })
  const failures: unknown[] = []
  const run = finiteRun<string>(
    planner,
    () => undefined,
    error => {
      failures.push(error)
    },
    () => undefined
  )
  const a = planner.submit(job('a'))
  const b = planner.submit(job('b'))
  const c = planner.submit(job('c'))
  assert.equal(b.id, 0)
  assert.equal(c.id, 0)
  const work = Promise.all([run.track(a), run.track(b), run.track(c)])
  await clock.flush()
  await work
  assert.equal(
    failures.filter(error => error instanceof OperationError && error.code === 'QUEUE_FULL').length,
    2
  )
  assert.equal(await run.windows([job('remaining')], 1), 0)
  assert.deepEqual(await run.finalize(10), [])
})

test('Soft stop preserves sent POST budgets and bounded forced finalization preserves late accounting', async t => {
  const clock = createRuntime(t)
  const late = deferred<undefined>()
  const entered = deferred<undefined>()
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response('ok')), {
    attemptTimeoutMs: 100,
    deadlineMs: 200,
    cleanupGraceMs: 10
  })
  const values: string[] = []
  const failures: unknown[] = []
  const run = finiteRun<string>(
    planner,
    value => {
      values.push(value)
    },
    error => {
      failures.push(error)
    },
    () => undefined
  )
  const spec = job('sent')
  spec.consume = async response => {
    await response.text()
    entered.resolve(undefined)
    await late.promise
    return 'late'
  }
  const handle = planner.submit(spec)
  const work = run.track(handle)
  try {
    await entered.promise
    run.softStop()
    await clock.advance(99)
    assert.equal(handle.snapshot().outcome, 'pending')
    await clock.advance(1)
    assert.equal(handle.snapshot().failureCode, 'ATTEMPT_TIMEOUT')
    run.forceAbort()
    const final = run.finalize(5)
    await clock.advance(5)
    const pending = await final
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.resources, 'pending')
    assert.equal(values.length, 0)
    assert.ok(failures[0] instanceof OperationError)
    late.resolve(undefined)
    await work
    assert.deepEqual(await run.finalize(5), [])
    assert.equal(values.length, 0, 'Late consume must not publish after timeout')
  } finally {
    late.resolve(undefined)
    run.forceAbort()
    await work
  }
})

for (const status of [404, 412]) {
  test(`Expected ${status} success still opens the local guard and preserves remaining work`, async t => {
    const clock = createRuntime(t)
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        calls++
        return Promise.resolve(new Response('expected', { status }))
      },
      { errorPerMinuteLimit: 2, maxParallelLimit: 1 }
    )
    const partial: string[] = []
    const failures: unknown[] = []
    const run = finiteRun<string>(
      planner,
      value => {
        partial.push(value)
      },
      error => {
        failures.push(error)
      },
      () => undefined
    )
    const work = run.windows(
      Array.from({ length: 5 }, () => job('expected')),
      1
    )
    for (let i = 0; i < 5; i++) await clock.advance(3000)
    assert.equal(await work, 3)
    assert.equal(calls, 2)
    assert.deepEqual(partial, ['expected', 'expected'])
    assert.ok(failures[0] instanceof OperationError)
    assert.equal(failures[0].code, 'GUARD_OPEN')
    assert.equal(planner.snapshot().guardOpen, true)
    assert.equal(await run.windows([job('remaining')], 1), 0)
  })
}

test('Collection consume retains indices and partial successes and only normalizes known causes', async t => {
  createRuntime(t)
  const planner = new FetchPlanner<typeof fetch>(() =>
    Promise.resolve(new Response('[{"value":"a"},{"error":"bad"},{"value":"c"}]'))
  )
  const handle = planner.submit({ ...job('mixed'), consume: consumeCollection })
  await assert.rejects(handle.result, (error: unknown) => {
    const known = normalizeCollection(error)
    assert.ok(error instanceof OperationError)
    assert.equal(known, error.cause)
    assert.ok(known instanceof CollectionFailure)
    assert.deepEqual(known.partial, [
      { index: 0, value: 'a' },
      { index: 2, value: 'c' }
    ])
    assert.deepEqual(known.errors, [{ index: 1, message: 'bad' }])
    return true
  })
  await handle.resourcesDone
  assert.deepEqual(await consumeCollection(new Response('[{"value":"ok"}]')), [
    { index: 0, value: 'ok' }
  ])
  const known = new CollectionFailure([], [])
  for (const code of [
    'STOPPED',
    'GUARD_OPEN',
    'DEADLINE',
    'QUEUE_FULL',
    'TRANSPORT_FAILED'
  ] as const) {
    const error = new OperationError(
      code,
      { phase: 'terminal', operationId: 0, attemptNumber: 0, dispatchEntered: true },
      known
    )
    assert.equal(normalizeCollection(error), error)
  }
  const unknown = new OperationError(
    'CONSUME_FAILED',
    { phase: 'consuming', operationId: 1, attemptNumber: 1, dispatchEntered: true },
    new SyntaxError('unknown')
  )
  assert.equal(normalizeCollection(unknown), unknown)
  await assert.rejects(consumeCollection(new Response('invalid json')), SyntaxError)
  await assert.rejects(consumeCollection(new Response('<html>error</html>')), SyntaxError)
  const http = new Response('complete error body', { status: 503 })
  await assert.rejects(consumeCollection(http), /HTTP 503/)
  assert.equal(http.bodyUsed, true)
})

test('Forced abort of sent work keeps unknown outcome and observes late resources', async t => {
  const clock = createRuntime(t)
  const wire = deferred<Response>()
  const planner = new FetchPlanner<typeof fetch>(() => wire.promise)
  const values: string[] = []
  const failures: unknown[] = []
  const run = finiteRun<string>(
    planner,
    value => {
      values.push(value)
    },
    error => {
      failures.push(error)
    },
    () => undefined
  )
  const soft = new AbortController()
  const force = new AbortController()
  const detach = bindStop(run, soft.signal, force.signal)
  const handle = planner.submit(job('sent'))
  const work = run.track(handle)
  try {
    await clock.flush()
    assert.equal(handle.snapshot().dispatchEntered, true)
    force.abort()
    const final = run.finalize(5)
    await clock.advance(5)
    assert.equal((await final)[0]?.resources, 'pending')
    assert.ok(failures[0] instanceof OperationError)
    assert.equal(failures[0].code, 'ABORTED')
    assert.equal(failures[0].serverOutcome, 'unknown')
    wire.resolve(new Response('late'))
    await work
    assert.deepEqual(values, [])
    assert.deepEqual(await run.finalize(5), [])
  } finally {
    detach()
    wire.resolve(new Response('late'))
    run.forceAbort()
    await work
  }
})

test('Signal adapter stops new work and detaches listeners while cleanup failure preserves commit', async t => {
  createRuntime(t)
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response('committed')))
  const values: string[] = []
  const resources: string[] = []
  const run = finiteRun<string>(
    planner,
    value => {
      values.push(value)
    },
    () => assert.fail('Unexpected task failure'),
    state => {
      resources.push(state)
    }
  )
  const spec = job('one')
  spec.prepare = ctx => {
    ctx.onDispose(() => {
      throw new Error('cleanup')
    })
    return { url: 'https://example.invalid/', init: {} }
  }
  await run.windows([spec], 1)
  assert.deepEqual(values, ['committed'])
  assert.deepEqual(resources, ['failed'])
  assert.deepEqual(await run.finalize(5), [])
  const soft = new AbortController()
  const force = new AbortController()
  let stops = 0
  let aborts = 0
  const detach = bindStop(
    {
      softStop() {
        stops++
        run.softStop()
      },
      forceAbort() {
        aborts++
        run.forceAbort()
      }
    },
    soft.signal,
    force.signal
  )
  soft.abort()
  assert.equal(await run.windows([job('remaining')], 1), 0)
  detach()
  force.abort()
  assert.equal(stops, 1)
  assert.equal(aborts, 0, 'Detached listener must not run')
  const detachAlreadyAborted = bindStop(run, soft.signal, force.signal)
  detachAlreadyAborted()
})
