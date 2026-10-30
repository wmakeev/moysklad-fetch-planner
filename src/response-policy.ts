/** Internal policy reads only status/headers; it never receives scheduler state or a body. */
interface HeadersReader {
  get(name: string): string | null
}

function parseNumberHeader(headers: HeadersReader, name: string, minimum: number) {
  const raw = headers.get(name)
  if (raw === null) return null
  // Preserve numeric prefixes accepted by the original parser.
  const value = Number.parseInt(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Некорректный формат заголовка ${name} - "${raw}"`)
  }
  return value
}

export function parseResponsePolicy(status: number, headers: HeadersReader) {
  const retryTimeInterval = parseNumberHeader(headers, 'x-lognex-retry-timeInterval', 1)
  const limit = parseNumberHeader(headers, 'x-ratelimit-limit', 1)
  const remaining = parseNumberHeader(headers, 'x-ratelimit-remaining', 0)
  const responseType =
    status !== 429
      ? 'OK'
      : headers.get('x-lognex-auth') === '429005'
        ? 'PARALLEL_LIMIT_OVERFLOW'
        : 'RATE_LIMIT_OVERFLOW'
  const retryAfterMs =
    responseType === 'RATE_LIMIT_OVERFLOW'
      ? parseNumberHeader(headers, 'x-lognex-retry-after', 0)
      : null
  return { retryTimeInterval, limit, remaining, responseType, retryAfterMs }
}
