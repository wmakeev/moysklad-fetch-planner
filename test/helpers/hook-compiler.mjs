import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'

/** @typedef {{canonicalRoot: string, selectedSelectors: string[], buildDirectory: string}} Context */
/** @typedef {{identity: string, version: string, compiler: string, status: number, signal: null, error: null, diagnostics: (string | number)[][], count: number}} Result */
/** @type {readonly (readonly [string, string])[]} */
const compilers = [
  ['5.7.3', 'node_modules/.pnpm/typescript@5.7.3/node_modules/typescript/bin/tsc'],
  ['7.0.2', 'node_modules/typescript/bin/tsc']
]

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

const sources = [
  'callback-context',
  'fetch-types',
  'guard',
  'index',
  'operation-capacity',
  'operation-hooks',
  'operation-observation',
  'operation-resources',
  'operation-state',
  'operation-types',
  'pacing',
  'planner',
  'response-classifier',
  'response-policy',
  'retry-policy',
  'runtime'
]

/** @param {Context} context */
function inputDigest(context) {
  const { canonicalRoot: root, buildDirectory: build } = context
  const files = [
    ...sources.map(name => `src/${name}.ts`),
    ...sources.map(name => path.relative(root, path.join(build, `src/${name}.js`))),
    'test/helpers/hook-compiler.mjs',
    'test/operation/hook-types.test.ts',
    path.relative(root, path.join(build, 'test/helpers/hook-compiler.mjs')),
    path.relative(root, path.join(build, 'test/operation/hook-types.test.js')),
    'test/operation/type-fixtures/final-hooks.ts.txt',
    'test/operation/run.mjs',
    'tsconfig.json',
    'test/operation/tsconfig.json',
    'package.json',
    ...compilers.flatMap(([, compiler]) => [
      compiler,
      path.join(path.dirname(compiler), '../package.json')
    ])
  ].sort()
  const hash = createHash('sha256')
  for (const file of files) {
    const bytes = readFileSync(path.join(root, file))
    hash.update(JSON.stringify([file, bytes.length]) + '\n')
    hash.update(bytes)
  }
  for (const [version, compiler] of compilers) {
    const manifest = object(
      JSON.parse(readFileSync(path.join(root, path.dirname(compiler), '../package.json'), 'utf8'))
    )
    assert.equal(manifest['version'], version, 'Hook compiler version mismatch')
  }
  return hash.digest('hex')
}

