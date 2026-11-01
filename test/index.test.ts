import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FetchPlanner, OperationError, type Event, type FetchPlannerOptions } from '../src/index.js'
import { OperationObservation } from '../src/operation-observation.js'
import { createRuntime } from './helpers/runtime.js'
import { deferred } from './operation/helpers.js'

const url = 'http://offline.test/foo'
const replay = { serverSafe: false, consumeSafe: false }
const safeReplay = { serverSafe: true, consumeSafe: true }
const rate = (remaining: number, data = '') =>
  new Response(JSON.stringify({ ok: true, data }), {
    headers: {
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': String(remaining),
      'X-Lognex-Retry-TimeInterval': '1000'
    }
  })

for (const [name, options] of [
  ['simple operation', {}],
  ['operation with options', { maxParallelLimit: 2 }],
  ['simple GET', {}]
] as const) {
  test(`Submit ${name} consumes JSON and separates resource completion`, async () => {
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>((input, init) => {
      calls++
      assert.equal(input, url)
      assert.equal(init?.method, 'GET')
      assert.ok(init.signal instanceof AbortSignal)
      return Promise.resolve(new Response('{"ok":true}'))
    }, options)
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: async response => {
        const value: unknown = await response.json()
        assert.deepEqual(value, { ok: true }, 'SIMPLE_JSON_VALUE')
        return value
      }
    })
    assert.equal('then' in handle, false)
    assert.equal((await handle.result).status, 200)
    assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
    assert.equal(calls, 1)
  })
}

