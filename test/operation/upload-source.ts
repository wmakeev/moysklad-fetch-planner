import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { setImmediate as turn } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { FetchPlanner, OperationError } from '../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../src/planner.js'
import { OperationObservation } from '../../src/operation-observation.js'
import type { Handle } from '../../src/operation-types.js'
import { deferred } from './helpers.js'

const prefix = new TextEncoder().encode('cooperative-upload-prefix:')
const errorBody = JSON.stringify({ errors: [{ code: 1073, error: 'loopback fixture' }] })
type Family = 'native' | 'undici'
type Mode = 'released' | 'rejected' | 'failure' | 'watchdog'

/** This fixture owns every pull; it is not a disposer for arbitrary caller streams. */
function producer() {
  const stopGate = deferred<undefined>()
  const work = deferred<undefined>()
  const entered = deferred<undefined>()
  const stoppedSeen = deferred<undefined>()
  const producerDone = deferred<undefined>()
  const disposerGate = deferred<undefined>()
  const tasks: Promise<void>[] = []
  const state = { pulls: 0, pending: 0, settled: 0, stopCalls: 0, disposeCalls: 0 }
  let controller: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull(value) {
        if (++state.pulls === 1) {
          value.enqueue(prefix)
          return
        }
        state.pending++
        const task = (async () => {
          entered.resolve(undefined)
          await stopGate.promise
          stoppedSeen.resolve(undefined)
          await work.promise
        })().finally(() => {
          state.pending--
          state.settled++
        })
        tasks.push(task)
        return task
      }
    },
    { highWaterMark: 0 }
  )
  function stop() {
    if (state.stopCalls) return
    state.stopCalls++
    controller.close() // Stop emitting bytes; the known pull finalization still needs work.
    stopGate.resolve(undefined)
  }
  async function wait() {
    await Promise.all(tasks)
  }
  async function dispose(reject: boolean) {
    state.disposeCalls++
    stop() // Stop before waiting for the active pull/finalization.
    await wait()
    producerDone.resolve(undefined)
    await disposerGate.promise
    if (reject) throw new Error('fixture disposer rejected')
  }
  return {
    body,
    state,
    work,
    entered,
    stoppedSeen,
    producerDone,
    disposerGate,
    stop,
    wait,
    dispose
  }
}

