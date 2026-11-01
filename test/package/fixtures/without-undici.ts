import { FetchPlanner } from '../../../src/index.js'
import type { Completed, Handle, Init, PrepareContext } from '../../../src/index.js'
import type { fetch, RequestInfo, RequestInit, Request, Response } from 'undici-types'

export function legacyConsumer(
  transport: typeof fetch,
  request: Request,
  freshInit: (ctx: PrepareContext) => RequestInit
) {
  const planner = new FetchPlanner(transport)
  // Request remains transport input intent; prepare produces fresh URL/init instead of forwarding it.
  const input: RequestInfo = request
  const result = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare(ctx) {
      const { method, signal, ...bodyInit } = freshInit(ctx)
      const prepared: Init<typeof transport> = bodyInit
      void method
      void signal
      return { url: request.url, init: prepared }
    },
    consume(response) {
      const exact: Response = response
      return exact.arrayBuffer()
    }
  })
  const text = planner.submit({
    method: 'GET',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: () => ({ url: 'https://local.invalid/', init: {} }),
    consume: response => response.text()
  })
  const url = planner.submit({
    method: 'GET',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: () => ({ url: new URL(request.url), init: {} }),
    consume: response => response.text()
  })
  const typed: Handle<ArrayBuffer> = result
  const completed: Promise<Completed<ArrayBuffer>> = typed.result
  return { result, completed, input, text, url, resources: typed.resourcesDone }
}
