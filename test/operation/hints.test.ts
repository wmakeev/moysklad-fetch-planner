import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici'
import { OperationObservation } from '../../src/operation-observation.js'
import { parseResponsePolicy } from '../../src/response-policy.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

test('Missing hints preserve unread success on the public receipt path', async () => {
  const response = new Response('value')
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(response))
  const handle = planner.submit({
    method: 'GET',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({ url: 'https://example.invalid', init: {} }),
    consume: async body => {
      assert.equal(body.bodyUsed, false)
      return body.text()
    }
  })
  assert.equal((await handle.result).value, 'value')
  await handle.resourcesDone
  assert.equal(planner.snapshot().serverNotBefore, 0)
})

const replay = { serverSafe: false, consumeSafe: false }
const canary = 'PRIVATE_HINT_URL_ERROR_VALUE'
const fields = [
  ['x-lognex-retry-timeinterval', 'retryTimeInterval', 1],
  ['x-ratelimit-limit', 'limit', 1],
  ['x-ratelimit-remaining', 'remaining', 0],
  ['x-lognex-retry-after', 'serverNotBefore', 0],
  ['x-lognex-reset', 'serverNotBefore', 0],
  ['retry-after', 'serverNotBefore', 0]
] as const
const invalidNumbers = [
  '',
  ' ',
  '\t12',
  '12 ',
  '12\n',
  '12\r',
  '1 2',
  '+12',
  '-1',
  '0x12',
  '12junk',
  '1.5',
  '1e2',
  'NaN',
  'Infinity',
  '9007199254740992',
  '12, 13',
  canary
]

function diagnostics(planner: { snapshot(): unknown }, expected: number) {
  const observation: unknown = Reflect.get(planner, 'observation')
  assert.ok(observation instanceof OperationObservation)
  const actual = observation.diagnostics.snapshot()
  assert.deepEqual(actual, {
    OBSERVER_FAILED: 0,
    INVALID_HINT: expected,
    LATE_COMPLETION: 0,
    rejections: {}
  })
  assert.equal(JSON.stringify(actual).includes(canary), false)
}

const numericCases: readonly (readonly [string | null, number | null])[] = [
  [null, null],
  ['0', 0],
  ['1', 1],
  ['0012', 12],
  ['45', 45],
  ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ...invalidNumbers.map(raw => [raw, null] as const)
]

for (const [header, property, minimum] of fields) {
  for (const [raw, value] of numericCases) {
    test(`Direct exposed ${header} strictly parses ${JSON.stringify(raw)}`, () => {
      const result = parseResponsePolicy(
        200,
        { get: name => (name === header ? raw : null) },
        { monotonic: 1000, wall: 1000000 }
      )
      const scaled = value === null ? null : value * (header === 'retry-after' ? 1000 : 1)
      const isPause = property === 'serverNotBefore'
      const valid =
        value !== null && value >= minimum && (!isPause || value !== Number.MAX_SAFE_INTEGER)
      assert.equal(result.invalidHints, raw === null || valid ? 0 : 1)
      assert.equal(
        result[property],
        valid ? (isPause ? 1000 + Number(scaled) : value) : isPause ? 0 : null
      )
    })
  }
}

