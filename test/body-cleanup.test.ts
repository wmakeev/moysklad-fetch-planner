import assert from 'node:assert/strict'
import { OperationObservation } from '../src/operation-observation.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Response } from 'undici'
import { FetchPlanner } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'
import { deferred } from './operation/helpers.js'

const url = 'http://offline.test/'
const replay = { serverSafe: false, consumeSafe: false }
for (const status of [429, 200, 500]) {
  for (const failure of ['header', 'observer', 'late'] as const) {
    test(`D08 HTTP${status} ${failure} retains cleanup ownership exactly once`, async t => {
      const clock = createRuntime(t)
      let cancellations = 0
      let starts = 0
      let settlements = 0
      let responses = 0
      let failures = 0
      const transport = deferred<Response>()
      const response = new Response(
        new ReadableStream({
          cancel() {
            cancellations++
          }
        }),
        {
          status,
          headers:
            failure === 'header'
              ? status === 429
                ? { 'X-Lognex-Retry-After': 'invalid' }
                : { 'X-RateLimit-Limit': 'invalid' }
              : { 'X-Lognex-Retry-After': '0' }
        }
      )
      const planner = new FetchPlanner<typeof import('undici').fetch>(
        () => (++starts === 1 ? transport.promise : Promise.resolve(new Response(null))),
        { maxParallelLimit: 1, jitter: 0 }
      )
      let thrown = false
      planner.observe(event => {
        if (event.type === 'headers-received') responses++
        if (event.type === 'operation-settled' && event.outcome === 'failed') failures++
        if (
          !thrown &&
          failure !== 'header' &&
          event.type === (failure === 'late' ? 'dispatch-started' : 'headers-received')
        ) {
          thrown = true
          throw new Error('observer')
        }
      })
      const first = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: borrowed => {
          assert.equal(borrowed, response)
          assert.equal(borrowed.bodyUsed, false, 'UNREAD_STATUS_AT_CONSUME')
          assert.equal(borrowed.status, status)
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
      const next = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: () => 'next'
      })
      try {
        await clock.advance(0)
        assert.equal(settlements, 0, 'PENDING_TRANSPORT_NOT_TERMINATED_BY_OBSERVER')
        assert.equal(starts, 1)
        assert.equal(planner.snapshot().sentActive, 1)
        transport.resolve(response)
        await clock.advance(status === 429 ? 250 : 0)
        const result = await outcome
        if (status === 429) assert.ok(result instanceof Error)
        else {
          assert.ok(!(result instanceof Error))
          assert.equal(result.value, 'finished')
          assert.equal(result.status, status)
        }
        await first.resourcesDone
        await clock.advance(0)
        assert.equal((await next.result).value, 'next')
        assert.equal((await next.result).status, 200, 'NEXT_HTTP_STATUS')
        await next.resourcesDone
        await clock.advance(100)
        assert.equal(cancellations, 1, 'OWNED_BODY_CANCELLED_ONCE')
        assert.equal(starts, 2)
        assert.equal(settlements, 1)
        assert.equal(failures, status === 429 ? 1 : 0)
        assert.equal(responses, 2, 'OBSERVATION_THROW_DOES_NOT_SUPPRESS_OTHER_LISTENERS')
        assert.equal(diagnostics(planner).INVALID_HINT, failure === 'header' ? 1 : 0)
        assert.equal(diagnostics(planner).OBSERVER_FAILED, failure === 'header' ? 0 : 1)
        assert.equal(planner.snapshot().queued, 0)
        assert.equal(planner.snapshot().sentActive, 0)
      } finally {
        transport.resolve(response)
        await Promise.allSettled([
          first.result,
          next.result,
          first.resourcesDone,
          next.resourcesDone
        ])
      }
    })
  }
}
for (const cleanup of ['finite', 'rejected', 'hanging', 'synchronous', 'null'] as const) {
  test(`D08 explicit replay waits for ${cleanup} cleanup`, async t => {
    const clock = createRuntime(t)
    const gate = deferred<undefined>()
    let cancellations = 0
    let starts = 0
    let prepares = 0
    const discarded = new Response(
      cleanup === 'null'
        ? null
        : new ReadableStream({
            cancel() {
              cancellations++
              if (cleanup === 'synchronous') throw new Error('sync cancel failure')
              if (cleanup === 'rejected') return Promise.reject(new Error('cancel failure'))
              if (cleanup === 'hanging') return gate.promise
              return Promise.resolve()
            }
          }),
      { status: 429, headers: { 'X-Lognex-Retry-After': '0' } }
    )
    const delivered = new Response('consumer body')
    assert.ok(delivered.body)
    const cancelDelivered = t.mock.method(delivered.body, 'cancel')
    const planner = new FetchPlanner<typeof import('undici').fetch>(
      () => Promise.resolve(++starts === 1 ? discarded : delivered),
      { maxParallelLimit: 1, jitter: 0 }
    )
    const handle = planner.submit({
      method: 'POST',
      replay: { serverSafe: true, consumeSafe: true },
      prepare: () => {
        prepares++
        return { url, init: { body: 'logical payload' } }
      },
      consume: async response => {
        assert.equal(response, delivered)
        assert.equal(response.bodyUsed, false, 'RETRY_CONSUME_UNREAD')
        assert.equal(cancelDelivered.mock.callCount(), 0, 'NO_CANCEL_BEFORE_RETRY_CONSUME')
        return response.text()
      }
    })
    const outcome = handle.result.then(
      value => value,
      (error: unknown) => {
        assert.ok(error instanceof Error)
        return error
      }
    )
    try {
      await clock.advance(0)
      await clock.advance(250)
      assert.equal(cancellations, cleanup === 'null' ? 0 : 1, 'DISCARDED_CANCEL_ONCE')
      if (cleanup === 'hanging') {
        await clock.advance(100)
        assert.equal(prepares, 1, 'NEXT_PREPARE_MUST_WAIT_FOR_FINITE_DISPOSER')
        assert.equal(handle.snapshot().resources, 'pending')
        assert.equal(planner.snapshot().sentActive, 1)
        gate.resolve(undefined)
      }
      await clock.advance(4000)
      const result = await outcome
      if (cleanup === 'rejected' || cleanup === 'synchronous') {
        assert.ok(result instanceof Error)
        assert.equal(starts, 1, 'FAILED_CLEANUP_FORBIDS_REPLAY')
      } else {
        assert.ok(!(result instanceof Error))
        assert.equal(result.value, 'consumer body')
        assert.equal(starts, 2)
      }
      assert.deepEqual(await handle.resourcesDone, {
        resources: cleanup === 'rejected' || cleanup === 'synchronous' ? 'failed' : 'released'
      })
      assert.equal(cancellations, cleanup === 'null' ? 0 : 1)
      assert.equal(cancelDelivered.mock.callCount(), 0, 'EOF_READER_IS_ALREADY_CLOSED')
      const next = planner.submit({
        method: 'GET',
        replay,
        prepare: () => ({ url, init: {} }),
        consume: () => 'next'
      })
      await clock.advance(0)
      assert.equal((await next.result).value, 'next')
      assert.equal((await next.result).status, 200, 'NEXT_HTTP_STATUS')
      await next.resourcesDone
      assert.equal(planner.snapshot().queued, 0)
      assert.equal(planner.snapshot().sentActive, 0)
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}
for (const status of [200, 500]) {
  test(`HTTP${status} preserves borrow identity and finished consumer value`, async t => {
    const clock = createRuntime(t)
    const response = new Response('consumer body', { status })
    assert.ok(response.body)
    const cancel = t.mock.method(response.body, 'cancel')
    const planner = new FetchPlanner<typeof import('undici').fetch>(() => Promise.resolve(response))
    const handle = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url, init: {} }),
      consume: borrowed => {
        assert.equal(borrowed, response, 'BORROW_IDENTITY')
        assert.equal(borrowed.bodyUsed, false)
        assert.equal(cancel.mock.callCount(), 0)
        return borrowed.text()
      }
    })
    await clock.advance(0)
    assert.equal((await handle.result).value, 'consumer body')
    assert.equal((await handle.result).status, status)
    await handle.resourcesDone
    await clock.advance(100)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(cancel.mock.callCount(), 0, 'EOF_NEEDS_NO_SECOND_CANCEL')
  })
}
test('Finite loopback cleanup child exits naturally with strict rejections', async () => {
  const child = spawn(process.execPath, [
    '--unhandled-rejections=strict',
    fileURLToPath(new URL('./helpers/child.mjs', import.meta.url)),
    'cleanup-loopback'
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
  }, 10000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(expired, false, 'WATCHDOG_IS_FAILURE')
    assert.equal(code, 0, stderr)
    assert.equal(stderr, '')
    assert.match(
      stdout,
      /loopback: retry, header, observer, late; bodies released; finite cancels settled/
    )
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill()
  }
})

function diagnostics(target: object) {
  const observation: unknown = Reflect.get(target, 'observation')
  assert.ok(observation instanceof OperationObservation)
  return observation.diagnostics.snapshot()
}