test('Observation tracks rate-limit and JSON1073 attempts without private payloads', async t => {
  const clock = createRuntime(t)
  const records: Event[] = []
  let calls = 0
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      calls++
      if (calls === 1)
        return Promise.resolve(
          new Response('{}', {
            status: 429,
            headers: {
              'X-RateLimit-Limit': '45',
              'X-RateLimit-Remaining': '0',
              'X-Lognex-Retry-TimeInterval': '1000',
              'X-Lognex-Retry-After': '10',
              'Content-Type': 'application/json'
            }
          })
        )
      if (calls === 2)
        return Promise.resolve(
          new Response('{"errors":[{"code":1073}]}', {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      return Promise.resolve(new Response('{"ok":true}'))
    },
    { jitter: 0, parallelLimitCorrectionPeriodMs: 10000 }
  )
  planner.observe(event => {
    records.push(event)
  })
  const handle = planner.submit({
    method: 'GET',
    replay: safeReplay,
    prepare: () => ({ url, init: {} }),
    consume: response => response.text()
  })
  const perOperation: Event[] = []
  handle.observe(event => {
    perOperation.push(event)
  })
  try {
    await clock.advance(0)
    assert.equal(calls, 1)
    assert.equal(planner.snapshot().serverNotBefore, 1000010)
    await clock.advance(3000)
    assert.equal(calls, 2)
    assert.equal(planner.snapshot().effectiveParallelism, 3)
    await clock.advance(6000)
    assert.equal((await handle.result).value, '{"ok":true}')
    await handle.resourcesDone
    const sends = records.filter(event => event.type === 'dispatch-started')
    const headers = records.filter(event => event.type === 'headers-received')
    assert.deepEqual(
      sends.map(event => event.attempts),
      [1, 2, 3]
    )
    assert.deepEqual(
      sends.map(event => event.dispatchCalls),
      [1, 2, 3]
    )
    assert.deepEqual(
      headers.map(event => event.status),
      [429, 429, 200]
    )
    assert.deepEqual(
      records.filter(event => event.type === 'retry-scheduled').map(event => event.attempts),
      [1, 2]
    )
    for (const event of records) {
      assert.equal(event.id, handle.id)
      assert.equal(typeof event.epochTime, 'number')
      assert.equal(typeof event.elapsedMs, 'number')
      assert.ok(event.elapsedMs >= 0)
      assert.ok(Object.isFrozen(event))
      for (const field of ['url', 'method', 'error', 'response', 'value', 'body', 'entityKey'])
        assert.equal(field in event, false, 'PRIVATE_PAYLOAD_ABSENT')
    }
    for (const sent of sends) {
      const received = headers.find(event => event.dispatchCalls === sent.dispatchCalls)
      assert.ok(received)
      assert.ok(sent.epochTime <= received.epochTime)
      assert.ok(sent.sequence < received.sequence)
    }
    assert.deepEqual(
      perOperation.map(event => event.sequence),
      records.filter(event => event.type !== 'created').map(event => event.sequence)
    )
  } finally {
    planner.stop()
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

for (const returned of ['deny', 'false', 'promise', 'throw', 'reject'] as const) {
  test(`POST observation ${returned} is isolated from transport and consumer value`, async () => {
    let calls = 0
    let first = true
    let settled = 0
    const events: Event[] = []
    const planner = new FetchPlanner<typeof fetch>((_input, init) => {
      calls++
      assert.equal(init?.method, 'POST')
      assert.ok(init.signal instanceof AbortSignal)
      return Promise.resolve(rate(5))
    })
    const observer = (): unknown => {
      if (!first) return
      first = false
      if (returned === 'throw') throw new Error('private observer error')
      if (returned === 'reject') return Promise.reject(new Error('private observer rejection'))
      if (returned === 'promise') return Promise.resolve({ action: 'deny' })
      if (returned === 'false') return false
      return { action: 'deny' }
    }
    planner.observe(observer)
    planner.observe(event => {
      events.push(event)
      if (event.type === 'operation-settled') settled++
    })
    const value = { ok: true }
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => value
    })
    assert.equal((await handle.result).value, value, 'OBSERVER_CANNOT_CONTROL_TRANSPORT')
    await handle.resourcesDone
    assert.equal(calls, 1)
    assert.equal(settled, 1)
    const observation: unknown = Reflect.get(planner, 'observation')
    assert.ok(observation instanceof OperationObservation)
    assert.deepEqual(
      observation.diagnostics.snapshot(),
      {
        OBSERVER_FAILED: returned === 'throw' || returned === 'reject' ? 1 : 0,
        INVALID_HINT: 0,
        LATE_COMPLETION: 0,
        rejections: {}
      },
      'OBSERVER_DIAGNOSTICS_ONLY'
    )
    assert.equal(events.find(event => event.type === 'headers-received')?.status, 200)
    assert.equal(planner.snapshot().sentActive, 0)
  })
}

test('Simple POST preserves explicit headers and JSON payload', async () => {
  const planner = new FetchPlanner<typeof fetch>((input, init) => {
    assert.equal(input, url)
    assert.equal(init?.method, 'POST')
    assert.deepEqual(init.headers, { 'Foo-Header': '42' })
    assert.equal(init.body, '{"some":123}')
    return Promise.resolve(new Response('{"ok":true}'))
  })
  const h = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({
      url,
      init: { headers: { 'Foo-Header': '42' }, body: JSON.stringify({ some: 123 }) }
    }),
    consume: response => response.text()
  })
  assert.equal((await h.result).value, '{"ok":true}')
  await h.resourcesDone
})

test('Elapsed time reduces calculated delay for five sequential operations', async t => {
  const clock = createRuntime(t)
  const times: number[] = []
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      times.push(performance.now())
      return Promise.resolve(rate(5))
    },
    {
      maxParallelLimit: 1,
      throttlingCoefficient: 1,
      maxRequestDelayTimeMs: 1000,
      jitter: 0
    }
  )
  for (let i = 0; i < 5; i++) {
    const h = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: response => response.text()
    })
    await clock.advance(0)
    assert.equal(times.length, i + 1, 'NO_DELAY_AFTER_ELAPSED_HALF_WINDOW')
    await h.result
    await h.resourcesDone
    await clock.advance(500)
  }
  assert.deepEqual(times, [1000000, 1000500, 1001000, 1001500, 1002000])
})

