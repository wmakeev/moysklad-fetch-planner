import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { FetchPlanner as DeepFetchPlanner } from '../../src/planner.js'
import { fetch as UndiciFetch, Response as UndiciResponse } from 'undici'
import type { ConsumeContext, PrepareContext } from '../../src/operation-types.js'
import { deferred } from './helpers.js'

const replay = { serverSafe: true, consumeSafe: true }

for (const owner of ['prepare', 'consume'] as const) {
  for (const lateFailure of [false, true]) {
    test(`Ownership abort retains pending ${owner} through late ${lateFailure ? 'throw' : 'return'} and disposal`, async () => {
      const ownerGate = deferred<undefined>()
      const disposeGate = deferred<undefined>()
      const entered = deferred<undefined>()
      const disposing = deferred<undefined>()
      const events: string[] = []
      const reason = new Error('individual abort')
      const lateCause = new Error('late callback failure')
      let nextPrepares = 0
      let dispatches = 0
      let resourcesSettled = false
      let rejected = 0
      let delivered = 0
      let registration: (() => void) | undefined
      const planner = new FetchPlanner<typeof globalThis.fetch>(
        () => {
          dispatches++
          return Promise.resolve(new Response('unread'))
        },
        { maxParallelLimit: 1 }
      )
      const hold = async (ctx: PrepareContext | ConsumeContext) => {
        registration = () => {
          ctx.onDispose(() => undefined)
        }
        ctx.onDispose(async () => {
          events.push('dispose-start')
          disposing.resolve(undefined)
          await disposeGate.promise
          events.push('dispose-return')
        })
        if ('onDiscard' in ctx)
          ctx.onDiscard(() => {
            events.push('discard')
          })
        entered.resolve(undefined)
        await ownerGate.promise
        assert.equal(ctx.signal.aborted, true)
        ctx.onDispose(() => {
          events.push('late-dispose')
        })
        events.push('owner-return')
        if (lateFailure) throw lateCause
      }
      const first = planner.submit({
        method: 'POST',
        replay,
        prepare: async ctx => {
          if (owner === 'prepare') await hold(ctx)
          return { url: '', init: {} }
        },
        consume: async (_response, ctx) => {
          await hold(ctx)
          return { temporary: 'late value' }
        }
      })
      void first.result.then(
        () => {
          delivered++
        },
        () => {
          rejected++
        }
      )
      void first.resourcesDone.then(() => {
        resourcesSettled = true
      })
      const second = planner.submit({
        method: 'GET',
        replay,
        prepare: () => {
          nextPrepares++
          return { url: '', init: {} }
        },
        consume: response => response.text()
      })
      try {
        await entered.promise
        first.abort(reason)
        first.abort(new Error('second abort'))
        await assert.rejects(
          first.result,
          error =>
            error instanceof OperationError && error.code === 'ABORTED' && error.cause === reason
        )
        await setImmediate()
        assert.equal(nextPrepares, 0, 'NEXT_PREPARE_MUST_WAIT_FOR_LOGICALLY_FAILED_OWNER')
        assert.equal(planner.snapshot().queued, 1)
        assert.equal(planner.snapshot().leasedAttempts, 1)
        assert.equal(planner.snapshot().sentActive, owner === 'consume' ? 1 : 0)
        assert.equal(resourcesSettled, false)
        assert.deepEqual(events, [], 'DISPOSAL_MUST_NOT_START_BEFORE_OWNER_RETURN')
        assert.throws(() => registration?.(), /INVALID_RESOURCE_REGISTRATION/)
        ownerGate.resolve(undefined)
        await disposing.promise
        assert.deepEqual(
          events,
          owner === 'consume'
            ? ['owner-return', 'discard', 'late-dispose', 'dispose-start']
            : ['owner-return', 'late-dispose', 'dispose-start']
        )
        await setImmediate()
        assert.equal(nextPrepares, 0, 'NEXT_PREPARE_MUST_WAIT_FOR_DISPOSER')
        assert.equal(resourcesSettled, false)
        assert.equal(planner.snapshot().leasedAttempts, 1)
        assert.equal(planner.snapshot().sentActive, owner === 'consume' ? 1 : 0)
        disposeGate.resolve(undefined)
        assert.deepEqual(await first.resourcesDone, { resources: 'released' })
        await second.result
        await second.resourcesDone
        assert.equal(dispatches, owner === 'consume' ? 2 : 1, 'LATE_DESCRIPTOR_MUST_NEVER_DISPATCH')
        assert.equal(nextPrepares, 1)
        assert.equal(rejected, 1)
        assert.equal(delivered, 0)
        assert.equal(events.filter(event => event === 'dispose-start').length, 1)
        assert.equal(
          events.filter(event => event === 'discard').length,
          owner === 'consume' ? 1 : 0
        )
        assert.throws(() => registration?.(), /INVALID_RESOURCE_REGISTRATION/)
        assert.equal(planner.snapshot().leasedAttempts, 0)
        assert.equal(planner.snapshot().sentActive, 0)
      } finally {
        ownerGate.resolve(undefined)
        disposeGate.resolve(undefined)
        await Promise.allSettled([
          first.result,
          second.result,
          first.resourcesDone,
          second.resourcesDone
        ])
      }
    })
  }
}

