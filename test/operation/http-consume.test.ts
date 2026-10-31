import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import { ConsumeReadFailure } from '../../src/operation-types.js'
import type { ConsumeContext, Event, Handle, Snapshot } from '../../src/operation-types.js'
import { OperationObservation } from '../../src/operation-observation.js'
import { createRuntime, deferred } from './helpers.js'

const canary = 'T24_PRIVATE_DETAIL_7e6c'
const replay = { serverSafe: true, consumeSafe: true }
const errors = [
  { code: 3000, parameter: 'agent', error: `${canary} missing agent`, line: 1, column: 2 },
  {
    code: 3006,
    parameter: 'name',
    error: `${canary} duplicate name`,
    moreInfo: 'https://example.invalid/error_3006'
  },
  { code: 0, error: `${canary} unspecified` }
]
const bulk = [{ id: `${canary}-created-first` }, { errors }, { id: `${canary}-created-last` }]
const html = `<html><body>${canary} gateway unavailable</body></html>`
const fixtures = [
  { name: 'multi-errors', status: 412, payload: { errors }, format: 'json' },
  { name: 'mixed-bulk', status: 412, payload: bulk, format: 'json' },
  {
    name: 'mixed-delete',
    status: 409,
    payload: [{ info: `${canary} deleted` }, { errors }],
    format: 'json'
  },
  { name: 'html', status: 503, payload: html, format: 'text' },
  { name: 'manual-redirect', status: 302, payload: html, format: 'text' }
] as const

type Family = 'native/root' | 'undici7.3/deep'
type Body = string | ReadableStream<Uint8Array> | null

class ApplicationFailure extends Error {
  constructor(
    readonly details: unknown,
    cause?: unknown
  ) {
    super(`${canary} application failure`, { cause })
  }
}

function fixture(family: Family, body: Body, status: number) {
  const headers = {
    'content-type':
      typeof body === 'string' && body.startsWith('<') ? 'text/html' : 'application/json',
    'x-private-detail': canary,
    'x-lognex-retry-after': 'malformed',
    'retry-after': 'not-a-date'
  }
  let calls = 0
  if (family === 'native/root') {
    const response = new Response(body, { status, headers })
    const planner = new FetchPlanner<typeof fetch>(() => {
      calls++
      return Promise.resolve(response)
    })
    return { response, planner, calls: () => calls }
  }
  const response = new UndiciResponse(body, { status, headers })
  const planner = new DeepPlanner<typeof undiciFetch>(() => {
    calls++
    return Promise.resolve(response)
  })
  return { response, planner, calls: () => calls }
}

function checkRecord(record: Snapshot | Event) {
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
  assert.deepEqual(Object.keys(record).sort(), keys.sort(), 'EXACT_RECORD_ALLOWLIST')
  assert.equal(Object.isFrozen(record), true)
  assert.ok(
    Object.values(record).every(value => ['number', 'boolean', 'string'].includes(typeof value))
  )
  assert.equal(JSON.stringify(record).includes(canary), false, 'OBSERVATION_PRIVATE_DETAILS')
}