for (const family of ['native/root', 'undici/deep'] as const) {
  function fixture(headers: Record<string, string>, status = 200, body = canary) {
    if (family === 'native/root') {
      const response = new Response(body, { status, headers })
      return { response, planner: new FetchPlanner<typeof fetch>(() => Promise.resolve(response)) }
    }
    const response = new UndiciResponse(body, { status, headers })
    return {
      response,
      planner: new DeepPlanner<typeof undiciFetch>(() => Promise.resolve(response))
    }
  }
  for (const [header, property, minimum] of fields) {
    const cases: readonly (readonly [string, number | null])[] = [
      ['0', 0],
      ['12', 12],
      ['0012', 12],
      ['12junk', null],
      ['-1', null],
      ['1.5', null],
      ['9007199254740992', null],
      [canary, null]
    ]
    for (const [raw, value] of cases) {
      test(`${family} public receipt independently applies ${header}=${raw}`, async t => {
        createRuntime(t)
        const sibling = header === 'x-lognex-reset' ? 'x-lognex-retry-after' : 'x-lognex-reset'
        const source = fixture({ [header]: raw, [sibling]: '5000' })
        const records: unknown[] = []
        source.planner.observe(event => {
          records.push(event, source.planner.snapshot())
        })
        const handle = source.planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: canary, init: {} }),
          consume: response => {
            assert.equal(response.bodyUsed, false)
            return response.text()
          }
        })
        try {
          assert.equal((await handle.result).value, canary)
          await handle.resourcesDone
          const valid = value !== null && value >= minimum
          diagnostics(source.planner, valid ? 0 : 1)
          const duration =
            valid && property === 'serverNotBefore'
              ? Number(raw) * (header === 'retry-after' ? 1000 : 1)
              : 0
          assert.equal(
            source.planner.snapshot().serverNotBefore,
            1000000 + Math.max(5000, duration)
          )
          assert.equal(handle.snapshot().dispatchCalls, 1)
          assert.equal(JSON.stringify(records).includes(canary), false)
        } finally {
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }
  test(`${family} missing hints and transport OWS normalization have exact zero diagnostics`, async t => {
    createRuntime(t)
    const cases: Record<string, string>[] = [{}, { 'x-lognex-retry-after': ' \t12\t ' }]
    for (const headers of cases) {
      const source = fixture(headers)
      const exposed = source.response.headers.get('x-lognex-retry-after')
      assert.ok(exposed === null || exposed === '12')
      const handle = source.planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: canary, init: {} }),
        consume: response => response.text()
      })
      await handle.result
      await handle.resourcesDone
      diagnostics(source.planner, 0)
      assert.equal(source.planner.snapshot().serverNotBefore, exposed === null ? 0 : 1000012)
    }
  })
  test(`${family} both malformed fields increment independently`, async t => {
    createRuntime(t)
    const source = fixture({ 'retry-after': canary, 'x-lognex-retry-after': '12junk' })
    const handle = source.planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: canary, init: {} }),
      consume: response => response.text()
    })
    await handle.result
    await handle.resourcesDone
    diagnostics(source.planner, 2)
    assert.equal(source.planner.snapshot().serverNotBefore, 0)
  })
  for (const [label, raw, wall, expectedDate] of [
    ['V37F1 original leap second', 'Sat, 31 Dec 2016 23:59:60 GMT', 1483228799000, 1483228800000],
    ['leap second RFC850', 'Saturday, 31-Dec-16 23:59:60 GMT', 1483228799000, 1483228800000],
    ['leap second asctime', 'Sat Dec 31 23:59:60 2016', 1483228799000, 1483228800000],
    [
      'V37F2 original full timestamp',
      'Friday, 31-Dec-76 23:59:59 GMT',
      Date.UTC(2026, 0, 1),
      Date.UTC(1976, 11, 31, 23, 59, 59)
    ],
    [
      '50 year boundary before by one millisecond',
      'Monday, 15-Jun-76 12:34:56 GMT',
      Date.UTC(2026, 5, 15, 12, 34, 56, 1),
      Date.UTC(2076, 5, 15, 12, 34, 56)
    ],
    [
      '50 year boundary exact',
      'Monday, 15-Jun-76 12:34:56 GMT',
      Date.UTC(2026, 5, 15, 12, 34, 56),
      Date.UTC(2076, 5, 15, 12, 34, 56)
    ],
    [
      '50 year boundary after by one millisecond',
      'Tuesday, 15-Jun-76 12:34:56 GMT',
      Date.UTC(2026, 5, 15, 12, 34, 55, 999),
      Date.UTC(1976, 5, 15, 12, 34, 56)
    ],
    [
      '50 year preceding month',
      'Friday, 15-May-76 12:34:56 GMT',
      Date.UTC(2026, 5, 15, 12, 34, 56),
      Date.UTC(2076, 4, 15, 12, 34, 56)
    ],
    [
      '50 year following day',
      'Wednesday, 16-Jun-76 12:34:56 GMT',
      Date.UTC(2026, 5, 15, 12, 34, 56),
      Date.UTC(1976, 5, 16, 12, 34, 56)
    ]
  ] as const) {
    test(`${family} RFC valid HTTP date ${label}`, async t => {
      const clock = createRuntime(t)
      clock.jumpWall(wall - 1000000)
      const source = fixture({ 'retry-after': raw })
      const handle = source.planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: canary, init: {} }),
        consume: response => response.text()
      })
      try {
        assert.equal((await handle.result).value, canary)
        await handle.resourcesDone
        const observation: unknown = Reflect.get(source.planner, 'observation')
        assert.ok(observation instanceof OperationObservation)
        assert.equal(
          observation.diagnostics.snapshot().INVALID_HINT,
          0,
          'RFC_VALID_HTTP_DATE_MUST_NOT_BE_INVALID_HINT'
        )
        diagnostics(source.planner, 0)
        assert.equal(
          source.planner.snapshot().serverNotBefore,
          1000000 + Math.max(0, expectedDate - wall)
        )
        assert.equal(handle.snapshot().dispatchCalls, 1)
      } finally {
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
  for (const [raw, duration, invalid] of [
    ['Thu, 01 Jan 1970 00:16:45 GMT', 5000, 0],
    ['Thursday, 01-Jan-70 00:16:45 GMT', 5000, 0],
    ['Thu Jan  1 00:16:45 1970', 5000, 0],
    ['Thu, 01 Jan 1970 00:16:39 GMT', 0, 0],
    ['1970-01-01T00:16:45Z', 0, 1],
    ['Thu, 01 Jan 1970 00:16:45 GMTjunk', 0, 1],
    ['Thu, 30 Feb 1970 00:16:45 GMT', 0, 1],
    ['Thu, 01 Jan 1970 24:16:45 GMT', 0, 1],
    ['thu, 01 jan 1970 00:16:45 gmt', 0, 1],
    ['9007199254741', 0, 1],
    ['9007199254740991', 0, 1],
    ['9007199254740990', 0, 1]
  ] as const) {
    test(`${family} standard Retry-After seconds or HTTP date ${raw}`, async t => {
      createRuntime(t)
      const source = fixture({ 'retry-after': raw })
      const handle = source.planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: canary, init: {} }),
        consume: response => response.text()
      })
      await handle.result
      await handle.resourcesDone
      // A representable duration can still overflow the absolute monotonic deadline.
      const overflow = duration > Number.MAX_SAFE_INTEGER - 1000000
      diagnostics(source.planner, overflow ? 1 : invalid)
      assert.equal(
        source.planner.snapshot().serverNotBefore,
        invalid || overflow ? 0 : 1000000 + duration
      )
    })
  }
}