test('Rate-limit receipt retains sent capacity until consume actually returns', async t => {
  const clock = createRuntime(t)
  const gate = deferred<undefined>()
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(rate(8, 'data')))
  const h = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url, init: {} }),
    consume: async response => {
      assert.equal(response.status, 200)
      await gate.promise
      return response.text()
    }
  })
  try {
    await clock.advance(0)
    assert.equal(planner.snapshot().sentActive, 1)
    assert.equal(h.snapshot().status, 200)
    assert.equal(h.snapshot().phase, 'consuming')
    gate.resolve(undefined)
    await clock.advance(0)
    assert.equal((await h.result).value, '{"ok":true,"data":"data"}')
    await h.resourcesDone
    assert.equal(planner.snapshot().sentActive, 0)
    // At remaining8/limit10 the default coefficient5 makes round(3000*.2^5)=1ms.
    let sent = false
    const nextPlannerObservation = planner.observe(event => {
      if (event.type === 'dispatch-started') sent = true
    })
    const next = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'next'
    })
    await clock.advance(0)
    assert.equal(sent, false)
    await clock.advance(1)
    assert.equal(sent, true)
    await next.result
    await next.resourcesDone
    nextPlannerObservation.unsubscribe()
  } finally {
    gate.resolve(undefined)
    h.abort()
    await Promise.allSettled([h.result, h.resourcesDone])
  }
})

test('Public queue replaces priority slot notifications with FIFO submissions', async t => {
  const clock = createRuntime(t)
  const priorities = [10, 81, 70, 11, 60, 80, 52, 30, 51]
  const starts: string[] = []
  const planner = new FetchPlanner<typeof fetch>(
    input => {
      assert.equal(typeof input, 'string')
      assert.ok(typeof input === 'string')
      starts.push(input)
      return Promise.resolve(new Response(null))
    },
    { maxParallelLimit: 3, jitter: 0 }
  )
  const handles = priorities.map((priority, index) =>
    planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: `${url}/${index + 1}`, init: {} }),
      consume: () => `${index + 1} / ${priority}`
    })
  )
  assert.equal(planner.snapshot().queued, 9)
  await clock.advance(0)
  assert.deepEqual(
    (await Promise.all(handles.map(h => h.result))).map(result => result.value),
    ['1 / 10', '2 / 81', '3 / 70', '4 / 11', '5 / 60', '6 / 80', '7 / 52', '8 / 30', '9 / 51']
  )
  assert.deepEqual(
    starts,
    priorities.map((_priority, index) => `${url}/${index + 1}`)
  )
  await Promise.all(handles.map(h => h.resourcesDone))
  assert.equal(planner.snapshot().queued, 0)
})

test('Parallel capacity and adaptive throttling retain independent operation values', async t => {
  const clock = createRuntime(t)
  const gates = [deferred<undefined>(), deferred<undefined>()]
  const times: number[] = []
  let calls = 0
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      times.push(performance.now())
      return Promise.resolve(rate(4 - calls, `r${++calls}`))
    },
    { maxParallelLimit: 2, maxRequestDelayTimeMs: 1000, jitter: 0, throttlingCoefficient: 1 }
  )
  const handles = [0, 1, 2].map(index =>
    planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: async response => {
        if (index < 2) await gates[index]?.promise
        return response.text()
      }
    })
  )
  try {
    assert.equal(planner.snapshot().queued, 3)
    assert.equal(planner.snapshot().sentActive, 0)
    await clock.advance(0)
    assert.equal(planner.snapshot().queued, 1)
    assert.equal(planner.snapshot().sentActive, 2)
    assert.equal(calls, 2)
    for (const gate of gates) gate.resolve(undefined)
    await clock.advance(0)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().queued, 0)
    // Third operation can prepare, but cannot dispatch before round((1-.3)*1000)=700.
    assert.equal(calls, 2)
    await clock.advance(699)
    assert.equal(calls, 2)
    await clock.advance(1)
    assert.equal(calls, 3)
    assert.deepEqual(times, [1000000, 1000000, 1000700])
    assert.deepEqual(
      (await Promise.all(handles.map(h => h.result))).map(result => result.value),
      ['{"ok":true,"data":"r1"}', '{"ok":true,"data":"r2"}', '{"ok":true,"data":"r3"}']
    )
    await Promise.all(handles.map(h => h.resourcesDone))
    assert.equal(planner.snapshot().sentActive, 0)
  } finally {
    for (const gate of gates) gate.resolve(undefined)
    planner.stop()
    for (const h of handles) h.abort()
    await Promise.allSettled(handles.flatMap(h => [h.result, h.resourcesDone]))
  }
})

