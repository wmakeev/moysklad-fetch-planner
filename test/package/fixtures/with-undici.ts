import { ReadableStream } from 'node:stream/web'
import { File } from 'node:buffer'
import { fetch, Request, FormData } from 'undici'
import type { Response } from 'undici'
import { FetchPlanner } from '../../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../../src/planner.js'
import type { Completed, Handle, Init, ResponseOf } from '../../../src/index.js'

export function undiciConsumer() {
  const planner = new FetchPlanner(fetch)
  const form = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare() {
      const request = new Request('https://local.invalid/')
      const body = new FormData()
      body.append('file', new File(['payload'], 'payload.txt'))
      const init: Init<typeof fetch> = { body }
      return { url: request.url, init }
    },
    consume(response, ctx) {
      const exact: Response = response
      return exact.arrayBuffer().then(value => {
        if (exact.status === 503) throw ctx.retryableHttpFailure(new Error('Known full refusal'))
        return value
      })
    }
  })
  const file = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({
      url: new URL('https://local.invalid/'),
      init: { body: new File([], 'x') }
    }),
    consume: response => response.arrayBuffer()
  })
  const stream = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({
      url: 'https://local.invalid/',
      init: {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          }
        }),
        duplex: 'half'
      }
    }),
    consume: response => response.arrayBuffer()
  })
  // The patched runtime extends the legacy declaration family with bytes().
  const modernBytes: Handle<Uint8Array> = planner.submit({
    method: 'GET',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({ url: 'https://local.invalid/', init: {} }),
    consume: response => response.bytes()
  })
  const typed: Handle<ArrayBuffer> = form
  const result: Promise<Completed<ArrayBuffer>> = typed.result
  const bytes: Promise<ArrayBuffer> = result.then(completed => completed.value)
  return { planner, form, file, stream, bytes, modernBytes, resources: typed.resourcesDone }
}

type Equal<A, B> =
  (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Check<T extends true> = T
export type UndiciResponse = Check<Equal<ResponseOf<typeof fetch>, Response>>
export type OwnedMethod = Check<Equal<Init<typeof fetch>['method'], undefined>>
export type OwnedSignal = Check<Equal<Init<typeof fetch>['signal'], undefined>>
export type UndiciResult = Check<
  Equal<ReturnType<typeof undiciConsumer>['file'], Handle<ArrayBuffer>>
>

export function deepHttpConsumer() {
  const planner = new DeepPlanner(fetch)
  return planner.submit({
    method: 'GET',
    replay: { serverSafe: true, consumeSafe: true },
    prepare: () => ({ url: 'https://offline.invalid/', init: {} }),
    async consume(response, ctx) {
      const text = await response.text()
      if (response.status === 503) throw ctx.retryableHttpFailure(new Error(text))
      return text
    }
  })
}
