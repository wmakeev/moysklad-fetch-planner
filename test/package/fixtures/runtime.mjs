/// <reference types="node" />

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { FetchPlanner, OperationError } from '../../../src/index.js'
import * as deep from '../../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../../src/planner.js'

const family = process.argv[2]
assert.ok(
  process.argv.length === 3 &&
    family &&
    ['bare', 'undici', 'undici8-baseline', 'undici8'].includes(family),
  'Runtime family'
)

const runtimeUndici = family === 'bare' ? undefined : await import('undici')
assert.equal(FetchPlanner, deep.FetchPlanner)
assert.equal(FetchPlanner, DeepPlanner)
assert.equal(OperationError, deep.OperationError)
assert.deepEqual(Object.keys(deep).sort(), ['FetchPlanner', 'OperationError'])

/** @type {{input: unknown, method: string | undefined, body: unknown, signal: AbortSignal | null | undefined}[]} */
const calls = []
/** @type {typeof globalThis.fetch} */
const transport = (input, init) => {
  calls.push({ input, method: init?.method, body: init?.body, signal: init?.signal })
  return Promise.resolve(new Response('finished response'))
}
const options = {
  jitter: 0,
  deadlineMs: 10_000,
  attemptTimeoutMs: 5_000,
  cleanupGraceMs: 1_000,
  maxAttempts: 2
}
const planner = new FetchPlanner(transport, options)
/** @type {import('../../../src/index.js').Event[]} */
const events = []
const observation = planner.observe(event => {
  events.push(event)
})
try {
  for (const method of /** @type {const} */ (['GET', 'POST'])) {
    let disposed = 0
    const handle = planner.submit({
      method,
      replay: { serverSafe: false, consumeSafe: false },
      prepare(ctx) {
        ctx.onDispose(() => {
          disposed++
        })
        return {
          url: new URL(`https://local.invalid/${method.toLowerCase()}`),
          init: method === 'POST' ? { body: 'payload' } : {}
        }
      },
      consume: response => response.bytes()
    })
    const completed = await handle.result
    assert.deepEqual(completed.value, new TextEncoder().encode('finished response'))
    assert.equal(completed.status, 200)
    assert.equal(completed.cleanup, 'released')
    assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
    assert.equal(disposed, 1)
    assert.equal(handle.snapshot().dispatchCalls, 1)
  }
  assert.deepEqual(
    calls.map(call => call.method),
    ['GET', 'POST']
  )
  assert.deepEqual(
    calls.map(call => call.body),
    [undefined, 'payload']
  )
  assert.ok(calls.every(call => call.signal instanceof AbortSignal))
  assert.ok(events.some(event => event.type === 'operation-settled'))
  assert.ok(events.every(event => !('value' in event) && !('body' in event) && !('url' in event)))
} finally {
  observation.unsubscribe()
  planner.stop('fixture finished')
}

// Retry recreates a request body for the SAME operation, with an explicit logical identity.
// FormData owns no ongoing upload producer in this fake; stream stop-and-wait is tested in T100/T71.
let prepared = 0
let dispatched = 0
/** @type {unknown[]} */
const bodies = []
/** @type {number[]} */
const cleanupAtDispatch = []
/** @type {number[]} */
const operationIds = []
/** @type {number[]} */
const cleanupOrder = []
/** @type {typeof globalThis.fetch} */
const retryTransport = (_input, init) => {
  dispatched++
  cleanupAtDispatch.push(cleanupOrder.length)
  bodies.push(init?.body)
  return Promise.resolve(
    new Response(dispatched === 1 ? 'retry' : 'finished', {
      status: dispatched === 1 ? 429 : 200,
      headers: { 'X-Lognex-Retry-After': '1' }
    })
  )
}
const retryPlanner = new deep.FetchPlanner(retryTransport, options)
try {
  const handle = retryPlanner.submit({
    method: 'POST',
    replay: { serverSafe: true, consumeSafe: true },
    prepare(ctx) {
      const attempt = ++prepared
      operationIds.push(ctx.operationId)
      ctx.onDispose(() => {
        cleanupOrder.push(attempt)
      })
      const body = new FormData()
      body.set('identity', 'fixture-operation')
      body.set('payload', 'same logical payload')
      return { url: 'https://local.invalid/retry', init: { body } }
    },
    consume: response => response.text()
  })
  assert.deepEqual(
    { ...(await handle.result) },
    { value: 'finished', status: 200, cleanup: 'released' }
  )
  assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
  assert.equal(prepared, 2)
  assert.equal(dispatched, 2)
  assert.deepEqual(operationIds, [handle.id, handle.id])
  assert.deepEqual(cleanupOrder, [1, 2])
  assert.equal(bodies.length, 2)
  assert.notEqual(bodies[0], bodies[1])
  assert.deepEqual(cleanupAtDispatch, [0, 1])
  for (const body of bodies) {
    assert.ok(body instanceof FormData)
    assert.equal(body.get('identity'), 'fixture-operation')
    assert.equal(body.get('payload'), 'same logical payload')
  }
} finally {
  retryPlanner.stop('retry fixture finished')
}

