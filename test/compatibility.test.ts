import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as publicApi from '../src/index.js'
import { FetchPlanner, OperationError, type Event } from '../src/index.js'
import { FetchPlanner as DeepPlanner } from '../src/planner.js'
import { OperationError as DeepError } from '../src/operation-types.js'
import { createRuntime } from './helpers/runtime.js'
import { deferred } from './operation/helpers.js'

const replay = { serverSafe: false, consumeSafe: false }
const url = 'http://offline.test/private-url'

function scalar(record: object) {
  assert.ok(Object.isFrozen(record), 'FROZEN_PUBLIC_RECORD')
  for (const [key, value] of Object.entries(record)) {
    assert.ok(['number', 'string', 'boolean', 'undefined'].includes(typeof value), key)
    assert.ok(
      !['url', 'body', 'error', 'cause', 'value', 'entityKey', 'response'].includes(key),
      key
    )
  }
}

test('Public namespace, deep identities and completed consumer value', async t => {
  const clock = createRuntime(t)
  assert.deepEqual(Object.keys(publicApi).sort(), ['FetchPlanner', 'OperationError'])
  assert.equal(FetchPlanner, DeepPlanner)
  assert.equal(OperationError, DeepError)
  const response = new Response('payload', { status: 500 })
  const value = { text: '' }
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(response))
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url, init: {} }),
    consume: async borrowed => {
      assert.equal(borrowed, response, 'BORROW_IDENTITY')
      assert.equal(borrowed.bodyUsed, false, 'UNREAD_NON2XX')
      value.text = await borrowed.text()
      return value
    }
  })
  assert.equal('then' in handle, false, 'NONTHENABLE_HANDLE')
  assert.notEqual(handle.result, handle.resourcesDone)
  await clock.advance(0)
  const completed = await handle.result
  assert.equal(completed.value, value, 'COMPLETED_VALUE_IDENTITY')
  assert.equal(completed.status, 500)
  assert.equal(completed.cleanup, 'released')
  assert.equal(value.text, 'payload')
  assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
})

test('Subclass identity uses scalar observation and public queued operations', async t => {
  const clock = createRuntime(t)
  class SubclassPlanner extends FetchPlanner<typeof fetch> {}
  const gate = deferred<undefined>()
  const events: Event[] = []
  const planner = new SubclassPlanner(
    () =>
      Promise.resolve(
        new Response('payload', {
          headers: {
            'X-RateLimit-Limit': '45',
            'X-RateLimit-Remaining': '45',
            'X-Lognex-Retry-TimeInterval': '4000'
          }
        })
      ),
    { maxParallelLimit: 1, jitter: 0 }
  )
  assert.ok(planner instanceof FetchPlanner)
  const attachment = planner.observe(event => {
    scalar(event)
    scalar(planner.snapshot())
    events.push(event)
  })
  const first = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url, init: { body: 'data' } }),
    consume: async response => {
      await gate.promise
      return response.text()
    }
  })
  const second = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url, init: {} }),
    consume: response => response.text()
  })
  try {
    assert.equal(planner.snapshot().queued, 2)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(attachment.snapshot.queued, 0, 'DETACHED_ATTACHMENT_SNAPSHOT')
    await clock.advance(0)
    assert.equal(planner.snapshot().sentActive, 1)
    assert.equal(planner.snapshot().queued, 1)
    assert.equal(first.snapshot().phase, 'consuming')
    gate.resolve(undefined)
    await clock.advance(0)
    assert.equal((await first.result).value, 'payload')
    assert.equal((await second.result).value, 'payload')
    await Promise.all([first.resourcesDone, second.resourcesDone])
    assert.equal(planner.snapshot().queued, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().effectiveParallelism, 1)
    const own = events.filter(event => event.id === first.id)
    assert.equal(own.filter(event => event.type === 'dispatch-started').length, 1)
    assert.equal(own.filter(event => event.type === 'headers-received').length, 1)
    assert.ok(
      own.findIndex(event => event.type === 'dispatch-started') <
        own.findIndex(event => event.type === 'headers-received')
    )
    for (let i = 1; i < events.length; i++) {
      const current = events[i]
      const previous = events[i - 1]
      assert.ok(current && previous)
      assert.ok(current.sequence > previous.sequence)
    }
  } finally {
    gate.resolve(undefined)
    attachment.unsubscribe()
    planner.stop()
    await Promise.allSettled([
      first.result,
      second.result,
      first.resourcesDone,
      second.resourcesDone
    ])
  }
})

