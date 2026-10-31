import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici'
import { OperationError, type Decision, type HookContext } from '../../src/operation-types.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const replay = { serverSafe: true, consumeSafe: true }

for (const kind of ['allow', 'deny', 'throw', 'reject', 'invalid'] as const) {
  test(`Before dispatch ${kind} controls actual transport without replay`, async t => {
    createRuntime(t)
    let prepares = 0
    let calls = 0
    let hooks = 0
    let disposals = 0
    const cause = new Error('private hook failure')
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response('complete'))
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        prepares++
        ctx.onDispose(() => {
          disposals++
        })
        return { url: '', init: { body: 'payload' } }
      },
      beforeDispatch: () => {
        hooks++
        assert.equal(prepares, 1)
        assert.equal(calls, 0)
        if (kind === 'throw') throw cause
        if (kind === 'reject') return Promise.reject(cause)
        if (kind === 'invalid') return { type: 'allow', extra: true }
        if (kind === 'deny') return { type: 'deny', code: 'POLICY_DENIED' }
        return { type: 'allow' }
      },
      consume: response => response.text()
    })
    await Promise.allSettled([handle.result])
    assert.equal(calls, kind === 'allow' ? 1 : 0, 'HOOK_DECISION_CONTROLS_ACTUAL_CALLS')
    if (kind === 'allow') assert.equal((await handle.result).value, 'complete')
    else {
      await assert.rejects(handle.result, error => {
        assert.ok(error instanceof OperationError)
        assert.equal(error.code, kind === 'deny' ? 'HOOK_DENIED' : 'HOOK_FAILED')
        assert.equal(error.dispatchEntered, false)
        if (kind === 'deny') assert.equal(error.cause, 'POLICY_DENIED')
        return true
      })
    }
    await handle.resourcesDone
    assert.equal(calls, kind === 'allow' ? 1 : 0)
    assert.equal(prepares, 1)
    assert.equal(hooks, 1)
    assert.equal(disposals, 1)
    assert.equal(planner.snapshot().leasedAttempts, 0)
  })
}

for (const failure of ['prepare', 'descriptor', 'init'] as const) {
  test(`Before dispatch requires successful guarded ${failure}`, async () => {
    let hooks = 0
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response())
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => {
        if (failure === 'prepare') throw new Error('prepare')
        return {
          get url() {
            if (failure === 'descriptor') throw new Error('descriptor')
            return ''
          },
          init: {
            get body(): string {
              throw new Error('init')
            }
          }
        }
      },
      beforeDispatch: () => {
        hooks++
        return { type: 'allow' }
      },
      consume: () => 1
    })
    await assert.rejects(handle.result, { code: 'PREPARE_FAILED' })
    await handle.resourcesDone
    assert.equal(hooks, 0)
    assert.equal(calls, 0)
  })
}

