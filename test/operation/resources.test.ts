import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { CallbackContext } from '../../src/callback-context.js'
import { OperationResources } from '../../src/operation-resources.js'
import { createRuntime, deferred } from './helpers.js'

test('Resources dispose and discard LIFO once even after rejection', async () => {
  const context = new CallbackContext()
  const resources = new OperationResources(context)
  const seen: string[] = []
  const guards: boolean[] = []
  const cause = new Error('cleanup rejected')
  await resources.runOwner(
    'prepare',
    ctx => {
      ctx.onDispose(() => {
        guards.push(context.isActive())
        seen.push('dispose1')
      })
      ctx.onDispose(async () => {
        await Promise.resolve(undefined)
        guards.push(context.isActive())
        seen.push('dispose2')
        throw cause
      })
    },
    value => value
  )
  await resources.runOwner(
    'consume',
    ctx => {
      ctx.onDiscard(() => {
        guards.push(context.isActive())
        seen.push('discard1')
      })
      ctx.onDiscard(() => {
        guards.push(context.isActive())
        seen.push('discard2')
        throw cause
      })
    },
    value => value
  )
  const cleanup = resources.cleanup(true)
  assert.equal(resources.cleanup(false), cleanup)
  assert.deepEqual(await cleanup, { resources: 'failed', errors: [cause, cause] })
  assert.deepEqual(seen, ['discard2', 'discard1', 'dispose2', 'dispose1'])
  assert.deepEqual(guards, [true, true, true, true])
  await resources.cleanup(true)
  assert.equal(seen.length, 4)
})

test('Resources retain partial acquisitions after throw and reject late registrations', async () => {
  const resources = new OperationResources(new CallbackContext())
  const seen: string[] = []
  let register: (fn: () => void) => void = () => {
    throw new Error('not captured')
  }
  const cause = new Error('partial prepare')
  await assert.rejects(
    resources.runOwner(
      'prepare',
      ctx => {
        seen.push('acquire1')
        ctx.onDispose(() => {
          seen.push('dispose1')
        })
        register = ctx.onDispose
        assert.throws(() => {
          ctx.onDiscard(() => undefined)
        }, /INVALID_RESOURCE_REGISTRATION/)
        seen.push('acquire2')
        ctx.onDispose(() => {
          seen.push('dispose2')
        })
        throw cause
      },
      value => value
    ),
    error => error === cause
  )
  assert.throws(() => {
    register(() => undefined)
  }, /INVALID_RESOURCE_REGISTRATION/)
  assert.deepEqual(await resources.cleanup(true), { resources: 'released', errors: [] })
  assert.deepEqual(seen, ['acquire1', 'acquire2', 'dispose2', 'dispose1'])
  await assert.rejects(
    resources.runOwner(
      'prepare',
      () => undefined,
      value => value
    ),
    /INVALID_RESOURCE_OWNER/
  )
})

for (const kind of ['prepare', 'consume'] as const) {
  test(`Resources logical abort waits for pending ${kind} and late acquisition`, async () => {
    const context = new CallbackContext()
    const resources = new OperationResources(context)
    const gate = deferred<undefined>()
    const cleanupGate = deferred<undefined>()
    const cleanupEntered = deferred<undefined>()
    const entered = deferred<undefined>()
    const controller = new AbortController()
    const seen: string[] = []
    const active: boolean[] = []
    let lateRegistration: (() => void) | undefined
    const work = resources.runOwner(
      kind,
      async ctx => {
        lateRegistration = () => {
          ctx.onDispose(() => undefined)
        }
        ctx.onDispose(async () => {
          seen.push('dispose-start')
          active.push(context.isActive())
          cleanupEntered.resolve(undefined)
          await cleanupGate.promise
          active.push(context.isActive())
          seen.push('dispose-return')
        })
        entered.resolve(undefined)
        await gate.promise
        assert.equal(controller.signal.aborted, true)
        active.push(context.isActive())
        ctx.onDispose(() => {
          seen.push('late-dispose')
        })
        if (kind === 'consume')
          ctx.onDiscard(() => {
            seen.push('discard')
          })
        seen.push('owner-return')
        return { url: 'https://example.invalid/' }
      },
      descriptor => ({ url: descriptor.url })
    )
    let cleanup: Promise<unknown> | undefined
    try {
      await entered.promise
      controller.abort()
      cleanup = resources.cleanup(true)
      let settled = false
      void cleanup.then(() => {
        settled = true
      })
      await Promise.resolve(undefined)
      assert.equal(settled, false)
      assert.deepEqual(seen, [])
      assert.throws(() => {
        lateRegistration?.()
      }, /INVALID_RESOURCE_REGISTRATION/)
      gate.resolve(undefined)
      assert.equal((await work).value.url, 'https://example.invalid/')
      await cleanupEntered.promise
      assert.equal(settled, false)
      assert.deepEqual(
        seen,
        kind === 'consume'
          ? ['owner-return', 'discard', 'late-dispose', 'dispose-start']
          : ['owner-return', 'late-dispose', 'dispose-start']
      )
      cleanupGate.resolve(undefined)
      assert.deepEqual(await cleanup, { resources: 'released', errors: [] })
      assert.deepEqual(active, [true, true, true])
      assert.throws(() => {
        lateRegistration?.()
      }, /INVALID_RESOURCE_REGISTRATION/)
    } finally {
      gate.resolve(undefined)
      cleanupGate.resolve(undefined)
      await work
      await cleanup
    }
  })
}

