import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { runHookCompilerPhase } from '../helpers/hook-compiler.mjs'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '../..')
const scratch = path.join(root, '__temp/operation-types')
const registry = new Map([
  ['types', 'types.test.ts'],
  ['hook-types', 'hook-types.test.ts'],
  ['public', 'public.test.ts'],
  ['before-dispatch', 'before-dispatch.test.ts'],
  ['before-retry', 'before-retry.test.ts'],
  ['hooks-integration', 'hooks-integration.test.ts'],
  ['admission', 'admission.test.ts'],
  ['ownership', 'ownership.test.ts'],
  ['commit', 'commit.test.ts'],
  ['cancellation', 'cancellation.test.ts'],
  ['pacing', 'pacing.test.ts'],
  ['pacing-formula', 'pacing-formula.test.ts'],
  ['context', 'context.test.ts'],
  ['resources', 'resources.test.ts'],
  ['state', 'state.test.ts'],
  ['observation', 'observation.test.ts'],
  ['capacity', 'capacity.test.ts'],
  ['commands', 'commands.test.ts'],
  ['reentry', 'reentry.test.ts'],
  ['http-consume', 'http-consume.test.ts'],
  ['http-integration', 'http-integration.test.ts'],
  ['upload', 'upload.test.ts'],
  ['integration', 'integration.test.ts'],
  ['classifier', 'classifier.test.ts'],
  ['hints', 'hints.test.ts'],
  ['guard', 'guard.test.ts'],
  ['retry', 'retry.test.ts']
])
const compilers = /** @type {const} */ ([
  ['5.7.3', 'node_modules/.pnpm/typescript@5.7.3/node_modules/typescript/bin/tsc'],
  ['7.0.2', 'node_modules/typescript/bin/tsc']
])

/** @param {number} fd @param {string} text */
function writeDiagnostic(fd, text) {
  try {
    const bytes = Buffer.from(text)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written === 0) return
      offset += written
    }
  } catch {
    // Diagnostic I/O must not replace the original child failure.
  }
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} [env] @param {number} [timeout] */
function child(args, env, timeout = 30_000) {
  const started = performance.now()
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env
  })
  if (result.error) {
    writeDiagnostic(1, result.stdout)
    writeDiagnostic(2, result.stderr)
    try {
      /** @type {unknown} */
      const code = Reflect.get(result.error, 'code')
      writeDiagnostic(
        2,
        JSON.stringify({
          command: [process.execPath, ...args],
          cwd: root,
          elapsedMs: performance.now() - started,
          status: result.status,
          signal: result.signal,
          error: {
            name: result.error.name,
            message: result.error.message,
            code: typeof code === 'string' || typeof code === 'number' ? code : undefined
          }
        }) + '\n'
      )
    } catch {
      // Metadata preparation must not replace the original child failure either.
    }
  }
  assert.ifError(result.error)
  return result
}

/** @param {string} folder @returns {string[]} */
function inventory(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(folder, entry.name)
    if (entry.isDirectory()) return inventory(name)
    return entry.name.endsWith('.test.ts') ? [path.relative(directory, name)] : []
  })
}

const selector = process.argv[2] ?? 'all'
assert.equal(process.argv.length <= 3, true, 'Expected one suite selector')
const selected = selector === 'all' ? [...registry.keys()] : selector.split(',')
assert.ok(selected.length > 0, 'No suites selected')
for (const name of selected) {
  const file = registry.get(name)
  assert.ok(file, `Unknown operation suite: ${name}`)
  assert.ok(existsSync(path.join(directory, file)), `Missing selected suite: ${file}`)
}
if (selector === 'all') {
  const actual = inventory(directory).sort()
  const registered = [...registry.values()].sort()
  assert.deepEqual(actual, registered, 'Operation suite inventory must match the explicit registry')
}
const build = child(['node_modules/typescript/bin/tsc', '-p', 'test/operation/tsconfig.json'])
assert.equal(build.status, 0, build.stdout + build.stderr)

