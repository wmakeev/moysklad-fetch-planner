import { OperationObservation, ObservationSequence } from './operation-observation.js'
import { isErrored, isReadable } from 'node:stream'
import { CallbackContext } from './callback-context.js'
import { OperationCapacity } from './operation-capacity.js'
import { runHook } from './operation-hooks.js'
import { OperationResources } from './operation-resources.js'
import { OperationState } from './operation-state.js'
import { GuardStore } from './guard.js'
import { ResponseClassifier } from './response-classifier.js'
import { parseResponsePolicy } from './response-policy.js'
import {
  calculateRequestDelay,
  createAttenuationSteps,
  requestDeadline,
  safeTime
} from './pacing.js'
import { retryCandidate, retryDecision, type RetryCandidate } from './retry-policy.js'
import { absoluteDeadline, MAX_TIMEOUT_MS, monotonicNow } from './runtime.js'
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
import { ConsumeReadFailure, OperationError } from './operation-types.js'

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
  const allowed = [
    'method',
    'entityKey',
    'prepare',
    'consume',
    'replay',
    'deadlineMs',
    'beforeDispatch'
  ]
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
  if (spec['beforeDispatch'] !== undefined && typeof spec['beforeDispatch'] !== 'function')
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
  cancel(
    code: 'ABORTED' | 'STOPPED' | 'GUARD_OPEN' | 'SEQUENCE_EXHAUSTED' | 'INVALID_ARGUMENT',
    reason?: unknown
  ): void
  nextWake(): number | undefined
  expire(now: number): void
  admit(): number
  releaseReady(): void
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
  readonly #guard: GuardStore
  #guardAt = -Infinity
  readonly #context = new CallbackContext()
  readonly #consumeScope = new CallbackContext()
  readonly #capacity: OperationCapacity<Entry>
  readonly #active = new Set<Entry>()
  private readonly observation: OperationObservation
  private readonly observationSequence = new ObservationSequence()
  readonly #startedAt = monotonicNow()
  readonly #ready = new Set<Entry>()
  readonly #attenuationSteps: readonly number[]
  #parallelCorrection = 0
  #parallelCorrectionAt = 0
  #recoveryWake = Infinity
  readonly #pacing: {
    limit: number | null
    remaining: number | null
    retryTimeInterval: number
    lastDispatchAt: number
    serverNotBefore: number
    guardOpen: boolean
  } = {
    limit: null,
    remaining: null,
    retryTimeInterval: 3000,
    lastDispatchAt: 0,
    serverNotBefore: 0,
    guardOpen: false
  }
  #pacingPlan: { key: string; notBefore: number } | undefined
  #readyWake = Infinity
  private nextId = 1
  private idExhausted = false
  #sequenceExhausted = false
  private readonly commands: (() => void)[] = []
  private drainingCommands = false
  #stopCode: 'STOPPED' | 'GUARD_OPEN' = 'STOPPED'
  #stopRequested = false
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
    this.#guard = new GuardStore({
      maxEntityKeys: this.#options.maxEntityKeys,
      errorPerMinuteLimit: this.#options.errorPerMinuteLimit,
      rateLimitPerMinuteLimit: this.#options.rateLimitPerMinuteLimit,
      entityPutPerMinuteLimit: this.#options.entityPutPerMinuteLimit
    })
    this.observation = new OperationObservation(
      this.#options.maxSubscribers,
      undefined,
      () => {
        this.#drainCommands()
      },
      delivery => {
        this.#context.detached(delivery)
      }
    )
    this.#attenuationSteps = createAttenuationSteps(this.#options.throttlingCoefficient)
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
    const reject = (code: FailureCode, cause?: unknown) => {
      this.observation.diagnostics.reject(code)
      return OperationState.rejected<T>(
        code,
        new OperationError(
          code,
          { phase: 'queued', operationId: 0, attemptNumber: 0, dispatchEntered: false },
          cause
        )
      )
    }
    if (this.observationSequence.isExhausted) return reject('SEQUENCE_EXHAUSTED')
    if (this.#context.isActive()) return reject('REENTRANT_OPERATION')
    if (this.#stopRequested) return reject(this.#stopCode, this.#stopReason)
    // Reserve before copying/accessing user spec or retaining it in a command.
    const entry: Entry = {
      start: () => {
        throw new Error('UNMATERIALIZED_OPERATION')
      },
      cancel: () => undefined,
      nextWake: () => undefined,
      expire: () => undefined,
      admit: () => Infinity,
      releaseReady: () => undefined
    }
    const initialReservation = this.#capacity.reserve(entry)
    if (!initialReservation) return reject('QUEUE_FULL')
    let reservation = initialReservation
    const rejectReserved = (code: FailureCode, cause?: unknown) => {
      reservation.release()
      return reject(code, cause)
    }
    let spec: Spec<Init<F>, ResponseOf<F>, T>
    try {
      spec = { ...input }
      validateSpec(spec)
    } catch (cause) {
      return rejectReserved('INVALID_ARGUMENT', cause)
    }
    if (this.#submissionStopped()) return rejectReserved(this.#stopCode, this.#stopReason)
    if (this.observationSequence.current >= Number.MAX_SAFE_INTEGER)
      return rejectReserved('SEQUENCE_EXHAUSTED')
    if (this.idExhausted || !Number.isSafeInteger(this.nextId) || this.nextId < 1)
      return rejectReserved('ID_EXHAUSTED')

    const deadline = absoluteDeadline(monotonicNow(), spec.deadlineMs ?? this.#options.deadlineMs)
    if (deadline === undefined) return rejectReserved('INVALID_ARGUMENT')
    let abortRequested = false
    const state = new OperationState<T>(
      this.nextId,
      reason => {
        if (abortRequested || state.snapshot().outcome !== 'pending') return
        abortRequested = true
        this.#command(() => {
          entry.cancel('ABORTED', reason)
        })
      },
      this.observation,
      this.#options.maxSubscribers
    )
    // Operation state and its admission deadline outlive this attempt's ownership.
    // Never reset/reuse a closing resource registry for another preparation.
    interface Attempt {
      readonly number: number
      readonly controller: AbortController
      readonly resources: OperationResources
      readonly lease: Lease
      deadline: number | undefined
      classifier: ResponseClassifier | undefined
      classificationWake: number | undefined
      hookNotBefore: number | undefined
      hookDeadline: number | undefined
      hookWork: ReturnType<typeof runHook> | undefined
      token: ReturnType<Lease['trySend']>
      response: ResponseOf<F> | undefined
    }
    let currentAttempt: Attempt | undefined
    let cleanupDeadline: number | undefined
    let retryNotBefore: number | undefined
    let rateLimitOrdinal = 0
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
            dispatchEntered: currentAttempt?.token !== undefined,
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
        : Math.min(
            deadline,
            currentAttempt?.deadline ?? deadline,
            currentAttempt?.classificationWake ?? Infinity,
            currentAttempt?.hookDeadline ?? Infinity,
            retryNotBefore ?? Infinity
          )
    }
    const expire = (now: number) => {
      if (state.snapshot().outcome !== 'pending') return
      if (state.snapshot().resultCommitted) {
        if (cleanupDeadline !== undefined && now >= cleanupDeadline)
          state.succeed('pending', this.#stamp())
        return
      }
      if (retryNotBefore !== undefined && now >= retryNotBefore && now < deadline) {
        retryNotBefore = undefined
        reservation.enqueue()
        this.#wake()
      }
      const attempt = currentAttempt
      const code =
        now >= deadline
          ? 'DEADLINE'
          : attempt?.deadline !== undefined && now >= attempt.deadline
            ? 'ATTEMPT_TIMEOUT'
            : attempt?.hookDeadline !== undefined && now >= attempt.hookDeadline
              ? 'HOOK_FAILED'
              : undefined
      if (code && fail(code)) {
        attempt?.controller.abort()
        attempt?.classifier?.cancel()
        entry.releaseReady()
        if (!currentAttempt) {
          reservation.release()
          this.#active.delete(entry)
          state.settleResources({ resources: 'released' }, this.#stamp())
        }
      }
      if (attempt?.classificationWake !== undefined && now >= attempt.classificationWake) {
        attempt.classificationWake = undefined
        attempt.classifier?.expire(now)
      }
    }
    const materialized: Entry = {
      admit: () => Infinity,
      releaseReady: () => undefined,
      nextWake,
      expire,
      cancel: (code, reason) => {
        if ((code === 'STOPPED' || code === 'GUARD_OPEN') && currentAttempt?.token) return
        if (code !== 'STOPPED' && code !== 'GUARD_OPEN' && state.snapshot().resultCommitted) {
          state.succeed('pending', this.#stamp())
          this.#armTimer()
          return
        }
        if (!fail(code, reason)) return
        currentAttempt?.controller.abort(reason)
        currentAttempt?.classifier?.cancel()
        entry.releaseReady()
        if (!currentAttempt) {
          reservation.release()
          this.#active.delete(entry)
          state.settleResources({ resources: 'released' }, this.#stamp())
        }
        this.#armTimer()
      },
      start: async lease => {
        const attempt: Attempt = {
          number: state.snapshot().attempts + 1,
          controller: new AbortController(),
          resources: new OperationResources(this.#context),
          lease,
          deadline: undefined,
          classifier: undefined,
          classificationWake: undefined,
          hookNotBefore: undefined,
          hookDeadline: undefined,
          hookWork: undefined,
          token: undefined,
          response: undefined
        }
        currentAttempt = attempt
        let code: FailureCode = 'PREPARE_FAILED'
        let candidate: RetryCandidate | undefined
        let failure: { code: FailureCode; error: OperationError } | undefined
        const recordFailure = (failureCode: FailureCode, cause?: unknown) => {
          candidate ??= retryCandidate(
            { code: failureCode, status: state.snapshot().status, cause },
            spec.replay
          )
          if (
            failureCode === 'TRANSPORT_FAILED' &&
            (!attempt.token || attempt.response !== undefined)
          )
            candidate = undefined
          const snapshot = state.snapshot()
          failure = {
            code: failureCode,
            error: new OperationError(
              failureCode,
              {
                phase: snapshot.phase,
                operationId: snapshot.id,
                attemptNumber: snapshot.attempts,
                dispatchEntered: attempt.token !== undefined,
                status: snapshot.status
              },
              cause
            )
          }
          // A candidate with no possible remaining budget is already terminal; do not
          // make its logical result wait for a cleanup that cannot permit another send.
          const eligibility = retryDecision({
            candidate,
            attempts: attempt.number,
            maxAttempts: this.#options.maxAttempts,
            deadline,
            now: monotonicNow(),
            stopped: this.#stopRequested,
            cleanup: 'pending',
            rateLimitOrdinal,
            jitterFactor: 0.8,
            adaptiveNotBefore: 0,
            serverNotBefore: this.#pacing.serverNotBefore
          })
          if (candidate && this.#stopRequested) fail(this.#stopCode, this.#stopReason)
          else if (eligibility.kind === 'terminal') fail(failureCode, cause)
        }
        try {
          expire(monotonicNow())
          if (state.snapshot().outcome !== 'pending') return
          attempt.deadline = absoluteDeadline(monotonicNow(), this.#options.attemptTimeoutMs)
          if (attempt.deadline === undefined) {
            fail('INVALID_ARGUMENT')
            return
          }
          this.#armTimer()
          state.transition(
            'phase-changed',
            { phase: 'preparing', attempts: attempt.number, status: undefined },
            this.#stamp()
          )
          const descriptor = await attempt.resources.runOwner(
            'prepare',
            registrations =>
              spec.prepare({
                signal: attempt.controller.signal,
                operationId: state.handle.id,
                attemptNumber: attempt.number,
                onDispose: registrations.onDispose
              }),
            raw => this.#descriptor(raw)
          )
          if (state.snapshot().outcome !== 'pending') return
          // All descriptor accessors were read under the prepare lifetime. Materialize
          // the final transport arguments before admission, including the method/signal.
          const url = descriptor.value.url
          const method = spec.method
          const putKey = method === 'PUT' ? spec.entityKey : undefined
          const init = { ...descriptor.value.init, method, signal: attempt.controller.signal }
          if (spec.beforeDispatch) {
            expire(monotonicNow())
            if (state.snapshot().outcome !== 'pending') return
            code = 'HOOK_FAILED'
            attempt.hookDeadline = absoluteDeadline(monotonicNow(), this.#options.hookTimeoutMs)
            if (attempt.hookDeadline === undefined) {
              fail('HOOK_FAILED')
              return
            }
            this.#armTimer()
            // A separate physical owner, with no request registrations. Await its full
            // assimilation/extraction before cleanup or lease release, even after timeout.
            attempt.hookWork = runHook(
              this.#context,
              spec.beforeDispatch,
              {
                snapshot: state.snapshot(),
                signal: attempt.controller.signal,
                attemptNumber: attempt.number,
                dispatchCalls: state.snapshot().dispatchCalls
              },
              monotonicNow
            )
            try {
              const decision = await attempt.hookWork
              expire(monotonicNow())
              if (state.snapshot().outcome !== 'pending') return
              if (decision.value.type === 'deny') {
                fail('HOOK_DENIED', decision.value.code)
                return
              }
              if (decision.value.type === 'defer') attempt.hookNotBefore = decision.value.notBefore
            } finally {
              // Absolute expiry also wins on rejection or a synchronously blocking hook.
              expire(monotonicNow())
              attempt.hookWork = undefined
              attempt.hookDeadline = undefined
              this.#armTimer()
            }
          }
          if (state.snapshot().outcome !== 'pending') return
          state.transition('phase-changed', { phase: 'ready' }, this.#stamp())
          code = 'TRANSPORT_FAILED'
          const work = await new Promise<ResponseOf<F> | undefined>(resolve => {
            entry.releaseReady = () => {
              if (!this.#ready.delete(entry)) return
              resolve(undefined)
              this.#wake()
            }
            entry.admit = () => {
              try {
                // These sources can run user code; take them before the final checks.
                const random = Math.random()
                const stamp = this.#stamp()
                const now = monotonicNow()
                const guardNow = this.#guardTime(now)
                expire(now)
                if (this.#stopRequested) entry.cancel(this.#stopCode, this.#stopReason)
                if (this.#pacing.guardOpen) fail('GUARD_OPEN')
                if (state.snapshot().outcome !== 'pending') {
                  entry.releaseReady()
                  return Infinity
                }
                this.#reviewParallelism(now, random)
                const notBefore = Math.max(
                  this.#dispatchNotBefore(now, random),
                  attempt.hookNotBefore ?? 0
                )
                if (now < notBefore) return notBefore
                if (putKey !== undefined) {
                  const decision = this.#guard.checkPut(putKey, guardNow)
                  if (decision.code) {
                    fail(decision.code)
                    entry.releaseReady()
                    return Infinity
                  }
                }
                attempt.token = lease.trySend()
                if (!attempt.token) return Infinity
                // Final gate -> accounting -> committed state -> transport is synchronous.
                // No observer, getter, random source, clock callback or await in this section.
                if (putKey !== undefined) this.#guard.recordPutDispatch(putKey, guardNow)
                this.#pacing.lastDispatchAt = now
                this.#pacingPlan = undefined
                this.#ready.delete(entry)
                state.deferDelivery(() => {
                  state.transition(
                    'dispatch-started',
                    {
                      phase: 'sending',
                      dispatchCalls: state.snapshot().dispatchCalls + 1,
                      dispatchEntered: true
                    },
                    stamp
                  )
                  try {
                    resolve(this.#transport(url, init))
                  } catch (cause) {
                    recordFailure('TRANSPORT_FAILED', cause)
                    resolve(undefined)
                  }
                })
                return Infinity
              } catch (cause) {
                recordFailure('TRANSPORT_FAILED', cause)
                entry.releaseReady()
                return Infinity
              }
            }
            this.#ready.add(entry)
            this.#wake()
          })
          if (!work) return
          attempt.response = work
          // Read the receipt's HTTP fact once; custom Response accessors can run user code.
          const receipt = { monotonic: monotonicNow(), wall: Date.now() }
          const status = attempt.response.status
          if (!Number.isInteger(status) || status < 0 || status > 599) throw invalid()
          // Count every materialized HTTP receipt, even after logical termination, before
          // touching headers or delivering observations. Opening is a permanent local stop.
          if (this.#guard.recordReceipt(status, this.#guardTime(receipt.monotonic)).guardOpen) {
            this.#pacing.guardOpen = true
            this.#requestStop('GUARD_OPEN')
          }
          const headers = attempt.response.headers
          const policy = parseResponsePolicy(status, headers, receipt)
          if (policy.limit !== null) this.#pacing.limit = policy.limit
          if (policy.remaining !== null) this.#pacing.remaining = policy.remaining
          if (policy.retryTimeInterval !== null)
            this.#pacing.retryTimeInterval = policy.retryTimeInterval
          this.#pacing.serverNotBefore = Math.max(
            this.#pacing.serverNotBefore,
            policy.serverNotBefore
          )
          if (policy.responseType === 'PARALLEL_LIMIT_OVERFLOW')
            this.#reduceParallelism(receipt.monotonic)
          for (let i = 0; i < policy.invalidHints; i++)
            this.observation.diagnostics.increment('INVALID_HINT')
          this.#wake()
          state.transition('headers-received', { phase: 'classifying', status }, this.#stamp())
          if (state.snapshot().outcome !== 'pending') return
          if (status === 429) {
            code = 'HTTP_FAILED'
            const classificationStartedAt = monotonicNow()
            attempt.classifier = new ResponseClassifier(
              { status, headers, body: attempt.response.body },
              classificationStartedAt,
              monotonicNow
            )
            attempt.classificationWake = attempt.classifier.deadline
            if (state.snapshot().outcome !== 'pending') attempt.classifier.cancel()
            this.#armTimer()
            const classification = await attempt.classifier.result
            if (
              classification === 'parallel1073' &&
              policy.responseType !== 'PARALLEL_LIMIT_OVERFLOW'
            )
              this.#reduceParallelism(receipt.monotonic)
            attempt.classificationWake = undefined
            // Timer delivery is not required for an operation/attempt deadline to win.
            expire(monotonicNow())
            rateLimitOrdinal++
            recordFailure('HTTP_FAILED')
            return
          }
          code = 'CONSUME_FAILED'
          state.transition('phase-changed', { phase: 'consuming' }, this.#stamp())
          const borrowed = attempt.response
          const value = await attempt.resources.runOwner(
            'consume',
            // The inner lifetime gives the read-failure capability its exact consume
            // identity; another active owner on this planner must not be able to use it.
            // Keep both value boxes until outer materialization, preserving T49's guard.
            registrations =>
              this.#consumeScope.run(
                async lifetime => {
                  // Complete the await/async-return assimilation while the exact consume
                  // identity is active. Box the value before crossing either owner guard.
                  const settle = async () => {
                    return await spec.consume(borrowed, {
                      signal: attempt.controller.signal,
                      operationId: state.handle.id,
                      attemptNumber: attempt.number,
                      ...registrations,
                      retryableReadFailure: cause => {
                        if (!this.#context.isActive() || !this.#consumeScope.isCurrent(lifetime))
                          throw invalid()
                        return new ConsumeReadFailure(lifetime, cause)
                      }
                    })
                  }
                  try {
                    const raw = await settle()
                    const box = { value: raw }
                    Object.setPrototypeOf(box, null)
                    return Object.freeze(box)
                  } catch (cause) {
                    candidate = retryCandidate(
                      { code: 'CONSUME_FAILED', status, cause, consumeLifetime: lifetime },
                      spec.replay
                    )
                    throw cause
                  }
                },
                boxed => boxed.value
              ),
            boxed => boxed.value
          )
          // Materialize clocks before the final safety decision: even Date.now may run
          // user code. Only scalar facts and the guarded value box enter commit.
          const stamp = this.#stamp()
          const now = monotonicNow()
          expire(now)
          if (state.snapshot().outcome === 'pending') {
            cleanupDeadline = now + Math.min(deadline - now, this.#options.cleanupGraceMs)
            state.commit(value, status, stamp)
            this.#armTimer()
          }
        } catch (cause) {
          recordFailure(code, cause)
        } finally {
          if (state.snapshot().outcome === 'pending')
            state.transition('phase-changed', { phase: 'cleanup' }, this.#stamp())
          attempt.classifier?.cancel()
          attempt.classificationWake = undefined
          this.#armTimer()
          // Start request disposal (including producer stop) before waiting for reader work.
          // Neither reader settlement nor request disposal alone proves attempt cleanup.
          const cleanupWork = attempt.resources.cleanup(!state.snapshot().resultCommitted)
          let responseResources: ResourceSummary['resources'] = 'released'
          if (attempt.classifier) {
            const reader = await attempt.classifier.knownWork
            responseResources =
              reader.readFailed || reader.cancelFailed
                ? 'failed'
                : reader.readerReleased
                  ? 'released'
                  : 'unknown'
          }
          const cleanup = await cleanupWork
          try {
            const body = attempt.classifier ? undefined : attempt.response?.body
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
          attempt.token?.release()
          attempt.lease.release()
          // Cleanup is physical: never retire this operation between attempts.
          let retryScheduled = false
          expire(monotonicNow())
          if (failure && state.snapshot().outcome === 'pending') {
            const now = monotonicNow()
            const decision = retryDecision({
              candidate: spec.replay.serverSafe && spec.replay.consumeSafe ? candidate : undefined,
              attempts: attempt.number,
              maxAttempts: this.#options.maxAttempts,
              deadline,
              now,
              stopped: this.#stopRequested,
              cleanup: summary.resources,
              rateLimitOrdinal,
              jitterFactor: 0.8 + Math.random() * 0.4,
              adaptiveNotBefore: this.#dispatchNotBefore(now, Math.random()),
              serverNotBefore: this.#pacing.serverNotBefore
            })
            // Random/clock sources may run user code: repeat terminal checks afterwards.
            expire(monotonicNow())
            if (state.snapshot().outcome === 'pending') {
              if (this.#stopRequested) fail(this.#stopCode, this.#stopReason)
              else if (decision.kind === 'eligible') {
                const nextReservation = this.#capacity.reserve(entry)
                if (nextReservation) {
                  retryScheduled = true
                  currentAttempt = undefined
                  reservation = nextReservation
                  retryNotBefore = decision.notBefore
                  state.transition('retry-scheduled', { phase: 'retry-wait' }, this.#stamp())
                  this.#armTimer()
                  this.#wake()
                } else fail('QUEUE_FULL')
              } else state.fail(failure.code, failure.error, this.#stamp())
            }
          }
          if (!retryScheduled) {
            currentAttempt = undefined
            this.#active.delete(entry)
            state.settleResources(summary, this.#stamp())
          }
          this.#armTimer()
          this.#wake()
        }
      }
    }
    Object.assign(entry, materialized)
    if (this.nextId === Number.MAX_SAFE_INTEGER) this.idExhausted = true
    else this.nextId++
    this.#active.add(entry)
    this.#command(() => {
      reservation.enqueue()
      state.transition('created', {}, this.#stamp())
      this.#armTimer()
      this.#wake()
    })
    return state.handle
  }

  snapshot(): PlannerSnapshot {
    return Object.freeze({
      sequence: this.observationSequence.current,
      stopped: this.#stopped,
      guardOpen: this.#pacing.guardOpen,
      ...this.#capacity.snapshot(),
      serverNotBefore: this.#pacing.serverNotBefore
    })
  }

  observe(listener: (event: Event) => void): Attachment<PlannerSnapshot> {
    return this.observation.attach(listener, () => this.snapshot())
  }

  stop(reason?: unknown): void {
    this.#requestStop('STOPPED', reason)
  }

  #requestStop(code: 'STOPPED' | 'GUARD_OPEN', reason?: unknown): void {
    if (this.#stopRequested) return
    this.#stopRequested = true
    this.#stopCode = code
    this.#stopReason = reason
    this.#command(() => {
      this.#stopped = true
      for (const entry of this.#active) entry.cancel(code, reason)
    })
  }

  /** Keep store time monotonic even if an injected host clock moves backwards. */
  #guardTime(now: number): number {
    this.#guardAt = Math.max(this.#guardAt, now)
    return this.#guardAt
  }

  #submissionStopped(): boolean {
    return this.#stopRequested
  }

  #command(command: () => void): void {
    this.commands.push(command)
    this.#drainCommands()
  }

  #drainCommands(): void {
    if (this.drainingCommands || this.observation.busy) return
    this.drainingCommands = true
    try {
      while (this.commands.length) {
        const command = this.commands.shift()
        if (command) command()
      }
    } finally {
      this.drainingCommands = false
    }
  }

  #stamp() {
    // Materialize user-replaceable clock calls before allocating the sequence.
    const epochTime = Date.now()
    const elapsedMs = monotonicNow() - this.#startedAt
    const stamp = this.observationSequence.stamp(epochTime, elapsedMs)
    if (stamp.emit === false && !this.#sequenceExhausted) {
      this.#sequenceExhausted = true
      for (const entry of this.#active) entry.cancel('SEQUENCE_EXHAUSTED')
    }
    return stamp
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

  /** A wake is not a permit. Cache only the numeric wait for unchanged history/inputs.
   * Recomputing a fresh delay on each wake would postpone admission indefinitely.
   */
  #dispatchNotBefore(now: number, random: number): number {
    const p = this.#pacing
    const key = `${p.limit}/${p.remaining}/${p.retryTimeInterval}/${p.lastDispatchAt}`
    if (this.#pacingPlan?.key !== key) {
      const delay = calculateRequestDelay(
        { ...p, elapsed: now - p.lastDispatchAt },
        this.#options,
        this.#attenuationSteps,
        random
      )
      this.#pacingPlan = { key, notBefore: requestDeadline(now, delay) }
    }
    return Math.max(this.#pacingPlan.notBefore, p.serverNotBefore)
  }

  #reduceParallelism(receiptAt: number): void {
    this.#parallelCorrection = Math.max(
      1 - this.#options.maxParallelLimit,
      this.#parallelCorrection - 1
    )
    this.#parallelCorrectionAt = Math.max(this.#parallelCorrectionAt, receiptAt)
    this.#capacity.setEffectiveParallelism(
      this.#options.maxParallelLimit + this.#parallelCorrection
    )
    this.#wake()
  }

  /** Preserved 003 strict period and one-step recovery, only while processing work. */
  #reviewParallelism(now: number, random: number): void {
    this.#recoveryWake = Infinity
    if (this.#parallelCorrection === 0) return
    const period = safeTime(
      this.#options.parallelLimitCorrectionPeriodMs * (1 + 2 * random * this.#options.jitter)
    )
    if (now - this.#parallelCorrectionAt > period) {
      this.#parallelCorrection = Math.min(0, this.#parallelCorrection + 1)
      this.#parallelCorrectionAt = now
      this.#capacity.setEffectiveParallelism(
        this.#options.maxParallelLimit + this.#parallelCorrection
      )
    }
    if (this.#parallelCorrection < 0) {
      // Clocks are integer milliseconds; equality is deliberately not a recovery.
      const next = this.#parallelCorrectionAt + Math.floor(period) + 1
      if (Number.isSafeInteger(next)) this.#recoveryWake = next
    }
  }

  /** One timer belongs to this coordinator, including logical cleanup grace. */
  #armTimer(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    let next = this.#ready.size ? this.#readyWake : Infinity
    for (const entry of this.#active) next = Math.min(next, entry.nextWake() ?? Infinity)
    if (this.#active.size) next = Math.min(next, this.#recoveryWake)
    if (next === Infinity) return
    const timer = setTimeout(
      () => {
        // A delayed callback only wakes current policy; retire any newer scheduled wake.
        clearTimeout(this.#timer)
        this.#timer = undefined
        this.#recoveryWake = Infinity
        const now = monotonicNow()
        for (const entry of this.#active) entry.expire(now)
        this.#readyWake = Infinity
        this.#wake()
        this.#armTimer()
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(0, next - monotonicNow()))
    )
    this.#timer = timer
  }

  #wake(): void {
    if (this.#pumpScheduled) return
    this.#pumpScheduled = true
    // A wake raised by consume must not lend its read-failure capability to
    // the next owner admitted by the coordinator.
    this.#consumeScope.detached(() => {
      queueMicrotask(() => {
        this.#pumpScheduled = false
        this.#readyWake = Infinity
        const random = Math.random()
        const now = monotonicNow()
        if (this.#active.size) {
          try {
            this.#reviewParallelism(now, random)
          } catch (cause) {
            // Unsafe configured arithmetic is an explicit operation failure, not an
            // unhandled microtask error or a silently shortened recovery period.
            for (const entry of this.#active) entry.cancel('INVALID_ARGUMENT', cause)
          }
        }
        for (const entry of this.#ready) {
          this.#readyWake = Math.min(this.#readyWake, entry.admit())
        }
        while (!this.#stopRequested) {
          const next = this.#capacity.take()
          if (!next) break
          void next.value.start(next.lease)
        }
        this.#armTimer()
      })
    })
  }
}
