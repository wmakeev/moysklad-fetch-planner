import type { ReadableStream } from 'node:stream/web'
import { fetch, FormData, Agent, type Response } from 'undici8'
import type { Handle, Init, ResponseOf } from '../../../src/index.js'
import { FetchPlanner } from '../../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../../src/planner.js'

const wrapper: typeof fetch = (input, init) => fetch(input, init)
// A consumer-owned HTTP/1 transport: compile-only, never executed by the type runner.
const dispatcher = new Agent({ allowH2: false, connections: 1, pipelining: 1 })
const http1Fetch: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher })
const init: Init<typeof fetch> = { body: new FormData(), dispatcher }
for (const planner of [
  new FetchPlanner(fetch),
  new FetchPlanner<typeof fetch>(fetch),
  new FetchPlanner(wrapper),
  new FetchPlanner<typeof fetch>(wrapper),
  new FetchPlanner(http1Fetch),
  new FetchPlanner<typeof fetch>(http1Fetch),
  new DeepPlanner(fetch),
  new DeepPlanner<typeof fetch>(fetch),
  new DeepPlanner(wrapper),
  new DeepPlanner<typeof fetch>(wrapper),
  new DeepPlanner(http1Fetch),
  new DeepPlanner<typeof fetch>(http1Fetch)
]) {
  const bytes: Handle<Uint8Array> = planner.submit({
    method: 'POST',
    replay: { serverSafe: false, consumeSafe: false },
    prepare: () => ({ url: 'https://offline.invalid', init }),
    consume: (response, ctx) => {
      const exact: Response = response
      const stream: ReadableStream<string> = exact.textStream()
      void stream
      return exact.bytes().then(value => {
        if (exact.status === 503) throw ctx.retryableHttpFailure(new Error('Known full refusal'))
        return value
      })
    }
  })
  void bytes
}
type Equal<A, B> =
  (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Check<T extends true> = T
export type ExactResponse = Check<Equal<ResponseOf<typeof fetch>, Response>>
export type OwnedMethod = Check<Equal<Init<typeof fetch>['method'], undefined>>
export type OwnedSignal = Check<Equal<Init<typeof fetch>['signal'], undefined>>
