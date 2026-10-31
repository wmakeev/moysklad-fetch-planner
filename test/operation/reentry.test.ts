import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import type { Handle, Init, Spec } from '../../src/operation-types.js'
import { ObservationDiagnostics } from '../../src/operation-observation.js'
import { createRuntime, deferred } from './helpers.js'

const replay = { serverSafe: false, consumeSafe: false }
const simple = {
  method: 'GET',
  replay,
  prepare: () => ({ url: '', init: {} }),
  consume: () => 'nested'
} satisfies Spec<Init<typeof fetch>, Response, string>

// Deliberately hostile property descriptors preserve strict consumer signatures.
// The first reads conceal a thenable; later reads reveal pending recursive work.
function adversary<T>(final: T, subclass: boolean, inspect: (step: string) => void) {
  const gate = deferred<undefined>()
  const entered = deferred<undefined>()
  const late = deferred<undefined>()
  let descendant = Promise.resolve()
  let reads = 0
  function link(depth: number): T | PromiseLike<T> {
    if (!depth) return final
    const typed: PromiseLike<T> = {
      then: (fulfilled, rejected) => Promise.resolve(final).then(fulfilled, rejected)
    }
    return Object.defineProperty(typed, 'then', {
      get() {
        inspect(`link-get-${depth}`)
        return (resolve: (value: T | PromiseLike<T>) => void) => {
          inspect(`link-resolve-${depth}`)
          resolve(link(depth - 1))
        }
      }
    })
  }
  const typed: PromiseLike<T> = {
    then: (fulfilled, rejected) => Promise.resolve(final).then(fulfilled, rejected)
  }
  const decision = Object.defineProperty(typed, 'then', {
    get() {
      inspect(`stateful-get-${++reads}`)
      if (reads !== (subclass ? 3 : 2)) return undefined
      return (resolve: (value: T | PromiseLike<T>) => void) => {
        inspect('pending-then')
        descendant = late.promise.then(() => {
          inspect('inactive-descendant')
        })
        entered.resolve(undefined)
        void gate.promise.then(() => {
          inspect('pending-release')
          resolve(link(12))
        })
      }
    }
  })
  class OwnerPromise extends Promise<T> {
    override then<A = T, B = never>(
      fulfilled?: ((value: T) => A | PromiseLike<A>) | null,
      rejected?: ((reason: unknown) => B | PromiseLike<B>) | null
    ): Promise<A | B> {
      inspect('subclass-then')
      return super.then(fulfilled, rejected)
    }
  }
  const callback = () => {
    inspect('callback')
    void Promise.resolve().then(() => {
      inspect('active-fire-and-forget')
    })
    return subclass
      ? new OwnerPromise(resolve => {
          resolve(decision)
        })
      : new Promise<T>(resolve => {
          resolve(decision)
        })
  }
  return { callback, gate, entered, late, descendant: () => descendant }
}

