import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FetchPlanner as RootPlanner } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import { deferred } from './helpers.js'

test('Operation harness uses the real root and deep module graph', () => {
  assert.strictEqual(RootPlanner, DeepPlanner)
  assert.strictEqual(process.execArgv.includes('--unhandled-rejections=strict'), true)
})

test('Operation harness keeps a deferred pending until release', async () => {
  const gate = deferred<number>()
  let settled = false
  const work = gate.promise.then(value => {
    settled = true
    return value
  })
  try {
    await Promise.resolve()
    assert.strictEqual(settled, false)
    gate.resolve(42)
    assert.strictEqual(await work, 42)
    assert.strictEqual(settled, true)
  } finally {
    gate.resolve(42)
    await work
  }
})
