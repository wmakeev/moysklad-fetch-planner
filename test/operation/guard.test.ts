import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GuardStore } from '../../src/guard.js'
import { FetchPlanner } from '../../src/planner.js'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici'
import { OperationObservation } from '../../src/operation-observation.js'
import { createRuntime, deferred } from './helpers.js'
import type { FetchPlannerOptions, Init, Spec } from '../../src/operation-types.js'

const defaults = {
  maxEntityKeys: 1024,
  errorPerMinuteLimit: 100,
  rateLimitPerMinuteLimit: 100,
  entityPutPerMinuteLimit: 60
}
function store(options: Partial<FetchPlannerOptions> = {}) {
  return new GuardStore({ ...defaults, ...options })
}

/** Inspect real retained storage without adding a production debug API. */
function timestamps(window: unknown): number[] {
  assert.ok(typeof window === 'object' && window !== null)
  const retained: unknown = Reflect.get(window, 'timestamps')
  assert.ok(Array.isArray(retained))
  return retained.map((value: unknown) => {
    assert.equal(typeof value, 'number')
    assert.ok(typeof value === 'number')
    return value
  })
}
function puts(guard: GuardStore): Map<unknown, unknown> {
  const retained: unknown = Reflect.get(guard, 'puts')
  assert.ok(retained instanceof Map)
  return retained
}

for (const status of [400, 412, 429, 500, 599]) {
  test(`Receipt ${status} counts 99, opens at 100 and saturates at 101`, () => {
    const guard = store()
    for (let i = 0; i < 99; i++) guard.recordReceipt(status, 0)
    assert.deepEqual(guard.snapshot(0), {
      guardOpen: false,
      errorCount: 99,
      rateLimitCount: status === 429 ? 99 : 0
    })
    assert.equal(guard.recordReceipt(status, 0).guardOpen, true)
    assert.deepEqual(guard.recordReceipt(status, 0), {
      guardOpen: true,
      errorCount: 100,
      rateLimitCount: status === 429 ? 100 : 0
    })
    assert.equal(timestamps(Reflect.get(guard, 'errors')).length, 100)
    assert.equal(timestamps(Reflect.get(guard, 'rateLimits')).length, status === 429 ? 100 : 0)
  })
}

test('Error and rate thresholds are independent with raised and lowered options', () => {
  const guard = store({ errorPerMinuteLimit: 102, rateLimitPerMinuteLimit: 100 })
  for (let i = 0; i < 99; i++) guard.recordReceipt(429, 0)
  guard.recordReceipt(400, 0)
  assert.deepEqual(guard.snapshot(0), { guardOpen: false, errorCount: 100, rateLimitCount: 99 })
  assert.deepEqual(guard.recordReceipt(429, 0), {
    guardOpen: true,
    errorCount: 101,
    rateLimitCount: 100
  })
  guard.recordReceipt(429, 0)
  assert.equal(guard.snapshot(0).rateLimitCount, 100)
  const other = store({ errorPerMinuteLimit: 2, rateLimitPerMinuteLimit: 3 })
  other.recordReceipt(400, 0)
  assert.deepEqual(other.recordReceipt(429, 0), {
    guardOpen: true,
    errorCount: 2,
    rateLimitCount: 1
  })
})

for (const age of [59999, 60000, 60001]) {
  test(`Independent receipt and PUT windows expire at age ${age}`, () => {
    const guard = store()
    guard.recordReceipt(400, 0.25)
    guard.recordReceipt(429, 0.25)
    guard.recordPutDispatch('a', 0.25)
    const live = age < 60000
    assert.deepEqual(guard.snapshot(age + 0.25), {
      guardOpen: false,
      errorCount: live ? 2 : 0,
      rateLimitCount: live ? 1 : 0
    })
    assert.deepEqual(guard.checkPut('a', age + 0.25), { count: live ? 1 : 0 })
    assert.equal(puts(guard).size, live ? 1 : 0)
    assert.equal(timestamps(Reflect.get(guard, 'errors')).length, live ? 2 : 0)
    assert.equal(timestamps(Reflect.get(guard, 'rateLimits')).length, live ? 1 : 0)
  })
}

