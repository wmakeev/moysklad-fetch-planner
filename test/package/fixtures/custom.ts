import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import type { RequestEvent } from '../../../src/index.js'
interface CustomInit extends RequestInit {
  trace?: string
}
interface CustomResponse extends Response {
  trace: string
}
declare function custom(input: string | URL | Request, init?: CustomInit): Promise<CustomResponse>
export const wrapped = wrapFetch(custom)
export const response: Promise<CustomResponse> = wrapped('https://local.invalid/', { trace: 't' })
export const planner = new FetchPlanner(custom)
export const viaPlanner: Promise<CustomResponse> = planner.getFetch()(
  new Request('https://local.invalid/')
)
export const event: RequestEvent<typeof custom> = {
  actionId: 1,
  requestId: 1,
  url: new Request('https://local.invalid/'),
  method: 'GET',
  startTime: 0
}
