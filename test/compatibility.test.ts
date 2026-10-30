import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Response } from 'undici'
import * as facade from '../src/index.js'
import { FetchPlanner, type FetchPlannerEventMap } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'

class SubclassPlanner extends FetchPlanner {
  slotChecks = 0

  protected override checkFreeRequestSlotTrigger() {
    this.slotChecks++
    super.checkFreeRequestSlotTrigger()
  }

  protectedSnapshot() {
    return [this.retryTimeInterval, this.rateLimit, this.rateLimitRemaining]
  }
}

test('Facade preserves runtime export names and wrapFetch response identity', async t => {
  const runtime = createRuntime(t)
  assert.deepEqual(Object.keys(facade).sort(), ['FetchPlanner', 'wrapFetch'])
  const response = new Response('payload', { status: 500 })
  const fetch = facade.wrapFetch<typeof import('undici').fetch>(() => Promise.resolve(response), {
    jitter: 0
  })
  const result = fetch('http://offline.test/wrapped')
  await runtime.advance(0)
  assert.equal(await result, response)
  assert.equal(await response.text(), 'payload')
})

test('Subclass hook, protected fields, getters and EventEmitter retain one planner identity', async t => {
  const runtime = createRuntime(t)
  const events = new EventEmitter<FetchPlannerEventMap<typeof import('undici').fetch>>()
  const response = new Response('payload', {
    headers: {
      'X-RateLimit-Limit': '45',
      'X-RateLimit-Remaining': '45',
      'X-Lognex-Retry-TimeInterval': '4000'
    }
  })
  const order: string[] = []
  const planner = new SubclassPlanner(() => Promise.resolve(response), {
    eventHandler: events,
    jitter: 0
  })
  events.on('request', (event, instance) => {
    assert.equal(instance, planner)
    assert.equal(instance instanceof FetchPlanner, true)
    assert.deepEqual(event, {
      actionId: 1,
      requestId: 1,
      url: 'http://offline.test/item',
      method: 'POST',
      startTime: Date.now()
    })
    assert.equal(instance.getCurInflightRequestsCount(), 1)
    order.push('request')
  })
  events.on('response', (event, instance) => {
    assert.equal(instance, planner)
    assert.deepEqual(event, {
      actionId: 1,
      requestId: 1,
      url: 'http://offline.test/item',
      method: 'POST',
      startTime: Date.now(),
      endTime: Date.now(),
      responseType: 'OK'
    })
    assert.equal(instance.getRateLimit(), 45)
    assert.equal(instance.getRateLimitRemaining(), 45)
    order.push('response')
  })
  assert.deepEqual(planner.protectedSnapshot(), [3000, null, null])
  assert.equal(planner.getOptions(), planner.getOptions())
  assert.equal(planner.getOptions().eventHandler, events)
  const fetch = planner.getFetch()
  const result = fetch('http://offline.test/item', { method: 'POST', body: 'data' })
  assert.equal(planner.getActionsQueueLength(), 1)
  assert.equal(planner.getNextRequestTime(), Date.now())
  assert.equal(planner.getCurInflightRequestsCount(), 0)
  await runtime.advance(0)
  assert.equal(await result, response)
  assert.deepEqual(order, ['request', 'response'])
  assert.deepEqual(planner.protectedSnapshot(), [4000, 45, 45])
  assert.equal(planner.getActionsQueueLength(), 0)
  assert.equal(planner.getCurInflightRequestsCount(), 0)
  assert.equal(planner.getParallelLimitCorrection(), 0)
  assert.equal(planner.getLastRequestDelay(), 0)
  assert.equal(planner.getNextRequestTime(), 0)
  assert.ok(planner.slotChecks > 0, 'Completion dispatches through the protected subclass hook')

  const checks = planner.slotChecks
  const slot = planner.waitForFreeRequestSlot(-10)
  assert.equal(planner.getRequestSlotHandlersCount(), 1)
  await runtime.flush()
  await slot
  assert.equal(planner.getRequestSlotHandlersCount(), 0)
  assert.ok(planner.slotChecks > checks, 'Slot notifications dispatch through the subclass hook')
})

