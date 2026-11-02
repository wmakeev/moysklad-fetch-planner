/// <reference types="node" />

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Preparation owns only this fresh directory. The existing runner owns its gates.
const root = fileURLToPath(new URL('../../', import.meta.url))
assert.equal(process.argv.length, 2, 'No arguments expected')
assert.equal(process.version, 'v24.22.2', 'Use the pinned project Node')

/** @param {string} command @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} [env] */
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    timeout: 900_000
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, `${command} terminated by signal`)
  assert.equal(result.status, 0, `${command} failed`)
}

const parent = await realpath(tmpdir())
const owned = await mkdtemp(path.join(parent, 'fetch-planner-ci-'))
const marker = path.join(owned, '.owner')
const nonce = randomUUID()
await writeFile(marker, nonce, { flag: 'wx' })
try {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, TMPDIR: owned, TMP: owned, TEMP: owned, NODE_PATH: '' }
  const state = path.join(
    owned,
    `fetch-planner-package-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.json`
  )
  const tooling = `${state}.tooling`
  const cache = path.join(tooling, 'npm-cache')
  await mkdir(cache, { recursive: true })
  const installFlags = [
    '--cache',
    cache,
    '--registry=https://registry.npmjs.org',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--save-exact'
  ]
  const compilers = [
    'ts5@npm:typescript@5.7.3',
    'ts7@npm:typescript@7.0.2',
    '@types/node@24.19.2',
    'undici-types@7.3.0'
  ]
  /** @param {string} leaf @param {string[]} packages @param {boolean} [scripts] */
  async function install(leaf, packages, scripts = false) {
    const directory = path.join(tooling, leaf)
    await mkdir(directory)
    await writeFile(path.join(directory, 'package.json'), '{"private":true}\n', { flag: 'wx' })
    run(
      'npm',
      ['install', ...installFlags, `--ignore-scripts=${!scripts}`, ...packages],
      directory,
      env
    )
  }
  console.log(`CI package preparation: ${owned}`)
  // setup-node pins Node, but the runner image may provide a different npm.
  await install('npm', ['npm@11.13.0'])
  env.PATH = `${path.join(tooling, 'npm/node_modules/.bin')}${path.delimiter}${env.PATH ?? ''}`
  await install('bare', compilers)
  await install('undici', [...compilers, 'undici@7.3.0'])
  for (const version of ['24.0.0', '24.22.2', '26.13.0']) {
    // Only the isolated Node packages need their binary-install lifecycle scripts.
    await install(`node-${version}`, [`node@${version}`], true)
  }
  // Consumer installs are offline; ensure their exact dependency is cached too.
  run(
    'npm',
    [
      'cache',
      'add',
      'undici-types@7.3.0',
      '--cache',
      cache,
      '--registry=https://registry.npmjs.org'
    ],
    owned,
    env
  )
  console.log('CI package preparation complete; running the unchanged full package gate')
  run('pnpm', ['test:package'], root, env)
} finally {
  assert.equal(await realpath(owned), owned, 'Owned directory moved')
  assert.ok((await lstat(owned)).isDirectory(), 'Owned directory replaced')
  assert.ok(!(await lstat(marker)).isSymbolicLink(), 'Owner marker replaced')
  assert.equal(await readFile(marker, 'utf8'), nonce, 'Owner marker changed')
  await rm(owned, { recursive: true })
  console.log(`CI package cleanup complete: ${owned}`)
}
