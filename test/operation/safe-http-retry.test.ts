import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { FetchPlanner, OperationError, type ConsumeContext } from '../../src/index.js'
import { ConsumeHttpFailure, ConsumeReadFailure } from '../../src/operation-types.js'
import { retryCandidate, retryDecision, type RetryBudget } from '../../src/retry-policy.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const replay = { serverSafe: true, consumeSafe: true }
const budget: RetryBudget = {
  candidate: 'consume-http',
  attempts: 1,
  maxAttempts: 100,
  now: 1000,
  deadline: 120000,
  stopped: false,
  cleanup: 'released',
  rateLimitOrdinal: 1,
  jitterFactor: 1,
  adaptiveNotBefore: 0,
  serverNotBefore: 0
}
for (const [attempts, base] of [
  [1, 1000],
  [2, 2000],
  [5, 16000],
  [6, 30000],
  [Number.MAX_SAFE_INTEGER - 1, 30000]
]) {
  for (const jitterFactor of [0.8, 1, 1.2]) {
    test(`HTTP fallback attempt ${attempts} jitter ${jitterFactor} caps before jitter`, () => {
      assert.ok(attempts !== undefined && base !== undefined)
      const delayMs = Math.ceil(base * jitterFactor)
      assert.deepEqual(
        retryDecision({ ...budget, attempts, maxAttempts: Number.MAX_SAFE_INTEGER, jitterFactor }),
        { kind: 'eligible', notBefore: 1000 + delayMs, delayMs }
      )
    })
  }
}
test('HTTP decision respects fixed time floors cleanup shared budgets and exact deadline', () => {
  for (const overrides of [
    { maxAttempts: 1 },
    { attempts: 3, maxAttempts: 3 },
    { deadline: 2000 },
    { serverNotBefore: 120000 },
    { cleanup: 'failed' as const },
    { cleanup: 'unknown' as const },
    { stopped: true },
    { now: Number.MAX_SAFE_INTEGER - 1, deadline: Number.MAX_SAFE_INTEGER }
  ])
    assert.equal(retryDecision({ ...budget, ...overrides }).kind, 'terminal')
  assert.deepEqual(retryDecision({ ...budget, cleanup: 'pending' }), { kind: 'pending-cleanup' })
  assert.deepEqual(retryDecision({ ...budget, jitterFactor: 0.80001 }), {
    kind: 'eligible',
    notBefore: 1801,
    delayMs: 801
  })
  assert.deepEqual(retryDecision({ ...budget, adaptiveNotBefore: 4000, serverNotBefore: 5000 }), {
    kind: 'eligible',
    notBefore: 5000,
    delayMs: 4000
  })
})
test('HTTP identity ignores shape and requires exact active lifetime and separate marker kind', () => {
  const scope = { active: true }
  const marker = new ConsumeHttpFailure(scope, undefined)
  assert.equal(
    retryCandidate({ code: 'CONSUME_FAILED', cause: marker, consumeLifetime: scope }, replay),
    undefined
  )
  assert.equal(
    retryCandidate({ code: 'CONSUME_FAILED', status: 503, cause: marker }, replay),
    undefined
  )
  for (const status of [200, 429, 500, 501, 502, 503, 504, 505]) {
    const facts = { code: 'CONSUME_FAILED' as const, status, cause: marker, consumeLifetime: scope }
    assert.equal(
      retryCandidate(facts, replay),
      [500, 502, 503, 504].includes(status) ? 'consume-http' : undefined
    )
    assert.equal(
      retryCandidate({ ...facts, cause: new ConsumeReadFailure(scope, null) }, replay),
      status === 200 ? 'consume-read' : undefined
    )
    for (const cause of [
      new Error(marker.message),
      Object.create(ConsumeHttpFailure.prototype),
      new ConsumeHttpFailure({}, null)
    ])
      assert.equal(retryCandidate({ ...facts, cause }, replay), undefined)
    assert.equal(retryCandidate(facts, { ...replay, consumeSafe: false }), undefined)
  }
  scope.active = false
  assert.equal(
    retryCandidate(
      { code: 'CONSUME_FAILED', status: 503, cause: marker, consumeLifetime: scope },
      replay
    ),
    undefined
  )
})

