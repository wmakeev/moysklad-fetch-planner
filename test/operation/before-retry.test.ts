import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import {
  ConsumeReadFailure,
  OperationError,
  type Decision,
  type HookContext
} from '../../src/operation-types.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const replay = { serverSafe: true, consumeSafe: true }

for (const [name, Planner] of [
  ['root', RootPlanner],
  ['deep', FetchPlanner]
] as const) {
  test(`Before retry ${name} waits for reader and disposer before owning the lease`, async t => {
    const clock = createRuntime(t)
    const reader = deferred<undefined>()
    const disposer = deferred<undefined>()
    const disposing = deferred<undefined>()
    const gate = deferred<Decision>()
    const entered = deferred<HookContext>()
    let hooks = 0
    let prepares = 0
    let calls = 0
    let nextPrepare = 0
    let resources = 0
    const inits: object[] = []
    const signals: AbortSignal[] = []
    const order: string[] = []
    const planner = new Planner<typeof fetch>(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response(
                new ReadableStream({
                  cancel: () => reader.promise
                }),
                { status: 429, headers: { 'content-type': 'application/json' } }
              )
            : new Response('ok')
        )
      },
      { maxParallelLimit: 1 }
    )
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        prepares++
        order.push(`prepare${prepares}`)
        signals.push(ctx.signal)
        ctx.onDispose(async () => {
          if (ctx.attemptNumber === 1) {
            disposing.resolve(undefined)
            await disposer.promise
          }
        })
        const init = { body: 'same payload' }
        inits.push(init)
        return { url: '', init }
      },
      beforeRetry: async ctx => {
        hooks++
        entered.resolve(ctx)
        return await gate.promise
      },
      consume: response => response.text()
    })
    void handle.resourcesDone.then(() => {
      resources++
    })
    const next = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        nextPrepare++
        order.push('sibling')
        return { url: '', init: {} }
      },
      consume: response => response.text()
    })
    try {
      await clock.flush()
      await clock.advance(250)
      await disposing.promise
      await clock.flush()
      assert.equal(hooks, 0)
      assert.equal(prepares, 1)
      assert.equal(nextPrepare, 0)
      disposer.resolve(undefined)
      await clock.flush()
      assert.equal(hooks, 0, 'READER_MUST_RELEASE_BEFORE_HOOK')
      reader.resolve(undefined)
      const ctx = await entered.promise
      await clock.flush()
      assert.ok(Object.isFrozen(ctx))
      assert.ok(Object.isFrozen(ctx.snapshot))
      assert.deepEqual(Object.keys(ctx).sort(), [
        'attemptNumber',
        'dispatchCalls',
        'signal',
        'snapshot',
        'status'
      ])
      assert.equal(ctx.status, 429)
      assert.equal(ctx.attemptNumber, 1)
      assert.equal(ctx.dispatchCalls, 1)
      assert.equal(ctx.snapshot.resources, 'pending')
      assert.equal(ctx.signal.aborted, false)
      assert.equal(planner.snapshot().sentActive, 0)
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(resources, 0)
      assert.equal(nextPrepare, 0, 'PENDING_RETRY_HOOK_BLOCKS_NEXT_PREPARE')
      gate.resolve({ type: 'allow' })
      await clock.flush()
      assert.equal(nextPrepare, 1)
      assert.equal(prepares, 1)
      assert.equal(resources, 0)
      await clock.advance(3000)
      await clock.advance(1)
      assert.equal((await next.result).value, 'ok')
      assert.equal((await handle.result).value, 'ok')
      await Promise.all([handle.resourcesDone, next.resourcesDone])
      assert.equal(hooks, 1)
      assert.equal(prepares, 2)
      assert.equal(calls, 3)
      assert.notEqual(inits[0], inits[1])
      assert.notEqual(signals[0], signals[1])
      assert.deepEqual(order, ['prepare1', 'sibling', 'prepare2'])
      assert.equal(resources, 1)
      assert.equal(planner.snapshot().leasedAttempts, 0)
    } finally {
      reader.resolve(undefined)
      disposer.resolve(undefined)
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

for (const kind of ['deny', 'throw', 'reject', 'invalid', 'defer'] as const) {
  test(`Before retry ${kind} terminates without replay`, async t => {
    createRuntime(t)
    let hooks = 0
    let prepares = 0
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response(null, { status: 429 }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => {
        prepares++
        return { url: '', init: {} }
      },
      beforeRetry: () => {
        hooks++
        if (kind === 'throw') throw new Error('private')
        if (kind === 'reject') return Promise.reject(new Error('private'))
        if (kind === 'invalid') return { type: 'allow', extra: true }
        if (kind === 'defer') return { type: 'defer', delayMs: 5 }
        return { type: 'deny', code: 'POLICY_DENIED' }
      },
      consume: () => 1
    })
    await assert.rejects(handle.result, error => {
      assert.ok(error instanceof OperationError)
      assert.equal(error.code, kind === 'deny' ? 'HOOK_DENIED' : 'HOOK_FAILED')
      assert.equal(error.status, 429)
      assert.equal(error.dispatchEntered, true)
      if (kind === 'deny') assert.equal(error.cause, 'POLICY_DENIED')
      return true
    })
    await handle.resourcesDone
    assert.equal(hooks, 1)
    assert.equal(prepares, 1)
    assert.equal(calls, 1)
    assert.equal(planner.snapshot().leasedAttempts, 0)
  })
}

