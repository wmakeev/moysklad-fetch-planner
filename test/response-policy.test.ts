import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Headers, Response } from 'undici'
import { FetchPlanner, OperationError, type Event } from '../src/index.js'
import { OperationObservation } from '../src/operation-observation.js'
import { createRuntime } from './helpers/runtime.js'
import { deferred } from './operation/helpers.js'
import { parseResponsePolicy } from '../src/response-policy.js'

const replay = { serverSafe: false, consumeSafe: false }
const receipt = { monotonic: 1000, wall: 1_000_000 }
const headers = [
  ['x-ratelimit-limit', 'limit', false],
  ['x-ratelimit-remaining', 'remaining', true],
  ['x-lognex-retry-timeInterval', 'retryTimeInterval', false],
  ['x-lognex-retry-after', 'serverNotBefore', true]
] as const

function diagnostics(planner: { snapshot(): unknown }) {
  const observation: unknown = Reflect.get(planner, 'observation')
  assert.ok(observation instanceof OperationObservation)
  return observation.diagnostics.snapshot()
}

for (const [name, field, zeroAllowed] of headers) {
  test(`Migrated Header policy validates ${name} without changing its input`, () => {
    const input = new Headers()
    const missing = parseResponsePolicy(429, input, receipt)
    assert.equal(missing[field], field === 'serverNotBefore' ? 0 : null)
    assert.equal(missing.invalidHints, 0)
    for (const raw of [
      '0',
      '7',
      '7ms',
      '12items',
      'NaN',
      'Infinity',
      '-Infinity',
      '-1',
      '9007199254740992',
      'invalid',
      ''
    ]) {
      input.set(name, raw)
      // A malformed field cannot discard a valid sibling.
      const sibling = field === 'limit' ? 'x-ratelimit-remaining' : 'x-ratelimit-limit'
      input.set(sibling, '9')
      const before = [...input]
      const valid = raw === '7' || (raw === '0' && zeroAllowed)
      const policy = parseResponsePolicy(429, input, receipt)
      assert.equal(policy.invalidHints, valid ? 0 : 1, `INVALID_HINT:${name}:${raw}`)
      assert.equal(
        policy[field],
        valid
          ? field === 'serverNotBefore'
            ? receipt.monotonic + Number(raw)
            : Number(raw)
          : field === 'serverNotBefore'
            ? 0
            : null,
        `STRICT_VALUE:${name}:${raw}`
      )
      assert.equal(policy[field === 'limit' ? 'remaining' : 'limit'], 9, 'VALID_SIBLING_SURVIVES')
      assert.deepEqual([...input], before, 'INPUT_HEADERS_NOT_MUTATED')
    }
    input.set(name, String(Number.MAX_SAFE_INTEGER))
    const before = [...input]
    // MAX_SAFE is a valid duration at zero, but overflows an absolute positive receipt.
    const atZero = parseResponsePolicy(429, input, { monotonic: 0, wall: receipt.wall })
    assert.equal(atZero[field], Number.MAX_SAFE_INTEGER)
    assert.equal(atZero.invalidHints, 0)
    const atReceipt = parseResponsePolicy(429, input, receipt)
    assert.equal(atReceipt[field], field === 'serverNotBefore' ? 0 : Number.MAX_SAFE_INTEGER)
    assert.equal(atReceipt.invalidHints, field === 'serverNotBefore' ? 1 : 0)
    assert.deepEqual([...input], before)
  })
}

test('Migrated Header policy preserves missing and partial updates and raw remaining above limit', () => {
  assert.deepEqual(parseResponsePolicy(200, new Headers(), receipt), {
    limit: null,
    remaining: null,
    retryTimeInterval: null,
    serverNotBefore: 0,
    invalidHints: 0,
    responseType: 'OK'
  })
  assert.deepEqual(
    parseResponsePolicy(200, new Headers({ 'x-ratelimit-remaining': '12' }), receipt),
    {
      limit: null,
      remaining: 12,
      retryTimeInterval: null,
      serverNotBefore: 0,
      invalidHints: 0,
      responseType: 'OK'
    }
  )
  const input = new Headers({ 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '12' })
  const before = [...input]
  const policy = parseResponsePolicy(200, input, receipt)
  assert.equal(policy.limit, 10)
  assert.equal(policy.remaining, 12, 'RAW_REMAINING_ABOVE_LIMIT_NOT_CLAMPED')
  assert.equal(policy.invalidHints, 0)
  assert.deepEqual([...input], before)
})