test('Staggered receipts retain newest bounded history and global opening remains final', () => {
  const guard = store({ errorPerMinuteLimit: 2, rateLimitPerMinuteLimit: 3 })
  guard.recordReceipt(429, 0)
  guard.recordReceipt(429, 100)
  guard.recordReceipt(429, 200)
  assert.deepEqual(guard.snapshot(60000), { guardOpen: true, errorCount: 2, rateLimitCount: 2 })
  assert.deepEqual(guard.snapshot(60100), { guardOpen: true, errorCount: 1, rateLimitCount: 1 })
  assert.deepEqual(guard.snapshot(60200), { guardOpen: true, errorCount: 0, rateLimitCount: 0 })
})

test('Two PUT keys have independent 59, 60, 61 dispatch decisions and no global stop', () => {
  const guard = store()
  for (let i = 1; i <= 59; i++) assert.deepEqual(guard.recordPutDispatch('a', 0), { count: i })
  assert.deepEqual(guard.recordPutDispatch('b', 0), { count: 1 })
  assert.deepEqual(guard.checkPut('a', 0), { count: 59 })
  assert.deepEqual(guard.recordPutDispatch('a', 0), { count: 60 })
  assert.deepEqual(guard.recordPutDispatch('a', 0), { count: 60, code: 'PUT_LIMIT' })
  assert.deepEqual(guard.checkPut('a', 59999), { count: 60, code: 'PUT_LIMIT' })
  assert.deepEqual(guard.recordPutDispatch('b', 59999), { count: 2 })
  assert.deepEqual(guard.snapshot(59999), { guardOpen: false, errorCount: 0, rateLimitCount: 0 })
  assert.deepEqual(guard.recordPutDispatch('a', 60000), { count: 1 })
  assert.deepEqual(guard.checkPut('b', 60000), { count: 1 })
  assert.deepEqual(guard.checkPut('a', 60001), { count: 1 })
})

test('PUT overrides preserve independent limits and repeated checks never charge or forget', () => {
  for (const limit of [1, 2, 61]) {
    const guard = store({ entityPutPerMinuteLimit: limit })
    for (let i = 1; i <= limit; i++) guard.recordPutDispatch('a', 0)
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(guard.checkPut('a', 1), { count: limit, code: 'PUT_LIMIT' })
      assert.deepEqual(guard.checkPut('new', 1), { count: 0 })
    }
    assert.equal(puts(guard).size, 1)
    assert.equal(timestamps(puts(guard).get('a')).length, limit)
    assert.deepEqual(guard.recordPutDispatch('b', 1), { count: 1 })
  }
})

test('Capacity 1024 rejects key 1025 without live eviction and expired histories free space', () => {
  const guard = store()
  for (let i = 0; i < 1024; i++) guard.recordPutDispatch(`key-${i}`, 0)
  assert.equal(puts(guard).size, 1024)
  assert.deepEqual(guard.recordPutDispatch('overflow', 59999), { count: 0, code: 'GUARD_CAPACITY' })
  assert.equal(puts(guard).size, 1024)
  for (let i = 0; i < 1024; i++) assert.deepEqual(guard.checkPut(`key-${i}`, 59999), { count: 1 })
  assert.deepEqual(guard.recordPutDispatch('overflow', 60000), { count: 1 })
  assert.equal(puts(guard).size, 1)
  assert.equal(puts(guard).has('key-0'), false)
  assert.deepEqual(guard.snapshot(1e12), { guardOpen: false, errorCount: 0, rateLimitCount: 0 })
  assert.equal(puts(guard).size, 0)
})

test('Configured key capacity preserves the live survivor when another history expires', () => {
  const guard = store({ maxEntityKeys: 2 })
  guard.recordPutDispatch('old', 0)
  guard.recordPutDispatch('live', 1)
  assert.deepEqual(guard.recordPutDispatch('third', 59999), { count: 0, code: 'GUARD_CAPACITY' })
  assert.deepEqual(guard.recordPutDispatch('third', 60000), { count: 1 })
  assert.deepEqual(guard.checkPut('live', 60000), { count: 1 })
  assert.equal(puts(guard).size, 2)
})