for (const owner of ['prepare', 'consume'] as const) {
  test(`Ownership partial ${owner} failure drains both stacks LIFO once and preserves primary cause`, async () => {
    const events: string[] = []
    const primary = new Error('primary callback failure')
    let prepares = 0
    let dispatches = 0
    const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
      dispatches++
      return Promise.resolve(new Response('body', { status: 200 }))
    })
    const acquire = (ctx: PrepareContext) => {
      ctx.onDispose(() => {
        events.push('dispose1')
        throw new Error('sync disposal')
      })
      ctx.onDispose(async () => {
        await Promise.resolve()
        events.push('dispose2')
        throw new Error('async disposal')
      })
    }
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        prepares++
        acquire(ctx)
        if (owner === 'prepare') throw primary
        return { url: '', init: {} }
      },
      consume: (_response, ctx) => {
        ctx.onDispose(() => {
          events.push('consume-dispose')
        })
        ctx.onDiscard(() => {
          events.push('discard1')
          throw new Error('sync discard')
        })
        ctx.onDiscard(async () => {
          await Promise.resolve()
          events.push('discard2')
          throw new Error('async discard')
        })
        throw primary
      }
    })
    await assert.rejects(
      handle.result,
      error =>
        error instanceof OperationError &&
        error.code === (owner === 'prepare' ? 'PREPARE_FAILED' : 'CONSUME_FAILED') &&
        error.cause === primary &&
        error.status === (owner === 'consume' ? 200 : undefined)
    )
    assert.deepEqual(await handle.resourcesDone, { resources: 'failed' })
    assert.deepEqual(
      events,
      owner === 'prepare'
        ? ['dispose2', 'dispose1']
        : ['discard2', 'discard1', 'consume-dispose', 'dispose2', 'dispose1']
    )
    handle.abort()
    await setImmediate()
    assert.equal(prepares, 1)
    assert.equal(dispatches, owner === 'consume' ? 1 : 0)
    assert.equal(handle.snapshot().resources, 'failed')
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  })
}

