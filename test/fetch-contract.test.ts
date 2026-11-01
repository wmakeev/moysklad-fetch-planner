import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { fetch, Response, FormData } from 'undici'
import { FetchPlanner, OperationError, type Handle, type MethodSpec } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'

const replay = { serverSafe: false, consumeSafe: false }
for (const family of ['native', 'undici'] as const) {
  test(`${family} explicit MethodSpec replaces Request metadata and override`, async () => {
    const methods: string[] = []
    const specs: MethodSpec[] = [
      { method: 'POST' },
      { method: 'PUT', entityKey: 'one' },
      { method: 'GET' }
    ]
    if (family === 'native') {
      const planner = new FetchPlanner<typeof globalThis.fetch>((input, init) => {
        assert.equal(typeof input, 'string')
        methods.push(init?.method ?? '')
        return Promise.resolve(new globalThis.Response(null))
      })
      for (const spec of specs) {
        const h = planner.submit({
          ...spec,
          replay,
          prepare: () => ({ url: 'http://offline.test/', init: {} }),
          consume: () => 'finished'
        })
        assert.equal((await h.result).value, 'finished')
        await h.resourcesDone
      }
    } else {
      const planner = new FetchPlanner<typeof fetch>((input, init) => {
        assert.equal(typeof input, 'string')
        methods.push(init?.method ?? '')
        return Promise.resolve(new Response(null))
      })
      for (const spec of specs) {
        const h = planner.submit({
          ...spec,
          replay,
          prepare: () => ({ url: 'http://offline.test/', init: {} }),
          consume: () => 'finished'
        })
        assert.equal((await h.result).value, 'finished')
        await h.resourcesDone
      }
    }
    assert.deepEqual(methods, ['POST', 'PUT', 'GET'], 'EXPLICIT_METHOD_OVERRIDE')
  })
}
test('Undici transport preserves payload and borrow identity with owned init and signal', async () => {
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
    const input = new URL('http://offline.test/')
    const descriptorInit = { body, duplex: 'half' as const }
    const response = new Response('untouched', { status: 503 })
    let signal: AbortSignal | undefined
    const value = { text: '' }
    const planner = new FetchPlanner<typeof fetch>((url, init) => {
      assert.equal(url, input.href)
      assert.ok(init)
      assert.notEqual(init, descriptorInit, 'OWNED_INIT_COPY')
      assert.equal(init.body, body, 'PAYLOAD_IDENTITY')
      assert.equal(init.signal, signal, 'ATTEMPT_SIGNAL_IDENTITY')
      assert.equal(init.method, 'POST')
      return Promise.resolve(response)
    })
    const handle = planner.submit({
      method: 'POST',
      replay,
      prepare: ctx => {
        signal = ctx.signal
        return { url: input, init: descriptorInit }
      },
      consume: async borrowed => {
        assert.equal(borrowed, response)
        assert.equal(borrowed.bodyUsed, false)
        value.text = await borrowed.text()
        return value
      }
    })
    assert.equal((await handle.result).value, value)
    assert.equal((await handle.result).status, 503)
    assert.equal(value.text, 'untouched')
    await handle.resourcesDone
  }
})
test('Abort owns transport signal and transport rejection never retries', async () => {
  let starts = 0
  let failures = 0
  let signal: AbortSignal | undefined
  let entered!: () => void
  const sending = new Promise<void>(resolve => {
    entered = resolve
  })
  const reason = new Error('transport abort')
  const planner = new FetchPlanner<typeof globalThis.fetch>((_input, init) => {
    starts++
    assert.equal(init?.signal, signal)
    assert.equal(init?.method, 'POST')
    entered()
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          reject(reason)
        },
        { once: true }
      )
    })
  })
  planner.observe(event => {
    if (event.type === 'operation-settled' && event.outcome === 'failed') failures++
  })
  const h: Handle<string> = planner.submit({
    method: 'POST',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: ctx => {
      signal = ctx.signal
      return { url: 'http://offline.test/', init: {} }
    },
    consume: () => 'unused'
  })
  const rejected = assert.rejects(
    h.result,
    error => error instanceof OperationError && error.code === 'ABORTED' && error.cause === reason
  )
  await sending
  h.abort(reason)
  await rejected
  await h.resourcesDone
  assert.equal(signal?.aborted, true)
  assert.equal(starts, 1)
  assert.equal(failures, 1, 'ONE_ABORT_FAILURE_EVENT')
  assert.equal(planner.snapshot().queued, 0)
  assert.equal(planner.snapshot().sentActive, 0)
})
for (const body of ['retry payload', Buffer.from('retry payload')]) {
  test(`Undici retry prepares fresh ${typeof body === 'string' ? 'string' : 'Buffer'} descriptor with stable payload`, async t => {
    const clock = createRuntime(t)
    let calls = 0
    let prepares = 0
    const delivered = new Response('consumer')
    const inits: unknown[] = []
    const signals: unknown[] = []
    const planner = new FetchPlanner<typeof fetch>(
      (_url, init) => {
        assert.equal(init?.body, body)
        inits.push(init)
        signals.push(init.signal)
        return Promise.resolve(
          ++calls === 1
            ? new Response(null, { status: 429, headers: { 'X-Lognex-Retry-After': '0' } })
            : delivered
        )
      },
      { jitter: 0 }
    )
    const h: Handle<string> = planner.submit({
      method: 'POST',
      replay: { serverSafe: true, consumeSafe: true },
      prepare: ctx => {
        prepares++
        assert.equal(ctx.operationId, h.id)
        return { url: 'http://offline.test/', init: { body } }
      },
      consume: response => {
        assert.equal(response, delivered, 'RETRY_BORROW_IDENTITY')
        assert.equal(response.bodyUsed, false, 'RETRY_UNREAD_AT_CONSUME')
        return response.text()
      }
    })
    await clock.advance(0)
    await clock.advance(4000)
    assert.equal((await h.result).value, 'consumer')
    await h.resourcesDone
    assert.equal(calls, 2)
    assert.equal(prepares, 2)
    assert.notEqual(inits[0], inits[1])
    assert.notEqual(signals[0], signals[1])
    assert.equal(planner.snapshot().queued, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  })
}
test('Native loopback Fetch contract and one-shot child exits naturally under strict rejections', async () => {
  const child = spawn(process.execPath, [
    '--unhandled-rejections=strict',
    fileURLToPath(new URL('./helpers/child.mjs', import.meta.url)),
    'native-fetch-contract'
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
  }, 15000)
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
      /Native loopback: payloads, metadata, HTTP OK, retry and one-shot boundaries/
    )
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill()
  }
})