test('Opaque key identity uses exact UTF16 length and never appears in returned records', () => {
  const guard = store()
  for (const key of ['x', 'x'.repeat(127), 'x'.repeat(128), '😀'.repeat(64), ' a ', 'a', 'A']) {
    assert.deepEqual(guard.recordPutDispatch(key, 0), { count: 1 })
    assert.deepEqual(guard.checkPut(key, 0), { count: 1 })
  }
  for (const key of ['', 'x'.repeat(129), '😀'.repeat(65), undefined, 42]) {
    assert.throws(
      () => Reflect.apply((value: string) => guard.recordPutDispatch(value, 0), undefined, [key]),
      /INVALID_ARGUMENT/
    )
  }
  const key = 'SECRET_ENTITY_CANARY'
  const records = [guard.checkPut(key, 0), guard.recordPutDispatch(key, 0), guard.snapshot(0)]
  assert.equal(JSON.stringify(records).includes(key), false)
  assert.equal(puts(guard).size, 8)
})

test('Large configured safe counts allocate only actual history and copy scalar policy', () => {
  const options = {
    ...defaults,
    errorPerMinuteLimit: Number.MAX_SAFE_INTEGER,
    rateLimitPerMinuteLimit: Number.MAX_SAFE_INTEGER,
    entityPutPerMinuteLimit: Number.MAX_SAFE_INTEGER,
    maxEntityKeys: Number.MAX_SAFE_INTEGER
  }
  const guard = new GuardStore(options)
  options.maxEntityKeys = 1
  options.entityPutPerMinuteLimit = 1
  assert.equal(puts(guard).size, 0)
  assert.equal(timestamps(Reflect.get(guard, 'errors')).length, 0)
  guard.recordReceipt(429, 0)
  guard.recordPutDispatch('a', 0)
  assert.deepEqual(guard.recordPutDispatch('a', 0), { count: 2 })
  assert.deepEqual(guard.recordPutDispatch('b', 0), { count: 1 })
  assert.equal(timestamps(Reflect.get(guard, 'errors')).length, 1)
  assert.equal(timestamps(Reflect.get(guard, 'rateLimits')).length, 1)
})

test('Policy counts reject invalid numbers and caller time is finite monotonic, including fractions', () => {
  for (const field of Object.keys(defaults)) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new GuardStore({ ...defaults, [field]: value }), /INVALID_ARGUMENT/)
    }
  }
  const guard = store()
  guard.recordReceipt(200, 0.125)
  guard.recordReceipt(399, 0.125)
  assert.deepEqual(guard.snapshot(0.125), { guardOpen: false, errorCount: 0, rateLimitCount: 0 })
  for (const now of [NaN, Infinity, -Infinity, 0])
    assert.throws(() => guard.snapshot(now), /INVALID_ARGUMENT/)
  assert.deepEqual(guard.recordPutDispatch('a', 0.25), { count: 1 })
})

test('Existing public validation rejects missing PUT keys and mixed case methods before work', async () => {
  let sends = 0
  const transport: typeof globalThis.fetch = () => {
    sends++
    return Promise.resolve(new Response('ok'))
  }
  const planner = new FetchPlanner(transport)
  try {
    for (const fields of [
      { method: 'PUT' },
      { method: 'put', entityKey: 'a' },
      { method: 'Put', entityKey: 'a' },
      { method: 'get' },
      { method: 'GET', entityKey: 'a' }
    ]) {
      const spec: Spec<Init<typeof globalThis.fetch>, Response, number> = {
        method: 'GET',
        replay: { serverSafe: false, consumeSafe: false },
        prepare: () => {
          assert.fail('Invalid spec must not prepare')
        },
        consume: () => 0
      }
      Object.assign(spec, fields)
      const handle = planner.submit(spec)
      await assert.rejects(handle.result, { code: 'INVALID_ARGUMENT' })
      await handle.resourcesDone
    }
    assert.equal(sends, 0)
  } finally {
    planner.stop()
  }
})

const replay = { serverSafe: false, consumeSafe: false }
const secret = 'PRIVATE_GUARD_KEY_URL_BODY_VALUE_ERROR'

function diagnosticCounts(planner: { snapshot(): unknown }) {
  const observation: unknown = Reflect.get(planner, 'observation')
  assert.ok(observation instanceof OperationObservation)
  return observation.diagnostics.snapshot()
}