// Every installed runtime family exercises the additive API with its real Response class.
const HttpResponse = runtimeUndici?.Response ?? Response
for (const Planner of [FetchPlanner, DeepPlanner]) {
  for (const scenario of ['default', 'recover', 'terminal']) {
    let dispatches = 0
    let prepares = 0
    let disposals = 0
    /** @type {unknown[]} */
    const httpBodies = []
    /** @type {number[]} */
    const httpIds = []
    const cause = new Error(`Known full refusal: ${scenario}`)
    /** @type {typeof globalThis.fetch} */
    const httpTransport = (_input, init) => {
      dispatches++
      httpBodies.push(init?.body)
      return Promise.resolve(
        new HttpResponse('complete body', {
          status: scenario === 'recover' && dispatches === 2 ? 200 : 503
        })
      )
    }
    const httpPlanner = new Planner(httpTransport, { ...options, maxAttempts: 3 })
    const handle = httpPlanner.submit({
      method: 'POST',
      replay: { serverSafe: true, consumeSafe: true },
      prepare(ctx) {
        assert.equal(disposals, prepares, 'HTTP_CLEANUP_BEFORE_PREPARE')
        prepares++
        httpIds.push(ctx.operationId)
        ctx.onDispose(() => {
          disposals++
        })
        return { url: 'https://offline.invalid/http', init: { body: new Uint8Array([1, 2]) } }
      },
      async consume(response, ctx) {
        const text = await response.text()
        if (!response.ok) {
          if (scenario === 'default') throw cause
          throw ctx.retryableHttpFailure(cause)
        }
        return text
      }
    })
    try {
      if (scenario === 'recover') {
        assert.deepEqual(
          { ...(await handle.result) },
          {
            value: 'complete body',
            status: 200,
            cleanup: 'released'
          }
        )
      } else {
        await assert.rejects(handle.result, error => {
          assert.ok(error instanceof OperationError)
          assert.equal(error.cause, cause, 'DIRECT_HTTP_CAUSE_IDENTITY')
          assert.equal(error.code, 'CONSUME_FAILED')
          assert.equal(error.phase, 'consuming')
          assert.equal(error.status, 503)
          assert.equal(error.attemptNumber, scenario === 'terminal' ? 3 : 1)
          assert.equal(error.operationId, handle.id)
          assert.equal(error.dispatchEntered, true)
          assert.equal(error.serverOutcome, 'http-response')
          return true
        })
      }
      assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
      const expected = scenario === 'default' ? 1 : scenario === 'recover' ? 2 : 3
      assert.equal(dispatches, expected)
      assert.equal(prepares, expected)
      assert.equal(disposals, expected)
      assert.equal(handle.snapshot().dispatchCalls, expected)
      assert.deepEqual(httpIds, Array(expected).fill(handle.id))
      assert.equal(new Set(httpBodies).size, expected, 'HTTP_FRESH_BODIES')
      for (const body of httpBodies) assert.deepEqual(body, new Uint8Array([1, 2]))
    } finally {
      handle.abort('HTTP fixture finally')
      httpPlanner.stop('HTTP fixture finally')
      await handle.resourcesDone
    }
  }
}
console.log(
  `Runtime ${family}: default503, safe503 recovery, terminal503 original cause, root/deep`
)

