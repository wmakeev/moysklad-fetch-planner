import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { deferred } from './helpers.js'

const replay = { serverSafe: false, consumeSafe: false }

test('A pending consume and disposer retain L1 until the next real prepare', async () => {
  const consume = deferred<undefined>()
  const dispose = deferred<undefined>()
  const consuming = deferred<undefined>()
  const disposing = deferred<undefined>()
  let preparations = 0
  let dispatches = 0
  let delivered = false
  const transport: typeof globalThis.fetch = () => {
    dispatches++
    return Promise.resolve(new Response('ok'))
  }
  const planner = new FetchPlanner(transport, { maxParallelLimit: 1, maxQueuedOperations: 2 })
  const first = planner.submit({
    method: 'GET',
    replay,
    prepare: ctx => {
      preparations++
      ctx.onDispose(async () => {
        disposing.resolve(undefined)
        await dispose.promise
      })
      return { url: '', init: {} }
    },
    consume: async response => {
      consuming.resolve(undefined)
      await consume.promise
      return await response.text()
    }
  })
  void first.result.then(() => {
    delivered = true
  })
  const second = planner.submit({
    method: 'GET',
    replay,
    prepare: () => {
      preparations++
      return { url: '', init: {} }
    },
    consume: response => response.text()
  })
  try {
    await consuming.promise
    await setImmediate()
    assert.equal(delivered, false, 'HEADERS_MUST_NOT_RESOLVE_RESULT')
    assert.equal(preparations, 1, 'NEXT_PREPARE_MUST_WAIT_FOR_OWNER')
    assert.equal(dispatches, 1)
    assert.equal(planner.snapshot().leasedAttempts, 1)
    assert.equal(planner.snapshot().sentActive, 1)
    consume.resolve(undefined)
    await disposing.promise
    await setImmediate()
    assert.equal(preparations, 1, 'NEXT_PREPARE_MUST_WAIT_FOR_DISPOSER')
    assert.equal(planner.snapshot().leasedAttempts, 1)
    assert.equal(planner.snapshot().sentActive, 1)
    dispose.resolve(undefined)
    assert.equal((await first.result).value, 'ok')
    assert.equal((await second.result).value, 'ok')
    await Promise.all([first.resourcesDone, second.resourcesDone])
    assert.equal(preparations, 2)
    assert.equal(dispatches, 2)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().queued, 0)
  } finally {
    consume.resolve(undefined)
    dispose.resolve(undefined)
    await Promise.allSettled([
      first.result,
      second.result,
      first.resourcesDone,
      second.resourcesDone
    ])
  }
})

test('Admission bounds the FIFO synchronously and excess submissions never prepare', async () => {
  const gate = deferred<undefined>()
  const entered = deferred<undefined>()
  let calls = 0
  const transport: typeof globalThis.fetch = () => Promise.resolve(new Response())
  const planner = new FetchPlanner(transport, { maxQueuedOperations: 2, maxParallelLimit: 1 })
  const spec = {
    method: 'GET' as const,
    replay,
    prepare: async () => {
      calls++
      entered.resolve(undefined)
      await gate.promise
      return { url: '', init: {} }
    },
    consume: () => 'done'
  }
  const first = planner.submit(spec)
  const second = planner.submit(spec)
  const excess = Array.from({ length: 100 }, () => planner.submit(spec))
  try {
    assert.equal(planner.snapshot().queued, 2)
    assert.equal(planner.snapshot().sequence, 2)
    for (const handle of excess) {
      assert.equal(handle.id, 0)
      await assert.rejects(handle.result, { code: 'QUEUE_FULL', dispatchEntered: false })
    }
    await entered.promise
    assert.equal(calls, 1)
    assert.equal(planner.snapshot().queued, 1)
    gate.resolve(undefined)
    await Promise.all([first.result, second.result, first.resourcesDone, second.resourcesDone])
    assert.equal(calls, 2)
  } finally {
    gate.resolve(undefined)
    await Promise.allSettled([
      first.result,
      second.result,
      first.resourcesDone,
      second.resourcesDone
    ])
  }
})

