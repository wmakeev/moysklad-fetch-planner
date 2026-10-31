import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import { ConsumeReadFailure } from '../../src/operation-types.js'
import type { ConsumeContext, Event, Handle, Snapshot } from '../../src/operation-types.js'
import { OperationObservation } from '../../src/operation-observation.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const canary = 'T70_PRIVATE_URL_HEADER_BODY_CAUSE_VALUE_KEY'
const replay = { serverSafe: true, consumeSafe: true }
const errors = [
  { code: 3000, parameter: 'agent', error: canary, line: 1, column: 2 },
  { code: 3006, parameter: 'name', error: canary, moreInfo: `https://invalid.test/${canary}` },
  { code: 0, error: canary }
]
const fixtures = [
  { name: 'multiple errors', status: 412, payload: { errors }, json: true },
  {
    name: 'mixed bulk',
    status: 412,
    payload: [{ id: canary }, { errors }, { id: `${canary}2` }],
    json: true
  },
  { name: 'mixed delete', status: 409, payload: [{ info: canary }, { errors }], json: true },
  { name: 'HTML', status: 503, payload: `<html>${canary}</html>`, json: false },
  { name: 'manual redirect', status: 302, payload: canary, json: false }
] as const

type Body = string | ReadableStream<Uint8Array> | null
class ApplicationFailure extends Error {
  constructor(
    readonly details: unknown,
    cause?: unknown
  ) {
    super(canary, { cause })
  }
}

// Each dispatch constructs a real, fresh Response of the selected family. A broken
// retry implementation must reach dispatch 2 rather than fail on a reused body.
function source(
  Constructor: typeof FetchPlanner,
  family: 'native' | 'undici',
  status: number,
  body: () => Body,
  invalidHints = true
) {
  const responses: (Response | UndiciResponse)[] = []
  const headers = {
    'content-type': 'application/json',
    'x-private': canary,
    ...(invalidHints ? { 'x-lognex-retry-after': canary, 'retry-after': canary } : {}),
    'x-lognex-reset': '0'
  }
  if (family === 'native') {
    const planner = new Constructor<typeof fetch>(() => {
      const response = new Response(body(), { status, headers })
      responses.push(response)
      return Promise.resolve(response)
    })
    return { planner, responses }
  }
  const planner = new Constructor<typeof undiciFetch>(() => {
    const response = new UndiciResponse(body(), { status, headers })
    responses.push(response)
    return Promise.resolve(response)
  })
  return { planner, responses }
}

function record(record: Snapshot | Event) {
  const keys = [
    'id',
    'sequence',
    'phase',
    'outcome',
    'resultCommitted',
    'resources',
    'attempts',
    'dispatchCalls',
    'dispatchEntered'
  ]
  if ('status' in record) keys.push('status')
  if ('failureCode' in record) keys.push('failureCode')
  if ('type' in record) keys.push('type', 'epochTime', 'elapsedMs')
  assert.deepEqual(Object.keys(record).sort(), keys.sort(), 'SCALAR_RECORD_ALLOWLIST')
  assert.equal(Object.isFrozen(record), true)
  assert.ok(
    Object.values(record).every(value => ['string', 'number', 'boolean'].includes(typeof value))
  )
  assert.equal(JSON.stringify(record).includes(canary), false, 'PRIVATE_DETAILS_MUST_NOT_ESCAPE')
}

function observe(planner: ReturnType<typeof source>['planner']) {
  const events: Event[] = []
  const snapshots: Snapshot[] = []
  const aggregates = [planner.snapshot()]
  const plannerAttachment = planner.observe(event => {
    events.push(event)
    aggregates.push(planner.snapshot())
    // Returning a decision-looking object cannot influence retries.
    return { kind: 'deny', private: canary }
  })
  aggregates.push(plannerAttachment.snapshot)
  function attach<T>(handle: Handle<T>) {
    const attached = handle.observe(event => {
      events.push(event)
      snapshots.push(handle.snapshot())
      return { kind: 'allow', private: canary }
    })
    snapshots.push(attached.snapshot)
    return () => {
      attached.unsubscribe()
    }
  }
  function verify<T>(
    handle: Handle<T>,
    status: number,
    dispatches: number,
    resources = 'released',
    invalidHints = true
  ) {
    snapshots.push(handle.snapshot())
    // All assertions are outside observer callbacks; observer failures cannot hide them.
    for (const item of [...events, ...snapshots]) record(item)
    for (const item of aggregates) {
      assert.deepEqual(
        Object.keys(item).sort(),
        [
          'sequence',
          'stopped',
          'guardOpen',
          'queued',
          'leasedAttempts',
          'sentActive',
          'effectiveParallelism',
          'serverNotBefore'
        ].sort()
      )
      assert.equal(Object.isFrozen(item), true)
      assert.ok(Object.values(item).every(value => ['number', 'boolean'].includes(typeof value)))
      assert.equal(JSON.stringify(item).includes(canary), false)
    }
    for (const type of ['dispatch-started', 'headers-received']) {
      const matching = events.filter(event => event.type === type)
      assert.equal(matching.length, dispatches * 2, 'BOTH_OBSERVERS_SEE_EACH_DISPATCH')
    }
    for (const type of ['operation-settled', 'resources-settled']) {
      const matching = events.filter(event => event.type === type)
      assert.equal(matching.length, 2, 'SETTLEMENT_ONCE_PER_OBSERVER')
      assert.ok(
        matching.every(event => event.status === status && event.dispatchCalls === dispatches)
      )
    }
    assert.equal(handle.snapshot().status, status)
    assert.equal(handle.snapshot().dispatchEntered, true)
    assert.equal(handle.snapshot().attempts, dispatches)
    assert.equal(handle.snapshot().dispatchCalls, dispatches)
    assert.equal(handle.snapshot().resources, resources)
    assert.equal(planner.snapshot().queued, 0)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    const observation: unknown = Reflect.get(planner, 'observation')
    assert.ok(observation instanceof OperationObservation)
    const diagnostics = observation.diagnostics.snapshot()
    assert.deepEqual(diagnostics, {
      OBSERVER_FAILED: 0,
      INVALID_HINT: invalidHints ? dispatches * 2 : 0,
      LATE_COMPLETION: 0,
      rejections: {}
    })
    assert.equal(JSON.stringify(diagnostics).includes(canary), false)
  }
  return {
    attach,
    verify,
    close: () => {
      plannerAttachment.unsubscribe()
    }
  }
}