export async function runUploadCase(family: Family, mode: Mode) {
  const source = producer()
  const dispatcher = new Agent({ connections: 1, pipelining: 1 })
  const sockets = new Set<Socket>()
  const socketClosures: Promise<void>[] = []
  const requests: {
    path: string | undefined
    bytes: number
    ended: boolean
    pendingAtResponse: number
    responseFinished: boolean
  }[] = []
  const transports: Promise<unknown>[] = []
  const statuses: number[] = []
  const fixtureAbort = new AbortController()
  const uploadAbort = new AbortController()
  const nextPrepared = deferred<undefined>()
  let nextPrepare = 0
  let consumeCalls = 0
  let resourcesSettled = 0
  let resourceEvents = 0
  let handle: Handle<string> | undefined
  let next: Handle<string> | undefined
  let cancelTask: Promise<void> | undefined
  const server = createServer((req, res) => {
    const entry = {
      path: req.url,
      bytes: 0,
      ended: false,
      pendingAtResponse: 0,
      responseFinished: false
    }
    requests.push(entry)
    req.on('error', () => undefined)
    res.on('error', () => undefined)
    req.on('data', (chunk: Buffer) => {
      entry.bytes += chunk.length
      if (req.url === '/early' && !res.headersSent) {
        entry.pendingAtResponse = source.state.pending
        res.writeHead(429, {
          'content-type': 'application/json',
          'connection': 'close',
          'content-length': Buffer.byteLength(errorBody)
        })
        res.once('finish', () => {
          entry.responseFinished = true
        })
        res.end(errorBody)
      }
    })
    req.on('end', () => {
      entry.ended = true
      if (req.url === '/next') res.end('independent GET')
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socketClosures.push(
      new Promise(resolve =>
        socket.once('close', () => {
          sockets.delete(socket)
          resolve()
        })
      )
    )
  })
  const spy = <R extends Response | UndiciResponse>(task: Promise<R>): Promise<R> => {
    const observed = task.then(response => {
      statuses.push(response.status) // No body reads/cancellation in the transport spy.
      return response
    })
    transports.push(
      observed.then(
        () => undefined,
        () => undefined
      )
    )
    return observed
  }
  // Node's declaration imports a newer undici-types Dispatcher whose compose overloads
  // differ from installed Agent 7.3. Keep the transport native-family and install the
  // fixture-owned runtime dispatcher as a property, without widening body/Response types.
  const nativeTransport: typeof fetch = (url, init) => {
    const actual = {
      ...init,
      signal: AbortSignal.any([
        fixtureAbort.signal,
        ...(typeof url === 'string' && url.endsWith('/early') ? [uploadAbort.signal] : []),
        ...(init?.signal ? [init.signal] : [])
      ])
    }
    Object.defineProperty(actual, 'dispatcher', { value: dispatcher })
    return spy(globalThis.fetch(url, actual))
  }
  const undiciTransport: typeof undiciFetch = (url, init) =>
    spy(
      undiciFetch(url, {
        ...init,
        dispatcher,
        signal: AbortSignal.any([
          fixtureAbort.signal,
          ...(typeof url === 'string' && url.endsWith('/early') ? [uploadAbort.signal] : []),
          ...(init?.signal ? [init.signal] : [])
        ])
      })
    )
  const options = { maxParallelLimit: 1, jitter: 0, deadlineMs: 10000 }
  const planner =
    family === 'native'
      ? new FetchPlanner<typeof nativeTransport>(nativeTransport, options)
      : new DeepPlanner<typeof undiciTransport>(undiciTransport, options)
  const failure = deferred<never>()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const check = async () => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    handle = planner.submit({
      method: 'POST',
      replay: { serverSafe: false, consumeSafe: false },
      prepare: ctx => {
        ctx.onDispose(async () => {
          assert.equal(source.body.locked, true)
          cancelTask = assert.rejects(source.body.cancel(), TypeError)
          await cancelTask
          await source.dispose(mode === 'rejected')
        })
        return {
          url: `${base}/early`,
          init: { body: source.body, duplex: 'half', redirect: 'error' }
        }
      },
      consume: () => {
        consumeCalls++
        return 'unexpected'
      }
    })
    handle.observe(event => {
      if (event.type === 'resources-settled') resourceEvents++
    })
    const result = assert.rejects(
      handle.result,
      error =>
        error instanceof OperationError && error.code === 'HTTP_FAILED' && error.status === 429
    )
    transports.push(result)
    void handle.resourcesDone.then(() => {
      resourcesSettled++
    })
    await source.entered.promise
    await source.stoppedSeen.promise
    await result
    assert.deepEqual(statuses, [429], 'ACTUAL_RESPONSE_BEFORE_PRODUCER_SETTLEMENT')
    assert.equal(source.state.pending, 1)
    assert.equal(source.state.settled, 0)
    assert.equal(requests[0]?.pendingAtResponse, 1)
    assert.equal(requests[0].responseFinished, true)
    assert.equal(requests[0].ended, false)
    assert.equal(requests[0].bytes, prefix.byteLength)
    // Locked cancellation is rejected; it cannot confirm completion of the pending pull.
    await cancelTask
    if (mode === 'failure') {
      uploadAbort.abort()
      await turn()
      assert.equal(source.state.pending, 1, 'ABORT_IS_NOT_PRODUCER_COMPLETION')
    }
    assert.equal(source.state.pending, 1)
    console.log(
      JSON.stringify({
        event: 'baseline-ready',
        family,
        mode,
        status: statuses[0],
        producerPending: source.state.pending,
        request: requests[0]
      })
    )
    if (mode === 'failure') throw new Error('INJECTED_AFTER_HEADERS')
    if (mode === 'watchdog') {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        failure.reject(new Error('WATCHDOG_UPLOAD'))
      }, 100)
      await source.work.promise
      return
    }
    next = planner.submit({
      method: 'GET',
      replay: { serverSafe: true, consumeSafe: true },
      prepare: () => {
        nextPrepare++
        console.log(
          JSON.stringify({
            event: 'next-prepare',
            producerPending: source.state.pending,
            nextPrepare
          })
        )
        nextPrepared.resolve(undefined)
        return { url: `${base}/next`, init: { redirect: 'error' } }
      },
      consume: (response: Response | UndiciResponse) => response.text()
    })
    // Attach result handling before any await, including failure cleanup.
    transports.push(
      next.result.then(
        () => undefined,
        () => undefined
      )
    )
    const held = async (producerPending: number) => {
      await turn()
      await turn()
      console.log(
        JSON.stringify({
          event: 'barrier-check',
          producerPending: source.state.pending,
          nextPrepare,
          snapshot: planner.snapshot()
        })
      )
      assert.equal(
        nextPrepare,
        0,
        'EARLY_RELEASE: independent prepare started before upload cleanup'
      )
      assert.equal(source.state.pending, producerPending)
      assert.equal(resourcesSettled, 0)
      assert.equal(handle?.snapshot().resources, 'pending')
      assert.equal(planner.snapshot().leasedAttempts, 1)
      assert.equal(planner.snapshot().sentActive, 1)
      assert.equal(planner.snapshot().queued, 1)
    }
    await held(1)
    source.work.resolve(undefined)
    await source.producerDone.promise
    await held(0)
    source.disposerGate.resolve(undefined)
    assert.deepEqual(await handle.resourcesDone, {
      resources: mode === 'rejected' ? 'failed' : 'released'
    })
    await nextPrepared.promise
    assert.equal((await next.result).value, 'independent GET')
    assert.deepEqual(await next.resourcesDone, { resources: 'released' })
    assert.equal(nextPrepare, 1)
    assert.equal(source.state.disposeCalls, 1)
    assert.equal(source.state.stopCalls, 1)
    assert.equal(source.state.settled, 1)
    assert.equal(resourceEvents, 1)
    assert.equal(resourcesSettled, 1)
    assert.equal(handle.snapshot().attempts, 1)
    assert.equal(handle.snapshot().dispatchCalls, 1)
    assert.equal(consumeCalls, 0)
    assert.deepEqual(statuses, [429, 200])
    assert.equal(requests[1]?.path, '/next')
    assert.equal(requests[1].ended, true)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    const observation: unknown = Reflect.get(planner, 'observation')
    assert.ok(observation instanceof OperationObservation)
    assert.deepEqual(observation.diagnostics.snapshot(), {
      OBSERVER_FAILED: 0,
      INVALID_HINT: 0,
      LATE_COMPLETION: 0,
      rejections: {}
    })
  }
  const running = check()
  // Handle both branches before the first await; finally owns all outstanding work.
  const settled = running.then(
    () => undefined,
    () => undefined
  )
  watchdog = setTimeout(() => {
    failure.reject(new Error('WATCHDOG_UPLOAD'))
  }, 8000)
  try {
    await Promise.race([running, failure.promise])
  } finally {
    source.stop()
    source.work.resolve(undefined)
    source.disposerGate.resolve(undefined)
    handle?.abort()
    next?.abort()
    fixtureAbort.abort()
    await source.wait()
    await Promise.allSettled([
      handle?.result,
      handle?.resourcesDone,
      next?.result,
      next?.resourcesDone,
      cancelTask,
      ...transports
    ])
    // resourcesDone above includes the coordinator-owned unread response cancellation.
    for (const socket of sockets) socket.destroy()
    const closures = await Promise.allSettled([
      dispatcher.destroy(),
      server.listening
        ? new Promise<void>((resolve, reject) =>
            server.close(error => {
              if (error) reject(error)
              else resolve()
            })
          )
        : Promise.resolve(undefined),
      ...socketClosures
    ])
    await settled
    clearTimeout(watchdog)
    for (const closure of closures) assert.equal(closure.status, 'fulfilled')
    assert.equal(source.state.pending, 0)
    assert.equal(sockets.size, 0)
    assert.equal(server.listening, false)
    console.log(
      JSON.stringify({
        event: 'finally-clean',
        family,
        mode,
        producerPending: source.state.pending,
        sockets: sockets.size,
        serverListening: server.listening
      })
    )
  }
}

