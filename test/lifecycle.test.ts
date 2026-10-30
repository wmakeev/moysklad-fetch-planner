import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Response } from 'undici'
import { FetchPlanner, type FetchPlannerEventMap } from '../src/index.js'
import { createRuntime } from './helpers/runtime.js'

for (const scenario of ['invalid-header', 'response-observer']) {
  test(`${scenario === 'invalid-header' ? 'D01' : 'D02'} terminal action never restarts after ${scenario}`, async t => {
    const runtime = createRuntime(t)
    let starts = 0
    let settlements = 0
    const original = new Error('response observer failed')
    const events = new EventEmitter<FetchPlannerEventMap>()
    events.on('response', () => {
      if (scenario === 'response-observer') throw original
    })
    const planner = new FetchPlanner(
      () => {
        starts++
        return Promise.resolve(
          new Response(null, {
            status: 429,
            headers: { 'X-Lognex-Retry-After': scenario === 'invalid-header' ? 'invalid' : '1' }
          })
        )
      },
      { jitter: 0, eventHandler: events }
    )
    const result = planner
      .getFetch()('http://offline.test/')
      .then(
        () => {
          settlements++
          assert.fail('Failed action resolved')
        },
        (error: unknown) => {
          settlements++
          return error
        }
      )
    await runtime.advance(0)
    const error = await result
    assert.ok(error instanceof Error)
    if (scenario === 'response-observer') assert.equal(error, original)
    await runtime.advance(100)
    await runtime.advance(100)
    assert.equal(starts, 1, 'Rejected action must never start again')
    assert.equal(settlements, 1)
    assert.equal(planner.getActionsQueueLength(), 0)
    assert.equal(planner.getCurInflightRequestsCount(), 0)
  })
}

