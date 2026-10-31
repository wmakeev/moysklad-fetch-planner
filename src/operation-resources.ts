import { CallbackContext, type CallbackValue } from './callback-context.js'
import type { ConsumeContext, ResourceSummary } from './operation-types.js'

type Cleanup = () => void | Promise<void>
type Registrations = Pick<ConsumeContext, 'onDispose' | 'onDiscard'>

export interface CleanupSummary extends ResourceSummary {
  readonly errors: readonly unknown[]
}

/** Attempt-local ownership. Logical cancellation must not bypass its owner barrier. */
export class OperationResources {
  private readonly disposers: Cleanup[] = []
  private readonly discards: Cleanup[] = []
  private ownerPending = false
  private ownerReturned: (() => void) | undefined
  private closing = false
  private cleanupWork: Promise<CleanupSummary> | undefined

  constructor(private readonly context: CallbackContext) {}

  async runOwner<T, R>(
    kind: 'prepare' | 'consume',
    callback: (registrations: Registrations) => T | PromiseLike<T>,
    materialize: (value: Awaited<T>) => R
  ): Promise<CallbackValue<R>> {
    if (this.closing || this.ownerPending) throw new Error('INVALID_RESOURCE_OWNER')
    this.ownerPending = true
    try {
      return await this.context.run(lifetime => {
        const register = (stack: Cleanup[], fn: Cleanup) => {
          if (!this.context.isCurrent(lifetime)) throw new Error('INVALID_RESOURCE_REGISTRATION')
          if (typeof fn !== 'function') throw new TypeError('INVALID_RESOURCE_CALLBACK')
          stack.push(fn)
        }
        return callback({
          onDispose: fn => {
            register(this.disposers, fn)
          },
          onDiscard: fn => {
            if (kind !== 'consume') throw new Error('INVALID_RESOURCE_REGISTRATION')
            register(this.discards, fn)
          }
        })
      }, materialize)
    } finally {
      this.ownerPending = false
      this.ownerReturned?.()
      this.ownerReturned = undefined
    }
  }

  /** Call once the coordinator knows whether the uncommitted result must be discarded. */
  cleanup(discard: boolean): Promise<CleanupSummary> {
    if (this.cleanupWork) return this.cleanupWork
    this.closing = true
    // Publish the shared barrier before drain can enter a reentrant user callback.
    this.cleanupWork = Promise.resolve().then(() => this.drain(discard))
    return this.cleanupWork
  }

  private async drain(discard: boolean): Promise<CleanupSummary> {
    if (this.ownerPending) {
      await new Promise<void>(resolve => {
        this.ownerReturned = resolve
      })
    }
    const errors: unknown[] = []
    const drainStack = async (stack: Cleanup[]) => {
      while (stack.length > 0) {
        const fn = stack.pop()
        if (!fn) throw new Error('INVALID_RESOURCE_STACK')
        try {
          await this.context.run(fn, () => undefined)
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (discard) await drainStack(this.discards)
    this.discards.length = 0
    await drainStack(this.disposers)
    return { resources: errors.length ? 'failed' : 'released', errors }
  }
}
