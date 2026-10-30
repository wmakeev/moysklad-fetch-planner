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
