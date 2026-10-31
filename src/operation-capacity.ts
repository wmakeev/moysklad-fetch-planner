interface Reservation {
  /** Publish a reserved command/retry into the ready FIFO, once. */
  enqueue(): boolean
  release(): boolean
}
interface SentToken {
  release(): boolean
}
interface Lease {
  /** One dispatch per attempt; a blocked admission may be retried. */
  trySend(): SentToken | undefined
  /** Only after known work finishes, and after releasing the sent token. */
  release(): boolean
}

function positiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('INVALID_CAPACITY_LIMIT')
}

/** Internal storage for the single coordinator. No callbacks, clocks or scheduling. */
export class OperationCapacity<T> {
  private readonly reservations = new Map<Reservation, { value: T }>()
  private readonly queue = new Set<Reservation>()
  private leasedAttempts = 0
  private sentActive = 0
  private effectiveParallelism: number

  constructor(
    private readonly maxQueuedOperations: number,
    private readonly maxParallelLimit: number
  ) {
    positiveLimit(maxQueuedOperations)
    positiveLimit(maxParallelLimit)
    this.effectiveParallelism = maxParallelLimit
  }

  snapshot() {
    return Object.freeze({
      queued: this.reservations.size,
      leasedAttempts: this.leasedAttempts,
      sentActive: this.sentActive,
      effectiveParallelism: this.effectiveParallelism
    })
  }

  setEffectiveParallelism(limit: number): void {
    positiveLimit(limit)
    if (limit > this.maxParallelLimit) throw new RangeError('INVALID_CAPACITY_LIMIT')
    this.effectiveParallelism = limit
  }

  /** Reserve synchronously before a command retains its spec. Rejection retains nothing. */
  reserve(value: T): Reservation | undefined {
    if (this.reservations.size >= this.maxQueuedOperations) return undefined
    const reservation: Reservation = Object.freeze({
      enqueue: () => {
        if (!this.reservations.has(reservation) || this.queue.has(reservation)) return false
        this.queue.add(reservation)
        return true
      },
      release: () => {
        this.queue.delete(reservation)
        return this.reservations.delete(reservation)
      }
    })
    this.reservations.set(reservation, { value })
    return reservation
  }

  /** Atomically exchange the oldest ready reservation for a configured-bound lease. */
  take(): { value: T; lease: Lease } | undefined {
    if (this.leasedAttempts >= this.maxParallelLimit) return undefined
    const first = this.queue.values().next()
    if (first.done) return undefined
    const reservation = first.value
    const entry = this.reservations.get(reservation)
    if (!entry) throw new Error('INVALID_CAPACITY_RESERVATION')
    reservation.release()
    this.leasedAttempts++
    let released = false
    let sent = false
    let sentPending = false
    const lease: Lease = Object.freeze({
      trySend: () => {
        if (released || sent || this.sentActive >= this.effectiveParallelism) return undefined
        sent = true
        sentPending = true
        this.sentActive++
        return Object.freeze({
          release: () => {
            if (!sentPending) return false
            sentPending = false
            this.sentActive--
            return true
          }
        })
      },
      release: () => {
        if (released) return false
        if (sentPending) throw new Error('SENT_WORK_PENDING')
        released = true
        this.leasedAttempts--
        return true
      }
    })
    return { value: entry.value, lease }
  }
}
