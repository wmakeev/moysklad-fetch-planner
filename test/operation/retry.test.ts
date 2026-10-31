import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { createRuntime, deferred } from './helpers.js'
import { FetchPlanner as DeepFetchPlanner } from '../../src/planner.js'
import { fetch as UndiciFetch, Response as UndiciResponse } from 'undici'
import { CallbackContext } from '../../src/callback-context.js'
import { ConsumeReadFailure, type FailureCode } from '../../src/operation-types.js'
import { parseResponsePolicy } from '../../src/response-policy.js'
import {
  retryCandidate,
  retryDecision,
  type RetryBudget,
  type RetryFailure
} from '../../src/retry-policy.js'

const replay = { serverSafe: true, consumeSafe: true }
function budget(overrides: Partial<RetryBudget> = {}): RetryBudget {
  return {
    attempts: 1,
    maxAttempts: 3,
    now: 1000,
    deadline: 120_000,
    stopped: false,
    cleanup: 'released',
    candidate: 'rate-limit',
    rateLimitOrdinal: 1,
    jitterFactor: 1,
    adaptiveNotBefore: 0,
    serverNotBefore: 0,
    ...overrides
  }
}

test('Explicit safe 429 candidate and arbitrary TypeError baseline', () => {
  assert.equal(retryCandidate({ code: 'HTTP_FAILED', status: 429 }, replay), 'rate-limit')
  assert.equal(
    retryCandidate(
      { code: 'CONSUME_FAILED', status: 200, cause: new TypeError('network') },
      replay
    ),
    undefined
  )
  assert.deepEqual(retryDecision(budget()), { kind: 'eligible', notBefore: 4000, delayMs: 3000 })
})

const inactive = { active: false }
const scope = { active: true }
const branded = new ConsumeReadFailure(scope, new TypeError('read'))
const origins: {
  name: string
  failure: RetryFailure
  expected: ReturnType<typeof retryCandidate>
}[] = [
  { name: '429', failure: { code: 'HTTP_FAILED', status: 429 }, expected: 'rate-limit' },
  {
    name: 'transport rejection',
    failure: { code: 'TRANSPORT_FAILED', cause: new Error() },
    expected: 'transport'
  },
  {
    name: 'transport sync throw',
    failure: { code: 'TRANSPORT_FAILED', cause: new TypeError() },
    expected: 'transport'
  },
  {
    name: 'transport with response',
    failure: { code: 'TRANSPORT_FAILED', status: 503 },
    expected: undefined
  },
  {
    name: 'active branded consume',
    failure: { code: 'CONSUME_FAILED', status: 200, cause: branded, consumeLifetime: scope },
    expected: 'consume-read'
  },
  {
    name: 'wrong scope',
    failure: {
      code: 'CONSUME_FAILED',
      status: 200,
      cause: branded,
      consumeLifetime: { active: true }
    },
    expected: undefined
  },
  {
    name: 'missing scope',
    failure: { code: 'CONSUME_FAILED', status: 200, cause: branded },
    expected: undefined
  },
  {
    name: 'inactive scope',
    failure: {
      code: 'CONSUME_FAILED',
      status: 200,
      cause: new ConsumeReadFailure(inactive, null),
      consumeLifetime: inactive
    },
    expected: undefined
  },
  {
    name: 'message forgery',
    failure: {
      code: 'CONSUME_FAILED',
      status: 200,
      cause: new Error(branded.message),
      consumeLifetime: scope
    },
    expected: undefined
  },
  {
    name: 'prototype forgery',
    failure: {
      code: 'CONSUME_FAILED',
      status: 200,
      cause: Object.create(ConsumeReadFailure.prototype),
      consumeLifetime: scope
    },
    expected: undefined
  },
  {
    name: 'arbitrary TypeError',
    failure: {
      code: 'CONSUME_FAILED',
      status: 200,
      cause: new TypeError('fetch failed'),
      consumeLifetime: scope
    },
    expected: undefined
  },
  {
    name: 'decode',
    failure: { code: 'CONSUME_FAILED', status: 200, cause: new SyntaxError('JSON') },
    expected: undefined
  },
  {
    name: 'schema',
    failure: { code: 'CONSUME_FAILED', status: 200, cause: new Error('schema') },
    expected: undefined
  }
]
const terminalCodes: FailureCode[] = [
  'PREPARE_FAILED',
  'INVALID_ARGUMENT',
  'ATTEMPT_TIMEOUT',
  'CLEANUP_FAILED',
  'ABORTED',
  'DEADLINE',
  'STOPPED',
  'GUARD_OPEN',
  'GUARD_CAPACITY',
  'PUT_LIMIT',
  'HOOK_FAILED',
  'HOOK_DENIED'
]
for (const code of terminalCodes)
  origins.push({
    name: code,
    failure: { code, status: 429, cause: branded, consumeLifetime: scope },
    expected: undefined
  })
