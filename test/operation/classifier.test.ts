import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response as UndiciResponse } from 'undici'
import { ResponseClassifier } from '../../src/response-classifier.js'
import { deferred } from './helpers.js'

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
