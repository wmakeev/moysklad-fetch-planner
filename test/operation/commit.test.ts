import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { OperationError } from '../../src/operation-types.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const replay = { serverSafe: false, consumeSafe: false }

for (const interrupt of ['abort', 'attempt', 'deadline'] as const) {
  for (const afterCommit of [false, true]) {
    for (const cleanup of ['released', 'rejected', 'pending'] as const) {
      test(`Commit ${interrupt} ${afterCommit ? 'after' : 'before'} commit with ${cleanup} cleanup preserves value ownership`, async t => {
        const clock = createRuntime(t)
        const timers = trackTimeouts(t)
        const consumeGate = deferred<undefined>()
        const cleanupGate = deferred<undefined>()
        const entered = deferred<undefined>()
        const disposing = deferred<undefined>()
        const value = { temporary: true }
        let discards = 0
        let deliveries = 0
        let rejections = 0
        let settlements = 0
        let sends = 0
        let nextPrepares = 0
        let disposed = 0
        let resourceSettled = false
        const planner = new FetchPlanner<typeof fetch>(
          () => {
            sends++
            return Promise.resolve(new Response())
          },
          {
            maxParallelLimit: 1,
            deadlineMs: interrupt === 'deadline' ? 10 : 100,
            attemptTimeoutMs: interrupt === 'attempt' ? 10 : 200,
            cleanupGraceMs: 20
          }
        )
        const handle = planner.submit({
          method: 'POST',
          replay,
          prepare: () => ({ url: '', init: {} }),
          consume: async (_response, ctx) => {
            ctx.onDiscard(() => {
              discards++
            })
            ctx.onDispose(async () => {
              disposed++
              disposing.resolve(undefined)
              if (cleanup === 'pending') await cleanupGate.promise
              if (cleanup === 'rejected') throw new Error('cleanup failed')
            })
            entered.resolve(undefined)
            await consumeGate.promise
            return value
          }
        })
        void handle.result.then(
          completed => {
            deliveries++
            assert.equal(completed.value, value, 'DELIVER_THE_COMMITTED_VALUE')
          },
          () => {
            rejections++
          }
        )
        handle.observe(event => {
          if (event.type === 'operation-settled') settlements++
        })
        void handle.resourcesDone.then(() => {
          resourceSettled = true
        })
        let second: ReturnType<typeof planner.submit<string>> | undefined
        try {
          await entered.promise
          assert.equal(deliveries, 0, 'HEADERS_ARE_NOT_A_RESULT')
          if (afterCommit) {
            consumeGate.resolve(undefined)
            await disposing.promise
            if (cleanup !== 'pending') await clock.flush()
            assert.equal(handle.snapshot().resultCommitted, true)
          }
          if (interrupt === 'abort') {
            handle.abort()
            handle.abort()
          } else await clock.advance(10)
          if (!afterCommit) {
            await assert.rejects(handle.result, {
              code:
                interrupt === 'abort'
                  ? 'ABORTED'
                  : interrupt === 'attempt'
                    ? 'ATTEMPT_TIMEOUT'
                    : 'DEADLINE'
            })
            handle.abort()
            consumeGate.resolve(undefined)
            await disposing.promise
          } else if (cleanup === 'pending') {
            if (interrupt === 'attempt') {
              assert.equal(handle.snapshot().outcome, 'pending', 'ATTEMPT_CANNOT_SHORTEN_GRACE')
              await clock.advance(10)
            }
            const result = await handle.result
            assert.equal(result.value, value)
            assert.equal(result.cleanup, 'pending')
            assert.equal(resourceSettled, false)
            assert.equal(planner.snapshot().leasedAttempts, 1)
            assert.equal(planner.snapshot().sentActive, 1)
            second = planner.submit({
              method: 'GET',
              replay,
              prepare: () => {
                nextPrepares++
                return { url: '', init: {} }
              },
              consume: () => 'next'
            })
            await clock.flush()
            assert.equal(nextPrepares, 0, 'NEXT_PREPARE_WAITS_FOR_KNOWN_CLEANUP')
          }
          cleanupGate.resolve(undefined)
          const summary = await handle.resourcesDone
          assert.equal(summary.resources, cleanup === 'rejected' ? 'failed' : 'released')
          if (afterCommit) {
            const result = await handle.result
            assert.equal(result.value, value)
            assert.equal(result.status, 200)
            if (cleanup !== 'pending')
              assert.equal(result.cleanup, cleanup === 'rejected' ? 'failed' : 'released')
          }
          if (second) {
            await second.result
            await second.resourcesDone
          }
          await clock.flush()
          assert.equal(deliveries, afterCommit ? 1 : 0, 'COMMIT_MUST_DELIVER_ONCE')
          assert.equal(rejections, afterCommit ? 0 : 1)
          assert.equal(discards, afterCommit ? 0 : 1, 'UNCOMMITTED_VALUE_DISCARDED_ONCE')
          assert.equal(deliveries + discards, 1, 'VALUE_MUST_NOT_BE_LOST')
          assert.equal(settlements, 1)
          assert.equal(disposed, 1)
          assert.equal(sends, second ? 2 : 1, 'CLEANUP_NEVER_REPLAYS_POST')
          assert.equal(planner.snapshot().leasedAttempts, 0)
          assert.equal(planner.snapshot().sentActive, 0)
          assert.equal(timers.active.size, 0)
          assert.ok(timers.maximum() <= 1, 'ONE_COORDINATOR_TIMER')
        } finally {
          consumeGate.resolve(undefined)
          cleanupGate.resolve(undefined)
          handle.abort()
          second?.abort()
          await Promise.allSettled([
            handle.result,
            handle.resourcesDone,
            second?.result,
            second?.resourcesDone
          ])
        }
      })
    }
  }
}

