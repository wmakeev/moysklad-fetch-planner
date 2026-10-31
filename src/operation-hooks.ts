import type { CallbackContext, CallbackValue } from './callback-context.js'
import { OperationError, type Decision, type HookContext } from './operation-types.js'

type HookDecision =
  | Exclude<Decision, { readonly type: 'defer' }>
  | (Extract<Decision, { readonly type: 'defer' }> & { readonly notBefore: number })

/** Internal unknown boundary: public Hook types cannot validate JavaScript callback returns. */
export async function runHook(
  owner: CallbackContext,
  hook: (context: HookContext) => unknown,
  input: HookContext,
  now: () => number
): Promise<CallbackValue<HookDecision>> {
  // Copy only coordinator facts. Never expose the live operation or caller extras.
  const source = input.snapshot
  const snapshot = Object.freeze({
    id: source.id,
    sequence: source.sequence,
    phase: source.phase,
    outcome: source.outcome,
    resultCommitted: source.resultCommitted,
    resources: source.resources,
    attempts: source.attempts,
    dispatchCalls: source.dispatchCalls,
    dispatchEntered: source.dispatchEntered,
    ...(source.failureCode === undefined ? {} : { failureCode: source.failureCode }),
    ...(source.status === undefined ? {} : { status: source.status })
  })
  const context: HookContext = Object.freeze({
    snapshot,
    signal: input.signal,
    attemptNumber: input.attemptNumber,
    dispatchCalls: input.dispatchCalls,
    ...(input.status === undefined ? {} : { status: input.status })
  })
  try {
    return await owner.run(
      () => hook(context),
      raw => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          throw new TypeError('Invalid hook decision')
        const keys = Reflect.ownKeys(raw)
        const type = 'type' in raw ? raw.type : undefined
        let decision: HookDecision
        if (type === 'allow' && keys.length === 1 && keys.includes('type')) {
          decision = { type }
        } else if (
          type === 'deny' &&
          keys.length === 2 &&
          keys.includes('type') &&
          keys.includes('code') &&
          'code' in raw &&
          raw.code === 'POLICY_DENIED'
        ) {
          decision = { type, code: 'POLICY_DENIED' }
        } else if (
          type === 'defer' &&
          keys.length === 2 &&
          keys.includes('type') &&
          keys.includes('delayMs') &&
          'delayMs' in raw
        ) {
          const delayMs = raw.delayMs
          if (typeof delayMs !== 'number' || !Number.isSafeInteger(delayMs) || delayMs < 1)
            throw new TypeError('Invalid hook delay')
          const settledAt = now()
          // Duration is integral; a monotonic timestamp can contain a fractional millisecond.
          // Bound before addition so rounding cannot hide an overflow near MAX_SAFE_INTEGER.
          if (
            !Number.isFinite(settledAt) ||
            settledAt < 0 ||
            settledAt > Number.MAX_SAFE_INTEGER ||
            delayMs > Number.MAX_SAFE_INTEGER - Math.ceil(settledAt)
          )
            throw new TypeError('Invalid hook deadline')
          const notBefore = settledAt + delayMs
          decision = { type, delayMs, notBefore }
        } else {
          throw new TypeError('Invalid hook decision')
        }
        // No user object or inherited then can escape the materialization lifetime.
        Object.setPrototypeOf(decision, null)
        return Object.freeze(decision)
      }
    )
  } catch (cause) {
    throw new OperationError(
      'HOOK_FAILED',
      {
        phase: snapshot.phase,
        operationId: snapshot.id,
        attemptNumber: context.attemptNumber,
        dispatchEntered: snapshot.dispatchEntered,
        status: context.status
      },
      cause
    )
  }
}