for (const mode of ['timeout', 'abort', 'stop', 'deadline', 'attempt'] as const) {
  test(`Before retry pending ${mode} holds physical ownership after logical failure`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const gate = deferred<Decision>()
    const entered = deferred<HookContext>()
    let nextPrepare = 0
    let calls = 0
    let resources = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        calls++
        return Promise.resolve(new Response(null, { status: calls === 1 ? 429 : 200 }))
      },
      { maxParallelLimit: 1 }
    )
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      beforeRetry: async ctx => {
        entered.resolve(ctx)
        return await gate.promise
      },
      consume: () => 1
    })
    void handle.resourcesDone.then(() => {
      resources++
    })
    const next = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        nextPrepare++
        return { url: '', init: {} }
      },
      consume: () => 2
    })
    try {
      const ctx = await entered.promise
      assert.equal(timers.delays.at(-1), 1000)
      if (mode === 'abort') handle.abort()
      else if (mode === 'stop') planner.stop()
      else if (mode === 'timeout') {
        await clock.advance(999)
        assert.equal(handle.snapshot().outcome, 'pending')
        assert.equal(ctx.signal.aborted, false)
        await clock.advance(1)
      } else {
        // Deliver the existing timer late; absolute operation/attempt expiry wins.
        clock.tick(mode === 'deadline' ? 120000 : 30000)
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
      await assert.rejects(handle.result, { code })
      await clock.flush()
      assert.equal(ctx.signal.aborted, true)
      assert.equal(nextPrepare, 0, 'PENDING_RETRY_HOOK_BLOCKS_NEXT_PREPARE')
      assert.equal(resources, 0)
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 0)
      gate.resolve({ type: 'allow' })
      await handle.resourcesDone
      if (mode === 'deadline' || mode === 'stop') await assert.rejects(next.result)
      else {
        await clock.advance(3000)
        assert.equal((await next.result).value, 2)
      }
      await next.resourcesDone
      assert.equal(handle.snapshot().failureCode, code)
      assert.equal(handle.snapshot().dispatchCalls, 1)
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

for (const family of ['native', 'undici']) {
  test(`Before retry ${family} actual upload settles before hook entry`, () => {
    const source = `
      import assert from 'node:assert/strict'
      import { once } from 'node:events'
      import { createServer } from 'node:http'
      import { setImmediate as turn } from 'node:timers/promises'
      import { Agent, fetch as undiciFetch } from 'undici'
      import { FetchPlanner } from ${JSON.stringify(new URL(family === 'native' ? '../../src/index.js' : '../../src/planner.js', import.meta.url).href)}
      import { deferred } from ${JSON.stringify(new URL('./helpers.js', import.meta.url).href)}
      const work = deferred(), dispose = deferred(), stopping = deferred(), produced = deferred()
      const entered = deferred(), hookGate = deferred(), failed = deferred()
      const tasks = [], sockets = new Set(), closures = []
      const agent = new Agent({ connections: 1, pipelining: 1 })
      const abort = new AbortController()
      let controller, pulls = 0, pending = 0, prepares = 0, calls = 0, hooks = 0, disposals = 0
      const body = new ReadableStream({
        start(value) { controller = value },
        pull(value) {
          if (++pulls === 1) { value.enqueue(new TextEncoder().encode('prefix')); return }
          pending++
          const task = work.promise.finally(() => { pending-- })
          tasks.push(task)
          return task
        }
      }, { highWaterMark: 0 })
      let stopped = false
      const stop = () => { if (!stopped) { stopped = true; controller.close() } }
      const server = createServer((req, res) => {
        req.on('error', () => undefined); res.on('error', () => undefined)
        if (req.url === '/early') req.once('data', () => {
          res.writeHead(429, { 'content-type': 'application/json', connection: 'close' })
          res.end('{}')
        })
        else { req.resume(); req.on('end', () => res.end('complete')) }
      })
      server.on('connection', socket => {
        sockets.add(socket)
        closures.push(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve() })))
      })
      const transport = (url, init) => {
        calls++
        const actual = { ...init, signal: AbortSignal.any([abort.signal, init.signal]) }
        Object.defineProperty(actual, 'dispatcher', { value: agent })
        return ${family === 'native' ? 'globalThis.fetch' : 'undiciFetch'}(url, actual)
      }
      const planner = new FetchPlanner(transport, { maxParallelLimit: 1, deadlineMs: 15000 })
      let handle
      const watchdog = setTimeout(() => failed.reject(new Error('WATCHDOG_BEFORE_RETRY_UPLOAD')), 10000)
      const run = async () => {
        server.listen(0, '127.0.0.1'); await once(server, 'listening')
        const base = 'http://127.0.0.1:' + server.address().port
        handle = planner.submit({
          method: 'POST', replay: { serverSafe: true, consumeSafe: true },
          prepare(ctx) {
            prepares++
            if (prepares === 1) {
              ctx.onDispose(async () => {
                disposals++; stop(); stopping.resolve(); await Promise.all(tasks)
                produced.resolve(); await dispose.promise
              })
              return { url: base + '/early', init: { body, duplex: 'half', redirect: 'error' } }
            }
            return { url: base + '/retry', init: { body: 'prefix', redirect: 'error' } }
          },
          async beforeRetry(ctx) { hooks++; entered.resolve(ctx); return await hookGate.promise },
          consume: response => response.text()
        })
        await stopping.promise
        assert.equal(pending, 1); assert.equal(hooks, 0); assert.equal(prepares, 1)
        assert.equal(planner.snapshot().sentActive, 1)
        work.resolve(); await produced.promise; await turn()
        assert.equal(pending, 0); assert.equal(hooks, 0); assert.equal(prepares, 1)
        dispose.resolve()
        const ctx = await entered.promise
        assert.equal(ctx.signal.aborted, false)
        assert.equal(ctx.status, 429)
        assert.equal(planner.snapshot().sentActive, 0)
        assert.equal(planner.snapshot().leasedAttempts, 1)
        hookGate.resolve({ type: 'allow' })
        assert.equal((await handle.result).value, 'complete')
        await handle.resourcesDone
        assert.equal(calls, 2); assert.equal(prepares, 2); assert.equal(hooks, 1); assert.equal(disposals, 1)
      }
      try { await Promise.race([run(), failed.promise]) }
      finally {
        clearTimeout(watchdog); stop(); work.resolve(); dispose.resolve(); hookGate.resolve({ type: 'allow' })
        handle?.abort(); abort.abort(); await Promise.all(tasks)
        if (handle) await Promise.allSettled([handle.result, handle.resourcesDone])
        server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
        await agent.close(); await Promise.all(closures)
        assert.equal(pending, 0); assert.equal(sockets.size, 0)
      }
      console.log('UPLOAD_HOOK_RELEASED')
    `
    const child = spawnSync(
      process.execPath,
      ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
      {
        encoding: 'utf8',
        timeout: 15000
      }
    )
    assert.ifError(child.error)
    assert.equal(child.signal, null, child.stdout + child.stderr)
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.match(child.stdout, /UPLOAD_HOOK_RELEASED/)
  })
}

test('Before retry allow rechecks revoked replay permission', async t => {
  createRuntime(t)
  const permission = { serverSafe: true, consumeSafe: true }
  let calls = 0
  let hooks = 0
  const planner = new FetchPlanner<typeof fetch>(() => {
    calls++
    return Promise.resolve(new Response(null, { status: 429 }))
  })
  const handle = planner.submit({
    method: 'POST',
    replay: permission,
    prepare: () => ({ url: '', init: {} }),
    beforeRetry: async () => {
      hooks++
      await Promise.resolve()
      permission.consumeSafe = false
      return { type: 'allow' }
    },
    consume: () => 1
  })
  await assert.rejects(handle.result, { code: 'HTTP_FAILED', status: 429 })
  await handle.resourcesDone
  assert.equal(hooks, 1)
  assert.equal(calls, 1)
  assert.equal(planner.snapshot().leasedAttempts, 0)
})

// Exercise the actual coordinator, rather than substituting retry-policy facts.
const origins = [
  '429',
  'transport',
  'brand',
  'arbitrary',
  'prepare',
  'prepare-brand',
  'schema',
  'decode',
  'timeout',
  'cleanup-failed',
  'cleanup-unknown',
  'errored-body',
  'exhausted',
  'deadline-budget',
  'foreign-brand',
  'expired-brand',
  'hook-brand'
] as const

for (const serverSafe of [false, true]) {
  for (const consumeSafe of [false, true]) {
    for (const origin of origins) {
      test(`Before retry eligibility ${Number(serverSafe)}${Number(consumeSafe)} ${origin}`, async t => {
        const clock = createRuntime(t)
        const canary = 'T86-private-url-body-error-value'
        const cause = new TypeError(canary)
        const pending = deferred<undefined>()
        const records: unknown[] = []
        const inits: object[] = []
        const bodies: object[] = []
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let thrown: unknown = cause
        let hooks = 0
        let prepares = 0
        let calls = 0
        let discards = 0
        let disposals = 0
        const rateLimit = ['429', 'cleanup-failed', 'exhausted', 'deadline-budget'].includes(origin)
        const beforeSend = ['prepare', 'prepare-brand', 'hook-brand'].includes(origin)
        const eligible = serverSafe && consumeSafe && ['429', 'transport', 'brand'].includes(origin)
        const planner = new FetchPlanner<typeof fetch>(
          () => {
            calls++
            if (origin === 'transport' && calls === 1) throw cause
            if (origin === 'errored-body' && calls === 1)
              return Promise.resolve(
                new Response(
                  new ReadableStream({
                    start(c) {
                      c.error(cause)
                    }
                  })
                )
              )
            return Promise.resolve(
              new Response(calls === 1 && rateLimit ? null : canary, {
                status: calls === 1 && rateLimit ? 429 : 200
              })
            )
          },
          {
            maxAttempts: origin === 'exhausted' ? 1 : 3,
            deadlineMs: origin === 'deadline-budget' ? 3000 : 120000
          }
        )
        planner.observe(e => {
          records.push(e)
        })
        const handle = planner.submit({
          method: 'POST',
          replay: { serverSafe, consumeSafe },
          prepare: ctx => {
            prepares++
            ctx.onDispose(() => {
              disposals++
              if (origin === 'cleanup-failed') throw cause
            })
            if (origin === 'prepare' || origin === 'prepare-brand') {
              if (origin === 'prepare-brand')
                thrown = new ConsumeReadFailure({ active: true }, cause)
              throw thrown
            }
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                c.close()
              }
            })
            const init = { body, duplex: 'half' as const }
            bodies.push(body)
            inits.push(init)
            return { url: canary, init }
          },
          beforeDispatch:
            origin === 'hook-brand'
              ? () => {
                  thrown = new ConsumeReadFailure({ active: true }, cause)
                  throw thrown
                }
              : undefined,
          beforeRetry: ctx => {
            hooks++
            assert.equal(disposals, 1, 'FULL_CLEANUP_BEFORE_HOOK')
            assert.equal(
              ctx.status,
              origin === 'transport' ? undefined : origin === 'brand' ? 200 : 429
            )
            assert.equal(ctx.dispatchCalls, 1)
            assert.equal(planner.snapshot().sentActive, 0)
            assert.equal(planner.snapshot().leasedAttempts, 1)
            return { type: 'allow' }
          },
          consume: async (response, ctx) => {
            if (ctx.attemptNumber === 2) return response.text()
            ctx.onDiscard(() => {
              discards++
            })
            if (origin === 'timeout') {
              await pending.promise
              return canary
            }
            if (origin === 'cleanup-unknown') {
              reader = response.body?.getReader()
              thrown = ctx.retryableReadFailure(cause)
            } else if (origin === 'errored-body') {
              try {
                await response.text()
              } catch (error) {
                assert.equal(error, cause)
                thrown = ctx.retryableReadFailure(error)
              }
            } else {
              await response.text()
              if (origin === 'brand') thrown = ctx.retryableReadFailure(cause)
              else if (origin === 'schema') thrown = new Error(canary)
              else if (origin === 'decode') {
                try {
                  JSON.parse(canary)
                } catch (error) {
                  thrown = error
                }
                assert.ok(thrown instanceof SyntaxError)
              } else if (origin === 'foreign-brand' || origin === 'expired-brand')
                thrown = new ConsumeReadFailure({ active: origin === 'foreign-brand' }, cause)
            }
            throw thrown
          }
        })
        handle.observe(e => {
          records.push(e)
        })
        void handle.result.catch(() => undefined)
        try {
          await clock.flush()
          if (origin === 'timeout') {
            await clock.advance(30000)
            pending.resolve(undefined)
          } else await clock.advance(3000)
          await clock.flush()
          assert.equal(hooks, eligible ? 1 : 0, 'T86_ONLY_ELIGIBLE_CANDIDATE_ENTERS_HOOK')
          if (eligible) {
            assert.equal((await handle.result).value, canary)
            assert.notEqual(inits[0], inits[1])
            assert.notEqual(bodies[0], bodies[1], 'FRESH_BODY_PER_ATTEMPT')
          } else
            await assert.rejects(handle.result, error => {
              assert.ok(error instanceof OperationError)
              assert.equal(
                error.code,
                origin === 'timeout'
                  ? 'ATTEMPT_TIMEOUT'
                  : origin === 'hook-brand'
                    ? 'HOOK_FAILED'
                    : beforeSend
                      ? 'PREPARE_FAILED'
                      : origin === 'transport'
                        ? 'TRANSPORT_FAILED'
                        : rateLimit
                          ? 'HTTP_FAILED'
                          : 'CONSUME_FAILED'
              )
              assert.equal(
                error.status,
                beforeSend || origin === 'transport' ? undefined : rateLimit ? 429 : 200
              )
              assert.equal(
                error.serverOutcome,
                beforeSend ? 'not-dispatched' : origin === 'transport' ? 'unknown' : 'http-response'
              )
              if (origin === 'hook-brand') {
                assert.ok(error.cause instanceof OperationError)
                assert.equal(error.cause.cause, thrown)
              } else if (origin !== 'timeout' && !rateLimit) assert.equal(error.cause, thrown)
              assert.equal(error.dispatchEntered, !beforeSend)
              return true
            })
          const summary = await handle.resourcesDone
          assert.equal(
            summary.resources,
            origin === 'cleanup-failed'
              ? 'failed'
              : origin === 'cleanup-unknown' || origin === 'errored-body'
                ? 'unknown'
                : 'released'
          )
          assert.equal(calls, beforeSend ? 0 : eligible ? 2 : 1)
          assert.equal(prepares, eligible ? 2 : 1)
          assert.equal(disposals, prepares)
          assert.equal(discards, !beforeSend && !rateLimit && origin !== 'transport' ? 1 : 0)
          assert.equal(handle.snapshot().resultCommitted, eligible)
          assert.equal(planner.snapshot().leasedAttempts, 0)
          assert.equal(planner.snapshot().sentActive, 0)
          assert.ok(
            !JSON.stringify([records, planner.snapshot(), handle.snapshot()]).includes(canary)
          )
        } finally {
          pending.resolve(undefined)
          reader?.releaseLock()
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }
}

for (const serverSafe of [false, true]) {
  for (const consumeSafe of [false, true]) {
    test(`Before retry non2xx matrix ${Number(serverSafe)}${Number(consumeSafe)} excludes every non429 status`, async t => {
      createRuntime(t)
      for (let status = 300; status < 600; status++) {
        if (status === 429) continue
        let hooks = 0
        let calls = 0
        let prepares = 0
        let discards = 0
        let thrown: Error | undefined
        const cause = new Error('T86-private-non2xx')
        const records: unknown[] = []
        const planner = new FetchPlanner<typeof fetch>(() => {
          calls++
          return Promise.resolve(
            new Response(status === 304 ? null : 'private-details', { status })
          )
        })
        const handle = planner.submit({
          method: 'POST',
          replay: { serverSafe, consumeSafe },
          prepare: () => {
            prepares++
            return { url: cause.message, init: {} }
          },
          beforeRetry: () => {
            hooks++
            return { type: 'allow' }
          },
          consume: async (response, ctx) => {
            assert.equal(await response.text(), status === 304 ? '' : 'private-details')
            ctx.onDiscard(() => {
              discards++
            })
            thrown = ctx.retryableReadFailure(cause)
            throw thrown
          }
        })
        handle.observe(e => {
          records.push(e)
        })
        try {
          await assert.rejects(handle.result, error => {
            assert.ok(error instanceof OperationError)
            assert.equal(error.code, 'CONSUME_FAILED')
            assert.equal(error.status, status)
            assert.equal(error.cause, thrown)
            assert.equal(error.serverOutcome, 'http-response')
            return true
          })
          assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
          assert.equal(hooks, 0, `NON2XX_${status}_MUST_NOT_CALL_RETRY_HOOK`)
          assert.deepEqual([calls, prepares, discards], [1, 1, 1])
          assert.equal(handle.snapshot().status, status)
          assert.ok(!JSON.stringify(records).includes('private'))
        } finally {
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      }
    })
  }
}

for (const origin of ['429', 'transport', 'brand'] as const) {
  for (const serverSafe of [false, true]) {
    for (const consumeSafe of [false, true]) {
      test(`Before retry ${origin} rechecks mutable replay ${Number(serverSafe)}${Number(consumeSafe)} after hook await`, async t => {
        const clock = createRuntime(t)
        const permission = { serverSafe: true, consumeSafe: true }
        const gate = deferred<Decision>()
        let hooks = 0
        let calls = 0
        let prepares = 0
        let discarded = 0
        let thrown: unknown
        const cause = new Error('T86-original-cause')
        const planner = new FetchPlanner<typeof fetch>(() => {
          calls++
          if (origin === 'transport' && calls === 1) throw cause
          return Promise.resolve(
            new Response(null, { status: calls === 1 && origin === '429' ? 429 : 200 })
          )
        })
        const handle = planner.submit({
          method: 'POST',
          replay: permission,
          prepare: () => {
            prepares++
            return { url: '', init: {} }
          },
          beforeRetry: async () => {
            hooks++
            return await gate.promise
          },
          consume: (_response, ctx) => {
            if (ctx.attemptNumber === 1 && origin === 'brand') {
              ctx.onDiscard(() => {
                discarded++
              })
              thrown = ctx.retryableReadFailure(cause)
              throw thrown
            }
            return 42
          }
        })
        void handle.result.catch(() => undefined)
        try {
          await clock.flush()
          assert.equal(hooks, 1)
          assert.equal(planner.snapshot().leasedAttempts, 1)
          permission.serverSafe = serverSafe
          permission.consumeSafe = consumeSafe
          gate.resolve({ type: 'allow' })
          await clock.flush()
          await clock.advance(3000)
          if (serverSafe && consumeSafe) assert.equal((await handle.result).value, 42)
          else
            await assert.rejects(handle.result, error => {
              assert.ok(error instanceof OperationError)
              assert.equal(
                error.code,
                origin === '429'
                  ? 'HTTP_FAILED'
                  : origin === 'transport'
                    ? 'TRANSPORT_FAILED'
                    : 'CONSUME_FAILED'
              )
              assert.equal(
                error.status,
                origin === '429' ? 429 : origin === 'brand' ? 200 : undefined
              )
              assert.equal(
                error.serverOutcome,
                origin === 'transport' ? 'unknown' : 'http-response'
              )
              assert.equal(error.cause, origin === 'transport' ? cause : thrown)
              return true
            })
          assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
          assert.equal(hooks, 1)
          assert.equal(
            calls,
            serverSafe && consumeSafe ? 2 : 1,
            'REVOKED_FLAGS_CANNOT_REPLAY_AFTER_AWAIT'
          )
          assert.equal(prepares, calls)
          assert.equal(discarded, origin === 'brand' ? 1 : 0)
        } finally {
          gate.resolve({ type: 'allow' })
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }
}

for (const origin of ['429', 'transport', 'brand'] as const) {
  for (const direction of ['revoke', 'grant'] as const) {
    for (const flag of ['serverSafe', 'consumeSafe'] as const) {
      test(`Before retry ${origin} ${direction} ${flag} during cleanup cannot bypass captured eligibility`, async t => {
        const clock = createRuntime(t)
        const permission = { serverSafe: true, consumeSafe: true }
        permission[flag] = direction === 'revoke'
        const cleanup = deferred<undefined>()
        let hooks = 0
        let calls = 0
        let disposals = 0
        const planner = new FetchPlanner<typeof fetch>(() => {
          calls++
          if (origin === 'transport') throw new Error('T86-transport')
          return Promise.resolve(new Response(null, { status: origin === '429' ? 429 : 200 }))
        })
        const handle = planner.submit({
          method: 'POST',
          replay: permission,
          prepare: ctx => {
            ctx.onDispose(async () => {
              disposals++
              await cleanup.promise
            })
            return { url: '', init: {} }
          },
          beforeRetry: () => {
            hooks++
            return { type: 'allow' }
          },
          consume: (_response, ctx) => {
            throw ctx.retryableReadFailure(new Error('T86-consume'))
          }
        })
        void handle.result.catch(() => undefined)
        try {
          await clock.flush()
          assert.equal(disposals, 1)
          assert.equal(hooks, 0)
          assert.equal(planner.snapshot().sentActive, 1)
          permission[flag] = direction === 'grant'
          cleanup.resolve(undefined)
          await clock.flush()
          await clock.advance(3000)
          await assert.rejects(handle.result, {
            code:
              origin === '429'
                ? 'HTTP_FAILED'
                : origin === 'transport'
                  ? 'TRANSPORT_FAILED'
                  : 'CONSUME_FAILED'
          })
          assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
          assert.equal(hooks, 0, 'CHANGED_FLAGS_DO_NOT_CREATE_A_CANDIDATE')
          assert.equal(calls, 1)
          assert.equal(handle.snapshot().attempts, 1)
        } finally {
          cleanup.resolve(undefined)
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }
}

for (const phase of ['cleanup', 'hook'] as const) {
  for (const mode of ['abort', 'stop', 'deadline', 'attempt'] as const) {
    test(`Before retry ${phase} ${mode} rechecks terminal state without timer delivery`, async t => {
      const clock = createRuntime(t)
      const gate = deferred<undefined>()
      const reason = new Error('T86-private-terminal-reason')
      let hooks = 0
      let calls = 0
      let prepares = 0
      let settled = 0
      let resources = 0
      const planner = new FetchPlanner<typeof fetch>(() => {
        calls++
        return Promise.resolve(new Response(null, { status: 429 }))
      })
      const handle = planner.submit({
        method: 'POST',
        replay,
        prepare: ctx => {
          prepares++
          if (phase === 'cleanup') ctx.onDispose(() => gate.promise)
          return { url: '', init: {} }
        },
        beforeRetry: async () => {
          hooks++
          await gate.promise
          return { type: 'allow' }
        },
        consume: () => 0
      })
      handle.observe(e => {
        if (e.type === 'operation-settled') settled++
      })
      void handle.resourcesDone.then(() => {
        resources++
      })
      void handle.result.catch(() => undefined)
      try {
        await clock.flush()
        assert.equal(hooks, phase === 'hook' ? 1 : 0)
        if (mode === 'abort') handle.abort(reason)
        else if (mode === 'stop') planner.stop(reason)
        else t.mock.method(performance, 'now', () => (mode === 'deadline' ? 1120000 : 1030000))
        gate.resolve(undefined)
        const code =
          mode === 'abort'
            ? 'ABORTED'
            : mode === 'stop'
              ? 'STOPPED'
              : mode === 'deadline'
                ? 'DEADLINE'
                : 'ATTEMPT_TIMEOUT'
        await assert.rejects(handle.result, error => {
          assert.ok(error instanceof OperationError)
          assert.equal(error.code, code)
          assert.equal(error.status, 429)
          assert.equal(error.dispatchEntered, true)
          assert.equal(error.serverOutcome, 'http-response')
          if (mode === 'abort' || mode === 'stop') assert.equal(error.cause, reason)
          return true
        })
        assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
        await clock.advance(10000)
        assert.deepEqual(
          [calls, prepares, hooks, settled, resources],
          [1, 1, phase === 'hook' ? 1 : 0, 1, 1]
        )
        assert.equal(handle.snapshot().resultCommitted, false)
        assert.equal(planner.snapshot().leasedAttempts, 0)
      } finally {
        gate.resolve(undefined)
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
}

for (const origin of ['429', 'transport'] as const) {
  test(`Before retry ${origin} exhausts the shared three attempt budget before another hook`, async t => {
    const clock = createRuntime(t)
    let calls = 0
    let hooks = 0
    let prepares = 0
    const cause = new Error('T86-exhaustion')
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      if (origin === 'transport') return Promise.reject(cause)
      return Promise.resolve(new Response(null, { status: 429 }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => {
        prepares++
        return { url: '', init: {} }
      },
      beforeRetry: ctx => {
        hooks++
        assert.equal(ctx.attemptNumber, hooks)
        return { type: 'allow' }
      },
      consume: () => 0
    })
    void handle.result.catch(() => undefined)
    try {
      await clock.flush()
      await clock.advance(3000)
      await clock.advance(6000)
      await assert.rejects(handle.result, error => {
        assert.ok(error instanceof OperationError)
        assert.equal(error.code, origin === '429' ? 'HTTP_FAILED' : 'TRANSPORT_FAILED')
        assert.equal(error.attemptNumber, 3)
        if (origin === 'transport') assert.equal(error.cause, cause)
        return true
      })
      assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
      assert.deepEqual([calls, prepares, hooks], [3, 3, 2])
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Before retry rejects a capability escaped from an actual previous consume lifetime', async t => {
  createRuntime(t)
  let escaped: Error | undefined
  let hooks = 0
  let calls = 0
  const cause = new Error('T86-escaped')
  const planner = new FetchPlanner<typeof fetch>(() => {
    calls++
    return Promise.resolve(new Response())
  })
  const first = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: (_response, ctx) => {
      escaped = ctx.retryableReadFailure(cause)
      return 1
    }
  })
  try {
    assert.equal((await first.result).value, 1)
    await first.resourcesDone
    const next = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      beforeRetry: () => {
        hooks++
        return { type: 'allow' }
      },
      consume: () => {
        assert.ok(escaped instanceof Error)
        throw escaped
      }
    })
    try {
      await assert.rejects(next.result, error => {
        assert.ok(error instanceof OperationError)
        assert.equal(error.code, 'CONSUME_FAILED')
        assert.equal(error.status, 200)
        assert.equal(error.cause, escaped)
        return true
      })
      await next.resourcesDone
      assert.equal(hooks, 0)
      assert.equal(calls, 2)
    } finally {
      next.abort()
      await Promise.allSettled([next.result, next.resourcesDone])
    }
  } finally {
    first.abort()
    await Promise.allSettled([first.result, first.resourcesDone])
  }
})

for (const [entry, Planner] of [
  ['root', RootPlanner],
  ['deep', FetchPlanner]
] as const) {
  for (const clockRead of [4, 5]) {
    for (const action of ['abort', 'stop', 'deadline', 'attempt'] as const) {
      test(`Before retry ${entry} rechecks ${action} at entry clock ${clockRead}`, async t => {
        createRuntime(t)
        let now = 1000000
        let clocks = 0
        let triggered = false
        let hooks = 0
        let calls = 0
        const reason = new Error('T86-entry-clock')
        const planner = new Planner<typeof fetch>(() => {
          calls++
          return Promise.resolve(new Response(null, { status: 429 }))
        })
        const handle = planner.submit({
          method: 'POST',
          replay: { serverSafe: true, consumeSafe: true },
          prepare: () => ({ url: '', init: {} }),
          consume: () => 0,
          beforeRetry: () => {
            hooks++
            return { type: 'allow' }
          }
        })
        t.mock.method(performance, 'now', () => {
          if (
            !triggered &&
            hooks === 0 &&
            handle.snapshot().status === 429 &&
            planner.snapshot().sentActive === 0 &&
            planner.snapshot().leasedAttempts === 1 &&
            ++clocks === clockRead
          ) {
            triggered = true
            if (action === 'abort') handle.abort(reason)
            else if (action === 'stop') planner.stop(reason)
            else now = action === 'deadline' ? 1120000 : 1030000
          }
          return now
        })
        try {
          await assert.rejects(handle.result, error => {
            assert.ok(error instanceof OperationError)
            assert.equal(
              error.code,
              action === 'abort'
                ? 'ABORTED'
                : action === 'stop'
                  ? 'STOPPED'
                  : action === 'deadline'
                    ? 'DEADLINE'
                    : 'ATTEMPT_TIMEOUT'
            )
            assert.equal(error.dispatchEntered, true)
            assert.equal(error.status, 429)
            assert.equal(error.serverOutcome, 'http-response')
            if (action === 'abort' || action === 'stop') assert.equal(error.cause, reason)
            return true
          })
          assert.equal(triggered, true, 'ENTRY_CLOCK_RACE_MUST_RUN')
          assert.equal(calls, 1)
          assert.equal(hooks, 0, 'TERMINAL_OPERATION_MUST_NOT_ENTER_RETRY_HOOK')
          assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
          assert.equal(planner.snapshot().leasedAttempts, 0)
        } finally {
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }

  for (const origin of ['429', 'transport', 'brand'] as const) {
    for (const flag of ['serverSafe', 'consumeSafe'] as const) {
      for (const source of ['random', 'clock', 'control'] as const) {
        test(`Before retry ${entry} rechecks ${flag} after ${source} policy materialization ${origin}`, async t => {
          const clock = createRuntime(t)
          const permission = { serverSafe: true, consumeSafe: true }
          const cause = new Error('T86-post-hook-permission')
          let brand: Error | undefined
          let calls = 0
          let prepares = 0
          let hooks = 0
          let returned = false
          let sampled = false
          let affected = false
          const planner = new Planner<typeof fetch>(() => {
            calls++
            if (calls === 1 && origin === 'transport') throw cause
            return Promise.resolve(
              new Response(null, { status: calls === 1 && origin === '429' ? 429 : 200 })
            )
          })
          t.mock.method(Math, 'random', () => {
            if (returned && !sampled) {
              sampled = true
              if (source !== 'clock') {
                affected = true
                if (source === 'random') permission[flag] = false
              }
            }
            return 0.5
          })
          t.mock.method(performance, 'now', () => {
            if (sampled && !affected && source === 'clock') {
              affected = true
              permission[flag] = false
            }
            return 1000000
          })
          const handle = planner.submit({
            method: 'POST',
            replay: permission,
            prepare: () => {
              prepares++
              return { url: '', init: {} }
            },
            consume: (_response, ctx) => {
              if (origin === 'brand' && ctx.attemptNumber === 1) {
                brand = ctx.retryableReadFailure(cause)
                throw brand
              }
              return 7
            },
            beforeRetry: () => {
              hooks++
              returned = true
              return { type: 'allow' }
            }
          })
          // Observe an expected terminal result before draining asynchronous work.
          void handle.result.catch(() => undefined)
          try {
            await clock.flush()
            // Restore the clock before advancing the normal retry floor.
            t.mock.method(performance, 'now', () => 1003000)
            await clock.advance(3000)
            assert.equal(affected, true, 'POST_HOOK_POLICY_RACE_MUST_RUN')
            assert.equal(hooks, 1)
            if (source === 'control') assert.equal((await handle.result).value, 7)
            else {
              await assert.rejects(handle.result, error => {
                assert.ok(error instanceof OperationError)
                assert.equal(
                  error.code,
                  origin === '429'
                    ? 'HTTP_FAILED'
                    : origin === 'transport'
                      ? 'TRANSPORT_FAILED'
                      : 'CONSUME_FAILED'
                )
                assert.equal(error.dispatchEntered, true)
                if (origin !== '429') assert.equal(error.cause, origin === 'brand' ? brand : cause)
                if (origin !== 'transport') assert.equal(error.status, origin === '429' ? 429 : 200)
                return true
              })
            }
            assert.equal(
              calls,
              source === 'control' ? 2 : 1,
              'REVOKED_PERMISSION_MUST_PREVENT_SECOND_DISPATCH'
            )
            assert.equal(prepares, source === 'control' ? 2 : 1)
            assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
          } finally {
            handle.abort()
            await Promise.allSettled([handle.result, handle.resourcesDone])
          }
        })
      }
    }
  }
}