test('Public late and out-of-order receipts retain maximum pause across wall rollback and stale wakes', async t => {
  const clock = createRuntime(t)
  const timers = trackTimeouts(t)
  const replies = Array.from({ length: 4 }, () => deferred<Response>())
  let sends = 0
  const planner = new FetchPlanner<typeof fetch>(() => {
    const reply = replies[sends++]
    assert.ok(reply)
    return reply.promise
  })
  const spec = {
    method: 'GET',
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: (response: Response) => response.text()
  } as const
  const handles = [planner.submit(spec), planner.submit(spec), planner.submit(spec)]
  const first = handles[0]
  const second = handles[1]
  const third = handles[2]
  assert.ok(first && second && third)
  const aborted = assert.rejects(
    first.result,
    error => error instanceof OperationError && error.code === 'ABORTED'
  )
  try {
    await clock.flush()
    assert.equal(sends, 3)
    first.abort()
    await aborted
    replies[1]?.resolve(new Response('second', { headers: { 'x-lognex-reset': '10000' } }))
    await second.result
    await second.resourcesDone
    const deadline = 1010000
    assert.equal(planner.snapshot().serverNotBefore, deadline)
    const waiting = planner.submit(spec)
    handles.push(waiting)
    await clock.flush()
    assert.equal(sends, 3, 'RECEIPT_PAUSE_BLOCKS_ACTUAL_DISPATCH')
    await clock.advance(1000)
    clock.jumpWall(-600000)
    replies[2]?.resolve(new Response('third', { headers: { 'x-lognex-retry-after': '0' } }))
    await third.result
    await third.resourcesDone
    assert.equal(planner.snapshot().serverNotBefore, deadline, 'SHORTER_SUCCESS_RETAINS_MAXIMUM')
    replies[0]?.resolve(
      new Response('late', { headers: { 'retry-after': 'Thu, 01 Jan 1970 00:06:51 GMT' } })
    )
    await first.resourcesDone
    assert.equal(planner.snapshot().serverNotBefore, 1011000, 'LATE_TERMINAL_RECEIPT_EXTENDS_PAUSE')
    const stale = timers.callbacks.at(-1)
    for (const timer of timers.active) clearTimeout(timer)
    stale?.()
    await clock.flush()
    assert.equal(sends, 3, 'STALE_WAKE_IS_NOT_A_DISPATCH_PERMIT')
    await clock.advance(9999)
    assert.equal(sends, 3)
    await clock.advance(1)
    assert.equal(sends, 4, 'DISPATCH_RESUMES_AT_MONOTONIC_MAXIMUM')
    replies[3]?.resolve(new Response('last'))
    await waiting.result
    await waiting.resourcesDone
    assert.equal(
      planner.snapshot().serverNotBefore,
      1011000,
      'MISSING_SUCCESS_NEVER_SHORTENS_PAUSE'
    )
    diagnostics(planner, 0)
    assert.ok(timers.maximum() <= 1)
  } finally {
    for (const reply of replies) reply.resolve(new Response('cleanup'))
    for (const handle of handles) handle.abort()
    await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
  }
})

test('429 hints are committed before body parsing and observer delivery', async t => {
  const clock = createRuntime(t)
  const release = deferred<undefined>()
  let bodyPause = 0
  const observed: number[] = []
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          bodyPause = planner.snapshot().serverNotBefore
          await release.promise
          controller.close()
        }
      },
      { highWaterMark: 0 }
    ),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-lognex-retry-after': '5000',
        'x-lognex-reset': canary
      }
    }
  )
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(response))
  planner.observe(event => {
    if (event.type === 'headers-received') observed.push(planner.snapshot().serverNotBefore)
  })
  let consumes = 0
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: () => {
      consumes++
      return 'bad'
    }
  })
  const failed = assert.rejects(
    handle.result,
    error => error instanceof OperationError && error.code === 'HTTP_FAILED' && error.status === 429
  )
  try {
    await clock.flush()
    assert.equal(bodyPause, 1005000)
    assert.deepEqual(observed, [1005000])
    diagnostics(planner, 1)
    await clock.advance(250)
    await failed
    assert.equal(consumes, 0)
    assert.equal(planner.snapshot().serverNotBefore, 1005000)
  } finally {
    release.resolve(undefined)
    handle.abort()
    await Promise.allSettled([failed, handle.resourcesDone])
  }
})