// Expected diagnostic positions are fixed assertions, never inferred from compiler output.
const expected = /** @type {const} */ ([
  [8, 60, 2322],
  [9, 49, 2322],
  [10, 56, 2322],
  [11, 56, 2322],
  [13, 14, 2322],
  [14, 69, 2322],
  [15, 79, 2820],
  [16, 14, 2322],
  [18, 8, 2339],
  [19, 24, 2339],
  [20, 19, 2540],
  [21, 80, 2322],
  [22, 110, 2339],
  [23, 22, 2345],
  [25, 22, 2345],
  [26, 160, 2353],
  [27, 44, 2322],
  [29, 9, 2540],
  [30, 23, 2339],
  [36, 10, 2540],
  [37, 11, 2540],
  [38, 7, 2540],
  [39, 11, 2540],
  [40, 11, 2540]
])

function types() {
  mkdirSync(scratch, { recursive: true })
  const fixtures = path.join(directory, 'type-fixtures')
  const names = ['contract', 'native', 'undici', 'final-hooks', 'negative']
  for (const name of names) {
    writeFileSync(
      path.join(scratch, `${name}.ts`),
      readFileSync(path.join(fixtures, `${name}.ts.txt`))
    )
  }
  const compilerOptions = {
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
  }
  /** @type {{version: string, name: string, command: string[], status: number | null, diagnostics: [string, number, number, number][]}[]} */
  const results = []
  /** @param {string} version @param {string} compiler @param {string} name @param {readonly (readonly [number, number, number])[]} diagnostics */
  function compile(version, compiler, name, diagnostics) {
    const config = path.join(scratch, `${name}.json`)
    writeFileSync(
      config,
      JSON.stringify({ compilerOptions, files: [`${name}.ts`] }, null, 2) + '\n'
    )
    const args = [compiler, '-p', config, '--pretty', 'false']
    const result = child(args)
    const raw = result.stdout + result.stderr
    writeFileSync(path.join(scratch, `${version}-${name}.log`), raw)
    /** @type {[string, number, number, number][]} */
    const actual = [...raw.matchAll(/^(.+?)\((\d+),(\d+)\): error TS(\d+):/gm)].map(match => [
      /** @type {RegExpMatchArray & {1: string}} */ (match)[1],
      Number(match[2]),
      Number(match[3]),
      Number(match[4])
    ])
    results.push({
      version,
      name,
      command: [process.execPath, ...args],
      status: result.status,
      diagnostics: actual
    })
    writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(results, null, 2) + '\n')
    assert.equal(result.status, diagnostics.length ? (version === '7.0.2' ? 1 : 2) : 0, raw)
    assert.deepEqual(
      actual,
      diagnostics.map(item => ['__temp/operation-types/negative.ts', ...item]),
      raw
    )
    // Include non-file/config diagnostics in the count so an unexpected error cannot hide.
    assert.equal((raw.match(/error TS\d+:/g) ?? []).length, diagnostics.length, raw)
    console.log(`PASS TS${version} ${name}: ${actual.length} exact diagnostics`)
  }
  // Both compiler/family positives must pass before any negative case is considered.
  for (const [version, compiler] of compilers) {
    const versionResult = child([compiler, '--version'])
    assert.equal(versionResult.status, 0, versionResult.stderr)
    assert.equal(versionResult.stdout.trim(), `Version ${version}`)
    for (const name of ['native', 'undici', 'final-hooks']) compile(version, compiler, name, [])
  }
  for (const [version, compiler] of compilers) compile(version, compiler, 'negative', expected)
}

