import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'
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

for (const full of [false, true]) {
  test(`Retry reservation follows physical cleanup and FIFO with queue full ${full}`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const cleanup = deferred<undefined>()
    const disposing = deferred<undefined>()
    const owner = deferred<undefined>()
    const trace: string[] = []
    const planner = new FetchPlanner<typeof globalThis.fetch>(
      url => Promise.resolve(new Response(null, { status: url === 'retry' ? 429 : 200 })),
      { maxParallelLimit: 1, maxQueuedOperations: 2 }
    )
    const first = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        trace.push(`retry${ctx.attemptNumber}`)
        ctx.onDispose(async () => {
          disposing.resolve(undefined)
          await cleanup.promise
        })
        return { url: 'retry', init: {} }
      },
      consume: () => 'unexpected'
    })
    const handles = [first]
    void first.result.catch(() => undefined)
    const submit = (name: string) =>
      planner.submit({
        method: 'GET',
        replay,
        prepare: async () => {
          trace.push(name)
          await owner.promise
          return { url: name, init: {} }
        },
        consume: () => name
      })
    try {
      await disposing.promise
      handles.push(submit('older'))
      if (full) handles.push(submit('newer'))
      assert.equal(planner.snapshot().queued, full ? 2 : 1)
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 1)
      cleanup.resolve(undefined)
      await clock.flush()
      assert.equal(trace[1], 'older', 'OLDER_FIFO_PREPARES_BEFORE_RETRY')
      if (full) {
        await assert.rejects(first.result, { code: 'QUEUE_FULL' })
        await first.resourcesDone
        assert.equal(first.snapshot().attempts, 1)
      } else {
        assert.equal(first.snapshot().phase, 'retry-wait')
        assert.equal(planner.snapshot().queued, 1, 'RETRY_WAIT_RESERVES_Q_BEFORE_ELIGIBILITY')
        // One lease belongs to the gated sibling; the sleeping retry owns none.
        assert.equal(planner.snapshot().leasedAttempts, 1)
        assert.equal(planner.snapshot().sentActive, 0)
        await clock.advance(2999)
        assert.deepEqual(trace, ['retry1', 'older'], 'NO_PREPARE_BEFORE_NOT_BEFORE')
        handles.push(submit('newer'))
        await clock.advance(1)
        assert.equal(planner.snapshot().queued, 2)
      }
      const s = planner.snapshot()
      assert.ok(
        handles.filter(h => h.snapshot().resources === 'pending').length <=
          s.queued + s.leasedAttempts,
        'N_LE_Q_PLUS_L'
      )
      assert.ok(s.sentActive <= s.leasedAttempts && s.leasedAttempts <= 1)
      owner.resolve(undefined)
      await clock.flush()
      assert.deepEqual(
        trace.slice(0, 3),
        ['retry1', 'older', 'newer'],
        'ELIGIBLE_RETRY_JOINS_READY_FIFO_TAIL'
      )
      first.abort()
      await Promise.allSettled(handles.flatMap(h => [h.result, h.resourcesDone]))
      assert.deepEqual(
        [
          planner.snapshot().queued,
          planner.snapshot().leasedAttempts,
          planner.snapshot().sentActive
        ],
        [0, 0, 0]
      )
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
    } finally {
      cleanup.resolve(undefined)
      owner.resolve(undefined)
      handles.forEach(h => {
        h.abort()
      })
      await Promise.allSettled(handles.flatMap(h => [h.result, h.resourcesDone]))
    }
  })
}

