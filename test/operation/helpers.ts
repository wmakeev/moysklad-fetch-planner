export { createRuntime, trackTimeouts } from '../helpers/runtime.js'

/** Call resolve in finally so pending work cannot outlive a test. */
export function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('Deferred executor has not initialized')
  }
  let reject: (reason: unknown) => void = () => {
    throw new Error('Deferred executor has not initialized')
  }
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
