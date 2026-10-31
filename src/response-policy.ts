import { absoluteDeadline } from './runtime.js'

/** Values exposed by Headers.get, not raw wire bytes (HTTP OWS may already be removed). */
interface HeadersReader {
  get(name: string): string | null
}

function decimal(raw: string, minimum: number): number | null {
  if (raw.length === 0 || /[^0-9]/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum ? value : null
}

/** RFC 9110 HTTP-date, including both obsolete recipient formats; no Date.parse extensions. */
function httpDate(raw: string, wall: number): number | null {
  if (raw.includes('\n') || raw.includes('\r')) return null
  const shortDay = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)'
  const month = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
  const time = '([0-9]{2}):([0-9]{2}):([0-9]{2})'
  const imf = new RegExp(`^${shortDay}, ([0-9]{2}) ${month} ([0-9]{4}) ${time} GMT$`).exec(raw)
  const rfc850 = new RegExp(
    `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-${month}-([0-9]{2}) ${time} GMT$`
  ).exec(raw)
  const asc = new RegExp(`^${shortDay} ${month} ([0-9]{2}| [0-9]) ${time} ([0-9]{4})$`).exec(raw)
  const parts = imf ?? rfc850
  if (!parts && !asc) return null
  const day = Number(parts ? parts[1] : asc?.[2])
  const monthName = parts ? parts[2] : asc?.[1]
  const monthIndex = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'
    .split(' ')
    .indexOf(monthName ?? '')
  let year = Number(parts ? parts[3] : asc?.[6])
  const hour = Number(parts ? parts[4] : asc?.[3])
  const minute = Number(parts ? parts[5] : asc?.[4])
  const second = Number(parts ? parts[6] : asc?.[5])
  if (rfc850) {
    const current = new Date(wall)
    const boundaryYear = current.getUTCFullYear() + 50
    year += Math.floor(boundaryYear / 100) * 100
    // Compare calendar components before Date normalization, including receipt milliseconds.
    const order = [
      year - boundaryYear,
      monthIndex - current.getUTCMonth(),
      day - current.getUTCDate(),
      hour - current.getUTCHours(),
      minute - current.getUTCMinutes(),
      second - current.getUTCSeconds(),
      -current.getUTCMilliseconds()
    ].find(difference => difference !== 0)
    if (order !== undefined && order > 0) year -= 100
  }
  const leapSecond = second === 60 && hour === 23 && minute === 59
  const calendarSecond = leapSecond ? 59 : second
  const date = new Date(0)
  date.setUTCFullYear(year, monthIndex, day)
  date.setUTCHours(hour, minute, calendarSecond, 0)
  if (
    year < 1900 ||
    date.toUTCString().slice(0, 3) !== raw.slice(0, 3) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== calendarSecond
  )
    return null
  // POSIX has no leap-second slot: map :60 to the following second after validation.
  return date.getTime() + (leapSecond ? 1000 : 0)
}

/** Independent scalar facts: one invalid exposed field contributes exactly one diagnostic. */
export function parseResponsePolicy(
  status: number,
  headers: HeadersReader,
  receipt: { monotonic: number; wall: number }
) {
  let invalidHints = 0
  function numeric(name: string, minimum: number) {
    const raw = headers.get(name)
    if (raw === null) return null
    const value = decimal(raw, minimum)
    if (value === null) invalidHints++
    return value
  }
  let serverNotBefore = 0
  function pause(name: string, standard = false) {
    const raw = headers.get(name)
    if (raw === null) return
    let duration = decimal(raw, 0)
    if (standard) {
      if (duration !== null) duration *= 1000
      else {
        const date = httpDate(raw, receipt.wall)
        if (date !== null) duration = Math.max(0, date - receipt.wall)
      }
    }
    const deadline =
      duration !== null && Number.isSafeInteger(duration)
        ? absoluteDeadline(receipt.monotonic, duration)
        : undefined
    if (deadline === undefined) invalidHints++
    else serverNotBefore = Math.max(serverNotBefore, deadline)
  }
  const retryTimeInterval = numeric('x-lognex-retry-timeinterval', 1)
  const limit = numeric('x-ratelimit-limit', 1)
  const remaining = numeric('x-ratelimit-remaining', 0)
  pause('x-lognex-retry-after')
  pause('x-lognex-reset')
  pause('retry-after', true)
  const responseType =
    status !== 429
      ? 'OK'
      : headers.get('x-lognex-auth') === '429005'
        ? 'PARALLEL_LIMIT_OVERFLOW'
        : 'RATE_LIMIT_OVERFLOW'
  return { retryTimeInterval, limit, remaining, responseType, serverNotBefore, invalidHints }
}