test('Migrated Response classification preserves legacy 429 and all other HTTP statuses', () => {
  for (const status of [200, 400, 401, 403, 404, 412, 500, 503, 429]) {
    const policy = parseResponsePolicy(
      status,
      new Headers({
        'x-lognex-auth': '429005',
        'x-lognex-retry-after': 'invalid'
      }),
      receipt
    )
    assert.equal(policy.responseType, status === 429 ? 'PARALLEL_LIMIT_OVERFLOW' : 'OK')
    assert.equal(policy.serverNotBefore, 0)
    assert.equal(policy.invalidHints, 1, 'STATUS_DOES_NOT_HIDE_INVALID_HINT')
  }
  for (const auth of ['', '429002', '1073']) {
    const policy = parseResponsePolicy(
      429,
      new Headers({
        'x-lognex-auth': auth,
        'x-lognex-reset': '1000'
      }),
      receipt
    )
    assert.equal(policy.responseType, 'RATE_LIMIT_OVERFLOW')
    assert.equal(policy.serverNotBefore, receipt.monotonic + 1000, 'RESET_IS_RECEIPT_RELATIVE')
    assert.equal(policy.invalidHints, 0)
  }
  const zero = parseResponsePolicy(429, new Headers({ 'x-lognex-retry-after': '0' }), receipt)
  assert.equal(zero.serverNotBefore, receipt.monotonic)
  assert.equal(zero.invalidHints, 0)
  const invalid = parseResponsePolicy(
    429,
    new Headers({ 'x-lognex-retry-after': 'invalid' }),
    receipt
  )
  assert.equal(invalid.serverNotBefore, 0)
  assert.equal(invalid.invalidHints, 1)
})

for (const initialRemaining of [5, 10]) {
  test(`Migrated Planner applies partial headers, preserves missing state and returns non-429 responses at remaining ${initialRemaining}`, async t => {
    const runtime = createRuntime(t)
    const responses = [
      new Response('initial', {
        headers: {
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': String(initialRemaining),
          'x-lognex-retry-timeinterval': '1000'
        }
      }),
      new Response('invalid partial', {
        status: 412,
        headers: { 'x-ratelimit-remaining': '12items' }
      }),
      new Response('valid partial', { status: 412, headers: { 'x-ratelimit-remaining': '12' } }),
      new Response('missing', { status: 503 }),
      new Response('limit only', { headers: { 'x-ratelimit-limit': '20' } }),
      new Response('retained remaining')
    ]
    const starts: number[] = []
    const events: Event[] = []
    let index = 0
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () => {
        starts.push(performance.now())
        const response = responses[index++]
        assert.ok(response)
        return Promise.resolve(response)
      },
      { maxParallelLimit: 1, jitter: 0, throttlingCoefficient: 1, maxRequestDelayTimeMs: 1000 }
    )
    planner.observe(event => {
      events.push(event)
    })
    const handles = []
    const delay = initialRemaining === 5 ? 500 : 0
    try {
      for (const [i, response] of responses.entries()) {
        const handle = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: 'http://offline.test/policy', init: {} }),
          consume: borrowed => {
            assert.equal(borrowed, response, 'TRANSPORT_IDENTITY_ONLY_INSIDE_CONSUME')
            assert.equal(borrowed.bodyUsed, false, 'NON429_BODY_UNREAD')
            assert.equal(borrowed.status, response.status)
            return borrowed.text()
          }
        })
        handles.push(handle)
        await runtime.advance(0)
        if ((i === 1 || i === 2) && delay > 0) {
          assert.equal(handle.snapshot().phase, 'ready')
          await runtime.advance(delay - 1)
          assert.equal(starts.length, i, 'PARTIAL_HINT_NO_EARLY_SEND')
          await runtime.advance(1)
        }
        if (i === 5) {
          // Raw remaining12 survives missing503 and limit-only20: (1-12/20)*1000=400.
          assert.equal(starts.length, 5, 'MISSING_REMAINING_NO_EARLY_DISPATCH')
          await runtime.advance(399)
          assert.equal(starts.length, 5, 'MISSING_REMAINING_BEFORE_BOUNDARY')
          await runtime.advance(1)
          assert.equal(starts.length, 6, 'MISSING_RAW_REMAINING_RETAINED_12')
        }
        const completed = await handle.result
        assert.equal(
          completed.value,
          [
            'initial',
            'invalid partial',
            'valid partial',
            'missing',
            'limit only',
            'retained remaining'
          ][i]
        )
        assert.equal(completed.status, response.status)
        assert.equal(completed.cleanup, 'released')
        await handle.resourcesDone
        assert.equal(
          diagnostics(planner).INVALID_HINT,
          i === 0 ? 0 : 1,
          'EXACT_RECEIPT_INVALID_HINT'
        )
      }
      assert.deepEqual(
        starts,
        [
          1_000_000,
          1_000_000 + delay,
          1_000_000 + 2 * delay,
          1_000_000 + 2 * delay,
          1_000_000 + 2 * delay,
          1_000_000 + 2 * delay + 400
        ],
        'PARTIAL_INVALID_PRESERVES_PACING_VALID_ABOVE_LIMIT_CLEARS_DELAY'
      )
      assert.deepEqual(
        events.filter(event => event.type === 'headers-received').map(event => event.status),
        [200, 412, 412, 503, 200, 200]
      )
      assert.equal(planner.snapshot().queued, 0)
      assert.equal(planner.snapshot().sentActive, 0)
      assert.equal(planner.snapshot().leasedAttempts, 0)
    } finally {
      planner.stop()
      for (const handle of handles) handle.abort()
      await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
    }
  })
}