for (const sequence of [
  [500, 200],
  [502, 200],
  [503, 200],
  [504, 200],
  [429, 503, 200],
  [503, 429, 503],
  [500, 502, 504],
  [0, 503, 200]
]) {
  test(`HTTP sequence ${sequence.join('-')} shares attempts and fresh owned bodies`, async t => {
    const runtime = createRuntime(t)
    const timers = trackTimeouts(t)
    const cause = new Error('SDK')
    const bodies = new Set<unknown>()
    const identities: number[] = []
    const order: string[] = []
    let sends = 0
    let settlements = 0
    const planner = new FetchPlanner<typeof fetch>((_url, init) => {
      assert.ok(!bodies.has(init?.body))
      bodies.add(init?.body)
      const status = sequence[sends++]
      if (status === 0) throw new Error('transport')
      return Promise.resolve(new Response(null, { status }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        identities.push(ctx.operationId)
        order.push(`prepare${ctx.attemptNumber}`)
        ctx.onDispose(() => {
          order.push(`dispose${ctx.attemptNumber}`)
        })
        return { url: '', init: { body: new Uint8Array([ctx.attemptNumber]) } }
      },
      consume: (response, ctx) => {
        if (response.status !== 200) {
          ctx.onDiscard(() => {
            order.push(`discard${ctx.attemptNumber}`)
          })
          throw ctx.retryableHttpFailure(cause)
        }
        return 'complete'
      }
    })
    const outcome = handle.result.then(
      value => {
        settlements++
        return value
      },
      (error: unknown) => {
        settlements++
        return error
      }
    )
    try {
      await runtime.flush()
      // Advance one retry at a time: the second HTTP fallback uses attempt 2 even after 429/transport.
      await runtime.advance(sequence[0] === 429 ? 3000 : sequence[0] === 0 ? 1 : 1000)
      if (sequence.length === 3) await runtime.advance(sequence[1] === 429 ? 3000 : 2000)
      const result = await outcome
      if (sequence.at(-1) === 200) assert.equal((result as { value: string }).value, 'complete')
      else {
        assert.ok(result instanceof OperationError)
        assert.equal(result.cause, cause)
        assert.equal(result.status, sequence.at(-1))
        assert.equal(result.code, 'CONSUME_FAILED')
        assert.equal(result.phase, 'consuming')
        assert.equal(result.serverOutcome, 'http-response')
      }
      await handle.resourcesDone
      assert.equal(sends, sequence.length)
      assert.equal(settlements, 1)
      assert.ok(identities.every(id => id === handle.id))
      for (let n = 1; n < sends; n++)
        assert.ok(order.indexOf(`dispose${n}`) < order.indexOf(`prepare${n + 1}`))
      assert.equal(planner.snapshot().leasedAttempts, 0)
      assert.equal(planner.snapshot().sentActive, 0)
      assert.equal(timers.active.size, 0)
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const mode of [
  'default',
  'plain',
  'parser',
  'business',
  'partial',
  'unsafe-server',
  'unsafe-consume',
  'max-one',
  'deadline',
  'failed-cleanup',
  'unknown-cleanup',
  'mutated-cause',
  'getter-cause',
  'wrong-status',
  'read-marker',
  'foreign',
  'forged'
] as const) {
  test(`HTTP terminal ${mode} preserves result and direct SDK cause`, async t => {
    const runtime = createRuntime(t)
    const cause = new Error('SDK')
    const partial = { items: ['saved'], errors: ['failed'] }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let primary: unknown = cause
    let sends = 0
    const status = mode === 'wrong-status' ? 200 : 503
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        sends++
        return Promise.resolve(
          new Response(mode === 'unknown-cleanup' ? new ReadableStream<Uint8Array>() : null, {
            status
          })
        )
      },
      { maxAttempts: ['mutated-cause', 'getter-cause', 'max-one'].includes(mode) ? 1 : 3 }
    )
    const handle = planner.submit({
      method: 'POST',
      replay: { serverSafe: mode !== 'unsafe-server', consumeSafe: mode !== 'unsafe-consume' },
      ...(mode === 'deadline' ? { deadlineMs: 800 } : {}),
      prepare: ctx => {
        if (mode === 'failed-cleanup')
          ctx.onDispose(() => {
            throw new Error('dispose')
          })
        return { url: '', init: {} }
      },
      consume: (response, ctx) => {
        if (mode === 'default') return 'default'
        if (mode === 'partial') return partial
        if (mode === 'unknown-cleanup') reader = response.body?.getReader()
        if (mode === 'plain' || mode === 'business') throw cause
        if (mode === 'parser') {
          primary = new SyntaxError('JSON')
          throw primary
        }
        const marker =
          mode === 'read-marker'
            ? ctx.retryableReadFailure(cause)
            : mode === 'foreign'
              ? new ConsumeHttpFailure({}, cause)
              : mode === 'forged'
                ? (Object.create(ConsumeHttpFailure.prototype) as Error)
                : ctx.retryableHttpFailure(cause)
        if (['read-marker', 'foreign', 'forged'].includes(mode)) primary = marker
        if (mode === 'mutated-cause') marker.cause = 'mutated'
        if (mode === 'getter-cause')
          Object.defineProperty(marker, 'cause', {
            get() {
              assert.fail('public cause must not be read')
            }
          })
        throw marker
      }
    })
    const outcome = handle.result.then(
      value => value,
      (error: unknown) => error
    )
    try {
      await runtime.flush()
      const result = await outcome
      if (mode === 'default' || mode === 'partial')
        assert.equal((result as { value: unknown }).value, mode === 'default' ? 'default' : partial)
      else {
        assert.ok(result instanceof OperationError)
        assert.equal(result.cause, primary)
        assert.equal(result.status, status)
        assert.equal(result.attemptNumber, 1)
        assert.equal(result.code, 'CONSUME_FAILED')
      }
      await handle.resourcesDone
      assert.equal(sends, 1)
    } finally {
      reader?.releaseLock()
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const origin of ['http', '429', 'transport'] as const) {
  test(`Unsafe ${origin} never redispatches`, async t => {
    const runtime = createRuntime(t)
    let sends = 0
    const planner = new FetchPlanner<typeof fetch>(() => {
      sends++
      if (origin === 'transport') throw new Error('network')
      return Promise.resolve(new Response(null, { status: origin === '429' ? 429 : 503 }))
    })
    const handle = planner.submit({
      method: 'POST',
      replay: { serverSafe: false, consumeSafe: false },
      prepare: () => ({ url: '', init: {} }),
      consume: (_r, ctx) => {
        throw ctx.retryableHttpFailure('SDK')
      }
    })
    const outcome = handle.result.catch((error: unknown) => error)
    await runtime.flush()
    assert.ok((await outcome) instanceof OperationError)
    await handle.resourcesDone
    assert.equal(sends, 1)
  })
}

for (const mode of ['thenable', 'subclass', 'stateful'] as const) {
  test(`HTTP active branded ${mode} rejection is captured before guard closes`, async t => {
    const runtime = createRuntime(t)
    let sends = 0
    let expired: (() => Error) | undefined
    const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
      sends++
      return Promise.resolve(new Response(null, { status: sends === 1 ? 503 : 200 }))
    })
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: '', init: {} }),
      consume: (_response, ctx) => {
        if (ctx.attemptNumber > 1) {
          assert.throws(() => expired?.(), { code: 'INVALID_ARGUMENT' })
          return 'complete'
        }
        expired = () => ctx.retryableHttpFailure('escaped')
        const rejectBrand = () => ctx.retryableHttpFailure('active')
        if (mode === 'subclass') {
          class ReadPromise extends Promise<string> {
            override then<A = string, B = never>(): Promise<A | B> {
              throw rejectBrand()
            }
          }
          return new ReadPromise(resolve => {
            resolve('read')
          })
        }
        let reads = 0
        const value: PromiseLike<string> = {
          then: (fulfilled, rejected) =>
            Promise.reject<string>(rejectBrand()).then(fulfilled, rejected)
        }
        Object.defineProperty(value, 'then', {
          get() {
            reads++
            if (mode === 'stateful' && reads === 1) return undefined
            return (_resolve: (value: string) => void, reject: (reason: unknown) => void) => {
              reject(rejectBrand())
            }
          }
        })
        // Descriptor preserves the public Promise return shape while hostile getters
        // deliberately exercise the runtime assimilation protocol.
        return new Promise<string>(resolve => {
          resolve(value)
        })
      }
    })
    try {
      await runtime.flush()
      await runtime.advance(1000)
      assert.equal(sends, 2, 'ACTIVE_ASSIMILATION_BRAND_MUST_RETRY')
      assert.equal((await handle.result).value, 'complete')
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const hook of ['allow', 'defer', 'deny', 'late'] as const) {
  test(`HTTP cleanup then ${hook} hook retains a single fallback sample and time`, async t => {
    const clock = createRuntime(t)
    const cleanup = deferred<undefined>()
    const gate = deferred<undefined>()
    let hooks = 0
    let sends = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => Promise.resolve(new Response(null, { status: ++sends === 1 ? 503 : 200 })),
      { hookTimeoutMs: 5000 }
    )
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: ctx => {
        if (ctx.attemptNumber === 1) ctx.onDispose(() => cleanup.promise)
        return { url: '', init: {} }
      },
      consume: (r, ctx) => {
        if (r.status === 503) throw ctx.retryableHttpFailure('SDK')
        return 'ok'
      },
      beforeRetry: async () => {
        hooks++
        await gate.promise
        if (hook === 'deny') return { type: 'deny', code: 'POLICY_DENIED' }
        if (hook === 'defer') return { type: 'defer', delayMs: 1500 }
        return { type: 'allow' }
      }
    })
    const outcome = handle.result.catch((error: unknown) => error)
    try {
      await clock.flush()
      await clock.advance(2000)
      assert.equal(hooks, 0)
      assert.equal(sends, 1)
      cleanup.resolve(undefined)
      await clock.flush()
      assert.equal(hooks, 1)
      // Fallback starts after cleanup, not consume, and must survive changed randomness.
      clock.setRandom(1)
      await clock.advance(hook === 'late' ? 5000 : 500)
      gate.resolve(undefined)
      await clock.flush()
      if (hook === 'deny' || hook === 'late') {
        const result = await outcome
        assert.ok(result instanceof OperationError)
        assert.equal(result.code, hook === 'deny' ? 'HOOK_DENIED' : 'HOOK_FAILED')
        assert.equal(sends, 1)
      } else {
        const remainder = hook === 'defer' ? 1500 : 500
        await clock.advance(remainder - 1)
        assert.equal(sends, 1)
        await clock.advance(1)
        assert.equal(sends, 2)
        assert.equal(((await outcome) as { value: string }).value, 'ok')
      }
      await handle.resourcesDone
    } finally {
      cleanup.resolve(undefined)
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const phase of ['consume', 'cleanup', 'backoff'] as const) {
  for (const interrupt of ['stop', 'abort', 'deadline', 'timeout'] as const) {
    if (phase === 'backoff' && interrupt === 'timeout') continue
    test(`HTTP ${interrupt} during ${phase} keeps terminal reason and releases ownership`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const gate = deferred<undefined>()
      let sends = 0
      const planner = new FetchPlanner<typeof fetch>(
        () => Promise.resolve(new Response(null, { status: ++sends === 1 ? 503 : 200 })),
        {
          deadlineMs: interrupt === 'deadline' ? 2000 : 10000,
          attemptTimeoutMs: interrupt === 'timeout' ? 2000 : 10000
        }
      )
      const handle = planner.submit({
        method: 'GET',
        replay,
        prepare: ctx => {
          if (phase === 'cleanup') ctx.onDispose(() => gate.promise)
          return { url: '', init: {} }
        },
        consume: async (_r, ctx) => {
          if (phase === 'consume') await gate.promise
          throw ctx.retryableHttpFailure('late SDK')
        }
      })
      const outcome = handle.result.catch((error: unknown) => error)
      try {
        await clock.flush()
        if (interrupt === 'stop') planner.stop('stop reason')
        else if (interrupt === 'abort') handle.abort('abort reason')
        else await clock.advance(2000)
        gate.resolve(undefined)
        await clock.flush()
        const result = await outcome
        assert.ok(result instanceof OperationError)
        const expected =
          interrupt === 'stop'
            ? 'STOPPED'
            : interrupt === 'abort'
              ? 'ABORTED'
              : interrupt === 'deadline'
                ? 'DEADLINE'
                : 'ATTEMPT_TIMEOUT'
        assert.equal(result.code, expected)
        assert.notEqual(result.cause, 'late SDK')
        await handle.resourcesDone
        assert.equal(sends, 1)
        assert.equal(timers.active.size, 0)
        assert.equal(planner.snapshot().leasedAttempts, 0)
      } finally {
        gate.resolve(undefined)
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
}

test('HTTP factories cannot be borrowed by another owner or observer and expire after consume', async t => {
  const clock = createRuntime(t)
  const gate = deferred<undefined>()
  let factory: ConsumeContext['retryableHttpFailure'] | undefined
  let marker: Error | undefined
  let borrowedError: unknown
  let observed = 0
  const planner = new FetchPlanner<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: 503 }))
  )
  const first = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: async (_r, ctx) => {
      // Intentionally extract the capability to test borrowing across active owners.
      // oxlint-disable-next-line typescript/unbound-method
      factory = ctx.retryableHttpFailure
      marker = factory('first SDK')
      await gate.promise
      return 'first'
    }
  })
  const firstResult = first.result.catch((error: unknown) => error)
  await clock.flush()
  const second = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: () => {
      assert.throws(() => factory?.('borrowed'), { code: 'INVALID_ARGUMENT' })
      assert.ok(marker instanceof Error)
      borrowedError = marker
      throw marker
    }
  })
  second.observe(() => {
    if (factory) {
      observed++
      assert.throws(() => factory?.('observer'), { code: 'INVALID_ARGUMENT' })
    }
  })
  const secondResult = second.result.catch((error: unknown) => error)
  try {
    await clock.flush()
    const result = await secondResult
    assert.ok(result instanceof OperationError)
    assert.equal(result.cause, borrowedError, 'foreign marker must not unwrap')
    assert.equal(second.snapshot().attempts, 1)
    gate.resolve(undefined)
    await firstResult
    await Promise.all([first.resourcesDone, second.resourcesDone])
    assert.throws(() => factory?.('late'), { code: 'INVALID_ARGUMENT' })
    assert.ok(observed > 0)
  } finally {
    gate.resolve(undefined)
    first.abort()
    second.abort()
    await Promise.allSettled([
      first.result,
      second.result,
      first.resourcesDone,
      second.resourcesDone
    ])
  }
})

