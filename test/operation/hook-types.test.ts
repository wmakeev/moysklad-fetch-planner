import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