for (const interrupt of ['stop', 'abort', 'deadline'] as const) {
  test(`Retry wait ${interrupt} clears reservation once without another attempt`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    let sends = 0
    let prepares = 0
    let settles = 0
    let releases = 0
    const planner = new DeepFetchPlanner<typeof globalThis.fetch>(
      () => {
        sends++
        return Promise.resolve(new Response(null, { status: 429 }))
      },
      { maxParallelLimit: 1, maxQueuedOperations: 1, deadlineMs: 4000 }
    )
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: () => {
        prepares++
        return { url: '', init: {} }
      },
      consume: () => 0
    })
    void handle.result.catch(() => undefined)
    handle.observe(e => {
      if (e.type === 'operation-settled') settles++
      if (e.type === 'resources-settled') releases++
    })
    try {
      await clock.flush()
      assert.equal(handle.snapshot().phase, 'retry-wait')
      assert.equal(handle.snapshot().dispatchEntered, true, 'HISTORY_IS_NOT_CURRENT_SENT')
      assert.deepEqual(
        [
          planner.snapshot().queued,
          planner.snapshot().leasedAttempts,
          planner.snapshot().sentActive
        ],
        [1, 0, 0],
        'SLEEP_OWNS_ONLY_RESERVATION'
      )
      const reason = new Error('first reason')
      if (interrupt === 'deadline') {
        // Move the monotonic clock without delivering the scheduled retry timer.
        t.mock.method(performance, 'now', () => 1_004_000)
        timers.callbacks.at(-1)?.()
      } else
        for (let i = 0; i < 100; i++) {
          if (interrupt === 'stop') planner.stop(i === 0 ? reason : i)
          else handle.abort(i === 0 ? reason : i)
        }
      assert.equal(
        handle.snapshot().failureCode,
        interrupt === 'stop' ? 'STOPPED' : interrupt === 'abort' ? 'ABORTED' : 'DEADLINE',
        'STOP_OR_ABORT_RETRY_WAIT_TERMINATES_SYNCHRONOUSLY'
      )
      await assert.rejects(
        handle.result,
        error =>
          error instanceof OperationError &&
          error.code ===
            (interrupt === 'stop' ? 'STOPPED' : interrupt === 'abort' ? 'ABORTED' : 'DEADLINE') &&
          (interrupt === 'deadline' || error.cause === reason)
      )
      await handle.resourcesDone
      await clock.advance(10_000)
      for (const callback of timers.callbacks.slice()) callback()
      await clock.flush()
      assert.deepEqual(
        [prepares, sends, settles, releases],
        [1, 1, 1, 1],
        'NO_RETRY_AFTER_TERMINAL'
      )
      assert.equal(planner.snapshot().queued, 0)
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
    } finally {
      handle.abort()
      planner.stop()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Retry observer burst reserves before spec access and completes full fanout', async t => {
  const clock = createRuntime(t)
  const seenA: number[] = []
  const seenB: number[] = []
  const handles: ReturnType<FetchPlanner<typeof globalThis.fetch>['submit']>[] = []
  const measurements: number[][] = []
  let copies = 0
  let once = false
  const planner = new FetchPlanner<typeof globalThis.fetch>(
    () => Promise.resolve(new Response(null, { status: 429 })),
    { maxParallelLimit: 1, maxQueuedOperations: 2 }
  )
  planner.observe(e => {
    seenA.push(e.sequence)
    if (e.type !== 'retry-scheduled' || once) return
    once = true
    for (let i = 0; i < 100; i++) {
      handles.push(
        planner.submit({
          get method(): 'GET' {
            copies++
            return 'GET'
          },
          replay,
          prepare: () => ({ url: '', init: {} }),
          consume: () => 0
        })
      )
    }
    measurements.push([planner.snapshot().queued, copies, handles.filter(h => h.id !== 0).length])
    for (let i = 0; i < 100; i++) planner.stop('first')
  })
  planner.observe(e => {
    seenB.push(e.sequence)
  })
  const root = planner.submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: () => 0
  })
  try {
    await clock.flush()
    await Promise.allSettled([root, ...handles].flatMap(h => [h.result, h.resourcesDone]))
    assert.deepEqual(measurements, [[2, 1, 1]], 'RETRY_RESERVATION_BOUNDS_OBSERVER_SPEC_RETENTION')
    assert.equal(handles.filter(h => h.snapshot().failureCode === 'QUEUE_FULL').length, 99)
    assert.equal(
      root.snapshot().failureCode,
      'STOPPED',
      'STOP_USES_CURRENT_ATTEMPT_NOT_DISPATCH_HISTORY'
    )
    assert.deepEqual(seenA, seenB, 'RETRY_FULL_FANOUT_BEFORE_COMMANDS')
    assert.deepEqual(
      [planner.snapshot().queued, planner.snapshot().leasedAttempts, planner.snapshot().sentActive],
      [0, 0, 0]
    )
  } finally {
    planner.stop()
    root.abort()
    handles.forEach(h => {
      h.abort()
    })
    await Promise.allSettled([root, ...handles].flatMap(h => [h.result, h.resourcesDone]))
  }
})

