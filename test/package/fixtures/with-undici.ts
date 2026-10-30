import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import { fetch, Request, Response } from 'undici'
import type { RequestInit } from 'undici'

export function exercise() {
  const request = new Request('https://local.invalid/')
  const init: RequestInit = { method: 'POST', body: 'payload' }
  const planner = new FetchPlanner(fetch)
  const wrapped: typeof fetch = wrapFetch(fetch)
  const response: Promise<Response> = planner.getFetch()(request, init)
  const post: Promise<Response> = wrapped('https://local.invalid/', init)
  const url: Promise<Response> = wrapped(new URL('https://local.invalid/'))
  return { response, post, url }
}
