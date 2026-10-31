import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CallbackContext } from '../../src/callback-context.js'
import { runHook } from '../../src/operation-hooks.js'
import { OperationError, type HookContext, type Snapshot } from '../../src/operation-types.js'
import { deferred } from './helpers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const compilers = [
  ['5.7.3', 'node_modules/.pnpm/typescript@5.7.3/node_modules/typescript/bin/tsc'],
  ['7.0.2', 'node_modules/typescript/bin/tsc']
] as const

const positive = `import type { HookContext, Snapshot, Decision, Hook, Spec } from '../../src/index.js'
import type { HookContext as DeepContext, Decision as DeepDecision, Hook as DeepHook } from '../../src/operation-types.js'
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Check<T extends true> = T
type ContextShape = { readonly snapshot: Snapshot; readonly signal: AbortSignal; readonly attemptNumber: number; readonly dispatchCalls: number; readonly status?: number }
type SnapshotShape = { readonly id: number; readonly sequence: number; readonly phase: Snapshot['phase']; readonly outcome: 'pending' | 'succeeded' | 'failed'; readonly resultCommitted: boolean; readonly resources: 'pending' | 'released' | 'failed' | 'unknown'; readonly failureCode?: Snapshot['failureCode']; readonly attempts: number; readonly dispatchCalls: number; readonly dispatchEntered: boolean; readonly status?: number }
type DecisionShape = { readonly type: 'allow' } | { readonly type: 'deny'; readonly code: 'POLICY_DENIED' } | { readonly type: 'defer'; readonly delayMs: number }
export type ContextContract = Check<Equal<HookContext, ContextShape>>
export type SnapshotContract = Check<Equal<Snapshot, SnapshotShape>>
export type DecisionContract = Check<Equal<Decision, DecisionShape>>
export type HookContract = Check<Equal<Hook, (context: HookContext) => Decision | Promise<Decision>>>
export type DeepContracts = [Check<Equal<DeepContext, HookContext>>, Check<Equal<DeepDecision, Decision>>, Check<Equal<DeepHook, Hook>>]
export type OptionalHooks = Check<Equal<Pick<Spec<{}, Response, number>, 'beforeDispatch' | 'beforeRetry'>, { beforeDispatch?: Hook; beforeRetry?: Hook }>>
// Numeric validity and freezing are runtime obligations, not branded type promises.
export const numericOnly: Decision[] = [{ type: 'defer', delayMs: NaN }, { type: 'defer', delayMs: 0 }, { type: 'defer', delayMs: Infinity }]
`

const negative = `import type { HookContext, Decision } from '../../src/index.js'
declare const ctx: HookContext
export const deny: Decision = { type: 'deny', code: 'OTHER' }
export const defer: Decision = { type: 'defer', delayMs: '1' }
ctx.onDispose(() => undefined)
ctx.onDiscard(() => undefined)
ctx.snapshot = ctx.snapshot
ctx.signal = new AbortController().signal
ctx.attemptNumber = 2
ctx.dispatchCalls = 2
ctx.status = 200
ctx.snapshot.phase = 'terminal'
ctx.snapshot.dispatchCalls = 1
void ctx.body
void ctx.headers
void ctx.transport
void ctx.policy
void ctx.snapshot.value
void ctx.snapshot.signal
export const allowExtra: Decision = { type: 'allow', delayMs: 1 }
`

// Literal locations/codes/count, fixed independently of either compiler's output.
const expected = [
  [3, 47, 2322],
  [4, 49, 2322],
  [5, 5, 2339],
  [6, 5, 2339],
  [7, 5, 2540],
  [8, 5, 2540],
  [9, 5, 2540],
  [10, 5, 2540],
  [11, 5, 2540],
  [12, 14, 2540],
  [13, 14, 2540],
  [14, 10, 2339],
  [15, 10, 2339],
  [16, 10, 2339],
  [17, 10, 2339],
  [18, 19, 2339],
  [19, 19, 2339],
  [20, 54, 2353]
]

