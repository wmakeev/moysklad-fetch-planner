import type { fetch as undiciFetch } from 'undici-types'
import type { fetch as modernUndiciFetch } from 'undici-types-modern'

export type UndiciFetch = typeof undiciFetch
export type Transport = typeof globalThis.fetch | UndiciFetch | typeof modernUndiciFetch
