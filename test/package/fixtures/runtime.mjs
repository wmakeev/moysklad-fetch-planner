/// <reference types="node" />

import assert from 'node:assert/strict'
import { FetchPlanner, wrapFetch } from '../../../src/index.js'
import * as deep from '../../../src/index.js'

assert.equal(FetchPlanner, deep.FetchPlanner)
assert.equal(wrapFetch, deep.wrapFetch)
/** @type {{input: unknown, init: unknown}[]} */
const calls = []
const response = new Response('local response', { status: 200 })
// JS runtime smoke deliberately uses native Response; native fetch TYPE compatibility is stage 3.
/** @param {unknown} input @param {unknown} [init] */
const transport = (input, init) => {
  calls.push({ input, init })
  return Promise.resolve(response)
}
const get = new FetchPlanner(transport).getFetch()
assert.equal(await get('https://local.invalid/get'), response)
const post = wrapFetch(transport)
const init = { method: 'POST', body: 'payload' }
assert.equal(await post('https://local.invalid/post', init), response)
assert.deepEqual(calls, [
  { input: 'https://local.invalid/get', init: undefined },
  { input: 'https://local.invalid/post', init }
])
assert.equal(await response.text(), 'local response')
console.log('Runtime smoke: root/deep imports, GET/POST, original Response identity')
