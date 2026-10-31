import type { CallbackLifetime } from './callback-context.js'
import { ConsumeReadFailure, type FailureCode } from './operation-types.js'
import { absoluteDeadline } from './runtime.js'

/** Internal facts, materialized by the coordinator, never inferred from an Error's shape. */
export interface RetryFailure {
  readonly code: FailureCode
  readonly status?: number
  readonly cause?: unknown
  readonly consumeLifetime?: CallbackLifetime
}

export type RetryCandidate = 'rate-limit' | 'transport' | 'consume-read'

/**
 * Capture inside the exact active consume rejection/assimilation lifetime. The caller
 * supplies that lifetime, never a borrowed owner token. This is only a potential
 * candidate: known reader/upload/discard/disposer work must still finish successfully.
 */
export function retryCandidate(
  failure: RetryFailure,
  replay: { readonly serverSafe: boolean; readonly consumeSafe: boolean }
): RetryCandidate | undefined {
  if (!replay.serverSafe || !replay.consumeSafe) return undefined
  if (failure.code === 'HTTP_FAILED' && failure.status === 429) return 'rate-limit'
  if (failure.code === 'TRANSPORT_FAILED' && failure.status === undefined) return 'transport'
  if (
    failure.code === 'CONSUME_FAILED' &&
    failure.status !== undefined &&
    failure.status >= 200 &&
    failure.status < 300 &&
    failure.consumeLifetime?.active === true &&
    ConsumeReadFailure.isFor(failure.cause, failure.consumeLifetime)
  )
    return 'consume-read'
  return undefined
}

export interface RetryBudget {
  /** Operation-wide count of started preparations, including the first. */
  readonly attempts: number
  readonly maxAttempts: number
  /** Original admission deadline; never refreshed by a retry or hook defer. */
  readonly deadline: number
  readonly now: number
  readonly stopped: boolean
  /** All known work, including reader cancellation and discard, not just disposers. */
  readonly cleanup: 'released' | 'pending' | 'failed' | 'unknown'
  readonly candidate: RetryCandidate | undefined
  /** Operation-wide 429 count; transport failures and hook defers do not reset it. */
  readonly rateLimitOrdinal: number
  /** Supplied sample, fixed C4 range, independent of configurable pacing jitter. */
  readonly jitterFactor: number
  /** Absolute monotonic ceilings, already parsed/materialized by the existing policy. */
  readonly adaptiveNotBefore: number
  readonly serverNotBefore: number
}

export type RetryDecision =
  | {
      readonly kind: 'terminal'
      readonly reason: 'not-candidate' | 'cleanup' | 'budget' | 'stopped'
    }
  | { readonly kind: 'pending-cleanup' }
  | { readonly kind: 'eligible'; readonly notBefore: number; readonly delayMs: number }

/** Pure eligibility only; T68 must recheck replay/stop/budget and final dispatch safety. */
export function retryDecision(facts: RetryBudget): RetryDecision {
  if (facts.candidate === undefined) return { kind: 'terminal', reason: 'not-candidate' }
  if (facts.stopped) return { kind: 'terminal', reason: 'stopped' }
  if (facts.cleanup === 'failed' || facts.cleanup === 'unknown')
    return { kind: 'terminal', reason: 'cleanup' }
  if (
    !Number.isSafeInteger(facts.attempts) ||
    facts.attempts < 1 ||
    !Number.isSafeInteger(facts.maxAttempts) ||
    facts.attempts >= facts.maxAttempts ||
    !Number.isSafeInteger(facts.now) ||
    facts.now < 0 ||
    !Number.isSafeInteger(facts.deadline) ||
    facts.now >= facts.deadline ||
    !Number.isSafeInteger(facts.adaptiveNotBefore) ||
    facts.adaptiveNotBefore < 0 ||
    !Number.isSafeInteger(facts.serverNotBefore) ||
    facts.serverNotBefore < 0 ||
    !Number.isFinite(facts.jitterFactor) ||
    facts.jitterFactor < 0.8 ||
    facts.jitterFactor > 1.2 ||
    (facts.candidate === 'rate-limit' &&
      (!Number.isSafeInteger(facts.rateLimitOrdinal) || facts.rateLimitOrdinal < 1))
  )
    return { kind: 'terminal', reason: 'budget' }
  // Saturate the exponent before evaluating it; even MAX_SAFE_INTEGER is bounded.
  // Ceil avoids undershooting a fractional millisecond lower bound.
  const fallback =
    facts.candidate === 'rate-limit'
      ? Math.ceil(
          Math.min(30_000, 3000 * 2 ** Math.min(4, facts.rateLimitOrdinal - 1)) * facts.jitterFactor
        )
      : 1
  const fallbackNotBefore = absoluteDeadline(facts.now, fallback)
  if (fallbackNotBefore === undefined) return { kind: 'terminal', reason: 'budget' }
  const notBefore = Math.max(fallbackNotBefore, facts.adaptiveNotBefore, facts.serverNotBefore)
  if (notBefore >= facts.deadline) return { kind: 'terminal', reason: 'budget' }
  if (facts.cleanup === 'pending') return { kind: 'pending-cleanup' }
  return { kind: 'eligible', notBefore, delayMs: notBefore - facts.now }
}
