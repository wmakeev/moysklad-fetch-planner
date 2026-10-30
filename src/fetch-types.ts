import type { fetch as undiciFetch } from 'undici-types'

export type UndiciFetch = typeof undiciFetch
export type Transport = typeof globalThis.fetch | UndiciFetch

// The planner creates a new callable; transport properties are not copied.
export type Scheduled<F extends Transport> = F extends Transport
  ? (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>
  : never
