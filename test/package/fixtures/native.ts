import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import type { RequestEvent, FetchPlannerEventMap } from '../../../src/index.js'
import { EventEmitter } from 'node:events'
export function nativeConsumer() {
  const request = new Request('https://local.invalid/', { method: 'POST', body: 'payload' })
  const form = new FormData()
  const file = new File(['payload'], 'payload.txt')
  form.append('file', file)
  const init: RequestInit = { method: 'POST', body: form }
  const planner = new FetchPlanner(globalThis.fetch)
  const wrapped: typeof globalThis.fetch = wrapFetch(globalThis.fetch)
  const scheduled: typeof globalThis.fetch = planner.getFetch()
  const response: Promise<Response> = scheduled(request, init)
  const url: Promise<Response> = wrapped(new URL('https://local.invalid/'), init)
  const fileBody: Promise<Response> = wrapped(request, { method: 'POST', body: file })
  const bytes: Promise<Uint8Array> = response.then(value => value.bytes())
  const requestBytes: Promise<Uint8Array> = request.bytes()
  const events = new EventEmitter<FetchPlannerEventMap<typeof globalThis.fetch>>()
  events.on('request', (event, instance) => {
    const input: string | URL | Request = event.url
    const method: RequestInit['method'] = event.method
    const fetch: typeof globalThis.fetch = instance.getFetch()
    void input
    void method
    void fetch
  })
  const eventPlanner = new FetchPlanner(globalThis.fetch, { eventHandler: events })
  const event: RequestEvent<typeof globalThis.fetch> = {
    actionId: 1,
    requestId: 1,
    url: request,
    method: 'POST',
    startTime: 0
  }
  return { response, url, fileBody, bytes, requestBytes, event, eventPlanner }
}
