// Compile-only fixture: importing this module performs no account or filesystem work.
import { stringify } from 'csv-stringify'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fetch } from 'undici'
import type { Response } from 'undici'
import { FetchPlanner, OperationError } from '../src/index.js'
import type { Event, FailureCode, Handle } from '../src/index.js'

export interface StressRequest {
  readonly process: number
  readonly duration: number
}

export interface StressResult {
  readonly process: number
  readonly submitted: number
  readonly succeeded: number
  readonly httpFailed: number
  readonly rows: number
  readonly elapsedMs: number
}

const WINDOW = 5

/** Caller-only HTTP details. Never serialize this error, its body, or its cause. */
class StressHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super('STRESS_HTTP_FAILED')
    this.name = 'StressHttpError'
  }
}

async function consumeDemand(response: Response): Promise<number> {
  // Read to EOF; non-JSON HTTP error bodies remain caller-controlled details.
  const body = await response.text()
  if (!response.ok) throw new StressHttpError(response.status, body)
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('STRESS_EXPECTED_JSON')
  }
  const value: unknown = JSON.parse(body)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('rows' in value) ||
    !Array.isArray(value.rows)
  ) {
    throw new Error('STRESS_INVALID_COLLECTION')
  }
  // JSON/schema/read failures are not branded as retryable wire failures.
  return value.rows.length
}

function createEvent(processNumber: number, event: Event, planner: FetchPlanner<typeof fetch>) {
  const state = planner.snapshot()
  // Explicit allowlist: no raw URL/query/body/Error/headers/token/value/entity key.
  return {
    process: processNumber,
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    phase: event.phase,
    epoch: event.epochTime,
    elapsed: event.elapsedMs,
    attempts: event.attempts,
    dispatches: event.dispatchCalls,
    status: event.status ?? '',
    code: event.failureCode ?? '',
    queued: state.queued,
    leased: state.leasedAttempts,
    inflight: state.sentActive,
    effective_parallelism: state.effectiveParallelism,
    resources: event.resources
  }
}

async function finished(handle: Handle<number>) {
  try {
    const completed = await handle.result
    const resources = await handle.resourcesDone
    if (resources.resources !== 'released') throw new Error('STRESS_CLEANUP_FAILED')
    return completed
  } finally {
    // Result settlement alone never releases ownership of known work.
    await handle.resourcesDone
  }
}