for (const [raw, wall, duration, invalid] of [
  ['Sun, 06 Nov 1994 08:49:37 GMT\n', Date.UTC(1994, 10, 6), 0, 1],
  ['Mon, 06 Nov 1994 08:49:37 GMT', Date.UTC(1994, 10, 6), 0, 1],
  [
    'Saturday, 01-Jan-00 00:00:00 GMT',
    Date.UTC(1994, 10, 6),
    Date.UTC(2000, 0, 1) - Date.UTC(1994, 10, 6),
    0
  ],
  ['Sunday, 06-Nov-94 08:49:37 GMT', Date.UTC(2026, 0, 1), 0, 0]
] as const) {
  test(`Direct HTTP date grammar and obsolete year window ${JSON.stringify(raw)}`, () => {
    const result = parseResponsePolicy(
      200,
      { get: name => (name === 'retry-after' ? raw : null) },
      { monotonic: 1000, wall }
    )
    assert.equal(result.invalidHints, invalid)
    assert.equal(result.serverNotBefore, invalid ? 0 : 1000 + duration)
  })
}

for (const interval of ['invalid', '10000']) {
  test(`Valid budget siblings affect actual dispatch with interval ${interval}`, async t => {
    const clock = createRuntime(t)
    let sends = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        sends++
        return Promise.resolve(
          new Response('ok', {
            headers: {
              'x-ratelimit-limit': '1',
              'x-ratelimit-remaining': '0',
              'x-lognex-retry-timeinterval': interval
            }
          })
        )
      },
      { jitter: 0 }
    )
    const spec = {
      method: 'GET',
      replay,
      prepare: () => ({ url: canary, init: {} }),
      consume: (response: Response) => response.text()
    } as const
    const first = planner.submit(spec)
    await first.result
    await first.resourcesDone
    diagnostics(planner, interval === 'invalid' ? 1 : 0)
    const second = planner.submit(spec)
    try {
      await clock.flush()
      assert.equal(sends, 1, 'VALID_BUDGET_SIBLINGS_REACH_COORDINATOR')
      await clock.advance(2999)
      assert.equal(sends, 1)
      await clock.advance(1)
      assert.equal(sends, 2)
      await second.result
      await second.resourcesDone
      diagnostics(planner, interval === 'invalid' ? 2 : 0)
    } finally {
      second.abort()
      await Promise.allSettled([second.result, second.resourcesDone])
    }
  })
}

test('Public receipt samples clocks before header access and reads scalar status once', async t => {
  const clock = createRuntime(t)
  const response = new Response('ok', {
    headers: {
      'retry-after': 'Thu, 01 Jan 1970 00:16:45 GMT',
      'x-lognex-retry-after': '5000'
    }
  })
  const headers = response.headers
  const get = headers.get.bind(headers)
  const names: string[] = []
  t.mock.method(headers, 'get', (name: string) => {
    names.push(name)
    if (names.length === 1) {
      clock.tick(1000)
      clock.jumpWall(-60000)
    }
    return get(name)
  })
  let statuses = 0
  Object.defineProperty(response, 'status', {
    get() {
      statuses++
      return 200
    }
  })
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(response))
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: body => body.text()
  })
  await handle.result
  await handle.resourcesDone
  assert.equal(statuses, 1)
  assert.deepEqual(
    names,
    fields.map(([name]) => name)
  )
  assert.equal(planner.snapshot().serverNotBefore, 1005000, 'ONE_RECEIPT_CLOCK_PAIR_FOR_ALL_HINTS')
  diagnostics(planner, 0)
})

test('Public arithmetic overflow rejects each unsafe deadline while retaining a valid sibling', async t => {
  createRuntime(t)
  const planner = new FetchPlanner<typeof fetch>(() =>
    Promise.resolve(
      new Response('ok', {
        headers: {
          'x-lognex-retry-after': '9007199254740991',
          'retry-after': '9007199254740991',
          'x-lognex-reset': '5000'
        }
      })
    )
  )
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: body => body.text()
  })
  await handle.result
  await handle.resourcesDone
  diagnostics(planner, 2)
  assert.equal(planner.snapshot().serverNotBefore, 1005000)
})

test('HTTP dates before the permitted calendar year are invalid', () => {
  const result = parseResponsePolicy(
    200,
    { get: name => (name === 'retry-after' ? 'Wed, 01 Jan 1800 00:00:00 GMT' : null) },
    { monotonic: 1000, wall: 1000000 }
  )
  assert.equal(result.invalidHints, 1)
  assert.equal(result.serverNotBefore, 0)
})