// stop during a sent consume preserves that attempt; it rejects subsequent submissions.
function gate() {
  /** @type {() => void} */
  let resolve = () => {
    throw new Error('Uninitialized gate')
  }
  const promise = new Promise(
    /** @param {(value: void) => void} done */ done => {
      resolve = () => {
        done()
      }
    }
  )
  return { promise, resolve }
}
const entered = gate()
const release = gate()
let disposed = 0
const stopPlanner = new FetchPlanner(transport, { ...options, maxParallelLimit: 1 })
const sent = stopPlanner.submit({
  method: 'POST',
  replay: { serverSafe: false, consumeSafe: false },
  prepare(ctx) {
    ctx.onDispose(() => {
      disposed++
    })
    return { url: 'https://local.invalid/sent', init: { body: 'sent payload' } }
  },
  async consume(response) {
    entered.resolve()
    await release.promise
    return response.text()
  }
})
// Observe every result immediately so assertion/finally paths never leave a rejection unhandled.
const sentOutcome = sent.result.then(
  value => ({ value }),
  /** @param {unknown} error */ error => ({ error })
)
try {
  await Promise.race([
    entered.promise,
    sentOutcome.then(() => {
      throw new Error('Consume was not entered')
    })
  ])
  stopPlanner.stop('stop during consume')
  assert.equal(sent.snapshot().phase, 'consuming')
  assert.equal(stopPlanner.snapshot().sentActive, 1)
  const rejected = stopPlanner.submit({
    method: 'GET',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: () => ({ url: 'https://local.invalid/never', init: {} }),
    consume: response => response.text()
  })
  await assert.rejects(
    rejected.result,
    error => error instanceof OperationError && error.code === 'STOPPED' && !error.dispatchEntered
  )
  assert.deepEqual(await rejected.resourcesDone, { resources: 'released' })
  release.resolve()
  const outcome = await sentOutcome
  assert.ok('value' in outcome)
  assert.equal(outcome.value.value, 'finished response')
  assert.deepEqual(await sent.resourcesDone, { resources: 'released' })
  assert.equal(disposed, 1)
  assert.equal(sent.snapshot().dispatchCalls, 1)
  assert.equal(stopPlanner.snapshot().sentActive, 0)
} finally {
  release.resolve()
  stopPlanner.stop('fixture finally')
  await sentOutcome
  await sent.resourcesDone
}
console.log('Runtime source: root/deep, GET/POST, fresh safe retry, finished consume and stop')