function failure(error: unknown, cause: unknown, status: number, id: number) {
  assert.ok(error instanceof OperationError)
  assert.equal(error.code, 'CONSUME_FAILED')
  assert.equal(error.phase, 'consuming')
  assert.equal(error.operationId, id)
  assert.equal(error.attemptNumber, 1)
  assert.equal(error.dispatchEntered, true)
  assert.equal(error.serverOutcome, 'http-response')
  assert.equal(error.status, status)
  assert.equal(error.cause, cause, 'ORIGINAL_APPLICATION_CAUSE')
  return true
}

for (const [entry, Constructor] of [
  ['root', FetchPlanner],
  ['deep', DeepPlanner]
] as const) {
  for (const family of ['native', 'undici'] as const) {
    const label = `${entry}/${family}`
    test(`${label} all 299 non429 statuses reject active brands without replay`, async t => {
      const clock = createRuntime(t)
      let checked = 0
      for (let status = 300; status <= 599; status++) {
        if (status === 429) continue
        const current = status
        const input = source(Constructor, family, status, () => (current === 304 ? null : canary))
        const records = observe(input.planner)
        const cause = new ApplicationFailure({ errors, status })
        let brand: Error | undefined
        let unread: unknown
        let text: string | undefined
        const handle = input.planner.submit({
          method: 'POST',
          replay,
          prepare: () => ({
            url: `https://invalid.test/${canary}`,
            init: { body: canary, headers: { 'x-private': canary }, redirect: 'manual' }
          }),
          consume: async (response: Response | UndiciResponse, ctx: ConsumeContext) => {
            unread = {
              same: response === input.responses[0],
              used: response.bodyUsed,
              locked: response.body?.locked
            }
            text = await response.text()
            brand = ctx.retryableReadFailure(cause)
            throw brand
          }
        })
        const detach = records.attach(handle)
        try {
          await clock.flush()
          await clock.advance(3000)
          assert.equal(input.responses.length, 1, `NON2XX_DISPATCH_ONE status=${status}`)
          await assert.rejects(handle.result, error => failure(error, brand, status, handle.id))
          assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
          assert.deepEqual(
            unread,
            { same: true, used: false, locked: status === 304 ? undefined : false },
            'UNREAD_BODY'
          )
          assert.equal(text, status === 304 ? '' : canary)
          assert.ok(brand instanceof ConsumeReadFailure)
          assert.equal(brand.cause, cause)
          records.verify(handle, status, 1)
          checked++
        } finally {
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
          detach()
          records.close()
        }
      }
      assert.equal(checked, 299)
    })

    for (const fixture of fixtures) {
      for (const mode of ['value', 'application error', 'brand'] as const) {
        test(`${label} unread ${fixture.name} retains ${mode}`, async t => {
          const clock = createRuntime(t)
          const input = source(Constructor, family, fixture.status, () =>
            fixture.json ? JSON.stringify(fixture.payload) : String(fixture.payload)
          )
          const records = observe(input.planner)
          let cause: Error | undefined
          let value: { details: unknown } | undefined
          let app: ApplicationFailure | undefined
          let unread: unknown
          const handle = input.planner.submit({
            method: 'POST',
            replay,
            prepare: () => ({ url: `https://invalid.test/${canary}`, init: { body: canary } }),
            consume: async (response: Response | UndiciResponse, ctx: ConsumeContext) => {
              unread = {
                same: response === input.responses[0],
                used: response.bodyUsed,
                locked: response.body?.locked
              }
              const details: unknown = fixture.json ? await response.json() : await response.text()
              value = { details }
              if (mode === 'value') return value
              app = new ApplicationFailure(details)
              cause = mode === 'brand' ? ctx.retryableReadFailure(app) : app
              throw cause
            }
          })
          const detach = records.attach(handle)
          try {
            await clock.flush()
            await clock.advance(3000)
            assert.equal(input.responses.length, 1, 'NON2XX_DISPATCH_ONE')
            assert.deepEqual(unread, { same: true, used: false, locked: false }, 'UNREAD_BODY')
            if (mode === 'value') {
              const completed = await handle.result
              assert.equal(completed.value, value)
              assert.deepEqual(
                { ...completed },
                {
                  value: { details: fixture.payload },
                  status: fixture.status,
                  cleanup: 'released'
                }
              )
            } else {
              await assert.rejects(handle.result, error =>
                failure(error, cause, fixture.status, handle.id)
              )
              assert.deepEqual(
                app?.details,
                fixture.payload,
                'ALL_CODES_PARAMETERS_AND_BULK_INDICES'
              )
              if (mode === 'brand') assert.equal(cause?.cause, app)
            }
            await handle.resourcesDone
            records.verify(handle, fixture.status, 1)
          } finally {
            handle.abort()
            await Promise.allSettled([handle.result, handle.resourcesDone])
            detach()
            records.close()
          }
        })
      }
    }

    test(`${label} positive branded 2xx retries twice while arbitrary TypeError stays terminal`, async t => {
      const clock = createRuntime(t)
      for (const branded of [true, false]) {
        const input = source(Constructor, family, 200, () => canary)
        const records = observe(input.planner)
        const cause = new TypeError(canary)
        const prepares: number[] = []
        let thrown: Error | undefined
        let discarded = 0
        let disposed = 0
        const handle = input.planner.submit({
          method: 'PUT',
          entityKey: canary,
          replay,
          prepare: ctx => {
            prepares.push(ctx.attemptNumber)
            ctx.onDispose(() => {
              disposed++
            })
            return { url: `https://invalid.test/${canary}`, init: { body: canary } }
          },
          consume: async (response: Response | UndiciResponse, ctx: ConsumeContext) => {
            const text = await response.text()
            if (ctx.attemptNumber === 1) {
              ctx.onDiscard(() => {
                discarded++
              })
              thrown = branded ? ctx.retryableReadFailure(cause) : cause
              throw thrown
            }
            return { text }
          }
        })
        const detach = records.attach(handle)
        try {
          await clock.flush()
          await clock.advance(3000)
          assert.equal(
            input.responses.length,
            branded ? 2 : 1,
            'POSITIVE_RETRY_MUST_ENTER_SECOND_DISPATCH'
          )
          if (branded) {
            assert.deepEqual(
              { ...(await handle.result) },
              {
                value: { text: canary },
                status: 200,
                cleanup: 'released'
              }
            )
            assert.deepEqual(prepares, [1, 2])
            assert.notEqual(input.responses[0], input.responses[1])
            assert.ok(thrown instanceof ConsumeReadFailure)
            assert.equal(thrown.cause, cause)
          } else await assert.rejects(handle.result, error => failure(error, cause, 200, handle.id))
          await handle.resourcesDone
          assert.equal(discarded, 1)
          assert.equal(disposed, branded ? 2 : 1)
          records.verify(handle, 200, branded ? 2 : 1)
        } finally {
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
          detach()
          records.close()
        }
      }
    })

    for (const cleanup of ['pending', 'rejected'] as const) {
      test(`${label} successful 412 value survives ${cleanup} disposal without replay`, async t => {
        const clock = createRuntime(t)
        const gate = deferred<undefined>()
        const input = source(Constructor, family, 412, () => JSON.stringify({ errors }))
        const records = observe(input.planner)
        let value: { details: unknown } | undefined
        let disposed = 0
        let discarded = 0
        let resourceSettlements = 0
        const handle = input.planner.submit({
          method: 'POST',
          replay,
          prepare: ctx => {
            ctx.onDispose(async () => {
              disposed++
              if (cleanup === 'pending') await gate.promise
              else throw new Error(`${canary} cleanup`)
            })
            return { url: canary, init: { body: canary } }
          },
          consume: async (response: Response | UndiciResponse, ctx: ConsumeContext) => {
            ctx.onDiscard(() => {
              discarded++
            })
            value = { details: await response.json() }
            return value
          }
        })
        const detach = records.attach(handle)
        void handle.resourcesDone.then(() => {
          resourceSettlements++
        })
        try {
          await clock.flush()
          if (cleanup === 'pending') {
            assert.equal(handle.snapshot().resultCommitted, true)
            assert.equal(input.planner.snapshot().leasedAttempts, 1)
            assert.equal(input.planner.snapshot().sentActive, 1)
            assert.equal(resourceSettlements, 0, 'PENDING_DISPOSAL_OWNS_RESOURCES')
            await clock.advance(5000)
          }
          const completed = await handle.result
          assert.equal(completed.value, value, 'COMMITTED_VALUE_MUST_SURVIVE')
          assert.deepEqual(completed.value.details, { errors })
          assert.equal(completed.status, 412)
          assert.equal(completed.cleanup, cleanup === 'pending' ? 'pending' : 'failed')
          if (cleanup === 'pending') {
            assert.equal(handle.snapshot().resources, 'pending')
            assert.equal(input.planner.snapshot().leasedAttempts, 1)
            assert.equal(input.planner.snapshot().sentActive, 1)
            assert.equal(resourceSettlements, 0)
          }
          gate.resolve(undefined)
          await handle.resourcesDone
          await clock.advance(3000)
          assert.equal(disposed, 1)
          assert.equal(discarded, 0)
          assert.equal(input.responses.length, 1, 'COMMITTED_NON2XX_MUST_NOT_REPLAY')
          records.verify(handle, 412, 1, cleanup === 'pending' ? 'released' : 'failed')
        } finally {
          gate.resolve(undefined)
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
          detach()
          records.close()
        }
      })
    }

    for (const status of [412, 200]) {
      test(`${label} broken ${status} preserves actual bytes and cause despite cleanup errors`, async t => {
        const clock = createRuntime(t)
        const gate = deferred<undefined>()
        const original = new Error(`${canary} socket`)
        const prefix = `{"errors":[{"code":3000,"parameter":"agent","error":"${canary}"},`
        let pulls = 0
        const input = source(
          Constructor,
          family,
          status,
          () =>
            new ReadableStream<Uint8Array>(
              {
                async pull(controller) {
                  if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(prefix))
                  else {
                    await gate.promise
                    controller.error(original)
                  }
                }
              },
              { highWaterMark: 0 }
            )
        )
        const records = observe(input.planner)
        let unread: unknown
        let readCause: unknown
        let received = ''
        let app: ApplicationFailure | undefined
        let brand: Error | undefined
        let discarded = 0
        let disposed = 0
        const handle = input.planner.submit({
          method: 'POST',
          replay,
          prepare: () => ({ url: canary, init: { body: canary } }),
          consume: async (response: Response | UndiciResponse, ctx: ConsumeContext) => {
            unread = {
              same: response === input.responses[0],
              used: response.bodyUsed,
              locked: response.body?.locked
            }
            ctx.onDispose(() => {
              disposed++
              throw new Error(`${canary} disposer`)
            })
            ctx.onDiscard(() => {
              discarded++
              throw new Error(`${canary} discard`)
            })
            const reader = response.body?.getReader()
            assert.ok(reader)
            try {
              const first = await reader.read()
              const bytes: unknown = first.value
              assert.ok(bytes instanceof Uint8Array)
              received = new TextDecoder().decode(bytes)
              gate.resolve(undefined)
              try {
                await reader.read()
              } catch (error) {
                readCause = error
              }
            } finally {
              reader.releaseLock()
            }
            app = new ApplicationFailure(
              { prefix: received, contentType: response.headers.get('content-type') },
              readCause
            )
            brand = ctx.retryableReadFailure(app)
            throw brand
          }
        })
        const detach = records.attach(handle)
        try {
          await assert.rejects(handle.result, error => failure(error, brand, status, handle.id))
          assert.deepEqual(await handle.resourcesDone, { resources: 'failed' })
          await clock.advance(3000)
          assert.deepEqual(unread, { same: true, used: false, locked: false }, 'UNREAD_BODY')
          assert.equal(received, prefix)
          assert.equal(readCause, original)
          assert.equal(app?.cause, original)
          assert.deepEqual(app.details, { prefix, contentType: 'application/json' })
          assert.equal(brand?.cause, app)
          assert.equal(disposed, 1)
          assert.equal(discarded, 1)
          assert.equal(input.responses.length, 1, 'FAILED_CLEANUP_MUST_NOT_REPLAY')
          records.verify(handle, status, 1, 'failed')
        } finally {
          gate.resolve(undefined)
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
          detach()
          records.close()
        }
      })
    }
  }
}

