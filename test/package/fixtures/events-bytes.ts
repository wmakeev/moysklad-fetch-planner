import { FetchPlanner } from '../../../src/index.js'
import type { FetchPlannerEventMap } from '../../../src/index.js'
import { EventEmitter } from 'node:events'
const events = new EventEmitter<FetchPlannerEventMap<NativeFetch>>()
events.on('request', (event, instance) => {
  const result: Promise<Response> = instance.getFetch()(event.url)
  void result.then(response => response.bytes())
})
export const planner = new FetchPlanner(globalThis.fetch, { eventHandler: events })

type NativeFetch = typeof globalThis.fetch
