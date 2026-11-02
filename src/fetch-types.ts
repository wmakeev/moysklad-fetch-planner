import type { fetch as undiciFetch } from 'undici-types'
import type { fetch as modernUndiciFetch } from 'undici-types-modern'
import type { fetch as undici8Fetch } from 'undici-types8'

export type UndiciFetch = typeof undiciFetch
export type Transport =
  | typeof globalThis.fetch
  | UndiciFetch
  | typeof modernUndiciFetch
  | typeof undici8Fetch