// Concurrent finite children keep real retry delays inside the existing runner budget.
test('native and undici same-operation upload retry owns both cleanup barriers and exits naturally', async () => {
  await Promise.all(
    ['native', 'undici'].flatMap(family =>
      ['producer-first', 'disposer-first', 'reject', 'fail', 'timeout'].map(async mode => {
        const child = spawn(
          process.execPath,
          [
            '--unhandled-rejections=strict',
            new URL('./upload-source.js', import.meta.url).pathname,
            family,
            `retry-${mode}`
          ],
          { timeout: 15000 }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk
        })
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once('error', reject)
            child.once('close', (code, signal) => {
              resolve({ code, signal })
            })
          }
        )
        const raw = stdout + stderr
        assert.equal(result.signal, null, raw)
        assert.match(stdout, /"event":"retry-ready"/, raw)
        assert.match(
          stdout,
          /"event":"retry-finally-clean".*"producerPending":0,"sockets":0,"serverListening":false,"agentsClosed":2/,
          raw
        )
        assert.equal(result.code, mode === 'fail' || mode === 'timeout' ? 1 : 0, raw)
        if (mode === 'fail') assert.match(stderr, /INJECTED_RETRY_AFTER_HEADERS/, raw)
        else if (mode === 'timeout') assert.match(stderr, /WATCHDOG_RETRY_UPLOAD/, raw)
        else {
          assert.doesNotMatch(raw, /WATCHDOG|ERR_ASSERTION/)
          assert.match(stdout, /"event":"retry-complete"/, raw)
        }
      })
    )
  )
})