test('Migrated Parsing valid and invalid headers cannot mutate a pending planner queue', async t => {
  const runtime = createRuntime(t)
  const starts: number[] = []
  const response = new Response('finished')
  const planner = new FetchPlanner<typeof import('undici').fetch>(() => {
    starts.push(performance.now())
    return Promise.resolve(response)
  })
  const pending = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: 'http://offline.test/pending', init: {} }),
    consume: borrowed => {
      assert.equal(borrowed, response)
      assert.equal(borrowed.bodyUsed, false)
      return borrowed.text()
    }
  })
  try {
    assert.equal(planner.snapshot().queued, 1)
    const before = planner.snapshot()
    const prefix = parseResponsePolicy(429, new Headers({ 'x-lognex-retry-after': '7ms' }), receipt)
    assert.equal(prefix.invalidHints, 1, 'PREFIX_7MS_EXACT_INVALID_HINT')
    assert.equal(prefix.serverNotBefore, 0)
    const invalid = parseResponsePolicy(
      429,
      new Headers({ 'x-lognex-retry-after': 'invalid' }),
      receipt
    )
    assert.equal(invalid.invalidHints, 1)
    const valid = parseResponsePolicy(
      429,
      new Headers({
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '0',
        'x-lognex-retry-after': '7000'
      }),
      receipt
    )
    assert.equal(valid.serverNotBefore, 8000)
    assert.equal(valid.limit, 10)
    assert.equal(valid.remaining, 0)
    assert.equal(valid.invalidHints, 0)
    assert.deepEqual(planner.snapshot(), before, 'PARSER_CANNOT_MUTATE_PENDING_QUEUE_OR_PAUSE')
    assert.equal(diagnostics(planner).INVALID_HINT, 0, 'PURE_PARSER_DOES_NOT_COUNT_RECEIPTS')
    await runtime.advance(0)
    assert.equal((await pending.result).value, 'finished')
    await pending.resourcesDone
    assert.deepEqual(starts, [1_000_000], 'PARSER_DOES_NOT_SEED_PACING')
    assert.equal(planner.snapshot().queued, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  } finally {
    planner.stop()
    pending.abort()
    await Promise.allSettled([pending.result, pending.resourcesDone])
  }
})

for (const auth of ['429005', '429002', '1073', '']) {
  test(`Legacy 429 classification applies effective parallelism for auth ${JSON.stringify(auth)}`, async t => {
    createRuntime(t)
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () =>
        Promise.resolve(
          new Response(null, {
            status: 429,
            headers: { 'x-lognex-auth': auth, 'x-lognex-retry-after': '7ms' }
          })
        ),
      { maxParallelLimit: 4 }
    )
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: 'http://offline.test/429', init: {} }),
      consume: () => assert.fail('INTERCEPTED_429_NEVER_CONSUMED')
    })
    try {
      await assert.rejects(
        handle.result,
        error =>
          error instanceof OperationError && error.code === 'HTTP_FAILED' && error.status === 429
      )
      await handle.resourcesDone
      assert.equal(handle.snapshot().dispatchCalls, 1, 'UNSAFE_429_NOT_REPLAYED')
      assert.equal(planner.snapshot().effectiveParallelism, auth === '429005' ? 3 : 4)
      assert.equal(diagnostics(planner).INVALID_HINT, 1, 'PUBLIC_PREFIX_EXACT_INVALID_HINT')
    } finally {
      planner.stop()
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const [serverSafe, consumeSafe] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true]
]) {
  test(`429 replay requires both flags and released cleanup ${serverSafe}/${consumeSafe}`, async t => {
    const runtime = createRuntime(t)
    const release = deferred<undefined>()
    let calls = 0
    let disposals = 0
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () =>
        Promise.resolve(++calls === 1 ? new Response(null, { status: 429 }) : new Response('done')),
      { jitter: 0, maxParallelLimit: 1 }
    )
    const handle = planner.submit({
      method: 'POST',
      replay: { serverSafe: serverSafe === true, consumeSafe: consumeSafe === true },
      prepare: context => {
        context.onDispose(async () => {
          disposals++
          await release.promise
        })
        return { url: 'http://offline.test/replay', init: { body: 'same payload' } }
      },
      consume: response => response.text()
    })
    const eligible = serverSafe && consumeSafe
    const outcome = eligible
      ? handle.result
      : assert.rejects(handle.result, { code: 'HTTP_FAILED', status: 429 })
    try {
      await runtime.advance(0)
      assert.equal(disposals, 1)
      assert.equal(calls, 1)
      assert.equal(planner.snapshot().sentActive, 1, 'PENDING_CLEANUP_RETAINS_SENT')
      assert.equal(planner.snapshot().leasedAttempts, 1)
      await runtime.advance(2999)
      assert.equal(calls, 1, 'NO_RETRY_BEFORE_RELEASE')
      release.resolve(undefined)
      await runtime.advance(0)
      await runtime.advance(3000)
      await outcome
      await handle.resourcesDone
      if (eligible) assert.equal((await handle.result).value, 'done')
      assert.equal(calls, eligible ? 2 : 1)
      assert.equal(disposals, calls)
      assert.equal(planner.snapshot().sentActive, 0)
    } finally {
      release.resolve(undefined)
      planner.stop()
      handle.abort()
      await Promise.allSettled([outcome, handle.result, handle.resourcesDone])
    }
  })
}