for (const family of ['native/root', 'undici/deep'] as const) {
  for (const status of [412, 429]) {
    for (const late of [false, true]) {
      test(`${family} actual receipt 99 and ${late ? 'late' : 'current'} 100 stop ready before hints and fanout ${status}`, async t => {
        const clock = createRuntime(t)
        const pending = deferred<Response>()
        const other = deferred<Response>()
        const prepare = deferred<undefined>()
        let sends = 0
        let forbidden = 0
        const transport: typeof fetch = () => {
          sends++
          if (sends === 99) return pending.promise
          if (sends === 100) return other.promise
          if (sends > 101) forbidden++
          return Promise.resolve(
            new Response('{}', {
              status,
              headers: {
                'content-type': 'application/json',
                ...(sends === 101 ? { 'x-lognex-reset': '1000' } : {})
              }
            })
          )
        }
        // Transport responses are materialized by the selected real Response implementation.
        const planner =
          family === 'native/root'
            ? new RootPlanner(transport, {
                maxParallelLimit: 4,
                ...(status === 429 ? { errorPerMinuteLimit: 1000 } : {})
              })
            : new FetchPlanner<typeof undiciFetch>(
                async () => {
                  const response = await transport('fixture')
                  return new UndiciResponse(response.body, {
                    status: response.status,
                    headers: response.headers
                  })
                },
                { maxParallelLimit: 4, ...(status === 429 ? { errorPerMinuteLimit: 1000 } : {}) }
              )
        const submit = () =>
          planner.submit({
            method: 'GET',
            replay,
            prepare: () => ({ url: secret, init: {} }),
            consume: response => response.text()
          })
        const records: unknown[] = []
        const guardAtFanout: boolean[] = []
        let armed = false
        let nested: ReturnType<typeof submit> | undefined
        planner.observe(event => {
          records.push(event, planner.snapshot())
          if (armed && event.type === 'headers-received') {
            guardAtFanout.push(planner.snapshot().guardOpen)
            nested ??= submit()
          }
        })
        const finish = async (handle: ReturnType<typeof submit>) => {
          if (status === 429) await assert.rejects(handle.result, { code: 'HTTP_FAILED', status })
          else assert.equal((await handle.result).status, status)
          await handle.resourcesDone
        }
        const handles: ReturnType<typeof submit>[] = []
        try {
          for (let i = 0; i < 98; i++) await finish(submit())
          assert.equal(planner.snapshot().guardOpen, false)
          const hundred = submit()
          const sibling = submit()
          handles.push(hundred, sibling)
          await clock.flush()
          const ninetyNine = submit()
          await finish(ninetyNine)
          assert.equal(sends, 101)
          assert.equal(planner.snapshot().guardOpen, false, 'Actual receipt99 baseline')
          const ready = submit()
          const preparing = planner.submit({
            method: 'GET',
            replay,
            prepare: async () => {
              await prepare.promise
              return { url: secret, init: {} }
            },
            consume: response => response.text()
          })
          handles.push(ready, preparing)
          await clock.flush()
          assert.equal(ready.snapshot().phase, 'ready')
          assert.equal(preparing.snapshot().phase, 'preparing')
          const queued = submit()
          handles.push(queued)
          assert.equal(queued.snapshot().phase, 'queued')
          if (late) {
            hundred.abort(secret)
            await assert.rejects(hundred.result, { code: 'ABORTED', serverOutcome: 'unknown' })
          }
          armed = true
          pending.resolve(
            new Response('{', {
              status,
              headers: {
                'content-type': 'application/json',
                'x-lognex-reset': 'malformed',
                'retry-after': 'invalid'
              }
            })
          )
          await clock.flush()
          await clock.advance(1000)
          assert.equal(forbidden, 0, 'NEXT_DISPATCH_MUST_NOT_ENTER')
          assert.equal(planner.snapshot().guardOpen, true)
          assert.equal(planner.snapshot().stopped, true)
          assert.deepEqual(guardAtFanout, [true])
          for (const handle of [ready, preparing, queued, nested]) {
            assert.ok(handle)
            await assert.rejects(handle.result, { code: 'GUARD_OPEN', dispatchEntered: false })
          }
          if (!late) {
            if (status === 429)
              await assert.rejects(hundred.result, { code: 'HTTP_FAILED', status: 429 })
            else assert.equal((await hundred.result).value, '{')
          }
          other.resolve(new Response('own-result', { status: 412 }))
          assert.equal((await sibling.result).value, 'own-result')
          assert.equal(sibling.snapshot().status, 412)
          prepare.resolve(undefined)
          await Promise.all(handles.map(handle => handle.resourcesDone))
          assert.equal(diagnosticCounts(planner).OBSERVER_FAILED, 0)
          assert.equal(diagnosticCounts(planner).INVALID_HINT, 2)
          assert.equal(JSON.stringify(records).includes(secret), false)
          await clock.advance(60001)
          assert.equal(planner.snapshot().guardOpen, true)
          assert.equal(planner.snapshot().leasedAttempts, 0)
          assert.equal(planner.snapshot().sentActive, 0)
        } finally {
          armed = false
          pending.resolve(new Response('{}', { status }))
          other.resolve(new Response('released'))
          prepare.resolve(undefined)
          planner.stop()
          for (const handle of handles) handle.abort()
          await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
        }
      })
    }
  }
}

