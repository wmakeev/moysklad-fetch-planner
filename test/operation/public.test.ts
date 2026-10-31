import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response as UndiciResponse } from 'undici'
import type { fetch as UndiciFetch } from 'undici'
import * as root from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import type { Handle, Spec, Init } from '../../src/index.js'

const replay = { serverSafe: false, consumeSafe: false }

test('Root and deep expose one submit planner with a closed runtime surface', async () => {
  assert.equal(root.FetchPlanner, DeepPlanner)
  assert.deepEqual(Object.keys(root).sort(), ['FetchPlanner', 'OperationError'])
  assert.deepEqual(Object.getOwnPropertyNames(DeepPlanner.prototype).sort(), [
    'constructor',
    'observe',
    'snapshot',
    'stop',
    'submit'
  ])
  const transport: typeof globalThis.fetch = () => Promise.resolve(new Response('native'))
  const planner = new root.FetchPlanner(transport)
  const handle: Handle<number> = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: 'https://offline.invalid', init: {} }),
    consume: async response => (await response.bytes()).length
  })
  assert.equal('then' in handle, false)
  assert.equal((await handle.result).value, 6)
  assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
  assert.equal(planner.snapshot().queued, 0)
})

test('Native and undici POST preserve family and core owns method and signal', async () => {
  const calls: string[] = []
  const native: typeof globalThis.fetch = (_url, init) => {
    calls.push(`native:${String(init?.method)}`)
    assert.ok(init?.signal instanceof AbortSignal)
    assert.equal(init.body, 'payload')
    return Promise.resolve(new Response('native'))
  }
  const undici: typeof UndiciFetch = (_url, init) => {
    calls.push(`undici:${String(init?.method)}`)
    assert.ok(init?.signal instanceof AbortSignal)
    assert.equal(init.body, 'payload')
    return Promise.resolve(new UndiciResponse('undici'))
  }
  const first = new root.FetchPlanner(native).submit({
    method: 'POST',
    replay,
    prepare: () => ({
      url: new URL('https://offline.invalid'),
      init: { body: 'payload', method: undefined, signal: undefined }
    }),
    consume: response => response.text()
  })
  const second = new root.FetchPlanner(undici).submit({
    method: 'POST',
    replay,
    prepare: () => ({ url: 'https://offline.invalid', init: { body: 'payload' } }),
    consume: async response => (await response.arrayBuffer()).byteLength
  })
  assert.equal((await first.result).value, 'native')
  assert.equal((await second.result).value, 6)
  await Promise.all([first.resourcesDone, second.resourcesDone])
  assert.deepEqual(calls, ['native:POST', 'undici:POST'])
})

test('Unknown hooks and invalid specs fail with sentinel zero without dispatch', async () => {
  let calls = 0
  const transport: typeof globalThis.fetch = () => {
    calls++
    return Promise.resolve(new Response())
  }
  const planner = new root.FetchPlanner(transport)
  const base: Spec<Init<typeof transport>, Response, string> = {
    method: 'GET',
    replay,
    prepare: () => ({ url: '', init: {} }),
    consume: response => response.text()
  }
  const invalid = [
    null,
    {},
    { ...base, method: 'get' },
    { ...base, replay: {} },
    { ...base, method: 'PUT' },
    { ...base, deadlineMs: 1.5 },
    { ...base, beforeDispatch: 42 },
    { ...base, beforeRetry: 42 },
    { ...base, beforeRetry: () => ({ type: 'allow' }) },
    { ...base, beforeUnknown: () => ({ type: 'allow' }) }
  ]
  for (const spec of invalid) {
    const result: unknown = Reflect.apply(planner.submit.bind(planner), planner, [spec])
    assert.ok(result && typeof result === 'object' && 'result' in result && 'id' in result)
    assert.equal(result.id, 0)
    assert.ok(result.result instanceof Promise)
    await assert.rejects(result.result, { code: 'INVALID_ARGUMENT', phase: 'queued' })
  }
  assert.equal(calls, 0)
  assert.equal(planner.snapshot().sequence, 0)
})

