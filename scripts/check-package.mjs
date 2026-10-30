/// <reference types="node" />

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixtures = path.join(root, 'test/package/fixtures')
const manifest = /** @type {typeof import('../package.json')} */ (
  JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
)
assert.ok(
  !process.argv[2] || ['bare', 'undici'].includes(process.argv[2]),
  'Unknown consumer slice'
)
assert.ok(!process.argv[3] || ['ts5', 'ts7'].includes(process.argv[3]), 'Unknown compiler slice')
const inputs = [
  'src',
  'test',
  'samples',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.prod.json',
  'tsconfig.test.json',
  'knip.json',
  '.oxlintrc.json',
  '.oxfmtrc.json',
  'README.md',
  'LICENSE',
  '.npmignore'
]

/** @param {string} directory @param {string[]} names */
async function digest(directory, names) {
  const hash = createHash('sha256')
  /** @param {string} relative */
  async function visit(relative) {
    assert.ok(!path.basename(relative).startsWith('.env'), 'Do not read secret files')
    const absolute = path.join(directory, relative)
    const stat = await import('node:fs/promises').then(fs => fs.lstat(absolute))
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        if (!name.startsWith('.env')) await visit(path.join(relative, name))
      }
    } else {
      assert.ok(stat.isFile(), `Unexpected input: ${relative}`)
      hash.update(relative).update(await readFile(absolute))
    }
  }
  for (const name of names) await visit(name)
  return hash.digest('hex')
}

