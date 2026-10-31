import { AsyncLocalStorage } from 'node:async_hooks'

export interface CallbackLifetime {
  readonly active: boolean
}

/** A container prevents generic values from being assimilated again outside the guard. */
export interface CallbackValue<T> {
  readonly value: T
}

/** One instance per planner; all of its owner callbacks share this guard. */
export class CallbackContext {
  private readonly storage = new AsyncLocalStorage<CallbackLifetime>()

  isActive(): boolean {
    return this.storage.getStore()?.active === true
  }

  isCurrent(lifetime: CallbackLifetime): boolean {
    return lifetime.active && this.storage.getStore() === lifetime
  }

  /** Observer work and its descendants have no owner; the calling owner stays active. */
  detached(work: () => void): void {
    this.storage.exit(work)
  }

  async run<T, R>(
    callback: (lifetime: CallbackLifetime) => T | PromiseLike<T>,
    materialize: (value: Awaited<T>) => R
  ): Promise<CallbackValue<R>> {
    const token = { active: true }
    try {
      // Both await and async return may read then again. Keep the *outer* token
      // alive through that entire chain, rather than releasing in this body.
      const settle = async () => {
        return await callback(token)
      }
      const raw = await this.storage.run(token, settle)
      return this.storage.run(token, () => {
        const box = { value: materialize(raw) }
        Object.setPrototypeOf(box, null)
        return Object.freeze(box)
      })
    } finally {
      token.active = false
    }
  }
}