for (const stage of ['prepare', 'transport', 'consume'] as const) {
  test(`Synchronous ${stage} failure preserves phase cause status and cleanup`, async () => {
    const cause = new Error(stage)
    let disposed = 0
    const transport: typeof globalThis.fetch = () => {
      if (stage === 'transport') throw cause
      return Promise.resolve(new Response('body', { status: 412 }))
    }
    const planner = new FetchPlanner(transport)
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        ctx.onDispose(() => {
          disposed++
        })
        if (stage === 'prepare') throw cause
        return { url: '', init: {} }
      },
      consume: () => {
        throw cause
      }
    })
    await assert.rejects(handle.result, (error: unknown) => {
      assert.ok(error instanceof OperationError)
      assert.equal(
        error.code,
        stage === 'prepare'
          ? 'PREPARE_FAILED'
          : stage === 'transport'
            ? 'TRANSPORT_FAILED'
            : 'CONSUME_FAILED'
      )
      assert.equal(
        error.phase,
        stage === 'prepare' ? 'preparing' : stage === 'transport' ? 'sending' : 'consuming'
      )
      assert.equal(error.cause, cause)
      assert.equal(error.status, stage === 'consume' ? 412 : undefined)
      assert.equal(error.dispatchEntered, stage !== 'prepare')
      assert.equal(
        error.serverOutcome,
        stage === 'prepare' ? 'not-dispatched' : stage === 'transport' ? 'unknown' : 'http-response'
      )
      return true
    })
    assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
    assert.equal(disposed, 1)
    assert.equal(planner.snapshot().leasedAttempts, 0)
  })
}

test('429 is intercepted and cancelled; non429 reaches consume unread', async () => {
  let cancelled = 0
  let consumed = 0
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled++
      }
    }),
    { status: 429 }
  )
  const transport: typeof globalThis.fetch = () => Promise.resolve(response)
  const handle = new FetchPlanner(transport).submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: () => {
      consumed++
      return 'bad'
    }
  })
  await assert.rejects(handle.result, { code: 'HTTP_FAILED', status: 429, phase: 'classifying' })
  await handle.resourcesDone
  assert.equal(consumed, 0)
  assert.equal(cancelled, 1)
  const original = new Response('details', { status: 503 })
  const normal: typeof globalThis.fetch = () => Promise.resolve(original)
  const next = new FetchPlanner(normal).submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: async borrowed => {
      assert.equal(borrowed, original)
      assert.equal(borrowed.bodyUsed, false)
      return await borrowed.text()
    }
  })
  assert.equal((await next.result).value, 'details')
  assert.equal((await next.result).status, 503)
  await next.resourcesDone
})

test('Abort pending prepare keeps its lease; stop rejects queued and future work', async () => {
  const gate = deferred<undefined>()
  const entered = deferred<undefined>()
  let calls = 0
  const transport: typeof globalThis.fetch = () => {
    calls++
    return Promise.resolve(new Response())
  }
  const planner = new FetchPlanner(transport, { maxParallelLimit: 1 })
  const spec = {
    method: 'GET' as const,
    replay,
    prepare: async () => {
      entered.resolve(undefined)
      await gate.promise
      return { url: '', init: {} }
    },
    consume: () => 1
  }
  const first = planner.submit(spec)
  const second = planner.submit(spec)
  try {
    await entered.promise
    first.abort('reason')
    await assert.rejects(first.result, { code: 'ABORTED' })
    assert.equal(planner.snapshot().leasedAttempts, 1)
    assert.equal(planner.snapshot().queued, 1)
    planner.stop('stop')
    await assert.rejects(second.result, { code: 'STOPPED' })
    await assert.rejects(planner.submit(spec).result, { code: 'STOPPED', operationId: 0 })
    assert.equal(planner.snapshot().queued, 0)
    gate.resolve(undefined)
    await Promise.all([first.resourcesDone, second.resourcesDone])
    assert.equal(calls, 0)
    assert.equal(planner.snapshot().leasedAttempts, 0)
  } finally {
    gate.resolve(undefined)
    await Promise.allSettled([
      first.result,
      second.result,
      first.resourcesDone,
      second.resourcesDone
    ])
  }
})