/** @param {string} command @param {string[]} args @param {string} cwd @param {number} expected */
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, NODE_PATH: '' },
    maxBuffer: 8 * 1024 * 1024
  })
  const output = `${result.stdout}${result.stderr}`
  assert.ifError(result.error)
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${output}`)
  return output
}

/** @param {string} prefix */
async function external(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporary.push(directory)
  assert.ok(!directory.startsWith(root), 'Consumer must be outside repository')
  // Verify every ancestor instead of relying on an empty NODE_PATH alone.
  let ancestor = path.dirname(directory)
  for (;;) {
    const entries = await readdir(ancestor)
    assert.ok(!entries.includes('node_modules'), `Ancestor node_modules: ${ancestor}`)
    if (ancestor === path.dirname(ancestor)) break
    ancestor = path.dirname(ancestor)
  }
  return directory
}

/** @type {string[]} */
const temporary = []
const before = await digest(root, inputs)
try {
  assert.equal(manifest.scripts.prepack, 'pnpm run build')
  assert.equal(manifest.dependencies['undici-types'], '7.3.0')
  assert.equal(manifest.devDependencies.undici, '7.3.0')
  assert.ok(!Object.hasOwn(manifest, 'exports'))
  const sandbox = await external('fetch-planner-pack-')
  for (const name of [
    'src',
    'test',
    'samples',
    'scripts',
    '.npmignore',
    'package.json',
    'README.md',
    'LICENSE',
    'tsconfig.json',
    'tsconfig.prod.json'
  ]) {
    await cp(path.join(root, name), path.join(sandbox, name), {
      recursive: true,
      filter: source => !path.basename(source).startsWith('.env')
    })
  }
  for (const directory of ['coverage', 'docs/plans']) {
    await mkdir(path.join(sandbox, directory), { recursive: true })
    await writeFile(
      path.join(sandbox, directory, 'must-not-publish.txt'),
      'package exclusion probe'
    )
  }
  // Build tools only; consumers below never share this symlink.
  await symlink(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir')
  run('pnpm', ['run', 'build'], sandbox)
  /** @type {Map<string, Buffer>} */
  const expected = new Map()
  for (const name of await readdir(path.join(sandbox, 'build/src'))) {
    expected.set(name, await readFile(path.join(sandbox, 'build/src', name)))
  }
  assert.ok(expected.has('index.js') && expected.has('index.d.ts') && expected.has('index.js.map'))
  const output = path.join(root, '__temp/package-check')
  await mkdir(output, { recursive: true })
  let tarball = ''
  for (const tool of ['pnpm', 'npm']) {
    for (const state of ['absent', 'stale']) {
      await rm(path.join(sandbox, 'build'), { recursive: true, force: true })
      if (state === 'stale') {
        await mkdir(path.join(sandbox, 'build/src'), { recursive: true })
        for (const name of expected.keys()) {
          await writeFile(path.join(sandbox, 'build/src', name), 'STALE_T80_ARTIFACT')
        }
      }
      run(tool, ['pack', '--pack-destination', output], sandbox)
      tarball = path.join(output, `${manifest.name}-${manifest.version}.tgz`)
      const entries = run('tar', ['-tzf', tarball], sandbox).trim().split('\n')
      for (const entry of entries) {
        assert.match(
          entry,
          /^package\/(?:package\.json|README\.md|LICENSE|src\/[^\n]+|build\/src\/[^\n]+)$/
        )
        assert.ok(!entry.split('/').some(part => part.startsWith('.env')))
      }
      for (const entry of [
        'package.json',
        'README.md',
        'LICENSE',
        'src/index.ts',
        'build/src/index.d.ts'
      ]) {
        assert.ok(entries.includes(`package/${entry}`), `Missing ${entry}`)
      }
      for (const [name, bytes] of expected) {
        const packed = spawnSync('tar', ['-xOzf', tarball, `package/build/src/${name}`])
        assert.equal(packed.status, 0)
        assert.deepEqual(packed.stdout, bytes, `${tool}/${state}: stale ${name}`)
      }
      const packedSource = run('tar', ['-xOzf', tarball, 'package/src/index.ts'], sandbox)
      assert.equal(packedSource, await readFile(path.join(root, 'src/index.ts'), 'utf8'))
      const packedManifest = /** @type {typeof manifest} */ (
        JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json'], sandbox))
      )
      for (const key of ['name', 'version', 'main', 'types'])
        assert.equal(packedManifest[key], manifest[key])
      console.log(
        `A6: ${tool} pack / ${state}: current JS, declarations, map, source and package contents`
      )
    }
  }
  assert.ok(tarball)
  for (const withUndici of [false, true]) {
    if (process.argv[2] && process.argv[2] !== (withUndici ? 'undici' : 'bare')) continue
    const consumer = await external(`fetch-planner-consumer-${withUndici ? 'undici' : 'bare'}-`)
    await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
    const dependencies = [
      tarball,
      '@types/node@24.19.2',
      'ts5@npm:typescript@5.7.3',
      'ts7@npm:typescript@7.0.2'
    ]
    if (withUndici) dependencies.push('undici@7.3.0')
    for (const dependency of dependencies) {
      console.log(
        `Installing ${withUndici ? 'undici' : 'bare'} consumer: ${path.basename(dependency)}`
      )
      run(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--prefer-offline',
          '--fetch-retries=0',
          '--fetch-timeout=20000',
          dependency
        ],
        consumer
      )
    }
    const require = createRequire(path.join(consumer, 'package.json'))
    assert.equal(
      /** @type {{version: string}} */ (require('@types/node/package.json')).version,
      '24.19.2'
    )
    assert.equal(
      /** @type {{version: string}} */ (require('undici-types/package.json')).version,
      '7.3.0'
    )
    if (withUndici) {
      assert.equal(
        /** @type {{version: string}} */ (require('undici/package.json')).version,
        '7.3.0'
      )
    } else {
      assert.throws(() => require.resolve('undici'), { code: 'MODULE_NOT_FOUND' })
      assert.ok(!(await readdir(path.join(consumer, 'node_modules'))).includes('undici'))
    }
    await writeFile(
      path.join(consumer, 'runtime.mjs'),
      (await readFile(path.join(fixtures, 'runtime.mjs'), 'utf8'))
        .replace(
          "import { FetchPlanner, wrapFetch } from '../../../src/index.js'",
          "import { FetchPlanner, wrapFetch } from 'moysklad-fetch-planner'"
        )
        .replace(
          "import * as deep from '../../../src/index.js'",
          "import * as deep from 'moysklad-fetch-planner/build/src/index.js'"
        )
    )
    console.log(run(process.execPath, ['runtime.mjs'], consumer).trim())
    const positiveNames = [
      'without-undici',
      'native',
      'custom',
      'subclass',
      'events',
      'events-bytes',
      ...(withUndici ? ['with-undici'] : [])
    ]
    const negativeNames = [
      'transport',
      'constructor',
      'input-transport',
      'body',
      'method',
      'planner-body',
      'planner-method',
      'event',
      'event-method',
      'union-input',
      'callable-property',
      ...(withUndici ? ['undici-body', 'undici-method', 'undici-bytes'] : [])
    ].map(name => `negative-${name}`)
    const names = [
      ...positiveNames,
      ...negativeNames,
      'events-negative',
      'events-overload-annotation'
    ]
    for (const name of names) {
      await writeFile(
        path.join(consumer, `${name}.ts`),
        (
          await readFile(
            path.join(fixtures, `${name}.ts${positiveNames.includes(name) ? '' : '.txt'}`),
            'utf8'
          )
        ).replaceAll("'../../../src/index.js'", "'moysklad-fetch-planner'")
      )
    }
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
    const declarationDirectory = path.join(consumer, 'node_modules', manifest.name, 'build/src')
    // Follow the emitted declaration graph: the dependency need not live in index.d.ts.
    const declarationNames = (await readdir(declarationDirectory)).filter(name =>
      name.endsWith('.d.ts')
    )
    const imports = []
    for (const name of declarationNames) {
      const file = path.join(declarationDirectory, name)
      const source = await readFile(file, 'utf8')
      if (source.includes("from 'undici-types'")) imports.push({ file, source, name })
    }
    assert.equal(imports.length, 1, 'Expected one real declaration dependency import')
    for (const [compiler, version] of [
      ['ts5', '5.7.3'],
      ['ts7', '7.0.2']
    ]) {
      if (process.argv[3] && process.argv[3] !== compiler) continue
      assert.equal(
        /** @type {{version: string}} */ (require(`${compiler}/package.json`)).version,
        version
      )
      const args = [`node_modules/${compiler}/bin/tsc`, '-p', 'tsconfig.json', '--pretty', 'false']
      await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify(config))
      run(process.execPath, args, consumer)
      console.log(
        `A5: ${compiler}, undici=${withUndici}: native/legacy/custom/subclass/events positives passed`
      )
      const expected = /** @type {Record<string, [number, number | number[]][]>} */ (
        JSON.parse(await readFile(path.join(fixtures, 'diagnostics.json'), 'utf8'))
      )
      const negativeFiles = [...negativeNames, 'events-negative', 'events-overload-annotation']
      await writeFile(
        path.join(consumer, 'tsconfig.json'),
        JSON.stringify({
          ...config,
          files: [...config.files, ...negativeFiles.map(name => `${name}.ts`)]
        })
      )
      const diagnostic = run(process.execPath, args, consumer, compiler === 'ts5' ? 2 : 1)
      console.log(diagnostic.trim())
      const actual = diagnostic
        .split('\n')
        .filter(line => line.includes('error TS'))
        .map(line => {
          const match = /^([^()]+)\((\d+),\d+\): error TS(\d+):/.exec(line)
          assert.ok(match, line)
          return [match[1], Number(match[2]), Number(match[3])]
        })
      const wanted = negativeFiles.flatMap(name =>
        expected[name].map(
          /** @param {[number, number | number[]]} entry */ ([line, code]) => [
            `${name}.ts`,
            line,
            Array.isArray(code) ? code[compiler === 'ts5' ? 0 : 1] : code
          ]
        )
      )
      const compare = (/** @type {unknown} */ a, /** @type {unknown} */ b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      assert.deepEqual(
        actual.sort(compare),
        wanted.sort(compare),
        'Exact negative diagnostic file/line/code matrix'
      )
      if (!withUndici) {
        const dependency = imports[0]
        assert.ok(dependency)
        await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify(config))
        try {
          await writeFile(
            dependency.file,
            dependency.source.replace("from 'undici-types'", "from 'undici'")
          )
          const diagnostic = run(process.execPath, args, consumer, compiler === 'ts5' ? 2 : 1)
          const errors = diagnostic.split('\n').filter(line => line.includes('error TS'))
          assert.equal(errors.length, 1, diagnostic)
          assert.ok(errors[0]?.includes(`${dependency.name}(`), diagnostic)
          assert.match(errors[0] ?? '', /error TS2307: Cannot find module 'undici'/)
          console.log(diagnostic.trim())
        } finally {
          await writeFile(dependency.file, dependency.source)
        }
      }
      console.log(
        `A5: TS ${version}, undici=${withUndici}: exact transport/body/method/event/bytes negatives and declaration closure passed`
      )
    }
  }
  console.log('A5–A8 passed: native and undici Fetch contracts verified on fresh tarball.')
} finally {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true })
  assert.equal(await digest(root, inputs), before, 'Package checks mutated repository inputs')
}