export async function stressTest(params: StressRequest): Promise<StressResult> {
  if (process.env['MOYSKLAD_LIVE_STRESS'] !== '1') throw new Error('STRESS_DISABLED')
  if (
    !Number.isSafeInteger(params.process) ||
    params.process < 1 ||
    !Number.isSafeInteger(params.duration) ||
    params.duration < 1 ||
    params.duration > 2147483647
  ) {
    throw new Error('STRESS_INVALID_PARAMETERS')
  }
  // The owner supplies credentials externally. Never log params or environment.
  const accessToken = process.env['MOYSKLAD_TOKEN']
  if (!accessToken) throw new Error('STRESS_TOKEN_REQUIRED')

  const { process: processNumber, duration } = params
  const started = performance.now()
  const planner = new FetchPlanner(fetch, {
    maxParallelLimit: WINDOW,
    maxQueuedOperations: WINDOW,
    maxAttempts: 3,
    deadlineMs: 120000,
    attemptTimeoutMs: 30000,
    parallelLimitCorrectionPeriodMs: 5000
  })
  const active = new Map<Handle<number>, Promise<void>>()
  const events = new PassThrough({ objectMode: true })
  const state: {
    pipelineFailed: boolean
    backpressured: boolean
    failureCode?:
      | FailureCode
      | 'STRESS_WORKER_FAILED'
      | 'STRESS_CLEANUP_FAILED'
      | 'STRESS_REPORT_FAILED'
  } = { pipelineFailed: false, backpressured: false }
  let submitted = 0
  let succeeded = 0
  let httpFailed = 0
  let rows = 0
  let pipelineDone: Promise<void> | undefined
  const observation = planner.observe(event => {
    if (!state.pipelineFailed) {
      state.backpressured =
        !events.write(createEvent(processNumber, event, planner)) || state.backpressured
    }
  })

  try {
    const directory = path.join(process.cwd(), '__temp/stress-test', String(processNumber))
    await mkdir(directory, { recursive: true })
    // Attach the rejection handler immediately; filesystem failures must not escape
    // as unhandled rejections while a request window is still running.
    pipelineDone = pipeline(
      events,
      stringify({ header: true }),
      createWriteStream(path.join(directory, 'report.csv'))
    ).catch(() => {
      state.pipelineFailed = true
      state.failureCode ??= 'STRESS_REPORT_FAILED'
    })

    const expands = [
      '',
      'agent',
      'organization',
      'positions',
      'positions.assortment',
      'positions.assortment.productFolder',
      'agent,positions',
      'agent,positions.assortment',
      'agent,positions.assortment.productFolder',
      'organization,agent,positions',
      'organization,agent,positions.assortment',
      'organization,agent,positions.assortment.productFolder'
    ]

    // Each window contains at most WINDOW actual handles, including physical
    // cleanup. The planner alone owns wire pacing and attempt retries.
    while (performance.now() - started < duration) {
      if (state.pipelineFailed) throw new Error('STRESS_REPORT_FAILED')
      const pending: Promise<void>[] = []
      for (let index = 0; index < WINDOW && performance.now() - started < duration; index++) {
        const expand = expands[Math.floor(Math.random() * expands.length)] ?? ''
        const query = new URLSearchParams({
          limit: String(Math.round(Math.random() * 20)),
          offset: String(1 + Math.round(Math.random() * 10))
        })
        if (expand) query.set('expand', expand)
        // Keep deliberate invalid-entity GETs in the same API origin; no random
        // third-party hosts or obsolete API versions. No account writes.
        const endpoint = Math.random() > 0.97 ? 'foo' : 'demand'
        const requestUrl = `https://api.moysklad.ru/api/remap/1.2/entity/${endpoint}?${query}`
        const handle = planner.submit({
          method: 'GET',
          replay: { serverSafe: true, consumeSafe: true },
          prepare: () => ({
            url: new URL(requestUrl),
            init: {
              headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept-Encoding': 'gzip' },
              redirect: 'error'
            }
          }),
          consume: consumeDemand
        })
        submitted++
        const work = finished(handle)
          .then(completed => {
            succeeded++
            rows += completed.value
          })
          .catch(async (error: unknown) => {
            const resources = await handle.resourcesDone
            if (resources.resources !== 'released') {
              state.failureCode ??= 'STRESS_CLEANUP_FAILED'
              planner.stop()
            } else if (
              endpoint === 'foo' &&
              error instanceof OperationError &&
              error.cause instanceof StressHttpError
            ) {
              httpFailed++
            } else {
              // Keep original errors caller-local; only a closed code crosses the
              // worker boundary. An unexpected operation failure stops this producer.
              state.failureCode ??=
                error instanceof OperationError ? error.code : 'STRESS_WORKER_FAILED'
              planner.stop()
            }
          })
          .finally(() => {
            active.delete(handle)
          })
        active.set(handle, work)
        pending.push(work)
      }
      await Promise.all(pending)
      if (state.failureCode) throw new Error(state.failureCode)
      if (state.backpressured) {
        // No observer awaits or controls policy. Drain only between full windows;
        // event production is bounded by handles and finite attempt counts.
        if (events.writableNeedDrain) {
          await new Promise<void>(resolve => {
            const drained = () => {
              events.off('drain', drained)
              events.off('close', drained)
              resolve()
            }
            events.once('drain', drained)
            events.once('close', drained)
          })
        }
        state.backpressured = false
      }
    }
  } catch (error: unknown) {
    // Do not leak an HTTP body, transport cause or filesystem path through Piscina.
    state.failureCode ??= error instanceof OperationError ? error.code : 'STRESS_WORKER_FAILED'
  } finally {
    planner.stop()
    for (const handle of active.keys()) handle.abort()
    const handles = [...active.keys()]
    await Promise.all(active.values())
    const cleanup = await Promise.all(handles.map(handle => handle.resourcesDone))
    observation.unsubscribe()
    events.end()
    if (pipelineDone) await pipelineDone
    else events.destroy()
    if (cleanup.some(summary => summary.resources !== 'released')) {
      state.failureCode ??= 'STRESS_CLEANUP_FAILED'
    }
    if (state.pipelineFailed) state.failureCode ??= 'STRESS_REPORT_FAILED'
  }

  if (state.failureCode) throw new Error(state.failureCode)
  return {
    process: processNumber,
    submitted,
    succeeded,
    httpFailed,
    rows,
    elapsedMs: Math.round(performance.now() - started)
  }
}
