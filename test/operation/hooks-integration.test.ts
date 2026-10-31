import assert from 'node:assert/strict'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import { OperationError, type Decision, type Hook, type Event } from '../../src/operation-types.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const replay = { serverSafe: true, consumeSafe: true }
const sites = ['beforeDispatch', 'beforeRetry'] as const

for (const [entry, Planner] of [
  ['root', RootPlanner],
  ['deep', FetchPlanner]
] as const) {
  for (const site of sites) {
    for (const mode of ['timeout', 'abort', 'stop', 'deadline', 'attempt'] as const) {
      for (const late of ['allow', 'deny', 'defer', 'reject'] as const) {
        test(`Hooks ${entry} ${site} pending ${mode} late ${late} keeps physical barrier`, async t => {
          const clock = createRuntime(t)
          const timers = trackTimeouts(t)
          const gate = deferred<Decision>()
          const events: Event[] = []
          const reason = new Error('T88 cancellation reason')
          let signal: AbortSignal | undefined
          let hookCalls = 0
          let prepares = 0
          let dispatches = 0
          let consumes = 0
          let disposes = 0
          let discards = 0
          let nextPrepare = 0
          let delivered = 0
          let rejected = 0
          let resources = 0
          const hook: Hook = ctx => {
            hookCalls++
            signal = ctx.signal
            return gate.promise
          }
          const planner = new Planner<typeof fetch>(
            () => {
              dispatches++
              return Promise.resolve(new Response(null, { status: 200 }))
            },
            { maxParallelLimit: 1, ...(mode === 'attempt' ? { attemptTimeoutMs: 300 } : {}) }
          )
          const handle = planner.submit({
            method: 'POST',
            replay,
            ...(mode === 'deadline' ? { deadlineMs: 400 } : {}),
            [site]: hook,
            prepare: ctx => {
              prepares++
              ctx.onDispose(() => {
                disposes++
              })
              return { url: 'target', init: { body: 'same logical payload' } }
            },
            consume: (_response, ctx) => {
              consumes++
              ctx.onDiscard(() => {
                discards++
              })
              throw ctx.retryableReadFailure(new Error('T88 read failure'))
            }
          })
          handle.observe(event => {
            events.push(event)
          })
          const observed = handle.result.then(
            () => {
              delivered++
              return undefined
            },
            (error: unknown) => {
              rejected++
              return error
            }
          )
          void handle.resourcesDone.then(() => {
            resources++
          })
          const sibling = planner.submit({
            method: 'GET',
            replay,
            prepare: () => {
              nextPrepare++
              return { url: 'sibling', init: {} }
            },
            consume: () => 'sibling value'
          })
          void sibling.result.catch(() => undefined)
          try {
            await clock.flush()
            const prior = site === 'beforeRetry' ? 1 : 0
            assert.equal(hookCalls, 1)
            assert.ok(signal)
            assert.deepEqual(
              [prepares, dispatches, consumes, disposes, discards],
              [1, prior, prior, prior, prior]
            )
            assert.deepEqual([delivered, rejected, resources, nextPrepare], [0, 0, 0, 0])
            assert.deepEqual(
              [planner.snapshot().leasedAttempts, planner.snapshot().sentActive],
              [1, 0]
            )
            assert.equal(planner.snapshot().queued, 1)
            assert.equal(signal.aborted, false)
            const cutoff = mode === 'deadline' ? 400 : mode === 'attempt' ? 300 : 1000
            await clock.advance(cutoff - 1)
            assert.equal(handle.snapshot().outcome, 'pending')
            assert.equal(signal.aborted, false)
            assert.deepEqual([delivered, rejected, resources, nextPrepare], [0, 0, 0, 0])
            if (mode === 'abort') handle.abort(reason)
            else if (mode === 'stop') planner.stop(reason)
            else await clock.advance(1)
            await clock.flush()
            const code =
              mode === 'timeout'
                ? 'HOOK_FAILED'
                : mode === 'abort'
                  ? 'ABORTED'
                  : mode === 'stop'
                    ? 'STOPPED'
                    : mode === 'deadline'
                      ? 'DEADLINE'
                      : 'ATTEMPT_TIMEOUT'
            const error = await observed
            assert.ok(error instanceof OperationError)
            assert.equal(error.code, code)
            assert.equal(error.operationId, handle.id)
            assert.equal(error.attemptNumber, 1)
            assert.equal(error.dispatchEntered, prior === 1)
            assert.equal(error.status, prior === 1 ? 200 : undefined)
            assert.equal(error.serverOutcome, prior === 1 ? 'http-response' : 'not-dispatched')
            if (mode === 'abort' || mode === 'stop') {
              assert.equal(error.cause, reason)
              assert.equal(signal.reason, reason)
            }
            assert.equal(signal.aborted, true)
            assert.equal(nextPrepare, 0, 'T88_PENDING_HOOK_BLOCKS_REAL_QUEUED_PREPARE')
            assert.equal(resources, 0, 'T88_RESOURCES_MUST_WAIT_FOR_CALLBACK_SETTLEMENT')
            assert.deepEqual(
              [planner.snapshot().leasedAttempts, planner.snapshot().sentActive],
              [1, 0]
            )
            assert.deepEqual([delivered, rejected], [0, 1])
            assert.equal(handle.snapshot().resultCommitted, false)
            assert.equal(handle.snapshot().resources, 'pending')
            const terminal = handle.snapshot()
            // Further commands and clock wakes cannot replace the primary failure or retire the owner.
            handle.abort(new Error('later reason'))
            await clock.advance(10)
            assert.equal(handle.snapshot().failureCode, code)
            assert.equal(nextPrepare, 0)
            assert.equal(resources, 0)
            if (late === 'reject') gate.reject(new Error('late hook rejection'))
            else
              gate.resolve(
                late === 'deny'
                  ? { type: 'deny', code: 'POLICY_DENIED' }
                  : late === 'defer'
                    ? { type: 'defer', delayMs: 500 }
                    : { type: 'allow' }
              )
            assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
            await clock.flush()
            if (mode === 'stop') {
              await assert.rejects(sibling.result, { code: 'STOPPED', cause: reason })
              const afterStop = planner.submit({
                method: 'GET',
                replay,
                prepare: () => {
                  nextPrepare++
                  return { url: 'forbidden', init: {} }
                },
                consume: () => 0
              })
              await assert.rejects(afterStop.result, { code: 'STOPPED', cause: reason })
              await afterStop.resourcesDone
              assert.equal(nextPrepare, 0, 'PERMANENT_STOP_SURVIVES_PHYSICAL_RELEASE')
            } else {
              await clock.advance(1)
              assert.equal((await sibling.result).value, 'sibling value')
              assert.equal(nextPrepare, 1, 'PHYSICAL_SETTLEMENT_UNBLOCKS_REAL_SIBLING')
            }
            await sibling.resourcesDone
            await clock.advance(5000)
            assert.equal(await observed, error, 'PRIMARY_ERROR_IDENTITY_PRESERVED')
            assert.deepEqual([delivered, rejected, resources, hookCalls, prepares], [0, 1, 1, 1, 1])
            assert.deepEqual([disposes, discards], [1, prior])
            assert.equal(
              dispatches,
              prior + (mode === 'stop' ? 0 : 1),
              'LATE_HOOK_NEVER_DISPATCHES_TARGET'
            )
            assert.equal(handle.snapshot().failureCode, terminal.failureCode)
            assert.equal(handle.snapshot().dispatchCalls, prior)
            assert.equal(events.filter(event => event.type === 'operation-settled').length, 1)
            assert.equal(events.filter(event => event.type === 'resources-settled').length, 1)
            assert.deepEqual(
              [
                planner.snapshot().leasedAttempts,
                planner.snapshot().sentActive,
                planner.snapshot().queued
              ],
              [0, 0, 0]
            )
            assert.ok(timers.maximum() <= 1, 'ONE_COORDINATOR_TIMER')
            assert.equal(timers.active.size, 0)
          } finally {
            gate.resolve({ type: 'allow' })
            handle.abort()
            sibling.abort()
            await Promise.allSettled([
              observed,
              handle.result,
              handle.resourcesDone,
              sibling.result,
              sibling.resourcesDone
            ])
          }
        })
      }
    }
  }
}

