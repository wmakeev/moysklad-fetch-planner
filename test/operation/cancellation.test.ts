import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { OperationError } from '../../src/operation-types.js'
import { MAX_TIMEOUT_MS } from '../../src/runtime.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const replay = { serverSafe: false, consumeSafe: false }
const phases = ['queued', 'preparing', 'ready', 'sending', 'consuming', 'cleanup'] as const

for (const phase of phases) {
  for (const interrupt of ['stop', 'abort', 'deadline', 'attempt'] as const) {
    // Attempt time starts at prepare, so a queued operation has no attempt budget.
    if (phase === 'queued' && interrupt === 'attempt') continue
    test(`Cancellation ${interrupt} in ${phase} preserves ownership and terminal result`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const owner = deferred<undefined>()
      const cleanup = deferred<undefined>()
      const entered = deferred<undefined>()
      const disposing = deferred<undefined>()
      const receipt = deferred<Response>()
      const reason = new Error('first private reason')
      let signal: AbortSignal | undefined
      let sends = 0
      let prepares = 0
      let consumes = 0
      let disposals = 0
      let discards = 0
      let settlements = 0
      let resourceSettled = false
      let nextPrepares = 0
      const sent = phase === 'sending' || phase === 'consuming' || phase === 'cleanup'
      const committed = phase === 'cleanup'
      const planner = new FetchPlanner<typeof fetch>(
        (_url, init) => {
          sends++
          assert.equal(init?.method, sends === 1 && sent ? 'POST' : 'GET')
          signal = init.signal ?? undefined
          if (phase === 'sending') {
            entered.resolve(undefined)
            return receipt.promise
          }
          return Promise.resolve(new Response())
        },
        {
          maxParallelLimit: 1,
          deadlineMs: interrupt === 'deadline' ? 10 : 100,
          attemptTimeoutMs: interrupt === 'attempt' ? 10 : 100,
          cleanupGraceMs: 20
        }
      )
      const interruptNow = () => {
        if (interrupt === 'stop') {
          planner.stop(reason)
          planner.stop(new Error('ignored stop'))
        } else if (interrupt === 'abort') {
          handle.abort(reason)
          handle.abort(new Error('ignored abort'))
        } else clock.tick(10)
      }
      const handle = planner.submit({
        method: 'POST',
        replay,
        prepare: async ctx => {
          prepares++
          signal = ctx.signal
          ctx.onDispose(async () => {
            disposals++
            disposing.resolve(undefined)
            await cleanup.promise
          })
          if (phase === 'preparing') {
            entered.resolve(undefined)
            await owner.promise
          }
          return { url: '', init: {} }
        },
        consume: async (_response, ctx) => {
          consumes++
          ctx.onDiscard(() => {
            discards++
          })
          if (phase === 'consuming') {
            entered.resolve(undefined)
            await owner.promise
          }
          return 'current POST result'
        }
      })
      handle.observe(event => {
        if (event.type === 'operation-settled') settlements++
        if (phase === 'ready' && event.phase === 'ready') interruptNow()
      })
      void handle.resourcesDone.then(() => {
        resourceSettled = true
      })
      let next: ReturnType<typeof planner.submit<string>> | undefined
      try {
        if (phase === 'queued') interruptNow()
        else if (phase === 'ready') await clock.flush()
        else {
          await (committed ? disposing.promise : entered.promise)
          assert.equal(handle.snapshot().phase, phase)
          interruptNow()
        }
        await clock.flush()
        const success = committed || (interrupt === 'stop' && sent)
        const code =
          interrupt === 'stop'
            ? 'STOPPED'
            : interrupt === 'abort'
              ? 'ABORTED'
              : interrupt === 'deadline'
                ? 'DEADLINE'
                : 'ATTEMPT_TIMEOUT'
        if (!success) {
          await assert.rejects(
            handle.result,
            error =>
              error instanceof OperationError &&
              error.code === code &&
              error.phase === phase &&
              error.dispatchEntered === sent &&
              ((interrupt !== 'stop' && interrupt !== 'abort') || error.cause === reason)
          )
        }
        if (signal) assert.equal(signal.aborted, !success, 'STOP_SENT_MUST_NOT_ABORT')
        if (phase !== 'queued') {
          assert.equal(resourceSettled, false, 'RESOURCES_WAIT_FOR_ACTUAL_RELEASE')
          assert.equal(planner.snapshot().leasedAttempts, 1)
          assert.equal(planner.snapshot().sentActive, sent ? 1 : 0)
          if (phase === 'preparing' || phase === 'consuming') assert.equal(disposals, 0)
        }
        next = planner.submit({
          method: 'GET',
          replay,
          prepare: () => {
            nextPrepares++
            return { url: '', init: {} }
          },
          consume: () => 'next'
        })
        await clock.flush()
        if (phase !== 'queued' || interrupt === 'stop')
          assert.equal(nextPrepares, 0, 'NEXT_PREPARE_BLOCKED_UNTIL_RELEASE')
        if (interrupt === 'stop')
          await assert.rejects(
            next.result,
            error =>
              error instanceof OperationError && error.code === 'STOPPED' && error.cause === reason
          )
        owner.resolve(undefined)
        receipt.resolve(new Response())
        if (phase !== 'queued') await disposing.promise
        if (success) {
          if (interrupt === 'stop' || interrupt === 'attempt') await clock.advance(20)
          const result = await handle.result
          assert.equal(result.value, 'current POST result')
          assert.equal(result.cleanup, 'pending')
        }
        cleanup.resolve(undefined)
        await handle.resourcesDone
        if (interrupt !== 'stop') {
          await next.result
          await next.resourcesDone
        }
        const final = handle.snapshot()
        handle.abort(new Error('late abort'))
        planner.stop(reason)
        planner.stop()
        await clock.advance(200)
        assert.deepEqual(handle.snapshot(), final, 'TERMINAL_HANDLE_IS_STABLE')
        assert.equal(settlements, 1)
        assert.equal(disposals, phase === 'queued' ? 0 : 1)
        assert.equal(discards, !success && phase === 'consuming' ? 1 : 0)
        assert.equal(
          consumes,
          phase === 'consuming' || phase === 'cleanup' || (phase === 'sending' && success) ? 1 : 0
        )
        // The second operation uses the same transport, after the POST work releases.
        assert.equal(sends, (sent ? 1 : 0) + (interrupt !== 'stop' ? 1 : 0))
        assert.equal(prepares, phase === 'queued' ? 0 : 1)
        assert.equal(planner.snapshot().queued, 0)
        assert.equal(planner.snapshot().leasedAttempts, 0)
        assert.equal(planner.snapshot().sentActive, 0)
        assert.equal(timers.active.size, 0)
        assert.ok(timers.maximum() <= 1)
      } finally {
        owner.resolve(undefined)
        receipt.resolve(new Response())
        cleanup.resolve(undefined)
        handle.abort()
        next?.abort()
        await Promise.allSettled([
          handle.result,
          handle.resourcesDone,
          next?.result,
          next?.resourcesDone
        ])
      }
    })
  }
}