for (const budget of ['attempt', 'deadline'] as const) {
  test(`Commit rejects expired ${budget} before delayed timer delivery`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    let discards = 0
    let deliveries = 0
    const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
      deadlineMs: budget === 'deadline' ? 10 : 100,
      attemptTimeoutMs: budget === 'attempt' ? 10 : 100
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      consume: async (_response, ctx) => {
        ctx.onDiscard(() => {
          discards++
        })
        entered.resolve(undefined)
        await gate.promise
        return { temporary: true }
      }
    })
    void handle.result.then(
      () => {
        deliveries++
      },
      () => undefined
    )
    try {
      await entered.promise
      const now = performance.now()
      t.mock.method(performance, 'now', () => now + 10)
      gate.resolve(undefined)
      await clock.flush()
      assert.equal(handle.snapshot().resultCommitted, false, 'EXPIRED_CLOCK_MUST_NOT_COMMIT')
      await assert.rejects(handle.result, {
        code: budget === 'deadline' ? 'DEADLINE' : 'ATTEMPT_TIMEOUT'
      })
      await handle.resourcesDone
      assert.equal(deliveries, 0)
      assert.equal(discards, 1)
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const grace of [5, 50]) {
  test(`Commit caps grace ${grace} by remaining admission deadline`, async t => {
    const clock = createRuntime(t)
    const cleanupGate = deferred<undefined>()
    const disposing = deferred<undefined>()
    const consumeGate = deferred<undefined>()
    const entered = deferred<undefined>()
    const value = { done: true }
    const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()), {
      deadlineMs: 30,
      attemptTimeoutMs: 100,
      cleanupGraceMs: grace
    })
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: '', init: {} }),
      consume: async (_response, ctx) => {
        ctx.onDispose(async () => {
          disposing.resolve(undefined)
          await cleanupGate.promise
        })
        entered.resolve(undefined)
        await consumeGate.promise
        return value
      }
    })
    try {
      await entered.promise
      await clock.advance(20)
      consumeGate.resolve(undefined)
      await disposing.promise
      const wait = Math.min(grace, 10)
      await clock.advance(wait - 1)
      assert.equal(handle.snapshot().outcome, 'pending')
      await clock.advance(1)
      const result = await handle.result
      assert.equal(result.value, value)
      assert.equal(result.cleanup, 'pending')
      assert.equal(handle.snapshot().resources, 'pending')
    } finally {
      consumeGate.resolve(undefined)
      cleanupGate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const abortFirst of [false, true]) {
  test(`Commit same-tick ${abortFirst ? 'abort' : 'consume'} first has one value owner`, async t => {
    const clock = createRuntime(t)
    const consumeGate = deferred<undefined>()
    const cleanupGate = deferred<undefined>()
    const entered = deferred<undefined>()
    let discards = 0
    let deliveries = 0
    const value = { sameTick: true }
    const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()))
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      consume: async (_response, ctx) => {
        ctx.onDiscard(() => {
          discards++
        })
        ctx.onDispose(() => cleanupGate.promise)
        entered.resolve(undefined)
        await consumeGate.promise
        return value
      }
    })
    void handle.result.then(
      result => {
        deliveries++
        assert.equal(result.value, value)
      },
      () => undefined
    )
    handle.observe(event => {
      if (!abortFirst && event.resultCommitted && event.outcome === 'pending') handle.abort()
    })
    try {
      await entered.promise
      if (abortFirst) handle.abort()
      consumeGate.resolve(undefined)
      await clock.flush()
      assert.equal(handle.snapshot().resultCommitted, !abortFirst)
      if (abortFirst) await assert.rejects(handle.result, { code: 'ABORTED' })
      else assert.equal((await handle.result).value, value)
      cleanupGate.resolve(undefined)
      await handle.resourcesDone
      assert.equal(deliveries, abortFirst ? 0 : 1)
      assert.equal(discards, abortFirst ? 1 : 0)
    } finally {
      consumeGate.resolve(undefined)
      cleanupGate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const mode of ['failure', 'late', 'success'] as const) {
  test(`Commit temporary file ${mode} is discarded or published by application`, async t => {
    const clock = createRuntime(t)
    const folder = await mkdtemp(path.join(process.cwd(), '__temp/operation-build/t44-'))
    const temporary = path.join(folder, 'partial')
    const published = path.join(folder, 'published')
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    let discards = 0
    let sends = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      sends++
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('broken body'))
            }
          })
        )
      )
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      consume: async (response, ctx) => {
        ctx.onDiscard(async () => {
          discards++
          await rm(temporary, { force: true })
        })
        await writeFile(temporary, 'partial')
        entered.resolve(undefined)
        await gate.promise
        if (mode === 'failure') await response.text()
        return temporary
      }
    })
    try {
      await entered.promise
      if (mode === 'late') handle.abort()
      gate.resolve(undefined)
      if (mode === 'success') {
        const result = await handle.result
        assert.equal(result.value, temporary)
        await assert.rejects(readFile(published), { code: 'ENOENT' })
        await rename(result.value, published)
        assert.equal(await readFile(published, 'utf8'), 'partial')
      } else {
        await assert.rejects(
          handle.result,
          error =>
            error instanceof OperationError &&
            error.code === (mode === 'late' ? 'ABORTED' : 'CONSUME_FAILED') &&
            error.status === 200 &&
            error.serverOutcome === 'http-response'
        )
      }
      await handle.resourcesDone
      await clock.flush()
      assert.equal(discards, mode === 'success' ? 0 : 1)
      await assert.rejects(readFile(temporary), { code: 'ENOENT' })
      assert.equal(sends, 1)
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
      await rm(folder, { recursive: true, force: true })
    }
  })
}