for (const scenario of ['error-observer', 'sync-transport', 'request-observer']) {
  test(`${scenario === 'error-observer' ? 'D03' : 'D04'} ${scenario} settles without uncaught or unhandled errors`, async () => {
    const child = spawn(
      process.execPath,
      ['--unhandled-rejections=strict', '__temp/test-build/test/helpers/child.mjs', scenario],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const watchdog = setTimeout(() => child.kill(), 5000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      assert.equal(code, 0, `Finite child must exit naturally: ${stderr}`)
      assert.match(stdout, /settled once/)
      if (scenario === 'error-observer') {
        assert.match(stderr, /FetchPlanner observer failed/)
        assert.doesNotMatch(stderr, /original failure|secondary failure|offline.test/)
      } else assert.equal(stderr, '')
    } finally {
      clearTimeout(watchdog)
      if (child.exitCode === null) child.kill()
    }
  })
}

for (const event of ['request', 'response', 'fetch-error'] as const) {
  for (const throws of [false, true]) {
    test(`Reentrant ${event} enqueue with throw ${throws} preserves queue and slot ownership`, async t => {
      const runtime = createRuntime(t)
      const original = new Error('original transport failure')
      const observerError = new Error('observer failure')
      const events = new EventEmitter<FetchPlannerEventMap>()
      const starts: string[] = []
      const failures: Error[] = []
      let settlements = 0
      let releases = 0
      class ObservedPlanner extends FetchPlanner {
        protected override checkFreeRequestSlotTrigger() {
          releases++
          super.checkFreeRequestSlotTrigger()
        }
      }
      const planner = new ObservedPlanner(
        url => {
          assert.ok(typeof url === 'string')
          starts.push(url)
          if (starts.length === 1 && event === 'fetch-error') return Promise.reject(original)
          return Promise.resolve(new Response(null))
        },
        { maxParallelLimit: 1, jitter: 0, eventHandler: events }
      )
      const warning = t.mock.method(process, 'emitWarning', () => {
        // Record the diagnostic without writing test warnings.
      })
      events.on('fetch-error', data => failures.push(data.error))
      let nested: Promise<Response> | undefined
      events.once(event, () => {
        nested = planner.getFetch()('http://offline.test/nested')
        if (throws) throw observerError
      })
      const first = planner
        .getFetch()('http://offline.test/first')
        .then(
          response => {
            settlements++
            return response
          },
          (error: unknown) => {
            settlements++
            return error
          }
        )
      await runtime.advance(0)
      const result = await first
      if (event === 'fetch-error') assert.equal(result, original)
      else if (throws) assert.equal(result, observerError)
      else assert.ok(result instanceof Response)
      await runtime.advance(0)
      assert.ok(nested)
      assert.ok((await nested) instanceof Response)
      await runtime.advance(100)
      assert.deepEqual(starts, ['http://offline.test/first', 'http://offline.test/nested'])
      assert.equal(settlements, 1)
      assert.equal(releases, 2, 'Each completed transport releases exactly one slot')
      assert.equal(failures.length, event === 'fetch-error' || throws ? 1 : 0)
      assert.equal(warning.mock.callCount(), event === 'fetch-error' && throws ? 1 : 0)
      assert.equal(planner.getActionsQueueLength(), 0)
      assert.equal(planner.getCurInflightRequestsCount(), 0)
    })
  }
}

for (const late of ['response', 'rejection'] as const) {
  test(`Request observer rejection keeps inflight until late ${late} without a second settlement`, async t => {
    const runtime = createRuntime(t)
    const original = new Error('request observer failed')
    const events = new EventEmitter<FetchPlannerEventMap>()
    let resolve!: (response: Response) => void
    let reject!: (error: Error) => void
    const transport = new Promise<Response>((res, rej) => {
      resolve = res
      reject = rej
    })
    const starts: string[] = []
    const failures: Error[] = []
    let responses = 0
    let cancellations = 0
    const response = new Response('unconsumed')
    assert.ok(response.body)
    t.mock.method(response.body, 'cancel', () => {
      cancellations++
      return Promise.resolve()
    })
    const planner = new FetchPlanner(
      url => {
        assert.ok(typeof url === 'string')
        starts.push(url)
        return starts.length === 1 ? transport : Promise.resolve(new Response(null))
      },
      { maxParallelLimit: 1, jitter: 0, eventHandler: events }
    )
    let nested: Promise<Response> | undefined
    events.once('request', () => {
      nested = planner.getFetch()('http://offline.test/nested')
      throw original
    })
    events.on('response', () => {
      responses++
    })
    events.on('fetch-error', data => failures.push(data.error))
    const first = planner
      .getFetch()('http://offline.test/first')
      .catch((error: unknown) => error)
    await runtime.advance(0)
    assert.equal(await first, original)
    assert.equal(planner.getCurInflightRequestsCount(), 1)
    await runtime.advance(100)
    assert.equal(starts.length, 1, 'A rejected action still owns its sent transport slot')
    if (late === 'response') resolve(response)
    else reject(new Error('late transport error'))
    await runtime.flush()
    assert.equal(planner.getCurInflightRequestsCount(), 0)
    await runtime.advance(0)
    assert.ok(nested)
    await nested
    assert.equal(starts.length, 2)
    assert.deepEqual(failures, [original])
    assert.equal(responses, 1, 'Late result of terminal action emits no response')
    assert.equal(cancellations, late === 'response' ? 1 : 0)
    assert.equal(planner.getCurInflightRequestsCount(), 0)
  })
}

for (const failure of ['header', 'observer', 'none'] as const) {
  test(`Non429 response ownership after ${failure} failure`, async t => {
    const runtime = createRuntime(t)
    const events = new EventEmitter<FetchPlannerEventMap>()
    const original = new Error('observer failed')
    const response = new Response('consumer body', {
      headers: failure === 'header' ? { 'X-RateLimit-Limit': 'invalid' } : {}
    })
    assert.ok(response.body)
    const cancel = t.mock.method(response.body, 'cancel', () => Promise.resolve())
    if (failure === 'observer')
      events.on('response', () => {
        throw original
      })
    const planner = new FetchPlanner(() => Promise.resolve(response), { eventHandler: events })
    const result = planner
      .getFetch()('http://offline.test/')
      .catch((error: unknown) => error)
    await runtime.advance(0)
    const value = await result
    if (failure === 'none') {
      assert.equal(value, response)
      assert.equal(cancel.mock.callCount(), 0)
      assert.equal(await response.text(), 'consumer body')
    } else {
      assert.ok(value instanceof Error)
      if (failure === 'observer') assert.equal(value, original)
      assert.equal(cancel.mock.callCount(), 1, 'Undelivered response belongs to the cleanup path')
    }
    assert.equal(planner.getCurInflightRequestsCount(), 0)
  })
}

test('Diagnostic failure preserves original error and queue progress', async t => {
  const runtime = createRuntime(t)
  const original = new Error('transport failed')
  const events = new EventEmitter<FetchPlannerEventMap>()
  events.on('fetch-error', () => {
    throw new Error('secondary')
  })
  const warning = t.mock.method(process, 'emitWarning', () => {
    throw new Error('diagnostic failed')
  })
  let starts = 0
  const planner = new FetchPlanner(
    () => {
      starts++
      if (starts === 1)
        return new Promise<Response>((_resolve, reject) => {
          reject(original)
        })
      return Promise.resolve(new Response(null))
    },
    { eventHandler: events, maxParallelLimit: 1 }
  )
  const failed = planner
    .getFetch()('http://offline.test/first')
    .catch((error: unknown) => error)
  const next = planner.getFetch()('http://offline.test/next')
  await runtime.advance(0)
  const error = await failed
  assert.ok(error instanceof Error)
  assert.equal(error, original)
  await runtime.advance(0)
  await next
  assert.equal(warning.mock.callCount(), 1)
  assert.equal(planner.getCurInflightRequestsCount(), 0)
  assert.equal(starts, 2)
})