// Hold delivery of an actual coordinator wake, never a policy field or an entry.
// The receipt/control is delivered in a later host microtask before this wake runs.
function holdWake(t: import('node:test').TestContext) {
  const enqueue = globalThis.queueMicrotask
  let armed = false
  let held: (() => void) | undefined
  t.mock.method(globalThis, 'queueMicrotask', (callback: () => void) => {
    if (armed && !held) {
      armed = false
      held = callback
    } else enqueue(callback)
  })
  return {
    arm() {
      armed = true
    },
    get pending() {
      return held !== undefined
    },
    release() {
      const callback = held
      held = undefined
      if (callback) enqueue(callback)
    },
    change(callback: () => void) {
      enqueue(callback)
    }
  }
}

for (const safety of [
  'stop',
  'abort',
  'deadline',
  'pause',
  'pacing',
  'effective',
  'guard'
] as const) {
  test(`T72 real receipt admission rechecks ${safety} in a microtask after wake`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    t.after(() => {
      assert.equal(timers.active.size, 0, 'COORDINATOR_TIMER_RETIRED')
    })
    const wake = holdWake(t)
    const receipt = deferred<Response>()
    const disposal = deferred<undefined>()
    const prepare = deferred<undefined>()
    const permanent = ['stop', 'abort', 'deadline', 'guard'].includes(safety)
    const sends: {
      at: number
      guard: boolean
      pause: number
      active: number
      effective: number
    }[] = []
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        const snapshot = planner.snapshot()
        sends.push({
          at: performance.now(),
          guard: snapshot.guardOpen,
          pause: snapshot.serverNotBefore,
          active: snapshot.sentActive,
          effective: snapshot.effectiveParallelism
        })
        if (sends.length === 1) return receipt.promise
        return Promise.resolve(
          new Response(canary, {
            headers: sends.length === 2 ? { 'x-lognex-reset': '100' } : {}
          })
        )
      },
      {
        maxParallelLimit: safety === 'effective' ? 2 : 4,
        jitter: 0,
        ...(safety === 'guard' ? { errorPerMinuteLimit: 1 } : {})
      }
    )
    const current = planner.submit({
      method: 'POST',
      replay: { serverSafe: false, consumeSafe: false },
      prepare: ctx => {
        if (safety === 'effective') ctx.onDispose(() => disposal.promise)
        return { url: canary, init: { body: canary } }
      },
      consume: response => response.text()
    })
    const seed = planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: canary, init: {} }),
      consume: response => response.text()
    })
    const candidates: Handle<string>[] = []
    const trace: unknown[] = []
    const subscription = planner.observe(event => {
      trace.push(event, planner.snapshot())
    })
    try {
      await clock.flush()
      await seed.resourcesDone
      assert.equal(sends.length, 2)
      for (let i = 0; i < 2; i++)
        candidates.push(
          planner.submit({
            method: 'GET',
            replay,
            deadlineMs: safety === 'deadline' ? 101 : 20000,
            prepare: async () => {
              await prepare.promise
              return { url: canary, init: {} }
            },
            consume: response => response.text()
          })
        )
      await clock.flush()
      assert.equal(candidates[0]?.snapshot().phase, 'preparing')
      prepare.resolve(undefined)
      await clock.flush()
      assert.equal(candidates[0].snapshot().phase, 'ready')
      if (safety !== 'effective') assert.equal(candidates[1]?.snapshot().phase, 'ready')
      const origin = performance.now()
      wake.arm()
      clock.tick(100)
      assert.equal(wake.pending, true, 'ACTUAL_TIMER_WAKE_HELD')
      wake.change(() => {
        if (safety === 'stop') planner.stop(canary)
        else if (safety === 'abort') for (const handle of candidates) handle.abort(canary)
        else if (safety === 'deadline') t.mock.method(performance, 'now', () => origin + 101)
        else
          receipt.resolve(
            new Response(safety === 'effective' ? '{"errors":[{"code":1073}]}' : canary, {
              status: safety === 'effective' ? 429 : safety === 'guard' ? 412 : 200,
              headers:
                safety === 'pause'
                  ? { 'x-lognex-reset': '400' }
                  : safety === 'pacing'
                    ? {
                        'x-ratelimit-limit': '10',
                        'x-ratelimit-remaining': '0',
                        'x-lognex-retry-timeinterval': '1000'
                      }
                    : safety === 'effective'
                      ? { 'content-type': 'application/json' }
                      : {}
            })
          )
      })
      await clock.flush()
      assert.equal(sends.length, 2, 'NO_SEND_WHILE_WAKE_DELIVERY_HELD')
      if (safety === 'pause') assert.equal(planner.snapshot().serverNotBefore, origin + 500)
      if (safety === 'effective') {
        assert.equal(planner.snapshot().effectiveParallelism, 1)
        assert.equal(planner.snapshot().sentActive, 1, 'DISPOSER_STILL_OWNS_SENT_TOKEN')
      }
      if (safety === 'guard') assert.equal(planner.snapshot().guardOpen, true)
      wake.release()
      await clock.flush()
      assert.equal(sends.length, 2, `FINAL_${safety.toUpperCase()}_MUST_BLOCK_ACTUAL_TRANSPORT`)
      if (permanent) {
        const code =
          safety === 'stop'
            ? 'STOPPED'
            : safety === 'abort'
              ? 'ABORTED'
              : safety === 'deadline'
                ? 'DEADLINE'
                : 'GUARD_OPEN'
        for (const handle of candidates)
          await assert.rejects(handle.result, { code, dispatchEntered: false })
      } else {
        if (safety === 'pause') {
          clock.jumpWall(-20000000)
          await clock.advance(399)
          assert.equal(sends.length, 2, 'RECEIPT_PAUSE_MINUS_ONE')
          await clock.advance(1)
        } else if (safety === 'pacing') {
          // Preserved 003 formula at elapsed100: round(.9^5 * 3000)=1771.
          await clock.advance(1770)
          assert.equal(sends.length, 2, 'INVALIDATED_PACING_CACHE_MINUS_ONE')
          await clock.advance(1)
          assert.equal(sends.length, 3, 'ONE_READY_SEND_PER_PACING_INTERVAL')
          await clock.advance(3000)
        } else {
          disposal.resolve(undefined)
          await clock.flush()
        }
        assert.equal(sends.length, 4, 'RECOVERABLE_SAFETY_RESUMES_ALL_READY_WITHOUT_STARVATION')
        for (const handle of candidates) assert.equal((await handle.result).value, canary)
      }
      for (const send of sends) {
        assert.equal(send.guard, false, 'ACTUAL_TRANSPORT_AFTER_GUARD_OPEN')
        assert.ok(send.at >= send.pause, 'ACTUAL_TRANSPORT_BEFORE_RECEIPT_DEADLINE')
        assert.ok(send.active <= send.effective, 'ACTUAL_TRANSPORT_OVER_EFFECTIVE_LIMIT')
      }
      assert.equal(JSON.stringify(trace).includes(canary), false)
    } finally {
      wake.release()
      prepare.resolve(undefined)
      disposal.resolve(undefined)
      receipt.resolve(new Response('cleanup'))
      planner.stop()
      for (const handle of [current, seed, ...candidates]) handle.abort()
      await Promise.allSettled(
        [current, seed, ...candidates].flatMap(handle => [handle.result, handle.resourcesDone])
      )
      subscription.unsubscribe()
    }
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    assert.equal(planner.snapshot().queued, 0)
  })
}

