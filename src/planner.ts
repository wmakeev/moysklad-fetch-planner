import { isErrored, isReadable } from 'node:stream'
import { CallbackContext } from './callback-context.js'
import { OperationCapacity } from './operation-capacity.js'
import { OperationResources } from './operation-resources.js'
import { OperationState } from './operation-state.js'
import { MAX_TIMEOUT_MS, monotonicNow } from './runtime.js'
import type {
  Attachment,
  Descriptor,
  Event,
  FailureCode,
  FetchPlannerOptions,
  Handle,
  Init,
  OneTransport,
  Planner,
  PlannerSnapshot,
  ResourceSummary,
  ResponseOf,
  Spec,
  Transport
} from './operation-types.js'
import { OperationError } from './operation-types.js'

const defaults: FetchPlannerOptions = {
  maxParallelLimit: 4,
  maxQueuedOperations: 1024,
  maxSubscribers: 64,
  deadlineMs: 120000,
  attemptTimeoutMs: 30000,
  cleanupGraceMs: 5000,
  maxAttempts: 3,
  hookTimeoutMs: 1000,
  throttlingCoefficient: 5,
  maxRequestDelayTimeMs: 3000,
  jitter: 0.1,
  parallelLimitCorrectionPeriodMs: 10000,
  maxEntityKeys: 1024,
  errorPerMinuteLimit: 100,
  rateLimitPerMinuteLimit: 100,
  entityPutPerMinuteLimit: 60
}

function invalid(cause?: unknown): OperationError {
  return new OperationError(
    'INVALID_ARGUMENT',
    { phase: 'queued', operationId: 0, attemptNumber: 0, dispatchEntered: false },
    cause
  )
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw invalid()
  return input as Record<string, unknown>
}

function validateSpec(input: unknown): void {
  const spec = record(input)
  const allowed = ['method', 'entityKey', 'prepare', 'consume', 'replay', 'deadlineMs']
  if (Reflect.ownKeys(spec).some(key => typeof key !== 'string' || !allowed.includes(key)))
    throw invalid()
  if (
    typeof spec['method'] !== 'string' ||
    !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(
      spec['method']
    )
  )
    throw invalid()
  if (
    spec['method'] === 'PUT'
      ? typeof spec['entityKey'] !== 'string' ||
        spec['entityKey'].length < 1 ||
        spec['entityKey'].length > 128
      : spec['entityKey'] !== undefined
  )
    throw invalid()
  const replay = record(spec['replay'])
  if (
    typeof spec['prepare'] !== 'function' ||
    typeof spec['consume'] !== 'function' ||
    typeof replay['serverSafe'] !== 'boolean' ||
    typeof replay['consumeSafe'] !== 'boolean'
  )
    throw invalid()
  if (
    spec['deadlineMs'] !== undefined &&
    (typeof spec['deadlineMs'] !== 'number' ||
      !Number.isSafeInteger(spec['deadlineMs']) ||
      spec['deadlineMs'] < 1)
  )
    throw invalid()
}

function optionsFrom(input: Partial<FetchPlannerOptions>): FetchPlannerOptions {
  record(input)
  const options = { ...defaults }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !Object.hasOwn(defaults, key)) throw invalid()
  }
  Object.assign(options, input)
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid()
    if (key === 'jitter') {
      if (value < 0 || value > 0.3) throw invalid()
    } else if (key === 'throttlingCoefficient') {
      if (value < 1 || value > 20) throw invalid()
    } else if (
      key === 'maxParallelLimit' ||
      key === 'maxRequestDelayTimeMs' ||
      key === 'parallelLimitCorrectionPeriodMs'
    ) {
      const rounded = Math.round(value)
      if (
        !Number.isSafeInteger(rounded) ||
        rounded < (key === 'parallelLimitCorrectionPeriodMs' ? 1000 : 1)
      )
        throw invalid()
      Object.assign(options, { [key]: rounded })
    } else if (!Number.isSafeInteger(value) || value < 1) throw invalid()
  }
  return Object.freeze(options)
}