for (const [entry, Planner] of [
  ['root', RootPlanner],
  ['deep', DeepPlanner]
] as const) {
  for (const site of ['prepare', 'consume', 'dispose', 'discard'] as const) {
    for (const subclass of [false, true]) {
      test(`Reentry ${entry} ${site} ${subclass ? 'subclass' : 'thenable'} full lifetime`, async t => {
        const clock = createRuntime(t)
        const diagnostics = t.mock.method(ObservationDiagnostics.prototype, 'increment')
        const planner = new Planner<typeof fetch>(() => Promise.resolve(new Response()), {
          maxParallelLimit: 1,
          maxQueuedOperations: 1,
          deadlineMs: 100,
          attemptTimeoutMs: 200
        })
        const probes: { step: string; handle: Handle<string>; before: number; after: number }[] = []
        let specReads = 0
        const inspect = (step: string) => {
          const before = planner.snapshot().queued
          const handle = planner.submit({
            ...simple,
            get prepare() {
              specReads++
              return simple.prepare
            }
          })
          probes.push({ step, handle, before, after: planner.snapshot().queued })
        }
        const descriptor = {
          get url() {
            inspect('descriptor-url')
            return ''
          },
          get init() {
            inspect('descriptor-init')
            return {
              get headers() {
                inspect('init-headers')
                return {}
              }
            }
          }
        }
        const prepare = adversary(descriptor, subclass, inspect)
        const consume = adversary(
          {
            get then() {
              inspect('consume-value-then')
              return undefined
            }
          },
          subclass,
          inspect
        )
        const cleanup = adversary(undefined, subclass, inspect)
        const attack = site === 'prepare' ? prepare : site === 'consume' ? consume : cleanup
        let calls = 0
        const owner = planner.submit<unknown>({
          ...simple,
          prepare: ctx => {
            if (site === 'dispose')
              ctx.onDispose(() => {
                calls++
                return cleanup.callback()
              })
            return site === 'prepare' ? prepare.callback() : { url: '', init: {} }
          },
          consume: (_response, ctx) => {
            if (site === 'discard') {
              ctx.onDiscard(() => {
                calls++
                return cleanup.callback()
              })
              throw new Error('discard trigger')
            }
            return site === 'consume' ? consume.callback() : 'value'
          }
        })
        let nextPrepares = 0
        let next: Handle<string> | undefined
        const verifyActive = () => {
          for (const probe of probes) {
            if (probe.step === 'inactive-descendant') continue
            assert.equal(probe.handle.snapshot().failureCode, 'REENTRANT_OPERATION', probe.step)
            assert.equal(probe.handle.id, 0, probe.step)
            assert.equal(probe.after, probe.before, 'NO_SPEC_RESERVATION')
          }
          assert.equal(specReads, 0, 'NO_SPEC_READ_BEFORE_REENTRY_REJECTION')
        }
        try {
          await attack.entered.promise
          await clock.flush()
          verifyActive()
          assert.equal(owner.snapshot().resources, 'pending')
          assert.equal(planner.snapshot().leasedAttempts, 1)
          // Exercise abort and deadline across both owner and cleanup sites.
          if (subclass) await clock.advance(100)
          else owner.abort()
          await clock.flush()
          if (site === 'dispose') {
            assert.equal((await owner.result).cleanup, 'pending')
          } else {
            await assert.rejects(owner.result, {
              code: site === 'discard' ? 'CONSUME_FAILED' : subclass ? 'DEADLINE' : 'ABORTED'
            })
          }
          verifyActive()
          assert.equal(owner.snapshot().resources, 'pending')
          assert.equal(planner.snapshot().leasedAttempts, 1)
          assert.equal(planner.snapshot().sentActive, site === 'prepare' ? 0 : 1)
          next = planner.submit({
            ...simple,
            prepare: () => {
              nextPrepares++
              return { url: '', init: {} }
            }
          })
          await clock.flush()
          assert.equal(nextPrepares, 0, 'OWNER_BARRIER_RETAINS_LEASE')
          attack.gate.resolve(undefined)
          await owner.resourcesDone
          verifyActive()
          assert.equal(probes.filter(p => p.step.startsWith('link-resolve-')).length, 12)
          if (site === 'prepare') assert.ok(probes.some(p => p.step === 'init-headers'))
          assert.equal(calls, site === 'dispose' || site === 'discard' ? 1 : 0)
          await next.result
          await next.resourcesDone
          attack.late.resolve(undefined)
          await attack.descendant()
          const late = probes.at(-1)
          assert.ok(late)
          assert.equal(late.step, 'inactive-descendant')
          assert.equal(late.handle.id, 3, 'REJECTED_PROBES_DO_NOT_ALLOCATE_IDS')
          assert.equal((await late.handle.result).value, 'nested')
          await late.handle.resourcesDone
          assert.equal(specReads, 1)
          assert.equal(
            diagnostics.mock.calls.filter(call => call.arguments[0] === 'OBSERVER_FAILED').length,
            0
          )
          assert.equal(planner.snapshot().leasedAttempts, 0)
        } finally {
          for (const item of [prepare, consume, cleanup]) {
            item.gate.resolve(undefined)
            item.late.resolve(undefined)
          }
          planner.stop()
          await Promise.allSettled([
            owner.result,
            owner.resourcesDone,
            next?.result,
            next?.resourcesDone,
            ...probes.flatMap(p => [p.handle.result, p.handle.resourcesDone])
          ])
          await attack.descendant()
        }
      })
    }
  }
}

