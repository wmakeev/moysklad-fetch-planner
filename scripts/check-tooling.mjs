import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Exercise the real parents of security overrides without releasing or opening an editor.
const require = createRequire(import.meta.url)
/** @param {NodeJS.Require} parent @param {string} name */
const from = (parent, name) => createRequire(parent.resolve(`${name}/package.json`))
const np = from(require, 'np')
const exclusion = from(from(require, 'c8'), 'test-exclude')
const walker = from(np, 'ignore-walk')
const inquirer = from(from(np, 'listr-input'), 'inquirer')
const external = from(inquirer, 'external-editor')
const autoChangelog = from(require, 'auto-changelog')

assert.equal(/** @type {{version: string}} */ (external('tmp/package.json')).version, '0.2.7')
assert.equal(/** @type {{version: string}} */ (exclusion('glob/package.json')).version, '14.0.2')
assert.equal(
  /** @type {{version: string}} */ (exclusion('minimatch/package.json')).version,
  '11.0.1'
)
assert.equal(/** @type {{version: string}} */ (walker('minimatch/package.json')).version, '11.0.1')

const owned = await mkdtemp(path.join(tmpdir(), 'fetch-planner-tooling-'))
try {
  await mkdir(path.join(owned, 'src', 'nested'), { recursive: true })
  for (const name of ['include.js', 'skip.js', 'nested/deep.js'])
    await writeFile(path.join(owned, 'src', name), 'export const fixture = true\n')
  await writeFile(path.join(owned, '.fixtureignore'), 'src/skip.js\n')

  const TestExclude =
    /** @type {new (options: {cwd: string, include: string[], exclude: string[], extension: string[]}) => {globSync(): string[], glob(): Promise<string[]>, shouldInstrument(filename: string): boolean}} */ (
      from(require, 'c8')('test-exclude')
    )
  const filter = new TestExclude({
    cwd: owned,
    include: ['src/**/*.js'],
    exclude: ['**/skip.js'],
    extension: ['.js']
  })
  const expected = ['src/include.js', 'src/nested/deep.js']
  assert.deepEqual(filter.globSync().sort(), expected)
  assert.deepEqual((await filter.glob()).sort(), expected)
  assert.equal(filter.shouldInstrument(path.join(owned, '..', 'outside.js')), false)
  const walk =
    /** @type {(options: {path: string, ignoreFiles: string[]}) => Promise<string[]>} */ (
      np('ignore-walk')
    )
  const files = await walk({ path: owned, ignoreFiles: ['.fixtureignore'] })
  assert.ok(files.includes('src/include.js'))
  assert.ok(files.includes('src/nested/deep.js'))
  assert.ok(!files.includes('src/skip.js'))

  const { ExternalEditor } =
    /** @type {{ExternalEditor: new (text: string, options: {dir: string, prefix: string, postfix: string, mode: number}) => {tempFile: string, cleanup(): void}}} */ (
      inquirer('external-editor')
    )
  const editor = new ExternalEditor('fixture text', {
    dir: owned,
    prefix: 'editor-',
    postfix: '.txt',
    mode: 0o600
  })
  try {
    assert.equal(path.dirname(editor.tempFile), owned)
    assert.equal(await readFile(editor.tempFile, 'utf8'), 'fixture text')
  } finally {
    editor.cleanup()
  }
  await assert.rejects(readFile(editor.tempFile), { code: 'ENOENT' })

  const yaml = /** @type {{load(input: string): unknown}} */ (from(np, 'cosmiconfig')('js-yaml'))
  assert.deepEqual(yaml.load('release:\n  enabled: false\n'), { release: { enabled: false } })
  const { compileTemplate } =
    /** @type {{compileTemplate(this: void, releases: unknown[], options: {template: string}): Promise<string>}} */ (
      autoChangelog('./src/template.js')
    )
  const releases = [{ title: 'Fixture release', commits: [] }]
  const rendered = await compileTemplate(releases, { template: 'json' })
  assert.deepEqual(JSON.parse(rendered), releases)
  console.log(
    'Tooling compatibility: coverage globs, ignore-walk, editor temp lifecycle, YAML and changelog template passed'
  )
} finally {
  await rm(owned, { recursive: true })
}
