import type { Transport } from './fetch-types.js'

export type { Transport } from './fetch-types.js'

type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never
export type OneTransport<F extends Transport> = true extends IsUnion<F> ? never : F
export type Init<F extends Transport> = Omit<NonNullable<Parameters<F>[1]>, 'method' | 'signal'> & {
  method?: never
  signal?: never
}
export type ResponseOf<F extends Transport> = Awaited<ReturnType<F>>
export interface Descriptor<I> {
  url: string | URL
  init: I
}
export interface Completed<T> {
  readonly value: T
  readonly status: number
  readonly cleanup: 'released' | 'failed' | 'pending'
}
export type Phase =
  | 'queued'
  | 'preparing'
  | 'ready'
  | 'sending'
  | 'classifying'
  | 'consuming'
  | 'cleanup'
  | 'retry-wait'
  | 'terminal'
export type FailureCode =
  | 'INVALID_ARGUMENT'
  | 'QUEUE_FULL'
  | 'STOPPED'
  | 'ABORTED'
  | 'DEADLINE'
  | 'ATTEMPT_TIMEOUT'
  | 'REENTRANT_OPERATION'
  | 'PREPARE_FAILED'
  | 'TRANSPORT_FAILED'
  | 'HTTP_FAILED'
  | 'CONSUME_FAILED'
  | 'CLEANUP_FAILED'
  | 'GUARD_OPEN'
  | 'GUARD_CAPACITY'
  | 'PUT_LIMIT'
  | 'HOOK_FAILED'
  | 'HOOK_DENIED'
  | 'ID_EXHAUSTED'
  | 'SEQUENCE_EXHAUSTED'
  | 'SUBSCRIBER_LIMIT'
/** Closed diagnostic vocabulary; never carries observer errors or payloads. */
export type DiagnosticCode = 'OBSERVER_FAILED' | 'INVALID_HINT' | 'LATE_COMPLETION'

export interface Snapshot {
  readonly id: number
  readonly sequence: number
  readonly phase: Phase
  readonly outcome: 'pending' | 'succeeded' | 'failed'
  readonly resultCommitted: boolean
  readonly resources: 'pending' | 'released' | 'failed' | 'unknown'
  readonly failureCode?: FailureCode
  readonly attempts: number
  readonly dispatchCalls: number
  readonly dispatchEntered: boolean
  readonly status?: number
}
export interface PlannerSnapshot {
  readonly sequence: number
  readonly stopped: boolean
  readonly guardOpen: boolean
  readonly queued: number
  readonly leasedAttempts: number
  readonly sentActive: number
  readonly effectiveParallelism: number
  readonly serverNotBefore: number
}
export type EventType =
  | 'created'
  | 'phase-changed'
  | 'dispatch-deferred'
  | 'dispatch-started'
  | 'headers-received'
  | 'retry-scheduled'
  | 'operation-settled'
  | 'resources-settled'
  | 'late-completion'
export interface Event extends Snapshot {
  readonly type: EventType
  readonly epochTime: number
  readonly elapsedMs: number
}
export interface Attachment<S> {
  readonly snapshot: S
  unsubscribe(): void
}
export interface ResourceSummary {
  readonly resources: 'released' | 'failed' | 'unknown'
}
export interface Handle<T> {
  readonly id: number
  readonly result: Promise<Completed<T>>
  readonly resourcesDone: Promise<ResourceSummary>
  snapshot(): Snapshot
  observe(listener: (event: Event) => void): Attachment<Snapshot>
  abort(reason?: unknown): void
}
export interface PrepareContext {
  readonly signal: AbortSignal
  readonly operationId: number
  readonly attemptNumber: number
  onDispose(fn: () => void | Promise<void>): void
}
export interface ConsumeContext extends PrepareContext {
  onDiscard(fn: () => void | Promise<void>): void
  retryableReadFailure(cause: unknown): Error
}
/** Readonly control input; runtime hooks will supply frozen, detached snapshots. */
export interface HookContext {
  readonly snapshot: Snapshot
  readonly signal: AbortSignal
  readonly attemptNumber: number
  readonly dispatchCalls: number
  readonly status?: number
}
export type Decision =
  | { readonly type: 'allow' }
  | { readonly type: 'deny'; readonly code: 'POLICY_DENIED' }
  | { readonly type: 'defer'; readonly delayMs: number }
export type Hook = (context: HookContext) => Decision | Promise<Decision>
export type MethodSpec =
  | { method: 'PUT'; entityKey: string }
  | {
      method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'TRACE' | 'CONNECT'
      entityKey?: never
    }
export type Spec<I, R, T> = MethodSpec & {
  prepare: (ctx: PrepareContext) => Descriptor<I> | Promise<Descriptor<I>>
  consume: (response: R, ctx: ConsumeContext) => T | Promise<T>
  replay: { serverSafe: boolean; consumeSafe: boolean }
  deadlineMs?: number
  beforeDispatch?: Hook
  beforeRetry?: Hook
}
export interface Planner<I, R> {
  submit<T>(spec: Spec<I, R, T>): Handle<T>
  snapshot(): PlannerSnapshot
  observe(listener: (event: Event) => void): Attachment<PlannerSnapshot>
  stop(reason?: unknown): void
}

export interface FetchPlannerOptions {
  maxParallelLimit: number
  maxQueuedOperations: number
  maxSubscribers: number
  deadlineMs: number
  attemptTimeoutMs: number
  cleanupGraceMs: number
  maxAttempts: number
  hookTimeoutMs: number
  throttlingCoefficient: number
  maxRequestDelayTimeMs: number
  jitter: number
  parallelLimitCorrectionPeriodMs: number
  maxEntityKeys: number
  errorPerMinuteLimit: number
  rateLimitPerMinuteLimit: number
  entityPutPerMinuteLimit: number
}

interface FailureFacts {
  phase: Phase
  operationId: number
  attemptNumber: number
  dispatchEntered: boolean
  status?: number
}

export class OperationError extends Error {
  readonly code: FailureCode
  readonly phase: Phase
  readonly operationId: number
  readonly attemptNumber: number
  readonly dispatchEntered: boolean
  readonly status?: number
  readonly serverOutcome: 'not-dispatched' | 'unknown' | 'http-response'

  constructor(code: FailureCode, facts: FailureFacts, cause?: unknown) {
    super(code, { cause })
    this.name = 'OperationError'
    this.code = code
    this.phase = facts.phase
    this.operationId = facts.operationId
    this.attemptNumber = facts.attemptNumber
    this.dispatchEntered = facts.dispatchEntered
    this.status = facts.status
    this.serverOutcome =
      facts.status !== undefined
        ? 'http-response'
        : facts.dispatchEntered
          ? 'unknown'
          : 'not-dispatched'
  }
}

/** Internal identity seam for the stage III retry policy, never inferred from error text. */
export class ConsumeReadFailure extends Error {
  readonly #identity: object

  constructor(identity: object, cause: unknown) {
    super('RETRYABLE_READ_FAILURE', { cause })
    this.#identity = identity
  }

  static isFor(error: unknown, identity: object): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      #identity in error &&
      error.#identity === identity
    )
  }
}
