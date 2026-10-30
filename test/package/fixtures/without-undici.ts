import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import type { RequestInfo, RequestInit, Response } from 'undici-types'

export function exercise(transport: (input: RequestInfo, init?: RequestInit) => Promise<Response>) {
  const planner = new FetchPlanner(transport)
  const result: Promise<Response> = planner.getFetch()('https://local.invalid/')
  const wrapped: typeof transport = wrapFetch(transport)
  return { result, wrapped, planner }
}
