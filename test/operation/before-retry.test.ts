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

for (const kind of ['deny', 'throw', 'reject', 'invalid'] as const) {
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

for (const [entry, Planner] of [
  ['root', RootPlanner],
  ['deep', FetchPlanner]
] as const) {
  for (const delay of [0, 5, 30]) {
    for (const spent of [0, 7]) {
      test(`Before retry ${entry} frozen policy20 and defer${delay} after hook wait${spent}`, async t => {
        const clock = createRuntime(t)
        const timers = trackTimeouts(t)
        const gate = deferred<Decision>()
        let calls = 0
        let prepares = 0
        let hooks = 0
        let dispatchHooks = 0
        let resources = 0
        const inits: object[] = []
        const signals: AbortSignal[] = []
        const planner = new Planner<typeof fetch>(() => {
          calls++
          return Promise.resolve(
            new Response(null, {
              headers: calls === 1 ? { 'x-lognex-retry-after': '20' } : {}
            })
          )
        })
        const handle = planner.submit({
          method: 'POST',
          replay,
          prepare: ctx => {
            prepares++
            const init = { body: 'same logical payload' }
            inits.push(init)
            signals.push(ctx.signal)
            return { url: '', init }
          },
          beforeDispatch: () => {
            dispatchHooks++
            return { type: 'allow' }
          },
          beforeRetry: async () => {
            hooks++
            return await gate.promise
          },
          consume: (_response, ctx) => {
            if (ctx.attemptNumber === 1) throw ctx.retryableReadFailure(new Error('read'))
            return 42
          }
        })
        void handle.resourcesDone.then(() => {
          resources++
        })
        try {
          await clock.flush()
          assert.equal(hooks, 1)
          assert.deepEqual([calls, prepares, planner.snapshot().leasedAttempts], [1, 1, 1])
          await clock.advance(spent)
          gate.resolve(delay === 0 ? { type: 'allow' } : { type: 'defer', delayMs: delay })
          await clock.flush()
          assert.deepEqual(
            [planner.snapshot().leasedAttempts, planner.snapshot().sentActive, resources],
            [0, 0, 0]
          )
          const floor = Math.max(20, spent + delay)
          await clock.advance(floor - spent - 1)
          assert.equal(calls, 1, 'FROZEN_POLICY_AND_HOOK_FLOORS_PREVENT_EARLY_TRANSPORT')
          assert.equal(prepares, 1, 'NO_PREPARE_BEFORE_RETRY_FLOOR')
          await clock.advance(1)
          assert.equal((await handle.result).value, 42)
          assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
          assert.deepEqual([calls, prepares, hooks, dispatchHooks, resources], [2, 2, 1, 2, 1])
          assert.notEqual(inits[0], inits[1])
          assert.notEqual(signals[0], signals[1])
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

for (const delay of [5, 4000]) {
  test(`Before retry actual429 keeps default fallback3000 with defer${delay}`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<Decision>()
    let calls = 0
    let prepares = 0
    let hooks = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response(null, { status: calls === 1 ? 429 : 200 }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => {
        prepares++
        return { url: '', init: {} }
      },
      beforeRetry: async () => {
        hooks++
        return await gate.promise
      },
      consume: () => 42
    })
    try {
      await clock.flush()
      await clock.advance(100)
      // A new fallback sample must not shorten the frozen 3000ms floor.
      clock.setRandom(0)
      gate.resolve({ type: 'defer', delayMs: delay })
      await clock.flush()
      assert.equal(planner.snapshot().leasedAttempts, 0)
      const floor = Math.max(3000, 100 + delay)
      await clock.advance(floor - 101)
      assert.deepEqual([calls, prepares, hooks], [1, 1, 1], 'DEFAULT_429_FLOOR_STILL_ACTIVE')
      await clock.advance(1)
      assert.equal((await handle.result).value, 42)
      await handle.resourcesDone
      assert.deepEqual([calls, prepares, hooks], [2, 2, 1])
    } finally {
      gate.resolve({ type: 'allow' })
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const delayMs of [
  0,
  -1,
  0.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1
]) {
  test(`Before retry invalid defer ${String(delayMs)} remains terminal`, async t => {
    createRuntime(t)
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response(null, { status: 429 }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: {} }),
      beforeRetry: () => ({ type: 'defer', delayMs }),
      consume: () => 0
    })
    try {
      await assert.rejects(handle.result, { code: 'HOOK_FAILED', status: 429 })
      await handle.resourcesDone
      assert.equal(calls, 1)
      assert.equal(planner.snapshot().leasedAttempts, 0)
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Before retry defer with extra keys remains terminal', async t => {
  createRuntime(t)
  let calls = 0
  const planner = new FetchPlanner<typeof fetch>(() => {
    calls++
    return Promise.resolve(new Response(null, { status: 429 }))
  })
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    beforeRetry: () => ({ type: 'defer', delayMs: 5, extra: true }),
    consume: () => 0
  })
  await assert.rejects(handle.result, { code: 'HOOK_FAILED' })
  await handle.resourcesDone
  assert.equal(calls, 1)
})

for (const mode of ['abort', 'stop', 'deadline'] as const) {
  test(`Before retry defer sleep ${mode} cancels without another prepare`, async t => {
    const clock = createRuntime(t)
    let calls = 0
    let prepares = 0
    let resources = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(new Response(null, { status: calls === 1 ? 429 : 200 }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      ...(mode === 'deadline' ? { deadlineMs: 5000 } : {}),
      prepare: () => {
        prepares++
        return { url: '', init: {} }
      },
      beforeRetry: () => ({ type: 'defer', delayMs: 4000 }),
      consume: () => 42
    })
    void handle.result.catch(() => undefined)
    void handle.resourcesDone.then(() => {
      resources++
    })
    try {
      await clock.flush()
      assert.equal(handle.snapshot().phase, 'retry-wait')
      assert.deepEqual(
        [planner.snapshot().leasedAttempts, planner.snapshot().sentActive, resources],
        [0, 0, 0]
      )
      if (mode === 'abort') handle.abort()
      else if (mode === 'stop') planner.stop()
      else clock.tick(5000)
      await assert.rejects(handle.result, {
        code: mode === 'abort' ? 'ABORTED' : mode === 'stop' ? 'STOPPED' : 'DEADLINE'
      })
      await handle.resourcesDone
      await clock.advance(5000)
      assert.deepEqual([calls, prepares, resources], [1, 1, 1])
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const queuedLimit of [1, 2]) {
  test(`Before retry defer reserves bounded FIFO with Q${queuedLimit} observer burst`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<Decision>()
    const order: string[] = []
    let calls = 0
    let hooks = 0
    let rejectedPrepares = 0
    let burst = 0
    const rejected: Promise<unknown>[] = []
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        calls++
        return Promise.resolve(new Response(null, { status: calls === 1 ? 429 : 200 }))
      },
      { maxParallelLimit: 1, maxQueuedOperations: queuedLimit }
    )
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        order.push(`retry${ctx.attemptNumber}`)
        return { url: '', init: {} }
      },
      beforeRetry: async () => {
        hooks++
        return await gate.promise
      },
      consume: () => 42
    })
    await clock.flush()
    const sibling = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        order.push('sibling')
        return { url: '', init: {} }
      },
      consume: () => 7
    })
    handle.observe(event => {
      if (event.type !== 'retry-scheduled') return
      for (let i = 0; i < 100; i++) {
        burst++
        const excess = planner.submit({
          method: 'GET',
          replay,
          prepare: () => {
            rejectedPrepares++
            return { url: '', init: {} }
          },
          consume: () => 0
        })
        rejected.push(assert.rejects(excess.result, { code: 'QUEUE_FULL' }), excess.resourcesDone)
      }
    })
    void handle.result.catch(() => undefined)
    try {
      assert.equal(hooks, 1)
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.deepEqual(order, ['retry1'])
      gate.resolve({ type: 'defer', delayMs: 4000 })
      await clock.flush()
      if (queuedLimit === 1) {
        await assert.rejects(handle.result, { code: 'QUEUE_FULL' })
        await handle.resourcesDone
        assert.equal(burst, 0)
      } else {
        assert.equal(handle.snapshot().phase, 'retry-wait')
        assert.equal(burst, 100)
        await Promise.all(rejected)
      }
      await clock.advance(3000)
      assert.equal((await sibling.result).value, 7)
      await sibling.resourcesDone
      assert.equal(planner.snapshot().leasedAttempts, 0)
      assert.deepEqual(order, ['retry1', 'sibling'])
      await clock.advance(1000)
      if (queuedLimit === 2) {
        assert.equal((await handle.result).value, 42)
        await handle.resourcesDone
        assert.deepEqual(order, ['retry1', 'sibling', 'retry2'])
      }
      assert.equal(rejectedPrepares, 0)
      assert.equal(hooks, 1)
      assert.equal(planner.snapshot().queued, 0)
      assert.equal(planner.snapshot().leasedAttempts, 0)
    } finally {
      gate.resolve({ type: 'allow' })
      handle.abort()
      sibling.abort()
      await Promise.allSettled([
        handle.result,
        handle.resourcesDone,
        sibling.result,
        sibling.resourcesDone,
        ...rejected
      ])
    }
  })
}

