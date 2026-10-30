import { FetchPlanner } from '../../../src/index.js'
export class NativePlanner extends FetchPlanner<typeof globalThis.fetch> {
  protected override checkFreeRequestSlotTrigger(): void {
    super.checkFreeRequestSlotTrigger()
  }
}
export const planner = new NativePlanner(globalThis.fetch)
