import { FetchPlanner } from '../../../src/index.js'
import { FetchPlanner as DeepPlanner } from '../../../src/planner.js'
import type { Planner, Init, ResponseOf } from '../../../src/operation-types.js'

// Compile-only: restoring the old protected hook must conflict with this member.
// An ambient declaration adds no planner implementation or extension contract.
export declare class ProtectedHookAbsence extends FetchPlanner<typeof globalThis.fetch> {
  protected readonly checkFreeRequestSlotTrigger: 'removed'
}

// The old filename is retained; protected slot hooks are no longer an extension API.
export const planner: FetchPlanner<typeof globalThis.fetch> = new DeepPlanner(globalThis.fetch)
export const publicPlanner: Planner<
  Init<typeof globalThis.fetch>,
  ResponseOf<typeof globalThis.fetch>
> = planner
export const observation = publicPlanner.observe(event => {
  const dispatchCalls: number = event.dispatchCalls
  void dispatchCalls
})
export const handle = publicPlanner.submit({
  method: 'HEAD',
  replay: { serverSafe: true, consumeSafe: true },
  prepare: () => ({ url: 'https://local.invalid/', init: {} }),
  consume: response => response.status
})
export function stopConsumer() {
  handle.abort('consumer stopped')
  publicPlanner.stop('consumer stopped')
  observation.unsubscribe()
  return publicPlanner.snapshot()
}

type Check<T extends true> = T
export type RemovedExtension = Check<
  Extract<'getFetch' | 'waitForRequestSlot' | 'requestSlots', keyof typeof planner> extends never
    ? true
    : false
>