for (const settlement of ['resolve', 'reject', 'throw'] as const) {
  test(`Entered POST abort preserves dispatch facts through transport ${settlement}`, async () => {
    const reason = new Error('abort inside transport')
    const lateFailure = new Error('late transport failure')
    let calls = 0
    let consumed = 0
    let disposed = 0
    const events: string[] = []
    const entryFacts: {
      phase: string
      dispatchEntered: boolean
      dispatchCalls: number
      observed: boolean
    }[] = []
    const transport: typeof globalThis.fetch = () => {
      calls++
      entryFacts.push({ ...handle.snapshot(), observed: events.includes('dispatch-started') })
      handle.abort(reason)
      if (settlement === 'throw') throw lateFailure
      return settlement === 'resolve'
        ? Promise.resolve(new Response('late', { status: 202 }))
        : Promise.reject(lateFailure)
    }
    const planner = new FetchPlanner(transport)
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        ctx.onDispose(() => {
          disposed++
        })
        return { url: '', init: { body: 'payload' } }
      },
      consume: () => {
        consumed++
        return 'unexpected'
      }
    })
    handle.observe(event => {
      events.push(event.type)
    })
    let original: OperationError | undefined
    await assert.rejects(handle.result, (error: unknown) => {
      assert.ok(error instanceof OperationError)
      original = error
      assert.equal(error.dispatchEntered, true, 'ENTERED_POST_MUST_NOT_REPORT_NOT_DISPATCHED')
      assert.equal(error.phase, 'sending')
      assert.equal(error.code, 'ABORTED')
      assert.equal(error.cause, reason)
      assert.equal(error.serverOutcome, 'unknown')
      assert.equal(error.status, undefined)
      return true
    })
    await handle.resourcesDone
    await assert.rejects(handle.result, error => error === original)
    assert.equal(calls, 1)
    const entered = entryFacts[0]
    assert.ok(entered)
    assert.equal(entered.phase, 'sending')
    assert.equal(entered.dispatchEntered, true)
    assert.equal(entered.dispatchCalls, 1)
    assert.equal(entered.observed, false, 'NO_OBSERVER_INSIDE_TRANSPORT_ENTRY')
    assert.equal(consumed, 0)
    assert.equal(disposed, 1)
    assert.equal(handle.snapshot().dispatchCalls, 1)
    assert.equal(handle.snapshot().dispatchEntered, true)
    assert.equal(handle.snapshot().status, settlement === 'resolve' ? 202 : undefined)
    assert.equal(handle.snapshot().failureCode, 'ABORTED')
    assert.ok(events.indexOf('dispatch-started') < events.indexOf('operation-settled'))
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  })
}

test('Dispatch observer stop runs after transport entry and prevents the next dispatch', async () => {
  let calls = 0
  let preparations = 0
  const transport: typeof globalThis.fetch = () => {
    calls++
    return Promise.resolve(new Response('ok'))
  }
  const planner = new FetchPlanner(transport, { maxParallelLimit: 1 })
  const spec = {
    method: 'POST' as const,
    replay,
    prepare: () => {
      preparations++
      return { url: '', init: { body: 'payload' } }
    },
    consume: (response: Response) => response.text()
  }
  const first = planner.submit(spec)
  const second = planner.submit(spec)
  let observed = 0
  first.observe(event => {
    if (event.type !== 'dispatch-started') return
    observed++
    assert.equal(calls, 1, 'DISPATCH_EVENT_MUST_FOLLOW_TRANSPORT_ENTRY')
    planner.stop('observer stop')
  })
  assert.equal((await first.result).value, 'ok')
  await assert.rejects(second.result, {
    code: 'STOPPED',
    dispatchEntered: false,
    serverOutcome: 'not-dispatched'
  })
  await Promise.all([first.resourcesDone, second.resourcesDone])
  assert.equal(observed, 1)
  assert.equal(calls, 1)
  assert.equal(preparations, 1)
})

test('Queued abort remains not dispatched and never prepares', async () => {
  let calls = 0
  const transport: typeof globalThis.fetch = () => {
    calls++
    return Promise.resolve(new Response())
  }
  const planner = new FetchPlanner(transport)
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => {
      throw new Error('CANCELLED_QUEUE_MUST_NOT_PREPARE')
    },
    consume: () => 'unexpected'
  })
  handle.abort('queued abort')
  await assert.rejects(handle.result, {
    code: 'ABORTED',
    phase: 'queued',
    dispatchEntered: false,
    serverOutcome: 'not-dispatched'
  })
  await handle.resourcesDone
  assert.equal(calls, 0)
  assert.equal(handle.snapshot().dispatchCalls, 0)
  assert.equal(planner.snapshot().queued, 0)
})