function observe(planner: ReturnType<typeof fixture>['planner']) {
  const events: Event[] = []
  const snapshots: Snapshot[] = []
  const plannerSnapshots = [planner.snapshot()]
  const attached = planner.observe(event => {
    events.push(event)
    plannerSnapshots.push(planner.snapshot())
  })
  plannerSnapshots.push(attached.snapshot)
  function attach<T>(handle: Handle<T>) {
    const attachment = handle.observe(event => {
      events.push(event)
      snapshots.push(handle.snapshot())
    })
    snapshots.push(attachment.snapshot)
  }
  function verify<T>(handle: Handle<T>, status: number) {
    snapshots.push(handle.snapshot(), handle.observe(() => undefined).snapshot)
    for (const record of [...events, ...snapshots]) checkRecord(record)
    for (const record of plannerSnapshots) {
      assert.deepEqual(
        Object.keys(record).sort(),
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
      assert.equal(Object.isFrozen(record), true)
      assert.equal(JSON.stringify(record).includes(canary), false)
    }
    assert.ok(events.some(event => event.type === 'headers-received' && event.status === status))
    assert.ok(events.some(event => event.type === 'operation-settled' && event.status === status))
    assert.ok(events.some(event => event.type === 'resources-settled' && event.status === status))
    const observation: unknown = Reflect.get(planner, 'observation')
    assert.ok(observation instanceof OperationObservation)
    assert.deepEqual(observation.diagnostics.snapshot(), {
      OBSERVER_FAILED: 0,
      INVALID_HINT: 0,
      LATE_COMPLETION: 0,
      rejections: {}
    })
    assert.equal(handle.snapshot().dispatchCalls, 1, 'NON2XX_MUST_NOT_REPLAY')
    assert.equal(handle.snapshot().attempts, 1, 'NO_SECOND_PREPARE')
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    attached.unsubscribe()
  }
  return { attach, verify }
}

function httpFailure(error: unknown, cause: unknown, status: number) {
  assert.ok(error instanceof OperationError)
  assert.equal(error.code, 'CONSUME_FAILED')
  assert.equal(error.phase, 'consuming')
  assert.equal(error.status, status)
  assert.equal(error.serverOutcome, 'http-response')
  assert.equal(error.dispatchEntered, true)
  assert.equal(error.cause, cause, 'PRIMARY_CAUSE_IDENTITY')
  return true
}

for (const family of ['native/root', 'undici7.3/deep'] as const) {
  for (const item of fixtures) {
    for (const mode of ['result', 'typed-error'] as const) {
      test(`${family} unread ${item.name} preserves ${mode} and HTTP facts`, async () => {
        const body = item.format === 'json' ? JSON.stringify(item.payload) : item.payload
        const source = fixture(family, body, item.status)
        const records = observe(source.planner)
        const reads: { same: boolean; used: boolean; locked: boolean | undefined }[] = []
        let prepared = 0
        let value: { details: unknown } | undefined
        let failure: ApplicationFailure | undefined
        const handle = source.planner.submit({
          method: item.name === 'mixed-delete' ? 'DELETE' : 'POST',
          replay,
          prepare: () => {
            prepared++
            return {
              url: `https://example.invalid/${canary}`,
              init: { redirect: 'manual', body: canary }
            }
          },
          consume: async (response: Response | UndiciResponse) => {
            reads.push({
              same: response === source.response,
              used: response.bodyUsed,
              locked: response.body?.locked
            })
            assert.equal(response.bodyUsed, false, 'CONSUME_MUST_RECEIVE_UNREAD_BODY')
            assert.equal(response.body?.locked, false, 'CONSUME_MUST_RECEIVE_UNLOCKED_BODY')
            // json() is unknown here: payload belongs to the application, not the planner.
            const details: unknown =
              item.format === 'json' ? await response.json() : await response.text()
            value = { details }
            if (mode === 'typed-error') {
              failure = new ApplicationFailure(details)
              throw failure
            }
            return value
          }
        })
        records.attach(handle)
        try {
          if (mode === 'result') {
            const completed = await handle.result
            assert.equal(completed.value, value, 'APPLICATION_VALUE_IDENTITY')
            assert.deepEqual(
              { ...completed },
              { value: { details: item.payload }, status: item.status, cleanup: 'released' }
            )
          } else {
            await assert.rejects(handle.result, error => httpFailure(error, failure, item.status))
            assert.ok(failure instanceof ApplicationFailure)
            assert.deepEqual(failure.details, item.payload, 'ALL_APPLICATION_DETAILS_SURVIVE')
          }
          await handle.resourcesDone
          assert.deepEqual(
            reads,
            [{ same: true, used: false, locked: false }],
            'CONSUME_MUST_RECEIVE_UNREAD_BODY'
          )
          assert.equal(source.response.bodyUsed, true)
          assert.equal(prepared, 1)
          assert.equal(source.calls(), 1, 'NON2XX_MUST_NOT_REPLAY')
          records.verify(handle, item.status)
        } finally {
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }

  test(`${family} broken HTTP body retains prefix, branded cause and status despite cleanup failure`, async () => {
    const gate = deferred<undefined>()
    const prefix = `{"errors":[{"code":3000,"parameter":"agent","error":"${canary}"},`
    const original = new Error(`${canary} socket reset`)
    let pulls = 0
    const source = fixture(
      family,
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
      ),
      412
    )
    const records = observe(source.planner)
    let partial = ''
    let caught: unknown
    let failure: ApplicationFailure | undefined
    let brand: Error | undefined
    let discarded = 0
    let disposed = 0
    let input: { same: boolean; used: boolean; locked: boolean | undefined } | undefined
    const handle = source.planner.submit({
      method: 'POST',
      replay,
      prepare: () => ({ url: canary, init: {} }),
      consume: async (response: Response | UndiciResponse, ctx: ConsumeContext) => {
        input = {
          same: response === source.response,
          used: response.bodyUsed,
          locked: response.body?.locked
        }
        ctx.onDiscard(() => {
          discarded++
        })
        ctx.onDispose(() => {
          disposed++
          throw new Error(`${canary} secondary cleanup failure`)
        })
        const reader = response.body?.getReader()
        if (!reader) throw new Error('EXPECTED_BODY')
        try {
          const first = await reader.read()
          const bytes: unknown = first.value
          if (!(bytes instanceof Uint8Array)) throw new Error('EXPECTED_PREFIX_BYTES')
          partial = new TextDecoder().decode(bytes)
          gate.resolve(undefined)
          try {
            await reader.read()
          } catch (error) {
            caught = error
          }
        } finally {
          reader.releaseLock()
        }
        failure = new ApplicationFailure(
          { prefix: partial, contentType: response.headers.get('content-type') },
          caught
        )
        brand = ctx.retryableReadFailure(failure)
        throw brand
      }
    })
    records.attach(handle)
    try {
      await assert.rejects(handle.result, error => httpFailure(error, brand, 412))
      assert.deepEqual(await handle.resourcesDone, { resources: 'failed' })
      assert.deepEqual(
        input,
        { same: true, used: false, locked: false },
        'CONSUME_MUST_RECEIVE_UNREAD_BODY'
      )
      assert.equal(partial, prefix, 'PARTIAL_BYTES_ACTUALLY_DELIVERED')
      assert.equal(caught, original)
      assert.ok(brand instanceof ConsumeReadFailure)
      assert.equal(brand.cause, failure)
      assert.ok(failure instanceof ApplicationFailure)
      assert.equal(failure.cause, original)
      assert.deepEqual(failure.details, { prefix, contentType: 'application/json' })
      assert.equal(discarded, 1)
      assert.equal(disposed, 1)
      assert.equal(source.calls(), 1)
      records.verify(handle, 412)
    } finally {
      gate.resolve(undefined)
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })

  test(`${family} every non429 status 300 through 599 stays terminal with branded failure and replay flags`, async () => {
    for (let status = 300; status <= 599; status++) {
      if (status === 429) continue
      const source = fixture(family, status === 304 ? null : canary, status)
      const records = observe(source.planner)
      let before: { same: boolean; used: boolean; locked: boolean | undefined } | undefined
      let text = ''
      let prepared = 0
      let brand: Error | undefined
      const cause = new ApplicationFailure({ private: canary, status })
      const handle = source.planner.submit({
        method: 'POST',
        replay,
        prepare: () => {
          prepared++
          return { url: canary, init: {} }
        },
        consume: async (response: Response | UndiciResponse, ctx: ConsumeContext) => {
          before = {
            same: response === source.response,
            used: response.bodyUsed,
            locked: response.body?.locked
          }
          text = await response.text()
          brand = ctx.retryableReadFailure(cause)
          throw brand
        }
      })
      records.attach(handle)
      try {
        await assert.rejects(handle.result, error => httpFailure(error, brand, status))
        await handle.resourcesDone
        assert.deepEqual(
          before,
          { same: true, used: false, locked: status === 304 ? undefined : false },
          'CONSUME_MUST_RECEIVE_UNREAD_BODY'
        )
        assert.equal(text, status === 304 ? '' : canary)
        assert.equal(brand?.cause, cause)
        assert.equal(prepared, 1, 'NO_SECOND_PREPARE')
        assert.equal(source.calls(), 1, `NON2XX_MUST_NOT_REPLAY status=${status}`)
        records.verify(handle, status)
      } finally {
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    }
  })

  test(`${family} arbitrary TypeError on HTTP 200 is terminal and retains identity`, async () => {
    const source = fixture(family, canary, 200)
    const records = observe(source.planner)
    const cause = new TypeError(`${canary} schema failure`)
    const handle = source.planner.submit({
      method: 'GET',
      replay,
      prepare: () => ({ url: canary, init: {} }),
      consume: async (response: Response | UndiciResponse) => {
        await response.text()
        throw cause
      }
    })
    records.attach(handle)
    try {
      await assert.rejects(handle.result, error => httpFailure(error, cause, 200))
      await handle.resourcesDone
      assert.equal(source.calls(), 1)
      records.verify(handle, 200)
    } finally {
      handle.abort()
      await Promise.allSettled([handle.result, handle.resourcesDone])
    }
  })
}

test('Consume read failure identity is per scope and cannot be forged by message or prototype', () => {
  const identity = {}
  const cause = new Error(canary)
  const error = new ConsumeReadFailure(identity, cause)
  assert.equal(error.cause, cause)
  assert.equal(ConsumeReadFailure.isFor(error, identity), true)
  assert.equal(ConsumeReadFailure.isFor(error, {}), false)
  assert.equal(ConsumeReadFailure.isFor(new Error(error.message, { cause }), identity), false)
  assert.equal(
    ConsumeReadFailure.isFor(Object.create(ConsumeReadFailure.prototype), identity),
    false
  )
  assert.equal(ConsumeReadFailure.isFor(null, identity), false)
})

test('Consume read failure factory rejects escaped calls from observer, cleanup, another owner and after settlement', async t => {
  const clock = createRuntime(t)
  const gate = deferred<undefined>()
  const entered = deferred<undefined>()
  let factory: ConsumeContext['retryableReadFailure'] | undefined
  let disposeError: unknown
  let observerError: unknown
  let foreignError: unknown
  let brand: Error | undefined
  const cause = new Error(canary)
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response(canary)))
  planner.observe(event => {
    if (event.phase === 'cleanup' && factory) {
      try {
        factory(cause)
      } catch (error) {
        observerError = error
      }
    }
  })
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: async (response, ctx) => {
      factory = cause => ctx.retryableReadFailure(cause)
      ctx.onDispose(() => {
        try {
          factory?.(cause)
        } catch (error) {
          disposeError = error
        }
      })
      await response.text()
      entered.resolve(undefined)
      await gate.promise
      brand = ctx.retryableReadFailure(cause)
      return 'finished'
    }
  })
  let other: Handle<string> | undefined
  try {
    await entered.promise
    other = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        try {
          factory?.(cause)
        } catch (error) {
          foreignError = error
        }
        return { url: canary, init: {} }
      },
      consume: response => response.text()
    })
    await clock.flush()
    assert.ok(foreignError instanceof OperationError)
    assert.equal(foreignError.code, 'INVALID_ARGUMENT', 'CONSUME_FACTORY_IS_SCOPE_BOUND')
    gate.resolve(undefined)
    assert.equal((await handle.result).value, 'finished')
    await handle.resourcesDone
    await clock.advance(3000)
    await other.result
    await other.resourcesDone
    assert.ok(brand instanceof ConsumeReadFailure)
    assert.equal(brand.cause, cause)
    for (const error of [observerError, disposeError]) {
      assert.ok(error instanceof OperationError)
      assert.equal(error.code, 'INVALID_ARGUMENT', 'CONSUME_FACTORY_IS_LIFETIME_BOUND')
    }
    assert.ok(factory)
    assert.throws(
      () => factory?.(cause),
      error => error instanceof OperationError && error.code === 'INVALID_ARGUMENT'
    )
  } finally {
    gate.resolve(undefined)
    handle.abort()
    other?.abort()
    await Promise.allSettled([
      handle.result,
      handle.resourcesDone,
      other?.result,
      other?.resourcesDone
    ])
  }
})

