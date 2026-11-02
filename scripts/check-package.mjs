/// <reference types="node" />

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixtures = path.join(root, 'test/package/fixtures')
const manifest = /** @type {typeof import('../package.json')} */ (
  JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
)
const packCases = ['pnpm-absent', 'pnpm-stale', 'npm-absent', 'npm-stale']
const nodeVersions = ['24.0.0', '24.22.2', '26.13.0']
const typeJobs = ['bare/ts5', 'bare/ts7', 'undici/ts5', 'undici/ts7']
const cli = parseCLI(process.argv.slice(2))

/** @typedef {{phase: string, state?: string, family?: string, compiler?: string, node?: string, packCase?: string}} CLI */
/** @param {string[]} args @returns {CLI} */
function parseCLI(args) {
  if (!args.length) return { phase: 'default' }
  if (args.length === 2 && args[0] === '--phase' && args[1] === 'fixture-types')
    return { phase: 'fixture-types' }
  /** @type {Map<string, string>} */
  const options = new Map()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    assert.ok(
      key &&
        ['--phase', '--state', '--family', '--compiler', '--node', '--pack-case'].includes(key),
      'Unknown option'
    )
    assert.ok(value && !value.startsWith('--') && !options.has(key), 'Missing or duplicate option')
    options.set(key, value)
  }
  const phase = options.get('--phase')
  assert.ok(phase)
  assert.ok(['readiness', 'pack', 'types', 'runtime', 'finish'].includes(phase), 'Unknown phase')
  const state = options.get('--state')
  assert.ok(
    state && path.isAbsolute(state) && state.endsWith('.json'),
    'State must be absolute JSON path'
  )
  const allowed = [
    '--phase',
    '--state',
    ...(phase === 'pack'
      ? ['--pack-case']
      : phase === 'types'
        ? ['--family', '--compiler']
        : phase === 'runtime'
          ? ['--node']
          : [])
  ]
  assert.deepEqual([...options.keys()].sort(), allowed.sort(), 'Missing or incompatible options')
  const family = options.get('--family')
  const compiler = options.get('--compiler')
  const node = options.get('--node')
  const packCase = options.get('--pack-case')
  if (phase === 'types') {
    assert.ok(family && ['bare', 'undici'].includes(family), 'Unknown family')
    assert.ok(compiler && ['ts5', 'ts7'].includes(compiler), 'Unknown compiler')
  }
  if (phase === 'runtime')
    assert.ok(node && path.isAbsolute(node), 'Node must be absolute binary path')
  if (phase === 'pack') assert.ok(packCase && packCases.includes(packCase), 'Unknown pack case')
  return { phase, state, family, compiler, node, packCase }
}

/** @type {readonly string[]} */
const positiveFixtures = [
  'without-undici',
  'native',
  'custom',
  'subclass',
  'events',
  'events-bytes',
  'with-undici'
]
/** @type {readonly string[]} */
const negativeFixtures = [
  'events-negative',
  'events-overload-annotation',
  'negative-body',
  'negative-callable-property',
  'negative-constructor',
  'negative-event-method',
  'negative-event',
  'negative-input-transport',
  'negative-method',
  'negative-planner-body',
  'negative-planner-method',
  'negative-transport',
  'negative-undici-body',
  'negative-undici-bytes',
  'negative-undici-method',
  'negative-union-input'
]
/** @typedef {[number, number, number | [number, number]]} ExpectedDiagnostic */
/** @typedef {Record<string, ExpectedDiagnostic[]>} DiagnosticMatrix */

async function diagnosticMatrix() {
  const expected = /** @type {DiagnosticMatrix} */ (
    JSON.parse(await readFile(path.join(fixtures, 'diagnostics.json'), 'utf8'))
  )
  assert.deepEqual(
    Object.keys(expected).sort(),
    [...negativeFixtures].sort(),
    'Diagnostic inventory'
  )
  assert.deepEqual(
    (await readdir(fixtures)).filter(name => name.endsWith('.ts.txt')).sort(),
    negativeFixtures.map(name => `${name}.ts.txt`).sort(),
    'Negative source inventory'
  )
  for (const rows of Object.values(expected)) {
    assert.ok(Array.isArray(rows) && rows.length > 0, 'Empty diagnostic case')
    for (const row of rows) {
      assert.ok(Array.isArray(row), 'Malformed diagnostic tuple')
      assert.equal(row.length, 3, 'Malformed diagnostic tuple')
      const [line, column, code] = row
      assert.ok(Number.isSafeInteger(line) && line > 0)
      assert.ok(Number.isSafeInteger(column) && column > 0)
      const codes = Array.isArray(code) ? code : [code]
      if (Array.isArray(code)) assert.equal(code.length, 2)
      assert.ok(codes.every(value => Number.isSafeInteger(value) && value > 0))
    }
  }
  return expected
}