for (const mode of ['timeout', 'abort', 'stop', 'deadline', 'attempt'] as const) {
  test(`Before dispatch pending ${mode} retains physical lease until settlement`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const gate = deferred<Decision>()
    const entered = deferred<HookContext>()
    let prepares = 0
    let calls = 0
    let hooks = 0
    let nextPrepares = 0
    let disposals = 0
    let resourcesSettled = false
    let settlements = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        calls++
        return Promise.resolve(new Response())
      },
      {
        maxParallelLimit: 1,
        deadlineMs: mode === 'deadline' ? 800 : 120000,
        attemptTimeoutMs: mode === 'attempt' ? 800 : 30000
      }
    )
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        prepares++
        ctx.onDispose(() => {
          disposals++
        })
        return { url: '', init: {} }
      },
      beforeDispatch: async ctx => {
        hooks++
        entered.resolve(ctx)
        return await gate.promise
      },
      consume: () => 1
    })
    handle.observe(event => {
      if (event.type === 'operation-settled') settlements++
    })
    void handle.resourcesDone.then(() => {
      resourcesSettled = true
    })
    const next = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        nextPrepares++
        return { url: '', init: {} }
      },
      consume: () => 2
    })
    try {
      const context = await entered.promise
      assert.equal(timers.delays.at(-1), mode === 'deadline' || mode === 'attempt' ? 800 : 1000)
      if (mode === 'abort') handle.abort()
      else if (mode === 'stop') planner.stop()
      else {
        await clock.advance(mode === 'timeout' ? 999 : 799)
        assert.equal(handle.snapshot().outcome, 'pending')
        assert.equal(context.signal.aborted, false)
        await clock.advance(1)
      }
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
      await assert.rejects(handle.result, { code, dispatchEntered: false })
      await clock.flush()
      assert.equal(context.signal.aborted, true)
      assert.equal(prepares, 1)
      assert.equal(hooks, 1)
      assert.equal(calls, 0)
      assert.equal(resourcesSettled, false)
      assert.equal(handle.snapshot().resources, 'pending')
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 0)
      assert.equal(nextPrepares, 0)
      const before = handle.snapshot()
      gate.resolve({ type: 'allow' })
      await handle.resourcesDone
      if (mode === 'stop' || mode === 'deadline')
        await assert.rejects(next.result, { code: mode === 'stop' ? 'STOPPED' : 'DEADLINE' })
      else assert.equal((await next.result).value, 2)
      await next.resourcesDone
      assert.equal(handle.snapshot().failureCode, before.failureCode)
      assert.equal(handle.snapshot().dispatchCalls, 0)
      assert.equal(disposals, 1)
      assert.equal(settlements, 1)
      assert.equal(nextPrepares, mode === 'stop' || mode === 'deadline' ? 0 : 1)
      assert.equal(calls, nextPrepares)
      assert.equal(planner.snapshot().leasedAttempts, 0)
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
    } finally {
      gate.resolve({ type: 'allow' })
      handle.abort()
      next.abort()
      await Promise.allSettled([
        handle.result,
        handle.resourcesDone,
        next.result,
        next.resourcesDone
      ])
    }
  })
}

for (const kind of ['allow', 'reject'] as const) {
  test(`Before dispatch ${kind} continuation checks absolute expiry without timer delivery`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<Decision>()
    const entered = deferred<HookContext>()
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response())
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      beforeDispatch: ctx => {
        entered.resolve(ctx)
        return gate.promise
      },
      consume: () => 1
    })
    try {
      const context = await entered.promise
      const now = performance.now()
      t.mock.method(performance, 'now', () => now + 1000)
      if (kind === 'allow') gate.resolve({ type: 'allow' })
      else gate.reject(new Error('late rejection'))
      await assert.rejects(handle.result, { code: 'HOOK_FAILED' })
      await handle.resourcesDone
      await clock.flush()
      assert.equal(context.signal.aborted, true)
      assert.equal(calls, 0)
    } finally {
      gate.resolve({ type: 'allow' })
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Before dispatch actual decision extraction keeps the owning reentry guard', async () => {
  const nested: Promise<unknown>[] = []
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()))
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    beforeDispatch: () => ({
      get type() {
        const child = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: '', init: {} }),
          consume: () => 2
        })
        nested.push(assert.rejects(child.result, { code: 'REENTRANT_OPERATION' }))
        return 'allow' as const
      }
    }),
    consume: () => 1
  })
  assert.equal((await handle.result).value, 1)
  await handle.resourcesDone
  await Promise.all(nested)
  assert.equal(nested.length, 1)
})