for (let status = 200; status < 300; status++)
  origins.push({
    name: `branded HTTP ${status}`,
    failure: { code: 'CONSUME_FAILED', status, cause: branded, consumeLifetime: scope },
    expected: 'consume-read'
  })
for (let status = 300; status < 600; status++)
  origins.push({
    name: `branded non2xx ${status}`,
    failure: { code: 'CONSUME_FAILED', status, cause: branded, consumeLifetime: scope },
    expected: undefined
  })
for (const serverSafe of [false, true]) {
  for (const consumeSafe of [false, true]) {
    for (const origin of origins) {
      test(`Replay ${Number(serverSafe)}${Number(consumeSafe)} ${origin.name}`, () => {
        assert.equal(
          retryCandidate(origin.failure, { serverSafe, consumeSafe }),
          serverSafe && consumeSafe ? origin.expected : undefined,
          'CANDIDATE_REQUIRES_BOTH_FLAGS_AND_TRUSTED_ORIGIN'
        )
      })
    }
  }
}

test('Actual callback lifetime candidate capture survives as scalar but brand expires', async () => {
  const context = new CallbackContext()
  const other = new CallbackContext()
  let captured: RetryFailure | undefined
  let inside: ReturnType<typeof retryCandidate>
  await context.run(
    async lifetime => {
      const error = new ConsumeReadFailure(lifetime, new TypeError('read'))
      try {
        await Promise.resolve()
        throw error
      } catch (cause) {
        captured = { code: 'CONSUME_FAILED', status: 200, cause, consumeLifetime: lifetime }
        inside = retryCandidate(captured, replay)
        await other.run(
          otherLifetime => {
            assert.equal(
              retryCandidate(
                { ...captured, code: 'CONSUME_FAILED', consumeLifetime: otherLifetime },
                replay
              ),
              undefined
            )
          },
          value => value
        )
      }
    },
    value => value
  )
  assert.equal(inside, 'consume-read')
  assert.ok(captured)
  assert.equal(captured.consumeLifetime?.active, false)
  assert.equal(retryCandidate(captured, replay), undefined, 'EXPIRED_BRAND_IS_NOT_A_NEW_CANDIDATE')
  assert.deepEqual(retryDecision(budget({ candidate: inside })), {
    kind: 'eligible',
    notBefore: 1001,
    delayMs: 1
  })
})

for (const [ordinal, base] of [
  [1, 3000],
  [2, 6000],
  [3, 12000],
  [4, 24000],
  [5, 30000],
  [Number.MAX_SAFE_INTEGER, 30000]
]) {
  for (const factor of [0.8, 1, 1.2]) {
    test(`429 ordinal ${ordinal} factor ${factor} caps before jitter`, () => {
      assert.ok(ordinal !== undefined && base !== undefined)
      const expected = Math.ceil(base * factor)
      assert.deepEqual(
        retryDecision(budget({ rateLimitOrdinal: ordinal, jitterFactor: factor })),
        {
          kind: 'eligible',
          notBefore: 1000 + expected,
          delayMs: expected
        },
        'CAP_BEFORE_JITTER'
      )
    })
  }
}