for (const [raw, wall, expectedDate] of [
  ['Sat, 31 Dec 2016 23:59:59 GMT', Date.UTC(2016, 11, 31), Date.UTC(2016, 11, 31, 23, 59, 59)],
  ['Sun, 01 Jan 2017 00:00:00 GMT', Date.UTC(2016, 11, 31), Date.UTC(2017, 0, 1)],
  ['Sun, 31 Dec 2016 23:59:60 GMT', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 Dec 2016 23:59:61 GMT', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 Dec 2016 23:58:60 GMT', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 Dec 2016 22:59:60 GMT', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 Dec 2016 24:00:00 GMT', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 Dec 2016 23:60:00 GMT', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 Dec 2016 23:59:60 UTC', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 dec 2016 23:59:60 GMT', Date.UTC(2016, 11, 31), null],
  ['Sat, 31 Feb 2016 23:59:60 GMT', Date.UTC(2016, 11, 31), null],
  ['Monday, 15-Jun-76 12:34:56 GMT', Date.UTC(2026, 5, 15, 12, 34, 55, 999), null],
  ['Tuesday, 15-Jun-76 12:34:56 GMT', Date.UTC(2026, 5, 15, 12, 34, 56), null],
  ['Tuesday, 29-Feb-00 00:00:00 GMT', Date.UTC(2050, 0, 1), Date.UTC(2000, 1, 29)],
  ['Monday, 29-Feb-00 00:00:00 GMT', Date.UTC(2050, 2, 1), null]
] as const) {
  test(`HTTP date calendar and century neighbors ${raw} at ${wall}`, () => {
    const result = parseResponsePolicy(
      200,
      {
        get: name => (name === 'retry-after' ? raw : name === 'x-lognex-reset' ? '5000' : null)
      },
      { monotonic: 1000000, wall }
    )
    assert.equal(result.invalidHints, expectedDate === null ? 1 : 0)
    assert.equal(
      result.serverNotBefore,
      1000000 + Math.max(5000, expectedDate === null ? 0 : expectedDate - wall)
    )
  })
}

test('RFC850 past receipt retains a previously accepted public maximum', async t => {
  const clock = createRuntime(t)
  clock.jumpWall(Date.UTC(2026, 0, 1) - 1000000)
  const replies = [deferred<Response>(), deferred<Response>()]
  let sends = 0
  const planner = new FetchPlanner<typeof fetch>(() => {
    const reply = replies[sends++]
    assert.ok(reply)
    return reply.promise
  })
  const spec = {
    method: 'GET' as const,
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: (body: Response) => body.text()
  }
  const first = planner.submit(spec)
  const second = planner.submit(spec)
  try {
    await clock.advance(1000)
    assert.equal(sends, 2)
    replies[1]?.resolve(new Response('ok', { headers: { 'x-lognex-reset': '5000' } }))
    await second.result
    await second.resourcesDone
    const prior = planner.snapshot().serverNotBefore
    replies[0]?.resolve(
      new Response('ok', {
        headers: {
          'retry-after': 'Friday, 31-Dec-76 23:59:59 GMT',
          'x-lognex-retry-after': '12junk'
        }
      })
    )
    await first.result
    await first.resourcesDone
    diagnostics(planner, 1)
    assert.equal(prior, 1006000)
    assert.equal(planner.snapshot().serverNotBefore, prior)
  } finally {
    for (const reply of replies) reply.resolve(new Response('cleanup'))
    first.abort()
    second.abort()
    await Promise.allSettled([
      first.result,
      first.resourcesDone,
      second.result,
      second.resourcesDone
    ])
  }
})

for (const max of [1, 2, 4]) {
  for (const legacy of [false, true]) {
    test(`Parallel receipts clamp effective capacity and retain sent work at max ${max} legacy ${legacy}`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const replies = Array.from({ length: max + 2 }, () => deferred<Response>())
      const signals: AbortSignal[] = []
      let sends = 0
      const planner = new DeepPlanner<typeof fetch>(
        (_url, init) => {
          assert.ok(init?.signal)
          signals.push(init.signal)
          const reply = replies[sends++]
          assert.ok(reply)
          return reply.promise
        },
        { maxParallelLimit: max, jitter: 0 }
      )
      const spec = {
        method: 'GET' as const,
        replay,
        prepare: () => ({ url: canary, init: {} }),
        consume: (body: Response) => body.text()
      }
      const handles = Array.from({ length: max + 2 }, () => planner.submit(spec))
      const results = handles.map(handle =>
        handle.result.catch((error: unknown) => {
          assert.ok(error instanceof OperationError && error.code === 'HTTP_FAILED')
        })
      )
      try {
        await clock.flush()
        assert.equal(sends, max)
        assert.equal(planner.snapshot().queued, 2)
        for (let i = 0; i < max; i++) {
          const headers = legacy
            ? { 'x-lognex-auth': '429005' }
            : { 'content-type': 'application/json' }
          replies[i]?.resolve(
            new Response(legacy ? 'overflow' : '{"errors":[{"code":1073}]}', {
              status: 429,
              headers
            })
          )
          await handles[i]?.resourcesDone
          await clock.flush()
          assert.equal(
            planner.snapshot().effectiveParallelism,
            Math.max(1, max - i - 1),
            'RECEIPT_EFFECTIVE_CLAMP'
          )
          assert.equal(
            sends,
            i === max - 1 ? max + 1 : max,
            'ACTUAL_DISPATCH_USES_REDUCED_EFFECTIVE'
          )
          assert.ok(
            signals.every(signal => !signal.aborted),
            'SENT_WORK_IS_NOT_CANCELLED_BY_CORRECTION'
          )
        }
        assert.equal(planner.snapshot().effectiveParallelism, 1)
        assert.equal(planner.snapshot().sentActive, 1)
        replies[max]?.resolve(new Response('next'))
        await handles[max]?.resourcesDone
        await clock.flush()
        assert.equal(sends, max + 2)
        replies[max + 1]?.resolve(new Response('last'))
        await Promise.all(results)
        await Promise.all(handles.map(handle => handle.resourcesDone))
        diagnostics(planner, 0)
        assert.equal(timers.active.size, 0)
        assert.ok(timers.maximum() <= 1)
      } finally {
        for (const reply of replies) reply.resolve(new Response('cleanup'))
        for (const handle of handles) handle.abort()
        await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
      }
    })
  }
}

