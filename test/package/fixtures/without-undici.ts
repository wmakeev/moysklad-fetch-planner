import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import type { RequestEvent } from '../../../src/index.js'
import type { fetch, RequestInfo, RequestInit, Request, Response } from 'undici-types'
export function legacyConsumer(transport: typeof fetch, request: Request, init: RequestInit) {
  const planner = new FetchPlanner(transport)
  const wrapped: typeof transport = wrapFetch(transport)
  const result: Promise<Response> = planner.getFetch()(request, init)
  const event: RequestEvent<typeof transport> = {
    actionId: 1,
    requestId: 1,
    url: request,
    method: init.method,
    startTime: 0
  }
  const input: RequestInfo = event.url
  const text: Promise<Response> = wrapped('https://local.invalid/', init)
  const url: Promise<Response> = planner.getFetch()(new URL('https://local.invalid/'), init)
  return { result, wrapped, input, text, url }
}