for (const rejectCleanup of [false, true]) {
  test(`Ownership producer stop precedes known work wait and ${rejectCleanup ? 'failed' : 'released'} disposal frees accounting once`, async () => {
    const knownWork = deferred<undefined>()
    const finalization = deferred<undefined>()
    const disposing = deferred<undefined>()
    const producerSettled = deferred<undefined>()
    const events: string[] = []
    let firstPrepares = 0
    let nextPrepares = 0
    let sends = 0
    let settled = false
    const planner = new FetchPlanner<typeof globalThis.fetch>(
      () => {
        sends++
        return Promise.resolve(new Response('early response', { status: sends === 1 ? 429 : 200 }))
      },
      { maxParallelLimit: 1 }
    )
    const first = planner.submit({
      method: 'POST',
      replay: { serverSafe: false, consumeSafe: false },
      prepare: ctx => {
        firstPrepares++
        ctx.onDispose(async () => {
          events.push('producer-stop')
          disposing.resolve(undefined)
          await knownWork.promise
          events.push('known-work-settled')
          producerSettled.resolve(undefined)
          await finalization.promise
          events.push('dispose-return')
          if (rejectCleanup) throw new Error('producer release unconfirmed')
        })
        return { url: '', init: { body: 'payload' } }
      },
      consume: () => {
        assert.fail('429 must not reach consume')
      }
    })
    void first.resourcesDone.then(() => {
      settled = true
    })
    const second = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        nextPrepares++
        return { url: '', init: {} }
      },
      consume: response => response.text()
    })
    try {
      await disposing.promise
      await assert.rejects(first.result, { code: 'HTTP_FAILED', status: 429 })
      assert.deepEqual(events, ['producer-stop'])
      await setImmediate()
      assert.equal(nextPrepares, 0)
      assert.equal(settled, false)
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 1)
      knownWork.resolve(undefined)
      await producerSettled.promise
      await setImmediate()
      assert.equal(nextPrepares, 0)
      assert.equal(settled, false)
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 1)
      finalization.resolve(undefined)
      assert.deepEqual(await first.resourcesDone, {
        resources: rejectCleanup ? 'failed' : 'released'
      })
      await second.result
      await second.resourcesDone
      assert.equal(firstPrepares, 1, 'CLEANUP_FAILURE_MUST_NOT_REPLAY')
      assert.equal(nextPrepares, 1)
      assert.equal(sends, 2)
      assert.equal(planner.snapshot().leasedAttempts, 0)
      assert.equal(planner.snapshot().sentActive, 0)
      assert.deepEqual(events, ['producer-stop', 'known-work-settled', 'dispose-return'])
    } finally {
      knownWork.resolve(undefined)
      finalization.resolve(undefined)
      await Promise.allSettled([
        first.result,
        second.result,
        first.resourcesDone,
        second.resourcesDone
      ])
    }
  })
}

for (const partialRead of [false, true]) {
  for (const rejectCancel of [false, true]) {
    test(`Ownership cancels ${partialRead ? 'partially read' : 'unread'} Response only after borrow and retains pending ${rejectCancel ? 'rejected' : 'successful'} cancel`, async () => {
      const consumeGate = deferred<undefined>()
      const cancelGate = deferred<undefined>()
      const consuming = deferred<undefined>()
      const cancelling = deferred<undefined>()
      const events: string[] = []
      let nextPrepares = 0
      let sends = 0
      let resourcesSettled = false
      const value = { completed: true }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([7]))
        },
        async cancel() {
          events.push('cancel-start')
          cancelling.resolve(undefined)
          await cancelGate.promise
          events.push('cancel-return')
          if (rejectCancel) throw new Error('cancel failed')
        }
      })
      const response = new Response(body)
      const planner = new FetchPlanner<typeof globalThis.fetch>(
        () => {
          sends++
          return Promise.resolve(sends === 1 ? response : new Response())
        },
        { maxParallelLimit: 1 }
      )
      const first = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: '', init: {} }),
        consume: async borrowed => {
          assert.equal(borrowed, response)
          assert.equal(borrowed.bodyUsed, false)
          assert.equal(body.locked, false)
          consuming.resolve(undefined)
          await consumeGate.promise
          if (partialRead) {
            const reader = body.getReader()
            try {
              assert.deepEqual((await reader.read()).value, new Uint8Array([7]))
            } finally {
              reader.releaseLock()
            }
          }
          events.push('consume-return')
          return value
        }
      })
      void first.resourcesDone.then(() => {
        resourcesSettled = true
      })
      const second = planner.submit({
        method: 'GET',
        replay,
        prepare: () => {
          nextPrepares++
          return { url: '', init: {} }
        },
        consume: () => 'second'
      })
      try {
        await consuming.promise
        await setImmediate()
        assert.deepEqual(events, [], 'BODY_MUST_REMAIN_WITH_CONSUME')
        consumeGate.resolve(undefined)
        // A bounded turn also makes a missing cancel an assertion failure instead of a hang.
        await setImmediate()
        assert.deepEqual(
          [...events],
          ['consume-return', 'cancel-start'],
          'REMAINDER_MUST_BE_CANCELLED_AFTER_BORROW'
        )
        await cancelling.promise
        assert.equal(nextPrepares, 0)
        assert.equal(resourcesSettled, false)
        assert.equal(planner.snapshot().leasedAttempts, 1)
        assert.equal(planner.snapshot().sentActive, 1)
        cancelGate.resolve(undefined)
        const completed = await first.result
        assert.equal(completed.value, value)
        assert.equal(completed.cleanup, rejectCancel ? 'failed' : 'released')
        assert.deepEqual(await first.resourcesDone, {
          resources: rejectCancel ? 'failed' : 'released'
        })
        await second.result
        await second.resourcesDone
        assert.deepEqual(events, ['consume-return', 'cancel-start', 'cancel-return'])
        assert.equal(sends, 2)
        assert.equal(nextPrepares, 1)
        assert.equal(planner.snapshot().sentActive, 0)
        assert.equal(planner.snapshot().leasedAttempts, 0)
      } finally {
        consumeGate.resolve(undefined)
        cancelGate.resolve(undefined)
        await Promise.allSettled([
          first.result,
          second.result,
          first.resourcesDone,
          second.resourcesDone
        ])
        if (!body.locked) await body.cancel().catch(() => undefined)
      }
    })
  }
}