for (const max of [1, 2, 4]) {
  for (const random of [0, 0.5, 1]) {
    test(`Recovery dispatches active ready work one step after strict period max ${max} random ${random}`, async t => {
      const clock = createRuntime(t)
      clock.setRandom(random)
      const timers = trackTimeouts(t)
      let seed = true
      let sends = 0
      const release = deferred<undefined>()
      const planner = new FetchPlanner<typeof undiciFetch>(
        () => {
          sends++
          return Promise.resolve(
            seed
              ? new UndiciResponse('{"errors":[{"code":1073}]}', {
                  status: 429,
                  headers: { 'content-type': 'application/json' }
                })
              : new UndiciResponse('ok')
          )
        },
        { maxParallelLimit: max, parallelLimitCorrectionPeriodMs: 1000, jitter: 0.3 }
      )
      const spec = {
        method: 'GET' as const,
        replay,
        prepare: () => ({ url: canary, init: {} }),
        consume: async (body: UndiciResponse) => {
          await release.promise
          return body.text()
        }
      }
      for (let i = 0; i < max + 1; i++) {
        const handle = planner.submit(spec)
        await assert.rejects(
          handle.result,
          error => error instanceof OperationError && error.code === 'HTTP_FAILED'
        )
        await handle.resourcesDone
      }
      assert.equal(planner.snapshot().effectiveParallelism, 1, 'REPEATED_RECEIPTS_SATURATE')
      seed = false
      const base = sends
      const handles = Array.from({ length: max }, () => planner.submit(spec))
      try {
        await clock.flush()
        assert.equal(sends, base + 1)
        const origin = performance.now()
        for (const jump of [10000000, -20000000]) {
          clock.jumpWall(jump)
          await clock.flush()
          assert.equal(performance.now(), origin)
          assert.equal(planner.snapshot().effectiveParallelism, 1)
        }
        const period = 1000 * (1 + 2 * random * 0.3)
        for (let effective = 1; effective < max; effective++) {
          await clock.advance(period)
          assert.equal(
            planner.snapshot().effectiveParallelism,
            effective,
            'STRICT_RECOVERY_BOUNDARY'
          )
          assert.equal(sends, base + effective)
          await clock.advance(1)
          assert.equal(
            planner.snapshot().effectiveParallelism,
            effective + 1,
            'RECOVERY_WITHOUT_NEW_RECEIPTS'
          )
          assert.equal(sends, base + effective + 1, 'RECOVERY_ACTUALLY_DISPATCHES_READY_WORK')
        }
        await clock.advance(period + 1)
        assert.equal(
          planner.snapshot().effectiveParallelism,
          max,
          'RECOVERY_NEVER_EXCEEDS_CONFIGURED_MAX'
        )
        assert.equal(sends, base + max)
        release.resolve(undefined)
        await Promise.all(handles.map(handle => handle.result))
        await Promise.all(handles.map(handle => handle.resourcesDone))
        diagnostics(planner, 0)
        assert.equal(timers.active.size, 0, 'NO_IDLE_RECOVERY_INTERVAL')
        assert.ok(timers.maximum() <= 1)
      } finally {
        release.resolve(undefined)
        for (const handle of handles) handle.abort()
        await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
      }
    })
  }
}

for (const remaining of [0, 100]) {
  test(`Changed HTTP budget invalidates a cached numeric wait with remaining ${remaining}`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const replies = Array.from({ length: 4 }, () => deferred<Response>())
    const calls: number[] = []
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        const reply = replies[calls.length]
        calls.push(performance.now())
        assert.ok(reply)
        return reply.promise
      },
      { maxParallelLimit: 3, jitter: 0, throttlingCoefficient: 1, maxRequestDelayTimeMs: 1000 }
    )
    const spec = {
      method: 'GET' as const,
      replay,
      prepare: () => ({ url: canary, init: {} }),
      consume: (body: Response) => body.text()
    }
    const handles = Array.from({ length: 4 }, () => planner.submit(spec))
    try {
      await clock.flush()
      assert.equal(calls.length, 3)
      replies[0]?.resolve(
        new Response('first', {
          headers: {
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '50',
            'x-lognex-retry-timeinterval': '10000'
          }
        })
      )
      await handles[0]?.resourcesDone
      await clock.flush()
      assert.equal(handles[3]?.snapshot().phase, 'ready')
      assert.equal(calls.length, 3)
      await clock.advance(100)
      replies[1]?.resolve(
        new Response('changed', {
          headers: {
            'x-ratelimit-limit': '200',
            'x-ratelimit-remaining': String(remaining),
            'x-lognex-retry-timeinterval': '2000'
          }
        })
      )
      await handles[1]?.resourcesDone
      await clock.flush()
      // elapsed100/2000=.05; remaining/200 is 0 or .5. Formula003 => 950 or450.
      const delay = remaining === 0 ? 950 : 450
      await clock.advance(399)
      assert.equal(calls.length, 3, 'OLD_CACHED_WAIT_IS_NOT_A_PERMIT')
      await clock.advance(delay - 400)
      assert.equal(calls.length, 3)
      await clock.advance(1)
      assert.equal(calls.length, 4, 'HTTP_NUMBERS_CHANGE_ACTUAL_NEXT_DISPATCH')
      assert.equal(calls[3], 1000100 + delay)
      replies[2]?.resolve(new Response('late'))
      replies[3]?.resolve(new Response('last'))
      await Promise.all(handles.map(handle => handle.result))
      await Promise.all(handles.map(handle => handle.resourcesDone))
      diagnostics(planner, 0)
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
    } finally {
      for (const reply of replies) reply.resolve(new Response('cleanup'))
      for (const handle of handles) handle.abort()
      await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
    }
  })
}