test('D12 characterization: unfinished errorLimits ignores supplied 1/2/3, retains defaults and has no guard', async t => {
  const runtime = createRuntime(t)
  const supplied = {
    sameRequestsErrorPerMinuteLimit: 1,
    tooManyRequestsErrorPerMinuteLimit: 2,
    sameEntityPutRequestsPerMinuteLimit: 3
  }
  let starts = 0
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () => {
      starts++
      if (starts <= 101) return Promise.resolve(new Response(null, { status: 500 }))
      if (starts <= 202)
        return Promise.resolve(
          new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '1' } })
        )
      return Promise.resolve(new Response(null))
    },
    { jitter: 0, errorLimits: supplied }
  )
  assert.deepEqual(planner.getOptions().errorLimits, {
    sameRequestsErrorPerMinuteLimit: 100,
    tooManyRequestsErrorPerMinuteLimit: 100,
    sameEntityPutRequestsPerMinuteLimit: 100
  })
  assert.notEqual(planner.getOptions().errorLimits, supplied)

  // Characterize the unfinished option, not desired protection: even the returned
  // defaults do not stop repeated identical HTTP errors, PUTs or 429 retries.
  const fetch = planner.getFetch()
  for (let count = 1; count <= 101; count++) {
    const result = fetch('http://offline.test/entity/one', { method: 'PUT', body: 'same' })
    await runtime.advance(0)
    assert.equal((await result).status, 500)
    assert.equal(starts, count)
  }
  const retried = fetch('http://offline.test/entity/one', { method: 'PUT', body: 'same' })
  await runtime.advance(0)
  assert.equal(starts, 102)
  for (let count = 1; count <= 101; count++) {
    await runtime.advance(1)
    assert.equal(starts, 102 + count)
  }
  assert.equal((await retried).status, 200)
  assert.equal(planner.getActionsQueueLength(), 0)
  assert.equal(planner.getCurInflightRequestsCount(), 0)
})

test('Transport rejection preserves fetch-error shape, planner identity and event order', async t => {
  const runtime = createRuntime(t)
  const events = new EventEmitter<FetchPlannerEventMap<typeof import('undici').fetch>>()
  const original = new Error('transport failed')
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(original)
        }, 7)
      }),
    { eventHandler: events, jitter: 0 }
  )
  const order: string[] = []
  const startTime = Date.now()
  const metadata = {
    actionId: 1,
    requestId: 1,
    url: 'http://offline.test/failed',
    method: 'POST',
    startTime
  }
  events.on('request', (event, instance) => {
    assert.equal(instance, planner)
    assert.deepEqual(event, metadata)
    order.push('request')
  })
  events.on('response', () => order.push('response'))
  events.on('fetch-error', (event, instance) => {
    assert.equal(instance, planner)
    assert.deepEqual(event, { ...metadata, error: original, errorTime: startTime + 7 })
    order.push('fetch-error')
  })
  const result = planner
    .getFetch()(metadata.url, { method: 'POST' })
    .catch((error: unknown) => {
      order.push('rejected')
      return error
    })
  await runtime.advance(0)
  await runtime.advance(7)
  assert.equal(await result, original)
  assert.deepEqual(order, ['request', 'fetch-error', 'rejected'])
})

test('A 429 retry precedes queued actions while their FIFO order is preserved', async t => {
  const runtime = createRuntime(t)
  const starts: unknown[] = []
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    url => {
      starts.push(url)
      return Promise.resolve(
        starts.length === 1
          ? new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '5' } })
          : new Response(null)
      )
    },
    { maxParallelLimit: 1, jitter: 0 }
  )
  const fetch = planner.getFetch()
  const results = ['first', 'second', 'third'].map(name => fetch(`http://offline.test/${name}`))
  await runtime.advance(0)
  await runtime.advance(4)
  assert.deepEqual(starts, ['http://offline.test/first'])
  await runtime.advance(1)
  await runtime.advance(0)
  await runtime.advance(0)
  assert.deepEqual(starts, [
    'http://offline.test/first',
    'http://offline.test/first',
    'http://offline.test/second',
    'http://offline.test/third'
  ])
  assert.deepEqual(
    (await Promise.all(results)).map(response => response.status),
    [200, 200, 200]
  )
})