test('Resources keep committed values and skip discard when cleanup fails', async () => {
  const resources = new OperationResources(new CallbackContext())
  const value = { file: 'completed' }
  const cause = new Error('dispose')
  let discards = 0
  const result = await resources.runOwner(
    'consume',
    ctx => {
      ctx.onDiscard(() => {
        discards++
      })
      ctx.onDispose(() => {
        throw cause
      })
      return value
    },
    raw => raw
  )
  assert.deepEqual(await resources.cleanup(false), { resources: 'failed', errors: [cause] })
  assert.equal(result.value, value)
  assert.equal(discards, 0)
})

test('Resources reject invalid callbacks and registrations from inactive descendants', async () => {
  const resources = new OperationResources(new CallbackContext())
  const gate = deferred<undefined>()
  let descendant: Promise<void> = Promise.resolve()
  await resources.runOwner(
    'consume',
    ctx => {
      assert.throws(
        () => Reflect.apply(ctx.onDispose, undefined, [null]),
        /INVALID_RESOURCE_CALLBACK/
      )
      assert.throws(() => Reflect.apply(ctx.onDiscard, undefined, [3]), /INVALID_RESOURCE_CALLBACK/)
      descendant = gate.promise.then(() => {
        assert.throws(() => {
          ctx.onDispose(() => undefined)
        }, /INVALID_RESOURCE_REGISTRATION/)
        assert.throws(() => {
          ctx.onDiscard(() => undefined)
        }, /INVALID_RESOURCE_REGISTRATION/)
      })
    },
    value => value
  )
  try {
    gate.resolve(undefined)
    await descendant
    assert.deepEqual(await resources.cleanup(true), { resources: 'released', errors: [] })
  } finally {
    gate.resolve(undefined)
    await descendant
  }
})

for (const kind of ['prepare', 'consume'] as const) {
  test(`Resources logical timeout retains active ${kind} through external settlement`, async t => {
    const runtime = createRuntime(t)
    const context = new CallbackContext()
    const resources = new OperationResources(context)
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    const timeout = deferred<string>()
    const seen: boolean[] = []
    const timer = setTimeout(() => {
      timeout.resolve('ATTEMPT_TIMEOUT')
    }, 10)
    let disposals = 0
    const work = resources.runOwner(
      kind,
      async ctx => {
        ctx.onDispose(() => {
          disposals++
        })
        entered.resolve(undefined)
        await gate.promise
        seen.push(context.isActive())
        ctx.onDispose(() => {
          disposals++
        })
        return 'late'
      },
      value => value
    )
    const result = Promise.race([work, timeout.promise])
    let cleanup: Promise<unknown> | undefined
    try {
      await entered.promise
      runtime.tick(10)
      assert.equal(await result, 'ATTEMPT_TIMEOUT')
      cleanup = resources.cleanup(true)
      let released = false
      void cleanup.then(() => {
        released = true
      })
      await runtime.flush()
      assert.equal(released, false)
      assert.equal(disposals, 0)
      gate.resolve(undefined)
      assert.equal((await work).value, 'late')
      assert.deepEqual(await cleanup, { resources: 'released', errors: [] })
      assert.deepEqual(seen, [true])
      assert.equal(disposals, 2)
    } finally {
      clearTimeout(timer)
      gate.resolve(undefined)
      await work
      await cleanup
    }
  })
}