test('Default recovery preserves the receipt maximum across late success and undelivered timers', async t => {
  const clock = createRuntime(t)
  clock.setRandom(0)
  const timers = trackTimeouts(t)
  let mono = performance.now()
  t.mock.method(performance, 'now', () => mono)
  const replies = Array.from({ length: 5 }, () => deferred<Response>())
  let sends = 0
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      const reply = replies[sends++]
      assert.ok(reply)
      return reply.promise
    },
    { maxParallelLimit: 3, jitter: 0, attemptTimeoutMs: 90000 }
  )
  const prepare = deferred<undefined>()
  const spec = {
    method: 'GET' as const,
    replay,
    prepare: async () => {
      await prepare.promise
      return { url: canary, init: {} }
    },
    consume: (body: Response) => body.text()
  }
  prepare.resolve(undefined)
  const handles = Array.from({ length: 4 }, () => planner.submit(spec))
  const first = handles[0]
  assert.ok(first)
  const failed = assert.rejects(
    first.result,
    error => error instanceof OperationError && error.code === 'HTTP_FAILED'
  )
  try {
    await clock.flush()
    assert.equal(sends, 3)
    replies[0]?.resolve(
      new Response('{"errors":[{"code":1073}]}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-lognex-reset': '50000' }
      })
    )
    await failed
    await handles[0]?.resourcesDone
    await clock.flush()
    assert.equal(handles[3]?.snapshot().phase, 'ready')
    assert.equal(planner.snapshot().effectiveParallelism, 2)
    assert.equal(planner.snapshot().serverNotBefore, 1050000)
    mono -= 1000
    clock.jumpWall(100000000)
    replies[1]?.resolve(new Response('late', { headers: { 'x-lognex-reset': '1' } }))
    await handles[1]?.resourcesDone
    await clock.flush()
    assert.equal(planner.snapshot().effectiveParallelism, 2, 'BACKWARD_CLOCK_DOES_NOT_RECOVER')
    mono = 1010000
    const next = planner.submit(spec)
    handles.push(next)
    await clock.flush()
    assert.equal(planner.snapshot().effectiveParallelism, 2, 'DEFAULT_STRICT_10000')
    mono++
    replies[2]?.resolve(new Response('later'))
    await handles[2]?.resourcesDone
    await clock.flush()
    assert.equal(planner.snapshot().effectiveParallelism, 3, 'WORK_RECOVERS_WITHOUT_TIMER_DELIVERY')
    assert.equal(planner.snapshot().serverNotBefore, 1050000)
    assert.equal(sends, 3, 'RECOVERY_AND_SUCCESS_DO_NOT_SHORTEN_SERVER_PAUSE')
    mono = 1049999
    timers.callbacks[0]?.()
    await clock.flush()
    assert.equal(sends, 3, 'STALE_CALLBACK_ONLY_WAKES_CURRENT_GATE')
    mono++
    timers.callbacks[0]?.()
    await clock.flush()
    assert.equal(sends, 5, 'STALE_WAKE_RECHECKS_CURRENT_POLICY_AT_DEADLINE')
    replies[3]?.resolve(new Response('fourth'))
    replies[4]?.resolve(new Response('fifth'))
    await Promise.all(handles.slice(1).map(handle => handle.result))
    await Promise.all(handles.map(handle => handle.resourcesDone))
    diagnostics(planner, 0)
    assert.equal(timers.active.size, 0)
    assert.ok(timers.maximum() <= 1)
  } finally {
    for (const reply of replies) reply.resolve(new Response('cleanup'))
    for (const handle of handles) handle.abort()
    await Promise.allSettled([
      failed,
      ...handles.flatMap(handle => [handle.result, handle.resourcesDone])
    ])
  }
})

