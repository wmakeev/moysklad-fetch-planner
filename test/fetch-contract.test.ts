import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { fetch, Request, Response, FormData } from 'undici'
import { FetchPlanner, wrapFetch, type FetchPlannerEventMap } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'

for (const family of ['native', 'undici'] as const) {
  test(`${family} Request metadata uses Request method and init override`, async () => {
    if (family === 'native') {
      const events = new EventEmitter<FetchPlannerEventMap<typeof globalThis.fetch>>()
      const methods: (string | undefined)[] = []
      events.on('request', ev => methods.push(ev.method))
      events.on('response', ev => methods.push(ev.method))
      const planner = new FetchPlanner<typeof globalThis.fetch>(
        () => Promise.resolve(new globalThis.Response(null)),
        { eventHandler: events }
      )
      await planner.getFetch()(new globalThis.Request('http://offline.test/', { method: 'POST' }))
      await planner.getFetch()(new globalThis.Request('http://offline.test/', { method: 'POST' }), {
        method: 'PUT'
      })
      await planner.getFetch()('http://offline.test/')
      assert.deepEqual(methods, ['POST', 'POST', 'PUT', 'PUT', undefined, undefined])
    } else {
      const events = new EventEmitter<FetchPlannerEventMap<typeof fetch>>()
      const methods: (string | undefined)[] = []
      events.on('request', ev => methods.push(ev.method))
      events.on('response', ev => methods.push(ev.method))
      const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response(null)), {
        eventHandler: events
      })
      await planner.getFetch()(new Request('http://offline.test/', { method: 'POST' }))
      await planner.getFetch()(new Request('http://offline.test/', { method: 'POST' }), {
        method: 'PUT'
      })
      await planner.getFetch()('http://offline.test/')
      assert.deepEqual(methods, ['POST', 'POST', 'PUT', 'PUT', undefined, undefined])
    }
  })
}

test('Undici fake transport preserves payload, init, signal and Response identity', async () => {
  const form = new FormData()
  form.set('field', 'value')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    }
  })
  for (const body of [
    'payload',
    Buffer.from('payload'),
    form,
    new File(['payload'], 'body.txt'),
    stream
  ]) {
    const controller = new AbortController()
    const init = { method: 'POST', body, signal: controller.signal, duplex: 'half' as const }
    const input = new URL('http://offline.test/')
    const response = new Response('untouched', { status: 503 })
    const wrapped = wrapFetch<typeof fetch>((url, options) => {
      assert.equal(url, input)
      assert.equal(options, init)
      assert.equal(options.body, body)
      assert.equal(options.signal, controller.signal)
      return Promise.resolve(response)
    })
    assert.equal(await wrapped(input, init), response)
    assert.equal(response.bodyUsed, false)
    assert.equal(await response.text(), 'untouched')
  }
})

test('Signal remains transport-owned and transport rejection is never retried', async () => {
  const controller = new AbortController()
  const reason = new Error('transport abort')
  let starts = 0
  const events = new EventEmitter<FetchPlannerEventMap<typeof globalThis.fetch>>()
  let failures = 0
  events.on('fetch-error', event => {
    failures++
    assert.equal(event.error, reason)
    assert.equal(event.method, 'POST')
  })
  const planner = new FetchPlanner<typeof globalThis.fetch>(
    (_input, init) => {
      starts++
      assert.equal(init?.signal, controller.signal)
      return new Promise((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            reject(reason)
          },
          { once: true }
        )
      })
    },
    { eventHandler: events }
  )
  const result = planner.getFetch()('http://offline.test/', {
    method: 'POST',
    signal: controller.signal
  })
  const rejected = assert.rejects(result, error => error === reason)
  await new Promise<void>(resolve =>
    events.once('request', () => {
      resolve()
    })
  )
  controller.abort(reason)
  await rejected
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(starts, 1)
  assert.equal(failures, 1)
  assert.equal(planner.getActionsQueueLength(), 0)
  assert.equal(planner.getCurInflightRequestsCount(), 0)
})

for (const body of ['retry payload', Buffer.from('retry payload')]) {
  test(`Undici retry preserves ${typeof body === 'string' ? 'string' : 'Buffer'} payload identity`, async t => {
    const runtime = createRuntime(t)
    let calls = 0
    const init = { method: 'POST', body }
    const response = new Response('consumer')
    const planner = new FetchPlanner<typeof fetch>(
      (_url, options) => {
        assert.equal(options, init)
        assert.equal(options.body, body)
        return Promise.resolve(++calls === 1 ? new Response(null, { status: 429 }) : response)
      },
      { jitter: 0 }
    )
    const result = planner.getFetch()('http://offline.test/', init)
    await runtime.advance(0)
    await runtime.advance(0)
    assert.equal(await result, response)
    await runtime.advance(0)
    assert.equal(calls, 2)
    assert.equal(planner.getActionsQueueLength(), 0)
    assert.equal(planner.getCurInflightRequestsCount(), 0)
  })
}

test('Native loopback Fetch contract and one-shot replay child exits naturally under strict rejections', async () => {
  const child = spawn(process.execPath, [
    '--unhandled-rejections=strict',
    '__temp/test-build/test/package/fixtures/runtime.mjs'
  ])
  let stdout = ''
  let stderr = ''
  let expired = false
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const watchdog = setTimeout(() => {
    expired = true
    child.kill()
  }, 10000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(expired, false, 'Watchdog expiration is a failure')
    assert.equal(code, 0, stderr)
    assert.equal(stderr, '')
    assert.match(
      stdout,
      /Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries/
    )
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill()
  }
})