test('429 rate overflow obeys server pause, fallback and replay gates', async t => {
  const clock = createRuntime(t)
  for (const flags of [
    replay,
    { serverSafe: true, consumeSafe: false },
    { serverSafe: false, consumeSafe: true },
    safeReplay
  ]) {
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(
      () =>
        Promise.resolve(
          ++calls === 1
            ? new Response('{}', {
                status: 429,
                headers: {
                  'Content-Type': 'application/json',
                  'X-RateLimit-Limit': '10',
                  'X-RateLimit-Remaining': '0',
                  'X-Lognex-Retry-TimeInterval': '1000',
                  'X-Lognex-Retry-After': '100'
                }
              })
            : rate(1, 'r1')
        ),
      { maxParallelLimit: 2, maxRequestDelayTimeMs: 1000, jitter: 0, throttlingCoefficient: 1 }
    )
    const h = planner.submit({
      method: 'GET',
      replay: flags,
      prepare: () => ({ url, init: {} }),
      consume: response => response.text()
    })
    await clock.advance(0)
    assert.equal(calls, 1)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().effectiveParallelism, 2)
    if (flags.serverSafe && flags.consumeSafe) {
      assert.equal(h.snapshot().phase, 'retry-wait')
      await clock.advance(500)
      assert.equal(calls, 1)
      await clock.advance(2499)
      assert.equal(calls, 1)
      await clock.advance(1)
      assert.equal((await h.result).value, '{"ok":true,"data":"r1"}')
      assert.equal(calls, 2)
    } else {
      await assert.rejects(h.result, { code: 'HTTP_FAILED', status: 429 })
      assert.equal(calls, 1)
    }
    await h.resourcesDone
  }
})

for (const mechanism of ['legacy-header', 'json1073'] as const) {
  test(`429 ${mechanism} corrects parallelism and recovers after the configured period`, async t => {
    const clock = createRuntime(t)
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(
      input => {
        calls++
        if (calls === 3)
          return Promise.resolve(
            new Response(mechanism === 'json1073' ? '{"errors":[{"code":1073}]}' : '{}', {
              status: 429,
              headers:
                mechanism === 'json1073'
                  ? { 'Content-Type': 'application/json' }
                  : { 'X-Lognex-Auth': '429005', 'Content-Type': 'application/json' }
            })
          )
        return Promise.resolve(
          rate(
            calls === 1 ? 9 : 8,
            `r${new URL(typeof input === 'string' ? input : url).pathname.split('/').at(-1)}`
          )
        )
      },
      {
        maxParallelLimit: 3,
        maxRequestDelayTimeMs: 1000,
        jitter: 0,
        throttlingCoefficient: 1,
        parallelLimitCorrectionPeriodMs: 1000
      }
    )
    const handles = [1, 2, 3].map(id =>
      planner.submit({
        method: 'GET',
        replay: safeReplay,
        prepare: () => ({ url: `${url}/${id}`, init: {} }),
        consume: response => response.text()
      })
    )
    try {
      await clock.advance(0)
      assert.equal(calls, 3)
      assert.equal(planner.snapshot().effectiveParallelism, 2)
      await clock.advance(700)
      const fourth = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: `${url}/4`, init: {} }),
        consume: response => response.text()
      })
      handles.push(fourth)
      await clock.advance(0)
      assert.equal((await fourth.result).value, '{"ok":true,"data":"r4"}')
      await fourth.resourcesDone
      await clock.advance(299)
      assert.equal(planner.snapshot().effectiveParallelism, 2)
      assert.equal(calls, 4)
      await clock.advance(1)
      assert.equal(planner.snapshot().effectiveParallelism, 2, 'EQUALITY_IS_NOT_RECOVERY')
      await clock.advance(1)
      assert.equal(planner.snapshot().effectiveParallelism, 3)
      const fifth = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: `${url}/5`, init: {} }),
        consume: response => response.text()
      })
      handles.push(fifth)
      await clock.advance(0)
      assert.equal((await fifth.result).value, '{"ok":true,"data":"r5"}')
      await fifth.resourcesDone
      await clock.advance(1998)
      assert.equal(calls, 5)
      await clock.advance(1)
      assert.deepEqual(
        (await Promise.all(handles.map(h => h.result))).map(result => result.value),
        [
          '{"ok":true,"data":"r1"}',
          '{"ok":true,"data":"r2"}',
          '{"ok":true,"data":"r3"}',
          '{"ok":true,"data":"r4"}',
          '{"ok":true,"data":"r5"}'
        ]
      )
      await Promise.all(handles.map(h => h.resourcesDone))
      assert.equal(calls, 6)
      assert.equal(planner.snapshot().sentActive, 0)
      assert.equal(planner.snapshot().effectiveParallelism, 3)
    } finally {
      planner.stop()
      for (const h of handles) h.abort()
      await Promise.allSettled(handles.flatMap(h => [h.result, h.resourcesDone]))
    }
  })
}