for (const cleanup of ['failed', 'pending'] as const) {
  test(`HTTP committed value survives ${cleanup} cleanup without replay`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<undefined>()
    let sends = 0
    const value = { saved: true }
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        sends++
        return Promise.resolve(new Response(null, { status: 503 }))
      },
      { cleanupGraceMs: 50 }
    )
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        ctx.onDispose(() => {
          if (cleanup === 'failed') throw new Error('dispose')
          return gate.promise
        })
        return { url: '', init: {} }
      },
      consume: () => value
    })
    try {
      await clock.flush()
      if (cleanup === 'pending') await clock.advance(50)
      assert.equal((await handle.result).value, value)
      assert.equal(sends, 1)
    } finally {
      gate.resolve(undefined)
      await handle.resourcesDone
    }
  })
}

test('HTTP finite child clears backoff timer and exits naturally after abort', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '--input-type=module',
      '-e',
      `
import { FetchPlanner } from './__temp/operation-build/src/index.js';
const planner = new FetchPlanner(() => Promise.resolve(new Response(null, {status:503})));
const handle = planner.submit({method:'GET', replay:{serverSafe:true,consumeSafe:true},prepare:()=>({url:'',init:{}}),consume:(r,c)=>{throw c.retryableHttpFailure('SDK')}});
const outcome = handle.result.catch(e=>e);
handle.observe(e=>{if(e.type==='retry-scheduled') handle.abort('done')});
const error = await outcome;
if(error.code!=='ABORTED') throw error;
await handle.resourcesDone;
console.log('HTTP natural exit');
`
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 2000 }
  )
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.match(child.stdout, /HTTP natural exit/)
})

