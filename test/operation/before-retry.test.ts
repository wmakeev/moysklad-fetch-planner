import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { FetchPlanner } from '../../src/planner.js'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import { OperationError, type Decision, type HookContext } from '../../src/operation-types.js'
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