test('Fractional jitter rounds up and never shortens a lower bound', () => {
  assert.deepEqual(retryDecision(budget({ jitterFactor: 0.80001 })), {
    kind: 'eligible',
    notBefore: 3401,
    delayMs: 2401
  })
})

for (const candidate of ['rate-limit', 'transport', 'consume-read'] as const) {
  for (const attempts of [1, 2, 3]) {
    test(`${candidate} operation preparation count ${attempts} has shared max three`, () => {
      const decision = retryDecision(budget({ candidate, attempts }))
      assert.equal(decision.kind, attempts < 3 ? 'eligible' : 'terminal')
      assert.deepEqual(retryDecision(budget({ candidate, attempts, maxAttempts: 1 })), {
        kind: 'terminal',
        reason: 'budget'
      })
    })
  }
}

for (const cleanup of ['pending', 'failed', 'unknown', 'released'] as const) {
  test(`Known work cleanup ${cleanup} is distinct from potential candidate`, () => {
    assert.equal(retryCandidate({ code: 'HTTP_FAILED', status: 429 }, replay), 'rate-limit')
    assert.deepEqual(
      retryDecision(budget({ cleanup })),
      cleanup === 'pending'
        ? { kind: 'pending-cleanup' }
        : cleanup === 'released'
          ? { kind: 'eligible', notBefore: 4000, delayMs: 3000 }
          : { kind: 'terminal', reason: 'cleanup' }
    )
  })
}

test('Stop and missing candidates cannot become retry ready', () => {
  assert.deepEqual(retryDecision(budget({ stopped: true })), {
    kind: 'terminal',
    reason: 'stopped'
  })
  assert.deepEqual(retryDecision(budget({ candidate: undefined })), {
    kind: 'terminal',
    reason: 'not-candidate'
  })
})

for (const overrides of [
  { now: 120_000 },
  { now: 120_001 },
  { deadline: 4000 },
  { deadline: 3999 },
  { serverNotBefore: 120_000 },
  { adaptiveNotBefore: 120_001 },
  { now: Number.MAX_SAFE_INTEGER - 1, deadline: Number.MAX_SAFE_INTEGER },
  { attempts: Number.MAX_SAFE_INTEGER },
  { maxAttempts: 0 },
  { attempts: 0 },
  { now: NaN },
  { deadline: Infinity },
  { serverNotBefore: Infinity },
  { adaptiveNotBefore: -1 },
  { rateLimitOrdinal: Infinity },
  { rateLimitOrdinal: 0 },
  { jitterFactor: NaN },
  { jitterFactor: 0.79 },
  { jitterFactor: 1.21 }
]) {
  test(`Invalid or exhausted budget ${JSON.stringify(overrides)}`, () => {
    assert.deepEqual(retryDecision(budget(overrides)), { kind: 'terminal', reason: 'budget' })
  })
}

test('Last millisecond before deadline remains eligible without a fresh budget', () => {
  assert.deepEqual(retryDecision(budget({ deadline: 4001 })), {
    kind: 'eligible',
    notBefore: 4000,
    delayMs: 3000
  })
  assert.deepEqual(retryDecision(budget({ now: 4000, deadline: 4001, candidate: 'transport' })), {
    kind: 'terminal',
    reason: 'budget'
  })
})