for (const status of [412, 429]) {
  for (const terminal of ['current', 'abort', 'deadline'] as const) {
    test(`T72 late100th ${status}/${terminal} blocks wake before fanout with another classifier pending`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      t.after(() => {
        assert.equal(timers.active.size, 0, 'COORDINATOR_TIMER_RETIRED')
      })
      const wake = holdWake(t)
      const lateReceipt = deferred<Response>()
      const parser = deferred<undefined>()
      const preparing = deferred<undefined>()
      const origin = performance.now()
      let calls = 0
      let classifierReads = 0
      let lateConsumes = 0
      const planner = new DeepPlanner<typeof fetch>(
        () => {
          calls++
          if (calls === 98)
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>(
                  {
                    async pull(controller) {
                      classifierReads++
                      await parser.promise
                      controller.enqueue(new TextEncoder().encode('{}'))
                      controller.close()
                    }
                  },
                  { highWaterMark: 0 }
                ),
                { status: 429, headers: { 'content-type': 'application/json' } }
              )
            )
          if (calls === 99) return lateReceipt.promise
          return Promise.resolve(
            new Response(canary, {
              status: status === 429 ? 429 : 412,
              headers: calls === 100 ? { 'x-lognex-reset': '100' } : {}
            })
          )
        },
        { maxParallelLimit: 4, jitter: 0, ...(status === 429 ? { errorPerMinuteLimit: 1000 } : {}) }
      )
      const submit = () =>
        planner.submit({
          method: 'POST',
          replay: { serverSafe: false, consumeSafe: false },
          prepare: () => ({ url: canary, init: { body: canary } }),
          consume: response => response.text()
        })
      const finish = async (handle: Handle<string>) => {
        if (status === 429) await assert.rejects(handle.result, { code: 'HTTP_FAILED', status })
        else assert.equal((await handle.result).status, status)
        await handle.resourcesDone
      }
      const handles: Handle<string>[] = []
      const fanout: { listener: number; guard: boolean; calls: number; pending: string }[] = []
      const records: unknown[] = []
      let nested: Handle<string> | undefined
      let armed = false
      const attachments = [1, 2].map(listener =>
        planner.observe(event => {
          records.push(event, planner.snapshot())
          if (!armed || event.type !== 'headers-received') return
          fanout.push({
            listener,
            guard: planner.snapshot().guardOpen,
            calls,
            pending: handles[0]?.snapshot().outcome ?? 'missing'
          })
          if (listener === 1) nested = submit()
        })
      )
      try {
        for (let i = 0; i < 97; i++) await finish(submit())
        const classifying = submit()
        handles.push(classifying)
        await clock.flush()
        assert.equal(classifierReads, 1)
        assert.equal(classifying.snapshot().phase, 'classifying')
        const late = planner.submit({
          method: 'POST',
          replay: { serverSafe: false, consumeSafe: false },
          deadlineMs: terminal === 'deadline' ? 50 : 20000,
          prepare: () => ({ url: canary, init: { body: canary } }),
          consume: async response => {
            lateConsumes++
            return response.text()
          }
        })
        handles.push(late)
        await clock.flush()
        await finish(submit())
        assert.equal(calls, 100)
        assert.equal(planner.snapshot().guardOpen, false, 'REAL_RECEIPT_99_BASELINE')
        for (let i = 0; i < 2; i++)
          handles.push(
            planner.submit({
              method: 'GET',
              replay,
              prepare: async () => {
                await preparing.promise
                return { url: canary, init: {} }
              },
              consume: response => response.text()
            })
          )
        await clock.flush()
        preparing.resolve(undefined)
        await clock.flush()
        assert.deepEqual(
          handles.slice(2).map(handle => handle.snapshot().phase),
          ['ready', 'ready']
        )
        let original: unknown
        if (terminal !== 'current') {
          if (terminal === 'abort') late.abort(canary)
          else await clock.advance(50)
          await assert.rejects(late.result, error => {
            original = error
            return (
              error instanceof OperationError &&
              error.code === (terminal === 'abort' ? 'ABORTED' : 'DEADLINE')
            )
          })
          assert.equal(planner.snapshot().sentActive, 2, 'LATE_SENT_WORK_RETAINS_ACCOUNTING')
        }
        wake.arm()
        clock.tick(terminal === 'deadline' ? 50 : 100)
        assert.equal(wake.pending, true)
        armed = true
        wake.change(() => {
          lateReceipt.resolve(
            new Response('{', {
              status,
              headers: {
                'content-type': 'application/json',
                'x-lognex-reset': canary,
                'retry-after': canary
              }
            })
          )
        })
        await clock.flush()
        assert.equal(planner.snapshot().guardOpen, true)
        assert.equal(calls, 100, 'LATE100_RECEIPT_PREVENTS_NEXT_ACTUAL_SEND')
        assert.deepEqual(
          fanout,
          [1, 2].map(listener => ({ listener, guard: true, calls: 100, pending: 'pending' }))
        )
        assert.ok(nested)
        await assert.rejects(nested.result, { code: 'GUARD_OPEN', operationId: 0 })
        wake.release()
        await clock.flush()
        assert.equal(calls, 100, 'NO_CACHED_WAKE_PERMIT_AFTER_GUARD_OPEN')
        for (const ready of handles.slice(2))
          await assert.rejects(ready.result, { code: 'GUARD_OPEN', dispatchEntered: false })
        if (terminal === 'current') {
          if (status === 429)
            await assert.rejects(late.result, { code: 'HTTP_FAILED', status: 429 })
          else assert.equal((await late.result).value, '{')
        } else await assert.rejects(late.result, error => error === original)
        assert.equal(
          late.snapshot().status,
          status,
          'LATE_STATUS_RECORDED_WITHOUT_REPLACING_PRIMARY_RESULT'
        )
        assert.equal(lateConsumes, terminal === 'current' && status === 412 ? 1 : 0)
        assert.equal(
          classifying.snapshot().outcome,
          'pending',
          'GUARD_PRESERVES_CURRENT_SENT_CLASSIFIER'
        )
        assert.equal(planner.snapshot().sentActive, 1)
        parser.resolve(undefined)
        await assert.rejects(classifying.result, { code: 'HTTP_FAILED', status: 429 })
        await Promise.all(handles.map(handle => handle.resourcesDone))
        const observation: unknown = Reflect.get(planner, 'observation')
        assert.ok(observation instanceof OperationObservation)
        assert.equal(observation.diagnostics.snapshot().OBSERVER_FAILED, 0)
        assert.equal(observation.diagnostics.snapshot().INVALID_HINT, 2)
        assert.equal(JSON.stringify(records).includes(canary), false)
        assert.equal(performance.now(), origin + 100)
        assert.equal(planner.snapshot().leasedAttempts, 0)
        assert.equal(planner.snapshot().sentActive, 0)
      } finally {
        armed = false
        wake.release()
        parser.resolve(undefined)
        preparing.resolve(undefined)
        lateReceipt.resolve(new Response('cleanup'))
        planner.stop()
        for (const handle of handles) handle.abort()
        await Promise.allSettled(
          [...handles, ...(nested ? [nested] : [])].flatMap(handle => [
            handle.result,
            handle.resourcesDone
          ])
        )
        for (const attachment of attachments) attachment.unsubscribe()
      }
    })
  }
}

