import assert from 'node:assert'

export function createAttenuationSteps(coefficient: number) {
  return Array.from({ length: 101 }, (_, i) => Math.pow(1 - i / 100, coefficient))
}

export function safeTime(value: number) {
  assert.ok(
    Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER,
    'Небезопасное значение времени FetchPlanner'
  )
  return value
}

export function requestDeadline(now: number, delay: number) {
  assert.ok(Number.isSafeInteger(now), 'Небезопасное начало интервала FetchPlanner')
  assert.ok(Number.isSafeInteger(delay) && delay >= 0, 'Небезопасный интервал FetchPlanner')
  return safeTime(now + delay)
}

export function calculateRequestDelay(
  state: {
    limit: number | null
    remaining: number | null
    retryTimeInterval: number
    elapsed: number
  },
  options: { maxRequestDelayTimeMs: number; jitter: number },
  attenuationSteps: readonly number[],
  random: number
) {
  if (state.limit === null || state.remaining === null) return 0
  const elapsed = Math.max(0, safeTime(state.elapsed))
  if (elapsed >= state.retryTimeInterval) return 0

  const level = Math.min(1, state.remaining / state.limit + elapsed / state.retryTimeInterval)
  const step = Math.round(level * 100)
  const k = attenuationSteps[step]
  assert.ok(k !== undefined, 'Некорректная таблица затухания FetchPlanner')
  const jitterRange = options.maxRequestDelayTimeMs * options.jitter
  const jitter = jitterRange / 2 - random * jitterRange
  const maximum = safeTime(options.maxRequestDelayTimeMs + jitter)
  const delay = Math.round(k * maximum)
  assert.ok(Number.isSafeInteger(delay) && delay >= 0, 'Небезопасная задержка FetchPlanner')
  return delay
}