test('Parsed independent receipt hints and adaptive ceilings preserve absolute maxima', () => {
  for (const [headers, expected] of [
    [{}, 4000],
    [{ 'x-lognex-retry-after': '0', 'x-lognex-reset': '0', 'retry-after': '0' }, 4000],
    [{ 'x-lognex-retry-after': '9000', 'x-lognex-reset': '8000', 'retry-after': '7' }, 10_000],
    [{ 'x-lognex-retry-after': 'bad', 'x-lognex-reset': '9000', 'retry-after': '11' }, 12_000],
    [{ 'retry-after': 'Thu, 01 Jan 1970 00:00:20 GMT' }, 11_000]
  ] as const) {
    const policy = parseResponsePolicy(429, new Headers(headers), { monotonic: 1000, wall: 10_000 })
    assert.deepEqual(retryDecision(budget({ serverNotBefore: policy.serverNotBefore })), {
      kind: 'eligible',
      notBefore: expected,
      delayMs: expected - 1000
    })
    assert.deepEqual(
      retryDecision(budget({ serverNotBefore: policy.serverNotBefore, adaptiveNotBefore: 50_000 })),
      { kind: 'eligible', notBefore: 50_000, delayMs: 49_000 }
    )
  }
  const old = parseResponsePolicy(429, new Headers({ 'x-lognex-reset': '15000' }), {
    monotonic: 1000,
    wall: 0
  })
  const late = parseResponsePolicy(200, new Headers({ 'x-lognex-reset': '0' }), {
    monotonic: 2000,
    wall: 99_000
  })
  assert.deepEqual(
    retryDecision(budget({ serverNotBefore: Math.max(old.serverNotBefore, late.serverNotBefore) })),
    { kind: 'eligible', notBefore: 16_000, delayMs: 15_000 }
  )
})

test('Transport and deferred decisions do not reset the supplied operation 429 ordinal', () => {
  assert.equal(retryDecision(budget({ rateLimitOrdinal: 4 })).kind, 'eligible')
  assert.deepEqual(retryDecision(budget({ candidate: 'transport', rateLimitOrdinal: 4 })), {
    kind: 'eligible',
    notBefore: 1001,
    delayMs: 1
  })
  assert.deepEqual(retryDecision(budget({ rateLimitOrdinal: 5, serverNotBefore: 60_000 })), {
    kind: 'eligible',
    notBefore: 60_000,
    delayMs: 59_000
  })
  assert.deepEqual(retryDecision(budget({ rateLimitOrdinal: 5, jitterFactor: 1.2 })), {
    kind: 'eligible',
    notBefore: 37_000,
    delayMs: 36_000
  })
})

test('Single attempt terminal 429 preserves HTTP facts without consume or replay', async () => {
  let prepares = 0
  let sends = 0
  let consumes = 0
  let disposals = 0
  const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
    sends++
    return Promise.resolve(
      new Response('{}', {
        status: 429,
        headers: { 'content-type': 'application/json' }
      })
    )
  })
  const handle = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: ctx => {
      prepares++
      assert.equal(ctx.attemptNumber, 1)
      ctx.onDispose(() => {
        disposals++
      })
      return { url: '', init: {} }
    },
    consume: () => {
      consumes++
    }
  })
  await assert.rejects(
    handle.result,
    error =>
      error instanceof OperationError &&
      error.code === 'HTTP_FAILED' &&
      error.status === 429 &&
      error.attemptNumber === 1 &&
      error.serverOutcome === 'http-response'
  )
  assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
  assert.deepEqual([prepares, sends, consumes, disposals], [1, 1, 0, 1])
  assert.equal(handle.snapshot().dispatchEntered, true)
  assert.equal(planner.snapshot().leasedAttempts, 0)
  assert.equal(planner.snapshot().sentActive, 0)
})