/** @param {number} fd @param {string} text */
function diagnostic(fd, text) {
  try {
    const bytes = Buffer.from(text)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written === 0) return
      offset += written
    }
  } catch {
    // Diagnostics never replace the original assertion or its cause.
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {string} scratch @param {boolean} failed */
function removeFixtures(scratch, failed) {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch (error) {
    if (!failed) throw error
    diagnostic(2, 'Hook fixture cleanup failed after primary failure\n')
  }
}

/** @param {Context} context @param {string} nonce */
export function runHookCompilerPhase(context, nonce) {
  const root = context.canonicalRoot
  const before = inputDigest(context)
  const scratch = mkdtempSync(path.join(root, '__temp/hook-types-'))
  /** @type {Result[]} */
  const results = []
  let failed = false
  try {
    writeFileSync(path.join(scratch, 'positive.ts'), positive)
    writeFileSync(path.join(scratch, 'negative.ts'), negative)
    writeFileSync(
      path.join(scratch, 'final-hooks.ts'),
      readFileSync(path.join(root, 'test/operation/type-fixtures/final-hooks.ts.txt'))
    )
    /** @param {string} version @param {string} compiler @param {string} name */
    function compile(version, compiler, name) {
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
      if (result.error) {
        diagnostic(1, result.stdout)
        diagnostic(2, result.stderr)
        try {
          diagnostic(
            2,
            JSON.stringify({
              compiler,
              name,
              status: result.status,
              signal: result.signal,
              error: {
                name: result.error.name,
                message: result.error.message,
                code: String(Reflect.get(result.error, 'code'))
              }
            }) + '\n'
          )
        } catch {
          // Metadata failures must preserve assert.ifError too.
        }
      }
      assert.ifError(result.error)
      assert.equal(result.signal, null)
      const raw = result.stdout + result.stderr
      const negativeJob = name === 'negative'
      const status = negativeJob ? (version === '7.0.2' ? 1 : 2) : 0
      assert.equal(result.status, status, raw)
      const actual = [...raw.matchAll(/^(.+?)\((\d+),(\d+)\): error TS(\d+):/gm)].map(match => [
        match[1],
        Number(match[2]),
        Number(match[3]),
        Number(match[4])
      ])
      const source = path.relative(root, path.join(scratch, 'negative.ts'))
      assert.deepEqual(actual, negativeJob ? expected.map(item => [source, ...item]) : [], raw)
      assert.equal(
        (raw.match(/error TS\d+:/g) ?? []).length,
        negativeJob ? expected.length : 0,
        raw
      )
      results.push({
        identity: `TS${version === '7.0.2' ? '7' : '5'}${name}`,
        version,
        compiler,
        status,
        signal: null,
        error: null,
        diagnostics: actual,
        count: negativeJob ? expected.length : 0
      })
      console.log(
        negativeJob
          ? `PASS TS${version} hook negative: ${expected.length} exact diagnostics`
          : `PASS TS${version} hook ${name}`
      )
    }
    for (const [version, compiler] of compilers) {
      for (const name of ['positive', 'final-hooks']) compile(version, compiler, name)
    }
    for (const [version, compiler] of compilers) compile(version, compiler, 'negative')
  } catch (error) {
    failed = true
    throw error
  } finally {
    removeFixtures(scratch, failed)
  }
  assert.equal(inputDigest(context), before, 'Hook compiler inputs changed during phase')
  return {
    schema: 1,
    nonce,
    context,
    digest: before,
    fixtureDirectory: path.relative(root, scratch),
    results
  }
}

/** @param {string} root @param {string} buildDirectory */
export function verifyHookCompilerReceipt(root, buildDirectory) {
  const nonce = process.env['FETCH_PLANNER_HOOK_PHASE_NONCE']
  const file = process.env['FETCH_PLANNER_HOOK_PHASE_FILE']
  const serialized = process.env['FETCH_PLANNER_HOOK_PHASE_CONTEXT']
  assert.ok(
    nonce && file && serialized,
    'Missing hook compiler receipt; use test/operation/run.mjs hook-types'
  )
  assert.match(nonce, /^[a-f0-9]{64}$/)
  const parsed = object(JSON.parse(serialized))
  assert.equal(parsed['canonicalRoot'], realpathSync(root))
  assert.equal(parsed['buildDirectory'], realpathSync(buildDirectory))
  const selectors = parsed['selectedSelectors']
  assert.ok(
    Array.isArray(selectors) &&
      selectors.every(item => typeof item === 'string') &&
      selectors.includes('hook-types')
  )
  /** @type {Context} */
  const context = {
    canonicalRoot: realpathSync(root),
    buildDirectory: realpathSync(buildDirectory),
    selectedSelectors: selectors
  }
  assert.deepEqual(parsed, context)
  assert.equal(path.dirname(path.dirname(file)), path.join(root, '__temp'))
  assert.match(path.basename(path.dirname(file)), /^hook-phase-[A-Za-z0-9]+$/)
  assert.equal(path.basename(file), 'receipt.json')
  assert.equal(realpathSync(file), file)
  const receipt = object(JSON.parse(readFileSync(file, 'utf8')))
  const fixtureDirectory = receipt['fixtureDirectory']
  assert.ok(typeof fixtureDirectory === 'string')
  assert.match(fixtureDirectory, /^__temp\/hook-types-[A-Za-z0-9]+$/)
  const source = path.join(fixtureDirectory, 'negative.ts')
  const rows = []
  for (const [version, compiler] of compilers) {
    for (const name of ['positive', 'final-hooks']) {
      rows.push({
        identity: `TS${version === '7.0.2' ? '7' : '5'}${name}`,
        version,
        compiler,
        status: 0,
        signal: null,
        error: null,
        diagnostics: [],
        count: 0
      })
    }
  }
  for (const [version, compiler] of compilers) {
    rows.push({
      identity: `TS${version === '7.0.2' ? '7' : '5'}negative`,
      version,
      compiler,
      status: version === '7.0.2' ? 1 : 2,
      signal: null,
      error: null,
      diagnostics: expected.map(item => [source, ...item]),
      count: expected.length
    })
  }
  assert.deepEqual(
    receipt,
    {
      schema: 1,
      nonce,
      context,
      digest: inputDigest(context),
      fixtureDirectory: fixtureDirectory,
      results: rows
    },
    'Hook compiler receipt must match this invocation and all six checked jobs'
  )
}
