import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { OperationError, type Decision, type HookContext } from '../../src/operation-types.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const replay = { serverSafe: true, consumeSafe: true }

for (const kind of ['allow', 'deny', 'throw', 'reject', 'invalid', 'defer'] as const) {
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
        if (kind === 'defer') return { type: 'defer', delayMs: 1 }
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