test('Before dispatch finite strict child exits naturally after physical hook release', () => {
  const module = new URL('../../src/planner.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import { FetchPlanner } from ${JSON.stringify(module)}
    const watchdog = setTimeout(() => { throw new Error('hook child leaked work') }, 3000)
    let release, entered
    const gate = new Promise(resolve => { release = resolve })
    const ready = new Promise(resolve => { entered = resolve })
    let calls = 0, prepares = 0, context
    const planner = new FetchPlanner(() => { calls++; return Promise.resolve(new Response()) }, {maxParallelLimit:1})
    const replay = {serverSafe:true,consumeSafe:true}
    const handle = planner.submit({method:'POST',replay,prepare:() => {prepares++; return {url:'',init:{}}},beforeDispatch:async ctx => {context=ctx; entered(); return await gate},consume:() => 1})
    try {
      await ready
      await assert.rejects(handle.result,{code:'HOOK_FAILED'})
      assert.equal(context.signal.aborted,true)
      assert.equal(prepares,1)
      assert.equal(calls,0)
      assert.equal(planner.snapshot().leasedAttempts,1)
      release({type:'allow'})
      await handle.resourcesDone
      assert.equal(planner.snapshot().leasedAttempts,0)
      assert.equal(calls,0)
      console.log('PASS physical hook release, natural exit')
    } finally {
      release({type:'allow'}); handle.abort()
      await Promise.allSettled([handle.result,handle.resourcesDone])
      clearTimeout(watchdog)
    }
  `
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '--eval', source],
    { encoding: 'utf8', timeout: 5000 }
  )
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.equal(child.signal, null)
  assert.match(child.stdout, /PASS physical hook release, natural exit/)
})

test('Before dispatch runs once for each fresh retry attempt', async t => {
  const clock = createRuntime(t)
  const attempts: number[] = []
  const dispatches: number[] = []
  let prepares = 0
  let calls = 0
  const planner = new FetchPlanner<typeof fetch>(() => {
    calls++
    return Promise.resolve(new Response(null, { status: calls === 1 ? 429 : 200 }))
  })
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => {
      prepares++
      return { url: '', init: { body: 'same payload' } }
    },
    beforeDispatch: ctx => {
      attempts.push(ctx.attemptNumber)
      dispatches.push(ctx.dispatchCalls)
      assert.equal(prepares, ctx.attemptNumber)
      return { type: 'allow' }
    },
    consume: () => 'complete'
  })
  try {
    await clock.flush()
    assert.equal(handle.snapshot().phase, 'retry-wait')
    assert.deepEqual(attempts, [1])
    await clock.advance(2999)
    assert.equal(calls, 1)
    assert.deepEqual(attempts, [1])
    await clock.advance(1)
    assert.equal((await handle.result).value, 'complete')
    await handle.resourcesDone
    assert.equal(prepares, 2)
    assert.equal(calls, 2)
    assert.deepEqual(attempts, [1, 2])
    assert.deepEqual(dispatches, [0, 1])
  } finally {
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Before dispatch synchronously blocking hook cannot outlive its absolute budget', async t => {
  createRuntime(t)
  let calls = 0
  let signal: AbortSignal | undefined
  const planner = new FetchPlanner<typeof fetch>(() => {
    calls++
    return Promise.resolve(new Response())
  })
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    beforeDispatch: ctx => {
      signal = ctx.signal
      const now = performance.now()
      t.mock.method(performance, 'now', () => now + 1000)
      return { type: 'allow' }
    },
    consume: () => 1
  })
  await assert.rejects(handle.result, { code: 'HOOK_FAILED', dispatchEntered: false })
  await handle.resourcesDone
  assert.equal(signal?.aborted, true)
  assert.equal(calls, 0)
})

for (const delayMs of [1, 1500]) {
  test(`Before dispatch defer ${delayMs} waits once on the sole coordinator timer`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const start = performance.now()
    const sends: number[] = []
    let hooks = 0
    let disposals = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      sends.push(performance.now())
      return Promise.resolve(new Response())
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        ctx.onDispose(() => {
          disposals++
        })
        return { url: '', init: {} }
      },
      beforeDispatch: () => {
        hooks++
        return { type: 'defer', delayMs }
      },
      consume: () => 1
    })
    try {
      await clock.flush()
      assert.deepEqual(sends, [], 'DEFER_FLOOR_PREVENTS_ACTUAL_TRANSPORT')
      assert.equal(handle.snapshot().phase, 'ready')
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 0)
      // Re-deliver stale wakes: they cannot restart the callback or move the floor.
      for (let i = 0; i < 3; i++) {
        timers.callbacks.at(-1)?.()
        await clock.flush()
      }
      clock.jumpWall(-9000000)
      await clock.advance(delayMs - 1)
      assert.deepEqual(sends, [], 'DEFER_FLOOR_PREVENTS_ACTUAL_TRANSPORT')
      assert.equal(hooks, 1)
      await clock.advance(1)
      assert.equal((await handle.result).value, 1)
      await handle.resourcesDone
      assert.deepEqual(sends, [start + delayMs], 'FLOOR_RELEASE_REACHES_ACTUAL_TRANSPORT')
      assert.equal(handle.snapshot().attempts, 1)
      assert.equal(hooks, 1)
      assert.equal(disposals, 1)
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const delayMs of [
  NaN,
  Infinity,
  -1,
  0,
  0.5,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER
]) {
  test(`Before dispatch invalid defer ${delayMs} fails without transport`, async t => {
    createRuntime(t)
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response())
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      beforeDispatch: () => ({ type: 'defer', delayMs }),
      consume: () => 1
    })
    await assert.rejects(handle.result, { code: 'HOOK_FAILED', dispatchEntered: false })
    await handle.resourcesDone
    assert.equal(calls, 0)
    assert.equal(handle.snapshot().attempts, 1)
  })
}

for (const budget of ['deadline', 'attempt'] as const) {
  test(`Before dispatch defer preserves the original ${budget} budget`, async t => {
    const clock = createRuntime(t)
    const hook = deferred<Decision>()
    let calls = 0
    let hooks = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        calls++
        return Promise.resolve(new Response())
      },
      {
        deadlineMs: budget === 'deadline' ? 800 : 10000,
        attemptTimeoutMs: budget === 'attempt' ? 800 : 9000
      }
    )
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      beforeDispatch: () => {
        hooks++
        return hook.promise
      },
      consume: () => 1
    })
    try {
      await clock.flush()
      await clock.advance(500)
      hook.resolve({ type: 'defer', delayMs: 1500 })
      await clock.flush()
      await clock.advance(299)
      assert.equal(handle.snapshot().outcome, 'pending')
      await clock.advance(1)
      await assert.rejects(handle.result, {
        code: budget === 'deadline' ? 'DEADLINE' : 'ATTEMPT_TIMEOUT'
      })
      await handle.resourcesDone
      await clock.advance(2000)
      assert.equal(calls, 0)
      assert.equal(hooks, 1)
      assert.equal(handle.snapshot().attempts, 1)
    } finally {
      hook.resolve({ type: 'allow' })
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const phase of ['hook', 'floor'] as const) {
  for (const safety of [
    'stop',
    'abort',
    'deadline',
    'pause',
    'pacing',
    'effective',
    'guard'
  ] as const) {
    test(`Before dispatch ${phase} rechecks real ${safety} input`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const receipt = deferred<Response>()
      const hook = deferred<Decision>()
      const disposal = deferred<undefined>()
      let sends = 0
      let hooks = 0
      const planner = new FetchPlanner<typeof fetch>(
        () => {
          sends++
          return sends === 1 ? receipt.promise : Promise.resolve(new Response())
        },
        {
          maxParallelLimit: 2,
          errorPerMinuteLimit: safety === 'guard' ? 1 : 100,
          jitter: 0,
          throttlingCoefficient: 1,
          maxRequestDelayTimeMs: 200
        }
      )
      const peer = planner.submit({
        method: 'GET',
        replay: { serverSafe: false, consumeSafe: false },
        prepare: ctx => {
          if (safety === 'effective') ctx.onDispose(() => disposal.promise)
          return { url: '', init: {} }
        },
        consume: () => 1
      })
      const handle = planner.submit({
        method: 'POST',
        replay,
        ...(safety === 'deadline' ? { deadlineMs: 40 } : {}),
        prepare: () => ({ url: '', init: {} }),
        beforeDispatch: () => {
          hooks++
          return phase === 'hook' ? hook.promise : { type: 'defer', delayMs: 50 }
        },
        consume: () => 2
      })
      try {
        await clock.flush()
        assert.equal(sends, 1)
        assert.equal(hooks, 1)
        if (safety === 'stop') planner.stop()
        if (safety === 'abort') handle.abort()
        if (safety === 'deadline') await clock.advance(40)
        if (safety === 'pause')
          receipt.resolve(new Response(null, { headers: { 'x-lognex-retry-after': '200' } }))
        if (safety === 'pacing')
          receipt.resolve(
            new Response(null, {
              headers: {
                'x-ratelimit-limit': '10',
                'x-ratelimit-remaining': '0',
                'x-lognex-retry-timeinterval': '1000'
              }
            })
          )
        if (safety === 'effective')
          receipt.resolve(
            new Response('{"errors":[{"code":1073}]}', {
              status: 429,
              headers: { 'content-type': 'application/json' }
            })
          )
        if (safety === 'guard') receipt.resolve(new Response(null, { status: 500 }))
        await clock.flush()
        if (safety === 'effective') assert.equal(planner.snapshot().effectiveParallelism, 1)
        hook.resolve({ type: 'defer', delayMs: 50 })
        await clock.flush()
        await clock.advance(50)
        assert.equal(sends, 1, 'CHANGED_SAFETY_PREVENTS_TARGET_TRANSPORT')
        const terminal =
          safety === 'stop' || safety === 'abort' || safety === 'deadline' || safety === 'guard'
        if (terminal) {
          await assert.rejects(handle.result, {
            code:
              safety === 'stop'
                ? 'STOPPED'
                : safety === 'abort'
                  ? 'ABORTED'
                  : safety === 'deadline'
                    ? 'DEADLINE'
                    : 'GUARD_OPEN'
          })
          await handle.resourcesDone
          await clock.advance(500)
          assert.equal(sends, 1, 'TERMINAL_DEFER_CANNOT_RESURRECT')
        } else {
          if (safety === 'effective') {
            assert.equal(planner.snapshot().sentActive, 1, 'KNOWN_CLEANUP_RETAINS_SENT_TOKEN')
            disposal.resolve(undefined)
            await peer.resourcesDone
            await clock.flush()
          } else {
            await clock.advance(149)
            assert.equal(sends, 1)
            await clock.advance(1)
          }
          assert.equal(sends, 2, 'SAFETY_RELEASE_REACHES_ACTUAL_TRANSPORT')
          assert.equal((await handle.result).value, 2)
          await handle.resourcesDone
        }
        assert.equal(hooks, 1)
        assert.equal(handle.snapshot().attempts, 1)
      } finally {
        receipt.resolve(new Response())
        hook.resolve({ type: 'allow' })
        disposal.resolve(undefined)
        handle.abort()
        peer.abort()
        await Promise.allSettled([
          handle.result,
          handle.resourcesDone,
          peer.result,
          peer.resourcesDone
        ])
        await clock.flush()
        assert.equal(planner.snapshot().leasedAttempts, 0)
        assert.equal(planner.snapshot().sentActive, 0)
        assert.equal(timers.active.size, 0)
        assert.ok(timers.maximum() <= 1)
      }
    })
  }
}

for (const [entry, Constructor] of [
  ['deep', FetchPlanner],
  ['root', RootPlanner]
] as const) {
  for (const family of ['native', 'undici'] as const) {
    test(`Before dispatch ${entry} ${family} per-attempt floor leaves eligible peers runnable`, async t => {
      const clock = createRuntime(t)
      let sends = 0
      const transport = () => {
        sends++
        return Promise.resolve(new Response('native'))
      }
      const undiciTransport = () => {
        sends++
        return Promise.resolve(new UndiciResponse('undici'))
      }
      const planner =
        family === 'native'
          ? new Constructor<typeof fetch>(transport, { maxParallelLimit: 2 })
          : new Constructor<typeof undiciFetch>(undiciTransport, { maxParallelLimit: 2 })
      let hooks = 0
      const handle = planner.submit({
        method: 'POST',
        replay,
        prepare: () => ({ url: '', init: {} }),
        beforeDispatch: () => {
          hooks++
          return { type: 'defer', delayMs: 20 }
        },
        consume: response => response.text()
      })
      const peer = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: '', init: {} }),
        consume: response => response.text()
      })
      try {
        assert.equal((await peer.result).value, family)
        await peer.resourcesDone
        assert.equal(sends, 1, 'PEER_DOES_NOT_INHERIT_HOOK_FLOOR')
        await clock.advance(19)
        assert.equal(sends, 1)
        await clock.advance(1)
        assert.equal((await handle.result).value, family)
        await handle.resourcesDone
        assert.equal(sends, 2)
        assert.equal(hooks, 1)
      } finally {
        handle.abort()
        peer.abort()
        await Promise.allSettled([
          handle.result,
          handle.resourcesDone,
          peer.result,
          peer.resourcesDone
        ])
      }
    })
  }
}