for (const phase of ['hook', 'sleep'] as const) {
  test(`Before retry defer preserves increasing out of order receipt floors during ${phase}`, async t => {
    const clock = createRuntime(t)
    const hook = deferred<Decision>()
    const early = deferred<Response>()
    const late = deferred<Response>()
    let calls = 0
    let retryCalls = 0
    let prepares = 0
    let hooks = 0
    const planner = new FetchPlanner<typeof fetch>(url => {
      calls++
      if (url === 'early') return early.promise
      if (url === 'late') return late.promise
      retryCalls++
      return Promise.resolve(
        new Response(null, {
          headers: retryCalls === 1 ? { 'x-lognex-retry-after': '20' } : {}
        })
      )
    })
    const sibling = (url: string) =>
      planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: () => 1
      })
    const first = sibling('early')
    const last = sibling('late')
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => {
        prepares++
        return { url: 'retry', init: {} }
      },
      beforeRetry: async () => {
        hooks++
        return await hook.promise
      },
      consume: (_response, ctx) => {
        if (ctx.attemptNumber === 1) throw ctx.retryableReadFailure(new Error('read'))
        return 42
      }
    })
    try {
      await clock.flush()
      assert.equal(calls, 3)
      assert.equal(hooks, 1)
      if (phase === 'sleep') {
        hook.resolve({ type: 'defer', delayMs: 30 })
        await clock.flush()
      }
      await clock.advance(5)
      early.resolve(new Response(null, { headers: { 'x-lognex-retry-after': '50' } }))
      await first.result
      await first.resourcesDone
      await clock.advance(5)
      late.resolve(new Response(null, { headers: { 'x-lognex-retry-after': '1' } }))
      await last.result
      await last.resourcesDone
      if (phase === 'hook') {
        hook.resolve({ type: 'defer', delayMs: 30 })
        await clock.flush()
      }
      await clock.advance(44)
      assert.equal(retryCalls, 1, 'UPDATED_RECEIPT_FLOOR_CANNOT_DECREASE')
      await clock.advance(1)
      assert.equal((await handle.result).value, 42)
      await handle.resourcesDone
      assert.deepEqual([retryCalls, prepares, hooks], [2, 2, 1])
    } finally {
      early.resolve(new Response())
      late.resolve(new Response())
      hook.resolve({ type: 'allow' })
      for (const item of [handle, first, last]) item.abort()
      await Promise.allSettled([
        handle.result,
        handle.resourcesDone,
        first.result,
        first.resourcesDone,
        last.result,
        last.resourcesDone
      ])
    }
  })
}

