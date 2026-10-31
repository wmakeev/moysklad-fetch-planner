import { OperationObservation } from './operation-observation.js'
import type { ObservationStamp as Stamp } from './operation-observation.js'
import type { CallbackValue } from './callback-context.js'
import type {
  Attachment,
  Completed,
  Event,
  EventType,
  FailureCode,
  Handle,
  ResourceSummary,
  Snapshot
} from './operation-types.js'

type Progress = Partial<
  Pick<Snapshot, 'phase' | 'attempts' | 'dispatchCalls' | 'dispatchEntered' | 'status'>
>

function settlement<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('UNINITIALIZED_SETTLEMENT')
  }
  let reject: (error: Error) => void = () => {
    throw new Error('UNINITIALIZED_SETTLEMENT')
  }
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Internal state only: no admission, scheduling, callback ownership or transport. */
export class OperationState<T> {
  private current: Snapshot
  private readonly result = settlement<Completed<T>>()
  private readonly resources = settlement<ResourceSummary>()
  private readonly observation: OperationObservation
  private committed: CallbackValue<T> | undefined
  private abortRequest: ((reason?: unknown) => void) | undefined
  readonly handle: Handle<T>

  constructor(
    id: number,
    abortRequest?: (reason?: unknown) => void,
    private plannerObservation?: OperationObservation,
    maxSubscribers = 64
  ) {
    this.observation = new OperationObservation(maxSubscribers, plannerObservation?.diagnostics)
    this.current = {
      id,
      sequence: 0,
      phase: 'queued',
      outcome: 'pending',
      resultCommitted: false,
      resources: 'pending',
      attempts: 0,
      dispatchCalls: 0,
      dispatchEntered: false
    }
    this.abortRequest = abortRequest
    // A caller may observe a synchronous submit rejection later in the same turn.
    void this.result.promise.catch(() => undefined)
    this.handle = Object.freeze({
      id,
      result: this.result.promise,
      resourcesDone: this.resources.promise,
      snapshot: () => this.snapshot(),
      observe: (listener: (event: Event) => void) => this.observe(listener),
      abort: (reason?: unknown) => {
        this.abortRequest?.(reason)
      }
    })
  }

  /** Unaccepted submissions have no coordinator registry, sequence or events. */
  static rejected<T>(code: FailureCode, error: Error): Handle<T> {
    const state = new OperationState<T>(0)
    state.current = {
      ...state.current,
      phase: 'terminal',
      outcome: 'failed',
      failureCode: code,
      resources: 'released'
    }
    state.result.reject(error)
    state.resources.resolve(Object.freeze({ resources: 'released' }))
    return state.handle
  }

  snapshot(): Snapshot {
    const s = this.current
    return Object.freeze({
      id: s.id,
      sequence: s.sequence,
      phase: s.phase,
      outcome: s.outcome,
      resultCommitted: s.resultCommitted,
      resources: s.resources,
      attempts: s.attempts,
      dispatchCalls: s.dispatchCalls,
      dispatchEntered: s.dispatchEntered,
      ...(s.failureCode === undefined ? {} : { failureCode: s.failureCode }),
      ...(s.status === undefined ? {} : { status: s.status })
    })
  }

  private observe(listener: (event: Event) => void): Attachment<Snapshot> {
    return this.observation.attach(listener, () => this.snapshot(), this.finished())
  }

  /** Terminal results retain their outcome/phase while late HTTP facts arrive. */
  transition(type: EventType, patch: Progress, stamp: Stamp): void {
    if (this.finished()) return
    const s = this.current
    this.publish(
      type,
      {
        ...s,
        phase: s.outcome === 'pending' ? (patch.phase ?? s.phase) : 'terminal',
        attempts: patch.attempts ?? s.attempts,
        dispatchCalls: patch.dispatchCalls ?? s.dispatchCalls,
        dispatchEntered: patch.dispatchEntered ?? s.dispatchEntered,
        status: 'status' in patch ? patch.status : s.status
      },
      stamp
    )
  }

  /** Commit facts immediately, but deliver records only after a synchronous critical section.
   * Capturing subscriptions at commit keeps attachment snapshots free of past events.
   * The coordinator uses this only around transport entry, never across an await.
   */
  deferDelivery<R>(work: () => R): R {
    return (this.plannerObservation ?? this.observation).deferDelivery(work)
  }

  /** Caller performs deadline/abort checks before handing over the guarded box. */
  commit(value: CallbackValue<T>, status: number, stamp: Stamp): boolean {
    if (this.current.outcome !== 'pending' || this.current.resultCommitted) return false
    this.committed = value
    this.publish(
      'phase-changed',
      { ...this.current, resultCommitted: true, phase: 'cleanup', status },
      stamp
    )
    return true
  }

  succeed(cleanup: Completed<T>['cleanup'], stamp: Stamp): boolean {
    if (this.current.outcome !== 'pending' || !this.committed) return false
    const status = this.current.status
    if (status === undefined) throw new Error('MISSING_COMMITTED_STATUS')
    const completed: Completed<T> = { value: this.committed.value, status, cleanup }
    // Resolve the container, never the raw generic value (including a hostile then).
    Object.setPrototypeOf(completed, null)
    Object.freeze(completed)
    this.committed = undefined
    this.abortRequest = undefined
    this.result.resolve(completed)
    this.publish(
      'operation-settled',
      { ...this.current, phase: 'terminal', outcome: 'succeeded' },
      stamp
    )
    return true
  }

  fail(code: FailureCode, error: Error, stamp: Stamp): boolean {
    if (this.current.outcome !== 'pending' || this.current.resultCommitted) return false
    this.abortRequest = undefined
    this.result.reject(error)
    this.publish(
      'operation-settled',
      { ...this.current, phase: 'terminal', outcome: 'failed', failureCode: code },
      stamp
    )
    return true
  }

  settleResources(summary: ResourceSummary, stamp: Stamp): boolean {
    if (this.current.resources !== 'pending') return false
    const detached = Object.freeze({ resources: summary.resources })
    this.resources.resolve(detached)
    this.publish('resources-settled', { ...this.current, resources: detached.resources }, stamp)
    return true
  }

  private finished(): boolean {
    return this.current.outcome !== 'pending' && this.current.resources !== 'pending'
  }

  private publish(type: EventType, next: Snapshot, stamp: Stamp): void {
    this.current = { ...next, sequence: stamp.sequence }
    const event: Event = Object.freeze({
      ...this.snapshot(),
      type,
      epochTime: stamp.epochTime,
      elapsedMs: stamp.elapsedMs
    })
    if (type === 'late-completion') this.observation.diagnostics.increment('LATE_COMPLETION')
    const operationDelivery = stamp.emit === false ? undefined : this.observation.capture(event)
    const plannerDelivery =
      stamp.emit === false ? undefined : this.plannerObservation?.capture(event)
    const deliveryScope = this.plannerObservation ?? this.observation
    // Retire at commit, keeping only the captured final fanout until delivery.
    if (this.finished()) {
      this.observation.clear()
      this.plannerObservation = undefined
    }
    const deliver = () => {
      plannerDelivery?.()
      operationDelivery?.()
    }
    deliveryScope.deliver(deliver)
  }
}