/** @param {string} output @param {DiagnosticMatrix} expected @param {readonly string[]} names @param {string} compiler @param {string} [prefix] */
function exactDiagnostics(output, expected, names, compiler, prefix = '') {
  const actual = output
    .split(/\r?\n/)
    .filter(line => line.includes('error TS'))
    .map(line => {
      const match = /^([^()]+)\((\d+),(\d+)\): error TS(\d+):/.exec(line)
      assert.ok(match, `Malformed or non-file diagnostic: ${line}`)
      const [, file, lineNumber, column, code] = match
      assert.ok(file && lineNumber && column && code, line)
      return [file, Number(lineNumber), Number(column), Number(code)]
    })
  const wanted = names.flatMap(name => {
    const rows = expected[name]
    assert.ok(rows, `Missing diagnostic case ${name}`)
    return rows.map(([line, column, code]) => [
      `${prefix}${name}.ts`,
      line,
      column,
      Array.isArray(code) ? code[compiler === 'ts5' ? 0 : 1] : code
    ])
  })
  const compare = (/** @type {unknown} */ a, /** @type {unknown} */ b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  assert.deepEqual(
    actual.sort(compare),
    wanted.sort(compare),
    'Exact negative diagnostic file/line/column/code/count matrix'
  )
}

/** @param {string} command @param {string[]} args @param {string} cwd @param {number} expected @param {number} timeout */
function run(command, args, cwd, expected = 0, timeout = 240_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, NODE_PATH: '' },
    maxBuffer: 8 * 1024 * 1024
  })
  const output = `${result.stdout}${result.stderr}`
  if (result.error) {
    try {
      console.error(output)
    } catch {
      // Diagnostic IO must never replace the primary child-process failure.
    }
  }
  assert.ifError(result.error)
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${output}`)
  return output
}

/** @param {string} directory @param {boolean} failed */
async function cleanupFixtureWorkspace(directory, failed) {
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (!failed) throw error
    try {
      console.error('Fixture workspace cleanup failed', error)
    } catch {
      // Preserve the original compiler/assertion failure even if diagnostic IO fails.
    }
  }
}

async function fixtureTypes() {
  const expected = await diagnosticMatrix()
  const require = createRequire(path.join(root, 'package.json'))
  /** @type {readonly (readonly [string, string, string])[]} */
  const compilers = [
    ['ts5', '5.7.3', 'node_modules/.pnpm/typescript@5.7.3/node_modules/typescript'],
    ['ts7', '7.0.2', 'node_modules/typescript']
  ]
  for (const [, version, location] of compilers) {
    const installed = /** @type {{version: string}} */ (require(`${root}${location}/package.json`))
    assert.equal(installed.version, version, 'Exact local compiler version')
  }
  assert.equal(
    /** @type {{version: string}} */ (require('@types/node/package.json')).version,
    '24.19.2'
  )
  assert.equal(/** @type {{version: string}} */ (require('undici/package.json')).version, '7.30.1')
  assert.equal(
    /** @type {{version: string}} */ (require('undici-types/package.json')).version,
    '7.3.0'
  )
  const parent = path.join(root, '__temp')
  await mkdir(parent, { recursive: true })
  const workspace = await mkdtemp(path.join(parent, 'package-fixture-types-'))
  let failed = false
  try {
    const directory = path.join(workspace, 'test/package/fixtures')
    await mkdir(directory, { recursive: true })
    await symlink(path.join(root, 'src'), path.join(workspace, 'src'), 'dir')
    await symlink(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'dir')
    await writeFile(path.join(workspace, 'package.json'), '{"private":true,"type":"module"}\n')
    for (const name of positiveFixtures) {
      await writeFile(
        path.join(directory, `${name}.ts`),
        await readFile(path.join(fixtures, `${name}.ts`))
      )
    }
    const config = {
      extends: path.join(root, 'tsconfig.json'),
      compilerOptions: { noEmit: true },
      files: positiveFixtures.map(name => `test/package/fixtures/${name}.ts`),
      include: []
    }
    await writeFile(path.join(workspace, 'positive.json'), JSON.stringify(config))
    for (const [compiler, version, location] of compilers) {
      run(
        process.execPath,
        [path.join(root, location, 'bin/tsc'), '-p', 'positive.json', '--pretty', 'false'],
        workspace,
        0,
        30_000
      )
      console.log(`fixture-types: TS ${version} ${compiler} all seven positives passed`)
    }
    // No negative source is materialized or compiled until BOTH actual positive matrices pass.
    for (const name of negativeFixtures) {
      await writeFile(
        path.join(directory, `${name}.ts`),
        await readFile(path.join(fixtures, `${name}.ts.txt`))
      )
    }
    await writeFile(
      path.join(workspace, 'negative.json'),
      JSON.stringify({
        ...config,
        files: negativeFixtures.map(name => `test/package/fixtures/${name}.ts`)
      })
    )
    for (const [compiler, version, location] of compilers) {
      const output = run(
        process.execPath,
        [path.join(root, location, 'bin/tsc'), '-p', 'negative.json', '--pretty', 'false'],
        workspace,
        compiler === 'ts5' ? 2 : 1,
        30_000
      )
      console.log(output.trim())
      exactDiagnostics(output, expected, negativeFixtures, compiler, 'test/package/fixtures/')
      console.log(`fixture-types: TS ${version} all sixteen exact negative fixtures passed`)
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    await cleanupFixtureWorkspace(workspace, failed)
  }
}

/** @typedef {{path: string, sha256: string}} Artifact */
/** @typedef {{schema: 1, statePath: string, root: string, workspace: string, nonce: string, sourceDigest: string, tooling: ReturnType<typeof tooling>, readiness: boolean, candidates: Record<string, Artifact>, artifact?: Artifact, types: string[], runtime: string[], finished: boolean}} State */
const snapshotInputs = [
  'src',
  'package.json',
  'README.md',
  'LICENSE',
  '.npmignore',
  'tsconfig.json',
  'tsconfig.prod.json'
]
const identityInputs = [
  ...snapshotInputs,
  'scripts/check-package.mjs',
  'test/package/fixtures',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml'
]

/** Length framing includes names and byte lengths, not ambiguous concatenation. @param {string} directory @param {string[]} names */
async function digest(directory, names) {
  const hash = createHash('sha256')
  /** @param {string} relative */
  async function visit(relative) {
    if (relative.split(path.sep).some(part => part.startsWith('.env'))) return
    const absolute = path.join(directory, relative)
    const stat = await lstat(absolute)
    assert.ok(!stat.isSymbolicLink(), `Symlink input: ${relative}`)
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        if (!name.startsWith('.env')) await visit(path.join(relative, name))
      }
    } else {
      assert.ok(stat.isFile(), `Unexpected input: ${relative}`)
      const bytes = await readFile(absolute)
      const name = Buffer.from(relative)
      hash.update(`${name.length}:`).update(name).update(`${bytes.length}:`).update(bytes)
    }
  }
  for (const name of [...names].sort()) await visit(name)
  return hash.digest('hex')
}

/** @param {string} file */
async function sha256(file) {
  assert.equal(await realpath(file), file, 'Artifact path must be canonical')
  assert.ok((await lstat(file)).isFile(), 'Artifact must be a regular file')
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

/** @param {string} file */
async function canonicalStatePath(file) {
  assert.ok(
    path.isAbsolute(file) && file === path.resolve(file) && file.endsWith('.json'),
    'Invalid state path'
  )
  assert.equal(
    await realpath(path.dirname(file)),
    path.dirname(file),
    'State parent must be canonical'
  )
  assert.ok(
    !file.startsWith(root) && path.dirname(file) !== path.parse(file).root,
    'State must be outside repository and filesystem root'
  )
  await isolatedAncestry(path.dirname(file))
  return file
}

/** Direct checks only: never enumerate ancestor directories. @param {string} directory */
async function isolatedAncestry(directory) {
  let ancestor = directory
  for (;;) {
    let exists = true
    try {
      await access(path.join(ancestor, 'node_modules'))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      exists = false
    }
    assert.ok(!exists, `Ancestor node_modules: ${ancestor}`)
    if (ancestor === path.dirname(ancestor)) break
    ancestor = path.dirname(ancestor)
  }
}

/** @param {State} state */
async function saveState(state) {
  const file = `${state.statePath}.${state.nonce}.tmp`
  let failed = false
  try {
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
    await rename(file, state.statePath)
  } catch (error) {
    failed = true
    throw error
  } finally {
    await cleanupFixtureWorkspace(file, failed)
  }
}

/** @param {State} state */
async function ownedWorkspace(state) {
  assert.match(state.nonce, /^[a-f0-9]{32}$/)
  assert.equal(state.workspace, `${state.statePath}.work`, 'Foreign workspace')
  assert.equal(await realpath(state.workspace), state.workspace, 'Workspace symlink')
  assert.equal(
    await readFile(path.join(state.workspace, '.owner'), 'utf8'),
    `${state.statePath}\n${state.nonce}\n`,
    'Workspace ownership'
  )
}

/** @param {string} file @returns {Promise<State>} */
async function loadState(file) {
  await canonicalStatePath(file)
  assert.ok((await lstat(file)).isFile(), 'State must be regular file')
  const state = /** @type {State} */ (JSON.parse(await readFile(file, 'utf8')))
  assert.equal(state.schema, 1, 'State schema')
  assert.equal(state.statePath, file, 'State path identity')
  assert.equal(state.root, root, 'Source root identity')
  assert.equal(state.readiness, true, 'Missing readiness')
  assert.deepEqual(state.tooling, tooling(file), 'Foreign tooling layout')
  assert.equal(state.finished, false, 'State already finished')
  assert.ok(Array.isArray(state.types) && Array.isArray(state.runtime), 'Invalid receipts')
  assert.ok(
    state.types.every(job => typeJobs.includes(job)) &&
      new Set(state.types).size === state.types.length,
    'Invalid type receipt'
  )
  assert.ok(
    state.runtime.every(version => nodeVersions.includes(version)) &&
      new Set(state.runtime).size === state.runtime.length,
    'Invalid runtime receipt'
  )
  await ownedWorkspace(state)
  assert.equal(state.sourceDigest, await digest(root, identityInputs), 'Source input digest drift')
  const completed = Object.keys(state.candidates)
  assert.deepEqual(completed, packCases.slice(0, completed.length), 'Candidate order/inventory')
  for (const [name, artifact] of Object.entries(state.candidates)) {
    assert.equal(artifact.path, candidatePath(state, name), 'Foreign candidate path')
    assert.equal(await sha256(artifact.path), artifact.sha256, 'Candidate hash mismatch')
  }
  if (state.artifact) await frozenArtifact(state)
  return state
}

/** @param {State} state @param {string} name */
function candidatePath(state, name) {
  return path.join(state.workspace, 'artifacts', name, `${manifest.name}-${manifest.version}.tgz`)
}

/** @param {State} state @param {string} name */
async function canonicalArtifactParents(state, name) {
  for (const directory of [
    path.join(state.workspace, 'artifacts'),
    path.dirname(candidatePath(state, name))
  ]) {
    try {
      assert.ok((await lstat(directory)).isDirectory(), 'Artifact parent must be a directory')
      assert.equal(await realpath(directory), directory, 'Artifact parent must be canonical')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }
}

/** @param {State} state */
async function frozenArtifact(state) {
  assert.equal(state.readiness, true, 'Missing readiness')
  assert.deepEqual(Object.keys(state.candidates), packCases, 'Missing pack candidate')
  const artifact = state.artifact
  assert.ok(artifact, 'Missing frozen artifact')
  assert.deepEqual(artifact, state.candidates['npm-stale'], 'Different frozen artifact')
  assert.equal(artifact.path, candidatePath(state, 'npm-stale'), 'Foreign artifact path')
  assert.equal(await sha256(artifact.path), artifact.sha256, 'Frozen artifact hash mismatch')
  return artifact
}

/** Fixed externally prepared prerequisite layout; readiness NEVER installs. @param {string} statePath */
function tooling(statePath) {
  const base = `${statePath}.tooling`
  return {
    base,
    cache: path.join(base, 'npm-cache'),
    bare: path.join(base, 'bare'),
    undici: path.join(base, 'undici'),
    nodes: nodeVersions.map(version => ({
      version,
      binary: path.join(base, `node-${version}`, 'node_modules/node/bin/node')
    }))
  }
}

/** @param {string} directory @param {string} name @param {string} version */
async function packageVersion(directory, name, version) {
  const file = path.join(directory, 'node_modules', name, 'package.json')
  const installed = /** @type {{version: string}} */ (JSON.parse(await readFile(file, 'utf8')))
  assert.equal(installed.version, version, `Prerequisite ${file}`)
  const resolved = await realpath(file)
  assert.ok(
    resolved.startsWith(`${await realpath(directory)}${path.sep}`),
    'Prerequisite escaped isolated tooling'
  )
}

/** Cache is prepared/owned by T113, never created or removed by this runner. @param {ReturnType<typeof tooling>} tools */
async function canonicalCache(tools) {
  for (const directory of [tools.base, tools.cache, path.join(tools.cache, '_cacache')]) {
    assert.ok((await lstat(directory)).isDirectory(), 'Missing local npm cache prerequisite')
    assert.equal(await realpath(directory), directory, 'Npm cache must be canonical')
  }
}

/** @param {string} statePath */
async function prerequisites(statePath) {
  assert.equal(process.version, 'v24.22.2', 'Runner requires pinned Node24.22.2')
  assert.equal(run('pnpm', ['--version'], root).trim(), '12.16.1')
  assert.equal(run('npm', ['--version'], root).trim(), '11.13.0')
  run('tar', ['--version'], root)
  const tools = tooling(statePath)
  await canonicalCache(tools)
  for (const directory of [tools.bare, tools.undici]) {
    assert.equal(await realpath(directory), directory)
    await isolatedAncestry(path.dirname(directory))
    for (const [name, version] of [
      ['ts5', '5.7.3'],
      ['ts7', '7.0.2'],
      ['@types/node', '24.19.2'],
      ['undici-types', '7.3.0'],
      ['undici-types-modern', '7.30.1']
    ]) {
      assert.ok(name && version)
      await packageVersion(directory, name, version)
    }
    for (const compiler of ['ts5', 'ts7'])
      assert.equal(
        run(
          process.execPath,
          [path.join(directory, 'node_modules', compiler, 'bin/tsc'), '--version'],
          directory
        ).trim(),
        compiler === 'ts5' ? 'Version 5.7.3' : 'Version 7.0.2'
      )
  }
  const require = createRequire(path.join(tools.bare, 'package.json'))
  assert.throws(() => require.resolve('undici'), { code: 'MODULE_NOT_FOUND' })
  await packageVersion(tools.undici, 'undici', '7.30.1')
  for (const { binary, version } of tools.nodes) {
    assert.equal(await realpath(binary), binary, 'Node binary must be canonical')
    await packageVersion(
      path.dirname(path.dirname(path.dirname(path.dirname(binary)))),
      'node',
      version
    )
    assert.equal(run(binary, ['--version'], tools.base).trim(), `v${version}`, 'Exact Node profile')
  }
}

/** @param {string} statePath */
async function readiness(statePath) {
  await canonicalStatePath(statePath)
  await assert.rejects(lstat(statePath), { code: 'ENOENT' }, 'State already exists')
  await prerequisites(statePath)
  assert.equal(manifest.scripts.prepack, 'pnpm run build')
  assert.equal(manifest.dependencies['undici-types'], '7.3.0')
  assert.equal(manifest.dependencies['undici-types-modern'], 'npm:undici-types@7.30.1')
  assert.equal(manifest.devDependencies.undici, '7.30.1')
  assert.ok(!Object.hasOwn(manifest, 'exports'))
  // mkdir without recursive rejects pre-existing/foreign workspaces and repeated readiness.
  const workspace = `${statePath}.work`
  await mkdir(workspace)
  const nonce = createHash('sha256')
    .update(workspace)
    .update(String(process.hrtime.bigint()))
    .digest('hex')
    .slice(0, 32)
  await writeFile(path.join(workspace, '.owner'), `${statePath}\n${nonce}\n`, { flag: 'wx' })
  /** @type {State} */
  const state = {
    schema: 1,
    statePath,
    root,
    workspace,
    nonce,
    sourceDigest: await digest(root, identityInputs),
    tooling: tooling(statePath),
    readiness: true,
    candidates: {},
    types: [],
    runtime: [],
    finished: false
  }
  await saveState(state)
}

/** @param {State} state @param {string} prefix @param {(directory: string) => Promise<void>} work */
async function temporaryLeaf(state, prefix, work) {
  await ownedWorkspace(state)
  const directory = await mkdtemp(path.join(state.workspace, `${prefix}-`))
  let failed = false
  try {
    await work(directory)
  } catch (error) {
    failed = true
    throw error
  } finally {
    await cleanupFixtureWorkspace(directory, failed)
  }
}

/** @param {State} state @param {string} packCase */
async function pack(state, packCase) {
  assert.ok(!state.artifact, 'Artifact already frozen')
  assert.equal(
    packCase,
    packCases[Object.keys(state.candidates).length],
    'Missing or repeated candidate'
  )
  await ownedWorkspace(state)
  await canonicalArtifactParents(state, packCase)
  const artifactPath = candidatePath(state, packCase)
  await mkdir(path.join(state.workspace, 'artifacts'), { recursive: true })
  await mkdir(path.dirname(artifactPath))
  await temporaryLeaf(state, 'pack', async sandbox => {
    for (const name of snapshotInputs) {
      await cp(path.join(root, name), path.join(sandbox, name), {
        recursive: true,
        filter: source =>
          !path
            .relative(root, source)
            .split(path.sep)
            .some(part => part.startsWith('.env'))
      })
    }
    for (const directory of ['coverage', 'docs/plans']) {
      await mkdir(path.join(sandbox, directory), { recursive: true })
      await writeFile(
        path.join(sandbox, directory, 'must-not-publish.txt'),
        'package exclusion probe'
      )
    }
    await symlink(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir')
    await writeFile(path.join(sandbox, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
    assert.equal(run('pnpm', ['config', 'get', 'verifyDepsBeforeRun'], sandbox).trim(), 'false')
    run('pnpm', ['run', 'build'], sandbox)
    /** @type {Map<string, Buffer>} */
    const expected = new Map()
    for (const name of await readdir(path.join(sandbox, 'build/src')))
      expected.set(name, await readFile(path.join(sandbox, 'build/src', name)))
    assert.ok(
      expected.has('index.js') && expected.has('index.d.ts') && expected.has('index.js.map')
    )
    await rm(path.join(sandbox, 'build'), { recursive: true })
    if (packCase.endsWith('-stale')) {
      await mkdir(path.join(sandbox, 'build/src'), { recursive: true })
      for (const name of expected.keys())
        await writeFile(path.join(sandbox, 'build/src', name), 'STALE_T80_ARTIFACT')
    }
    const tool = packCase.startsWith('pnpm-') ? 'pnpm' : 'npm'
    run(tool, ['pack', '--pack-destination', path.dirname(artifactPath)], sandbox)
    const entries = run('tar', ['-tzf', artifactPath], sandbox).trim().split('\n')
    for (const entry of entries) {
      assert.match(
        entry,
        /^package\/(?:package\.json|README\.md|LICENSE|src\/[^\n]+|build\/src\/[^\n]+)$/
      )
      assert.ok(!entry.split('/').some(part => part.startsWith('.env')))
    }
    const sources = (await readdir(path.join(sandbox, 'src'))).sort()
    assert.deepEqual(
      [...entries].sort(),
      [
        'package/package.json',
        'package/README.md',
        'package/LICENSE',
        ...sources.map(name => `package/src/${name}`),
        ...[...expected.keys()].map(name => `package/build/src/${name}`)
      ].sort(),
      'Exact packed entries'
    )
    for (const [name, bytes] of expected) {
      const packed = run('tar', ['-xOzf', artifactPath, `package/build/src/${name}`], sandbox)
      assert.deepEqual(Buffer.from(packed), bytes, `${packCase}: stale ${name}`)
    }
    for (const name of [...sources.map(name => `src/${name}`), 'README.md', 'LICENSE'])
      assert.equal(
        run('tar', ['-xOzf', artifactPath, `package/${name}`], sandbox),
        await readFile(path.join(root, name), 'utf8'),
        `Packed source ${name}`
      )
    const packedManifest = /** @type {typeof manifest} */ (
      JSON.parse(run('tar', ['-xOzf', artifactPath, 'package/package.json'], sandbox))
    )
    for (const key of /** @type {const} */ ([
      'name',
      'version',
      'main',
      'types',
      'dependencies',
      'engines'
    ]))
      assert.deepEqual(packedManifest[key], manifest[key])
  })
  const artifact = { path: artifactPath, sha256: await sha256(artifactPath) }
  await chmod(artifactPath, 0o444)
  state.candidates[packCase] = artifact
  if (Object.keys(state.candidates).length === packCases.length) state.artifact = { ...artifact }
}
/** @param {string} source */
function consumerImports(source) {
  return source
    .replaceAll("'../../../src/index.js'", "'moysklad-fetch-planner'")
    .replaceAll("'../../../src/planner.js'", "'moysklad-fetch-planner/build/src/planner.js'")
    .replaceAll(
      "'../../../src/operation-types.js'",
      "'moysklad-fetch-planner/build/src/operation-types.js'"
    )
}

/** @param {State} state @param {string} family @param {(consumer: string) => Promise<void>} work */
async function consumer(state, family, work) {
  const artifact = await frozenArtifact(state)
  await temporaryLeaf(state, `consumer-${family}`, async directory => {
    await isolatedAncestry(path.dirname(directory))
    await writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n')
    // T113 prepares the exact dependency in the local npm cache. This phase cannot download.
    run(
      'npm',
      [
        'install',
        '--offline',
        '--cache',
        state.tooling.cache,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--fetch-retries=0',
        artifact.path
      ],
      directory,
      0,
      90_000
    )
    const tools = path.join(tooling(state.statePath).base, family)
    await mkdir(path.join(directory, 'node_modules/@types'), { recursive: true })
    for (const name of ['ts5', 'ts7', '@types/node', ...(family === 'undici' ? ['undici'] : [])])
      await symlink(
        path.join(tools, 'node_modules', name),
        path.join(directory, 'node_modules', name),
        'dir'
      )
    const require = createRequire(path.join(directory, 'package.json'))
    assert.equal(
      /** @type {{version: string}} */ (require('@types/node/package.json')).version,
      '24.19.2'
    )
    // Resolve dependency from the installed LIBRARY, not consumer hoisting assumptions.
    const libraryRequire = createRequire(
      path.join(directory, 'node_modules', manifest.name, 'package.json')
    )
    assert.equal(
      /** @type {{version: string}} */ (libraryRequire('undici-types/package.json')).version,
      '7.3.0'
    )
    assert.ok(
      libraryRequire.resolve('undici-types/package.json').startsWith(`${directory}/node_modules/`),
      'Library closure escaped consumer'
    )
    assert.equal(
      /** @type {{version: string}} */ (libraryRequire('undici-types-modern/package.json')).version,
      '7.30.1'
    )
    assert.ok(
      libraryRequire
        .resolve('undici-types-modern/package.json')
        .startsWith(`${directory}/node_modules/`),
      'Modern declaration closure escaped consumer'
    )
    if (family === 'undici') {
      assert.equal(
        /** @type {{version: string}} */ (require('undici/package.json')).version,
        '7.30.1'
      )
    } else {
      assert.throws(() => require.resolve('undici'), { code: 'MODULE_NOT_FOUND' })
      assert.throws(() => libraryRequire.resolve('undici'), { code: 'MODULE_NOT_FOUND' })
      assert.ok(!(await readdir(path.join(directory, 'node_modules'))).includes('undici'))
    }
    await work(directory)
  })
  await frozenArtifact(state)
}

/** @param {State} state @param {string} family @param {string} compiler */
async function types(state, family, compiler) {
  const job = `${family}/${compiler}`
  assert.ok(!state.types.includes(job), 'Repeated type job')
  await consumer(state, family, async directory => {
    const positiveNames = positiveFixtures.filter(
      name => family === 'undici' || name !== 'with-undici'
    )
    // The same legacy family declarations are available from declared undici-types
    // in bare: all sixteen literal oracles run without installing runtime undici.
    const negativeNames = negativeFixtures
    for (const name of [...positiveNames, ...negativeNames])
      await writeFile(
        path.join(directory, `${name}.ts`),
        consumerImports(
          await readFile(
            path.join(fixtures, `${name}.ts${positiveNames.includes(name) ? '' : '.txt'}`),
            'utf8'
          )
        ).replaceAll("from 'undici'", family === 'bare' ? "from 'undici-types'" : "from 'undici'")
      )
    const config = {
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
        noImplicitOverride: true
      },
      files: positiveNames.map(name => `${name}.ts`)
    }
    const require = createRequire(path.join(directory, 'package.json'))
    assert.equal(
      /** @type {{version: string}} */ (require(`${compiler}/package.json`)).version,
      compiler === 'ts5' ? '5.7.3' : '7.0.2'
    )
    const args = [
      path.join(directory, 'node_modules', compiler, 'bin/tsc'),
      '-p',
      'tsconfig.json',
      '--pretty',
      'false'
    ]
    await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify(config))
    run(process.execPath, args, directory, 0, 30_000)
    const expected = await diagnosticMatrix()
    await writeFile(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({
        ...config,
        files: [...config.files, ...negativeNames.map(name => `${name}.ts`)]
      })
    )
    const output = run(process.execPath, args, directory, compiler === 'ts5' ? 2 : 1, 30_000)
    console.log(output.trim())
    exactDiagnostics(output, expected, negativeNames, compiler)
    const declarationDirectory = path.join(directory, 'node_modules', manifest.name, 'build/src')
    const imports = []
    for (const name of (await readdir(declarationDirectory)).filter(name =>
      name.endsWith('.d.ts')
    )) {
      const file = path.join(declarationDirectory, name)
      const source = await readFile(file, 'utf8')
      if (source.includes("from 'undici-types'")) imports.push({ file, source, name })
    }
    assert.equal(imports.length, 1, 'Expected one real declaration dependency import')
    if (family === 'bare') {
      const dependency = imports[0]
      assert.ok(dependency)
      await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify(config))
      try {
        await writeFile(
          dependency.file,
          dependency.source.replace("from 'undici-types'", "from 'undici'")
        )
        const diagnostic = run(
          process.execPath,
          args,
          directory,
          compiler === 'ts5' ? 2 : 1,
          30_000
        )
        const errors = diagnostic.split('\n').filter(line => line.includes('error TS'))
        assert.equal(errors.length, 1, diagnostic)
        assert.ok(errors[0]?.includes(`${dependency.name}(`), diagnostic)
        assert.match(errors[0] ?? '', /error TS2307: Cannot find module 'undici'/)
        console.log(diagnostic.trim())
      } finally {
        await writeFile(dependency.file, dependency.source)
      }
      run(process.execPath, args, directory, 0, 30_000)
    }
  })
  state.types.push(job)
}

/** @param {State} state @param {string} binary */
async function runtime(state, binary) {
  assert.deepEqual(
    [...state.types].sort(),
    [...typeJobs].sort(),
    'Types must finish before runtime'
  )
  const profile = tooling(state.statePath).nodes.find(profile => profile.binary === binary)
  assert.ok(profile, 'Unknown Node profile')
  assert.ok(!state.runtime.includes(profile.version), 'Repeated runtime profile')
  assert.equal(run(binary, ['--version'], state.workspace).trim(), `v${profile.version}`)
  for (const family of ['bare', 'undici']) {
    await consumer(state, family, async directory => {
      const source = await readFile(path.join(fixtures, 'runtime.mjs'), 'utf8')
      assert.ok(
        source.includes("import { FetchPlanner, OperationError } from '../../../src/index.js'"),
        'Runtime root mapping missing'
      )
      assert.ok(
        source.includes("import * as deep from '../../../src/index.js'"),
        'Runtime deep mapping missing'
      )
      assert.ok(
        source.includes("import { FetchPlanner as DeepPlanner } from '../../../src/planner.js'"),
        'Runtime deep planner mapping missing'
      )
      const mapped = consumerImports(source).replace(
        "import * as deep from 'moysklad-fetch-planner'",
        "import * as deep from 'moysklad-fetch-planner/build/src/index.js'"
      )
      await writeFile(path.join(directory, 'runtime.mjs'), mapped)
      console.log(
        run(
          binary,
          ['--unhandled-rejections=strict', 'runtime.mjs', family],
          directory,
          0,
          30_000
        ).trim()
      )
    })
  }
  state.runtime.push(profile.version)
}

/** @param {State} state */
async function finish(state) {
  await frozenArtifact(state)
  assert.deepEqual([...state.types].sort(), [...typeJobs].sort(), 'Missing type receipts')
  assert.deepEqual([...state.runtime].sort(), [...nodeVersions].sort(), 'Missing runtime receipts')
  // Leaves are removed by their creating invocation. Never delete paths supplied by JSON.
  assert.deepEqual(
    (await readdir(state.workspace)).sort(),
    ['.owner', 'artifacts'],
    'Unclean workspace; inspect retained failed evidence'
  )
  state.finished = true
}

/** @param {CLI} options */
async function phase(options) {
  assert.ok(options.state)
  if (options.phase === 'readiness') return readiness(options.state)
  const state = await loadState(options.state)
  let failed = false
  try {
    // All state/path/hash/source checks precede external commands, even version probes.
    if (options.phase === 'types' || options.phase === 'runtime' || options.phase === 'finish')
      await frozenArtifact(state)
    if (options.phase === 'runtime') {
      assert.deepEqual(
        [...state.types].sort(),
        [...typeJobs].sort(),
        'Types must finish before runtime'
      )
      assert.ok(
        tooling(state.statePath).nodes.some(profile => profile.binary === options.node),
        'Unknown Node profile'
      )
    }
    if (options.phase === 'pack') {
      assert.ok(!state.artifact, 'Artifact already frozen')
      assert.equal(
        options.packCase,
        packCases[Object.keys(state.candidates).length],
        'Missing or repeated candidate'
      )
      assert.ok(options.packCase)
      await canonicalArtifactParents(state, options.packCase)
    }
    if (options.phase === 'types')
      assert.ok(!state.types.includes(`${options.family}/${options.compiler}`), 'Repeated type job')
    if (options.phase !== 'finish') await prerequisites(state.statePath)
    if (options.phase === 'pack') {
      assert.ok(options.packCase)
      await pack(state, options.packCase)
    } else if (options.phase === 'types') {
      assert.ok(options.family && options.compiler)
      await types(state, options.family, options.compiler)
    } else if (options.phase === 'runtime') {
      assert.ok(options.node)
      await runtime(state, options.node)
    } else {
      assert.equal(options.phase, 'finish')
      await finish(state)
    }
    assert.equal(
      await digest(root, identityInputs),
      state.sourceDigest,
      'Phase mutated source inputs'
    )
    if (state.artifact) await frozenArtifact(state)
    await saveState(state)
    console.log(`${options.phase}: complete; state ${state.statePath}`)
  } catch (error) {
    failed = true
    throw error
  } finally {
    await preservation(state, failed)
  }
}

/** @param {State} state @param {boolean} failed */
async function preservation(state, failed) {
  try {
    assert.equal(
      await digest(root, identityInputs),
      state.sourceDigest,
      'Phase mutated source inputs'
    )
    if (state.artifact) await frozenArtifact(state)
  } catch (error) {
    if (!failed) throw error
    try {
      console.error('Secondary preservation failure', error)
    } catch {
      // Original phase error has priority over diagnostic writer failure.
    }
  }
}

/** @param {string} statePath */
function orchestrationJobs(statePath) {
  return [
    ['--phase', 'readiness', '--state', statePath],
    ...packCases.map(name => ['--phase', 'pack', '--state', statePath, '--pack-case', name]),
    ...typeJobs.map(job => {
      const [family, compiler] = job.split('/')
      assert.ok(family && compiler)
      return ['--phase', 'types', '--state', statePath, '--family', family, '--compiler', compiler]
    }),
    ...tooling(statePath).nodes.map(profile => [
      '--phase',
      'runtime',
      '--state',
      statePath,
      '--node',
      profile.binary
    ]),
    ['--phase', 'finish', '--state', statePath]
  ]
}

function orchestrate() {
  // Stable location allows T113 to prepare prerequisites before invoking the default gate.
  const statePath = path.join(
    tmpdir(),
    `fetch-planner-package-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.json`
  )
  for (const job of orchestrationJobs(statePath))
    console.log(
      run(process.execPath, [fileURLToPath(import.meta.url), ...job], root, 0, 295_000).trim()
    )
}

if (cli.phase === 'fixture-types') await fixtureTypes()
else if (cli.phase === 'default') orchestrate()
else await phase(cli)