test('Before retry Q1 sleep reservation rejects observer burst without hidden backlog', async t => {
  const clock = createRuntime(t)
  let calls = 0
  let rejectedPrepares = 0
  let burst = 0
  const rejected: Promise<unknown>[] = []
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      calls++
      return Promise.resolve(new Response(null, { status: calls === 1 ? 429 : 200 }))
    },
    { maxParallelLimit: 1, maxQueuedOperations: 1 }
  )
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    beforeRetry: () => ({ type: 'defer', delayMs: 4000 }),
    consume: () => 42
  })
  handle.observe(event => {
    if (event.type !== 'retry-scheduled') return
    for (let i = 0; i < 100; i++) {
      burst++
      const excess = planner.submit({
        method: 'GET',
        replay,
        prepare: () => {
          rejectedPrepares++
          return { url: '', init: {} }
        },
        consume: () => 0
      })
      rejected.push(assert.rejects(excess.result, { code: 'QUEUE_FULL' }), excess.resourcesDone)
    }
  })
  try {
    await clock.flush()
    await Promise.all(rejected)
    assert.equal(burst, 100)
    assert.equal(planner.snapshot().queued, 1)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(rejectedPrepares, 0)
    await clock.advance(3999)
    assert.equal(calls, 1)
    await clock.advance(1)
    assert.equal((await handle.result).value, 42)
    await handle.resourcesDone
    assert.equal(calls, 2)
    assert.equal(rejectedPrepares, 0)
    assert.equal(planner.snapshot().queued, 0)
    assert.equal(planner.snapshot().leasedAttempts, 0)
  } finally {
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone, ...rejected])
  }
})