type RetryMode = 'producer-first' | 'disposer-first' | 'reject' | 'fail' | 'timeout'

/** Separate replay11 fixture: the terminal-only upload8 above remains unchanged. */
export async function runUploadRetryCase(family: Family, mode: RetryMode) {
  const source = producer()
  const suffix = new TextEncoder().encode('stable-business-id:71;full-payload:конец')
  const payload = Buffer.concat([prefix, suffix])
  const agents = [
    new Agent({ connections: 1, pipelining: 1 }),
    new Agent({ connections: 1, pipelining: 1 })
  ]
  const sockets = new Set<Socket>()
  const socketClosures: Promise<void>[] = []
  const transports: Promise<unknown>[] = []
  const statuses: number[] = []
  const responses: (Response | UndiciResponse)[] = []
  const disposals: Promise<void>[] = []
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const requests: {
    bytes: Buffer[]
    ended: boolean
    pending: number
    identity: string | string[] | undefined
  }[] = []
  const attempts: {
    number: number
    id: number
    body: ReadableStream<Uint8Array>
    init: object
    signal: AbortSignal
  }[] = []
  const disposal: string[] = []
  const fixtureAbort = new AbortController()
  const finished = deferred<undefined>()
  let handle: Handle<string> | undefined
  let resultSettled = 0
  let resourcesSettled = 0
  let resourceEvents = 0
  let consumeCalls = 0
  let dispatches = 0
  let cancelTask: Promise<void> | undefined
  let agentClosures = 0
  const server = createServer((req, res) => {
    const entry: (typeof requests)[number] = {
      bytes: [],
      ended: false,
      pending: 0,
      identity: req.headers['x-business-id']
    }
    requests.push(entry)
    req.on('error', () => undefined)
    res.on('error', () => undefined)
    req.on('data', (chunk: Buffer) => {
      entry.bytes.push(chunk)
      if (requests.length === 1 && !res.headersSent) {
        entry.pending = source.state.pending
        res.writeHead(429, {
          'content-type': 'application/json',
          'connection': 'close',
          'content-length': Buffer.byteLength(errorBody)
        })
        res.end(errorBody)
      }
    })
    req.on('end', () => {
      entry.ended = true
      if (entry !== requests[0]) res.end('same operation completed')
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socketClosures.push(
      new Promise(resolve =>
        socket.once('close', () => {
          sockets.delete(socket)
          resolve()
        })
      )
    )
  })
  const spy = <R extends Response | UndiciResponse>(task: Promise<R>): Promise<R> => {
    const observed = task.then(response => {
      statuses.push(response.status)
      responses.push(response)
      return response
    })
    transports.push(
      observed.then(
        () => undefined,
        () => undefined
      )
    )
    return observed
  }
  const nativeTransport: typeof fetch = (url, init) => {
    const dispatcher = agents[dispatches++]
    assert.ok(dispatcher, 'NO_UNEXPECTED_THIRD_DISPATCH')
    const actual = {
      ...init,
      signal: AbortSignal.any([fixtureAbort.signal, ...(init?.signal ? [init.signal] : [])])
    }
    Object.defineProperty(actual, 'dispatcher', { value: dispatcher })
    return spy(globalThis.fetch(url, actual))
  }
  const undiciTransport: typeof undiciFetch = (url, init) => {
    const dispatcher = agents[dispatches++]
    assert.ok(dispatcher, 'NO_UNEXPECTED_THIRD_DISPATCH')
    return spy(
      undiciFetch(url, {
        ...init,
        dispatcher,
        signal: AbortSignal.any([fixtureAbort.signal, ...(init?.signal ? [init.signal] : [])])
      })
    )
  }
  const options = { maxParallelLimit: 2, jitter: 0, deadlineMs: 15000 }
  const planner =
    family === 'native'
      ? new FetchPlanner(nativeTransport, options)
      : new DeepPlanner(undiciTransport, options)
  const check = async () => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    handle = planner.submit({
      method: 'POST',
      replay: { serverSafe: true, consumeSafe: true },
      prepare: ctx => {
        const number = ctx.attemptNumber
        const body =
          number === 1
            ? source.body
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(prefix)
                  controller.enqueue(suffix)
                  controller.close()
                }
              })
        ctx.onDispose(() => {
          disposal.push(`${number}:outer`)
        })
        ctx.onDispose(async () => {
          disposal.push(`${number}:inner-start`)
          if (number === 1) {
            assert.equal(source.body.locked, true)
            cancelTask = assert.rejects(source.body.cancel(), TypeError)
            await cancelTask
            const disposalTask = source.dispose(mode === 'reject')
            disposals.push(disposalTask)
            await disposalTask
          }
          disposal.push(`${number}:inner-end`)
        })
        const init = {
          body,
          duplex: 'half' as const,
          redirect: 'error' as const,
          headers: { 'x-business-id': 'T71-stable' }
        }
        attempts.push({ number, id: ctx.operationId, body, init, signal: ctx.signal })
        return { url: `http://127.0.0.1:${address.port}/same`, init }
      },
      consume: (response: Response | UndiciResponse) => {
        consumeCalls++
        return response.text()
      }
    })
    void handle.result.then(
      () => {
        resultSettled++
      },
      () => {
        resultSettled++
      }
    )
    void handle.resourcesDone.then(() => {
      resourcesSettled++
    })
    handle.observe(event => {
      if (event.type === 'resources-settled') resourceEvents++
    })
    await source.entered.promise
    await source.stoppedSeen.promise
    // This fact is established before testing retry/accounting: actual early HTTP429,
    // and the cooperative request pull is still physically pending after parser EOF.
    assert.deepEqual(statuses, [429])
    assert.equal(planner.snapshot().effectiveParallelism, 1, 'REAL_JSON1073_CLASSIFICATION')
    assert.equal(responses[0]?.bodyUsed, true, 'BOUNDED_CLASSIFIER_READ_REAL_429')
    assert.equal(responses[0].body?.locked, false)
    assert.equal(requests[0]?.pending, 1)
    assert.equal(source.state.pending, 1)
    assert.equal(requests[0].ended, false)
    assert.deepEqual(Buffer.concat(requests[0].bytes), Buffer.from(prefix))
    console.log(
      JSON.stringify({ event: 'retry-ready', family, mode, status: 429, producerPending: 1 })
    )
    const held = async (pending: number) => {
      await turn()
      await turn()
      assert.equal(attempts.length, 1, 'SAME_OPERATION_RETRY_BEFORE_CLEANUP')
      assert.equal(dispatches, 1, 'SAME_OPERATION_RETRY_BEFORE_CLEANUP')
      assert.equal(planner.snapshot().leasedAttempts, 1, 'SAME_OPERATION_RETRY_BEFORE_CLEANUP')
      assert.equal(planner.snapshot().sentActive, 1, 'SAME_OPERATION_RETRY_BEFORE_CLEANUP')
      assert.equal(handle?.snapshot().resources, 'pending')
      assert.equal(handle.snapshot().outcome, 'pending')
      assert.equal(resultSettled, 0)
      assert.equal(resourcesSettled, 0)
      assert.equal(source.state.pending, pending)
      assert.equal(consumeCalls, 0)
      console.log(JSON.stringify({ event: 'retry-held', family, mode, producerPending: pending }))
    }
    await held(1)
    if (mode === 'fail') throw new Error('INJECTED_RETRY_AFTER_HEADERS')
    if (mode === 'timeout') {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        finished.reject(new Error('WATCHDOG_RETRY_UPLOAD'))
      }, 100)
      await finished.promise
      return
    }
    if (mode === 'disposer-first') {
      source.disposerGate.resolve(undefined)
      await held(1)
      source.work.resolve(undefined)
    } else {
      source.work.resolve(undefined)
      await source.producerDone.promise
      await held(0)
      source.disposerGate.resolve(undefined)
    }
    if (mode === 'reject') {
      const operationId = handle.id
      await assert.rejects(
        handle.result,
        error =>
          error instanceof OperationError &&
          error.code === 'HTTP_FAILED' &&
          error.status === 429 &&
          error.operationId === operationId &&
          error.serverOutcome === 'http-response'
      )
      assert.deepEqual(await handle.resourcesDone, { resources: 'failed' })
      assert.equal(handle.snapshot().resources, 'failed')
      assert.equal(attempts.length, 1)
      assert.equal(dispatches, 1)
      assert.equal(consumeCalls, 0)
      assert.deepEqual(disposal, ['1:inner-start', '1:outer'])
    } else {
      const result = await handle.result
      assert.deepEqual(
        { ...result },
        { value: 'same operation completed', status: 200, cleanup: 'released' }
      )
      assert.deepEqual(await handle.resourcesDone, { resources: 'released' })
      assert.deepEqual(
        attempts.map(attempt => attempt.number),
        [1, 2]
      )
      assert.deepEqual(
        attempts.map(attempt => attempt.id),
        [handle.id, handle.id]
      )
      assert.notEqual(attempts[0]?.body, attempts[1]?.body)
      assert.notEqual(attempts[0]?.init, attempts[1]?.init)
      assert.notEqual(attempts[0]?.signal, attempts[1]?.signal)
      assert.deepEqual(statuses, [429, 200])
      assert.equal(requests[1]?.ended, true)
      assert.deepEqual(
        Buffer.concat(requests[1].bytes),
        payload,
        'FULL_LOGICAL_PAYLOAD_ON_SAME_OPERATION_RETRY'
      )
      assert.deepEqual(
        requests.map(request => request.identity),
        ['T71-stable', 'T71-stable']
      )
      assert.equal(consumeCalls, 1)
      assert.deepEqual(disposal, [
        '1:inner-start',
        '1:inner-end',
        '1:outer',
        '2:inner-start',
        '2:inner-end',
        '2:outer'
      ])
    }
    assert.equal(source.state.stopCalls, 1)
    assert.equal(source.state.disposeCalls, 1)
    assert.equal(source.state.settled, 1)
    assert.equal(resourceEvents, 1)
    assert.equal(resourcesSettled, 1)
    assert.equal(handle.snapshot().attempts, mode === 'reject' ? 1 : 2)
    assert.equal(handle.snapshot().dispatchCalls, mode === 'reject' ? 1 : 2)
    assert.equal(planner.snapshot().leasedAttempts, 0)
    assert.equal(planner.snapshot().sentActive, 0)
    console.log(
      JSON.stringify({ event: 'retry-complete', family, mode, attempts: attempts.length })
    )
  }
  const running = check()
  const settled = running.then(
    () => undefined,
    () => undefined
  )
  watchdog = setTimeout(() => {
    finished.reject(new Error('WATCHDOG_RETRY_UPLOAD'))
  }, 12000)
  try {
    await Promise.race([running, finished.promise])
  } finally {
    source.stop()
    source.work.resolve(undefined)
    source.disposerGate.resolve(undefined)
    finished.resolve(undefined)
    handle?.abort()
    fixtureAbort.abort()
    await source.wait()
    await Promise.allSettled([
      handle?.result,
      handle?.resourcesDone,
      cancelTask,
      ...disposals,
      ...transports
    ])
    for (const socket of sockets) socket.destroy()
    const closures = await Promise.allSettled([
      ...agents.map(async agent => {
        await agent.destroy()
        agentClosures++
      }),
      server.listening
        ? new Promise<void>((resolve, reject) =>
            server.close(error => {
              if (error) reject(error)
              else resolve()
            })
          )
        : Promise.resolve(),
      ...socketClosures
    ])
    await settled
    clearTimeout(watchdog)
    for (const closure of closures) assert.equal(closure.status, 'fulfilled')
    assert.equal(source.state.pending, 0)
    assert.equal(sockets.size, 0)
    assert.equal(server.listening, false)
    assert.equal(agentClosures, 2)
    console.log(
      JSON.stringify({
        event: 'retry-finally-clean',
        family,
        mode,
        producerPending: source.state.pending,
        sockets: sockets.size,
        serverListening: server.listening,
        agentsClosed: agentClosures
      })
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const family = process.argv[2]
  const mode = process.argv[3]
  assert.ok(family === 'native' || family === 'undici')
  if (mode?.startsWith('retry-')) {
    const retryMode = mode.slice(6)
    assert.ok(
      retryMode === 'producer-first' ||
        retryMode === 'disposer-first' ||
        retryMode === 'reject' ||
        retryMode === 'fail' ||
        retryMode === 'timeout'
    )
    await runUploadRetryCase(family, retryMode)
  } else {
    assert.ok(
      mode === 'released' || mode === 'rejected' || mode === 'failure' || mode === 'watchdog'
    )
    await runUploadCase(family, mode)
  }
}