test('T72 receipts during prepare clamp effective and retain maximum pause through stale success and recovery', async t => {
  const clock = createRuntime(t)
  const timers = trackTimeouts(t)
  t.after(() => {
    assert.equal(timers.active.size, 0, 'COORDINATOR_TIMER_RETIRED')
  })
  const origin = performance.now()
  const replies = Array.from({ length: 4 }, () => deferred<Response>())
  const prepare = deferred<undefined>()
  const consume = deferred<undefined>()
  const entered: { at: number; active: number; effective: number }[] = []
  const planner = new FetchPlanner<typeof fetch>(
    () => {
      entered.push({
        at: performance.now(),
        active: planner.snapshot().sentActive,
        effective: planner.snapshot().effectiveParallelism
      })
      const reply = replies[entered.length - 1]
      return reply ? reply.promise : Promise.resolve(new Response(canary))
    },
    { maxParallelLimit: 4, jitter: 0 }
  )
  const seeds = Array.from({ length: 4 }, () =>
    planner.submit({
      method: 'GET',
      replay: { serverSafe: false, consumeSafe: false },
      prepare: () => ({ url: canary, init: {} }),
      consume: response => response.text()
    })
  )
  const candidates: Handle<string>[] = []
  const overflow = (pause: number) =>
    new Response('{"errors":[{"code":1073}]}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'x-lognex-reset': String(pause) }
    })
  try {
    await clock.flush()
    assert.equal(entered.length, 4)
    replies[0]?.resolve(overflow(1000))
    await seeds[0]?.resourcesDone
    for (let i = 0; i < 3; i++)
      candidates.push(
        planner.submit({
          method: 'GET',
          replay,
          prepare: async () => {
            await prepare.promise
            return { url: canary, init: {} }
          },
          consume: async response => {
            await consume.promise
            return response.text()
          }
        })
      )
    await clock.flush()
    assert.equal(candidates[0]?.snapshot().phase, 'preparing')
    replies[1]?.resolve(overflow(500))
    await seeds[1]?.resourcesDone
    replies[2]?.resolve(overflow(2000))
    await seeds[2]?.resourcesDone
    assert.equal(planner.snapshot().effectiveParallelism, 1, 'REAL_1073_CLAMP')
    assert.equal(planner.snapshot().serverNotBefore, origin + 2000)
    clock.jumpWall(20000000)
    replies[3]?.resolve(new Response('old-success', { headers: { 'x-lognex-reset': '10' } }))
    assert.equal((await seeds[3]?.result)?.value, 'old-success')
    await seeds[3]?.resourcesDone
    assert.equal(
      planner.snapshot().serverNotBefore,
      origin + 2000,
      'OUT_OF_ORDER_SUCCESS_CANNOT_SHORTEN_PAUSE'
    )
    prepare.resolve(undefined)
    await clock.flush()
    assert.deepEqual(
      candidates.map(handle => handle.snapshot().phase),
      ['ready', 'ready', 'ready']
    )
    clock.jumpWall(-40000000)
    await clock.advance(1999)
    assert.equal(entered.length, 4, 'PREPARE_CANNOT_CACHE_PRE_RECEIPT_PERMIT')
    await clock.advance(1)
    assert.equal(entered.length, 5, 'ONLY_ONE_READY_ENTERS_REDUCED_EFFECTIVE')
    await clock.advance(8000)
    assert.equal(planner.snapshot().effectiveParallelism, 1, 'RECOVERY_STRICT_PERIOD_EQUALITY')
    assert.equal(entered.length, 5)
    await clock.advance(1)
    assert.equal(planner.snapshot().effectiveParallelism, 2)
    assert.equal(entered.length, 6, 'RECOVERY_DISPATCHES_WITHOUT_NEW_RECEIPT')
    assert.equal(planner.snapshot().serverNotBefore, origin + 2000)
    consume.resolve(undefined)
    await clock.flush()
    assert.equal(entered.length, 7, 'ALL_READY_RESUME_WITHOUT_STARVATION')
    for (const handle of candidates) assert.equal((await handle.result).value, canary)
    assert.ok(entered.every(send => send.active <= send.effective))
    assert.deepEqual(
      entered.slice(4).map(send => send.at),
      [origin + 2000, origin + 10001, origin + 10001]
    )
    for (const seed of seeds.slice(0, 3))
      await assert.rejects(seed.result, { code: 'HTTP_FAILED', status: 429 })
  } finally {
    prepare.resolve(undefined)
    consume.resolve(undefined)
    for (const reply of replies) reply.resolve(new Response('cleanup'))
    planner.stop()
    for (const handle of [...seeds, ...candidates]) handle.abort()
    await Promise.allSettled(
      [...seeds, ...candidates].flatMap(handle => [handle.result, handle.resourcesDone])
    )
  }
  assert.equal(planner.snapshot().leasedAttempts, 0)
  assert.equal(planner.snapshot().sentActive, 0)
})

