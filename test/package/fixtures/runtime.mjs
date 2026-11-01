/// <reference types="node" />

import assert from 'node:assert/strict'
import { FetchPlanner, OperationError } from '../../../src/index.js'
import * as deep from '../../../src/index.js'

// SOURCE PREPARATION ONLY in T107. Artifact/Node runtime acceptance belongs to T119–T121.
assert.equal(FetchPlanner, deep.FetchPlanner)
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
  assert.deepEqual(await handle.result, { value: 'finished', status: 200, cleanup: 'released' })
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
