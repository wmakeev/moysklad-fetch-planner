import type { fetch as undiciFetch } from 'undici-types'

export type UndiciFetch = typeof undiciFetch
export type Transport = typeof globalThis.fetch | UndiciFetch