test('Ownership does not declare an unread locked Response released', async () => {
  const body = new ReadableStream<Uint8Array>()
  const response = new Response(body)
  const reader = body.getReader()
  const planner = new FetchPlanner<typeof globalThis.fetch>(() => Promise.resolve(response))
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: () => 'value'
  })
  try {
    const completed = await handle.result
    assert.equal(completed.value, 'value')
    assert.equal(completed.cleanup, 'failed')
    assert.deepEqual(await handle.resourcesDone, { resources: 'unknown' })
    assert.equal(handle.snapshot().resources, 'unknown')
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  } finally {
    reader.releaseLock()
    await body.cancel()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Ownership late value discard failure preserves abort and never replays', async () => {
  const consumeGate = deferred<undefined>()
  const discardGate = deferred<undefined>()
  const consuming = deferred<undefined>()
  const discarding = deferred<undefined>()
  const value = { temporary: true }
  const reason = new Error('abort before value')
  let discarded: unknown
  let calls = 0
  let deliveries = 0
  const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
    calls++
    return Promise.resolve(new Response())
  })
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: async (_response, ctx) => {
      ctx.onDiscard(async () => {
        discarded = value
        discarding.resolve(undefined)
        await discardGate.promise
        throw new Error('discard failed')
      })
      consuming.resolve(undefined)
      await consumeGate.promise
      return value
    }
  })
  void handle.result.then(
    () => {
      deliveries++
    },
    () => undefined
  )
  try {
    await consuming.promise
    handle.abort(reason)
    await assert.rejects(
      handle.result,
      error => error instanceof OperationError && error.cause === reason && error.code === 'ABORTED'
    )
    consumeGate.resolve(undefined)
    await discarding.promise
    assert.equal(discarded, value)
    assert.equal(handle.snapshot().resources, 'pending')
    assert.equal(planner.snapshot().sentActive, 1)
    assert.equal(planner.snapshot().leasedAttempts, 1)
    discardGate.resolve(undefined)
    assert.deepEqual(await handle.resourcesDone, { resources: 'failed' })
    assert.equal(calls, 1)
    assert.equal(deliveries, 0)
    assert.equal(handle.snapshot().failureCode, 'ABORTED')
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().leasedAttempts, 0)
  } finally {
    consumeGate.resolve(undefined)
    discardGate.resolve(undefined)
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Ownership successful raw value survives rejected disposer without another assimilation or replay', async () => {
  let reads = 0
  let readsAtReturn = 0
  let disposals = 0
  let discards = 0
  let calls = 0
  const value = {
    get then() {
      reads++
      if (disposals) throw new Error('value assimilated outside owner lifetime')
      return undefined
    }
  }
  const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
    calls++
    return Promise.resolve(new Response())
  })
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: ctx => {
      ctx.onDispose(() => {
        readsAtReturn = reads
        disposals++
        throw new Error('release unconfirmed')
      })
      return { url: '', init: {} }
    },
    consume: (_response, ctx) => {
      ctx.onDiscard(() => {
        discards++
      })
      return value
    }
  })
  const completed = await handle.result
  assert.equal(completed.value, value)
  assert.equal(completed.cleanup, 'failed')
  assert.deepEqual(await handle.resourcesDone, { resources: 'failed' })
  assert.ok(readsAtReturn > 0)
  assert.equal(reads, readsAtReturn)
  assert.equal(discards, 0)
  assert.equal(disposals, 1)
  assert.equal(calls, 1)
  assert.equal(planner.snapshot().leasedAttempts, 0)
  assert.equal(planner.snapshot().sentActive, 0)
})