test('Late actual receipt100 stops before a throwing hint accessor can admit the next transport', async t => {
  const clock = createRuntime(t)
  const receipt = deferred<Response>()
  let sends = 0
  let forbidden = 0
  const planner = new RootPlanner<typeof fetch>(
    () => {
      sends++
      if (sends === 99) return receipt.promise
      if (sends > 100) forbidden++
      return Promise.resolve(
        new Response('error', {
          status: 412,
          headers: sends === 100 ? { 'x-lognex-reset': '1000' } : {}
        })
      )
    },
    { maxParallelLimit: 2 }
  )
  const submit = () =>
    planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: secret, init: {} }),
      consume: response => response.text()
    })
  const late = []
  let nested: ReturnType<typeof submit> | undefined
  const seen: unknown[] = []
  try {
    for (let i = 0; i < 98; i++) {
      const handle = submit()
      await handle.result
      await handle.resourcesDone
    }
    const hundred = submit()
    late.push(hundred)
    await clock.flush()
    const ninetyNine = submit()
    await ninetyNine.result
    await ninetyNine.resourcesDone
    assert.equal(planner.snapshot().guardOpen, false)
    const ready = submit()
    late.push(ready)
    await clock.flush()
    assert.equal(ready.snapshot().phase, 'ready')
    hundred.abort()
    await assert.rejects(hundred.result, { code: 'ABORTED' })
    const response = new Response('{', { status: 429, headers: { 'retry-after': 'invalid' } })
    Object.defineProperty(response.headers, 'get', {
      value: () => {
        seen.push(planner.snapshot())
        nested = submit()
        throw new Error(secret)
      }
    })
    receipt.resolve(response)
    await clock.flush()
    await clock.advance(1000)
    assert.equal(forbidden, 0, 'NEXT_DISPATCH_MUST_NOT_ENTER')
    assert.equal(planner.snapshot().guardOpen, true)
    assert.ok(seen.length > 0)
    assert.equal(JSON.stringify(seen).includes('"guardOpen":false'), false)
    assert.ok(nested)
    await assert.rejects(nested.result, { code: 'GUARD_OPEN' })
    await assert.rejects(ready.result, { code: 'GUARD_OPEN' })
    await Promise.all(late.map(handle => handle.resourcesDone))
    assert.equal(diagnosticCounts(planner).OBSERVER_FAILED, 0)
  } finally {
    receipt.resolve(new Response('released'))
    planner.stop()
    for (const handle of late) handle.abort()
    await Promise.allSettled(late.flatMap(handle => [handle.result, handle.resourcesDone]))
  }
})