test('Commit keeps raw thenable-like value boxed across pending cleanup and abort', async t => {
  const clock = createRuntime(t)
  const gate = deferred<undefined>()
  const disposing = deferred<undefined>()
  let reads = 0
  let readsAtCleanup = 0
  let discards = 0
  const value = {
    get then() {
      reads++
      if (readsAtCleanup) throw new Error('unboxed raw value')
      return undefined
    }
  }
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()))
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: (_response, ctx) => {
      ctx.onDiscard(() => {
        discards++
      })
      ctx.onDispose(async () => {
        readsAtCleanup = reads
        disposing.resolve(undefined)
        await gate.promise
      })
      return value
    }
  })
  try {
    await disposing.promise
    handle.abort()
    const result = await handle.result
    assert.equal(result.value, value)
    assert.equal(result.cleanup, 'pending')
    assert.equal(reads, readsAtCleanup)
    assert.ok(reads > 0)
    assert.equal(discards, 0)
    await clock.flush()
  } finally {
    gate.resolve(undefined)
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Commit conservation across abort in already entered cleanup never loses value', async t => {
  const clock = createRuntime(t)
  const gate = deferred<undefined>()
  const disposing = deferred<undefined>()
  const value = { conserved: true }
  let deliveries = 0
  let discards = 0
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response()))
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: (_response, ctx) => {
      ctx.onDiscard(() => {
        discards++
      })
      ctx.onDispose(async () => {
        disposing.resolve(undefined)
        await gate.promise
      })
      return value
    }
  })
  void handle.result.then(
    result => {
      deliveries++
      assert.equal(result.value, value)
    },
    () => undefined
  )
  try {
    await disposing.promise
    handle.abort()
    gate.resolve(undefined)
    await Promise.allSettled([handle.result, handle.resourcesDone])
    await clock.flush()
    assert.equal(deliveries + discards, 1, 'VALUE_MUST_NOT_BE_LOST_0_0')
    assert.equal(deliveries, 1)
    assert.equal(discards, 0)
  } finally {
    gate.resolve(undefined)
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

for (const budget of ['attempt', 'deadline'] as const) {
  for (const materialization of ['receipt', 'commit stamp'] as const) {
    test(`Commit checks actual ${budget} time after ${materialization} materialization`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const now = performance.now()
      const wall = Date.now()
      let discards = 0
      let deliveries = 0
      let reads = 0
      let consumed = 0
      let settled = 0
      let armStamp = false
      const expireClock = () => {
        t.mock.method(performance, 'now', () => now + 10)
      }
      t.mock.method(Date, 'now', () => {
        if (armStamp) {
          armStamp = false
          expireClock()
        }
        return wall
      })
      const response = new Response()
      Object.defineProperty(response, 'status', {
        get() {
          reads++
          if (materialization === 'receipt') expireClock()
          return 200
        }
      })
      const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(response), {
        deadlineMs: budget === 'deadline' ? 10 : 100,
        attemptTimeoutMs: budget === 'attempt' ? 10 : 100
      })
      const handle = planner.submit({
        method: 'POST',
        replay,
        prepare: () => ({ url: '', init: {} }),
        consume: (_response, ctx) => {
          consumed++
          ctx.onDiscard(() => {
            discards++
          })
          armStamp = materialization === 'commit stamp'
          return { temporary: true }
        }
      })
      handle.observe(event => {
        if (event.type === 'operation-settled') settled++
      })
      void handle.result.then(
        () => {
          deliveries++
        },
        () => undefined
      )
      try {
        await clock.flush()
        assert.equal(handle.snapshot().resultCommitted, false, 'MATERIALIZED_TIME_MUST_NOT_COMMIT')
        await assert.rejects(
          handle.result,
          error =>
            error instanceof OperationError &&
            error.code === (budget === 'deadline' ? 'DEADLINE' : 'ATTEMPT_TIMEOUT') &&
            error.status === 200 &&
            error.serverOutcome === 'http-response'
        )
        await handle.resourcesDone
        assert.equal(reads, 1, 'ONE_MATERIALIZED_HTTP_STATUS')
        assert.equal(consumed, 1)
        assert.equal(deliveries, 0)
        assert.equal(discards, 1)
        assert.equal(settled, 1)
        assert.equal(timers.active.size, 0)
        assert.equal(planner.snapshot().leasedAttempts, 0)
        assert.equal(planner.snapshot().sentActive, 0)
      } finally {
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
}

for (const effect of ['changed', 'attempt', 'deadline', 'abort', 'throw'] as const) {
  test(`Commit uses receipt status without ${effect} getter rereads after consume`, async t => {
    const clock = createRuntime(t)
    const now = performance.now()
    const cause = new Error('status getter side effect')
    const value = { receipt: true }
    let consumed = false
    let reads = 0
    let discards = 0
    const response = new Response()
    Object.defineProperty(response, 'status', {
      get() {
        reads++
        if (!consumed) return 200
        if (effect === 'abort') handle.abort(cause)
        if (effect === 'throw') throw cause
        if (effect === 'attempt' || effect === 'deadline')
          t.mock.method(performance, 'now', () => now + 10)
        return 429
      }
    })
    const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(response), {
      deadlineMs: effect === 'deadline' ? 10 : 100,
      attemptTimeoutMs: effect === 'attempt' ? 10 : 100
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      consume: (_response, ctx) => {
        consumed = true
        ctx.onDiscard(() => {
          discards++
        })
        return value
      }
    })
    try {
      await clock.flush()
      assert.equal(reads, 1, 'HTTP_RECEIPT_STATUS_MUST_NOT_BE_REREAD')
      const result = await handle.result
      assert.equal(result.value, value)
      assert.equal(result.status, 200)
      assert.equal(handle.snapshot().status, 200)
      await handle.resourcesDone
      assert.equal(discards, 0)
      assert.equal(handle.snapshot().dispatchCalls, 1)
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const site of ['receipt', 'consume property', 'value then', 'commit stamp'] as const) {
  for (const effect of ['abort', 'throw'] as const) {
    test(`Commit ${site} getter ${effect} preserves primary failure and discard once`, async t => {
      const clock = createRuntime(t)
      const cause = new Error('primary getter failure')
      let discards = 0
      let reads = 0
      let consumes = 0
      let settlements = 0
      let armStamp = false
      const wall = Date.now()
      const action = () => {
        reads++
        if (effect === 'throw') throw cause
        handle.abort(cause)
      }
      t.mock.method(Date, 'now', () => {
        if (armStamp) {
          armStamp = false
          action()
        }
        return wall
      })
      const response = new Response()
      if (site === 'receipt')
        Object.defineProperty(response, 'status', {
          get() {
            action()
            return 200
          }
        })
      if (site === 'consume property')
        Object.defineProperty(response, 'statusText', {
          get() {
            action()
            return 'OK'
          }
        })
      const value = {
        get then() {
          if (site === 'value then') action()
          return undefined
        }
      }
      const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(response))
      const handle = planner.submit({
        method: 'POST',
        replay,
        prepare: ctx => {
          // Receipt failure occurs before consume can acquire ownership.
          ctx.onDispose(() => {
            throw new Error('secondary cleanup failure')
          })
          return { url: '', init: {} }
        },
        consume: (borrowed, ctx) => {
          consumes++
          ctx.onDiscard(() => {
            discards++
            throw new Error('secondary discard failure')
          })
          if (site === 'consume property') void borrowed.statusText
          armStamp = site === 'commit stamp'
          return value
        }
      })
      handle.observe(event => {
        if (event.type === 'operation-settled') settlements++
      })
      try {
        await assert.rejects(
          handle.result,
          error =>
            error instanceof OperationError &&
            error.cause === cause &&
            error.code ===
              (effect === 'abort'
                ? 'ABORTED'
                : site === 'receipt'
                  ? 'TRANSPORT_FAILED'
                  : 'CONSUME_FAILED') &&
            error.status === (site === 'receipt' ? undefined : 200) &&
            error.serverOutcome === (site === 'receipt' ? 'unknown' : 'http-response')
        )
        assert.equal((await handle.resourcesDone).resources, 'failed')
        await clock.flush()
        assert.ok(reads > 0)
        assert.equal(consumes, site === 'receipt' ? 0 : 1)
        assert.equal(discards, site === 'receipt' ? 0 : 1)
        assert.equal(settlements, 1)
        assert.equal(handle.snapshot().resultCommitted, false)
        assert.equal(
          handle.snapshot().status,
          site === 'receipt' && effect === 'throw' ? undefined : 200
        )
        assert.equal(handle.snapshot().dispatchCalls, 1)
        assert.equal(planner.snapshot().leasedAttempts, 0)
        assert.equal(planner.snapshot().sentActive, 0)
      } finally {
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
}
