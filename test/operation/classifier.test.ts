import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici'
import { FetchPlanner as RootPlanner, OperationError } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import type { FetchPlannerOptions } from '../../src/operation-types.js'
import { ResponseClassifier } from '../../src/response-classifier.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

const parallel = '{"errors":[{"code":1073}]}'
const generic = '{"errors":[{"code":1049}]}'
const encoder = new TextEncoder()
const families = ['native', 'undici'] as const

function response(
  family: (typeof families)[number],
  body: string | ReadableStream<Uint8Array> | null,
  contentType = 'application/json',
  status = 429
) {
  const init = { status, headers: { 'content-type': contentType } }
  return family === 'native' ? new Response(body, init) : new UndiciResponse(body, init)
}

async function turns() {
  for (let i = 0; i < 12; i++) await Promise.resolve(undefined)
}

for (const family of families) {
  for (const [name, text, contentType, expected] of [
    ['valid1073', parallel, 'application/json', 'parallel1073'],
    ['generic JSON', generic, 'application/json', 'generic429'],
    ['case and charset', parallel, 'Application/JSON; charset=utf-8', 'parallel1073'],
    ['HTML', parallel, 'text/html', 'generic429'],
    ['missing JSON media type', parallel, '', 'generic429'],
    ['JSON prefix media type', parallel, 'application/jsonjunk', 'generic429'],
    ['malformed', parallel.slice(0, -1), 'application/json', 'generic429'],
    ['trailing garbage', parallel + 'x', 'application/json', 'generic429'],
    ['string code', '{"errors":[{"code":"1073"}]}', 'application/json', 'generic429'],
    ['wrong shape', '{"code":1073}', 'application/json', 'generic429'],
    ['null', 'null', 'application/json', 'generic429'],
    ['empty', '', 'application/json', 'generic429']
  ]) {
    test(`${family} classifier ${name}`, async () => {
      assert.ok(text !== undefined && contentType !== undefined)
      const body = response(family, text, contentType)
      let readers = 0
      assert.ok(body.body)
      const original = body.body.getReader.bind(body.body)
      Object.defineProperty(body.body, 'getReader', {
        value: () => {
          readers++
          return original()
        }
      })
      const classifier = new ResponseClassifier(body, 0, () => 0)
      assert.equal(await classifier.result, expected)
      assert.equal(classifier.status, 429)
      assert.equal((await classifier.knownWork).readerReleased, true)
      assert.equal(readers, 1, 'SINGLE_READER')
      assert.equal(body.body.locked, false)
    })
  }

  for (const size of [65535, 65536, 65537]) {
    test(`${family} classifier byte boundary ${size}`, async () => {
      const text = parallel + ' '.repeat(size - parallel.length)
      const classifier = new ResponseClassifier(response(family, text), 0, () => 0)
      assert.equal(
        await classifier.result,
        size <= 65536 ? 'parallel1073' : 'generic429',
        'BYTE_LIMIT_CLASSIFICATION'
      )
      await classifier.knownWork
    })
  }

  test(`${family} classifier split UTF8`, async () => {
    const bytes = encoder.encode('{"errors":[{"error":"я😀","code":1073}]}')
    let offset = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset))
          else controller.close()
        }
      },
      { highWaterMark: 0 }
    )
    const classifier = new ResponseClassifier(response(family, body), 0, () => 0)
    assert.equal(await classifier.result, 'parallel1073')
    await classifier.knownWork
  })

  for (const size of [65535, 65536, 65537]) {
    test(`${family} classifier split byte boundary ${size}`, async () => {
      const bytes = encoder.encode(parallel + ' '.repeat(size - parallel.length))
      let offset = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset < bytes.length) {
              const end = Math.min(bytes.length, offset + 8192)
              controller.enqueue(bytes.slice(offset, end))
              offset = end
            } else controller.close()
          }
        },
        { highWaterMark: 0 }
      )
      const classifier = new ResponseClassifier(response(family, stream), 0, () => 0)
      assert.equal(await classifier.result, size <= 65536 ? 'parallel1073' : 'generic429')
      await classifier.knownWork
    })
  }

  test(`${family} classifier invalid UTF8 is generic with completed read`, async () => {
    const bytes = encoder.encode('{"errors":[{"code":1073,"error":"x"}]}')
    const position = bytes.indexOf(120)
    bytes[position] = 255
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    })
    const classifier = new ResponseClassifier(response(family, stream), 0, () => 0)
    assert.equal(await classifier.result, 'generic429')
    assert.deepEqual(await classifier.knownWork, {
      readFailed: false,
      cancelFailed: false,
      readerReleased: true
    })
  })

  for (const prefixSize of [0, 65530, 65536]) {
    test(`${family} classifier huge chunk after ${prefixSize} bytes`, async t => {
      const huge = new Uint8Array(1024 * 1024)
      huge.set(encoder.encode(parallel))
      const prefix = new Uint8Array(prefixSize).fill(32)
      let pulls = 0
      const set = t.mock.method(Uint8Array.prototype, 'set')
      const decode = t.mock.method(TextDecoder.prototype, 'decode')
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulls++ === 0 && prefixSize > 0) controller.enqueue(prefix)
            else {
              controller.enqueue(huge)
              controller.close()
            }
          }
        },
        { highWaterMark: 0 }
      )
      const classifier = new ResponseClassifier(response(family, stream), 0, () => 0)
      assert.equal(await classifier.result, 'generic429')
      await classifier.knownWork
      const copied = set.mock.calls.reduce((total, call) => total + call.arguments[0].length, 0)
      assert.equal(copied, prefixSize, 'OVERSIZE_CHUNK_MUST_NOT_BE_COPIED')
      assert.equal(decode.mock.calls.length, 0, 'OVERSIZE_CHUNK_MUST_NOT_BE_DECODED')
    })
  }

  test(`${family} classifier requires EOF after valid prefix`, async () => {
    const gate = deferred<undefined>()
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (pulls++ === 0) controller.enqueue(encoder.encode(parallel))
          else {
            await gate.promise
            controller.close()
          }
        }
      },
      { highWaterMark: 0 }
    )
    const classifier = new ResponseClassifier(response(family, stream), 100, () => 100)
    let settled = false
    void classifier.result.then(() => {
      settled = true
    })
    try {
      await turns()
      assert.equal(settled, false, 'PARTIAL_JSON_MUST_NOT_CLASSIFY_BEFORE_EOF')
      gate.resolve(undefined)
      assert.equal(await classifier.result, 'parallel1073')
    } finally {
      gate.resolve(undefined)
      await classifier.knownWork
    }
  })

  for (const elapsed of [249, 250, 251]) {
    for (const eof of [true, false]) {
      test(`${family} classifier time ${elapsed} EOF ${eof}`, async () => {
        const gate = deferred<undefined>()
        let clock = 1000
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              await gate.promise
              controller.enqueue(encoder.encode(parallel))
              if (eof) controller.close()
            }
          },
          { highWaterMark: 0 }
        )
        const classifier = new ResponseClassifier(response(family, stream), 1000, () => clock)
        let settled = false
        void classifier.result.then(() => {
          settled = true
        })
        try {
          clock += elapsed
          if (eof) gate.resolve(undefined)
          else classifier.expire(clock)
          await turns()
          if (!eof && elapsed === 249) {
            assert.equal(settled, false, 'PENDING_READ_BEFORE_DEADLINE')
            clock = 1250
            classifier.expire(clock)
          }
          assert.equal(
            await classifier.result,
            eof && elapsed === 249 ? 'parallel1073' : 'generic429'
          )
          assert.equal(classifier.deadline, 1250)
        } finally {
          gate.resolve(undefined)
          classifier.cancel()
          await classifier.knownWork
        }
      })
    }
  }

  for (const rejectCancel of [false, true]) {
    test(`${family} classifier pending cancel rejected ${rejectCancel}`, async () => {
      const gate = deferred<undefined>()
      const entered = deferred<undefined>()
      let cancels = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull() {
            entered.resolve(undefined)
          },
          cancel() {
            cancels++
            return gate.promise
          }
        },
        { highWaterMark: 0 }
      )
      const body = response(family, stream)
      const classifier = new ResponseClassifier(body, 0, () => 0)
      let workSettled = false
      void classifier.knownWork.then(() => {
        workSettled = true
      })
      try {
        await entered.promise
        classifier.expire(250)
        assert.equal(await classifier.result, 'generic429')
        classifier.expire(251)
        classifier.cancel()
        await turns()
        assert.equal(workSettled, false, 'CANCEL_WORK_MUST_REMAIN_PENDING')
        assert.equal(body.body?.locked, true)
        assert.equal(cancels, 1)
        if (rejectCancel) gate.reject(new Error('cancel failed'))
        else gate.resolve(undefined)
        assert.deepEqual(await classifier.knownWork, {
          readFailed: false,
          cancelFailed: rejectCancel,
          readerReleased: true
        })
      } finally {
        gate.resolve(undefined)
        await classifier.knownWork
      }
    })
  }

  test(`${family} classifier known read remains pending after cancel`, async t => {
    const gate = deferred<undefined>()
    const entered = deferred<undefined>()
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          return undefined
        }
      },
      { highWaterMark: 0 }
    )
    const body = response(family, stream)
    assert.ok(body.body)
    const getReader = body.body.getReader.bind(body.body)
    // Keep real Response/reader/cancel, but delay its read reaction independently.
    t.mock.method(body.body, 'getReader', () => {
      const reader = getReader()
      const read = reader.read.bind(reader)
      t.mock.method(reader, 'read', async () => {
        const work = read()
        entered.resolve(undefined)
        await gate.promise
        return work
      })
      return reader
    })
    const classifier = new ResponseClassifier(body, 0, () => 0)
    let settled = false
    void classifier.knownWork.then(() => {
      settled = true
    })
    try {
      await entered.promise
      classifier.cancel()
      assert.equal(await classifier.result, 'generic429')
      await turns()
      assert.equal(settled, false, 'KNOWN_READ_MUST_REMAIN_PENDING')
      assert.equal(body.body.locked, true)
    } finally {
      gate.resolve(undefined)
      assert.deepEqual(await classifier.knownWork, {
        readFailed: false,
        cancelFailed: false,
        readerReleased: true
      })
    }
  })

  test(`${family} classifier uses external clock without timers`, async t => {
    let timers = 0
    t.mock.method(globalThis, 'setTimeout', () => {
      timers++
      throw new Error('OWN_TIMER')
    })
    t.mock.method(globalThis, 'setInterval', () => {
      timers++
      throw new Error('OWN_INTERVAL')
    })
    const classifier = new ResponseClassifier(response(family, parallel), 0, () => 250)
    assert.equal(await classifier.result, 'generic429')
    await classifier.knownWork
    assert.equal(timers, 0, 'NO_CLASSIFIER_TIMER')
  })

  test(`${family} classifier read rejection`, async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('read failed'))
      }
    })
    const classifier = new ResponseClassifier(response(family, stream), 0, () => 0)
    assert.equal(await classifier.result, 'generic429')
    assert.deepEqual(await classifier.knownWork, {
      readFailed: true,
      cancelFailed: true,
      readerReleased: true
    })
  })

  test(`${family} classifier locked body is not released`, async () => {
    const body = response(family, parallel)
    assert.ok(body.body)
    const owner = body.body.getReader()
    try {
      const classifier = new ResponseClassifier(body, 0, () => 0)
      assert.equal(await classifier.result, 'generic429')
      assert.deepEqual(await classifier.knownWork, {
        readFailed: true,
        cancelFailed: false,
        readerReleased: false
      })
      assert.equal(body.body.locked, true)
    } finally {
      await owner.cancel()
      owner.releaseLock()
    }
  })

  test(`${family} classifier leaves non429 unread`, () => {
    const body = response(family, parallel, 'application/json', 412)
    assert.throws(() => new ResponseClassifier(body, 0, () => 0), /CLASSIFIER_REQUIRES_429/)
    assert.equal(body.bodyUsed, false)
    assert.equal(body.body?.locked, false)
  })

  test(`${family} classifier null body`, async () => {
    const classifier = new ResponseClassifier(response(family, null), 0, () => 0)
    assert.equal(await classifier.result, 'generic429')
    assert.deepEqual(await classifier.knownWork, {
      readFailed: false,
      cancelFailed: false,
      readerReleased: true
    })
  })
}