test('Numeric options reject unsafe values synchronously and preserve rounded bounds', () => {
  const transport: typeof fetch = () => Promise.resolve(new Response(null))
  const integerOptions = [
    'maxParallelLimit',
    'maxRequestDelayTimeMs',
    'parallelLimitCorrectionPeriodMs'
  ] as const
  for (const name of [...integerOptions, 'jitter', 'throttlingCoefficient']) {
    for (const value of ['1', null, true, {}, []])
      assert.throws(() => Reflect.construct(FetchPlanner, [transport, { [name]: value }]), {
        code: 'INVALID_ARGUMENT'
      })
  }
  for (const name of integerOptions) {
    for (const value of [0, -1, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => new FetchPlanner(transport, { [name]: value }), {
        code: 'INVALID_ARGUMENT'
      })
    const minimum = name === 'parallelLimitCorrectionPeriodMs' ? 1000 : 1
    for (const value of [minimum, minimum - 0.4, 2147483647, 2147483648, Number.MAX_SAFE_INTEGER]) {
      const planner = new FetchPlanner(transport, { [name]: value })
      assert.equal(
        planner.snapshot().effectiveParallelism,
        name === 'maxParallelLimit' ? Math.round(value) : 4
      )
      assert.equal(planner.snapshot().stopped, false)
    }
    assert.throws(() => new FetchPlanner(transport, { [name]: minimum - 0.6 }), {
      code: 'INVALID_ARGUMENT'
    })
  }
  for (const name of ['jitter', 'throttlingCoefficient'] as const) {
    for (const value of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => new FetchPlanner(transport, { [name]: value }), {
        code: 'INVALID_ARGUMENT'
      })
  }
  for (const options of [
    { jitter: 0.31 },
    { throttlingCoefficient: 0 },
    { throttlingCoefficient: 20.1 }
  ])
    assert.throws(() => new FetchPlanner(transport, options), { code: 'INVALID_ARGUMENT' })
  for (const jitter of [0, 0.3])
    assert.equal(new FetchPlanner(transport, { jitter }).snapshot().stopped, false)
  for (const throttlingCoefficient of [1, 2.5, 20])
    assert.equal(new FetchPlanner(transport, { throttlingCoefficient }).snapshot().stopped, false)
})

for (const [coefficient, random, expected] of [
  [1, 0.5, 500],
  [2.5, 0.5, 177],
  [20, 0.5, 0],
  [1, 0, 575],
  [1, 1, 425]
] as const) {
  test(`Effective pacing coefficient ${coefficient} random ${random} follows rounded formula`, async t => {
    const clock = createRuntime(t)
    clock.setRandom(random)
    let calls = 0
    const options: Partial<FetchPlannerOptions> = {
      maxParallelLimit: 1,
      throttlingCoefficient: coefficient,
      jitter: 0.3,
      maxRequestDelayTimeMs: 1000
    }
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(rate(5))
    }, options)
    const submit = () =>
      planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: () => 'ok'
      })
    const first = submit()
    await clock.advance(0)
    await first.result
    await first.resourcesDone
    const next = submit()
    await clock.advance(0)
    if (expected > 0) {
      assert.equal(calls, 1)
      await clock.advance(expected - 1)
      assert.equal(calls, 1)
      await clock.advance(1)
    }
    assert.equal(calls, 2, 'EFFECTIVE_ROUNDED_DELAY')
    await next.result
    await next.resourcesDone
  })
}