test('Observer commands cannot inherit a pending consume read-failure capability', async t => {
  const clock = createRuntime(t)
  const gate = deferred<undefined>()
  const entered = deferred<undefined>()
  const cause = new Error(canary)
  let factory: ConsumeContext['retryableReadFailure'] | undefined
  let foreignError: unknown
  let child: Handle<string> | undefined
  const planner = new FetchPlanner<typeof fetch>(() => Promise.resolve(new Response(canary)))
  const records = observe(planner)
  planner.observe(event => {
    if (event.type !== 'operation-settled' || child || event.failureCode !== 'ABORTED') return
    child = planner.submit({
      method: 'GET',
      replay,
      prepare: () => {
        try {
          factory?.(cause)
        } catch (error) {
          foreignError = error
        }
        return { url: canary, init: {} }
      },
      consume: response => response.text()
    })
  })
  const handle = planner.submit({
    method: 'GET',
    replay,
    prepare: () => ({ url: canary, init: {} }),
    consume: async (response, ctx) => {
      factory = cause => ctx.retryableReadFailure(cause)
      await response.text()
      handle.abort(cause)
      entered.resolve(undefined)
      await gate.promise
      return canary
    }
  })
  records.attach(handle)
  const rejection = assert.rejects(
    handle.result,
    error =>
      error instanceof OperationError &&
      error.code === 'ABORTED' &&
      error.cause === cause &&
      error.status === 200
  )
  try {
    await entered.promise
    await clock.flush()
    assert.ok(child)
    assert.ok(foreignError instanceof OperationError, 'CONSUME_SCOPE_MUST_DETACH_WITH_OBSERVER')
    assert.equal(foreignError.code, 'INVALID_ARGUMENT')
    gate.resolve(undefined)
    await rejection
    await handle.resourcesDone
    await clock.advance(3000)
    await child.result
    await child.resourcesDone
    records.verify(handle, 200)
  } finally {
    gate.resolve(undefined)
    handle.abort()
    child?.abort()
    await Promise.allSettled([rejection, handle.resourcesDone, child?.result, child?.resourcesDone])
  }
})
