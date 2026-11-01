import { FetchPlanner } from '../../../src/index.js'
import type { Attachment, Completed, Handle, Snapshot } from '../../../src/index.js'

export const planner = new FetchPlanner(globalThis.fetch)
export const observation = planner.observe(event => {
  const sequence: number = event.sequence
  const elapsed: number = event.elapsedMs
  void sequence
  void elapsed
})
export const handle = planner.submit({
  method: 'GET',
  replay: { serverSafe: true, consumeSafe: true },
  prepare: () => ({ url: 'https://local.invalid/', init: {} }),
  consume: response => response.bytes()
})
export const typed: Handle<Uint8Array> = handle
export const result: Promise<Completed<Uint8Array>> = handle.result
export const bytes: Promise<Uint8Array> = result.then(completed => completed.value)
export const observed: Attachment<Snapshot> = handle.observe(event => {
  const status: number | undefined = event.status
  void status
})