test('Default options are stable public behavior and constructor input is detached', async t => {
  const clock = createRuntime(t)
  let calls = 0
  const options = { maxParallelLimit: 1, jitter: 0 }
  const planner = new FetchPlanner<typeof fetch>(() => {
    calls++
    return Promise.resolve(rate(5))
  }, options)
  options.maxParallelLimit = 2
  options.jitter = 0.2
  assert.equal(planner.snapshot().effectiveParallelism, 1, 'INPUT_OPTIONS_DETACHED')
  const submit = () =>
    planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'ok'
    })
  const first = submit()
  await clock.advance(0)
  await first.result
  await first.resourcesDone
  const second = submit()
  await clock.advance(0)
  // Defaults max delay3000 and coefficient5: round(3000*(1-.5)^5)=94.
  await clock.advance(93)
  assert.equal(calls, 1)
  await clock.advance(1)
  assert.equal(calls, 2)
  await second.result
  await second.resourcesDone
  assert.equal(
    new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response(null))).snapshot()
      .effectiveParallelism,
    4
  )
  for (const status of [500, 429]) {
    let receipts = 0
    const defaults = new FetchPlanner<typeof fetch>(() => {
      receipts++
      return Promise.resolve(new Response(null, { status }))
    })
    for (let i = 1; i <= 100; i++) {
      const h = defaults.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: response => response.status
      })
      await clock.advance(0)
      if (status === 429) await assert.rejects(h.result, { code: 'HTTP_FAILED', status })
      else assert.equal((await h.result).status, 500)
      await h.resourcesDone
      assert.equal(receipts, i)
      assert.equal(defaults.snapshot().guardOpen, i === 100, 'DEFAULT_GUARD_THRESHOLD')
    }
    const extra = defaults.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'forbidden'
    })
    await assert.rejects(extra.result, { code: 'GUARD_OPEN' })
    await extra.resourcesDone
    assert.equal(receipts, 100)
  }
  const defaults = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response(null)))
  for (let i = 1; i <= 61; i++) {
    const h = defaults.submit({
      method: 'PUT',
      entityKey: 'one',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'ok'
    })
    await clock.advance(0)
    if (i <= 60) assert.equal((await h.result).status, 200)
    else await assert.rejects(h.result, { code: 'PUT_LIMIT' })
    await h.resourcesDone
  }
  assert.equal(defaults.snapshot().guardOpen, false)
})

test('Observer stop prevents queued dispatch while preserving sent consume', async t => {
  const clock = createRuntime(t)
  let calls = 0
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      calls++
      return Promise.resolve(new Response(null))
    },
    { maxParallelLimit: 1 }
  )
  const reason = new Error('first stop')
  planner.observe(event => {
    if (event.type === 'headers-received') {
      planner.stop(reason)
      planner.stop(new Error('second stop'))
    }
  })
  const first = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url, init: {} }),
    consume: () => 'sent value'
  })
  const second = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url, init: {} }),
    consume: () => 'forbidden'
  })
  await clock.advance(0)
  assert.equal((await first.result).value, 'sent value')
  await assert.rejects(
    second.result,
    error => error instanceof OperationError && error.code === 'STOPPED' && error.cause === reason
  )
  await Promise.all([first.resourcesDone, second.resourcesDone])
  assert.equal(calls, 1)
  assert.equal(planner.snapshot().stopped, true)
})

