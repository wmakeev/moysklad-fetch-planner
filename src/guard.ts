import type { FetchPlannerOptions } from './operation-types.js'

type GuardOptions = Readonly<
  Pick<
    FetchPlannerOptions,
    'maxEntityKeys' | 'errorPerMinuteLimit' | 'rateLimitPerMinuteLimit' | 'entityPutPerMinuteLimit'
  >
>
type PutDecision = Readonly<{ count: number; code?: 'PUT_LIMIT' | 'GUARD_CAPACITY' }>

/** Retain only the newest threshold timestamps: exact below threshold, saturated above it. */
class RollingWindow {
  private readonly timestamps: number[] = []

  constructor(readonly limit: number) {}

  expire(now: number): void {
    let expired = 0
    for (const time of this.timestamps) {
      if (now - time >= 60000) expired++
      else break
    }
    if (expired) this.timestamps.splice(0, expired)
  }

  add(now: number): void {
    if (this.timestamps.length === this.limit) this.timestamps.shift()
    this.timestamps.push(now)
  }

  get count(): number {
    return this.timestamps.length
  }
}

/** Internal synchronous storage. The coordinator supplies receipt/actual-dispatch monotonic time. */
export class GuardStore {
  private readonly errors: RollingWindow
  private readonly rateLimits: RollingWindow
  private readonly puts = new Map<string, RollingWindow>()
  private readonly maxEntityKeys: number
  private readonly entityPutPerMinuteLimit: number
  private lastTime = -Infinity
  private opened = false

  constructor(options: GuardOptions) {
    for (const value of Object.values(options)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('INVALID_ARGUMENT')
    }
    this.maxEntityKeys = options.maxEntityKeys
    this.entityPutPerMinuteLimit = options.entityPutPerMinuteLimit
    this.errors = new RollingWindow(options.errorPerMinuteLimit)
    this.rateLimits = new RollingWindow(options.rateLimitPerMinuteLimit)
  }

  private advance(now: number): void {
    if (!Number.isFinite(now) || now < this.lastTime) throw new RangeError('INVALID_ARGUMENT')
    this.lastTime = now
    this.errors.expire(now)
    this.rateLimits.expire(now)
    for (const [key, window] of this.puts) {
      window.expire(now)
      if (window.count === 0) this.puts.delete(key)
    }
  }

  snapshot(now: number) {
    this.advance(now)
    return Object.freeze({
      guardOpen: this.opened,
      errorCount: this.errors.count,
      rateLimitCount: this.rateLimits.count
    })
  }

  /** Call only for HTTP receipts, including late receipts; never for application exceptions. */
  recordReceipt(status: number, now: number) {
    this.advance(now)
    if (status >= 400) this.errors.add(now)
    if (status === 429) this.rateLimits.add(now)
    if (this.errors.count >= this.errors.limit || this.rateLimits.count >= this.rateLimits.limit)
      this.opened = true
    return this.snapshot(now)
  }

  /** Read-only eligibility: querying an unseen key does not reserve capacity or charge a PUT. */
  checkPut(entityKey: string, now: number): PutDecision {
    if (typeof entityKey !== 'string' || entityKey.length < 1 || entityKey.length > 128)
      throw new RangeError('INVALID_ARGUMENT')
    this.advance(now)
    const count = this.puts.get(entityKey)?.count ?? 0
    if (count >= this.entityPutPerMinuteLimit) return Object.freeze({ count, code: 'PUT_LIMIT' })
    if (!this.puts.has(entityKey) && this.puts.size >= this.maxEntityKeys)
      return Object.freeze({ count, code: 'GUARD_CAPACITY' })
    return Object.freeze({ count })
  }

  /** Check and charge together, only in the coordinator's synchronous actual-dispatch section. */
  recordPutDispatch(entityKey: string, now: number): PutDecision {
    const decision = this.checkPut(entityKey, now)
    if (decision.code) return decision
    let window = this.puts.get(entityKey)
    if (!window) {
      window = new RollingWindow(this.entityPutPerMinuteLimit)
      this.puts.set(entityKey, window)
    }
    window.add(now)
    return Object.freeze({ count: window.count })
  }
}
