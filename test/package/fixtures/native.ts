import { ReadableStream } from 'node:stream/web'
import { FetchPlanner } from '../../../src/index.js'
import type { Completed, Handle, Init, ResponseOf } from '../../../src/index.js'

export function nativeConsumer() {
  const planner = new FetchPlanner(globalThis.fetch)
  const form = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    async prepare() {
      const request = new Request('https://local.invalid/', { method: 'POST', body: 'payload' })
      const requestBytes: Uint8Array = await request.bytes()
      const body = new FormData()
      body.append('file', new File([requestBytes], 'payload.txt'))
      const init: Init<typeof globalThis.fetch> = { body }
      return { url: request.url, init }
    },
    consume: response => response.bytes()
  })
  const file = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({
      url: new URL('https://local.invalid/'),
      init: { body: new File(['payload'], 'payload.txt') }
    }),
    consume: response => response.bytes()
  })
  const stream = planner.submit({
    method: 'PUT',
    entityKey: 'native-stream',
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
    consume: response => response.bytes()
  })
  const typed: Handle<Uint8Array> = form
  const result: Promise<Completed<Uint8Array>> = typed.result
  const bytes: Promise<Uint8Array> = result.then(completed => completed.value)
  return { planner, form, file, stream, bytes, resources: typed.resourcesDone }
}

type Equal<A, B> =
  (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Check<T extends true> = T
export type NativeResponse = Check<Equal<ResponseOf<typeof globalThis.fetch>, Response>>
export type OwnedMethod = Check<Equal<Init<typeof globalThis.fetch>['method'], undefined>>
export type OwnedSignal = Check<Equal<Init<typeof globalThis.fetch>['signal'], undefined>>
export type NativeResult = Check<
  Equal<ReturnType<typeof nativeConsumer>['file'], Handle<Uint8Array>>
>