for (const lateReject of [false, true]) {
  test(`Ownership pending transport retains sent accounting until late ${lateReject ? 'rejection' : 'Response'}`, async () => {
    const transportGate = deferred<Response>()
    const sending = deferred<undefined>()
    let sends = 0
    let nextPrepares = 0
    let consumes = 0
    let cancels = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancels++
      }
    })
    const response = new Response(body, { status: 201 })
    const planner = new FetchPlanner<typeof globalThis.fetch>(
      () => {
        sends++
        if (sends > 1) return Promise.resolve(new Response())
        sending.resolve(undefined)
        return transportGate.promise
      },
      { maxParallelLimit: 1 }
    )
    const first = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      consume: () => {
        consumes++
        return 'first'
      }
    })
    const second = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        nextPrepares++
        return { url: '', init: {} }
      },
      consume: () => 'second'
    })
    try {
      await sending.promise
      first.abort()
      await assert.rejects(first.result, { code: 'ABORTED' })
      await setImmediate()
      assert.equal(nextPrepares, 0)
      assert.equal(first.snapshot().resources, 'pending')
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 1)
      assert.equal(cancels, 0)
      if (lateReject) transportGate.reject(new Error('late transport rejection'))
      else transportGate.resolve(response)
      assert.deepEqual(await first.resourcesDone, { resources: 'released' })
      await second.result
      await second.resourcesDone
      assert.equal(first.snapshot().failureCode, 'ABORTED')
      assert.equal(first.snapshot().status, lateReject ? undefined : 201)
      assert.equal(consumes, 0)
      assert.equal(cancels, lateReject ? 0 : 1)
      assert.equal(sends, 2)
      assert.equal(nextPrepares, 1)
      assert.equal(planner.snapshot().leasedAttempts, 0)
      assert.equal(planner.snapshot().sentActive, 0)
    } finally {
      transportGate.resolve(response)
      await Promise.allSettled([
        first.result,
        second.result,
        first.resourcesDone,
        second.resourcesDone
      ])
      await body.cancel()
    }
  })
}

