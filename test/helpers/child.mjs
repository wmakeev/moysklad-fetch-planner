import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Response } from 'undici'
import { FetchPlanner } from '../../src/index.js'

const scenario = process.argv[2]
const original = new Error('original failure')
const secondary = new Error('secondary failure')
const planner = new FetchPlanner(
  () => {
    if (scenario === 'sync-transport') throw original
    if (scenario === 'error-observer') return Promise.reject(original)
    return delay(10).then(() => new Response(null))
  },
  {
    jitter: 0,
    eventHandler: {
      /** @param {string} name */
      emit(name) {
        if (scenario === 'request-observer' && name === 'request') throw original
        if (scenario === 'error-observer' && name === 'fetch-error') throw secondary
      }
    }
  }
)
await assert.rejects(planner.getFetch()('http://offline.test/'), error => error === original)
await delay(30)
assert.equal(planner.getActionsQueueLength(), 0)
assert.equal(planner.getCurInflightRequestsCount(), 0)
console.log('settled once; queue and inflight empty')