test('Default jitter and correction period retain effective pacing policy', async t => {
  const clock = createRuntime(t)
  clock.setRandom(0)
  let calls = 0
  const paced = new FetchPlanner<typeof fetch>(() => {
    calls++
    return Promise.resolve(rate(5))
  })
  const submit = () =>
    paced.submit({ method: 'GET', replay, prepare: () => ({ url, init: {} }), consume: () => 'ok' })
  const first = submit()
  await clock.advance(0)
  await first.result
  await first.resourcesDone
  const second = submit()
  await clock.advance(0)
  // round(3000*(1+.1/2)*.5**5)=98 for default jitter .1, random0.
  await clock.advance(97)
  assert.equal(calls, 1)
  await clock.advance(1)
  assert.equal(calls, 2)
  await second.result
  await second.resourcesDone
  clock.setRandom(0.5)
  let count = 0
  const planner = new FetchPlanner<typeof fetch>(() =>
    Promise.resolve(
      ++count === 1
        ? new Response(null, { status: 429, headers: { 'X-Lognex-Auth': '429005' } })
        : new Response(null)
    )
  )
  const operation = () =>
    planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'ok'
    })
  const rejected = operation()
  await clock.advance(0)
  await assert.rejects(rejected.result, { code: 'HTTP_FAILED' })
  await rejected.resourcesDone
  assert.equal(planner.snapshot().effectiveParallelism, 3)
  // Default correction period10000 times (1+2*.5*.1)=11000; recovery is strictly later.
  await clock.advance(11000)
  const equal = operation()
  await clock.advance(0)
  await equal.result
  await equal.resourcesDone
  assert.equal(planner.snapshot().effectiveParallelism, 3, 'DEFAULT_RECOVERY_EQUALITY')
  await clock.advance(1)
  const later = operation()
  await clock.advance(0)
  await later.result
  await later.resourcesDone
  assert.equal(planner.snapshot().effectiveParallelism, 4, 'DEFAULT_CORRECTION_PERIOD')
})

for (const configured of [1, 0.6, 2147483647, 2147483648]) {
  test(`Rounded max delay ${configured} controls actual dispatch across timer chunks`, async t => {
    const clock = createRuntime(t)
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        calls++
        return Promise.resolve(rate(0))
      },
      {
        maxRequestDelayTimeMs: configured,
        throttlingCoefficient: 1,
        jitter: 0,
        deadlineMs: 10000000000,
        attemptTimeoutMs: 10000000000
      }
    )
    const submit = () =>
      planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: () => 'finished'
      })
    const first = submit()
    await clock.advance(0)
    await first.result
    await first.resourcesDone
    const next = submit()
    try {
      await clock.advance(0)
      assert.equal(calls, 1)
      await clock.advance(Math.round(configured) - 1)
      assert.equal(calls, 1, 'ROUNDED_DELAY_BOUNDARY')
      await clock.advance(1)
      assert.equal(calls, 2, 'ROUNDED_DELAY_ACTUAL_DISPATCH')
      await next.result
      await next.resourcesDone
    } finally {
      next.abort()
      await Promise.allSettled([next.result, next.resourcesDone])
    }
  })
}

test('Accepted maximum delay fails unsafe absolute arithmetic without another transport entry', async t => {
  const clock = createRuntime(t)
  let calls = 0
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      calls++
      return Promise.resolve(rate(0))
    },
    { maxRequestDelayTimeMs: Number.MAX_SAFE_INTEGER, jitter: 0 }
  )
  const submit = () =>
    planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => 'finished'
    })
  const first = submit()
  await clock.advance(0)
  await first.result
  await first.resourcesDone
  const next = submit()
  await clock.advance(0)
  await assert.rejects(
    next.result,
    error =>
      error instanceof OperationError &&
      error.cause instanceof assert.AssertionError &&
      error.cause.message.includes('FetchPlanner')
  )
  await next.resourcesDone
  assert.equal(calls, 1, 'UNSAFE_ARITHMETIC_NO_DISPATCH')
  assert.equal(planner.snapshot().leasedAttempts, 0)
})

