import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import type { RequestEvent } from '../../../src/index.js'
import { fetch, Request, Response, FormData } from 'undici'
import { File } from 'node:buffer'
import type { RequestInit } from 'undici'
export function undiciConsumer() {
  const request = new Request('https://local.invalid/')
  const form = new FormData()
  form.append('file', new File(['payload'], 'payload.txt'))
  const init: RequestInit = { method: 'POST', body: form }
  const planner = new FetchPlanner(fetch)
  const wrapped: typeof fetch = wrapFetch(fetch)
  const result: Promise<Response> = planner.getFetch()(request, init)
  const fileBody: Promise<Response> = wrapped(new URL('https://local.invalid/'), {
    body: new File([], 'x')
  })
  const event: RequestEvent<typeof fetch> = {
    actionId: 1,
    requestId: 1,
    url: request,
    method: 'POST',
    startTime: 0
  }
  const post: Promise<Response> = wrapped('https://local.invalid/', init)
  return { wrapped, result, fileBody, event, post }
}
