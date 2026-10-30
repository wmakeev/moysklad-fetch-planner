import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import type {
  FetchPlannerEventMap,
  FetchPlannerEventHandler,
  FetchPlannerOptions,
  RequestEvent,
  ResponseEvent,
  FetchErrorEvent,
  FetchPlannerEvents
} from '../../../src/index.js'
import { EventEmitter } from 'node:events'
import type { fetch as uf } from 'undici-types'
declare const undiciFetch: typeof uf
const nativeEvents = new EventEmitter<FetchPlannerEventMap<NativeFetch>>()
const legacyEvents = new EventEmitter<FetchPlannerEventMap<UndiciFetch>>()
export const native = new FetchPlanner(globalThis.fetch, { eventHandler: nativeEvents })
export const legacy = new FetchPlanner(undiciFetch, { eventHandler: legacyEvents })
export const nativeWrapped: NativeFetch = wrapFetch(globalThis.fetch, {
  eventHandler: nativeEvents
})
export const legacyWrapped: UndiciFetch = wrapFetch(undiciFetch, { eventHandler: legacyEvents })
export const options: Partial<FetchPlannerOptions<NativeFetch>> = { eventHandler: nativeEvents }
export const handler: FetchPlannerEventHandler<NativeFetch> = nativeEvents
export const emit: FetchPlannerEventHandler<NativeFetch>['emit'] = (...args) => {
  const [name, event, instance] = args
  const input: string | URL | Request = event.url
  const fetch: NativeFetch = instance.getFetch()
  if (name === 'response') {
    const end: number = event.endTime
    void end
  }
  if (name === 'fetch-error') {
    const error: Error = event.error
    void error
  }
  void input
  void fetch
}
export const contextual = new FetchPlanner(globalThis.fetch, {
  eventHandler: {
    emit(name, event, instance) {
      const fetch: NativeFetch = instance.getFetch()
      const input: string | URL | Request = event.url
      void name
      void fetch
      void input
    }
  }
})
export const annotated: FetchPlannerEventHandler<NativeFetch> = { emit }
declare const request: RequestEvent<NativeFetch>
declare const response: ResponseEvent<NativeFetch>
declare const failure: FetchErrorEvent<NativeFetch>
handler.emit('request', request, native)
handler.emit('response', response, native)
handler.emit('fetch-error', failure, native)
export const eventUnion: FetchPlannerEvents<NativeFetch> = response
nativeEvents.on('request', (event, instance) => {
  const result: Promise<Response> = instance.getFetch()(event.url)
  void result
})
nativeEvents.on('response', (event, instance) => {
  const end: number = event.endTime
  const fetch: NativeFetch = instance.getFetch()
  void end
  void fetch
})
nativeEvents.on('fetch-error', (event, instance) => {
  const error: Error = event.error
  const fetch: NativeFetch = instance.getFetch()
  void error
  void fetch
})
legacyEvents.on('request', (event, instance) => {
  const result: ReturnType<UndiciFetch> = instance.getFetch()(event.url)
  void result
})
legacyEvents.on('response', (event, instance) => {
  const end: number = event.endTime
  const fetch: UndiciFetch = instance.getFetch()
  void end
  void fetch
})
legacyEvents.on('fetch-error', (event, instance) => {
  const error: Error = event.error
  const fetch: UndiciFetch = instance.getFetch()
  void error
  void fetch
})
interface CustomInit extends RequestInit {
  trace?: string
}
interface CustomResponse extends Response {
  trace: string
}
declare function custom(input: string | URL | Request, init?: CustomInit): Promise<CustomResponse>
const customEvents = new EventEmitter<FetchPlannerEventMap<typeof custom>>()
export const customPlanner = new FetchPlanner(custom, { eventHandler: customEvents })
export const customWrapped = wrapFetch(custom, { eventHandler: customEvents })
customEvents.on('request', (event, instance) => {
  const result: Promise<CustomResponse> = instance.getFetch()(event.url, { trace: 't' })
  void result
})
export const customResult: Promise<CustomResponse> = customWrapped('https://local.invalid/', {
  trace: 't'
})
export const legacyHandler: FetchPlannerEventHandler<UndiciFetch> = legacyEvents
export const legacyFetchPlannerOptions: Partial<FetchPlannerOptions<UndiciFetch>> = {
  eventHandler: legacyHandler
}
declare const legacyRequest: RequestEvent<UndiciFetch>
declare const legacyResponse: ResponseEvent<UndiciFetch>
declare const legacyFailure: FetchErrorEvent<UndiciFetch>
legacyHandler.emit('request', legacyRequest, legacy)
legacyHandler.emit('response', legacyResponse, legacy)
legacyHandler.emit('fetch-error', legacyFailure, legacy)

type NativeFetch = typeof globalThis.fetch
type UndiciFetch = typeof import('undici-types').fetch