for (const configured of [1000, 999.6, 2147483647, 2147483648]) {
  test(`Rounded recovery period ${configured} controls its exact public boundary`, async t => {
    const clock = createRuntime(t)
    const period = Math.round(configured)
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(
      () =>
        Promise.resolve(
          ++calls === 1
            ? new Response(null, { status: 429, headers: { 'X-Lognex-Auth': '429005' } })
            : new Response(null)
        ),
      { parallelLimitCorrectionPeriodMs: configured, jitter: 0 }
    )
    const submit = () =>
      planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: () => 'ok'
      })
    const failed = submit()
    const handles = [failed]
    try {
      await clock.advance(0)
      await assert.rejects(failed.result, { code: 'HTTP_FAILED' })
      await failed.resourcesDone
      assert.equal(planner.snapshot().effectiveParallelism, 3)
      // No active owner remains while the fake clock jumps; no long timer is polled.
      await clock.advance(period - 1)
      const before = submit()
      handles.push(before)
      await clock.advance(0)
      await before.result
      await before.resourcesDone
      assert.equal(planner.snapshot().effectiveParallelism, 3, 'ROUNDED_RECOVERY_BEFORE')
      await clock.advance(1)
      const equal = submit()
      handles.push(equal)
      await clock.advance(0)
      await equal.result
      await equal.resourcesDone
      assert.equal(planner.snapshot().effectiveParallelism, 3, 'ROUNDED_RECOVERY_EQUALITY')
      await clock.advance(1)
      const after = submit()
      handles.push(after)
      await clock.advance(0)
      await after.result
      await after.resourcesDone
      assert.equal(planner.snapshot().effectiveParallelism, 4, 'ROUNDED_RECOVERY_AFTER')
      assert.equal(calls, 4)
    } finally {
      planner.stop()
      await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
    }
  })
}

for (const jitter of [0, 0.1]) {
  test(`Maximum safe recovery period retains its public arithmetic with jitter ${jitter}`, async t => {
    const clock = createRuntime(t, 0)
    let now = 0
    t.mock.method(performance, 'now', () => now)
    let calls = 0
    const planner = new FetchPlanner<typeof fetch>(
      () =>
        Promise.resolve(
          ++calls === 1
            ? new Response(null, { status: 429, headers: { 'X-Lognex-Auth': '429005' } })
            : new Response(null)
        ),
      { parallelLimitCorrectionPeriodMs: Number.MAX_SAFE_INTEGER, jitter }
    )
    const submit = () =>
      planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: () => 'ok'
      })
    const first = submit()
    const handles = [first]
    try {
      await clock.advance(0)
      // A positive jitter multiplies MAX_SAFE_INTEGER beyond the safe duration
      // as soon as the first 429 reduction is reviewed by the coordinator.
      await assert.rejects(first.result, {
        code: jitter === 0 ? 'HTTP_FAILED' : 'INVALID_ARGUMENT'
      })
      await first.resourcesDone
      assert.equal(planner.snapshot().effectiveParallelism, 3)
      // Keep Date/timers representable and leave room for the admission deadline.
      now = Number.MAX_SAFE_INTEGER - 120001
      const next = submit()
      handles.push(next)
      const outcome = next.result.then(
        value => ({ value }),
        (error: unknown) => ({ error })
      )
      await clock.advance(0)
      const result = await outcome
      await next.resourcesDone
      if (jitter === 0) {
        assert.ok('value' in result)
        assert.equal(result.value.value, 'ok')
        assert.equal(calls, 2)
        assert.equal(planner.snapshot().effectiveParallelism, 3, 'MAXIMUM_RECOVERY_NOT_CLAMPED')
      } else {
        assert.ok('error' in result)
        assert.ok(result.error instanceof OperationError)
        assert.equal(result.error.code, 'INVALID_ARGUMENT')
        assert.ok(result.error.cause instanceof assert.AssertionError)
        assert.equal(calls, 1, 'UNSAFE_RECOVERY_PERIOD_NO_DISPATCH')
        assert.equal(planner.snapshot().effectiveParallelism, 3)
      }
    } finally {
      planner.stop()
      await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
    }
  })
}