for (const discard of [false, true]) {
  for (const pendingOwner of [false, true]) {
    for (const reject of [false, true]) {
      test(`Resources reentrant ${discard ? 'discard' : 'dispose'} cleanup shares barrier with ${pendingOwner ? 'pending' : 'returned'} owner and ${reject ? 'rejection' : 'success'}`, async () => {
        const context = new CallbackContext()
        const resources = new OperationResources(context)
        const ownerGate = deferred<undefined>()
        const callbackGate = deferred<undefined>()
        const entered = deferred<undefined>()
        const cause = new Error('pending cleanup rejected')
        const events: string[] = []
        const guards: boolean[] = []
        let nested: ReturnType<OperationResources['cleanup']> | undefined
        let nestedSettlements = 0
        let settlements = 0
        let live = 0
        let maxLive = 0
        let olderCalls = 0
        let newerCalls = 0
        const owner = resources.runOwner(
          'consume',
          async ctx => {
            const register = discard ? ctx.onDiscard : ctx.onDispose
            register(() => {
              olderCalls++
              live++
              maxLive = Math.max(maxLive, live)
              guards.push(context.isActive())
              events.push('older')
              live--
            })
            register(async () => {
              newerCalls++
              live++
              maxLive = Math.max(maxLive, live)
              guards.push(context.isActive())
              events.push('newer-start')
              // Observe the same barrier without awaiting our own completion.
              nested = resources.cleanup(!discard)
              void nested.then(() => {
                nestedSettlements++
              })
              entered.resolve(undefined)
              try {
                await callbackGate.promise
                guards.push(context.isActive())
                events.push('newer-return')
                if (reject) throw cause
              } finally {
                live--
              }
            })
            await ownerGate.promise
          },
          value => value
        )
        if (!pendingOwner) ownerGate.resolve(undefined)
        let work: ReturnType<OperationResources['cleanup']> | undefined
        try {
          if (!pendingOwner) await owner
          work = resources.cleanup(discard)
          void work.then(() => {
            settlements++
          })
          assert.equal(resources.cleanup(!discard), work)
          if (pendingOwner) {
            await setImmediate()
            assert.equal(settlements, 0)
            assert.equal(newerCalls, 0)
            assert.equal(olderCalls, 0)
            ownerGate.resolve(undefined)
          }
          await owner
          await entered.promise
          await setImmediate()
          assert.equal(nestedSettlements, 0, 'nested cleanup must wait for the pending callback')
          assert.equal(settlements, 0)
          assert.equal(nested, work, 'every cleanup caller must receive the same Promise')
          assert.equal(resources.cleanup(discard), work)
          assert.deepEqual(events, ['newer-start'], 'older callback must wait for newer settlement')
          assert.equal(newerCalls, 1)
          assert.equal(olderCalls, 0)
          assert.equal(live, 1)
          assert.equal(maxLive, 1)
          callbackGate.resolve(undefined)
          const summary = await work
          assert.deepEqual(summary, {
            resources: reject ? 'failed' : 'released',
            errors: reject ? [cause] : []
          })
          if (reject) assert.equal(summary.errors[0], cause)
          assert.equal(await nested, summary)
          assert.equal(await resources.cleanup(!discard), summary)
          assert.equal(resources.cleanup(discard), work)
          assert.deepEqual(events, ['newer-start', 'newer-return', 'older'])
          assert.deepEqual(guards, [true, true, true])
          assert.equal(newerCalls, 1)
          assert.equal(olderCalls, 1)
          assert.equal(live, 0)
          assert.equal(maxLive, 1)
          assert.equal(settlements, 1)
          assert.equal(nestedSettlements, 1)
        } finally {
          ownerGate.resolve(undefined)
          callbackGate.resolve(undefined)
          await owner
          await work
          await nested
        }
      })
    }
  }
}