const replay = { serverSafe: true, consumeSafe: true }
const entries = ['root', 'deep'] as const

function actualFixture(
  family: (typeof families)[number],
  entry: (typeof entries)[number],
  body: string | ReadableStream<Uint8Array> | null,
  options: Partial<FetchPlannerOptions> = {},
  contentType = 'application/json'
) {
  const Constructor = entry === 'root' ? RootPlanner : DeepPlanner
  let calls = 0
  if (family === 'native') {
    const native = new Response(body, { status: 429, headers: { 'content-type': contentType } })
    const planner = new Constructor<typeof fetch>(() => {
      calls++
      return Promise.resolve(calls === 1 ? native : new Response())
    }, options)
    return { planner, receipt: native, calls: () => calls }
  }
  const undici = new UndiciResponse(body, {
    status: 429,
    headers: { 'content-type': contentType }
  })
  const planner = new Constructor<typeof undiciFetch>(() => {
    calls++
    return Promise.resolve(calls === 1 ? undici : new UndiciResponse())
  }, options)
  return { planner, receipt: undici, calls: () => calls }
}

for (const family of families) {
  for (const entry of entries) {
    for (const [name, body, media] of [
      ['valid1073', parallel, 'application/json'],
      ['generic', generic, 'application/json'],
      ['malformed', '{', 'application/json'],
      ['HTML', parallel, 'text/html'],
      ['oversize', parallel + ' '.repeat(65537), 'application/json']
    ] as const) {
      test(`${family} ${entry} actual intercepted ${name} baseline`, async () => {
        const { planner, calls } = actualFixture(family, entry, body, { maxAttempts: 1 }, media)
        let consumes = 0
        const handle = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: '', init: {} }),
          consume: () => {
            consumes++
            return 1
          }
        })
        try {
          await assert.rejects(handle.result, { code: 'HTTP_FAILED', status: 429 })
          assert.equal(consumes, 0, 'NO_429_CONSUME')
          assert.equal(calls(), 1)
          assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
        } finally {
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }

    for (const mode of ['budget', 'abort', 'deadline', 'attempt', 'stop'] as const) {
      for (const failure of ['none', 'read', 'cancel', 'dispose'] as const) {
        test(`${family} ${entry} actual ownership ${mode} ${failure}`, async t => {
          const clock = createRuntime(t)
          const timers = trackTimeouts(t)
          const readGate = deferred<undefined>()
          const cancelGate = deferred<undefined>()
          const disposeGate = deferred<undefined>()
          const entered = deferred<undefined>()
          const disposing = deferred<undefined>()
          let cancelCalls = 0
          let disposeCalls = 0
          let consumes = 0
          let nextPrepares = 0
          let resourceSettled = false
          let settlements = 0
          let signal: AbortSignal | undefined
          const stream = new ReadableStream<Uint8Array>(
            {
              cancel() {
                cancelCalls++
                return cancelGate.promise
              }
            },
            { highWaterMark: 0 }
          )
          const { planner, receipt, calls } = actualFixture(family, entry, stream, {
            maxParallelLimit: 1,
            deadlineMs: mode === 'deadline' ? 100 : 2000,
            attemptTimeoutMs: mode === 'attempt' ? 100 : 2000
          })
          assert.ok(receipt.body)
          const getReader = receipt.body.getReader.bind(receipt.body)
          t.mock.method(receipt.body, 'getReader', () => {
            const reader = getReader()
            const read = reader.read.bind(reader)
            t.mock.method(reader, 'read', async () => {
              const work = read()
              entered.resolve(undefined)
              await readGate.promise
              return work
            })
            return reader
          })
          const handle = planner.submit({
            method: 'POST',
            replay,
            prepare: ctx => {
              signal = ctx.signal
              ctx.onDispose(async () => {
                disposeCalls++
                // A producer can need this stop before its pending read can settle.
                disposing.resolve(undefined)
                await disposeGate.promise
              })
              return { url: '', init: {} }
            },
            consume: () => {
              consumes++
              return 1
            }
          })
          handle.observe(event => {
            if (event.type === 'operation-settled') settlements++
          })
          void handle.resourcesDone.then(() => {
            resourceSettled = true
          })
          let next: ReturnType<typeof planner.submit<number>> | undefined
          const reason = new Error('private abort reason')
          const held = () => {
            assert.equal(planner.snapshot().leasedAttempts, 1, 'LEASE_WAITS_FOR_READER_CANCEL')
            assert.equal(planner.snapshot().sentActive, 1, 'SENT_WAITS_FOR_READER_CANCEL')
            assert.equal(resourceSettled, false, 'RESOURCES_WAIT_FOR_READER_CANCEL')
            assert.equal(nextPrepares, 0, 'NEXT_PREPARE_WAITS_FOR_ALL_OWNERS')
          }
          try {
            await entered.promise
            assert.equal(handle.snapshot().phase, 'classifying', 'BASELINE_READY')
            assert.equal(
              timers.delays.at(-1),
              mode === 'deadline' || mode === 'attempt' ? 100 : 250
            )
            if (mode === 'abort') handle.abort(reason)
            else if (mode === 'stop') {
              planner.stop(reason)
              assert.equal(signal?.aborted, false, 'STOP_PRESERVES_SENT_WORK')
              await clock.advance(249)
              assert.equal(handle.snapshot().outcome, 'pending')
              await clock.advance(1)
            } else await clock.advance(mode === 'budget' ? 250 : 100)
            await assert.rejects(
              handle.result,
              error =>
                error instanceof OperationError &&
                error.code ===
                  (mode === 'abort'
                    ? 'ABORTED'
                    : mode === 'deadline'
                      ? 'DEADLINE'
                      : mode === 'attempt'
                        ? 'ATTEMPT_TIMEOUT'
                        : mode === 'stop'
                          ? 'STOPPED'
                          : 'HTTP_FAILED') &&
                error.status === 429 &&
                ((mode !== 'abort' && mode !== 'stop') || error.cause === reason)
            )
            await disposing.promise
            await clock.flush()
            assert.equal(cancelCalls, 1, 'PENDING_CANCEL_CONFIRMED')
            assert.equal(disposeCalls, 1, 'STOP_BEFORE_READER_WAIT')
            t.diagnostic('BASELINE_READY: actual classifying receipt429; pending cancel confirmed')
            held()
            next = planner.submit({
              method: 'GET',
              replay,
              prepare: () => {
                nextPrepares++
                return { url: '', init: {} }
              },
              consume: () => 2
            })
            await clock.flush()
            held()
            // Settle read first: cancellation and request disposal still own the attempt.
            if (failure === 'read') readGate.reject(new Error('read failure'))
            else readGate.resolve(undefined)
            await clock.flush()
            held()
            // Settle request disposal next: pending reader cancel must still hold accounting.
            if (failure === 'dispose') disposeGate.reject(new Error('dispose failure'))
            else disposeGate.resolve(undefined)
            await clock.flush()
            held()
            if (failure === 'cancel') cancelGate.reject(new Error('cancel failure'))
            else cancelGate.resolve(undefined)
            assert.deepEqual(await handle.resourcesDone, {
              resources: failure === 'none' ? 'released' : 'failed'
            })
            if (mode === 'stop') await assert.rejects(next.result, { code: 'STOPPED' })
            else assert.equal((await next.result).value, 2)
            await next.resourcesDone
            await clock.flush()
            handle.abort()
            planner.stop()
            await clock.advance(3000)
            assert.equal(settlements, 1)
            assert.equal(consumes, 0)
            assert.equal(calls(), mode === 'stop' ? 1 : 2)
            assert.equal(disposeCalls, 1)
            assert.equal(cancelCalls, 1)
            assert.equal(planner.snapshot().leasedAttempts, 0)
            assert.equal(planner.snapshot().sentActive, 0)
            assert.equal(planner.snapshot().queued, 0)
            assert.equal(timers.active.size, 0)
            assert.ok(timers.maximum() <= 1, 'ONE_COORDINATOR_TIMER')
          } finally {
            readGate.resolve(undefined)
            cancelGate.resolve(undefined)
            disposeGate.resolve(undefined)
            handle.abort()
            next?.abort()
            await Promise.allSettled([
              handle.result,
              handle.resourcesDone,
              next?.result,
              next?.resourcesDone
            ])
          }
        })
      }
    }
  }
}

