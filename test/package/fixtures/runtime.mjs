/// <reference types="node" />

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once, EventEmitter } from 'node:events'
import { setImmediate as immediate } from 'node:timers/promises'
import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import * as deep from '../../../src/index.js'

assert.equal(FetchPlanner, deep.FetchPlanner)
assert.equal(wrapFetch, deep.wrapFetch)
/** @type {{input: unknown, init: unknown}[]} */
const calls = []
const response = new Response('local response', { status: 200 })
// Fake transport checks exact forwarding without consuming the delivered response.
/** @param {unknown} input @param {unknown} [init] */
const transport = (input, init) => {
  calls.push({ input, init })
  return Promise.resolve(response)
}
const get = new FetchPlanner(transport).getFetch()
assert.equal(await get('https://local.invalid/get'), response)
const post = wrapFetch(transport)
const init = { method: 'POST', body: 'payload' }
assert.equal(await post('https://local.invalid/post', init), response)
assert.deepEqual(calls, [
  { input: 'https://local.invalid/get', init: undefined },
  { input: 'https://local.invalid/post', init }
])
assert.equal(await response.text(), 'local response')
console.log('Runtime smoke: root/deep imports, GET/POST, original Response identity')

// This finite scenario also runs as a strict child in the unit suite.
/** @type {{method: string | undefined, body: Buffer, contentType: string | undefined}[]} */
const received = []
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
  const retry =
    req.url?.startsWith('/retry') && received.filter((_, i) => i >= retryStart).length === 1
  res.writeHead(retry ? 429 : req.url === '/404' ? 404 : req.url === '/503' ? 503 : 200, {
    'X-Lognex-Retry-After': '0'
  })
  res.end('consumer response')
}
let retryStart = 0
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  /** @type {EventEmitter<import('../../../src/index.js').FetchPlannerEventMap<typeof globalThis.fetch>>} */
  const events = new EventEmitter()
  /** @type {(string | undefined)[]} */
  const methods = []
  /** @type {string[]} */
  const types = []
  events.on('request', ev => methods.push(ev.method))
  events.on('response', ev => types.push(ev.responseType))
  /** @type {Response | undefined} */
  let originalResponse
  /** @type {typeof globalThis.fetch} */
  const nativeTransport = async (input, options) => {
    originalResponse = await globalThis.fetch(input, options)
    return originalResponse
  }
  const planner = new FetchPlanner(nativeTransport, { jitter: 0, eventHandler: events })
  const scheduled = planner.getFetch()
  /** @param {Parameters<typeof globalThis.fetch>[0]} input @param {RequestInit} [options] */
  async function send(input, options) {
    const response = await scheduled(input, options)
    assert.equal(response, originalResponse)
    assert.equal(response.bodyUsed, false)
    assert.equal(await response.text(), 'consumer response')
    return response
  }
  await send(new URL(base + '/url'))
  await send(new Request(base + '/request', { method: 'POST', body: 'request body' }))
  await send(new Request(base + '/override', { method: 'POST', body: 'old body' }), {
    method: 'PUT',
    body: 'override body'
  })
  await send(base + '/string')
  assert.deepEqual(methods, [undefined, 'POST', 'PUT', undefined])
  assert.deepEqual(
    received.map(r => r.method),
    ['GET', 'POST', 'PUT', 'GET']
  )
  assert.equal(received[1]?.body.toString(), 'request body')
  assert.equal(received[2]?.body.toString(), 'override body')
  const form = new FormData()
  form.set('field', 'form value')
  form.set('file', new File(['form file'], 'form.txt'))
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('stream payload'))
      controller.close()
    }
  })
  for (const body of [
    'string payload',
    Buffer.from('buffer payload'),
    form,
    new File(['file payload'], 'body.txt'),
    stream
  ]) {
    await send(base + '/payload', { method: 'POST', body, duplex: 'half' })
    const payload = received.at(-1)
    assert.ok(payload)
    if (body === form) {
      assert.match(payload.contentType ?? '', /^multipart\/form-data; boundary=/)
      assert.match(payload.body.toString(), /form value/)
      assert.match(payload.body.toString(), /filename="form.txt"/)
      assert.match(payload.body.toString(), /form file/)
    } else {
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
  }
  for (const status of [404, 503]) {
    const response = await send(`${base}/${status}`)
    assert.equal(response.status, status)
    assert.equal(types.at(-1), 'OK')
  }
  for (const body of ['replay string', Buffer.from('replay buffer')]) {
    retryStart = received.length
    await send(base + '/retry', { method: 'POST', body })
    assert.equal(received.length - retryStart, 2)
    assert.deepEqual(received[retryStart]?.body, received[retryStart + 1]?.body)
    assert.equal(received[retryStart]?.body.toString(), body.toString())
  }

  // No clone, buffering or body factory: a consumed Request/stream cannot be replayed.
  for (const mode of [
    'request-retry',
    'stream-retry',
    'disturbed-request',
    'locked-request',
    'disturbed-stream',
    'locked-stream'
  ]) {
    let attempts = 0
    let errors = 0
    let settlements = 0
    /** @type {Error | undefined} */
    let transportError
    const oneShot = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('one shot'))
        controller.close()
      }
    })
    const request = new Request(base + '/retry-one-shot', { method: 'POST', body: 'one shot' })
    const isRequest = mode.includes('request')
    if (mode === 'disturbed-request') await request.text()
    if (mode === 'disturbed-stream') await new Response(oneShot).text()
    const reader =
      mode === 'locked-request'
        ? request.body?.getReader()
        : mode === 'locked-stream'
          ? oneShot.getReader()
          : undefined
    retryStart = received.length
    /** @type {typeof globalThis.fetch} */
    const transport = async (input, options) => {
      if (input === base + '/next') return globalThis.fetch(input, options)
      attempts++
      assert.equal(input, isRequest ? request : base + '/retry-one-shot')
      if (!isRequest) assert.equal(options?.body, oneShot)
      try {
        return await globalThis.fetch(input, options)
      } catch (error) {
        assert.ok(error instanceof Error)
        transportError = error
        throw error
      }
    }
    const one = new FetchPlanner(transport, {
      jitter: 0,
      eventHandler: {
        emit(...[name, event]) {
          if (name === 'fetch-error') {
            errors++
            assert.equal(event.error, transportError)
            assert.equal(event.method, 'POST')
          }
        }
      }
    })
    try {
      await assert.rejects(
        one
          .getFetch()(
            isRequest ? request : base + '/retry-one-shot',
            isRequest ? undefined : { method: 'POST', body: oneShot, duplex: 'half' }
          )
          .then(
            value => {
              settlements++
              return value
            },
            /** @param {unknown} error */
            error => {
              settlements++
              throw error
            }
          ),
        error => error === transportError
      )
      await immediate()
      assert.equal(attempts, mode.endsWith('retry') ? 2 : 1)
      assert.equal(errors, 1)
      assert.equal(settlements, 1)
      assert.equal(one.getActionsQueueLength(), 0)
      assert.equal(one.getCurInflightRequestsCount(), 0)
      const next = await one.getFetch()(base + '/next')
      await next.text()
    } finally {
      reader?.releaseLock()
    }
  }
  console.log('Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries')
} finally {
  server.closeAllConnections()
  if (server.listening)
    await new Promise((resolve, reject) =>
      server.close(error => {
        if (error) reject(error)
        else resolve(undefined)
      })
    )
}