for (const status of [412, 503]) {
  test(`Non429 ${status} branded consume failure cannot replay even with both flags`, async t => {
    createRuntime(t)
    let calls = 0
    const cause = new Error('consumer read failure')
    const planner = new FetchPlanner<typeof import('undici').fetch>(() => {
      calls++
      return Promise.resolve(new Response('error body', { status }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay: { serverSafe: true, consumeSafe: true },
      prepare: () => ({ url: 'http://offline.test/error', init: { body: 'payload' } }),
      consume: async (response, context) => {
        assert.equal(response.bodyUsed, false)
        assert.equal(response.status, status)
        assert.equal(await response.text(), 'error body')
        throw context.retryableReadFailure(cause)
      }
    })
    try {
      await assert.rejects(
        handle.result,
        error =>
          error instanceof OperationError &&
          error.code === 'CONSUME_FAILED' &&
          error.status === status
      )
      await handle.resourcesDone
      assert.equal(calls, 1, 'NON2XX_NEVER_AUTOMATICALLY_REPLAYED')
    } finally {
      planner.stop()
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Public retained limit survives remaining-only and missing receipts', async t => {
  const runtime = createRuntime(t)
  const starts: number[] = []
  const responses = [
    new Response('initial', {
      headers: {
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '12',
        'x-lognex-retry-timeinterval': '1000'
      }
    }),
    new Response('remaining only', { headers: { 'x-ratelimit-remaining': '5' } }),
    new Response('missing', { status: 503 }),
    new Response('retained limit')
  ]
  let index = 0
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () => {
      starts.push(performance.now())
      const response = responses[index++]
      assert.ok(response)
      return Promise.resolve(response)
    },
    { jitter: 0, throttlingCoefficient: 1, maxRequestDelayTimeMs: 1000 }
  )
  const handles = []
  try {
    for (const [i, response] of responses.entries()) {
      const h = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: 'http://offline.test/retained-limit', init: {} }),
        consume: borrowed => {
          assert.equal(borrowed, response)
          assert.equal(borrowed.bodyUsed, false)
          return borrowed.text()
        }
      })
      handles.push(h)
      await runtime.advance(0)
      if (i >= 2) {
        // Retained limit10 and remaining5: (1-5/10)*1000=500 after each receipt.
        assert.equal(starts.length, i, 'RETAINED_LIMIT_NO_EARLY_DISPATCH')
        await runtime.advance(499)
        assert.equal(starts.length, i, 'RETAINED_LIMIT_BEFORE_BOUNDARY')
        await runtime.advance(1)
        assert.equal(starts.length, i + 1, 'RETAINED_LIMIT_EXACT_BOUNDARY')
      }
      const completed = await h.result
      assert.equal(completed.value, ['initial', 'remaining only', 'missing', 'retained limit'][i])
      assert.equal(completed.status, response.status)
      await h.resourcesDone
      assert.equal(diagnostics(planner).INVALID_HINT, 0)
    }
    assert.deepEqual(starts, [1_000_000, 1_000_000, 1_000_500, 1_001_000])
    assert.equal(planner.snapshot().queued, 0)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  } finally {
    planner.stop()
    for (const h of handles) h.abort()
    await Promise.allSettled(handles.flatMap(h => [h.result, h.resourcesDone]))
  }
})