function putFixture(
  t: Parameters<typeof createRuntime>[0],
  options: Partial<FetchPlannerOptions> = {}
) {
  const clock = createRuntime(t)
  let sends = 0
  let disposals = 0
  const records: unknown[] = []
  const planner = new RootPlanner<typeof fetch>(() => {
    sends++
    return Promise.resolve(new Response(secret))
  }, options)
  planner.observe(event => {
    records.push(event, planner.snapshot())
  })
  const spec = (entityKey: string): Spec<Init<typeof fetch>, Response, string> => ({
    method: 'PUT',
    entityKey,
    replay,
    prepare: context => {
      context.onDispose(() => {
        disposals++
      })
      return { url: secret, init: { body: secret } }
    },
    consume: response => response.text()
  })
  const send = async (entityKey: string) => {
    const handle = planner.submit(spec(entityKey))
    assert.equal((await handle.result).value, secret)
    await handle.resourcesDone
    return handle
  }
  const deny = async (key: string, code: 'PUT_LIMIT' | 'GUARD_CAPACITY') => {
    const before = sends
    const handle = planner.submit(spec(key))
    await handle.resourcesDone
    assert.equal(sends, before, 'PUT61_DISPATCH_MUST_NOT_ENTER')
    await assert.rejects(handle.result, {
      code,
      dispatchEntered: false,
      serverOutcome: 'not-dispatched'
    })
    assert.equal(handle.snapshot().dispatchCalls, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().stopped, false)
    return handle
  }
  return {
    clock,
    planner,
    spec,
    send,
    deny,
    sends: () => sends,
    disposals: () => disposals,
    records
  }
}

test('Actual PUT59,60,61 are per immutable captured key and preserve GET, privacy and expiry', async t => {
  const f = putFixture(t)
  const gate = deferred<undefined>()
  let delayed: ReturnType<typeof f.planner.submit> | undefined
  try {
    for (let i = 0; i < 59; i++) await f.send(secret)
    await f.send('other')
    assert.equal(f.sends(), 60)
    const input = f.spec(secret)
    input.prepare = async context => {
      context.onDispose(() => undefined)
      await gate.promise
      return { url: secret, init: {} }
    }
    const handle = f.planner.submit(input)
    delayed = handle
    input.entityKey = 'other'
    gate.resolve(undefined)
    await handle.result
    await handle.resourcesDone
    await f.deny(secret, 'PUT_LIMIT')
    assert.equal(f.sends(), 61, 'Actual PUT61 must not dispatch')
    await f.send('other')
    const get = f.planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: secret, init: {} }),
      consume: response => response.text()
    })
    await get.result
    await get.resourcesDone
    await f.clock.advance(59999)
    await f.deny(secret, 'PUT_LIMIT')
    await f.clock.advance(1)
    await f.send(secret)
    await f.clock.advance(1)
    await f.send(secret)
    assert.equal(f.sends(), 65)
    assert.equal(f.disposals(), 65)
    assert.equal(JSON.stringify(f.records).includes(secret), false)
    assert.deepEqual(diagnosticCounts(f.planner), {
      OBSERVER_FAILED: 0,
      INVALID_HINT: 0,
      LATE_COMPLETION: 0,
      rejections: {}
    })
  } finally {
    gate.resolve(undefined)
    f.planner.stop()
    if (delayed) await delayed.resourcesDone
  }
})

test('Actual capacity1024 rejects live key1025 without forgetting history, expiry frees it', async t => {
  const f = putFixture(t, { entityPutPerMinuteLimit: 1 })
  try {
    for (let i = 0; i < 1024; i++) await f.send(`key-${i}`)
    await f.clock.advance(59999)
    await f.deny('overflow', 'GUARD_CAPACITY')
    await f.deny('key-0', 'PUT_LIMIT')
    await f.deny('key-1023', 'PUT_LIMIT')
    await f.clock.advance(1)
    await f.send('overflow')
    await f.send('key-0')
    assert.equal(f.sends(), 1026)
    assert.equal(f.disposals(), 1029)
    assert.equal(f.planner.snapshot().guardOpen, false)
  } finally {
    f.planner.stop()
  }
})

test('Actual UTF16 keys127,128 accepted,129 invalid and exact identity is preserved', async t => {
  const f = putFixture(t, { entityPutPerMinuteLimit: 1 })
  try {
    for (const key of ['x', 'x'.repeat(127), '😀'.repeat(64), 'a', 'A', ' a ']) {
      await f.send(key)
      await f.deny(key, 'PUT_LIMIT')
    }
    for (const key of ['', 'x'.repeat(129), '😀'.repeat(64) + 'x']) {
      const handle = f.planner.submit(f.spec(key))
      await assert.rejects(handle.result, { code: 'INVALID_ARGUMENT' })
      await handle.resourcesDone
    }
    assert.equal(f.sends(), 6)
    assert.equal(f.planner.snapshot().stopped, false)
  } finally {
    f.planner.stop()
  }
})

