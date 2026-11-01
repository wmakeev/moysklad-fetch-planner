import assert from 'node:assert/strict'
import { OperationObservation } from '../src/operation-observation.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Response } from 'undici'
import { FetchPlanner, OperationError, type Handle } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'
import { deferred } from './operation/helpers.js'

const replay = { serverSafe: false, consumeSafe: false }
const url = 'http://offline.test/'
for (const scenario of ['invalid-header', 'response-observer']) {
  test(`D01 D02 ${scenario} preserves terminal status and isolated observation`, async t => {
    const clock = createRuntime(t)
    let starts = 0
    let settlements = 0
    let consumes = 0
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () => {
        starts++
        return Promise.resolve(
          new Response(null, {
            status: 429,
            headers: {
              'X-Lognex-Retry-After': scenario === 'invalid-header' ? 'invalid' : '0'
            }
          })
        )
      },
      { jitter: 0 }
    )
    planner.observe(event => {
      if (event.type === 'headers-received' && scenario === 'response-observer')
        throw new Error('observer')
    })
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: () => {
        consumes++
        return 'unused'
      }
    })
    void handle.result.then(
      () => {
        settlements++
      },
      () => {
        settlements++
      }
    )
    const rejected = assert.rejects(handle.result, { code: 'HTTP_FAILED', status: 429 })
    await clock.advance(0)
    await rejected
    await handle.resourcesDone
    await clock.advance(100)
    await clock.advance(100)
    assert.equal(starts, 1, 'TERMINAL_NEVER_RESTARTS')
    assert.equal(consumes, 0, '429_CLASSIFICATION_OWNS_RESPONSE')
    assert.equal(settlements, 1, 'SINGLE_SETTLEMENT')
    assert.equal(
      diagnostics(planner)[scenario === 'invalid-header' ? 'INVALID_HINT' : 'OBSERVER_FAILED'],
      1
    )
    assert.equal(planner.snapshot().queued, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  })
}
for (const scenario of ['error-observer', 'sync-transport', 'request-observer']) {
  test(`D03 D04 ${scenario} settles naturally under strict rejections`, async () => {
    const child = spawn(process.execPath, [
      '--unhandled-rejections=strict',
      fileURLToPath(new URL('./helpers/child.mjs', import.meta.url)),
      scenario
    ])
    let stdout = ''
    let stderr = ''
    let expired = false
    child.stdout.setEncoding('utf8').on('data', (s: string) => {
      stdout += s
    })
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      stderr += s
    })
    const watchdog = setTimeout(() => {
      expired = true
      child.kill()
    }, 5000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      assert.equal(expired, false, 'WATCHDOG_IS_FAILURE')
      assert.equal(code, 0, stderr)
      assert.equal(stderr, '')
      assert.match(stdout, /settled once; queue and inflight empty/)
    } finally {
      clearTimeout(watchdog)
      if (child.exitCode === null) child.kill()
    }
  })
}
for (const event of ['dispatch-started', 'headers-received', 'operation-settled'] as const) {
  for (const throws of [false, true]) {
    test(`Reentrant observer ${event} enqueue with throw ${throws} preserves ownership`, async t => {
      const clock = createRuntime(t)
      const original = new Error('original transport failure')
      const starts: string[] = []
      let settlements = 0
      let resourceSettlements = 0
      let failureSettlements = 0
      const planner = new FetchPlanner<typeof import('undici').fetch>(
        input => {
          assert.ok(typeof input === 'string')
          starts.push(input)
          if (starts.length === 1 && event === 'operation-settled') return Promise.reject(original)
          return Promise.resolve(new Response(null))
        },
        { maxParallelLimit: 1, jitter: 0 }
      )
      let nested: Handle<string> | undefined
      planner.observe(record => {
        if (record.type === 'resources-settled') resourceSettlements++
        if (record.type === 'operation-settled' && record.outcome === 'failed') failureSettlements++
        if (record.type !== event || nested) return
        nested = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: url + 'nested', init: {} }),
          consume: () => 'nested'
        })
        if (throws) throw new Error('observer failure')
      })
      const first = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url: url + 'first', init: {} }),
        consume: () => 'first'
      })
      const outcome = first.result.then(
        result => {
          settlements++
          return result.value
        },
        (error: unknown) => {
          settlements++
          assert.ok(error instanceof Error)
          return error
        }
      )
      await clock.advance(0)
      if (event === 'operation-settled') {
        const failure = await outcome
        assert.ok(failure instanceof OperationError)
        assert.equal(failure.cause, original)
      } else assert.equal(await outcome, 'first', 'OBSERVER_THROW_CANNOT_REJECT_DELIVERY')
      await first.resourcesDone
      await clock.advance(0)
      assert.ok(nested)
      assert.equal((await nested.result).value, 'nested')
      await nested.resourcesDone
      await clock.advance(100)
      assert.deepEqual(starts, [url + 'first', url + 'nested'])
      assert.equal(settlements, 1)
      assert.equal(resourceSettlements, 2, 'ONCE_RESOURCE_SETTLEMENT_PER_OPERATION')
      assert.equal(
        failureSettlements,
        event === 'operation-settled' ? 1 : 0,
        'OBSERVER_THROW_IS_NOT_OPERATION_FAILURE'
      )
      assert.equal(diagnostics(planner).OBSERVER_FAILED, throws ? 1 : 0)
      assert.equal(planner.snapshot().queued, 0)
      assert.equal(planner.snapshot().leasedAttempts, 0)
      assert.equal(planner.snapshot().sentActive, 0)
    })
  }
}
for (const late of ['response', 'rejection'] as const) {
  test(`Request observer throw retains pending transport until late ${late}`, async t => {
    const clock = createRuntime(t)
    const transport = deferred<Response>()
    let starts = 0
    let cancellations = 0
    let settlements = 0
    let receipts = 0
    let failures = 0
    const response = new Response('unconsumed')
    assert.ok(response.body)
    t.mock.method(response.body, 'cancel', () => {
      cancellations++
      return Promise.resolve()
    })
    const original = new Error('late transport error')
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () => (++starts === 1 ? transport.promise : Promise.resolve(new Response(null))),
      { maxParallelLimit: 1 }
    )
    let nested: Handle<string> | undefined
    planner.observe(event => {
      if (event.type === 'headers-received') receipts++
      if (event.type === 'operation-settled' && event.outcome === 'failed') failures++
      if (event.type === 'dispatch-started' && !nested) {
        nested = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url, init: {} }),
          consume: () => 'nested'
        })
        throw new Error('request observer')
      }
    })
    const first = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: borrowed => {
        assert.equal(borrowed, response)
        return 'finished'
      }
    })
    const outcome = first.result.then(
      value => {
        settlements++
        return value
      },
      (error: unknown) => {
        settlements++
        assert.ok(error instanceof Error)
        return error
      }
    )
    try {
      await clock.advance(0)
      assert.equal(settlements, 0, 'OBSERVER_DOES_NOT_TERMINATE_PENDING_TRANSPORT')
      assert.equal(planner.snapshot().sentActive, 1)
      await clock.advance(100)
      assert.equal(starts, 1, 'PENDING_TRANSPORT_RETAINS_SLOT')
      if (late === 'response') transport.resolve(response)
      else transport.reject(original)
      await clock.advance(0)
      const value = await outcome
      if (late === 'rejection') {
        assert.ok(value instanceof OperationError)
        assert.equal(value.cause, original)
      } else {
        assert.ok(!(value instanceof Error))
        assert.equal(value.value, 'finished')
      }
      await first.resourcesDone
      await clock.advance(0)
      assert.ok(nested)
      await nested.result
      await nested.resourcesDone
      assert.equal(starts, 2)
      assert.equal(settlements, 1)
      assert.equal(cancellations, late === 'response' ? 1 : 0)
      assert.equal(receipts, late === 'response' ? 2 : 1, 'LATE_TRANSPORT_RECEIPT_DELIVERED')
      assert.equal(failures, late === 'rejection' ? 1 : 0, 'LATE_TRANSPORT_FAILURE_ONLY')
      assert.equal(diagnostics(planner).OBSERVER_FAILED, 1)
      assert.equal(planner.snapshot().sentActive, 0)
    } finally {
      transport.resolve(response)
      await Promise.allSettled([first.result, first.resourcesDone])
    }
  })
}
for (const failure of ['header', 'observer', 'none'] as const) {
  test(`Non429 ${failure} preserves unread consume and finished value identity`, async t => {
    const clock = createRuntime(t)
    const response = new Response('consumer body', {
      headers: failure === 'header' ? { 'X-RateLimit-Limit': 'invalid' } : {}
    })
    assert.ok(response.body)
    const cancel = t.mock.method(response.body, 'cancel')
    const planner = new FetchPlanner<typeof import('undici').fetch>(() => Promise.resolve(response))
    planner.observe(event => {
      if (failure === 'observer' && event.type === 'headers-received') throw new Error('observer')
    })
    const value = { text: '' }
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: async borrowed => {
        assert.equal(borrowed, response, 'BORROW_IDENTITY')
        assert.equal(borrowed.bodyUsed, false, 'UNREAD_AT_CONSUME')
        assert.equal(cancel.mock.callCount(), 0, 'NO_CANCEL_BEFORE_CONSUME')
        value.text = await borrowed.text()
        return value
      }
    })
    await clock.advance(0)
    assert.equal((await handle.result).value, value, 'COMPLETED_VALUE_IDENTITY')
    await handle.resourcesDone
    assert.equal(value.text, 'consumer body')
    assert.equal(diagnostics(planner).INVALID_HINT, failure === 'header' ? 1 : 0)
    assert.equal(diagnostics(planner).OBSERVER_FAILED, failure === 'observer' ? 1 : 0)
    assert.equal(planner.snapshot().sentActive, 0)
  })
}
test('Diagnostic isolation preserves original transport error and queue progress', async t => {
  const clock = createRuntime(t)
  const original = new Error('transport failed')
  let starts = 0
  const planner = new FetchPlanner<typeof import('undici').fetch>(
    () => (++starts === 1 ? Promise.reject(original) : Promise.resolve(new Response(null))),
    { maxParallelLimit: 1 }
  )
  planner.observe(event => {
    if (event.type === 'operation-settled' && event.outcome === 'failed')
      throw new Error('secondary')
  })
  const failed = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url, init: {} }),
    consume: () => 'unused'
  })
  const rejected = assert.rejects(
    failed.result,
    error => error instanceof OperationError && error.cause === original
  )
  const next = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url, init: {} }),
    consume: () => 'next'
  })
  await clock.advance(0)
  await rejected
  await failed.resourcesDone
  await clock.advance(0)
  assert.equal((await next.result).value, 'next')
  await next.resourcesDone
  assert.equal(diagnostics(planner).OBSERVER_FAILED, 1)
  assert.equal(starts, 2)
  assert.equal(planner.snapshot().sentActive, 0)
})

function diagnostics(target: object) {
  const observation: unknown = Reflect.get(target, 'observation')
  assert.ok(observation instanceof OperationObservation)
  return observation.diagnostics.snapshot()
}
