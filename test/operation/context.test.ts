import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallbackContext } from '../../src/callback-context.js'
import { deferred } from './helpers.js'

for (const kind of ['prepare', 'consume', 'dispose', 'discard']) {
  test(`Context ${kind} guards await and fire-and-forget until return`, async () => {
    const context = new CallbackContext()
    const other = new CallbackContext()
    const gate = deferred<undefined>()
    const descendantGate = deferred<undefined>()
    const entered = deferred<undefined>()
    const seen: string[] = []
    const submit = () => (context.isActive() ? 'REENTRANT_OPERATION' : 'accepted')
    let descendant = Promise.resolve('unset')
    const work = context.run(
      async () => {
        seen.push(submit())
        await Promise.resolve(undefined)
        seen.push(submit())
        void Promise.resolve(undefined).then(() => {
          seen.push(submit())
        })
        descendant = descendantGate.promise.then(submit)
        entered.resolve(undefined)
        await gate.promise
        seen.push(submit())
        return 42
      },
      value => value
    )
    try {
      await entered.promise
      assert.equal(context.isActive(), false)
      assert.equal(other.isActive(), false)
      assert.deepEqual(seen, Array<string>(3).fill('REENTRANT_OPERATION'))
      gate.resolve(undefined)
      assert.equal((await work).value, 42)
      assert.deepEqual(seen, Array<string>(4).fill('REENTRANT_OPERATION'))
      descendantGate.resolve(undefined)
      assert.equal(await descendant, 'accepted')
    } finally {
      gate.resolve(undefined)
      descendantGate.resolve(undefined)
      await work
      await descendant
    }
  })

  for (const form of ['thenable', 'promise-subclass']) {
    for (const stateful of [false, true]) {
      test(`Context ${kind} ${form} ${stateful ? 'stateful' : 'ordinary'} recursive assimilation`, async () => {
        const context = new CallbackContext()
        const gate = deferred<undefined>()
        const entered = deferred<undefined>()
        const descendantGate = deferred<undefined>()
        const seen: string[] = []
        const submit = () => (context.isActive() ? 'REENTRANT_OPERATION' : 'accepted')
        const inspect = () => {
          seen.push(submit())
        }
        let descendant = Promise.resolve('unset')
        let reads = 0
        const final = { payload: kind }
        const chain = (depth: number): unknown =>
          depth === 0
            ? final
            : {
                then(resolve: (value: unknown) => void) {
                  inspect()
                  resolve(chain(depth - 1))
                }
              }
        const decision = {
          get then() {
            inspect()
            reads++
            if (reads !== (form === 'thenable' ? 2 : 3)) return undefined
            return (resolve: (value: unknown) => void) => {
              inspect()
              descendant = descendantGate.promise.then(submit)
              entered.resolve(undefined)
              void gate.promise.then(() => {
                resolve(chain(12))
              })
            }
          }
        }
        class CallbackPromise extends Promise<unknown> {
          override then<TResult1 = unknown, TResult2 = never>(
            fulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
            rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
          ): Promise<TResult1 | TResult2> {
            inspect()
            return super.then(fulfilled, rejected)
          }
        }
        const callback = () => {
          const value: unknown = stateful
            ? decision
            : {
                then(resolve: (value: unknown) => void) {
                  inspect()
                  descendant = descendantGate.promise.then(submit)
                  entered.resolve(undefined)
                  void gate.promise.then(() => {
                    resolve(chain(12))
                  })
                }
              }
          if (form === 'promise-subclass')
            return new CallbackPromise(resolve => {
              resolve(value)
            })
          return {
            then(resolve: (result: unknown) => void) {
              inspect()
              resolve(value)
            }
          }
        }
        let settled = false
        const work = context.run(callback, value => {
          inspect()
          return value
        })
        void work.then(() => {
          settled = true
        })
        try {
          await entered.promise
          assert.equal(settled, false)
          assert.ok(seen.length > 0)
          assert.deepEqual(
            seen,
            Array<string>(seen.length).fill('REENTRANT_OPERATION'),
            'pending assimilation retains REENTRANT_OPERATION'
          )
          gate.resolve(undefined)
          assert.equal((await work).value, final)
          assert.ok(seen.length >= 14)
          assert.deepEqual(
            seen,
            Array<string>(seen.length).fill('REENTRANT_OPERATION'),
            'recursive assimilation retains REENTRANT_OPERATION'
          )
          descendantGate.resolve(undefined)
          assert.equal(await descendant, 'accepted')
        } finally {
          gate.resolve(undefined)
          descendantGate.resolve(undefined)
          await work
          await descendant
        }
      })
    }
  }
}

test('Context protects materialization and boxes raw values without another then read', async () => {
  const context = new CallbackContext()
  const seen: boolean[] = []
  let reads = 0
  const value = {
    get then() {
      seen.push(context.isActive())
      reads++
      return undefined
    }
  }
  const result = await context.run(
    () => value,
    raw => raw
  )
  const before = reads
  assert.equal(result.value, value)
  await Promise.resolve(result)
  assert.equal(reads, before)
  assert.ok(seen.every(Boolean))
  assert.equal(Object.getPrototypeOf(result), null)
  assert.equal(Object.isFrozen(result), true)
})

test('Context guards throwing then and invalid descriptor getters and releases on failure', async () => {
  const context = new CallbackContext()
  const cause = new Error('invalid descriptor')
  const seen: boolean[] = []
  const badThen = {
    get then(): undefined {
      seen.push(context.isActive())
      throw cause
    }
  }
  await assert.rejects(
    context.run(
      () => badThen,
      value => value
    ),
    error => error === cause
  )
  const descriptor = {
    get url(): string {
      seen.push(context.isActive())
      throw cause
    }
  }
  await assert.rejects(
    context.run(
      () => descriptor,
      value => ({ url: value.url })
    ),
    error => error === cause
  )
  await assert.rejects(
    context.run(
      () => {
        throw cause
      },
      value => value
    ),
    error => error === cause
  )
  await assert.rejects(
    context.run(
      () => Promise.reject(cause),
      value => value
    ),
    error => error === cause
  )
  assert.deepEqual(seen, [true, true])
  assert.equal(context.isActive(), false)
  assert.equal(
    (
      await context.run(
        () => 'ok',
        value => value
      )
    ).value,
    'ok'
  )
})