// Finite wire scenarios shared by installed-package acceptance and the source suite.
// Bare consumers never resolve or import the optional runtime transport.
if (family !== 'bare') {
  assert.ok(runtimeUndici)
  const { fetch: undiciFetch, Response: UndiciResponse, Agent } = runtimeUndici
  const agent = new Agent({ connections: 1, pipelining: 1 })
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  /** @type {{method: string | undefined, url: string | undefined, body: string, contentType: string | undefined}[]} */
  const received = []
  /** @type {unknown[]} */
  const serverErrors = []
  const beforeHeaders = gate()
  const bodyEntered = gate()
  const headersClosed = gate()
  const bodyClosed = gate()
  const cleanupEntered = gate()
  const cleanupRelease = gate()
  let retryRequests = 0
  let httpRetryRequests = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    response.on('error', error => {
      serverErrors.push(error)
    })
    request.on('error', error => {
      // Aborted clients may reset their own finite loopback connection.
      if (!('code' in error) || error.code !== 'ECONNRESET') serverErrors.push(error)
    })
    request.on('data', (/** @type {string} */ chunk) => {
      body += chunk
      if (body.length > 1024) request.destroy(new Error('Loopback payload exceeded bound'))
    })
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        body,
        contentType: request.headers['content-type']
      })
      if (request.url === '/abort-headers') {
        response.once('close', headersClosed.resolve)
        beforeHeaders.resolve()
        return
      }
      if (request.url === '/abort-body') {
        response.once('close', bodyClosed.resolve)
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.write('partial')
        return
      }
      if (request.url === '/http-safe') {
        const retry = ++httpRetryRequests === 1
        response.writeHead(retry ? 503 : 200)
        response.end(retry ? 'full refusal' : 'finished')
        return
      }
      if (request.url === '/safe' || request.url === '/unsafe') {
        const retry = request.url === '/unsafe' || ++retryRequests === 1
        response.writeHead(retry ? 429 : 200, { 'x-lognex-retry-after': '1' })
        response.end(retry ? 'retry' : 'finished')
        return
      }
      response.writeHead(201, { 'content-type': 'text/plain' })
      response.end(`${request.method}:${body}`)
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })
  server.on('error', error => {
    serverErrors.push(error)
  })
  /** @type {AbortSignal[]} */
  const signals = []
  /** @type {typeof undiciFetch} */
  const wireTransport = (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal, 'COORDINATOR_SIGNAL_REQUIRED')
    assert.equal(init.signal.aborted, false)
    signals.push(init.signal)
    return undiciFetch(input, { ...init, dispatcher: agent })
  }
  const wirePlanners = [
    new FetchPlanner(wireTransport, options),
    new DeepPlanner(wireTransport, options)
  ]
  /** @type {import('../../../src/index.js').Handle<unknown>[]} */
  const handles = []
  /** @type {Promise<unknown>[]} */
  const settlements = []
  // One finite deadline also bounds gates on failure; finally destroys held sockets.
  const wireDeadline = setTimeout(() => {
    beforeHeaders.resolve()
    bodyEntered.resolve()
    cleanupEntered.resolve()
    cleanupRelease.resolve()
    for (const handle of handles) handle.abort('wire deadline')
    for (const socket of sockets) socket.destroy()
  }, 12_000)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve(undefined)
      })
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    for (const [index, method] of /** @type {const} */ (['GET', 'POST']).entries()) {
      const wirePlanner = wirePlanners[index]
      assert.ok(wirePlanner)
      let disposed = 0
      /** @type {import('../../../src/index.js').Handle<{text: string, undici: boolean}>} */
      const handle = wirePlanner.submit({
        method,
        replay: { serverSafe: false, consumeSafe: false },
        prepare(ctx) {
          ctx.onDispose(() => {
            disposed++
          })
          return {
            url: `http://127.0.0.1:${address.port}/${method.toLowerCase()}`,
            init:
              method === 'POST'
                ? {
                    body: JSON.stringify({ payload: 'wire payload' }),
                    headers: { 'content-type': 'application/json' }
                  }
                : {}
          }
        },
        async consume(response) {
          const text = await response.text()
          assert.equal(response.bodyUsed, true, 'CONSUMED_TO_EOF')
          return { text, undici: response instanceof UndiciResponse }
        }
      })
      handles.push(handle)
      // Attach before any assertion can leave either promise rejected and unobserved.
      settlements.push(
        handle.result.then(
          () => undefined,
          () => undefined
        ),
        handle.resourcesDone
      )
      assert.deepEqual(
        { ...(await handle.result) },
        {
          value: {
            text: `${method}:${method === 'POST' ? JSON.stringify({ payload: 'wire payload' }) : ''}`,
            undici: true
          },
          status: 201,
          cleanup: 'released'
        }
      )
      assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
      assert.equal(handle.snapshot().dispatchCalls, 1)
      assert.equal(disposed, 1)
    }
    assert.deepEqual(received, [
      { method: 'GET', url: '/get', body: '', contentType: undefined },
      {
        method: 'POST',
        url: '/post',
        body: JSON.stringify({ payload: 'wire payload' }),
        contentType: 'application/json'
      }
    ])
    const wirePlanner = wirePlanners[0]
    assert.ok(wirePlanner)
    const base = `http://127.0.0.1:${address.port}`
    // Observe immediately, including paths that fail before the next assertion.
    /**
     * @template T
     * @param {import('../../../src/index.js').Handle<T>} handle
     */
    function track(handle) {
      handles.push(handle)
      settlements.push(
        handle.result.catch(() => undefined),
        handle.resourcesDone
      )
      return handle
    }
    for (const stage of ['headers', 'body']) {
      /** @type {import('../../../src/index.js').Handle<never>} */
      const handle = track(
        wirePlanner.submit({
          method: 'GET',
          replay: { serverSafe: true, consumeSafe: true },
          prepare: () => ({ url: `${base}/abort-${stage}`, init: {} }),
          async consume(response) {
            assert.ok(response.body)
            const reader = response.body.getReader()
            try {
              const first = await reader.read()
              assert.ok(first.value instanceof Uint8Array)
              assert.equal(new TextDecoder().decode(first.value), 'partial')
              assert.equal(first.done, false)
              bodyEntered.resolve()
              await reader.read()
              throw new Error('Incomplete response unexpectedly reached EOF')
            } finally {
              reader.releaseLock()
            }
          }
        })
      )
      await (stage === 'headers' ? beforeHeaders.promise : bodyEntered.promise)
      const signal = signals.at(-1)
      assert.ok(signal)
      handle.abort(`abort ${stage}`)
      await assert.rejects(handle.result, error => {
        assert.ok(error instanceof OperationError)
        assert.equal(error.code, 'ABORTED')
        assert.equal(error.dispatchEntered, true)
        assert.equal(error.serverOutcome, stage === 'headers' ? 'unknown' : 'http-response')
        if (stage === 'body') assert.equal(error.status, 200)
        return true
      })
      assert.equal(signal.aborted, true, 'COORDINATOR_SIGNAL_ABORTED')
      // The signal must reach the real transport: the peer sees a closed,
      // unfinished response before finally destroys any owned socket.
      let closeTimer
      try {
        await Promise.race([
          stage === 'headers' ? headersClosed.promise : bodyClosed.promise,
          new Promise((_, reject) => {
            closeTimer = setTimeout(() => {
              reject(new Error('ABORT_DID_NOT_CLOSE_WIRE'))
            }, 1000)
          })
        ])
      } finally {
        clearTimeout(closeTimer)
      }
      const resources = await handle.resourcesDone
      assert.ok(['released', 'unknown', 'failed'].includes(resources.resources))
      assert.equal(handle.snapshot().resources, resources.resources)
      assert.equal(handle.snapshot().dispatchCalls, 1, 'NO_ABORT_RETRY')
      console.log(`Wire abort ${stage}: ${resources.resources}`)
    }

    let freshPrepared = 0
    let freshDisposed = 0
    /** @type {Uint8Array[]} */
    const freshBodies = []
    /** @type {number[]} */
    const freshIds = []
    const fresh = track(
      wirePlanner.submit({
        method: 'POST',
        replay: { serverSafe: true, consumeSafe: true },
        prepare(ctx) {
          const attempt = ++freshPrepared
          freshIds.push(ctx.operationId)
          assert.equal(freshDisposed, attempt - 1, 'CLEANUP_BEFORE_PREPARE')
          ctx.onDispose(async () => {
            if (attempt === 1) {
              cleanupEntered.resolve()
              await cleanupRelease.promise
            }
            freshDisposed++
          })
          const body = new TextEncoder().encode(
            JSON.stringify({ identity: 'wire-safe', payload: 'same' })
          )
          freshBodies.push(body)
          return {
            url: `${base}/safe`,
            init: { body, headers: { 'content-type': 'application/json' } }
          }
        },
        consume: response => response.text()
      })
    )
    try {
      await cleanupEntered.promise
      // Cross a real event-loop turn while cleanup is deliberately pending.
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(retryRequests, 1, 'NO_SECOND_DISPATCH_WHILE_CLEANUP_PENDING')
      assert.equal(freshPrepared, 1)
      assert.equal(fresh.snapshot().resources, 'pending')
    } finally {
      cleanupRelease.resolve()
    }
    assert.deepEqual(
      { ...(await fresh.result) },
      { value: 'finished', status: 200, cleanup: 'released' }
    )
    assert.deepEqual(await fresh.resourcesDone, { resources: 'released' })
    assert.equal(freshPrepared, 2)
    assert.equal(freshDisposed, 2)
    assert.deepEqual(freshIds, [fresh.id, fresh.id])
    assert.equal(freshBodies.length, 2)
    assert.notEqual(freshBodies[0], freshBodies[1], 'FRESH_BODY_OBJECTS')
    assert.deepEqual(freshBodies[0], freshBodies[1], 'SAME_LOGICAL_PAYLOAD')
    assert.equal(fresh.snapshot().dispatchCalls, 2)

    // The same owned Agent carries an actual 503 retry, with fresh bytes on the wire.
    /** @type {Uint8Array[]} */
    const wireHttpBodies = []
    /** @type {number[]} */
    const wireHttpIds = []
    const http = track(
      wirePlanner.submit({
        method: 'POST',
        replay: { serverSafe: true, consumeSafe: true },
        prepare(ctx) {
          wireHttpIds.push(ctx.operationId)
          const body = new TextEncoder().encode('same safe HTTP payload')
          wireHttpBodies.push(body)
          return { url: `${base}/http-safe`, init: { body } }
        },
        async consume(response, ctx) {
          assert.ok(response instanceof UndiciResponse)
          const text = await response.text()
          if (response.status === 503) throw ctx.retryableHttpFailure(new Error(text))
          return text
        }
      })
    )
    assert.deepEqual(
      { ...(await http.result) },
      { value: 'finished', status: 200, cleanup: 'released' }
    )
    assert.deepEqual(await http.resourcesDone, { resources: 'released' })
    assert.equal(httpRetryRequests, 2)
    assert.deepEqual(wireHttpIds, [http.id, http.id])
    assert.equal(wireHttpBodies.length, 2)
    assert.notEqual(wireHttpBodies[0], wireHttpBodies[1])
    assert.deepEqual(wireHttpBodies[0], wireHttpBodies[1])
    assert.deepEqual(
      received.filter(request => request.url === '/http-safe').map(request => request.body),
      ['same safe HTTP payload', 'same safe HTTP payload']
    )

    const unsafe = track(
      wirePlanner.submit({
        method: 'POST',
        replay: { serverSafe: false, consumeSafe: false },
        prepare: () => ({ url: `${base}/unsafe`, init: { body: 'unsafe' } }),
        consume: response => response.text()
      })
    )
    await assert.rejects(unsafe.result, error => {
      assert.ok(error instanceof OperationError)
      assert.equal(error.code, 'HTTP_FAILED')
      assert.equal(error.status, 429)
      assert.equal(error.dispatchEntered, true)
      return true
    })
    assert.deepEqual(await unsafe.resourcesDone, { resources: 'released' })
    assert.equal(unsafe.snapshot().dispatchCalls, 1)
    for (const route of ['/safe', '/unsafe']) {
      /** @type {typeof received} */
      const requests = received.filter(request => request.url === route)
      assert.equal(requests.length, route === '/safe' ? 2 : 1)
      for (const request of requests) {
        assert.equal(request.method, 'POST')
        assert.equal(
          request.body,
          route === '/safe' ? JSON.stringify({ identity: 'wire-safe', payload: 'same' }) : 'unsafe'
        )
        if (route === '/safe') assert.equal(request.contentType, 'application/json')
      }
    }
    assert.deepEqual(serverErrors, [])
    await agent.close()
  } finally {
    clearTimeout(wireDeadline)
    cleanupRelease.resolve()
    for (const wirePlanner of wirePlanners) wirePlanner.stop('wire fixture finally')
    for (const handle of handles) handle.abort('wire fixture finally')
    try {
      await agent.destroy()
    } finally {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      try {
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close(error => {
              if (error) reject(error)
              else resolve(undefined)
            })
          })
        }
      } finally {
        await Promise.allSettled(settlements)
      }
    }
  }
  console.log(
    `Runtime ${family}: owned Agent, root/deep GET/JSON POST EOF, signal, aborts, fresh safe429 cleanup barrier, unsafe429, safe503`
  )
}