for (const family of families) {
  for (const entry of entries) {
    for (const elapsed of [249, 250, 251]) {
      test(`${family} ${entry} actual monotonic wake ${elapsed}`, async t => {
        const clock = createRuntime(t)
        const timers = trackTimeouts(t)
        let cancels = 0
        const gate = deferred<undefined>()
        const stream = new ReadableStream<Uint8Array>(
          {
            cancel() {
              cancels++
              return gate.promise
            }
          },
          { highWaterMark: 0 }
        )
        const { planner } = actualFixture(family, entry, stream, { maxAttempts: 1 })
        const handle = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: '', init: {} }),
          consume: () => assert.fail('NO_429_CONSUME')
        })
        try {
          await clock.flush()
          assert.equal(handle.snapshot().phase, 'classifying')
          const wake = timers.callbacks.at(-1)
          assert.ok(wake)
          const deliver = () => {
            for (const timer of timers.active) clearTimeout(timer)
            wake()
          }
          const now = performance.now()
          t.mock.method(performance, 'now', () => now + elapsed)
          // Deliver the actual coordinator callback against current monotonic time.
          // No fake scheduler sets classifier state or accounting.
          deliver()
          await clock.flush()
          if (elapsed === 249) {
            assert.equal(handle.snapshot().outcome, 'pending')
            assert.equal(cancels, 0)
            assert.equal(timers.delays.at(-1), 1)
            t.mock.method(performance, 'now', () => now + 250)
            deliver()
          }
          await assert.rejects(handle.result, { code: 'HTTP_FAILED', status: 429 })
          deliver()
          handle.abort()
          await clock.flush()
          assert.equal(cancels, 1)
          assert.equal(planner.snapshot().leasedAttempts, 1)
          gate.resolve(undefined)
          await handle.resourcesDone
          await clock.flush()
          assert.equal(timers.active.size, 0)
          assert.ok(timers.maximum() <= 1)
        } finally {
          gate.resolve(undefined)
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }

    test(`${family} ${entry} actual cancel settles before read and disposer`, async t => {
      const clock = createRuntime(t)
      const readGate = deferred<undefined>()
      const disposeGate = deferred<undefined>()
      const entered = deferred<undefined>()
      let cancels = 0
      let disposals = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancels++
          }
        },
        { highWaterMark: 0 }
      )
      const { planner, receipt } = actualFixture(family, entry, stream)
      assert.ok(receipt.body)
      const getReader = receipt.body.getReader.bind(receipt.body)
      t.mock.method(receipt.body, 'getReader', () => {
        const reader = getReader()
        const read = reader.read.bind(reader)
        t.mock.method(reader, 'read', async () => {
          const work = read()
          entered.resolve(undefined)
          await readGate.promise
          return work
        })
        return reader
      })
      const handle = planner.submit({
        method: 'GET',
        replay,
        prepare: ctx => {
          ctx.onDispose(async () => {
            disposals++
            await disposeGate.promise
          })
          return { url: '', init: {} }
        },
        consume: () => assert.fail('NO_429_CONSUME')
      })
      try {
        await entered.promise
        handle.abort()
        await assert.rejects(handle.result, { code: 'ABORTED', status: 429 })
        await clock.flush()
        assert.equal(cancels, 1)
        assert.equal(disposals, 1, 'DISPOSE_BEFORE_KNOWN_READ')
        assert.equal(planner.snapshot().leasedAttempts, 1)
        assert.equal(handle.snapshot().resources, 'pending')
        readGate.resolve(undefined)
        await clock.flush()
        assert.equal(planner.snapshot().sentActive, 1, 'DISPOSER_STILL_OWNS_ATTEMPT')
        disposeGate.resolve(undefined)
        assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
      } finally {
        readGate.resolve(undefined)
        disposeGate.resolve(undefined)
        handle.abort()
        await Promise.allSettled([handle.result, handle.resourcesDone])
      }
    })
  }
}