type Lease = NonNullable<ReturnType<OperationCapacity<Entry>['take']>>['lease']
interface Entry {
  start(lease: Lease): Promise<void>
  cancel(code: 'ABORTED' | 'STOPPED', reason?: unknown): void
  nextWake(): number | undefined
  expire(now: number): void
}

/** The sole coordinator. Ownership remains with an attempt until actual cleanup settles. */
export class FetchPlanner<F extends Transport> implements Planner<Init<F>, ResponseOf<F>> {
  readonly #transport: (
    url: string | URL,
    init: Omit<NonNullable<Parameters<F>[1]>, 'method' | 'signal'> & {
      method: string
      signal: AbortSignal
    }
  ) => Promise<ResponseOf<F>>
  readonly #options: FetchPlannerOptions
  readonly #context = new CallbackContext()
  readonly #capacity: OperationCapacity<Entry>
  readonly #active = new Set<Entry>()
  readonly #listeners = new Set<(event: Event) => void>()
  readonly #startedAt = monotonicNow()
  #sequence = 0
  #nextId = 1
  #stopped = false
  #stopReason: unknown
  #pumpScheduled = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(transport: F & OneTransport<F>, options: Partial<FetchPlannerOptions> = {}) {
    if (typeof transport !== 'function') throw invalid()
    try {
      this.#options = optionsFrom(options)
    } catch (cause) {
      if (cause instanceof OperationError) throw cause
      throw invalid(cause)
    }
    this.#capacity = new OperationCapacity(
      this.#options.maxQueuedOperations,
      this.#options.maxParallelLimit
    )
    // TS cannot preserve the selected generic family's call signature through its union
    // constraint. This internal invocation cast keeps init/response paired with the same F;
    // public consumers retain OneTransport and never receive a union body/response API.
    this.#transport = transport as unknown as (
      url: string | URL,
      init: Omit<NonNullable<Parameters<F>[1]>, 'method' | 'signal'> & {
        method: string
        signal: AbortSignal
      }
    ) => Promise<ResponseOf<F>>
  }

  submit<T>(input: Spec<Init<F>, ResponseOf<F>, T>): Handle<T> {
    const reject = (code: FailureCode, cause?: unknown) =>
      OperationState.rejected<T>(
        code,
        new OperationError(
          code,
          { phase: 'queued', operationId: 0, attemptNumber: 0, dispatchEntered: false },
          cause
        )
      )
    if (this.#context.isActive()) return reject('REENTRANT_OPERATION')
    if (this.#stopped) return reject('STOPPED', this.#stopReason)
    let spec: Spec<Init<F>, ResponseOf<F>, T>
    try {
      spec = { ...input }
      validateSpec(spec)
    } catch (cause) {
      return reject('INVALID_ARGUMENT', cause)
    }
    if (!Number.isSafeInteger(this.#nextId)) return reject('ID_EXHAUSTED')

    const deadline = monotonicNow() + (spec.deadlineMs ?? this.#options.deadlineMs)
    if (!Number.isSafeInteger(deadline)) return reject('INVALID_ARGUMENT')
    const controller = new AbortController()
    const state = new OperationState<T>(this.#nextId, reason => {
      entry.cancel('ABORTED', reason)
    })
    const resources = new OperationResources(this.#context)
    let started = false
    let attemptDeadline: number | undefined
    let cleanupDeadline: number | undefined
    const fail = (code: FailureCode, cause?: unknown) => {
      const snapshot = state.snapshot()
      return state.fail(
        code,
        new OperationError(
          code,
          {
            phase: snapshot.phase,
            operationId: snapshot.id,
            attemptNumber: snapshot.attempts,
            dispatchEntered: snapshot.dispatchEntered,
            status: snapshot.status
          },
          cause
        ),
        this.#stamp()
      )
    }
    const nextWake = () => {
      const snapshot = state.snapshot()
      if (snapshot.outcome !== 'pending') return undefined
      return snapshot.resultCommitted
        ? cleanupDeadline
        : Math.min(deadline, attemptDeadline ?? deadline)
    }
    const expire = (now: number) => {
      if (state.snapshot().outcome !== 'pending') return
      if (state.snapshot().resultCommitted) {
        if (cleanupDeadline !== undefined && now >= cleanupDeadline)
          state.succeed('pending', this.#stamp())
        return
      }
      const code =
        now >= deadline
          ? 'DEADLINE'
          : attemptDeadline !== undefined && now >= attemptDeadline
            ? 'ATTEMPT_TIMEOUT'
            : undefined
      if (code && fail(code)) {
        controller.abort()
        if (!started) {
          reservation?.release()
          state.settleResources({ resources: 'released' }, this.#stamp())
          this.#active.delete(entry)
        }
      }
    }
    const entry: Entry = {
      nextWake,
      expire,
      cancel: (code, reason) => {
        if (code === 'STOPPED' && state.snapshot().dispatchEntered) return
        if (code === 'ABORTED' && state.snapshot().resultCommitted) {
          state.succeed('pending', this.#stamp())
          this.#armTimer()
          return
        }
        if (!fail(code, reason)) return
        controller.abort(reason)
        if (!started) {
          reservation?.release()
          state.settleResources({ resources: 'released' }, this.#stamp())
          this.#active.delete(entry)
        }
        this.#armTimer()
      },
      start: async lease => {
        started = true
        let token: ReturnType<Lease['trySend']>
        let response: ResponseOf<F> | undefined
        let code: FailureCode = 'PREPARE_FAILED'
        try {
          expire(monotonicNow())
          if (state.snapshot().outcome !== 'pending') return
          attemptDeadline = monotonicNow() + this.#options.attemptTimeoutMs
          this.#armTimer()
          state.transition('phase-changed', { phase: 'preparing', attempts: 1 }, this.#stamp())
          const descriptor = await resources.runOwner(
            'prepare',
            registrations =>
              spec.prepare({
                signal: controller.signal,
                operationId: state.handle.id,
                attemptNumber: 1,
                onDispose: registrations.onDispose
              }),
            raw => this.#descriptor(raw)
          )
          if (state.snapshot().outcome !== 'pending') return
          state.transition('phase-changed', { phase: 'ready' }, this.#stamp())
          if (this.#stopped) {
            entry.cancel('STOPPED', this.#stopReason)
            return
          }
          expire(monotonicNow())
          if (state.snapshot().outcome !== 'pending') return
          token = lease.trySend()
          if (!token) throw new Error('DISPATCH_CAPACITY_UNAVAILABLE')
          code = 'TRANSPORT_FAILED'
          const work = state.deferDelivery(() => {
            state.transition(
              'dispatch-started',
              { phase: 'sending', dispatchCalls: 1, dispatchEntered: true },
              this.#stamp()
            )
            // No observer/user callback between final admission and transport entry.
            // Synchronous transport abort reads these same committed dispatch facts.
            return this.#transport(descriptor.value.url, {
              ...descriptor.value.init,
              method: spec.method,
              signal: controller.signal
            })
          })
          response = await work
          // Read the receipt's HTTP fact once; custom Response accessors can run user code.
          const status = response.status
          state.transition('headers-received', { phase: 'classifying', status }, this.#stamp())
          if (state.snapshot().outcome !== 'pending') return
          if (status === 429) {
            fail('HTTP_FAILED')
            return
          }
          code = 'CONSUME_FAILED'
          state.transition('phase-changed', { phase: 'consuming' }, this.#stamp())
          const borrowed = response
          const value = await resources.runOwner(
            'consume',
            registrations =>
              spec.consume(borrowed, {
                signal: controller.signal,
                operationId: state.handle.id,
                attemptNumber: 1,
                ...registrations,
                retryableReadFailure: cause => new Error('RETRYABLE_READ_FAILURE', { cause })
              }),
            raw => raw
          )
          // Materialize clocks before the final safety decision: even Date.now may run
          // user code. Only scalar facts and the guarded value box enter commit.
          const stamp = this.#stamp()
          const now = monotonicNow()
          expire(now)
          if (state.snapshot().outcome === 'pending') {
            cleanupDeadline = Math.min(deadline, now + this.#options.cleanupGraceMs)
            state.commit(value, status, stamp)
            this.#armTimer()
          }
        } catch (cause) {
          fail(code, cause)
        } finally {
          if (state.snapshot().outcome === 'pending')
            state.transition('phase-changed', { phase: 'cleanup' }, this.#stamp())
          const cleanup = await resources.cleanup(!state.snapshot().resultCommitted)
          let responseResources: ResourceSummary['resources'] = 'released'
          try {
            const body = response?.body
            if (body) {
              // Await cancellation of an unlocked remainder as known work.
              if (!body.locked) await body.cancel()
              else {
                // Node's public probes support Web Streams, but @types/node24
                // omits that overload (its declaration has a TODO). Keep this
                // compatibility cast internal; never use bodyUsed as EOF proof.
                const stream = body as unknown as Parameters<typeof isReadable>[0]
                // Helpers can retain a closed reader. Only a confirmed closed,
                // non-errored stream proves completion; null is unconfirmed too.
                if (isReadable(stream) !== false || isErrored(stream)) responseResources = 'unknown'
              }
            }
          } catch {
            responseResources = 'failed'
          }
          const summary = {
            resources:
              responseResources === 'failed' || cleanup.resources === 'failed'
                ? 'failed'
                : responseResources === 'unknown'
                  ? 'unknown'
                  : cleanup.resources
          } as const
          if (state.snapshot().resultCommitted)
            state.succeed(summary.resources === 'released' ? 'released' : 'failed', this.#stamp())
          token?.release()
          lease.release()
          state.settleResources(summary, this.#stamp())
          this.#active.delete(entry)
          this.#armTimer()
          this.#wake()
        }
      }
    }
    const reservation = this.#capacity.reserve(entry)
    if (!reservation) return reject('QUEUE_FULL')
    this.#nextId++
    this.#active.add(entry)
    state.handle.observe(event => {
      for (const listener of [...this.#listeners]) {
        try {
          listener(event)
        } catch {
          /* Full observer isolation follows in T47. */
        }
      }
    })
    reservation.enqueue()
    state.transition('created', {}, this.#stamp())
    this.#armTimer()
    this.#wake()
    return state.handle
  }

  snapshot(): PlannerSnapshot {
    return Object.freeze({
      sequence: this.#sequence,
      stopped: this.#stopped,
      guardOpen: false,
      ...this.#capacity.snapshot(),
      serverNotBefore: 0
    })
  }

  observe(listener: (event: Event) => void): Attachment<PlannerSnapshot> {
    if (typeof listener !== 'function') throw invalid()
    const subscription = (event: Event) => {
      listener(event)
    }
    this.#listeners.add(subscription)
    return Object.freeze({
      snapshot: this.snapshot(),
      unsubscribe: () => {
        this.#listeners.delete(subscription)
      }
    })
  }

  stop(reason?: unknown): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#stopReason = reason
    for (const entry of this.#active) entry.cancel('STOPPED', reason)
  }

  #stamp() {
    return {
      sequence: ++this.#sequence,
      epochTime: Date.now(),
      elapsedMs: monotonicNow() - this.#startedAt
    }
  }

  #descriptor(raw: Descriptor<Init<F>>): Descriptor<Init<F>> {
    const descriptor = record(raw)
    if (!(typeof descriptor['url'] === 'string' || descriptor['url'] instanceof URL))
      throw invalid()
    record(descriptor['init'])
    const init = { ...raw.init }
    const fields = record(init)
    if (fields['method'] !== undefined || fields['signal'] !== undefined) throw invalid()
    return { url: typeof raw.url === 'string' ? raw.url : raw.url.href, init }
  }

  /** One timer belongs to this coordinator, including logical cleanup grace. */
  #armTimer(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    let next = Infinity
    for (const entry of this.#active) next = Math.min(next, entry.nextWake() ?? Infinity)
    if (next === Infinity) return
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined
        const now = monotonicNow()
        for (const entry of this.#active) entry.expire(now)
        this.#armTimer()
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(0, next - monotonicNow()))
    )
  }

  #wake(): void {
    if (this.#pumpScheduled) return
    this.#pumpScheduled = true
    queueMicrotask(() => {
      this.#pumpScheduled = false
      while (!this.#stopped) {
        const next = this.#capacity.take()
        if (!next) break
        void next.value.start(next.lease)
      }
    })
  }
}