for (const scope of ['planner', 'handle'] as const) {
  test(`Reentry ${scope} observer detaches synchronous and asynchronous descendants from active owner`, async t => {
    const clock = createRuntime(t)
    const diagnostics = t.mock.method(ObservationDiagnostics.prototype, 'increment')
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    const observerGate = deferred<undefined>()
    const planner = new RootPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
      maxParallelLimit: 1,
      maxQueuedOperations: 4
    })
    const nested: Handle<string>[] = []
    const guarded: Handle<string>[] = []
    const a: number[] = [],
      b: number[] = []
    let observerWork = Promise.resolve()
    let queuedInside = 0
    const owner = planner.submit({
      ...simple,
      prepare: async () => {
        entered.resolve(undefined)
        await gate.promise
        owner.abort()
        guarded.push(planner.submit(simple))
        await observerGate.promise
        guarded.push(planner.submit(simple))
        return { url: '', init: {} }
      }
    })
    const observed = scope === 'planner' ? planner : owner
    observed.observe(event => {
      a.push(event.sequence)
      if (event.id !== owner.id || event.type !== 'operation-settled') return
      nested.push(planner.submit(simple))
      queuedInside = nested[0]?.snapshot().sequence ?? -1
      observerWork = Promise.resolve().then(() => {
        nested.push(planner.submit(simple))
        observerGate.resolve(undefined)
      })
    })
    observed.observe(event => {
      b.push(event.sequence)
    })
    try {
      await entered.promise
      gate.resolve(undefined)
      await observerWork
      await owner.resourcesDone
      await clock.flush()
      await observerWork
      assert.equal(nested.length, 2)
      assert.equal(queuedInside, 0, 'OBSERVER_SUBMIT_USES_DEFERRED_COMMAND')
      assert.deepEqual(a, b, 'FULL_FANOUT_BEFORE_COMMANDS')
      assert.equal(diagnostics.mock.calls.length, 0)
      assert.deepEqual(
        nested.map(h => h.id),
        [2, 3]
      )
      assert.deepEqual(
        guarded.map(h => h.snapshot().failureCode),
        ['REENTRANT_OPERATION', 'REENTRANT_OPERATION']
      )
      for (const handle of nested) {
        assert.equal((await handle.result).value, 'nested')
        await handle.resourcesDone
      }
    } finally {
      gate.resolve(undefined)
      observerGate.resolve(undefined)
      planner.stop()
      await observerWork
      await Promise.allSettled([
        owner.result,
        owner.resourcesDone,
        ...nested.flatMap(h => [h.result, h.resourcesDone])
      ])
    }
  })
}

for (const site of ['prepare', 'consume', 'dispose', 'discard'] as const) {
  test(`Reentry ${site} retains active lifetime after stop`, async t => {
    const clock = createRuntime(t)
    const planner = new DeepPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
      maxParallelLimit: 1
    })
    const probes: Handle<string>[] = []
    const attack = adversary({ url: '', init: {} }, false, () => {
      probes.push(planner.submit(simple))
    })
    const cleanupAttack = adversary(undefined, false, () => {
      probes.push(planner.submit(simple))
    })
    const active = site === 'dispose' || site === 'discard' ? cleanupAttack : attack
    const owner = planner.submit<unknown>({
      ...simple,
      prepare: ctx => {
        if (site === 'dispose') ctx.onDispose(cleanupAttack.callback)
        return site === 'prepare' ? attack.callback() : { url: '', init: {} }
      },
      consume: (_response, ctx) => {
        if (site === 'discard') {
          ctx.onDiscard(cleanupAttack.callback)
          throw new Error('discard trigger')
        }
        return site === 'consume' ? attack.callback() : 'done'
      }
    })
    try {
      await active.entered.promise
      planner.stop()
      await clock.flush()
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(owner.snapshot().resources, 'pending')
      active.gate.resolve(undefined)
      await owner.resourcesDone
      assert.ok(probes.length >= 28)
      assert.ok(
        probes.every(h => h.id === 0 && h.snapshot().failureCode === 'REENTRANT_OPERATION'),
        'STOP_DOES_NOT_RELEASE_OWNER_TOKEN'
      )
      assert.equal(planner.snapshot().leasedAttempts, 0)
    } finally {
      for (const item of [attack, cleanupAttack]) {
        item.gate.resolve(undefined)
        item.late.resolve(undefined)
      }
      planner.stop()
      await Promise.allSettled([owner.result, owner.resourcesDone])
      await active.descendant()
    }
  })
}
