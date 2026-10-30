import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Response } from 'undici'
import { FetchPlanner, type FetchPlannerEventMap } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'

const url = 'http://offline.test/'

for (const status of [429, 200, 500]) {
  for (const failure of ['header', 'observer', 'late'] as const) {
    test(`D08 HTTP${status} ${failure} discards the owned body exactly once`, async t => {
      const runtime = createRuntime(t)
      const original = new Error('observer failure')
      const events = new EventEmitter<FetchPlannerEventMap>()
      let cancellations = 0
      let starts = 0
      let settlements = 0
      let failures = 0
      let responses = 0
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
      let deliver!: (response: Response) => void
      const transport = new Promise<Response>(resolve => {
        deliver = resolve
      })
      events.once(failure === 'late' ? 'request' : 'response', () => {
        if (failure !== 'header') throw original
      })
      events.on('fetch-error', () => failures++)
      events.on('response', () => responses++)
      const planner = new FetchPlanner(
        () => {
          starts++
          return starts === 1 ? transport : Promise.resolve(new Response(null))
        },
        { jitter: 0, maxParallelLimit: 1, eventHandler: events }
      )
      const first = planner
        .getFetch()(url)
        .then(
          value => {
            settlements++
            return value
          },
          (error: unknown) => {
            settlements++
            return error
          }
        )
      const next = planner.getFetch()(url)
      if (failure === 'late') {
        await runtime.advance(0)
        assert.equal(await first, original)
        assert.equal(planner.getCurInflightRequestsCount(), 1)
        await runtime.flush()
        assert.equal(
          starts,
          1,
          'Terminal action retains headers-owned inflight until transport settles'
        )
      }
      deliver(response)
      await runtime.advance(0)
      assert.equal(cancellations, 1, 'Discarded response must be cleaned exactly once')
      const error = await first
      assert.ok(error instanceof Error)
      if (failure !== 'header') assert.equal(error, original)
      await runtime.advance(0)
      assert.equal((await next).status, 200)
      await runtime.advance(100)
      assert.equal(cancellations, 1, 'Terminal cleanup must never repeat')
      assert.equal(starts, 2)
      assert.equal(settlements, 1)
      assert.equal(failures, 1)
      assert.equal(responses, 1, 'Only the next delivered response reaches the counting observer')
      assert.equal(planner.getActionsQueueLength(), 0)
      assert.equal(planner.getCurInflightRequestsCount(), 0)
    })
  }
}

for (const cleanup of ['finite', 'rejected', 'hanging', 'synchronous', 'null'] as const) {
  test(`D08 discarded429 retry progresses with ${cleanup} cancel`, async t => {
    const runtime = createRuntime(t)
    let cancellations = 0
    let starts = 0
    const pendingCancel = new Promise<void>(() => {
      // Deliberately never settles; a promise alone owns no event-loop handles.
    })
    const discarded = new Response(cleanup === 'null' ? null : 'discarded', {
      status: 429,
      headers: { 'X-Lognex-Retry-After': '0' }
    })
    if (discarded.body) {
      t.mock.method(discarded.body, 'cancel', () => {
        cancellations++
        if (cleanup === 'synchronous') throw new Error('sync cancel failure')
        if (cleanup === 'rejected') return Promise.reject(new Error('cancel failure'))
        if (cleanup === 'hanging') return pendingCancel
        return Promise.resolve()
      })
    }
    const delivered = new Response('consumer body')
    assert.ok(delivered.body)
    const cancelDelivered = t.mock.method(delivered.body, 'cancel')
    const planner = new FetchPlanner(
      () => Promise.resolve(++starts === 1 ? discarded : delivered),
      { jitter: 0, maxParallelLimit: 1 }
    )
    const result = planner.getFetch()(url)
    await runtime.advance(0)
    assert.equal(
      cancellations,
      cleanup === 'null' ? 0 : 1,
      'Discarded response must be cleaned exactly once'
    )
    await runtime.advance(0)
    assert.equal(await result, delivered)
    assert.equal(delivered.bodyUsed, false, 'Planner must not read the delivered body')
    assert.equal(cancelDelivered.mock.callCount(), 0)
    await runtime.advance(0)
    assert.equal(
      planner.getCurInflightRequestsCount(),
      0,
      'Inflight ends at headers, before consumer body reading'
    )
    const next = planner.getFetch()(url)
    await runtime.advance(0)
    assert.equal(await next, delivered, 'Next action must complete even while cancel is pending')
    await runtime.flush()
    assert.equal(await delivered.text(), 'consumer body')
    assert.equal(cancelDelivered.mock.callCount(), 0)
    await runtime.advance(100)
    assert.equal(cancellations, cleanup === 'null' ? 0 : 1)
    assert.equal(planner.getActionsQueueLength(), 0)
    assert.equal(planner.getCurInflightRequestsCount(), 0)
  })
}

for (const status of [200, 500]) {
  test(`HTTP${status} delivered response preserves identity and unread body`, async t => {
    const runtime = createRuntime(t)
    const response = new Response('consumer body', { status })
    assert.ok(response.body)
    const cancel = t.mock.method(response.body, 'cancel')
    const planner = new FetchPlanner(() => Promise.resolve(response), { jitter: 0 })
    const result = planner.getFetch()(url)
    await runtime.advance(0)
    assert.equal(await result, response)
    await runtime.flush()
    assert.equal(response.bodyUsed, false)
    assert.equal(cancel.mock.callCount(), 0)
    assert.equal(planner.getCurInflightRequestsCount(), 0)
    assert.equal(await response.text(), 'consumer body')
    await runtime.advance(100)
    assert.equal(cancel.mock.callCount(), 0)
  })
}

test('Finite loopback cleanup child exits naturally with strict rejections', async () => {
  const child = spawn(process.execPath, [
    '--unhandled-rejections=strict',
    '__temp/test-build/test/helpers/child.mjs',
    'cleanup-loopback'
  ])
  let stdout = ''
  let stderr = ''
  let expired = false
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const watchdog = setTimeout(() => {
    expired = true
    child.kill()
  }, 5000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(expired, false, 'Watchdog expiration is a failure')
    assert.equal(code, 0, `Finite cleanup child must exit naturally: ${stderr}`)
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