test('Production hook contracts pass both compilers before exact negative diagnostics', () => {
  const scratch = mkdtempSync(path.join(root, '__temp/hook-types-'))
  try {
    writeFileSync(path.join(scratch, 'positive.ts'), positive)
    writeFileSync(path.join(scratch, 'negative.ts'), negative)
    writeFileSync(
      path.join(scratch, 'final-hooks.ts'),
      readFileSync(path.join(root, 'test/operation/type-fixtures/final-hooks.ts.txt'))
    )
    function compile(compiler: string, name: string) {
      const config = path.join(scratch, `${name}.json`)
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            lib: ['ES2023'],
            types: ['node'],
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: false
          },
          files: [`${name}.ts`]
        })
      )
      const result = spawnSync(process.execPath, [compiler, '-p', config, '--pretty', 'false'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
      })
      assert.ifError(result.error)
      assert.equal(result.signal, null)
      return { status: result.status, raw: result.stdout + result.stderr }
    }
    for (const [version, compiler] of compilers) {
      for (const name of ['positive', 'final-hooks']) {
        const result = compile(compiler, name)
        assert.equal(result.status, 0, result.raw)
        console.log(`PASS TS${version} hook ${name}`)
      }
    }
    for (const [version, compiler] of compilers) {
      const { status, raw } = compile(compiler, 'negative')
      assert.equal(status, version === '7.0.2' ? 1 : 2, raw)
      const actual = [...raw.matchAll(/^(.+?)\((\d+),(\d+)\): error TS(\d+):/gm)].map(match => [
        match[1],
        Number(match[2]),
        Number(match[3]),
        Number(match[4])
      ])
      const source = path.relative(root, path.join(scratch, 'negative.ts'))
      assert.deepEqual(
        actual,
        expected.map(item => [source, ...item]),
        raw
      )
      assert.equal((raw.match(/error TS\d+:/g) ?? []).length, expected.length, raw)
      console.log(`PASS TS${version} hook negative: ${expected.length} exact diagnostics`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// Helper proof only: actual coordinator hook sites are added by T82/T85.
function hookInput(status?: number) {
  const snapshot: Snapshot = {
    id: 17,
    sequence: 23,
    phase: 'ready',
    outcome: 'pending',
    resultCommitted: false,
    resources: 'pending',
    attempts: 2,
    dispatchCalls: 1,
    dispatchEntered: true,
    ...(status === undefined ? {} : { status })
  }
  return {
    snapshot,
    signal: new AbortController().signal,
    attemptNumber: 2,
    dispatchCalls: 1,
    ...(status === undefined ? {} : { status })
  }
}

function isHookFailure(error: unknown): error is OperationError {
  assert.ok(error instanceof OperationError)
  assert.equal(error.code, 'HOOK_FAILED')
  assert.equal(error.operationId, 17)
  assert.equal(error.attemptNumber, 2)
  assert.equal(error.dispatchEntered, true)
  assert.equal(error.phase, 'ready')
  return true
}

test('Hook primitive detaches and freezes the exact context and returns safe scalars', async () => {
  const owner = new CallbackContext()
  const base = hookInput(429)
  const input = {
    ...base,
    body: 'secret',
    snapshot: { ...base.snapshot, headers: 'secret', signal: base.signal }
  }
  let received: HookContext | undefined
  const gate = deferred<undefined>()
  const raw = { type: 'defer', delayMs: 5 }
  let now = 10
  const work = runHook(
    owner,
    async ctx => {
      received = ctx
      assert.equal(owner.isActive(), true)
      await gate.promise
      assert.equal(owner.isActive(), true)
      return raw
    },
    input,
    () => now
  )
  try {
    assert.ok(received)
    assert.notEqual(received, input)
    assert.notEqual(received.snapshot, input.snapshot)
    assert.equal(Object.isFrozen(received), true)
    assert.equal(Object.isFrozen(received.snapshot), true)
    assert.deepEqual(Object.keys(received).sort(), [
      'attemptNumber',
      'dispatchCalls',
      'signal',
      'snapshot',
      'status'
    ])
    assert.deepEqual(Object.keys(received.snapshot).sort(), [
      'attempts',
      'dispatchCalls',
      'dispatchEntered',
      'id',
      'outcome',
      'phase',
      'resources',
      'resultCommitted',
      'sequence',
      'status'
    ])
    assert.equal(received.signal, input.signal)
    assert.equal(Reflect.set(received.snapshot, 'status', 200), false)
    assert.equal(Reflect.set(received, 'attemptNumber', 9), false)
    input.snapshot.status = 503
    input.snapshot.phase = 'terminal'
    input.dispatchCalls = 99
    assert.equal(received.snapshot.status, 429)
    assert.equal(received.snapshot.phase, 'ready')
    assert.equal(received.dispatchCalls, 1)
    now = 30
    gate.resolve(undefined)
    const box = await work
    assert.deepEqual({ ...box.value }, { type: 'defer', delayMs: 5, notBefore: 35 })
    assert.equal(Object.isFrozen(box), true)
    assert.equal(Object.getPrototypeOf(box), null)
    assert.equal(Object.isFrozen(box.value), true)
    assert.equal(Object.getPrototypeOf(box.value), null)
    raw.delayMs = 99
    assert.equal(box.value.type, 'defer')
    assert.equal(box.value.delayMs, 5)
    assert.equal(await Promise.resolve(box), box)
  } finally {
    gate.resolve(undefined)
    await work
  }
})

test('Hook primitive accepts allow and only the controlled deny code', async () => {
  const owner = new CallbackContext()
  for (const decision of [{ type: 'allow' }, { type: 'deny', code: 'POLICY_DENIED' }]) {
    const box = await runHook(
      owner,
      ctx => {
        assert.equal('status' in ctx, false)
        assert.equal('status' in ctx.snapshot, false)
        return decision
      },
      hookInput(),
      () => 1
    )
    assert.deepEqual({ ...box.value }, decision)
  }
})

test('Hook primitive rejects malformed decisions and finite duration or absolute overflow violations', async () => {
  const owner = new CallbackContext()
  const invalid: unknown[] = [
    undefined,
    null,
    true,
    1,
    'allow',
    [],
    () => ({ type: 'allow' }),
    {},
    { type: 'other' },
    { type: 'deny' },
    { type: 'deny', code: 'OTHER' },
    { type: 'allow', delayMs: 1 },
    { type: 'deny', code: 'POLICY_DENIED', extra: 1 },
    { type: 'defer' },
    { type: 'defer', delayMs: '1' },
    { type: 'allow', [Symbol('extra')]: true },
    Object.defineProperty({ type: 'allow' }, 'hidden', { value: 1 }),
    Object.create({ type: 'allow' })
  ]
  for (const delayMs of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    -0,
    0,
    0.5,
    1.5,
    Number.MAX_SAFE_INTEGER + 1
  ])
    invalid.push({ type: 'defer', delayMs })
  for (const decision of invalid) {
    await assert.rejects(
      runHook(
        owner,
        () => decision,
        hookInput(),
        () => 1
      ),
      isHookFailure
    )
    assert.equal(owner.isActive(), false)
  }
  for (const now of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1
  ])
    await assert.rejects(
      runHook(
        owner,
        () => ({ type: 'defer', delayMs: 1 }),
        hookInput(),
        () => now
      ),
      isHookFailure
    )
  for (const [now, delayMs, expected] of [
    [0, 1, 1],
    [0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER - 1, 1, Number.MAX_SAFE_INTEGER]
  ] as const) {
    const result = await runHook(
      owner,
      () => ({ type: 'defer', delayMs }),
      hookInput(),
      () => now
    )
    assert.equal(result.value.type, 'defer')
    assert.equal(result.value.notBefore, expected)
  }
  for (const [now, delayMs] of [
    [0.25, Number.MAX_SAFE_INTEGER],
    [1.5, Number.MAX_SAFE_INTEGER - 1],
    [Number.MAX_VALUE, 1]
  ] as const) {
    await assert.rejects(
      runHook(
        owner,
        () => ({ type: 'defer', delayMs }),
        hookInput(),
        () => now
      ),
      isHookFailure
    )
  }
})