for (const site of sites) {
  for (const budget of ['hook', 'deadline', 'attempt'] as const) {
    for (const decision of ['allow', 'defer'] as const) {
      test(`Hooks ${site} absolute ${budget} expiry rejects overdue ${decision} without timer delivery`, async t => {
        const clock = createRuntime(t)
        const timers = trackTimeouts(t)
        let now = 1000000
        t.mock.method(performance, 'now', () => now)
        const gate = deferred<Decision>()
        let calls = 0
        let resources = 0
        let hooks = 0
        const planner = new FetchPlanner<typeof fetch>(
          () => {
            calls++
            return Promise.resolve(new Response(null, { status: 200 }))
          },
          { maxParallelLimit: 1, ...(budget === 'attempt' ? { attemptTimeoutMs: 300 } : {}) }
        )
        const handle = planner.submit({
          method: 'POST',
          replay,
          ...(budget === 'deadline' ? { deadlineMs: 400 } : {}),
          [site]: () => {
            hooks++
            return gate.promise
          },
          prepare: () => ({ url: '', init: {} }),
          consume: (_response, ctx) => {
            throw ctx.retryableReadFailure(new Error('read'))
          }
        })
        void handle.result.catch(() => undefined)
        void handle.resourcesDone.then(() => {
          resources++
        })
        try {
          await clock.flush()
          assert.equal(hooks, 1)
          const callbacks = timers.callbacks.length
          now += budget === 'hook' ? 1000 : budget === 'deadline' ? 400 : 300
          await clock.flush()
          assert.equal(handle.snapshot().outcome, 'pending', 'DUE_TIMER_INTENTIONALLY_UNDELIVERED')
          assert.equal(resources, 0)
          assert.equal(planner.snapshot().leasedAttempts, 1)
          assert.equal(timers.callbacks.length, callbacks)
          gate.resolve(decision === 'allow' ? { type: 'allow' } : { type: 'defer', delayMs: 500 })
          await assert.rejects(handle.result, {
            code:
              budget === 'hook'
                ? 'HOOK_FAILED'
                : budget === 'deadline'
                  ? 'DEADLINE'
                  : 'ATTEMPT_TIMEOUT'
          })
          await handle.resourcesDone
          assert.equal(
            calls,
            site === 'beforeRetry' ? 1 : 0,
            'ABSOLUTE_EXPIRY_PREVENTS_LATE_DISPATCH'
          )
          assert.equal(handle.snapshot().resultCommitted, false)
          assert.equal(resources, 1)
          assert.equal(planner.snapshot().leasedAttempts, 0)
          assert.equal(timers.active.size, 0)
          assert.ok(timers.maximum() <= 1)
        } finally {
          gate.resolve({ type: 'allow' })
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }
}

for (const site of sites) {
  test(`Hooks ${site} admission deadline includes queue prepare HTTP cleanup and hook time`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const blockerGate = deferred<undefined>()
    const prepareGate = deferred<undefined>()
    const consumeGate = deferred<undefined>()
    const disposeGate = deferred<undefined>()
    const hookGate = deferred<Decision>()
    let hooks = 0
    let targetCalls = 0
    let prepares = 0
    let consumes = 0
    let disposes = 0
    let resources = 0
    const planner = new FetchPlanner<typeof fetch>(
      url => {
        if (url === 'target') targetCalls++
        return Promise.resolve(new Response(null, { status: 200 }))
      },
      { maxParallelLimit: 1 }
    )
    const blocker = planner.submit({
      method: 'GET',
      replay,
      prepare: async () => {
        await blockerGate.promise
        return { url: 'blocker', init: {} }
      },
      consume: () => 1
    })
    const target = planner.submit({
      method: 'POST',
      replay,
      deadlineMs: 200,
      prepare: async ctx => {
        prepares++
        ctx.onDispose(async () => {
          disposes++
          await disposeGate.promise
        })
        await prepareGate.promise
        return { url: 'target', init: { body: 'payload' } }
      },
      [site]: () => {
        hooks++
        return hookGate.promise
      },
      consume: async (_response, ctx) => {
        consumes++
        await consumeGate.promise
        throw ctx.retryableReadFailure(new Error('read'))
      }
    })
    void target.result.catch(() => undefined)
    void target.resourcesDone.then(() => {
      resources++
    })
    try {
      await clock.advance(40)
      assert.equal(prepares, 0, 'DEADLINE_STARTS_WHILE_QUEUED')
      blockerGate.resolve(undefined)
      await blocker.result
      await blocker.resourcesDone
      await clock.flush()
      assert.equal(prepares, 1)
      await clock.advance(30)
      prepareGate.resolve(undefined)
      await clock.flush()
      if (site === 'beforeRetry') {
        assert.deepEqual([targetCalls, consumes, hooks], [1, 1, 0])
        await clock.advance(40)
        consumeGate.resolve(undefined)
        await clock.flush()
        assert.deepEqual([disposes, hooks], [1, 0], 'FULL_CLEANUP_PRECEDES_RETRY_HOOK')
        await clock.advance(30)
        disposeGate.resolve(undefined)
        await clock.flush()
      }
      assert.equal(hooks, 1)
      await clock.advance(site === 'beforeRetry' ? 59 : 129)
      assert.equal(target.snapshot().outcome, 'pending', 'ADMISSION_199_STILL_PENDING')
      assert.equal(resources, 0)
      assert.equal(planner.snapshot().sentActive, 0)
      await clock.advance(1)
      await assert.rejects(target.result, { code: 'DEADLINE' })
      assert.equal(resources, 0)
      assert.equal(planner.snapshot().leasedAttempts, 1)
      hookGate.resolve({ type: 'allow' })
      disposeGate.resolve(undefined)
      await target.resourcesDone
      await clock.advance(1000)
      assert.deepEqual([prepares, hooks, disposes, resources], [1, 1, 1, 1])
      assert.equal(targetCalls, site === 'beforeRetry' ? 1 : 0)
      assert.equal(target.snapshot().resultCommitted, false)
      assert.equal(planner.snapshot().leasedAttempts, 0)
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
    } finally {
      blockerGate.resolve(undefined)
      prepareGate.resolve(undefined)
      consumeGate.resolve(undefined)
      disposeGate.resolve(undefined)
      hookGate.resolve({ type: 'allow' })
      blocker.abort()
      target.abort()
      await Promise.allSettled([
        blocker.result,
        blocker.resourcesDone,
        target.result,
        target.resourcesDone
      ])
    }
  })
}