test('Receipt pause during prepare gates concurrent readiness after recovery', async t => {
  const clock = createRuntime(t)
  const timers = trackTimeouts(t)
  const prepared = deferred<undefined>()
  let sends = 0
  const planner = new DeepPlanner<typeof fetch>(
    () => {
      sends++
      return Promise.resolve(
        sends === 1
          ? new Response('{"errors":[{"code":1073}]}', {
              status: 429,
              headers: { 'content-type': 'application/json', 'x-lognex-retry-after': '5000' }
            })
          : new Response('ok')
      )
    },
    { maxParallelLimit: 3, jitter: 0, parallelLimitCorrectionPeriodMs: 1000 }
  )
  const spec = {
    method: 'GET' as const,
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: (body: Response) => body.text()
  }
  const first = planner.submit(spec)
  const failed = assert.rejects(
    first.result,
    error => error instanceof OperationError && error.code === 'HTTP_FAILED'
  )
  const handles = Array.from({ length: 2 }, () =>
    planner.submit({
      ...spec,
      prepare: async () => {
        await prepared.promise
        return { url: canary, init: {} }
      }
    })
  )
  try {
    await failed
    await first.resourcesDone
    assert.equal(planner.snapshot().effectiveParallelism, 2)
    await clock.advance(1001)
    assert.equal(planner.snapshot().effectiveParallelism, 3)
    await clock.advance(3998)
    prepared.resolve(undefined)
    await clock.flush()
    assert.ok(handles.every(handle => handle.snapshot().phase === 'ready'))
    assert.equal(sends, 1, 'CONCURRENT_READY_RECHECKS_RECEIPT_PAUSE')
    await clock.advance(1)
    assert.equal(sends, 3)
    await Promise.all(handles.map(handle => handle.result))
    await Promise.all(handles.map(handle => handle.resourcesDone))
    diagnostics(planner, 0)
    assert.equal(timers.active.size, 0)
    assert.ok(timers.maximum() <= 1)
  } finally {
    prepared.resolve(undefined)
    first.abort()
    for (const handle of handles) handle.abort()
    await Promise.allSettled([
      failed,
      first.resourcesDone,
      ...handles.flatMap(handle => [handle.result, handle.resourcesDone])
    ])
  }
})

test('Finite corrected idle planner exits naturally without a recovery interval', () => {
  const module = new URL('../../src/index.js', import.meta.url)
  const script = `
    import assert from 'node:assert/strict'
    import { FetchPlanner, OperationError } from ${JSON.stringify(module.href)}
    const planner = new FetchPlanner(() => Promise.resolve(new Response('{"errors":[{"code":1073}]}', {
      status:429, headers:{'content-type':'application/json'}
    })), { maxParallelLimit:2 })
    const handle = planner.submit({method:'GET',replay:{serverSafe:false,consumeSafe:false},
      prepare:()=>({url:'https://example.invalid',init:{}}),consume:()=>{throw new Error('UNEXPECTED_CONSUME')}})
    await assert.rejects(handle.result,error=>error instanceof OperationError && error.code==='HTTP_FAILED')
    await handle.resourcesDone
    assert.equal(planner.snapshot().effectiveParallelism,1)
    assert.equal(planner.snapshot().leasedAttempts,0)
    console.log('FINITE_CORRECTED_IDLE')
  `
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 5000 }
  )
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.equal(child.signal, null)
  assert.equal(child.stdout.trim(), 'FINITE_CORRECTED_IDLE')
  assert.equal(child.stderr, '')
})

test('Unsafe recovery arithmetic fails explicitly and retains known sent work until cleanup', async t => {
  const clock = createRuntime(t)
  clock.setRandom(1)
  const timers = trackTimeouts(t)
  const release = deferred<undefined>()
  const planner = new FetchPlanner<typeof fetch>(
    () =>
      Promise.resolve(new Response(null, { status: 429, headers: { 'x-lognex-auth': '429005' } })),
    { maxParallelLimit: 2, jitter: 0.3, parallelLimitCorrectionPeriodMs: Number.MAX_SAFE_INTEGER }
  )
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: context => {
      context.onDispose(() => release.promise)
      return { url: canary, init: {} }
    },
    consume: () => assert.fail('NO_CONSUME')
  })
  try {
    await assert.rejects(
      handle.result,
      error => error instanceof OperationError && error.code === 'INVALID_ARGUMENT'
    )
    assert.equal(planner.snapshot().leasedAttempts, 1)
    assert.equal(planner.snapshot().sentActive, 1)
    release.resolve(undefined)
    await handle.resourcesDone
    await clock.flush()
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(timers.active.size, 0)
    assert.ok(timers.maximum() <= 1)
    diagnostics(planner, 0)
  } finally {
    release.resolve(undefined)
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

for (const entry of ['root', 'deep']) {
  for (const family of ['native', 'undici']) {
    test(`${family} ${entry} combined legacy and EOF1073 count as one receipt correction`, async t => {
      createRuntime(t)
      const headers = { 'content-type': 'application/json', 'x-lognex-auth': '429005' }
      const body = '{"errors":[{"code":1073}]}'
      const Constructor = entry === 'root' ? FetchPlanner : DeepPlanner
      const planner =
        family === 'native'
          ? new Constructor<typeof fetch>(
              () => Promise.resolve(new Response(body, { status: 429, headers })),
              { maxParallelLimit: 4 }
            )
          : new Constructor<typeof undiciFetch>(
              () => Promise.resolve(new UndiciResponse(body, { status: 429, headers })),
              { maxParallelLimit: 4 }
            )
      let consumes = 0
      const handle = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: canary, init: {} }),
        consume: () => {
          consumes++
          return 'bad'
        }
      })
      await assert.rejects(
        handle.result,
        error =>
          error instanceof OperationError && error.code === 'HTTP_FAILED' && error.status === 429
      )
      await handle.resourcesDone
      assert.equal(planner.snapshot().effectiveParallelism, 3, 'ONE_DECREMENT_PER_RECEIPT')
      assert.equal(handle.snapshot().dispatchCalls, 1)
      assert.equal(consumes, 0)
      diagnostics(planner, 0)
    })
  }
}
