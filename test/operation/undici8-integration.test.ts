import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import baselineManifest from 'undici8-baseline/package.json' with { type: 'json' }
import currentManifest from 'undici8/package.json' with { type: 'json' }

// Execute the same finite wire assertions against emitted source and, later, the
// installed tarball. This prevents source/package cancellation or retry drift.
for (const [family, version] of [
  ['undici8-baseline', '8.11.2'],
  ['undici8', '8.12.2']
] as const) {
  test(`${family} ${version} source wire lifecycle and replay`, () => {
    const manifest = family === 'undici8-baseline' ? baselineManifest : currentManifest
    assert.equal(manifest.version, version)
    const fixture = new URL('../../../../test/package/fixtures/runtime.mjs', import.meta.url)
    const source = readFileSync(fixture, 'utf8')
      .replaceAll('../../../src/index.js', new URL('../../src/index.js', import.meta.url).href)
      .replaceAll('../../../src/planner.js', new URL('../../src/planner.js', import.meta.url).href)
      .replace("await import('undici')", `await import('${family}')`)
    // -e supplies no script path; normalize argv to the fixture's explicit CLI.
    const script =
      `process.argv = [process.execPath, 'runtime.mjs', '${family}'];\nconst installed = await import('${family}/package.json', { with: { type: 'json' } });\nassert.equal(installed.default.version, '${version}');\n` +
      source
    // Common root/deep HTTP retries: 2 * (1s + 3s) = 8s; prior 429 3s; wire watchdog 12s; startup/teardown 5s.
    const child = spawnSync(
      process.execPath,
      ['--unhandled-rejections=strict', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 28_000, maxBuffer: 1024 * 1024 }
    )
    assert.ifError(child.error)
    assert.equal(child.signal, null, child.stdout + child.stderr)
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.ok(child.stdout.includes(`Runtime ${family}: owned Agent`))
    console.log(child.stdout.trim())
  })
}
