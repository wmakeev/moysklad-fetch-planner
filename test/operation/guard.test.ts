import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GuardStore } from '../../src/guard.js'
import { FetchPlanner } from '../../src/planner.js'
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