for (const seedCount of [58, 59]) {
  test(`T72 PUT retry after ${seedCount} sends charges only actual admission at 60 and rejects 61`, async t => {
    const clock = createRuntime(t)
    const timers = trackTimeouts(t)
    t.after(() => {
      assert.equal(timers.active.size, 0, 'COORDINATOR_TIMER_RETIRED')
    })
    let sends = 0
    const preparations: number[] = []
    const planner = new FetchPlanner<typeof fetch>(
      () => {
        sends++
        return Promise.resolve(
          new Response(canary, {
            status: sends === seedCount + 1 ? 429 : 200,
            headers: sends === seedCount + 1 ? { 'x-lognex-reset': '500' } : {}
          })
        )
      },
      { jitter: 0 }
    )
    const spec = {
      method: 'PUT' as const,
      entityKey: canary,
      replay,
      prepare: () => ({ url: canary, init: { body: canary } }),
      consume: (response: Response) => response.text()
    }
    const handles: Handle<string>[] = []
    try {
      for (let i = 0; i < seedCount; i++) {
        const seed = planner.submit(spec)
        await seed.result
        await seed.resourcesDone
      }
      const retry = planner.submit({
        ...spec,
        prepare: ctx => {
          preparations.push(ctx.attemptNumber)
          return spec.prepare()
        }
      })
      handles.push(retry)
      await clock.flush()
      assert.equal(retry.snapshot().phase, 'retry-wait')
      const cancelled = planner.submit(spec)
      handles.push(cancelled)
      await clock.flush()
      assert.equal(cancelled.snapshot().phase, 'ready')
      assert.equal(sends, seedCount + 1, 'DEFERRED_PUT_DOES_NOT_ENTER_TRANSPORT')
      cancelled.abort()
      await assert.rejects(cancelled.result, { code: 'ABORTED', dispatchEntered: false })
      await cancelled.resourcesDone
      await clock.advance(2999)
      assert.equal(sends, seedCount + 1)
      await clock.advance(1)
      assert.deepEqual(preparations, [1, 2], 'FRESH_RETRY_PREPARE_IS_NOT_A_PUT_CHARGE')
      if (seedCount === 58) {
        assert.equal((await retry.result).value, canary)
        assert.equal(retry.snapshot().dispatchCalls, 2, 'ACTUAL_RETRY_IS_PUT60')
      } else await assert.rejects(retry.result, { code: 'PUT_LIMIT', attemptNumber: 2 })
      await retry.resourcesDone
      assert.equal(sends, 60, 'ACTUAL_PUT61_MUST_NOT_ENTER')
      const denied = planner.submit(spec)
      handles.push(denied)
      await assert.rejects(denied.result, { code: 'PUT_LIMIT', dispatchEntered: false })
      const other = planner.submit({ ...spec, entityKey: `${canary}2` })
      handles.push(other)
      assert.equal((await other.result).value, canary)
      assert.equal(sends, 61, 'ANOTHER_ENTITY_STILL_DISPATCHES')
      assert.equal(planner.snapshot().guardOpen, false)
    } finally {
      planner.stop()
      for (const handle of handles) handle.abort()
      await Promise.allSettled(handles.flatMap(handle => [handle.result, handle.resourcesDone]))
    }
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
  })
}