test('D12 supplied 1/2/3 thresholds enforce receipt guards and per-entity PUT admission', async t => {
  const clock = createRuntime(t)
  for (const [status, limit] of [
    [500, 1],
    [429, 2]
  ] as const) {
    let starts = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        starts++
        return Promise.resolve(new Response(null, { status }))
      },
      {
        errorPerMinuteLimit: status === 500 ? 1 : 100,
        rateLimitPerMinuteLimit: 2,
        entityPutPerMinuteLimit: 3
      }
    )
    for (let i = 1; i <= limit; i++) {
      const handle = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: response => response.status
      })
      await clock.advance(0)
      if (status === 429) await assert.rejects(handle.result, { code: 'HTTP_FAILED', status })
      else assert.equal((await handle.result).value, status)
      await handle.resourcesDone
      assert.equal(starts, i)
      assert.equal(planner.snapshot().guardOpen, i === limit)
    }
    const denied = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'unused'
    })
    await assert.rejects(denied.result, { code: 'GUARD_OPEN', dispatchEntered: false })
    await denied.resourcesDone
    assert.equal(starts, limit)
  }
  let starts = 0
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      starts++
      return Promise.resolve(new Response(null))
    },
    { entityPutPerMinuteLimit: 3 }
  )
  const put = (entityKey: string) =>
    planner.submit({
      method: 'PUT',
      entityKey,
      replay,
      prepare: () => ({ url, init: { body: 'same' } }),
      consume: response => response.status
    })
  for (let i = 1; i <= 3; i++) {
    const h = put('one')
    await clock.advance(0)
    assert.equal((await h.result).value, 200)
    await h.resourcesDone
    assert.equal(starts, i)
  }
  const denied = put('one')
  await clock.advance(0)
  await assert.rejects(denied.result, { code: 'PUT_LIMIT', dispatchEntered: false })
  await denied.resourcesDone
  assert.equal(starts, 3)
  const other = put('two')
  await clock.advance(0)
  assert.equal((await other.result).value, 200)
  await other.resourcesDone
  assert.equal(starts, 4)
  assert.equal(planner.snapshot().guardOpen, false)
  await clock.advance(60000)
  const expired = put('one')
  await clock.advance(0)
  assert.equal((await expired.result).status, 200)
  await expired.resourcesDone
  assert.equal(starts, 5)
  assert.equal(planner.snapshot().queued, 0)
  assert.equal(planner.snapshot().sentActive, 0)
})

for (const synchronous of [false, true]) {
  test(`Transport ${synchronous ? 'synchronous throw' : 'rejection'} preserves cause and scalar event order`, async t => {
    const clock = createRuntime(t)
    const original = new Error('private transport failure')
    const events: Event[] = []
    const order: string[] = []
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      if (synchronous) throw original
      return new Promise((_resolve, reject) =>
        setTimeout(() => {
          reject(original)
        }, 7)
      )
    })
    planner.observe(event => {
      scalar(event)
      events.push(event)
      if (event.type === 'dispatch-started') order.push('dispatch')
      if (event.type === 'operation-settled') order.push('failed')
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'unused'
    })
    const result = handle.result.catch((error: unknown) => {
      order.push('rejected')
      return error
    })
    await clock.advance(0)
    await clock.advance(7)
    const error = await result
    assert.ok(error instanceof OperationError)
    assert.ok(error instanceof DeepError)
    assert.equal(error.cause, original)
    assert.equal(error.code, 'TRANSPORT_FAILED')
    assert.equal(error.operationId, handle.id)
    assert.equal(error.attemptNumber, 1)
    assert.equal(error.dispatchEntered, true)
    assert.equal(error.serverOutcome, 'unknown')
    assert.equal(error.status, undefined)
    assert.equal(calls, 1)
    assert.deepEqual(order, ['dispatch', 'failed', 'rejected'])
    const failed = events.find(event => event.type === 'operation-settled')
    assert.equal(failed?.elapsedMs, synchronous ? 0 : 7)
    assert.equal(
      events.some(event => event.type === 'headers-received'),
      false
    )
    assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
  })
}

test('A 429 retry reserves the tail while queued operations retain FIFO order', async t => {
  const clock = createRuntime(t)
  const starts: string[] = []
  const planner = new FetchPlanner<typeof fetch>(
    input => {
      assert.equal(typeof input, 'string')
      assert.ok(typeof input === 'string')
      starts.push(input)
      return Promise.resolve(
        starts.length === 1
          ? new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '5' } })
          : new Response(null)
      )
    },
    { maxParallelLimit: 1, jitter: 0 }
  )
  const handles = ['first', 'second', 'third'].map(name =>
    planner.submit({
      method: 'GET',
      replay: { serverSafe: true, consumeSafe: true },
      prepare: () => ({ url: `http://offline.test/${name}`, init: {} }),
      consume: response => response.status
    })
  )
  try {
    await clock.advance(0)
    await clock.advance(4)
    assert.deepEqual(starts, ['http://offline.test/first'])
    await clock.advance(1)
    assert.deepEqual(starts, [
      'http://offline.test/first',
      'http://offline.test/second',
      'http://offline.test/third'
    ])
    await clock.advance(2994)
    assert.equal(starts.length, 3, 'FALLBACK_NOT_BEFORE_3000')
    await clock.advance(1)
    assert.deepEqual(starts, [
      'http://offline.test/first',
      'http://offline.test/second',
      'http://offline.test/third',
      'http://offline.test/first'
    ])
    assert.deepEqual(
      (await Promise.all(handles.map(h => h.result))).map(result => result.status),
      [200, 200, 200]
    )
    await Promise.all(handles.map(h => h.resourcesDone))
  } finally {
    planner.stop()
    for (const h of handles) h.abort()
    await Promise.allSettled(handles.flatMap(h => [h.result, h.resourcesDone]))
  }
})