test('Prepared rejected and aborted PUTs never charge history', async t => {
  const f = putFixture(t, { entityPutPerMinuteLimit: 1, maxEntityKeys: 1 })
  const gate = deferred<undefined>()
  const input = f.spec('a')
  input.prepare = async () => {
    await gate.promise
    throw new Error(secret)
  }
  const aborted = f.planner.submit(input)
  try {
    await f.clock.flush()
    aborted.abort()
    await assert.rejects(aborted.result, { code: 'ABORTED' })
    gate.resolve(undefined)
    await aborted.resourcesDone
    const broken = f.spec('a')
    broken.prepare = () => {
      throw new Error(secret)
    }
    const failed = f.planner.submit(broken)
    await assert.rejects(failed.result, { code: 'PREPARE_FAILED' })
    await failed.resourcesDone
    await f.send('a')
    await f.deny('a', 'PUT_LIMIT')
    assert.equal(f.sends(), 1)
  } finally {
    gate.resolve(undefined)
    f.planner.stop()
    await aborted.resourcesDone
  }
})

test('Actual hundredth429 opens before pending classifier and preserves its HTTP result and cleanup', async t => {
  const clock = createRuntime(t)
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let sends = 0
  let consumes = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      }
    }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': 'malformed' } }
  )
  const planner = new RootPlanner<typeof fetch>(() => {
    sends++
    return Promise.resolve(sends === 100 ? response : new Response('valid-value', { status: 412 }))
  })
  const submit = () =>
    planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: secret, init: {} }),
      consume: body => {
        consumes++
        return body.text()
      }
    })
  let current: ReturnType<typeof submit> | undefined
  try {
    for (let i = 0; i < 99; i++) {
      const handle = submit()
      await handle.result
      await handle.resourcesDone
    }
    current = submit()
    await clock.flush()
    assert.equal(planner.snapshot().guardOpen, true)
    assert.equal(current.snapshot().phase, 'classifying')
    assert.equal(current.snapshot().outcome, 'pending')
    assert.equal(current.snapshot().status, 429)
    assert.equal(planner.snapshot().sentActive, 1)
    const denied = submit()
    await assert.rejects(denied.result, { code: 'GUARD_OPEN' })
    await clock.advance(249)
    assert.equal(current.snapshot().outcome, 'pending')
    await clock.advance(1)
    await assert.rejects(current.result, {
      code: 'HTTP_FAILED',
      status: 429,
      serverOutcome: 'http-response'
    })
    await current.resourcesDone
    assert.equal(sends, 100)
    assert.equal(consumes, 99)
    assert.equal(diagnosticCounts(planner).INVALID_HINT, 1)
    assert.equal(diagnosticCounts(planner).OBSERVER_FAILED, 0)
  } finally {
    if (!response.bodyUsed) controller?.close()
    planner.stop()
    current?.abort()
    if (current) await current.resourcesDone
  }
})

test('Late guard opening preserves the first explicit stop reason and full current fanout', async t => {
  const clock = createRuntime(t)
  const receipt = deferred<Response>()
  const reason = new Error(secret)
  const planner = new RootPlanner<typeof fetch>(() => receipt.promise, { errorPerMinuteLimit: 1 })
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: secret, init: {} }),
    consume: body => body.text()
  })
  const fanout: number[] = []
  planner.observe(event => {
    if (event.type === 'headers-received') {
      fanout.push(1)
      planner.stop('second')
    }
  })
  planner.observe(event => {
    if (event.type === 'headers-received') fanout.push(2)
  })
  try {
    await clock.flush()
    planner.stop(reason)
    receipt.resolve(new Response('own-value', { status: 412 }))
    assert.equal((await handle.result).value, 'own-value')
    await handle.resourcesDone
    assert.deepEqual(fanout, [1, 2])
    assert.equal(planner.snapshot().guardOpen, true)
    const denied = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: secret, init: {} }),
      consume: body => body.text()
    })
    await assert.rejects(denied.result, { code: 'STOPPED', cause: reason })
  } finally {
    receipt.resolve(new Response('released'))
    planner.stop()
    await handle.resourcesDone
  }
})