for (const status of [200, 429]) {
  test(`Stop sent POST status ${status} keeps current work and prohibits retries`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    const receipt = deferred<Response>()
    const cancel = deferred<undefined>()
    const disposing = deferred<undefined>()
    const cleanup = deferred<undefined>()
    let signal: AbortSignal | undefined
    let sends = 0
    const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
      sends++
      return receipt.promise
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        signal = ctx.signal
        ctx.onDispose(async () => {
          disposing.resolve(undefined)
          await cleanup.promise
        })
        return { url: '', init: {} }
      },
      consume: () => 'complete'
    })
    void handle.result.catch(() => undefined)
    try {
      await clock.flush()
      receipt.resolve(
        new Response(
          status === 429 ? new ReadableStream<Uint8Array>({ cancel: () => cancel.promise }) : null,
          { status, headers: { 'content-type': 'application/json' } }
        )
      )
      await clock.flush()
      if (status === 429) assert.equal(handle.snapshot().phase, 'classifying')
      planner.stop('first')
      planner.stop('ignored')
      assert.equal(signal?.aborted, false)
      if (status === 429) await clock.advance(250)
      await disposing.promise
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 1)
      cleanup.resolve(undefined)
      cancel.resolve(undefined)
      if (status === 429) await assert.rejects(handle.result, { code: 'STOPPED', cause: 'first' })
      else assert.equal((await handle.result).value, 'complete')
      await handle.resourcesDone
      await clock.advance(10_000)
      assert.equal(sends, 1)
      assert.equal(handle.snapshot().attempts, 1)
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
    } finally {
      receipt.resolve(new Response())
      cancel.resolve(undefined)
      cleanup.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Retry finite strict child preserves real admission deadline and exits naturally', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import {FetchPlanner} from ${JSON.stringify(new URL('../../src/index.js', import.meta.url).href)};
const watchdog=setTimeout(()=>{throw new Error('retry child leaked')},2000);
let release; const gate=new Promise(r=>{release=r}); let attempts=0,sends=0;
const start=performance.now();
const p=new FetchPlanner(()=>{sends++;throw new TypeError('transport')},{deadlineMs:80,attemptTimeoutMs:1000});
const h=p.submit({method:'POST',replay:{serverSafe:true,consumeSafe:true},prepare:async()=>{
 attempts++; if(attempts===2)await gate;return {url:'',init:{}};
},consume:()=>0});
try{
 await assert.rejects(h.result,{code:'DEADLINE'});
 assert.equal(attempts,2);assert.equal(sends,1);assert.equal(p.snapshot().leasedAttempts,1);
 assert.ok(performance.now()-start>=70,'REAL_DEADLINE_NOT_EARLY');
 release();await h.resourcesDone;
 assert.deepEqual([p.snapshot().queued,p.snapshot().leasedAttempts,p.snapshot().sentActive],[0,0,0]);
 console.log('PASS retry real deadline, natural exit');
}finally{release();h.abort();await Promise.allSettled([h.result,h.resourcesDone]);clearTimeout(watchdog)}
`
    ],
    { encoding: 'utf8', timeout: 5000 }
  )
  assert.ifError(child.error)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.match(child.stdout, /PASS retry real deadline, natural exit/)
})

test('Retry default budget exhausts at three preparations without resetting deadline', async t => {
  const clock = createRuntime(t)
  let sends = 0
  let prepares = 0
  const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
    sends++
    throw new TypeError('transport')
  })
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => {
      prepares++
      return { url: '', init: {} }
    },
    consume: () => 0
  })
  void handle.result.catch(() => undefined)
  try {
    await clock.flush()
    await clock.advance(1)
    await clock.advance(1)
    await assert.rejects(handle.result, { code: 'TRANSPORT_FAILED', attemptNumber: 3 })
    await handle.resourcesDone
    await clock.advance(10_000)
    assert.deepEqual([prepares, sends], [3, 3])
  } finally {
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Retry eligibility wakes prepare but final safety recheck still rejects expired work', async t => {
  const clock = createRuntime(t)
  const timers = trackTimeouts(t)
  const prepare = deferred<undefined>()
  let sends = 0
  let prepares = 0
  const planner = new FetchPlanner<typeof globalThis.fetch>(
    () => {
      sends++
      throw new TypeError('transport')
    },
    { deadlineMs: 100 }
  )
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: async () => {
      prepares++
      if (prepares === 2) await prepare.promise
      return { url: '', init: {} }
    },
    consume: () => 0
  })
  void handle.result.catch(() => undefined)
  try {
    await clock.flush()
    await clock.advance(1)
    assert.equal(prepares, 2)
    // The deadline expires while the retry's preparation owns a lease. Deliver no timer.
    t.mock.method(performance, 'now', () => 1_000_100)
    prepare.resolve(undefined)
    await clock.flush()
    await assert.rejects(handle.result, { code: 'DEADLINE' })
    await handle.resourcesDone
    assert.equal(sends, 1, 'RETRY_WAIT_IS_NOT_DISPATCH_PERMIT')
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(timers.active.size, 0)
  } finally {
    prepare.resolve(undefined)
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})

test('Retry finite collector bounds active specs and coalesced commands before observer drain', () => {
  const source = readFileSync(new URL('../../src/planner.js', import.meta.url), 'utf8')
  const fixture = new URL('../../src/planner-t69-collector.js', import.meta.url)
  const anchor = '    snapshot() {'
  assert.equal(source.split(anchor).length, 2, 'EXACT_COLLECTOR_ANCHOR')
  const instrumented = source.replace(
    anchor,
    `    t69() { return {active:this.#active.size, commands:this.commands.length, ...this.#capacity.snapshot(), diagnostics:this.observation.diagnostics.snapshot()}; }\n${anchor}`
  )
  try {
    writeFileSync(fixture, instrumented)
    const child = spawnSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {FetchPlanner} from ${JSON.stringify(fixture.href)};
const handles=[], samples=[],a=[],b=[];let copies=0,prepares=0,once=false;
const p=new FetchPlanner(()=>Promise.resolve(new Response(null,{status:429})),{maxParallelLimit:1,maxQueuedOperations:2});
const spec=()=>({get method(){copies++;return 'POST'},replay:{serverSafe:true,consumeSafe:true},prepare:()=>{prepares++;return {url:'',init:{}}},consume:()=>0});
p.observe(e=>{a.push(e.sequence);if(e.type==='retry-scheduled'&&!once){once=true;
 samples.push(p.t69());
 for(let i=0;i<1000;i++)handles.push(p.submit(spec()));
 samples.push(p.t69());
 for(let i=0;i<1000;i++){p.stop('first');root.abort('abort-first')}
 samples.push(p.t69());
}});
p.observe(e=>b.push(e.sequence));
const root=p.submit(spec());
try{
 await setImmediate();
 assert.equal(once,true);
 assert.deepEqual(samples.map(s=>[s.active,s.queued,s.leasedAttempts,s.sentActive,s.commands]),[[1,1,0,0,0],[2,2,0,0,1],[2,2,0,0,3]],'RETRY_ACTIVE_SPEC_COMMAND_BOUNDS');
 assert.equal(copies,2,'NO_RETAINED_REJECTED_SPEC_ACCESS');
 assert.equal(handles.filter(h=>h.id===0).length,999);
 await Promise.allSettled([root,...handles].flatMap(h=>[h.result,h.resourcesDone]));
 assert.deepEqual(a,b,'FULL_FANOUT');assert.equal(prepares,1);
 const final=p.t69();assert.deepEqual([final.active,final.queued,final.leasedAttempts,final.sentActive,final.commands],[0,0,0,0,0]);
 assert.equal(final.diagnostics.OBSERVER_FAILED,0);
 console.log(JSON.stringify({samples,final,copies,prepares}));
}finally{p.stop();root.abort();for(const h of handles)h.abort();await Promise.allSettled([root,...handles].flatMap(h=>[h.result,h.resourcesDone]))}
let release,entered;
const cleanup=new Promise(r=>{release=r}),disposing=new Promise(r=>{entered=r});
const full=new FetchPlanner(()=>Promise.resolve(new Response(null,{status:429})),{maxParallelLimit:1,maxQueuedOperations:1});
const retry=full.submit({...spec(),prepare:ctx=>{ctx.onDispose(()=>{entered();return cleanup});return {url:'',init:{}}}});
void retry.result.catch(()=>{});
let queued;
try{
 await disposing;
 queued=full.submit({...spec(),replay:{serverSafe:false,consumeSafe:false}});
 release();await assert.rejects(retry.result,{code:'QUEUE_FULL'});await retry.resourcesDone;
 await Promise.allSettled([queued.result,queued.resourcesDone]);
 const final=full.t69();
 assert.deepEqual([final.active,final.queued,final.leasedAttempts,final.sentActive,final.commands],[0,0,0,0,0],'FULL_RETRY_RETAINS_NO_SPEC_OR_BACKLOG');
 console.log('QUEUE_FULL_COLLECTOR',JSON.stringify(final));
}finally{release();full.stop();retry.abort();queued?.abort();await Promise.allSettled([retry.result,retry.resourcesDone,queued?.result,queued?.resourcesDone])}
`
      ],
      { encoding: 'utf8', timeout: 5000 }
    )
    assert.ifError(child.error)
    assert.equal(child.signal, null)
    assert.equal(child.status, 0, child.stdout + child.stderr)
    console.log('T69_COLLECTOR', child.stdout.trim())
  } finally {
    unlinkSync(fixture)
  }
})

for (const zeroHints of [false, true]) {
  test(`Retry actual 429 positive fallback and ordinal persist with zero hints ${zeroHints}`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    let sends = 0
    let prepares = 0
    const planner = new FetchPlanner<typeof globalThis.fetch>(() => {
      sends++
      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: zeroHints
            ? { 'x-lognex-retry-after': '0', 'x-lognex-reset': '0', 'retry-after': '0' }
            : {}
        })
      )
    })
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        prepares++
        return { url: '', init: {} }
      },
      consume: () => 0
    })
    void handle.result.catch(() => undefined)
    try {
      await clock.flush()
      assert.equal(handle.snapshot().phase, 'retry-wait')
      const stale = timers.callbacks.at(-1)
      await clock.advance(2999)
      stale?.()
      await clock.flush()
      assert.equal(sends, 1, 'STALE_WAKE_CANNOT_SHORTEN_FALLBACK')
      assert.equal(planner.snapshot().leasedAttempts, 0)
      await clock.advance(1)
      assert.equal(sends, 2)
      assert.equal(handle.snapshot().phase, 'retry-wait')
      await clock.advance(5999)
      assert.equal(sends, 2, 'SECOND_429_ORDINAL_NOT_RESET')
      await clock.advance(1)
      await assert.rejects(handle.result, { code: 'HTTP_FAILED', attemptNumber: 3 })
      await handle.resourcesDone
      assert.deepEqual([prepares, sends], [3, 3])
      assert.equal(timers.active.size, 0)
      assert.ok(timers.maximum() <= 1)
      assert.ok(timers.delays.every(delay => delay >= 0 && delay <= 2_147_483_647))
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Retry PUT attempts charge the same entity guard without globally stopping another key', async t => {
  const clock = createRuntime(t)
  let sends = 0
  const planner = new FetchPlanner<typeof globalThis.fetch>(
    url => {
      sends++
      if (url === 'first') throw new TypeError('transport')
      return Promise.resolve(new Response())
    },
    { entityPutPerMinuteLimit: 2 }
  )
  const submit = (entityKey: string) =>
    planner.submit({
      method: 'PUT',
      entityKey,
      replay,
      prepare: () => ({ url: entityKey, init: {} }),
      consume: () => 'complete'
    })
  const handle = submit('first')
  void handle.result.catch(() => undefined)
  try {
    await clock.flush()
    await clock.advance(1)
    await clock.advance(1)
    await assert.rejects(handle.result, { code: 'PUT_LIMIT', attemptNumber: 3 })
    await handle.resourcesDone
    assert.equal(sends, 2, 'EACH_RETRY_CHARGES_ENTITY_PUT')
    assert.equal(planner.snapshot().stopped, false)
    const sibling = submit('second')
    try {
      assert.equal((await sibling.result).value, 'complete')
      await sibling.resourcesDone
    } finally {
      sibling.abort()
      await Promise.allSettled([sibling.result, sibling.resourcesDone])
    }
    assert.equal(sends, 3)
  } finally {
    handle.abort()
    await Promise.allSettled([handle.result, handle.resourcesDone])
  }
})