for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`Cancellation rejects invalid finite duration ${value}`, async () => {
    for (const key of [
      'deadlineMs',
      'attemptTimeoutMs',
      'cleanupGraceMs',
      'hookTimeoutMs',
      'maxAttempts'
    ] as const) {
      assert.throws(() => new FetchPlanner(fetch, { [key]: value }), { code: 'INVALID_ARGUMENT' })
    }
    const planner = new FetchPlanner(fetch)
    const handle = planner.submit({
      method: 'GET',
      replay,
      deadlineMs: value,
      prepare: () => ({ url: '', init: {} }),
      consume: () => 1
    })
    await assert.rejects(handle.result, { code: 'INVALID_ARGUMENT' })
    await handle.resourcesDone
    assert.equal(planner.snapshot().queued, 0)
  })
}

for (const extra of [0, 1]) {
  test(`Cancellation chunks long monotonic wait MAX_TIMER plus ${extra}`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    let prepares = 0
    const planner = new FetchPlanner(fetch)
    assert.equal(timers.active.size, 0, 'IDLE_HAS_NO_TIMER')
    const handle = planner.submit({
      method: 'GET',
      replay,
      deadlineMs: MAX_TIMEOUT_MS + extra,
      prepare: () => {
        prepares++
        return { url: '', init: {} }
      },
      consume: () => 1
    })
    try {
      assert.equal(timers.delays.at(-1), MAX_TIMEOUT_MS)
      // Exercise the real coordinator's queued expiry without delivering its pump first.
      clock.jumpWall(-9_000_000_000)
      clock.tick(MAX_TIMEOUT_MS)
      if (extra) {
        assert.equal(handle.snapshot().outcome, 'pending')
        assert.equal(timers.delays.at(-1), 1)
        clock.jumpWall(18_000_000_000)
        clock.tick(1)
      }
      await assert.rejects(handle.result, { code: 'DEADLINE' })
      await handle.resourcesDone
      await clock.flush()
      assert.equal(prepares, 0)
      assert.equal(timers.active.size, 0)
      assert.ok(timers.delays.every(delay => delay >= 0 && delay <= MAX_TIMEOUT_MS))
      assert.ok(timers.maximum() <= 1)
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const kind of ['operation', 'attempt'] as const) {
  for (const overflow of [false, true]) {
    test(`Cancellation ${kind} absolute deadline ${overflow ? 'overflow rejects' : 'exact safe accepted'}`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const duration = Number.MAX_SAFE_INTEGER - performance.now() + (overflow ? 1 : 0)
      let prepares = 0
      const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
        attemptTimeoutMs: kind === 'attempt' ? duration : 100
      })
      const handle = planner.submit({
        method: 'GET',
        replay,
        deadlineMs: kind === 'operation' ? duration : 100,
        prepare: () => {
          prepares++
          return { url: '', init: {} }
        },
        consume: () => 1
      })
      try {
        await clock.flush()
        if (overflow) {
          await assert.rejects(handle.result, { code: 'INVALID_ARGUMENT' })
          assert.equal(prepares, 0, 'OVERFLOW_MUST_NOT_ENTER_PREPARE')
        } else assert.equal((await handle.result).value, 1)
        await handle.resourcesDone
        assert.equal(timers.active.size, 0)
      } finally {
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
}

for (const budget of ['deadline', 'attempt'] as const) {
  test(`Cancellation ${budget} starts at its own admission or prepare boundary`, async t => {
    const clock = createRuntime(t)
    const blocker = deferred<undefined>()
    const entered = deferred<undefined>()
    const work = deferred<undefined>()
    const working = deferred<undefined>()
    let signal: AbortSignal | undefined
    let prepares = 0
    const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
      maxParallelLimit: 1,
      deadlineMs: 100,
      attemptTimeoutMs: budget === 'attempt' ? 10 : 100
    })
    const first = planner.submit({
      method: 'GET',
      replay,
      prepare: async () => {
        entered.resolve(undefined)
        await blocker.promise
        return { url: '', init: {} }
      },
      consume: () => 1
    })
    await entered.promise
    const second = planner.submit({
      method: 'GET',
      replay,
      deadlineMs: budget === 'deadline' ? 10 : 100,
      prepare: async ctx => {
        prepares++
        signal = ctx.signal
        working.resolve(undefined)
        await work.promise
        return { url: '', init: {} }
      },
      consume: () => 2
    })
    try {
      await clock.advance(9)
      assert.equal(prepares, 0)
      first.abort()
      blocker.resolve(undefined)
      await first.resourcesDone
      await working.promise
      await clock.advance(1)
      if (budget === 'deadline') await assert.rejects(second.result, { code: 'DEADLINE' })
      else {
        assert.equal(second.snapshot().outcome, 'pending')
        await clock.advance(8)
        assert.equal(second.snapshot().outcome, 'pending')
        await clock.advance(1)
        await assert.rejects(second.result, { code: 'ATTEMPT_TIMEOUT' })
      }
      assert.equal(signal?.aborted, true)
      assert.equal(second.snapshot().resources, 'pending')
    } finally {
      blocker.resolve(undefined)
      work.resolve(undefined)
      first.abort()
      second.abort()
      await Promise.allSettled([
        first.result,
        first.resourcesDone,
        second.result,
        second.resourcesDone
      ])
    }
  })
}

for (const budget of ['deadline', 'attempt'] as const) {
  test(`Cancellation checks expired ${budget} after prepare without timer delivery`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    let sends = 0
    let signal: AbortSignal | undefined
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        sends++
        return Promise.resolve(new Response())
      },
      {
        deadlineMs: budget === 'deadline' ? 10 : 100,
        attemptTimeoutMs: budget === 'attempt' ? 10 : 100
      }
    )
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: async ctx => {
        signal = ctx.signal
        entered.resolve(undefined)
        await gate.promise
        return { url: '', init: {} }
      },
      consume: () => 1
    })
    try {
      await entered.promise
      const now = performance.now()
      t.mock.method(performance, 'now', () => now + 10)
      gate.resolve(undefined)
      await clock.flush()
      await assert.rejects(handle.result, {
        code: budget === 'deadline' ? 'DEADLINE' : 'ATTEMPT_TIMEOUT'
      })
      await handle.resourcesDone
      assert.equal(signal?.aborted, true)
      assert.equal(sends, 0)
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Cancellation finite strict child exits naturally after real timer expiry and stop', () => {
  const module = new URL('../../src/planner.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import { FetchPlanner } from ${JSON.stringify(module)}
    const replay = {serverSafe:false,consumeSafe:false}
    const watchdog = setTimeout(() => { throw new Error('finite child leaked work') }, 2000)
    try {
      for (const mode of ['stop', 'abort', 'deadline', 'attempt']) {
        let signal, release, entered
        const gate = new Promise(resolve => { release = resolve })
        const ready = new Promise(resolve => { entered = resolve })
        const planner = new FetchPlanner(() => Promise.resolve(new Response()), {
          maxParallelLimit:1, deadlineMs:mode === 'deadline' ? 20 : 1000,
          attemptTimeoutMs:mode === 'attempt' ? 20 : 1000, cleanupGraceMs:10
        })
        const handle = planner.submit({method:'POST',replay,prepare:ctx => {
          signal=ctx.signal; return {url:'',init:{}}
        },consume:async () => { entered(); await gate; return 42 }})
        let next
        try {
          await ready
          if (mode === 'stop') planner.stop('first')
          if (mode === 'abort') handle.abort('first')
          if (mode !== 'stop') {
            await assert.rejects(handle.result, {code: mode === 'abort' ? 'ABORTED' : mode === 'deadline' ? 'DEADLINE' : 'ATTEMPT_TIMEOUT'})
            assert.equal(signal.aborted,true)
          } else assert.equal(signal.aborted,false)
          assert.equal(planner.snapshot().leasedAttempts,1)
          next=planner.submit({method:'GET',replay,prepare:() => ({url:'',init:{}}),consume:() => 7})
          release()
          if (mode === 'stop') assert.equal((await handle.result).value,42)
          await handle.resourcesDone
          if (mode === 'stop') await assert.rejects(next.result,{code:'STOPPED'})
          else await next.result
          await next.resourcesDone
          assert.equal(planner.snapshot().leasedAttempts,0)
          assert.equal(planner.snapshot().sentActive,0)
        } finally {
          release(); handle.abort(); next?.abort()
          await Promise.allSettled([handle.result,handle.resourcesDone,next?.result,next?.resourcesDone])
        }
      }
      console.log('PASS finite real timer child, natural exit')
    } finally { clearTimeout(watchdog) }
  `
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '--eval', source],
    {
      encoding: 'utf8',
      timeout: 5000
    }
  )
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.match(child.stdout, /PASS finite real timer child, natural exit/)
})

for (const phase of ['preparing', 'cleanup'] as const) {
  test(`Cancellation long ${phase} timer continues chunks with one owner`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    let signal: AbortSignal | undefined
    const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
      deadlineMs: MAX_TIMEOUT_MS + 100,
      attemptTimeoutMs: MAX_TIMEOUT_MS + 1,
      cleanupGraceMs: MAX_TIMEOUT_MS + 1
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: async ctx => {
        signal = ctx.signal
        if (phase === 'preparing') {
          entered.resolve(undefined)
          await gate.promise
        } else
          ctx.onDispose(async () => {
            entered.resolve(undefined)
            await gate.promise
          })
        return { url: '', init: {} }
      },
      consume: () => 1
    })
    try {
      await entered.promise
      assert.equal(timers.delays.at(-1), MAX_TIMEOUT_MS)
      clock.jumpWall(1_000_000_000_000)
      await clock.advance(MAX_TIMEOUT_MS)
      assert.equal(handle.snapshot().outcome, 'pending')
      assert.equal(signal?.aborted, false)
      assert.equal(timers.delays.at(-1), 1)
      clock.jumpWall(-2_000_000_000_000)
      await clock.advance(1)
      if (phase === 'preparing') {
        await assert.rejects(handle.result, { code: 'ATTEMPT_TIMEOUT' })
        assert.equal(signal.aborted, true)
      } else {
        assert.equal((await handle.result).cleanup, 'pending')
        assert.equal(signal.aborted, false)
      }
      assert.equal(handle.snapshot().resources, 'pending')
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(timers.active.size, 0)
      gate.resolve(undefined)
      await handle.resourcesDone
      assert.ok(timers.maximum() <= 1)
      assert.ok(timers.delays.every(delay => delay <= MAX_TIMEOUT_MS))
      assert.equal(timers.active.size, 0)
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const interrupt of ['stop', 'abort', 'deadline', 'attempt'] as const) {
  test(`Cancellation ${interrupt} after failed consume retains first failure during cleanup`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    const reason = new Error('original consume failure')
    let signal: AbortSignal | undefined
    let disposed = 0
    const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
      deadlineMs: 10,
      attemptTimeoutMs: 10
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        signal = ctx.signal
        ctx.onDispose(async () => {
          disposed++
          entered.resolve(undefined)
          await gate.promise
        })
        return { url: '', init: {} }
      },
      consume: () => {
        throw reason
      }
    })
    try {
      await entered.promise
      const before = handle.snapshot()
      if (interrupt === 'stop') {
        planner.stop(reason)
        planner.stop()
      } else if (interrupt === 'abort') {
        handle.abort()
        handle.abort()
      } else await clock.advance(10)
      await assert.rejects(
        handle.result,
        error =>
          error instanceof OperationError &&
          error.code === 'CONSUME_FAILED' &&
          error.cause === reason
      )
      assert.equal(signal?.aborted, false)
      assert.deepEqual(handle.snapshot(), before)
      assert.equal(handle.snapshot().resources, 'pending')
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 1)
      gate.resolve(undefined)
      await handle.resourcesDone
      assert.equal(disposed, 1)
      assert.equal(planner.snapshot().leasedAttempts, 0)
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Cancellation stop drains every queued reservation and keeps its first reason', async t => {
  const clock = createRuntime(t)
  const timers = trackTimeouts(t)
  const planner = new FetchPlanner(fetch, { maxQueuedOperations: 3 })
  const reason = new Error('private stop reason')
  let prepares = 0
  const spec = {
    method: 'GET',
    replay,
    prepare: () => {
      prepares++
      return { url: '', init: {} }
    },
    consume: () => 1
  } satisfies Parameters<typeof planner.submit>[0]
  const handles = [planner.submit(spec), planner.submit(spec), planner.submit(spec)]
  assert.equal(planner.snapshot().queued, 3)
  planner.stop(reason)
  planner.stop(new Error('second reason'))
  handles.push(planner.submit(spec))
  for (const handle of handles) {
    await assert.rejects(
      handle.result,
      error => error instanceof OperationError && error.code === 'STOPPED' && error.cause === reason
    )
    await handle.resourcesDone
    assert.equal(JSON.stringify(handle.snapshot()).includes('private'), false)
    handle.abort()
  }
  await clock.flush()
  assert.equal(prepares, 0)
  assert.equal(planner.snapshot().queued, 0)
  assert.equal(planner.snapshot().leasedAttempts, 0)
  assert.equal(timers.active.size, 0)
})
