import { isPromise } from 'node:util/types'
import { OperationError } from './operation-types.js'
import type { Attachment, DiagnosticCode, Event, FailureCode } from './operation-types.js'

/** Intrinsic attachment bypasses own then/catch, but still uses constructor/species.
 * Ordinary thenables are assimilated into our own promise before attachment.
 * Discarding fulfillment prevents payload assimilation with ordinary capability semantics.
 * A broken attachment is caught by fanout; it cannot handle the original rejection.
 * Custom capability side effects/derived rejections remain the caller's responsibility (C5).
 */
function observeReturn(returned: unknown, failed: () => void): void {
  const promise = isPromise(returned)
    ? returned
    : new Promise<unknown>(resolve => {
        resolve(returned)
      })
  void Promise.prototype.then.call(promise, () => undefined, failed)
}

export interface ObservationStamp {
  readonly sequence: number
  readonly epochTime: number
  readonly elapsedMs: number
  readonly emit?: boolean
}

/** Fixed, scalar counters only; diagnostics never publish another observer event. */
export class ObservationDiagnostics {
  private readonly counts = { OBSERVER_FAILED: 0, INVALID_HINT: 0, LATE_COMPLETION: 0 }
  private readonly rejections: Partial<Record<FailureCode, number>> = {}

  increment(code: DiagnosticCode): void {
    this.counts[code] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[code] + 1)
  }

  reject(code: FailureCode): void {
    this.rejections[code] = Math.min(Number.MAX_SAFE_INTEGER, (this.rejections[code] ?? 0) + 1)
  }

  snapshot() {
    return Object.freeze({ ...this.counts, rejections: Object.freeze({ ...this.rejections }) })
  }
}

/** Subscription storage only, shared by the coordinator and its sole operation state. */
export class OperationObservation {
  private delivering = false
  private deferred = false
  private pendingDeliveries: (() => void)[] | undefined
  private readonly listeners = new Set<(event: Event) => unknown>()

  constructor(
    private readonly maxSubscribers = 64,
    readonly diagnostics = new ObservationDiagnostics(),
    private readonly onIdle?: () => void,
    private readonly runDelivery: (delivery: () => void) => void = delivery => {
      delivery()
    }
  ) {}

  attach<S>(
    listener: (event: Event) => unknown,
    snapshot: () => S,
    retired = false
  ): Attachment<S> {
    const code =
      typeof listener !== 'function'
        ? 'INVALID_ARGUMENT'
        : !retired && this.listeners.size >= this.maxSubscribers
          ? 'SUBSCRIBER_LIMIT'
          : undefined
    if (code) {
      this.diagnostics.reject(code)
      throw new OperationError(code, {
        phase: 'queued',
        operationId: 0,
        attemptNumber: 0,
        dispatchEntered: false
      })
    }
    // Independent registrations even for the same callback identity.
    const subscription = (event: Event): unknown => listener(event)
    if (!retired) this.listeners.add(subscription)
    return Object.freeze({
      snapshot: snapshot(),
      unsubscribe: () => {
        this.listeners.delete(subscription)
      }
    })
  }

  /** Capture every scope before invoking any callback. Changes affect the next record. */
  capture(event: Event): () => void {
    const listeners = [...this.listeners]
    const diagnostics = this.diagnostics
    return () => {
      for (const listener of listeners) {
        try {
          const returned: unknown = listener(Object.freeze({ ...event }))
          observeReturn(returned, () => {
            diagnostics.increment('OBSERVER_FAILED')
          })
        } catch {
          diagnostics.increment('OBSERVER_FAILED')
        }
      }
    }
  }

  /** Shared synchronous delivery boundary; commands drain only after the entire fanout. */
  get busy(): boolean {
    return this.delivering
  }

  deferDelivery<R>(work: () => R): R {
    if (this.deferred) return work()
    this.deferred = true
    try {
      return work()
    } finally {
      this.deferred = false
      this.flush()
    }
  }

  deliver(delivery: () => void): void {
    ;(this.pendingDeliveries ??= []).push(delivery)
    this.flush()
  }

  private flush(): void {
    if (this.busy || this.deferred) return
    this.delivering = true
    try {
      while (this.pendingDeliveries?.length) {
        const delivery = this.pendingDeliveries.shift()
        if (delivery) this.runDelivery(delivery)
      }
    } finally {
      this.pendingDeliveries = undefined
      this.delivering = false
    }
    this.onIdle?.()
  }

  clear(): void {
    this.listeners.clear()
  }
}

/** Planner-wide sequence allocator. Saturation disables emission, never wraps. */
export class ObservationSequence {
  private sequence = 0
  private exhausted = false

  get current(): number {
    return this.sequence
  }
  get isExhausted(): boolean {
    return this.exhausted || this.sequence >= Number.MAX_SAFE_INTEGER
  }

  stamp(epochTime: number, elapsedMs: number): ObservationStamp {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) this.exhausted = true
    else this.sequence++
    return { sequence: this.sequence, epochTime, elapsedMs, emit: !this.exhausted }
  }
}
