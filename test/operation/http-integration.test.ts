import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import { ConsumeReadFailure } from '../../src/operation-types.js'
import type { ConsumeContext, Event, Handle, Snapshot } from '../../src/operation-types.js'
import { OperationObservation } from '../../src/operation-observation.js'
import { createRuntime, deferred } from './helpers.js'

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