// T22 circle-three reproducer: the second (subclass: third) read starts a
// pending outer return assimilation. Only the fixture counts reads.
for (const form of ['thenable', 'promise-subclass'] as const) {
  for (const mode of ['normal', 'invalid', 'timeout', 'abort', 'stop', 'deadline'] as const) {
    test(`T90 full chain beforeRetry ${form} ${mode} retains owning lifetime`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const entered = deferred<undefined>()
      const gate = deferred<undefined>()
      const steps = Array.from({ length: 12 }, () => ({
        entered: deferred<undefined>(),
        release: deferred<undefined>()
      }))
      const materialized = deferred<undefined>()
      let context: HookContext | undefined
      let reads = 0
      let hooks = 0
      let prepares = 0
      let childPrepares = 0
      let siblingPrepares = 0
      let disposals = 0
      let deliveries = 0
      let discards = 0
      let uploadStops = 0
      let registryClosed = false
      let capturedBrand = false
      let retrySchedules = 0
      const inits: object[] = []
      const bodies: object[] = []
      const signals: AbortSignal[] = []
      const dispatchContexts: HookContext[] = []
      const payloads: string[] = []
      const order: string[] = []
      const retryBoundary: { resources: string; settlements: number; lease: number }[] = []
      let settlements = 0
      let resourceSettlements = 0
      const sends: string[] = []
      const events: unknown[] = []
      const jobs: Promise<void>[] = []
      const planner = new FetchPlanner<typeof fetch>(
        (url, init) => {
          assert.equal(typeof url, 'string')
          if (typeof url !== 'string') throw new Error('T90 expects materialized string URL')
          sends.push(url)
          if (url === 'T90-private-target') {
            assert.equal(init?.method, 'POST')
            order.push(`dispatch${sends.filter(value => value === url).length}`)
          }
          return Promise.resolve(new Response('T90-private-value'))
        },
        { maxParallelLimit: 1 }
      )
      const children: ReturnType<typeof planner.submit>[] = []
      const probes: {
        stage: string
        id: number
        outcome: Promise<string>
        lease: number
        sent: number
        resources: number
        sibling: number
      }[] = []
      // Assertions stay outside callbacks: a callback assertion would be wrapped
      // as HOOK_FAILED and could conceal the actual accepted nested submit.
      const inspect = (stage: string) => {
        const child = planner.submit({
          method: 'GET',
          replay,
          prepare: () => {
            childPrepares++
            return { url: 'T90-private-child', init: {} }
          },
          consume: () => 2
        })
        children.push(child)
        const outcome = child.result.then(
          () => 'accepted',
          (error: unknown) => (error instanceof OperationError ? error.code : 'unexpected-error')
        )
        const snapshot = planner.snapshot()
        probes.push({
          stage,
          id: child.id,
          outcome,
          lease: snapshot.leasedAttempts,
          sent: snapshot.sentActive,
          resources: resourceSettlements,
          sibling: siblingPrepares
        })
      }
      const final: Decision = {
        get type() {
          inspect('final materialization')
          materialized.resolve(undefined)
          return 'allow' as const
        },
        ...(mode === 'invalid' ? { extra: 'T90-private-invalid' } : {})
      }
      const chain = (index: number): Decision => {
        const step = steps[index]
        if (!step) return final
        const value: Decision = { type: 'allow' }
        Object.setPrototypeOf(value, {
          get then() {
            inspect(`chain getter ${index}`)
            return (resolve: (value: Decision) => void) => {
              inspect(`chain job ${index}`)
              step.entered.resolve(undefined)
              jobs.push(
                step.release.promise.then(() => {
                  resolve(chain(index + 1))
                })
              )
            }
          }
        })
        return value
      }
      const stateful: Decision = { type: 'allow' }
      Object.setPrototypeOf(stateful, {
        get then() {
          inspect(`stateful getter ${++reads}`)
          if (reads !== (form === 'thenable' ? 2 : 3)) return undefined
          return (resolve: (value: Decision) => void) => {
            inspect('pending outer assimilation')
            entered.resolve(undefined)
            jobs.push(
              gate.promise.then(() => {
                resolve(chain(0))
              })
            )
          }
        }
      })
      const handle = planner.submit({
        method: 'POST',
        replay,
        ...(mode === 'deadline' ? { deadlineMs: 800 } : {}),
        prepare: ctx => {
          prepares++
          order.push(`prepare${ctx.attemptNumber}`)
          signals.push(ctx.signal)
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('T90-private-body'))
              controller.close()
            }
          })
          bodies.push(body)
          const init = { body, duplex: 'half' as const }
          inits.push(init)
          ctx.onDispose(async () => {
            // This fixture owns no hidden producer work. Wait for its actual
            // stream EOF; successful cleanup confirms the known upload work.
            payloads.push(await new Response(body).text())
            uploadStops++
          })
          ctx.onDispose(() => {
            disposals++
            if (ctx.attemptNumber === 1) registryClosed = true
          })
          return { url: 'T90-private-target', init }
        },
        beforeDispatch: ctx => {
          dispatchContexts.push(ctx)
          order.push(`beforeDispatch${ctx.attemptNumber}`)
          return { type: 'allow' }
        },
        beforeRetry: ctx => {
          hooks++
          context = ctx
          inspect('hook body')
          if (form === 'promise-subclass') {
            class HookPromise extends Promise<Decision> {}
            return new HookPromise(resolve => {
              resolve(stateful)
            })
          }
          const wrapper: Decision = { type: 'allow' }
          Object.defineProperty(wrapper, 'then', {
            value: (resolve: (value: Decision) => void) => {
              inspect('initial resolving thenable')
              resolve(stateful)
            }
          })
          return wrapper
        },
        consume: async (response, ctx) => {
          const value = await response.text()
          if (ctx.attemptNumber === 1) {
            ctx.onDiscard(() => {
              discards++
            })
            const failure = ctx.retryableReadFailure(new Error('T90-private-read'))
            capturedBrand = failure instanceof ConsumeReadFailure
            throw failure
          }
          deliveries++
          return value
        }
      })
      const result = handle.result.then(
        value => value,
        (error: unknown) => {
          assert.ok(error instanceof OperationError)
          return error
        }
      )
      const resources = handle.resourcesDone.then(value => {
        resourceSettlements++
        return value
      })
      handle.observe(event => {
        events.push(event)
        if (event.type === 'retry-scheduled') {
          retrySchedules++
          retryBoundary.push({
            resources: handle.snapshot().resources,
            settlements: resourceSettlements,
            lease: planner.snapshot().leasedAttempts
          })
        }
        if (event.type === 'operation-settled') settlements++
      })
      const sibling = planner.submit({
        method: 'GET',
        replay,
        prepare: () => {
          siblingPrepares++
          return { url: 'T90-private-sibling', init: {} }
        },
        consume: () => 3
      })
      const siblingResult = sibling.result.then(
        value => value,
        (error: unknown) => {
          assert.ok(error instanceof OperationError)
          return error
        }
      )
      const assertProbes = async () => {
        for (const probe of probes) {
          assert.equal(probe.id, 0, `T90_NESTED_ACCEPTED: ${probe.stage}`)
          assert.equal(await probe.outcome, 'REENTRANT_OPERATION', probe.stage)
          assert.equal(probe.lease, 1, probe.stage)
          assert.equal(probe.sent, 0, probe.stage)
          assert.equal(probe.resources, 0, probe.stage)
          assert.equal(probe.sibling, 0, probe.stage)
        }
        assert.equal(childPrepares, 0)
      }
      const assertPending = () => {
        assert.equal(planner.snapshot().leasedAttempts, 1)
        assert.equal(planner.snapshot().sentActive, 0)
        assert.equal(handle.snapshot().resources, 'pending')
        assert.equal(resourceSettlements, 0)
        assert.equal(siblingPrepares, 0)
        assert.equal(disposals, 1)
        assert.equal(discards, 1)
        assert.equal(uploadStops, 1)
        assert.equal(registryClosed, true)
        assert.equal(capturedBrand, true)
        assert.deepEqual(sends, ['T90-private-target'])
        assert.equal(prepares, 1)
        assert.equal(deliveries, 0)
      }
      try {
        await entered.promise
        assert.equal(reads, form === 'thenable' ? 2 : 3, 'ORIGINAL_PENDING_STEP_ENTERED')
        assert.equal(handle.snapshot().outcome, 'pending')
        assert.ok(context)
        assert.ok(Object.isFrozen(context))
        assert.ok(Object.isFrozen(context.snapshot))
        assert.equal(context.status, 200)
        assert.equal(context.attemptNumber, 1)
        assert.equal(context.dispatchCalls, 1)
        assert.equal(context.snapshot.dispatchEntered, true)
        assert.equal(context.snapshot.resources, 'pending')
        assert.equal(context.signal.aborted, false)
        assert.ok(sibling.id > 0, 'EXTERNAL_SIBLING_ACCEPTED')
        assert.equal(planner.snapshot().queued, 1)
        assert.equal(timers.delays.at(-1), mode === 'deadline' ? 800 : 1000)
        assertPending()
        await assertProbes()
        const code =
          mode === 'timeout'
            ? 'HOOK_FAILED'
            : mode === 'abort'
              ? 'ABORTED'
              : mode === 'stop'
                ? 'STOPPED'
                : mode === 'deadline'
                  ? 'DEADLINE'
                  : undefined
        if (mode === 'abort') handle.abort('T90-private-abort')
        else if (mode === 'stop') planner.stop('T90-private-stop')
        else if (mode === 'timeout' || mode === 'deadline') {
          await clock.advance(mode === 'timeout' ? 999 : 799)
          assert.equal(handle.snapshot().outcome, 'pending')
          assert.equal(context.signal.aborted, false)
          await clock.advance(1)
        }
        let primary: unknown
        if (code) {
          primary = await result
          assert.ok(primary instanceof OperationError)
          assert.equal(primary.code, code)
          assert.equal(primary.dispatchEntered, true)
          assert.equal(primary.serverOutcome, 'http-response')
          assert.equal(primary.status, 200)
          assert.equal(context.signal.aborted, true)
        }
        assertPending()
        gate.resolve(undefined)
        for (const step of steps) {
          await step.entered.promise
          assertPending()
          await assertProbes()
          step.release.resolve(undefined)
        }
        await materialized.promise
        await assertProbes()
        if (mode === 'normal') {
          await clock.flush()
          assert.equal(handle.snapshot().phase, 'retry-wait')
          assert.equal(resourceSettlements, 0)
          assert.equal(handle.snapshot().resources, 'pending')
          await clock.advance(3000)
        }
        const completed = await result
        if (primary) assert.equal(completed, primary, 'LATE_ALLOW_PRESERVES_PRIMARY_FAILURE')
        else if (mode === 'invalid') {
          assert.ok(completed instanceof OperationError)
          assert.equal(completed.code, 'HOOK_FAILED')
          assert.equal(completed.serverOutcome, 'http-response')
          assert.equal(completed.status, 200)
          assert.equal(completed.dispatchEntered, true)
          assert.ok(completed.cause instanceof OperationError)
          assert.ok(completed.cause.cause instanceof TypeError)
        } else {
          assert.ok(!(completed instanceof Error))
          assert.equal(completed.value, 'T90-private-value')
          assert.equal(completed.status, 200)
        }
        await resources
        await assertProbes()
        const peer = await siblingResult
        if (mode === 'stop') {
          assert.ok(peer instanceof OperationError)
          assert.equal(peer.code, 'STOPPED')
        } else {
          assert.ok(!(peer instanceof Error))
          assert.equal(peer.value, 3)
        }
        await sibling.resourcesDone
        assert.equal(siblingPrepares, mode === 'stop' ? 0 : 1)
        assert.deepEqual(sends, [
          'T90-private-target',
          ...(mode === 'stop' ? [] : ['T90-private-sibling']),
          ...(mode === 'normal' ? ['T90-private-target'] : [])
        ])
        assert.equal(handle.snapshot().dispatchCalls, mode === 'normal' ? 2 : 1)
        assert.equal(handle.snapshot().attempts, mode === 'normal' ? 2 : 1)
        assert.equal(deliveries, mode === 'normal' ? 1 : 0)
        assert.equal(hooks, 1)
        assert.equal(prepares, mode === 'normal' ? 2 : 1)
        assert.equal(disposals, prepares)
        assert.equal(uploadStops, prepares)
        assert.equal(discards, 1)
        assert.deepEqual(
          payloads,
          Array.from({ length: prepares }, () => 'T90-private-body')
        )
        assert.equal(dispatchContexts.length, prepares)
        assert.equal(retrySchedules, mode === 'normal' ? 1 : 0)
        assert.deepEqual(
          retryBoundary,
          mode === 'normal' ? [{ resources: 'pending', settlements: 0, lease: 0 }] : []
        )
        if (mode === 'normal') {
          assert.notEqual(inits[0], inits[1])
          assert.notEqual(bodies[0], bodies[1])
          assert.notEqual(signals[0], signals[1])
          assert.notEqual(dispatchContexts[0]?.signal, dispatchContexts[1]?.signal)
          assert.notEqual(context.signal, signals[0])
          assert.deepEqual(order, [
            'prepare1',
            'beforeDispatch1',
            'dispatch1',
            'prepare2',
            'beforeDispatch2',
            'dispatch2'
          ])
        }
        assert.equal(settlements, 1)
        assert.equal(resourceSettlements, 1)
        assert.equal((await resources).resources, 'released')
        assert.equal(planner.snapshot().stopped, mode === 'stop')
        const stable = handle.snapshot()
        await clock.advance(5000)
        assert.deepEqual(handle.snapshot(), stable, 'NO_LATE_RESURRECTION')
        assert.equal(await result, completed)
        if (mode === 'stop') {
          const stopped = planner.submit({
            method: 'GET',
            replay,
            prepare: () => ({ url: '', init: {} }),
            consume: () => 0
          })
          await assert.rejects(stopped.result, { code: 'STOPPED' })
          await stopped.resourcesDone
        }
        assert.equal(JSON.stringify(events).includes('T90-private'), false)
        assert.equal(probes.filter(probe => probe.stage.startsWith('chain getter')).length, 12)
        assert.equal(probes.filter(probe => probe.stage.startsWith('chain job')).length, 12)
        assert.equal(probes.filter(probe => probe.stage === 'final materialization').length, 1)
        console.log(
          'T90_CAUSAL',
          JSON.stringify({
            form,
            mode,
            reads,
            stages: probes.map(probe => probe.stage),
            sends,
            settlements,
            resourceSettlements,
            disposals,
            uploadStops,
            discards,
            order,
            retryBoundary
          })
        )
      } finally {
        gate.resolve(undefined)
        for (const step of steps) step.release.resolve(undefined)
        handle.abort()
        sibling.abort()
        for (const child of children) child.abort()
        await Promise.allSettled([result, resources, siblingResult, sibling.resourcesDone])
        await Promise.all(jobs)
        await Promise.allSettled(children.flatMap(child => [child.result, child.resourcesDone]))
        assert.equal(planner.snapshot().leasedAttempts, 0)
        assert.equal(planner.snapshot().sentActive, 0)
        assert.equal(timers.active.size, 0)
        assert.ok(timers.maximum() <= 1)
      }
    })
  }
}