function publicTypes() {
  mkdirSync(scratch, { recursive: true })
  const compilerOptions = {
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
  }
  const positives = []
  for (const module of ['index', 'planner']) {
    for (const family of ['native', 'undici']) {
      const name = `public-${module}-${family}`
      const source = readFileSync(
        path.join(directory, 'type-fixtures', `${family}.ts.txt`),
        'utf8'
      ).replace(
        "import { OperationPlanner } from './contract.js'",
        `import { FetchPlanner as OperationPlanner } from '../../src/${module}.js'`
      )
      writeFileSync(path.join(scratch, `${name}.ts`), source)
      positives.push(name)
    }
  }
  writeFileSync(
    path.join(scratch, 'public-removed.ts'),
    [
      "import * as root from '../../src/index.js'",
      'const planner = new root.FetchPlanner(globalThis.fetch)',
      "const handle = planner.submit({ method: 'GET', replay: { serverSafe: true, consumeSafe: true }, prepare: () => ({ url: '', init: {} }), consume: response => response.text() })",
      'void handle.result',
      'root.wrapFetch(globalThis.fetch)',
      'planner.getFetch()',
      "import type { Scheduled } from '../../src/fetch-types.js'",
      'export type Removed = Scheduled<typeof globalThis.fetch>',
      ''
    ].join('\n')
  )
  /** @param {string} name @param {string} compiler */
  function compile(name, compiler) {
    const config = path.join(scratch, `${name}.json`)
    writeFileSync(
      config,
      JSON.stringify({ compilerOptions, files: [`${name}.ts`] }, null, 2) + '\n'
    )
    const result = child([compiler, '-p', config, '--pretty', 'false'])
    writeFileSync(
      path.join(scratch, `${path.basename(path.dirname(path.dirname(compiler)))}-${name}.log`),
      result.stdout + result.stderr
    )
    return result
  }
  // Real root/deep submit positives run on both compilers before removed-API negatives.
  for (const [version, compiler] of compilers) {
    for (const name of positives) {
      const result = compile(name, compiler)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      console.log(`PASS TS${version} ${name}`)
    }
  }
  for (const [version, compiler] of compilers) {
    const result = compile('public-removed', compiler)
    const raw = result.stdout + result.stderr
    assert.equal(result.status, version === '7.0.2' ? 1 : 2, raw)
    const diagnostics = [...raw.matchAll(/\((\d+),(\d+)\): error TS(\d+):/g)].map(match => [
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    ])
    assert.deepEqual(
      diagnostics,
      [
        [5, 6, 2339],
        [6, 9, 2339],
        [7, 15, 2305]
      ],
      raw
    )
    assert.equal((raw.match(/error TS\d+:/g) ?? []).length, 3, raw)
    console.log(`PASS TS${version} removed public API: 3 exact diagnostics`)
  }
}

if (selected.includes('public')) publicTypes()
if (selected.includes('types')) types()
let receiptDirectory
let failed = false
try {
  let runtimeEnv
  if (selected.includes('hook-types')) {
    const nonce = randomBytes(32).toString('hex')
    const context = {
      canonicalRoot: realpathSync(root),
      selectedSelectors: selected,
      buildDirectory: realpathSync(path.join(root, '__temp/operation-build'))
    }
    receiptDirectory = mkdtempSync(path.join(root, '__temp/hook-phase-'))
    const file = path.join(receiptDirectory, 'receipt.json')
    const receipt = runHookCompilerPhase(context, nonce)
    writeFileSync(file, JSON.stringify(receipt), { flag: 'wx' })
    runtimeEnv = {
      ...process.env,
      FETCH_PLANNER_HOOK_PHASE_NONCE: nonce,
      FETCH_PLANNER_HOOK_PHASE_FILE: file,
      FETCH_PLANNER_HOOK_PHASE_CONTEXT: JSON.stringify(context)
    }
  }
  const runtime = child(
    [
      '--unhandled-rejections=strict',
      '--test',
      '--test-timeout=20000',
      ...selected.map(name => {
        const file = registry.get(name)
        assert.ok(file)
        return path.join('__temp/operation-build/test/operation', file.replace(/\.ts$/, '.js'))
      })
    ],
    runtimeEnv,
    120_000
  )
  writeDiagnostic(1, runtime.stdout)
  writeDiagnostic(2, runtime.stderr)
  assert.equal(runtime.status, 0, 'Operation runtime suites failed')
} catch (error) {
  failed = true
  throw error
} finally {
  if (receiptDirectory) removeReceipt(receiptDirectory, failed)
}

/** @param {string} folder @param {boolean} failed */
function removeReceipt(folder, failed) {
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch (error) {
    if (!failed) throw error
    writeDiagnostic(2, 'Hook receipt cleanup failed after primary failure\n')
  }
}
