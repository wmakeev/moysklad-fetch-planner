// Test-only application recipes; the same code is shown in integration-guide.md.
import {
  OperationError,
  type Completed,
  type Handle,
  type Init,
  type Planner,
  type ResourceSummary,
  type Spec
} from '../../src/index.js'

export function finiteRun<T>(
  planner: Planner<Init<typeof fetch>, Response>,
  publish: (value: T) => void,
  taskFailure: (error: unknown) => void,
  resourceReport: (resources: ResourceSummary['resources']) => void
) {
  let stopped = false
  const active = new Map<Handle<T>, { result: boolean; resources: boolean }>()
  function softStop() {
    stopped = true
    planner.stop()
  }
  function track(handle: Handle<T>) {
    const state = { result: false, resources: false }
    active.set(handle, state) // Identity matters: several rejected handles can have id=0.
    const forget = () => {
      if (state.result && state.resources) active.delete(handle)
    }
    const result = handle.result
      .then(
        (completed: Completed<T>) => {
          publish(completed.value)
        },
        (error: unknown) => {
          if (
            error instanceof OperationError &&
            ['GUARD_OPEN', 'STOPPED', 'QUEUE_FULL'].includes(error.code)
          )
            softStop()
          taskFailure(error)
        }
      )
      .finally(() => {
        state.result = true
        forget()
      })
    const resources = handle.resourcesDone.then(summary => {
      resourceReport(summary.resources)
      state.resources = true
      forget()
    })
    return Promise.all([result, resources])
  }
  return {
    track,
    softStop,
    forceAbort() {
      softStop()
      for (const handle of active.keys()) handle.abort()
    },
    async windows(jobs: readonly Spec<Init<typeof fetch>, Response, T>[], width: number) {
      if (!Number.isSafeInteger(width) || width < 1) throw new Error('Invalid window')
      let next = 0
      while (!stopped && next < jobs.length) {
        const window: Promise<unknown>[] = []
        while (window.length < width && next < jobs.length) {
          const job = jobs[next++]
          if (job) window.push(track(planner.submit(job)))
        }
        await Promise.all(window) // Results publish early; next window waits for resources.
      }
      return next // Caller owns jobs[next..] as remaining work.
    },
    async finalize(waitMs: number) {
      if (!Number.isSafeInteger(waitMs) || waitMs < 1) throw new Error('Invalid wait')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all([...active.keys()].map(handle => handle.resourcesDone)),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, waitMs)
          })
        ])
        return [...active.keys()].map(handle => handle.snapshot())
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

export class CollectionFailure extends Error {
  constructor(
    readonly errors: readonly { index: number; message: string }[],
    readonly partial: readonly { index: number; value: string }[]
  ) {
    super('Collection failure')
  }
}

export async function consumeCollection(response: Response) {
  const text = await response.text() // Complete body, including HTTP error responses.
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const rows: unknown = JSON.parse(text)
  if (!Array.isArray(rows)) throw new Error('Invalid collection')
  const partial: { index: number; value: string }[] = []
  const errors: { index: number; message: string }[] = []
  rows.forEach((row: unknown, index) => {
    if (typeof row !== 'object' || row === null) throw new Error('Invalid row')
    if ('value' in row && typeof row.value === 'string') partial.push({ index, value: row.value })
    else if ('error' in row && typeof row.error === 'string')
      errors.push({ index, message: row.error })
    else throw new Error('Invalid row')
  })
  if (errors.length) throw new CollectionFailure(errors, partial)
  return partial
}

export function normalizeCollection(error: unknown) {
  return error instanceof OperationError &&
    error.code === 'CONSUME_FAILED' &&
    error.cause instanceof CollectionFailure
    ? error.cause
    : error
}

export function bindStop(
  run: { softStop(): void; forceAbort(): void },
  soft: AbortSignal,
  force: AbortSignal
) {
  const stop = () => {
    run.softStop()
  }
  const abort = () => {
    run.forceAbort()
  }
  soft.addEventListener('abort', stop)
  force.addEventListener('abort', abort)
  if (soft.aborted) stop()
  if (force.aborted) abort()
  return () => {
    soft.removeEventListener('abort', stop)
    force.removeEventListener('abort', abort)
  }
}