for (const mode of ['exhaustion', 'deadline', 'server-floor', 'long-allow'] as const) {
  test(`HTTP ${mode} keeps shared deadline original cause and fixed backoff`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<undefined>()
    const cause = new Error('SDK cause')
    let sends = 0
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        sends++
        return Promise.resolve(
          new Response(null, {
            status: mode === 'exhaustion' || mode === 'deadline' || sends === 1 ? 503 : 200,
            headers: mode === 'server-floor' && sends === 1 ? { 'retry-after': '4' } : {}
          })
        )
      },
      { hookTimeoutMs: 5000 }
    )
    const handle = planner.submit({
      method: 'GET',
      replay,
      ...(mode === 'deadline' ? { deadlineMs: 2500 } : {}),
      ...(mode === 'long-allow'
        ? {
            beforeRetry: async () => {
              await gate.promise
              return { type: 'allow' as const }
            }
          }
        : {}),
      prepare: () => ({ url: '', init: {} }),
      consume: (r, ctx) => {
        if (r.status === 200) return 'ok'
        const marker = ctx.retryableHttpFailure(cause)
        Object.defineProperty(marker, 'cause', {
          get() {
            assert.fail('must use private cause at exhaustion')
          }
        })
        throw marker
      }
    })
    const outcome = handle.result.catch((error: unknown) => error)
    try {
      await clock.flush()
      if (mode === 'server-floor') {
        await clock.advance(3999)
        assert.equal(sends, 1)
        await clock.advance(1)
      } else if (mode === 'long-allow') {
        await clock.advance(1500)
        assert.equal(sends, 1)
        gate.resolve(undefined)
        await clock.flush()
        // An already elapsed floor still enters the existing coordinator timer wake.
        await clock.advance(1)
        assert.equal(sends, 2, 'allow after fallback must not restart delay')
      } else {
        await clock.advance(1000)
        assert.equal(sends, 2)
        if (mode === 'exhaustion') await clock.advance(2000)
      }
      const result = await outcome
      if (mode === 'exhaustion' || mode === 'deadline') {
        assert.ok(result instanceof OperationError)
        assert.equal(result.code, 'CONSUME_FAILED')
        assert.equal(result.cause, cause)
        assert.equal(result.attemptNumber, mode === 'exhaustion' ? 3 : 2)
        assert.equal(sends, mode === 'exhaustion' ? 3 : 2)
      } else assert.equal((result as { value: string }).value, 'ok')
      await handle.resourcesDone
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}
