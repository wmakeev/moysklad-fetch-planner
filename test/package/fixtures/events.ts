import { FetchPlanner } from '../../../src/index.js'
import type {
  Attachment,
  Completed,
  Decision,
  Event,
  EventType,
  FailureCode,
  FetchPlannerOptions,
  Handle,
  Phase,
  PlannerSnapshot,
  Snapshot
} from '../../../src/index.js'
import type { fetch as undiciFetch } from 'undici-types'

declare const transport: typeof undiciFetch
export const options: Partial<FetchPlannerOptions> = { maxSubscribers: 4 }
export const native = new FetchPlanner(globalThis.fetch, options)
export const undici = new FetchPlanner(transport, options)

// Observation carries detached scalar facts; a listener has no transport or control return.
export const listener: (event: Event) => void = event => {
  const type: EventType = event.type
  const phase: Phase = event.phase
  const sequence: number = event.sequence
  const epoch: number = event.epochTime
  const elapsed: number = event.elapsedMs
  if (type === 'dispatch-started') {
    const entered: boolean = event.dispatchEntered
    void entered
  }
  if (type === 'headers-received') {
    const status: number | undefined = event.status
    void status
  }
  if (type === 'operation-settled') {
    const failure: FailureCode | undefined = event.failureCode
    const outcome: Snapshot['outcome'] = event.outcome
    void failure
    void outcome
  }
  void phase
  void sequence
  void epoch
  void elapsed
}
export const nativeObservation: Attachment<PlannerSnapshot> = native.observe(listener)
export const undiciObservation: Attachment<PlannerSnapshot> = undici.observe(listener)
export const nativeHandle = native.submit({
  method: 'GET',
  replay: { serverSafe: true, consumeSafe: true },
  prepare: () => ({ url: 'https://local.invalid/', init: {} }),
  consume: response => response.bytes(),
  beforeDispatch(context) {
    const signal: AbortSignal = context.signal
    const snapshot: Snapshot = context.snapshot
    const decision: Decision = { type: 'allow' }
    void signal
    void snapshot
    return decision
  }
})
export const undiciHandle = undici.submit({
  method: 'GET',
  replay: { serverSafe: true, consumeSafe: true },
  prepare: () => ({ url: new URL('https://local.invalid/'), init: {} }),
  consume: response => response.arrayBuffer()
})
export const nativeResult: Promise<Completed<Uint8Array>> = nativeHandle.result
export const undiciResult: Promise<Completed<ArrayBuffer>> = undiciHandle.result
export const handleObservation: Attachment<Snapshot> = nativeHandle.observe(listener)
export const contextual = undiciHandle.observe(event => {
  const type: EventType = event.type
  const resources: Snapshot['resources'] = event.resources
  void type
  void resources
})

interface CustomInit extends RequestInit {
  trace?: string
}
interface CustomResponse extends Response {
  trace: string
}
declare function custom(input: string | URL | Request, init?: CustomInit): Promise<CustomResponse>
export const customPlanner = new FetchPlanner(custom, options)
export const customObservation: Attachment<PlannerSnapshot> = customPlanner.observe(listener)
export const customHandle = customPlanner.submit({
  method: 'GET',
  replay: { serverSafe: true, consumeSafe: true },
  prepare: () => ({ url: 'https://local.invalid/', init: { trace: 't' } }),
  consume: response => response.trace
})

type Equal<A, B> =
  (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Check<T extends true> = T
export type ReadonlyEvent = Check<Equal<Event, Readonly<Event>>>
export type ReadonlyOperation = Check<Equal<Snapshot, Readonly<Snapshot>>>
export type ReadonlyPlanner = Check<Equal<PlannerSnapshot, Readonly<PlannerSnapshot>>>
export type PrivatePayload = Check<
  Equal<Extract<'url' | 'body' | 'error' | 'value' | 'signal' | 'metadata', keyof Event>, never>
>
export type CustomInference = Check<Equal<typeof customHandle, Handle<string>>>
export type UndiciInference = Check<Equal<typeof undiciHandle, Handle<ArrayBuffer>>>
