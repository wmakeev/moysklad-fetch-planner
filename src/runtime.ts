/** Internal millisecond clock for intervals; public event timestamps use Date.now(). */
export function monotonicNow() {
  return Math.floor(performance.now())
}

/** Node timers must never receive an overflowing delay. Keep the full deadline elsewhere. */
export const MAX_TIMEOUT_MS = 2_147_483_647

/** Keep absolute times exact, even when a valid duration would overflow this clock. */
export function absoluteDeadline(now: number, duration: number): number | undefined {
  const deadline = now + duration
  return Number.isSafeInteger(deadline) ? deadline : undefined
}