test('Hook defer accepts fractional monotonic timestamps with integer durations', async () => {
  const owner = new CallbackContext()
  for (const [now, delayMs] of [
    [0.5, 1],
    [100.25, 3],
    [0.001, 2]
  ] as const) {
    const result = await runHook(
      owner,
      () => ({ type: 'defer', delayMs }),
      hookInput(),
      () => now
    ).catch(() => assert.fail('FRACTIONAL_TIMESTAMP_MUST_ACCEPT'))
    assert.equal(result.value.type, 'defer')
    assert.equal(result.value.notBefore, now + delayMs)
    assert.equal(owner.isActive(), false)
  }
})

test('Hook async defer samples the real performance clock once during extraction', async () => {
  const owner = new CallbackContext()
  let sampled = NaN
  let samples = 0
  const result = await runHook(
    owner,
    async () => {
      await Promise.resolve()
      return { type: 'defer', delayMs: 1 }
    },
    hookInput(),
    () => {
      assert.equal(owner.isActive(), true)
      samples++
      sampled = performance.now()
      return sampled
    }
  ).catch(() => assert.fail('PERFORMANCE_TIMESTAMP_MUST_ACCEPT'))
  assert.equal(result.value.type, 'defer')
  assert.equal(result.value.notBefore, sampled + 1)
  assert.equal(samples, 1)
  assert.equal(owner.isActive(), false)
})

