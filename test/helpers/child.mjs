import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent, fetch, Response } from 'undici'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { FetchPlanner } from '../../src/index.js'

const scenario = process.argv[2]
if (scenario === 'cleanup-loopback') await cleanupLoopback()
else await lifecycle()

async function lifecycle() {
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
}

async function cleanupLoopback() {
  let requests = 0
  let closedBodies = 0
  let cancelCalls = 0
  let cancelled = 0
  let retry = true
  const server = createServer((req, res) => {
    requests++
    const mode = req.url?.slice(1) ?? ''
    const discarded = mode !== 'delivered' && (mode !== 'retry' || retry)
    const status = mode === 'retry' && retry ? 429 : mode.endsWith('500') ? 500 : 200
    if (mode === 'retry') retry = false
    res.writeHead(status, {
      'Content-Type': 'text/plain',
      'X-RateLimit-Limit': mode.startsWith('header') ? 'invalid' : '45',
      'X-RateLimit-Remaining': '45',
      'X-Lognex-Retry-After': '0'
    })
    if (discarded) {
      res.on('close', () => closedBodies++)
      res.write('discarded body that never ends until cancelled')
    } else res.end('consumer body')
  })
  const agent = new Agent({ connections: 1, pipelining: 1 })
  /** @type {Promise<void>[]} */
  const cancellations = []
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/`
    for (const mode of [
      'retry',
      'header200',
      'header500',
      'observer200',
      'observer500',
      'late200',
      'late500'
    ]) {
      const original = new Error('observer failed')
      let observerFailed = false
      /** @type {() => void} */
      let release = () => {
        throw new Error('Transport gate is not initialized')
      }
      const observed = new Promise(resolve => {
        release = () => {
          resolve(undefined)
        }
      })
      const planner = new FetchPlanner(
        async (url, init) => {
          const response = await fetch(url, { ...init, dispatcher: agent })
          assert.equal(response.headers.get('content-type'), 'text/plain')
          const body = response.body
          assert.ok(body)
          const cancel = body.cancel.bind(body)
          body.cancel = (...args) => {
            cancelCalls++
            const completion = cancel(...args).then(() => {
              cancelled++
            })
            cancellations.push(completion)
            return completion
          }
          if (mode.startsWith('late')) await observed
          return response
        },
        {
          jitter: 0,
          maxParallelLimit: 1,
          eventHandler: {
            emit(name) {
              if (
                !observerFailed &&
                ((mode.startsWith('late') && name === 'request') ||
                  (mode.startsWith('observer') && name === 'response'))
              ) {
                observerFailed = true
                throw original
              }
            }
          }
        }
      )
      const result = planner.getFetch()(base + mode)
      if (mode === 'retry') {
        const response = await result
        assert.equal(response.status, 200)
        assert.equal(response.bodyUsed, false)
        assert.equal(await response.text(), 'consumer body')
      } else {
        await assert.rejects(result, error =>
          mode.startsWith('header') ? error instanceof Error : error === original
        )
        release()
      }
      // A single-connection pool cannot deliver this request until discarded bodies release it.
      const next = await planner.getFetch()(base + 'delivered')
      assert.equal(await next.text(), 'consumer body')
      await delay(0)
      assert.equal(planner.getCurInflightRequestsCount(), 0)
      assert.equal(planner.getActionsQueueLength(), 0)
    }
    await Promise.all(cancellations)
    assert.equal(cancelCalls, 7, 'Each owned real body must be cancelled once')
    assert.equal(cancelled, 7, 'All finite real cancels must settle')
    assert.equal(closedBodies, 7, 'Server observes each discarded response closing')
    assert.equal(requests, 15)
    // A rejected finite cancellation is also contained under strict unhandled-rejections.
    let starts = 0
    const bad = new Response('discarded', { status: 429 })
    assert.ok(bad.body)
    bad.body.cancel = () => Promise.reject(new Error('finite cancel rejection'))
    const planner = new FetchPlanner(
      () => Promise.resolve(++starts === 1 ? bad : new Response(null)),
      { jitter: 0 }
    )
    assert.equal((await planner.getFetch()('http://offline.test/')).status, 200)
    await delay(0)
    console.log('loopback: retry, header, observer, late; bodies released; finite cancels settled')
  } finally {
    try {
      await agent.destroy()
    } finally {
      server.closeAllConnections()
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close(error => {
            if (error) reject(error)
            else resolve(undefined)
          })
        })
      }
    }
  }
}
