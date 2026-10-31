import assert from 'node:assert/strict'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import {
  OperationError,
  type Decision,
  type Hook,
  type HookContext,
  type Event
} from '../../src/operation-types.js'
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

// These are runtime unknown-boundary inputs, built without widening the public Hook type.
const extractionCases = [
  'allow',
  'deny',
  'defer',
  'throw-type',
  'throw-code',
  'throw-delayMs',
  'stateful-type',
  'stateful-code',
  'stateful-delayMs',
  'extra',
  'hidden',
  'symbol',
  'invalid-type',
  'invalid-code',
  'delay-zero',
  'delay-negative',
  'delay-fraction',
  'delay-nan',
  'delay-infinity',
  'delay-unsafe',
  'delay-overflow',
  'delay-string',
  'ownKeys',
  'has'
] as const

for (const site of sites) {
  for (const scenario of extractionCases) {
    // Full result-chain coverage is concentrated on the arbitrary final-field readers.
    const forms =
      scenario.startsWith('stateful') || scenario.startsWith('throw')
        ? (['chain', 'promise-subclass'] as const)
        : (['chain'] as const)
    for (const form of forms) {
      test(`Hooks T91 ${site} guarded extraction ${scenario} ${form}`, async t => {
        const clock = createRuntime(t)
        const timers = trackTimeouts(t)
        const gate = deferred<undefined>()
        const entered = deferred<undefined>()
        const jobs: Promise<void>[] = []
        const records: unknown[] = []
        const contexts: HookContext[] = []
        const frozenSnapshots: string[] = []
        const canary = 'T91-private-decision-error-payload'
        const rawError = new Error(canary)
        const reads = new Map<string, number>()
        const boundaries: { stage: string; lease: number; sent: number; cleanup: number[] }[] = []
        let dispatches = 0
        let prepares = 0
        let discards = 0
        let disposals = 0
        let uploads = 0
        let siblingPrepares = 0
        let childPrepares = 0
        let hooks = 0
        let resources = 0
        const planner = new FetchPlanner<typeof fetch>(
          () => {
            dispatches++
            return Promise.resolve(new Response(canary))
          },
          { maxParallelLimit: 1, maxQueuedOperations: 2 }
        )
        const children: ReturnType<typeof planner.submit>[] = []
        const probes: { stage: string; id: number; outcome: Promise<string> }[] = []
        function inspect(stage: string) {
          const child = planner.submit({
            method: 'GET',
            replay,
            prepare: () => {
              childPrepares++
              return { url: canary, init: {} }
            },
            consume: () => canary
          })
          children.push(child)
          probes.push({
            stage,
            id: child.id,
            outcome: child.result.then(
              () => 'accepted',
              (error: unknown) => (error instanceof OperationError ? error.code : 'unexpected')
            )
          })
          const snapshot = planner.snapshot()
          boundaries.push({
            stage,
            lease: snapshot.leasedAttempts,
            sent: snapshot.sentActive,
            cleanup: [disposals, discards, uploads]
          })
        }
        function read(field: string, value: unknown): unknown {
          const count = (reads.get(field) ?? 0) + 1
          reads.set(field, count)
          inspect(`field ${field} read ${count}`)
          if (scenario === `throw-${field}` || count > 1) throw rawError
          return value
        }
        const denial =
          scenario.endsWith('code') || scenario === 'deny' || scenario === 'invalid-code'
        const delay = scenario.includes('delay') || scenario === 'defer'
        const raw: Decision = denial
          ? { type: 'deny', code: 'POLICY_DENIED' }
          : delay
            ? { type: 'defer', delayMs: 7 }
            : { type: 'allow' }
        let type: unknown = denial ? 'deny' : delay ? 'defer' : 'allow'
        if (scenario === 'invalid-type') type = canary
        Object.defineProperty(raw, 'type', {
          enumerable: true,
          configurable: true,
          get: () => read('type', type)
        })
        if (denial)
          Object.defineProperty(raw, 'code', {
            enumerable: true,
            get: () => read('code', scenario === 'invalid-code' ? canary : 'POLICY_DENIED')
          })
        if (delay) {
          const invalidDelays: Record<string, unknown> = {
            'delay-zero': 0,
            'delay-negative': -1,
            'delay-fraction': 0.5,
            'delay-nan': NaN,
            'delay-infinity': Infinity,
            'delay-unsafe': Number.MAX_SAFE_INTEGER + 1,
            'delay-overflow': Number.MAX_SAFE_INTEGER,
            'delay-string': canary
          }
          Object.defineProperty(raw, 'delayMs', {
            enumerable: true,
            get: () => read('delayMs', scenario in invalidDelays ? invalidDelays[scenario] : 7)
          })
        }
        if (scenario === 'extra')
          Object.defineProperty(raw, 'extra', { value: canary, enumerable: true })
        if (scenario === 'hidden') Object.defineProperty(raw, 'hidden', { value: canary })
        if (scenario === 'symbol') Object.defineProperty(raw, Symbol(canary), { value: canary })
        Object.setPrototypeOf(raw, {
          get then() {
            inspect('final inherited then')
            return undefined
          }
        })
        const decision =
          scenario === 'ownKeys' || scenario === 'has'
            ? new Proxy(raw, {
                ownKeys(target) {
                  inspect('proxy ownKeys')
                  if (scenario === 'ownKeys') throw rawError
                  return Reflect.ownKeys(target)
                },
                has(target, key) {
                  inspect('proxy has')
                  if (scenario === 'has') throw rawError
                  return Reflect.has(target, key)
                }
              })
            : raw
        // Each returned thenable is created only after the preceding resolution job.
        function chain(depth: number): Decision {
          if (depth === 0) return decision
          const step: Decision = { type: 'allow' }
          Object.setPrototypeOf(step, {
            get then() {
              inspect(`chain getter ${depth}`)
              return (resolve: (value: Decision) => void) => {
                inspect(`chain resolve ${depth}`)
                resolve(chain(depth - 1))
              }
            }
          })
          return step
        }
        const hook: Hook = context => {
          hooks++
          contexts.push(context)
          frozenSnapshots.push(JSON.stringify(context.snapshot))
          inspect('hook body')
          const wrapper: Decision = { type: 'allow' }
          Object.setPrototypeOf(wrapper, {
            get then() {
              inspect('outer getter')
              return (resolve: (value: Decision) => void) => {
                inspect('outer resolve')
                entered.resolve(undefined)
                jobs.push(
                  gate.promise.then(() => {
                    resolve(chain(12))
                  })
                )
              }
            }
          })
          if (form === 'promise-subclass') {
            class DecisionPromise extends Promise<Decision> {}
            return new DecisionPromise(resolve => {
              resolve(wrapper)
            })
          }
          return wrapper
        }
        const target = planner.submit({
          method: 'POST',
          replay,
          [site]: hook,
          prepare: ctx => {
            prepares++
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(canary))
                controller.close()
              }
            })
            ctx.onDispose(async () => {
              await new Response(body).text()
              uploads++
            })
            ctx.onDispose(() => {
              disposals++
            })
            return { url: canary, init: { body, duplex: 'half' } }
          },
          consume: async (response, ctx) => {
            const value = await response.text()
            if (site === 'beforeRetry' && ctx.attemptNumber === 1) {
              ctx.onDiscard(() => {
                discards++
              })
              throw ctx.retryableReadFailure(rawError)
            }
            return value
          }
        })
        const result = target.result.then(
          value => value,
          (error: unknown) => error
        )
        void target.resourcesDone.then(() => {
          resources++
        })
        target.observe(event => {
          records.push(event)
        })
        planner.observe(event => {
          records.push(event)
        })
        const sibling = planner.submit({
          method: 'GET',
          replay,
          prepare: () => {
            siblingPrepares++
            return { url: 'sibling', init: {} }
          },
          consume: () => 'sibling'
        })
        void sibling.result.catch(() => undefined)
        try {
          await entered.promise
          await clock.flush()
          const prior = site === 'beforeRetry' ? 1 : 0
          assert.equal(hooks, 1)
          assert.deepEqual(
            [prepares, dispatches, disposals, discards, uploads],
            [1, prior, prior, prior, prior]
          )
          assert.deepEqual([resources, siblingPrepares], [0, 0])
          assert.deepEqual(
            [planner.snapshot().leasedAttempts, planner.snapshot().sentActive],
            [1, 0]
          )
          gate.resolve(undefined)
          await clock.flush()
          // Causal oracle comes before queue/accounting checks and before awaiting child results.
          assert.ok(
            reads.size > 0 || scenario === 'ownKeys' || scenario === 'has',
            'T91_GETTER_ENTERED'
          )
          for (const probe of probes) {
            assert.equal(probe.id, 0, `T91_NESTED_SUBMIT_REJECTED ${site} ${probe.stage}`)
            assert.equal(await probe.outcome, 'REENTRANT_OPERATION', probe.stage)
          }
          assert.equal(childPrepares, 0)
          for (const boundary of boundaries) {
            assert.deepEqual([boundary.lease, boundary.sent], [1, 0], boundary.stage)
            assert.deepEqual(boundary.cleanup, [prior, prior, prior], boundary.stage)
          }
          for (const count of reads.values()) assert.equal(count, 1, 'SAFE_SCALAR_READ_ONCE')
          const allowed = ['allow', 'defer', 'stateful-type', 'stateful-delayMs'].includes(scenario)
          const denied = ['deny', 'stateful-code'].includes(scenario)
          await clock.advance(100)
          const outcome = await result
          if (allowed) {
            assert.ok(!(outcome instanceof Error))
            assert.ok(typeof outcome === 'object')
            assert.ok(outcome !== null && 'value' in outcome)
            assert.equal(outcome.value, canary)
          } else {
            assert.ok(outcome instanceof OperationError)
            assert.equal(outcome.code, denied ? 'HOOK_DENIED' : 'HOOK_FAILED')
            if (denied) assert.equal(outcome.cause, 'POLICY_DENIED')
          }
          await target.resourcesDone
          await sibling.result
          await sibling.resourcesDone
          assert.equal(hooks, 1)
          assert.equal(target.snapshot().dispatchCalls, prior + (allowed ? 1 : 0))
          assert.equal(dispatches, prior + (allowed ? 1 : 0) + 1)
          assert.equal(prepares, site === 'beforeRetry' && allowed ? 2 : 1)
          assert.deepEqual([disposals, uploads, discards], [prepares, prepares, prior])
          assert.deepEqual([resources, siblingPrepares], [1, 1])
          for (const [index, context] of contexts.entries()) {
            assert.deepEqual(
              Reflect.ownKeys(context).sort(),
              [
                ...['snapshot', 'signal', 'attemptNumber', 'dispatchCalls'],
                ...(prior ? ['status'] : [])
              ].sort()
            )
            assert.deepEqual(
              Reflect.ownKeys(context.snapshot).sort(),
              [
                ...[
                  'id',
                  'sequence',
                  'phase',
                  'outcome',
                  'resultCommitted',
                  'resources',
                  'attempts',
                  'dispatchCalls',
                  'dispatchEntered'
                ],
                ...(prior ? ['status'] : [])
              ].sort()
            )
            assert.equal(Object.isFrozen(context), true)
            assert.equal(Object.isFrozen(context.snapshot), true)
            assert.equal(Reflect.set(context, 'attemptNumber', 999), false)
            assert.equal(Reflect.set(context.snapshot, 'phase', 'terminal'), false)
            assert.equal(
              JSON.stringify(context.snapshot),
              frozenSnapshots[index],
              'DETACHED_SNAPSHOT'
            )
            assert.ok(context.signal instanceof AbortSignal)
            assert.deepEqual(
              [context.attemptNumber, context.dispatchCalls, context.status],
              [1, prior, prior ? 200 : undefined]
            )
          }
          records.push(target.snapshot(), planner.snapshot())
          const publicJson = JSON.stringify(records)
          assert.equal(publicJson.includes(canary), false, 'T91_PRIVATE_TEXT_ABSENT')
          const recordKeys = new Set([
            'id',
            'sequence',
            'phase',
            'outcome',
            'resultCommitted',
            'resources',
            'attempts',
            'dispatchCalls',
            'dispatchEntered',
            'failureCode',
            'status',
            'type',
            'epochTime',
            'elapsedMs',
            'stopped',
            'guardOpen',
            'queued',
            'leasedAttempts',
            'sentActive',
            'effectiveParallelism',
            'serverNotBefore'
          ])
          for (const record of records) {
            assert.ok(typeof record === 'object' && record !== null)
            for (const [key, value] of Object.entries(record)) {
              assert.equal(recordKeys.has(key), true, key)
              assert.ok(
                value === null ||
                  ['string', 'number', 'boolean', 'undefined'].includes(typeof value),
                key
              )
              assert.ok(
                !['cause', 'stack', 'message', 'decision', 'body', 'url', 'headers'].includes(key),
                key
              )
            }
          }
          assert.equal(planner.snapshot().leasedAttempts, 0)
          assert.equal(planner.snapshot().sentActive, 0)
          assert.equal(timers.active.size, 0)
        } finally {
          gate.resolve(undefined)
          target.abort()
          sibling.abort()
          for (const child of children) child.abort()
          await Promise.allSettled([
            result,
            target.resourcesDone,
            sibling.result,
            sibling.resourcesDone,
            ...jobs,
            ...children.flatMap(child => [child.result, child.resourcesDone])
          ])
        }
      })
    }
  }
}