test('Strict count options and existing pacing ranges reject invalid construction', () => {
  for (const key of [
    'maxQueuedOperations',
    'maxSubscribers',
    'deadlineMs',
    'attemptTimeoutMs',
    'cleanupGraceMs',
    'maxAttempts',
    'hookTimeoutMs',
    'maxEntityKeys',
    'errorPerMinuteLimit',
    'rateLimitPerMinuteLimit',
    'entityPutPerMinuteLimit'
  ]) {
    for (const value of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new root.FetchPlanner(globalThis.fetch, { [key]: value }), {
        code: 'INVALID_ARGUMENT'
      })
    }
  }
  for (const options of [
    { jitter: 0.31 },
    { throttlingCoefficient: 0 },
    { maxParallelLimit: 0 },
    { maxRequestDelayTimeMs: Infinity },
    { parallelLimitCorrectionPeriodMs: 999 },
    { hooks: {} }
  ]) {
    assert.throws(() => new root.FetchPlanner(globalThis.fetch, options), {
      code: 'INVALID_ARGUMENT'
    })
  }
  assert.equal(
    new root.FetchPlanner(globalThis.fetch, { maxParallelLimit: 1.5 }).snapshot()
      .effectiveParallelism,
    2
  )
})

test('Runtime init cannot override core method or signal', async () => {
  let calls = 0
  const transport: typeof globalThis.fetch = () => {
    calls++
    return Promise.resolve(new Response())
  }
  for (const [key, value] of [
    ['method', 'POST'],
    ['signal', new AbortController().signal]
  ]) {
    assert.ok(typeof key === 'string')
    const init = {}
    Object.defineProperty(init, key, { enumerable: true, value })
    const handle = new root.FetchPlanner(transport).submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: '', init }),
      consume: () => 'bad'
    })
    await assert.rejects(handle.result, { code: 'PREPARE_FAILED', phase: 'preparing' })
    await handle.resourcesDone
  }
  assert.equal(calls, 0)
})

for (const [name, Planner] of [
  ['root', root.FetchPlanner],
  ['deep', DeepPlanner]
] as const) {
  test(`Public ${name} beforeDispatch accepts frozen allow context for both families`, async () => {
    let calls = 0
    let hooks = 0
    const contexts: root.HookContext[] = []
    const beforeDispatch: root.Hook = context => {
      hooks++
      contexts.push(context)
      return { type: 'allow' }
    }
    const native: typeof globalThis.fetch = () => {
      calls++
      return Promise.resolve(new Response('native'))
    }
    const undici: typeof UndiciFetch = () => {
      calls++
      return Promise.resolve(new UndiciResponse('undici'))
    }
    const first = new Planner(native).submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: { body: 'payload' } }),
      beforeDispatch,
      consume: response => response.text()
    })
    assert.equal((await first.result).value, 'native')
    await first.resourcesDone
    assert.equal(calls, 1)
    assert.equal(hooks, 1)
    const second = new Planner(undici).submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: '', init: { body: 'payload' } }),
      beforeDispatch,
      consume: response => response.text()
    })
    assert.equal((await second.result).value, 'undici')
    await second.resourcesDone
    assert.equal(calls, 2)
    assert.equal(hooks, 2)
    for (const context of contexts) {
      assert.ok(Object.isFrozen(context))
      assert.ok(Object.isFrozen(context.snapshot))
      assert.deepEqual(Object.keys(context).sort(), [
        'attemptNumber',
        'dispatchCalls',
        'signal',
        'snapshot'
      ])
      assert.equal(context.snapshot.phase, 'preparing')
      assert.equal(context.attemptNumber, 1)
      assert.equal(context.dispatchCalls, 0)
      assert.equal(context.snapshot.dispatchEntered, false)
    }
  })
}
