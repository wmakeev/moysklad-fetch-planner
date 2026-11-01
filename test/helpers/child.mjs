import assert from 'node:assert/strict'
import { OperationObservation } from '../../src/operation-observation.js'
import { setTimeout as delay, setImmediate as immediate } from 'node:timers/promises'
import { Agent, fetch, Response } from 'undici'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { FetchPlanner, OperationError } from '../../src/index.js'

const scenario = process.argv[2]
const noReplay = { serverSafe: false, consumeSafe: false }
const replay = { serverSafe: true, consumeSafe: true }
if (scenario === 'cleanup-loopback') await cleanupLoopback()
else if (scenario === 'native-fetch-contract') await nativeContract()
else await lifecycle()

function gate() {
  /** @type {() => void} */
  let release = () => {
    throw new Error('Gate not initialized')
  }
  const promise = new Promise(resolve => {
    release = () => {
      resolve(undefined)
    }
  })
  return { promise, release }
}
async function lifecycle() {
  const original = new Error('original failure')
  let settlements = 0
  const planner = new FetchPlanner(
    /** @param {import('undici').RequestInfo} _input */
    _input => {
      if (scenario === 'sync-transport') throw original
      if (scenario === 'error-observer') return Promise.reject(original)
      return delay(10).then(() => new Response(null))
    },
    { jitter: 0 }
  )
  /** @param {import('../../src/index.js').Event} event @returns {unknown} */
  const observer = event => {
    if (scenario === 'request-observer' && event.type === 'dispatch-started')
      return Promise.reject(new Error('observer'))
    if (scenario === 'error-observer' && event.type === 'operation-settled')
      throw new Error('secondary')
    return undefined
  }
  planner.observe(observer)
  const h = planner.submit({
    method: 'GET',
    replay: noReplay,
    prepare: () => ({ url: 'http://offline.test/', init: {} }),
    consume: () => 'finished'
  })
  void h.result.then(
    () => {
      settlements++
    },
    () => {
      settlements++
    }
  )
  if (scenario === 'request-observer')
    assert.equal((await h.result).value, 'finished', 'OBSERVER_REJECTION_PRESERVES_DELIVERY')
  else
    await assert.rejects(
      h.result,
      error =>
        error instanceof OperationError &&
        error.code === 'TRANSPORT_FAILED' &&
        error.cause === original
    )
  await h.resourcesDone
  await delay(30)
  assert.equal(settlements, 1, 'SINGLE_SETTLEMENT')
  assert.equal(diagnostics(planner).OBSERVER_FAILED, scenario === 'sync-transport' ? 0 : 1)
  assert.equal(planner.snapshot().queued, 0)
  assert.equal(planner.snapshot().sentActive, 0)
  assert.equal(planner.snapshot().leasedAttempts, 0)
  console.log('settled once; queue and inflight empty')
}

async function finiteDisposerBarrier() {
  const dispose = gate()
  const disposing = gate()
  let nextPrepares = 0
  let disposals = 0
  const planner = new FetchPlanner(
    /** @param {import('undici').RequestInfo} _input */ _input =>
      Promise.resolve(new Response(null)),
    { maxParallelLimit: 1 }
  )
  const first = planner.submit({
    method: 'GET',
    replay: noReplay,
    prepare: ctx => {
      ctx.onDispose(async () => {
        disposals++
        disposing.release()
        await dispose.promise
      })
      return { url: 'http://offline.test/first', init: {} }
    },
    consume: () => 'first'
  })
  const next = planner.submit({
    method: 'GET',
    replay: noReplay,
    prepare: () => {
      nextPrepares++
      return { url: 'http://offline.test/next', init: {} }
    },
    consume: () => 'next'
  })
  try {
    await disposing.promise
    await immediate()
    assert.equal(nextPrepares, 0, 'NEXT_PREPARE_MUST_WAIT_FOR_FINITE_DISPOSER')
    assert.equal(first.snapshot().resources, 'pending', 'RESOURCES_WAIT_FOR_FINITE_DISPOSER')
    assert.equal(disposals, 1, 'FINITE_DISPOSER_ONCE')
    dispose.release()
    assert.equal((await first.result).value, 'first')
    await first.resourcesDone
    assert.equal((await next.result).value, 'next')
    await next.resourcesDone
    assert.equal(nextPrepares, 1)
  } finally {
    dispose.release()
    await Promise.allSettled([first.result, next.result, first.resourcesDone, next.resourcesDone])
  }
}