for (const [entry, Planner] of [
  ['root', FetchPlanner],
  ['deep', DeepFetchPlanner]
] as const) {
  for (const [family, ResponseClass] of [
    ['native', Response],
    ['undici', UndiciResponse]
  ] as const) {
    for (const mode of [
      'failure',
      'abort-throw',
      'abort-return',
      'partial-success',
      'helper-success',
      'eof-release',
      'eof-locked',
      'errored-locked',
      'unread'
    ] as const) {
      test(`Ownership ${entry}/${family} locked Response ${mode} reports only proven release`, async () => {
        const ownerGate = deferred<undefined>()
        const entered = deferred<undefined>()
        const aborted = mode === 'abort-throw' || mode === 'abort-return'
        const released = mode === 'eof-release'
        const confirmed = released || mode === 'eof-locked' || mode === 'helper-success'
        const primary = new Error('partial read failed')
        const reason = new Error('abort partial reader')
        let cancels = 0
        let sends = 0
        let nextPrepares = 0
        let discards = 0
        let disposals = 0
        let resourcesSettled = false
        let source: ReadableStreamDefaultController<Uint8Array> | undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller
            controller.enqueue(new Uint8Array([7]))
            if (confirmed) controller.close()
          },
          cancel() {
            cancels++
          }
        })
        const response = new ResponseClass(body, { status: 206 })
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        const planner = new Planner<typeof UndiciFetch>(
          () => {
            sends++
            return Promise.resolve(sends === 1 ? response : new ResponseClass())
          },
          { maxParallelLimit: 1 }
        )
        const handle = planner.submit({
          method: 'POST',
          replay,
          prepare: () => ({ url: '', init: {} }),
          consume: async (borrowed, ctx) => {
            assert.equal(borrowed, response)
            ctx.onDiscard(() => {
              discards++
            })
            ctx.onDispose(() => {
              disposals++
            })
            if (mode === 'helper-success') {
              assert.equal(await borrowed.text(), '\u0007')
              assert.equal(body.locked, true)
              return 'value'
            }
            reader = borrowed.body?.getReader()
            assert.ok(reader)
            if (mode !== 'unread') {
              assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([7]) })
              assert.equal(response.bodyUsed, true)
            }
            if (released || mode === 'eof-locked') {
              assert.deepEqual(await reader.read(), { done: true, value: undefined })
              if (released) {
                reader.releaseLock()
                reader = undefined
              }
            }
            if (mode === 'errored-locked') {
              source?.error(new Error('body source failed'))
              assert.ok(reader)
              await assert.rejects(reader.closed, /body source failed/)
            }
            entered.resolve(undefined)
            if (aborted) await ownerGate.promise
            if (mode === 'failure' || mode === 'errored-locked' || mode === 'abort-throw')
              throw primary
            return 'value'
          }
        })
        void handle.resourcesDone.then(() => {
          resourcesSettled = true
        })
        const second = planner.submit({
          method: 'GET',
          replay,
          prepare: () => {
            nextPrepares++
            return { url: '', init: {} }
          },
          consume: () => 'second'
        })
        try {
          if (aborted) {
            await entered.promise
            handle.abort(reason)
            await assert.rejects(
              handle.result,
              error =>
                error instanceof OperationError &&
                error.code === 'ABORTED' &&
                error.status === 206 &&
                error.cause === reason
            )
            await setImmediate()
            assert.equal(resourcesSettled, false)
            assert.equal(handle.snapshot().resources, 'pending')
            assert.equal(planner.snapshot().leasedAttempts, 1)
            assert.equal(planner.snapshot().sentActive, 1)
            assert.equal(nextPrepares, 0)
            assert.equal(disposals, 0)
            assert.equal(cancels, 0)
            ownerGate.resolve(undefined)
          } else if (mode === 'failure' || mode === 'errored-locked') {
            await assert.rejects(
              handle.result,
              error =>
                error instanceof OperationError &&
                error.code === 'CONSUME_FAILED' &&
                error.status === 206 &&
                error.cause === primary
            )
          } else {
            const completed = await handle.result
            assert.equal(completed.value, 'value')
            assert.equal(completed.status, 206)
            assert.equal(completed.cleanup, confirmed ? 'released' : 'failed')
          }
          assert.deepEqual(
            await handle.resourcesDone,
            { resources: confirmed ? 'released' : 'unknown' },
            'PARTIAL_LOCKED_READER_MUST_NOT_BE_RELEASED'
          )
          assert.equal(handle.snapshot().resources, confirmed ? 'released' : 'unknown')
          assert.equal(handle.snapshot().status, 206)
          assert.equal(
            handle.snapshot().failureCode,
            aborted
              ? 'ABORTED'
              : mode === 'failure' || mode === 'errored-locked'
                ? 'CONSUME_FAILED'
                : undefined
          )
          assert.equal(body.locked, !released)
          assert.equal(cancels, 0)
          assert.equal(discards, aborted || mode === 'failure' || mode === 'errored-locked' ? 1 : 0)
          assert.equal(disposals, 1)
          await second.result
          await second.resourcesDone
          assert.equal(nextPrepares, 1)
          assert.equal(sends, 2, 'NO_REPLAY_AFTER_UNCONFIRMED_CLEANUP')
          assert.equal(planner.snapshot().leasedAttempts, 0)
          assert.equal(planner.snapshot().sentActive, 0)
        } finally {
          ownerGate.resolve(undefined)
          reader?.releaseLock()
          if (!body.locked) await body.cancel().catch(() => undefined)
          await Promise.allSettled([
            handle.result,
            handle.resourcesDone,
            second.result,
            second.resourcesDone
          ])
        }
      })
    }
  }
}
