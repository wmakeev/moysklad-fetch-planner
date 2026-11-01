import { FetchPlanner } from '../../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../../src/planner.js'
import type { Completed, Handle, Init, ResponseOf } from '../../../src/index.js'
import type { ResourceSummary } from '../../../src/operation-types.js'

interface CustomInit extends RequestInit {
  trace?: string
}
interface CustomResponse extends Response {
  trace: string
}
declare function custom(input: string | URL | Request, init?: CustomInit): Promise<CustomResponse>

export const planner = new FetchPlanner(custom)
export const deepPlanner: typeof planner = new DeepPlanner(custom)
export const handle = planner.submit({
  method: 'GET',
  replay: { serverSafe: true, consumeSafe: true },
  prepare(ctx) {
    const signal: AbortSignal = ctx.signal
    const request = new Request('https://local.invalid/', { signal })
    const init: Init<typeof custom> = { trace: 't' }
    return { url: request.url, init }
  },
  async consume(response) {
    const exact: CustomResponse = response
    return { trace: exact.trace, text: await exact.text() }
  }
})
export const typed: Handle<{ trace: string; text: string }> = handle
export const result: Promise<Completed<{ trace: string; text: string }>> = handle.result
export const resources: Promise<ResourceSummary> = handle.resourcesDone
export const value: Promise<{ trace: string; text: string }> = result.then(done => done.value)

type Equal<A, B> =
  (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Check<T extends true> = T
export type CustomInference = Check<Equal<ResponseOf<typeof custom>, CustomResponse>>
export type TraceInit = Check<Equal<Init<typeof custom>['trace'], string | undefined>>
export type InferredValue = Check<Equal<typeof handle, Handle<{ trace: string; text: string }>>>
export type NonThenable = Check<Equal<Extract<'then', keyof typeof handle>, never>>