for (const property of ['type', 'code', 'delayMs', 'ownKeys', 'then', 'throw', 'reject']) {
  test(`Hook primitive maps ${property} failures to HOOK_FAILED with original cause`, async () => {
    const owner = new CallbackContext()
    const cause = new Error('private hook text')
    const decision = {
      type: property === 'code' ? 'deny' : 'defer',
      code: 'POLICY_DENIED',
      delayMs: 1
    }
    const callback = () => {
      if (property === 'throw') throw cause
      if (property === 'reject') return Promise.reject(cause)
      if (property === 'ownKeys')
        return new Proxy(
          {},
          {
            ownKeys() {
              assert.equal(owner.isActive(), true)
              throw cause
            }
          }
        )
      const raw =
        property === 'code'
          ? { type: 'deny', code: 'POLICY_DENIED' }
          : property === 'delayMs'
            ? { type: 'defer', delayMs: 1 }
            : decision
      return Object.defineProperty(raw, property, {
        get() {
          assert.equal(owner.isActive(), true)
          throw cause
        }
      })
    }
    await assert.rejects(
      runHook(owner, callback, hookInput(200), () => 10),
      error => {
        assert.ok(isHookFailure(error))
        assert.equal(error.cause, cause)
        assert.equal(error.status, 200)
        assert.equal(error.serverOutcome, 'http-response')
        assert.equal(error.message, 'HOOK_FAILED')
        return true
      }
    )
    assert.equal(owner.isActive(), false)
  })
}

for (const subclass of [false, true]) {
  test(`Hook primitive guards full assimilation and extraction with ${subclass ? 'Promise subclass' : 'thenable'}`, async () => {
    const owner = new CallbackContext()
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    const late = deferred<undefined>()
    const seen: string[] = []
    const submitProbe = () => (owner.isActive() ? 'REENTRANT_OPERATION' : 'accepted')
    const inspect = () => {
      seen.push(submitProbe())
    }
    let descendant = Promise.resolve('unset')
    const final = {
      get type() {
        inspect()
        return 'defer'
      },
      get delayMs() {
        inspect()
        return 3
      }
    }
    function chain(depth: number): unknown {
      return depth === 0
        ? final
        : {
            then(resolve: (value: unknown) => void) {
              inspect()
              resolve(chain(depth - 1))
            }
          }
    }
    let reads = 0
    const stateful = {
      get then() {
        inspect()
        if (++reads !== (subclass ? 3 : 2)) return undefined
        return (resolve: (value: unknown) => void) => {
          inspect()
          entered.resolve(undefined)
          descendant = late.promise.then(submitProbe)
          void gate.promise.then(() => {
            resolve(chain(12))
          })
        }
      }
    }
    class HookPromise extends Promise<unknown> {
      override then<A = unknown, B = never>(
        fulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
        rejected?: ((reason: unknown) => B | PromiseLike<B>) | null
      ): Promise<A | B> {
        inspect()
        return super.then(fulfilled, rejected)
      }
    }
    const callback = () =>
      subclass
        ? new HookPromise(resolve => {
            resolve(stateful)
          })
        : {
            then(resolve: (value: unknown) => void) {
              inspect()
              resolve(stateful)
            }
          }
    let settled = false
    const work = runHook(owner, callback, hookInput(), () => {
      inspect()
      return 10
    })
    void work.then(() => {
      settled = true
    })
    try {
      await entered.promise
      assert.equal(settled, false)
      assert.ok(seen.length > 0)
      assert.ok(seen.every(value => value === 'REENTRANT_OPERATION'))
      gate.resolve(undefined)
      const result = await work
      assert.deepEqual({ ...result.value }, { type: 'defer', delayMs: 3, notBefore: 13 })
      assert.ok(seen.length >= 17)
      assert.deepEqual(
        seen,
        Array<string>(seen.length).fill('REENTRANT_OPERATION'),
        'decision getters must retain REENTRANT_OPERATION through materialization'
      )
      late.resolve(undefined)
      assert.equal(await descendant, 'accepted')
    } finally {
      gate.resolve(undefined)
      late.resolve(undefined)
      await work
      await descendant
    }
  })
}