test('Single attempt keeps current send and guarded value through consume and cleanup barriers', async () => {
  const consuming = deferred<undefined>()
  const consumeGate = deferred<undefined>()
  const disposing = deferred<undefined>()
  const disposeGate = deferred<undefined>()
  const value = { complete: true }
  let settled = false
  let discarded = 0
  let prepareSignal: AbortSignal | undefined
  const planner = new FetchPlanner<typeof globalThis.fetch>(
    () => Promise.resolve(new Response('complete')),
    { maxParallelLimit: 1 }
  )
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: ctx => {
      prepareSignal = ctx.signal
      ctx.onDispose(async () => {
        disposing.resolve(undefined)
        await disposeGate.promise
      })
      return { url: '', init: {} }
    },
    consume: async (response, ctx) => {
      assert.equal(ctx.signal, prepareSignal)
      assert.equal(ctx.attemptNumber, 1)
      ctx.onDiscard(() => {
        discarded++
      })
      await response.text()
      consuming.resolve(undefined)
      await consumeGate.promise
      return value
    }
  })
  void handle.result.then(() => {
    settled = true
  })
  try {
    await consuming.promise
    planner.stop()
    await setImmediate()
    assert.equal(settled, false)
    assert.equal(prepareSignal?.aborted, false)
    assert.equal(planner.snapshot().leasedAttempts, 1)
    assert.equal(planner.snapshot().sentActive, 1)
    consumeGate.resolve(undefined)
    await disposing.promise
    assert.equal(handle.snapshot().resultCommitted, true)
    handle.abort()
    const completed = await handle.result
    assert.equal(completed.value, value)
    assert.equal(completed.cleanup, 'pending')
    assert.equal(discarded, 0)
    assert.equal(handle.snapshot().resources, 'pending')
    assert.equal(planner.snapshot().leasedAttempts, 1)
    assert.equal(planner.snapshot().sentActive, 1)
    disposeGate.resolve(undefined)
    assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
    assert.equal(handle.snapshot().attempts, 1)
    assert.equal(handle.snapshot().dispatchCalls, 1)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  } finally {
    consumeGate.resolve(undefined)
    disposeGate.resolve(undefined)
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

for (const [entry, Constructor] of [
  ['root', FetchPlanner],
  ['deep', DeepFetchPlanner]
] as const) {
  for (const first of ['known-work', 'finalization'] as const) {
    test(`Runtime safe429 waits for known work AND finalization ${entry} release ${first} first`, async t => {
      const runtime = createRuntime(t)
      const knownWork = deferred<undefined>()
      const finalization = deferred<undefined>()
      const disposing = deferred<undefined>()
      const signals: AbortSignal[] = []
      let prepares = 0
      let sends = 0
      let settled = false
      let resourcesSettled = false
      const consumed: number[] = []
      const planner = new Constructor<typeof globalThis.fetch>(
        () => {
          sends++
          return Promise.resolve(
            sends === 1
              ? new Response(new ReadableStream<Uint8Array>({ cancel: () => knownWork.promise }), {
                  status: 429
                })
              : new Response('complete')
          )
        },
        { maxParallelLimit: 1 }
      )
      const handle = planner.submit({
        method: 'POST',
        replay,
        prepare: ctx => {
          prepares++
          signals.push(ctx.signal)
          assert.equal(ctx.operationId, handle.id)
          assert.equal(ctx.attemptNumber, prepares)
          assert.equal(handle.snapshot().status, undefined, 'FRESH_ATTEMPT_CLEARS_STATUS')
          if (prepares === 1)
            ctx.onDispose(async () => {
              disposing.resolve(undefined)
              await finalization.promise
            })
          return { url: '', init: { body: 'same logical payload' } }
        },
        consume: async response => {
          consumed.push(response.status)
          return await response.text()
        }
      })
      void handle.result.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      void handle.resourcesDone.then(() => {
        resourcesSettled = true
      })
      try {
        await disposing.promise
        await runtime.flush()
        assert.equal(settled, false, 'SAFE429_RESULT_PENDING_BEFORE_KNOWN_WORK')
        assert.equal(prepares, 1, 'NO_RETRY_BEFORE_KNOWN_WORK')
        assert.equal(planner.snapshot().sentActive, 1, 'PENDING_WORK_RETAINS_SENT')
        assert.equal(planner.snapshot().leasedAttempts, 1, 'PENDING_WORK_RETAINS_LEASE')
        if (first === 'known-work') knownWork.resolve(undefined)
        else finalization.resolve(undefined)
        await runtime.flush()
        assert.equal(settled, false, 'SAFE429_RESULT_PENDING_BEFORE_SECOND_BARRIER')
        assert.equal(prepares, 1, 'NO_RETRY_BEFORE_SECOND_BARRIER')
        assert.equal(resourcesSettled, false)
        assert.equal(planner.snapshot().sentActive, 1, 'SECOND_BARRIER_RETAINS_SENT')
        assert.equal(planner.snapshot().leasedAttempts, 1, 'SECOND_BARRIER_RETAINS_LEASE')
        finalization.resolve(undefined)
        knownWork.resolve(undefined)
        await runtime.flush()
        await runtime.advance(3601)
        assert.equal(sends, 2, 'SAFE429_DISPATCH_1_MUST_BECOME_2')
        assert.equal((await handle.result).value, 'complete')
        assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
        assert.equal(signals.length, 2)
        assert.notEqual(signals[0], signals[1], 'FRESH_CONTROLLER')
        assert.deepEqual(consumed, [200])
        assert.equal(handle.snapshot().attempts, 2)
        assert.equal(handle.snapshot().dispatchCalls, 2)
      } finally {
        knownWork.resolve(undefined)
        finalization.resolve(undefined)
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
  for (const origin of ['branded', 'transport'] as const) {
    test(`Runtime ${origin} dispatches fresh attempt ${entry}`, async t => {
      const runtime = createRuntime(t)
      let sends = 0
      let prepares = 0
      const order: string[] = []
      const planner = new Constructor<typeof globalThis.fetch>(() => {
        sends++
        if (origin === 'transport' && sends === 1) throw new TypeError('transport')
        return Promise.resolve(new Response('complete'))
      })
      const handle = planner.submit({
        method: 'GET',
        replay,
        prepare: ctx => {
          prepares++
          order.push(`prepare${prepares}`)
          ctx.onDispose(() => {
            order.push(`dispose${ctx.attemptNumber}`)
          })
          return { url: '', init: {} }
        },
        consume: async (response, ctx) => {
          await response.text()
          if (ctx.attemptNumber === 1) {
            ctx.onDiscard(() => {
              order.push('discard1')
            })
            throw ctx.retryableReadFailure(new TypeError('read'))
          }
          return 'complete'
        }
      })
      try {
        await runtime.flush()
        await runtime.advance(10)
        assert.equal(sends, 2, 'RETRY_DISPATCH_1_MUST_BECOME_2')
        assert.equal((await handle.result).value, 'complete')
        await handle.resourcesDone
        assert.equal(prepares, 2)
        assert.ok(order.indexOf('dispose1') < order.indexOf('prepare2'))
        if (origin === 'branded') assert.ok(order.indexOf('discard1') < order.indexOf('dispose1'))
      } finally {
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
  for (const origin of ['branded', 'transport', '429'] as const) {
    test(`Runtime undici ${origin} retry ${entry}`, async t => {
      const runtime = createRuntime(t)
      let sends = 0
      const planner = new Constructor<typeof UndiciFetch>(() => {
        sends++
        if (origin === 'transport' && sends === 1) throw new TypeError('transport')
        return Promise.resolve(
          new UndiciResponse('complete', { status: origin === '429' && sends === 1 ? 429 : 200 })
        )
      })
      const handle = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: '', init: {} }),
        consume: async (response, ctx) => {
          await response.text()
          if (ctx.attemptNumber === 1 && origin === 'branded')
            throw ctx.retryableReadFailure('read')
          return 'complete'
        }
      })
      try {
        await runtime.flush()
        await runtime.advance(origin === '429' ? 3601 : 10)
        assert.equal(sends, 2, 'UNDICI_RETRY_DISPATCH_1_MUST_BECOME_2')
        assert.equal((await handle.result).value, 'complete')
      } finally {
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
}

for (const mode of ['thenable', 'subclass', 'stateful'] as const) {
  test(`Runtime active branded ${mode} rejection is captured before guard closes`, async t => {
    const runtime = createRuntime(t)
    let sends = 0
    let expired: (() => Error) | undefined
    const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
      sends++
      return Promise.resolve(new Response())
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
        expired = () => ctx.retryableReadFailure('escaped')
        const rejectBrand = () => ctx.retryableReadFailure('active')
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
      await runtime.advance(10)
      assert.equal(sends, 2, 'ACTIVE_ASSIMILATION_BRAND_MUST_RETRY')
      assert.equal((await handle.result).value, 'complete')
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

for (const mode of [
  'unsafe',
  'failed-cleanup',
  'unknown-cleanup',
  'foreign-brand',
  'max-one',
  'non2xx'
] as const) {
  test(`Runtime ${mode} branded failure remains terminal with original HTTP facts`, async t => {
    const runtime = createRuntime(t)
    const cause = new Error('read cause')
    let sends = 0
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>()
    const planner = new FetchPlanner<typeof globalThis.fetch>(
      () => {
        sends++
        return Promise.resolve(
          new Response(mode === 'unknown-cleanup' ? body : null, {
            status: mode === 'non2xx' ? 412 : 200
          })
        )
      },
      { maxAttempts: mode === 'max-one' ? 1 : 3 }
    )
    let primary: Error | undefined
    const handle = planner.submit({
      method: 'POST',
      replay: mode === 'unsafe' ? { serverSafe: false, consumeSafe: true } : replay,
      prepare: ctx => {
        if (mode === 'failed-cleanup')
          ctx.onDispose(() => {
            throw new Error('dispose')
          })
        return { url: '', init: {} }
      },
      consume: (response, ctx) => {
        if (mode === 'unknown-cleanup') reader = response.body?.getReader()
        primary =
          mode === 'foreign-brand'
            ? new ConsumeReadFailure({ active: true }, cause)
            : ctx.retryableReadFailure(cause)
        throw primary
      }
    })
    try {
      await runtime.flush()
      await runtime.advance(10)
      await assert.rejects(
        handle.result,
        error =>
          error instanceof OperationError &&
          error.code === 'CONSUME_FAILED' &&
          error.status === (mode === 'non2xx' ? 412 : 200) &&
          error.dispatchEntered &&
          error.cause === primary &&
          error.phase === 'consuming'
      )
      await handle.resourcesDone
      assert.equal(sends, 1, 'TERMINAL_FAILURE_MUST_NOT_REPLAY')
    } finally {
      reader?.releaseLock()
      await body.cancel()
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Runtime safe429 dispatch count advances after clean release', async t => {
  const runtime = createRuntime(t)
  let sends = 0
  const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
    sends++
    return Promise.resolve(new Response(null, { status: sends === 1 ? 429 : 200 }))
  })
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: () => 'complete'
  })
  try {
    await runtime.flush()
    await runtime.advance(3601)
    assert.equal(sends, 2, 'SAFE429_DISPATCH_1_MUST_BECOME_2')
    assert.equal((await handle.result).value, 'complete')
  } finally {
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Runtime fresh streams and init preserve one logical payload through retry', async t => {
  const runtime = createRuntime(t)
  const streams: ReadableStream<Uint8Array>[] = []
  const inits: unknown[] = []
  const bodies: string[] = []
  const order: string[] = []
  const planner = new FetchPlanner<typeof globalThis.fetch>(async (_url, init) => {
    inits.push(init)
    bodies.push(await new Response(init?.body).text())
    return new Response()
  })
  const handle = planner.submit({
    method: 'POST',
    replay,
    prepare: ctx => {
      order.push(`prepare${ctx.attemptNumber}`)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('business-id:stable;payload:complete'))
          controller.close()
        }
      })
      streams.push(body)
      ctx.onDispose(() => {
        order.push(`dispose${ctx.attemptNumber}`)
      })
      return { url: '', init: { body } }
    },
    consume: (_response, ctx) => {
      if (ctx.attemptNumber === 1) throw ctx.retryableReadFailure('read')
      return 'complete'
    }
  })
  try {
    await runtime.flush()
    await runtime.advance(10)
    assert.equal((await handle.result).value, 'complete')
    await handle.resourcesDone
    assert.deepEqual(bodies, [
      'business-id:stable;payload:complete',
      'business-id:stable;payload:complete'
    ])
    assert.notEqual(streams[0], streams[1])
    assert.notEqual(inits[0], inits[1])
    assert.deepEqual(order, ['prepare1', 'dispose1', 'prepare2', 'dispose2'])
  } finally {
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})
