import assert from 'node:assert/strict'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import {
  OperationError,
  type Decision,
  type Hook,
  type HookContext,
  type Event,
  type Handle
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

for (const site of sites) {
  for (const mode of ['settlement', 'timeout', 'abort', 'stop', 'deadline'] as const) {
    test(`Hooks T92 ${site} inherited descendants ${mode}`, async t => {
      const clock = createRuntime(t)
      const entered = deferred<undefined>()
      const active = deferred<undefined>()
      const fire = deferred<undefined>()
      const release = deferred<undefined>()
      const late = deferred<undefined>()
      const siblingRelease = deferred<undefined>()
      const siblingEntered = deferred<undefined>()
      const probes: { stage: string; handle: Handle<string>; error: Promise<unknown> }[] = []
      const jobs: Promise<void>[] = []
      let prepares = 0
      let sends = 0
      let cleanup = 0
      let childPrepares = 0
      let siblingPrepares = 0
      let context: HookContext | undefined
      const planner = new FetchPlanner<typeof fetch>(
        () => {
          sends++
          return Promise.resolve(new Response('T92 private body'))
        },
        { maxParallelLimit: 1, maxQueuedOperations: 2 }
      )
      function probe(stage: string) {
        const handle = planner.submit({
          method: 'GET',
          replay,
          prepare: () => {
            childPrepares++
            return { url: 'child', init: {} }
          },
          consume: () => 'child'
        })
        probes.push({ stage, handle, error: handle.result.catch((error: unknown) => error) })
      }
      const owner = planner.submit({
        method: 'POST',
        replay,
        ...(mode === 'deadline' ? { deadlineMs: 100 } : {}),
        [site]: async (ctx: HookContext) => {
          context = ctx
          await Promise.resolve()
          // All three continuations are created inside the actual owning callback.
          jobs.push(
            fire.promise.then(() => {
              probe('fire-and-forget')
            })
          )
          jobs.push(
            late.promise.then(() => {
              probe('inactive')
            })
          )
          entered.resolve(undefined)
          await active.promise
          probe('after-await')
          fire.resolve(undefined)
          await jobs[0]
          await release.promise
          return { type: 'deny', code: 'POLICY_DENIED' } as const
        },
        prepare: ctx => {
          prepares++
          ctx.onDispose(() => {
            cleanup++
          })
          return { url: 'owner', init: { body: 'T92 private payload' } }
        },
        consume: async (response, ctx) => {
          await response.text()
          throw ctx.retryableReadFailure(new Error('T92 private read'))
        }
      })
      const primary = owner.result.catch((error: unknown) => error)
      const sibling = planner.submit({
        method: 'GET',
        replay,
        prepare: async () => {
          siblingPrepares++
          siblingEntered.resolve(undefined)
          await siblingRelease.promise
          return { url: 'sibling', init: {} }
        },
        consume: () => 'sibling'
      })
      void sibling.result.catch(() => undefined)
      try {
        await entered.promise
        assert.ok(context)
        const snapshot = JSON.stringify(context.snapshot)
        const prior = site === 'beforeRetry' ? 1 : 0
        assert.deepEqual([prepares, sends, cleanup], [1, prior, prior])
        assert.equal(context.signal.aborted, false)
        if (mode === 'abort') owner.abort()
        else if (mode === 'stop') planner.stop()
        else if (mode !== 'settlement') await clock.advance(mode === 'timeout' ? 1000 : 100)
        if (mode !== 'settlement') {
          const error = await primary
          assert.ok(error instanceof OperationError)
          assert.equal(
            error.code,
            mode === 'timeout'
              ? 'HOOK_FAILED'
              : mode === 'abort'
                ? 'ABORTED'
                : mode === 'stop'
                  ? 'STOPPED'
                  : 'DEADLINE'
          )
          assert.equal(context.signal.aborted, true)
        }
        active.resolve(undefined)
        await jobs[0]
        assert.deepEqual(
          probes.map(p => p.stage),
          ['after-await', 'fire-and-forget']
        )
        // Direct oracles precede any wait for a potentially accepted child's result.
        for (const probe of probes) {
          assert.equal(probe.handle.id, 0, `T92_ACTIVE_ID ${site} ${probe.stage}`)
          assert.equal(
            probe.handle.snapshot().failureCode,
            'REENTRANT_OPERATION',
            `T92_ACTIVE_ERROR ${site} ${probe.stage}`
          )
          const error = await probe.error
          assert.ok(error instanceof OperationError)
          assert.equal(error.code, 'REENTRANT_OPERATION')
        }
        assert.equal(childPrepares, 0)
        assert.equal(siblingPrepares, 0)
        assert.deepEqual([planner.snapshot().leasedAttempts, planner.snapshot().sentActive], [1, 0])
        assert.equal(owner.snapshot().resources, 'pending')
        release.resolve(undefined)
        await owner.resourcesDone
        assert.equal(JSON.stringify(context.snapshot), snapshot, 'T92_CONTEXT_SNAPSHOT_DETACHED')
        if (mode !== 'stop') {
          await siblingEntered.promise
          // Owner settlement has really happened; a different owner is now pending.
          late.resolve(undefined)
          await jobs[1]
          const inherited = probes.at(-1)
          assert.ok(inherited)
          assert.equal(inherited.stage, 'inactive')
          assert.equal(inherited.handle.id, 3, 'T92_INACTIVE_ID_ACCEPTED_FIFO')
          assert.equal(inherited.handle.snapshot().failureCode, undefined)
          assert.equal(childPrepares, 0, 'T92_INACTIVE_STILL_BOUNDED_BY_SIBLING')
          siblingRelease.resolve(undefined)
          await sibling.result
          await sibling.resourcesDone
          await clock.advance(1)
          assert.equal((await inherited.handle.result).value, 'child')
          assert.equal(childPrepares, 1)
        } else {
          late.resolve(undefined)
          await jobs[1]
          assert.equal(probes.at(-1)?.handle.snapshot().failureCode, 'STOPPED')
        }
        const settled = await primary
        assert.ok(settled instanceof OperationError)
        assert.equal(
          settled.code,
          mode === 'settlement'
            ? 'HOOK_DENIED'
            : mode === 'timeout'
              ? 'HOOK_FAILED'
              : mode === 'abort'
                ? 'ABORTED'
                : mode === 'stop'
                  ? 'STOPPED'
                  : 'DEADLINE'
        )
        assert.equal(cleanup, 1, 'T92_CLEANUP_RELEASED_ONCE')
        assert.equal(owner.snapshot().dispatchCalls, prior)
      } finally {
        active.resolve(undefined)
        fire.resolve(undefined)
        release.resolve(undefined)
        late.resolve(undefined)
        siblingRelease.resolve(undefined)
        planner.stop()
        await Promise.allSettled(jobs)
        await Promise.allSettled([
          primary,
          owner.resourcesDone,
          sibling.result,
          sibling.resourcesDone,
          ...probes.flatMap(p => [p.error, p.handle.resourcesDone])
        ])
      }
    })
  }
}

for (const site of sites) {
  for (const decision of ['allow', 'deny', 'defer'] as const) {
    for (const stop of [false, true]) {
      test(`Hooks T92 ${site} detached observers return ${decision} explicit stop ${stop}`, async t => {
        const clock = createRuntime(t)
        const entered = deferred<undefined>()
        const trigger = deferred<undefined>()
        const delivered = deferred<undefined>()
        const release = deferred<undefined>()
        const canary = 'T92-private-url-body-value-error-stack-decision'
        const reason = new Error(canary)
        const records: Event[] = []
        const first: number[] = [],
          second: number[] = []
        const children: Handle<string>[] = []
        const outcomes: Promise<unknown>[] = []
        let context: HookContext | undefined
        let snapshot = ''
        let sends = 0
        let hooks = 0
        let cleanups = 0
        let childPrepares = 0
        let returnedReads = 0
        let queuedDuringFanout = -1
        let stoppedDuringFanout = false
        const planner = new FetchPlanner<typeof fetch>(
          () => {
            sends++
            return Promise.resolve(new Response(canary))
          },
          { maxParallelLimit: 1, maxQueuedOperations: 2 }
        )
        const owner = planner.submit({
          method: 'POST',
          replay,
          [site]: async (ctx: HookContext) => {
            hooks++
            context = ctx
            snapshot = JSON.stringify(ctx.snapshot)
            entered.resolve(undefined)
            await trigger.promise
            // Synchronous delivery is raised from an active owning ALS continuation.
            victim.abort(reason)
            await release.promise
            return { type: 'allow' } as const
          },
          prepare: ctx => {
            ctx.onDispose(() => {
              cleanups++
            })
            return { url: canary, init: { body: canary } }
          },
          consume: async (response, ctx) => {
            const value = await response.text()
            if (site === 'beforeRetry' && ctx.attemptNumber === 1)
              throw ctx.retryableReadFailure(reason)
            return value
          }
        })
        const primary = owner.result.catch((error: unknown) => error)
        const victim = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: canary, init: {} }),
          consume: () => canary
        })
        const victimResult = victim.result.catch((error: unknown) => error)
        const returned = Object.defineProperty({}, 'type', {
          get() {
            returnedReads++
            return decision
          }
        })
        // Actual scalar decisions, plus a hostile extra record, stay observation-only.
        const readonlyDecision: Decision =
          decision === 'allow'
            ? { type: 'allow' }
            : decision === 'deny'
              ? { type: 'deny', code: 'POLICY_DENIED' }
              : { type: 'defer', delayMs: 10000 }
        planner.observe(event => {
          records.push(event)
          first.push(event.sequence)
          if (event.id !== victim.id || event.type !== 'operation-settled') return undefined
          for (let i = 0; i < 5; i++) {
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
            outcomes.push(child.result.catch((error: unknown) => error))
          }
          if (stop) {
            planner.stop(reason)
            planner.stop(new Error('later stop'))
          }
          queuedDuringFanout = children[0]?.snapshot().sequence ?? -1
          return readonlyDecision
        })
        planner.observe(event => {
          second.push(event.sequence)
          if (event.id !== victim.id || event.type !== 'operation-settled') return undefined
          stoppedDuringFanout = planner.snapshot().stopped
          delivered.resolve(undefined)
          return returned
        })
        try {
          await entered.promise
          const prior = site === 'beforeRetry' ? 1 : 0
          assert.deepEqual([sends, cleanups], [prior, prior])
          trigger.resolve(undefined)
          await delivered.promise
          assert.equal(children.length, 5)
          // These must fail directly if observer detachment is removed.
          const observedChild = children[0]
          assert.ok(observedChild)
          assert.equal(
            observedChild.id,
            victim.id + 1,
            `T92_OBSERVER_ID ${site} ${observedChild.snapshot().failureCode}`
          )
          assert.equal(
            observedChild.snapshot().failureCode,
            stop ? 'STOPPED' : undefined,
            `T92_OBSERVER_ERROR ${site}`
          )
          assert.deepEqual(
            children.map(child => child.id > 0),
            [true, false, false, false, false]
          )
          for (const child of children.slice(1))
            assert.equal(child.snapshot().failureCode, 'QUEUE_FULL')
          assert.equal(queuedDuringFanout, 0, 'T92_COMMANDS_WAIT_FOR_FULL_FANOUT')
          assert.equal(stoppedDuringFanout, false, 'T92_STOP_COMMAND_COALESCED_AFTER_FANOUT')
          assert.deepEqual(first, second)
          assert.equal(childPrepares, 0)
          assert.deepEqual(
            [planner.snapshot().leasedAttempts, planner.snapshot().sentActive],
            [1, 0]
          )
          assert.equal(owner.snapshot().resources, 'pending')
          assert.ok(context)
          assert.deepEqual(
            Reflect.ownKeys(context).sort(),
            [
              'snapshot',
              'signal',
              'attemptNumber',
              'dispatchCalls',
              ...(prior ? ['status'] : [])
            ].sort()
          )
          assert.deepEqual(
            Reflect.ownKeys(context.snapshot).sort(),
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
              ...(prior ? ['status'] : [])
            ].sort()
          )
          assert.equal(Object.isFrozen(context), true)
          assert.equal(Object.isFrozen(context.snapshot), true)
          assert.notEqual(context.snapshot, owner.snapshot())
          assert.equal(Reflect.set(context, 'dispatchCalls', 999), false)
          assert.equal(Reflect.set(context.snapshot, 'outcome', 'failed'), false)
          assert.ok(context.signal instanceof AbortSignal)
          assert.equal(context.signal.aborted, stop)
          release.resolve(undefined)
          await clock.advance(100)
          const result = await primary
          if (stop) {
            assert.ok(result instanceof OperationError)
            assert.equal(result.code, 'STOPPED')
            assert.equal(result.cause, reason)
          } else {
            assert.ok(typeof result === 'object' && result !== null && 'value' in result)
            assert.equal(result.value, canary, 'T92_OBSERVER_RETURN_CANNOT_DENY_OR_DEFER_COMMIT')
            assert.equal(owner.snapshot().resultCommitted, true)
          }
          await owner.resourcesDone
          const childResults = await Promise.all(outcomes)
          for (const [index, result] of childResults.entries()) {
            if (index === 0 && !stop) {
              assert.ok(typeof result === 'object' && result !== null && 'value' in result)
              assert.equal(result.value, canary)
            } else {
              assert.ok(result instanceof OperationError)
              assert.equal(result.code, index === 0 ? 'STOPPED' : 'QUEUE_FULL')
              if (index === 0) assert.equal(result.cause, reason)
            }
          }
          await Promise.all(children.map(child => child.resourcesDone))
          await victim.resourcesDone
          const victimError = await victimResult
          assert.ok(victimError instanceof OperationError)
          assert.equal(victimError.cause, reason)
          assert.equal(hooks, 1)
          assert.equal(sends, stop ? prior : prior + 2)
          assert.equal(childPrepares, stop ? 0 : 1)
          assert.equal(returnedReads, 0)
          assert.equal(JSON.stringify(context.snapshot), snapshot)
          assert.equal(
            JSON.stringify([records, planner.snapshot(), owner.snapshot()]).includes(canary),
            false
          )
          for (const record of records) {
            assert.equal(Object.isFrozen(record), true)
            for (const [key, value] of Object.entries(record)) {
              assert.ok(['string', 'number', 'boolean', 'undefined'].includes(typeof value), key)
              assert.equal(
                ['signal', 'cause', 'stack', 'url', 'body', 'value', 'decision'].includes(key),
                false
              )
            }
          }
          assert.deepEqual(first, second)
          assert.equal(
            records.filter(event => event.id === owner.id && event.type === 'operation-settled')
              .length,
            1
          )
        } finally {
          trigger.resolve(undefined)
          release.resolve(undefined)
          planner.stop()
          await Promise.allSettled([
            primary,
            owner.resourcesDone,
            victimResult,
            victim.resourcesDone,
            ...outcomes,
            ...children.map(child => child.resourcesDone)
          ])
        }
      })
    }
  }
}