test('Actual classifier strict child exits naturally after cancellation and disposal', () => {
  const module = new URL('../../src/index.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
    const originalModule = new URL('./planner.js', ${JSON.stringify(module)})
    const inspectedModule = new URL('./t61-' + process.pid + '.js', originalModule)
    const original = readFileSync(originalModule, 'utf8')
    const anchor = '    snapshot() {'
    assert.equal(original.split(anchor).length,2)
    writeFileSync(inspectedModule, original.replace(anchor, \`
      t61() { return {active:this.#active.size,ready:this.#ready.size,commands:this.commands.length,
        timer:this.#timer !== undefined,pump:this.#pumpScheduled,
        diagnostics:this.observation.diagnostics.snapshot()}; }
    \` + anchor))
    const { FetchPlanner } = await import(inspectedModule.href)
    const watchdog = setTimeout(() => { throw new Error('classifier child leaked work') }, 2000)
    let release
    const gate = new Promise(resolve => { release = resolve })
    const planner = new FetchPlanner(() => Promise.resolve(new Response(new ReadableStream({
      cancel() { return gate }
    }), {status:429,headers:{'content-type':'application/json'}})), {maxParallelLimit:1,maxAttempts:1})
    let disposals = 0
    const handle = planner.submit({method:'POST',replay:{serverSafe:true,consumeSafe:true},
      prepare:ctx => {ctx.onDispose(() => {disposals++; release()}); return {url:'',init:{}}},
      consume:() => assert.fail('429 reached consume')})
    try {
      await assert.rejects(handle.result,{code:'HTTP_FAILED',status:429})
      assert.deepEqual(await handle.resourcesDone,{resources:'released'})
      assert.equal(disposals,1)
      assert.equal(planner.snapshot().leasedAttempts,0)
      assert.equal(planner.snapshot().sentActive,0)
      await new Promise(resolve => setImmediate(resolve))
      const final = planner.t61()
      assert.deepEqual([final.active,final.ready,final.commands,final.timer,final.pump],[0,0,0,false,false])
      assert.deepEqual([final.diagnostics.OBSERVER_FAILED,final.diagnostics.INVALID_HINT,final.diagnostics.LATE_COMPLETION],[0,0,0])
      console.log('PASS classifier natural exit; registries and diagnostics zero')
    } finally {
      release(); handle.abort(); planner.stop();
      await Promise.allSettled([handle.result,handle.resourcesDone]); clearTimeout(watchdog); unlinkSync(inspectedModule)
    }
  `
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '--eval', source],
    { encoding: 'utf8', timeout: 5000 }
  )
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.equal(child.signal, null)
  assert.match(child.stdout, /PASS classifier natural exit/)
})

for (const family of families) {
  for (const entry of entries) {
    for (const elapsed of [249, 250, 251]) {
      test(`${family} ${entry} actual EOF without timer delivery ${elapsed}`, async t => {
        const clock = createRuntime(t)
        const gate = deferred<undefined>()
        const entered = deferred<undefined>()
        const expire = t.mock.method(ResponseClassifier.prototype, 'expire')
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              entered.resolve(undefined)
              await gate.promise
              controller.enqueue(encoder.encode(parallel))
              controller.close()
            }
          },
          { highWaterMark: 0 }
        )
        const { planner } = actualFixture(family, entry, stream, { maxAttempts: 1 })
        const handle = planner.submit({
          method: 'GET',
          replay,
          prepare: () => ({ url: '', init: {} }),
          consume: () => assert.fail('NO_429_CONSUME')
        })
        try {
          await entered.promise
          const classifier = expire.mock.calls[0]?.this
          assert.ok(classifier instanceof ResponseClassifier, 'ACTUAL_CLASSIFIER_CONNECTED')
          const now = performance.now()
          t.mock.method(performance, 'now', () => now + elapsed)
          gate.resolve(undefined)
          assert.equal(
            await classifier.result,
            elapsed < 250 ? 'parallel1073' : 'generic429',
            'NO_LATE_1073'
          )
          await assert.rejects(handle.result, { code: 'HTTP_FAILED', status: 429 })
          await handle.resourcesDone
          await clock.flush()
          assert.equal(planner.snapshot().leasedAttempts, 0)
        } finally {
          gate.resolve(undefined)
          handle.abort()
          await Promise.allSettled([handle.result, handle.resourcesDone])
        }
      })
    }
  }
}