for (const site of sites) {
  for (const mode of ['timeout', 'abort', 'stop', 'deadline'] as const) {
    for (const field of ['type', 'code', 'delayMs'] as const) {
      test(`Hooks T91 ${site} late throwing ${field} preserves ${mode}`, async t => {
        const clock = createRuntime(t)
        const gate = deferred<Decision>()
        const records: Event[] = []
        const canary = 'T91-private-late-getter-error'
        const lateError = new Error(canary)
        let entered = 0
        let reads = 0
        let sends = 0
        let disposals = 0
        let resources = 0
        const planner = new FetchPlanner<typeof fetch>(
          () => {
            sends++
            return Promise.resolve(new Response('complete body'))
          },
          { maxParallelLimit: 1 }
        )
        const children: ReturnType<typeof planner.submit>[] = []
        const outcomes: Promise<unknown>[] = []
        const ids: number[] = []
        const late: Decision =
          field === 'code'
            ? { type: 'deny', code: 'POLICY_DENIED' }
            : field === 'delayMs'
              ? { type: 'defer', delayMs: 1 }
              : { type: 'allow' }
        Object.defineProperty(late, field, {
          get() {
            reads++
            const child = planner.submit({
              method: 'GET',
              replay,
              prepare: () => ({ url: 'nested', init: {} }),
              consume: () => 0
            })
            children.push(child)
            ids.push(child.id)
            outcomes.push(child.result.catch((error: unknown) => error))
            throw lateError
          }
        })
        const target = planner.submit({
          method: 'POST',
          replay,
          ...(mode === 'deadline' ? { deadlineMs: 100 } : {}),
          [site]: () => {
            entered++
            return gate.promise
          },
          prepare: ctx => {
            ctx.onDispose(() => {
              disposals++
            })
            return { url: 'target', init: { body: 'payload' } }
          },
          consume: async (response, ctx) => {
            await response.text()
            throw ctx.retryableReadFailure(new Error('read'))
          }
        })
        const result = target.result.catch((error: unknown) => error)
        target.observe(event => {
          records.push(event)
        })
        void target.resourcesDone.then(() => {
          resources++
        })
        try {
          await clock.flush()
          assert.equal(entered, 1)
          if (mode === 'abort') target.abort()
          else if (mode === 'stop') planner.stop()
          else await clock.advance(mode === 'deadline' ? 100 : 1000)
          const primary = await result
          assert.ok(primary instanceof OperationError)
          assert.equal(
            primary.code,
            mode === 'timeout'
              ? 'HOOK_FAILED'
              : mode === 'abort'
                ? 'ABORTED'
                : mode === 'stop'
                  ? 'STOPPED'
                  : 'DEADLINE'
          )
          assert.equal(resources, 0)
          assert.deepEqual(
            [planner.snapshot().leasedAttempts, planner.snapshot().sentActive],
            [1, 0]
          )
          gate.resolve(late)
          await target.resourcesDone
          assert.equal(reads, 1, 'LATE_GETTER_REALLY_EXTRACTED')
          for (const id of ids) assert.equal(id, 0, 'LATE_EXTRACTION_REENTRY_REJECTED')
          for (const outcome of await Promise.all(outcomes)) {
            assert.ok(outcome instanceof OperationError)
            assert.equal(outcome.code, 'REENTRANT_OPERATION')
          }
          await clock.advance(2000)
          assert.equal(await result, primary)
          assert.equal(target.snapshot().failureCode, primary.code)
          assert.deepEqual([sends, disposals, resources], [site === 'beforeRetry' ? 1 : 0, 1, 1])
          assert.equal(records.filter(record => record.type === 'operation-settled').length, 1)
          assert.equal(records.filter(record => record.type === 'resources-settled').length, 1)
          assert.equal(JSON.stringify(records).includes(canary), false)
          assert.equal(planner.snapshot().leasedAttempts, 0)
        } finally {
          gate.resolve(late)
          target.abort()
          for (const child of children) child.abort()
          await Promise.allSettled([
            result,
            target.resourcesDone,
            ...outcomes,
            ...children.flatMap(child => [child.result, child.resourcesDone])
          ])
        }
      })
    }
  }
}