async function cleanupLoopback() {
  await finiteDisposerBarrier()

  let requests = 0
  let closedBodies = 0
  let cancelCalls = 0
  let cancelled = 0
  let retry = true
  const closed = gate()
  const server = createServer((req, res) => {
    requests++
    const mode = req.url?.slice(1) ?? ''
    const discarded = mode !== 'delivered' && (mode !== 'retry' || retry)
    const status = mode === 'retry' && retry ? 429 : mode.endsWith('500') ? 500 : 200
    if (mode === 'retry') retry = false
    res.writeHead(status, {
      'Content-Type': 'text/plain',
      'X-RateLimit-Limit': mode.startsWith('header') ? 'invalid' : '45',
      'X-RateLimit-Remaining': '45',
      'X-Lognex-Retry-After': '0'
    })
    if (discarded) {
      res.on('close', () => {
        closedBodies++
        if (closedBodies === 7) closed.release()
      })
      res.write('discarded body')
    } else res.end('consumer body')
  })
  const agent = new Agent({ connections: 1, pipelining: 1 })
  /** @type {Promise<void>[]} */
  const cancellations = []
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/`
    // Trace fixed before execution: retry=2 sends + six single sends + seven next sends=15;
    // one discarded body per mode=7, each cancellation awaited exactly once.
    for (const mode of [
      'retry',
      'header200',
      'header500',
      'observer200',
      'observer500',
      'late200',
      'late500'
    ]) {
      const dispose = gate()
      const disposing = gate()
      const transportGate = gate()
      const headers = gate()
      let prepares = 0
      let nextPrepares = 0
      let disposals = 0
      const planner = new FetchPlanner(
        /** @param {import('undici').RequestInfo} input @param {import('undici').RequestInit} [init] */
        async (input, init) => {
          const response = await fetch(input, { ...init, dispatcher: agent })
          assert.equal(response.headers.get('content-type'), 'text/plain')
          const body = response.body
          assert.ok(body)
          const cancel = body.cancel.bind(body)
          body.cancel = (...args) => {
            cancelCalls++
            const work = cancel(...args).then(() => {
              cancelled++
            })
            cancellations.push(work)
            return work
          }
          if (mode === 'retry' && response.status === 429) {
            const getReader = body.getReader.bind(body)
            body.getReader = () => {
              const reader = getReader()
              const cancelReader = reader.cancel.bind(reader)
              reader.cancel = (...args) => {
                cancelCalls++
                const work = cancelReader(...args).then(() => {
                  cancelled++
                })
                cancellations.push(work)
                return work
              }
              return reader
            }
          }
          headers.release()
          if (mode.startsWith('late') && input === base + mode) await transportGate.promise
          return response
        },
        { jitter: 0, maxParallelLimit: 1 }
      )
      let observed = false
      planner.observe(event => {
        if (
          !observed &&
          ((mode.startsWith('late') && event.type === 'dispatch-started') ||
            (mode.startsWith('observer') && event.type === 'headers-received'))
        ) {
          observed = true
          throw new Error('observer')
        }
      })
      const first = planner.submit({
        method: 'GET',
        replay,
        prepare: ctx => {
          prepares++
          if (prepares === 1)
            ctx.onDispose(async () => {
              disposals++
              disposing.release()
              await dispose.promise
            })
          return { url: base + mode, init: {} }
        },
        consume: async response => {
          assert.equal(response.bodyUsed, false, 'LOOPBACK_UNREAD_AT_CONSUME')
          if (mode === 'retry') return response.text()
          return 'finished discard'
        }
      })
      const next = planner.submit({
        method: 'GET',
        replay: noReplay,
        prepare: () => {
          nextPrepares++
          return { url: base + 'delivered', init: {} }
        },
        consume: response => response.text()
      })
      try {
        await headers.promise
        if (mode.startsWith('late')) {
          assert.equal(planner.snapshot().sentActive, 1)
          assert.equal(nextPrepares, 0)
          transportGate.release()
        }
        await disposing.promise
        await immediate()
        assert.equal(nextPrepares, 0, 'NEXT_PREPARE_MUST_WAIT_FOR_FINITE_DISPOSER')
        assert.equal(planner.snapshot().leasedAttempts, 1, 'FINITE_DISPOSER_RETAINS_LEASE')
        assert.equal(disposals, 1, 'FINITE_DISPOSER_ONCE')
        dispose.release()
        const result = await first.result
        assert.equal(result.status, mode.endsWith('500') ? 500 : 200)
        assert.equal(result.value, mode === 'retry' ? 'consumer body' : 'finished discard')
        assert.equal(result.cleanup, 'released')
        await first.resourcesDone
        assert.equal((await next.result).value, 'consumer body')
        await next.resourcesDone
        assert.equal(diagnostics(planner).INVALID_HINT, mode.startsWith('header') ? 1 : 0)
        assert.equal(
          diagnostics(planner).OBSERVER_FAILED,
          mode.startsWith('late') || mode.startsWith('observer') ? 1 : 0
        )
        assert.equal(prepares, mode === 'retry' ? 2 : 1)
        assert.equal(planner.snapshot().sentActive, 0)
        assert.equal(planner.snapshot().queued, 0)
      } finally {
        dispose.release()
        transportGate.release()
        await Promise.allSettled([
          first.result,
          next.result,
          first.resourcesDone,
          next.resourcesDone
        ])
      }
    }
    await Promise.all(cancellations)
    await closed.promise
    // Six unread remainders use body.cancel; retry classifier uses reader.cancel.
    // Eight text consumers reach EOF and retain closed readers: no cancellation calls.
    assert.equal(cancelCalls, 7, 'EACH_DISCARDED_RESPONSE_CANCEL_ONCE')
    assert.equal(cancelled, 7, 'FINITE_REAL_CANCELS_SETTLED')
    assert.equal(closedBodies, 7, 'SERVER_DISCARDS_CLOSED')
    assert.equal(requests, 15, 'EXPLICIT_SCENARIO_REQUEST_TRACE')
    let starts = 0
    const bad = new Response(
      new ReadableStream({
        cancel() {
          return Promise.reject(new Error('finite cancel rejection'))
        }
      }),
      { status: 429 }
    )
    assert.ok(bad.body)
    const planner = new FetchPlanner(
      /** @param {import('undici').RequestInfo} _input */ _input => {
        starts++
        return Promise.resolve(bad)
      },
      { jitter: 0 }
    )
    const h = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: 'http://offline.test/', init: {} }),
      consume: () => 'unused'
    })
    await assert.rejects(h.result, { code: 'HTTP_FAILED', status: 429 })
    assert.deepEqual(await h.resourcesDone, { resources: 'failed' })
    assert.equal(starts, 1, 'REJECTED_CANCEL_FORBIDS_RETRY')
    console.log('loopback: retry, header, observer, late; bodies released; finite cancels settled')
  } finally {
    await Promise.allSettled(cancellations)
    try {
      await agent.close()
    } finally {
      server.closeAllConnections()
      if (server.listening)
        await new Promise((resolve, reject) => {
          server.close(error => {
            if (error) reject(error)
            else resolve(undefined)
          })
        })
    }
  }
}

async function nativeContract() {
  /** @type {{method: string | undefined, body: Buffer, contentType: string | undefined}[]} */
  const received = []
  let retryStart = 0
  const server = createServer((req, res) => {
    void receive(req, res).catch(
      /** @param {unknown} error */ error => {
        res.destroy(error instanceof Error ? error : new Error('Loopback receive failed'))
      }
    )
  })
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function receive(req, res) {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received.push({
      method: req.method,
      body: Buffer.concat(chunks),
      contentType: req.headers['content-type']
    })
    const retry = req.url?.startsWith('/retry') && received.length - retryStart === 1
    res.writeHead(retry ? 429 : req.url === '/404' ? 404 : req.url === '/503' ? 503 : 200, {
      'X-Lognex-Retry-After': '1'
    })
    res.end('consumer response')
  }
  const agent = new Agent({ connections: 1, pipelining: 1 })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    /** @type {globalThis.Response | undefined} */
    let originalResponse
    /** @type {typeof globalThis.fetch} */
    const nativeTransport = async (input, options) => {
      originalResponse = await globalThis.fetch(
        input,
        Object.assign({ ...options }, { dispatcher: agent })
      )
      return originalResponse
    }
    const planner = new FetchPlanner(nativeTransport, { jitter: 0 })
    /** @type {string[]} */
    const methods = []
    /** @param {string | URL} url @param {import('../../src/index.js').MethodSpec} method @param {import('../../src/operation-types.js').Init<typeof globalThis.fetch>} init @param {boolean} [safe] */
    async function send(url, method, init, safe = false) {
      const h = planner.submit({
        ...method,
        replay: safe ? replay : noReplay,
        prepare: () => ({ url, init: { ...init } }),
        consume: async response => {
          assert.equal(response, originalResponse, 'NATIVE_BORROW_IDENTITY')
          assert.equal(response.bodyUsed, false, 'NATIVE_UNREAD_AT_CONSUME')
          methods.push(method.method)
          return response.text()
        }
      })
      const result = await h.result
      assert.equal(result.value, 'consumer response')
      assert.equal(result.cleanup, 'released')
      await h.resourcesDone
      return result
    }
    await send(new URL(base + '/url'), { method: 'GET' }, {})
    await send(base + '/request', { method: 'POST' }, { body: 'request body' })
    await send(
      base + '/override',
      { method: 'PUT', entityKey: 'override' },
      { body: 'override body' }
    )
    await send(base + '/string', { method: 'GET' }, {})
    assert.deepEqual(methods, ['GET', 'POST', 'PUT', 'GET'])
    assert.deepEqual(
      received.map(r => r.method),
      methods
    )
    assert.equal(received[1]?.body.toString(), 'request body')
    assert.equal(received[2]?.body.toString(), 'override body')
    const form = new FormData()
    form.set('field', 'form value')
    form.set('file', new File(['form file'], 'form.txt'))
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('stream payload'))
        c.close()
      }
    })
    for (const body of [
      'string payload',
      Buffer.from('buffer payload'),
      form,
      new File(['file payload'], 'body.txt'),
      stream
    ]) {
      await send(base + '/payload', { method: 'POST' }, { body, duplex: 'half' })
      const payload = received.at(-1)
      assert.ok(payload)
      if (body === form) {
        assert.match(payload.contentType ?? '', /^multipart\/form-data; boundary=/)
        assert.match(payload.body.toString(), /form value/)
        assert.match(payload.body.toString(), /filename="form.txt"/)
        assert.match(payload.body.toString(), /form file/)
      } else
        assert.equal(
          payload.body.toString(),
          typeof body === 'string'
            ? body
            : Buffer.isBuffer(body)
              ? body.toString()
              : body instanceof File
                ? 'file payload'
                : 'stream payload'
        )
    }
    for (const status of [404, 503])
      assert.equal(
        (await send(`${base}/${status}`, { method: 'GET' }, {})).status,
        status,
        'NON429_STATUS_PRESERVED'
      )
    for (const body of ['replay string', Buffer.from('replay buffer')]) {
      retryStart = received.length
      await send(base + '/retry', { method: 'POST' }, { body }, true)
      assert.equal(received.length - retryStart, 2)
      assert.deepEqual(received[retryStart]?.body, received[retryStart + 1]?.body)
      assert.equal(received[retryStart]?.body.toString(), body.toString())
    }
    for (const mode of [
      'request-retry',
      'stream-retry',
      'disturbed-request',
      'locked-request',
      'disturbed-stream',
      'locked-stream'
    ]) {
      const oneShot = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('one shot'))
          c.close()
        }
      })
      const request = new Request(base + '/retry-one-shot', { method: 'POST', body: 'one shot' })
      const isRequest = mode.includes('request')
      const body = isRequest ? request.body : oneShot
      assert.ok(body)
      if (mode.startsWith('disturbed')) await new globalThis.Response(body).text()
      const reader = mode.startsWith('locked') ? body.getReader() : undefined
      retryStart = received.length
      let attempts = 0
      let settlements = 0
      let errors = 0
      /** @type {unknown} */
      let transportError
      const one = new FetchPlanner(
        /** @param {Parameters<typeof globalThis.fetch>[0]} input @param {Parameters<typeof globalThis.fetch>[1]} options */
        async (input, options) => {
          attempts++
          assert.equal(input, base + '/retry-one-shot')
          assert.equal(options?.body, body)
          assert.equal(options.method, 'POST', 'ONE_SHOT_EXPLICIT_METHOD')
          try {
            return await nativeTransport(input, options)
          } catch (error) {
            transportError = error
            throw error
          }
        },
        { jitter: 0 }
      )
      one.observe(event => {
        if (event.type === 'operation-settled' && event.outcome === 'failed') errors++
      })
      const h = one.submit({
        method: 'POST',
        replay: noReplay,
        prepare: () => ({ url: base + '/retry-one-shot', init: { body, duplex: 'half' } }),
        consume: response => response.text()
      })
      void h.result.then(
        () => {
          settlements++
        },
        () => {
          settlements++
        }
      )
      try {
        if (mode.endsWith('retry'))
          await assert.rejects(h.result, { code: 'HTTP_FAILED', status: 429 })
        else
          await assert.rejects(
            h.result,
            error =>
              error instanceof OperationError &&
              error.code === 'TRANSPORT_FAILED' &&
              error.cause === transportError
          )
        await h.resourcesDone
        await immediate()
        if (!mode.endsWith('retry')) assert.ok(transportError instanceof TypeError)
        assert.equal(attempts, 1, 'ONE_SHOT_NEVER_REPLAYED')
        assert.equal(
          received.length - retryStart,
          mode.endsWith('retry') ? 1 : 0,
          'ONE_SHOT_WIRE_TRACE'
        )
        assert.equal(settlements, 1)
        assert.equal(errors, 1, 'ONE_SHOT_FAILURE_EVENT_ONCE')
        assert.equal(one.snapshot().queued, 0)
        assert.equal(one.snapshot().sentActive, 0)
        await send(base + '/next', { method: 'GET' }, {})
      } finally {
        reader?.releaseLock()
        if (!body.locked) await body.cancel().catch(() => undefined)
        await Promise.allSettled([h.result, h.resourcesDone])
      }
    }
    console.log('Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries')
  } finally {
    try {
      await agent.close()
    } finally {
      server.closeAllConnections()
      if (server.listening)
        await new Promise((resolve, reject) => {
          server.close(error => {
            if (error) reject(error)
            else resolve(undefined)
          })
        })
    }
  }
}

/** @param {object} target */
function diagnostics(target) {
  /** @type {unknown} */
  const observation = Reflect.get(target, 'observation')
  assert.ok(observation instanceof OperationObservation)
  return observation.diagnostics.snapshot()
}
