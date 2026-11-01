import type { Response } from 'undici'
import type { Handle } from '../src/index.js'

/** Minimal application projections, not copies of the vendor SDK models. */
export interface Document {
  meta: {
    type: string
  }
  id: string
}

export interface DocumentCollection {
  rows: Document[]
}

export interface DocumentRef {
  type: string
  id: string
}

/** Caller-only details: never pass this error or its body to observation/logging. */
export class DocumentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Document request failed: HTTP ${status}`)
    this.name = 'DocumentHttpError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDocument(value: unknown): value is Document {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    isRecord(value['meta']) &&
    typeof value['meta']['type'] === 'string'
  )
}

/** Finished collection consume, shared only by these document-list endpoints. */
export async function consumeDocuments(response: Response): Promise<DocumentCollection> {
  // Read to EOF before returning. HTML and the complete errors[] body remain available
  // to the caller through OperationError.cause, including multiple code/parameter pairs.
  const body = await response.text()
  if (!response.ok) throw new DocumentHttpError(response.status, body)
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('Expected a JSON document collection')
  }
  // Decode/schema failures are not branded as retryable wire-read failures.
  const value: unknown = JSON.parse(body)
  if (!isRecord(value) || !Array.isArray(value['rows'])) {
    throw new Error('Expected document collection rows')
  }
  const rows: unknown[] = value['rows']
  if (!rows.every(isDocument)) throw new Error('Invalid document collection row')
  return { rows }
}

/** Physical cleanup is distinct from result settlement, including failure paths. */
export async function finishedDocuments(handle: Handle<DocumentCollection>) {
  try {
    const completed = await handle.result
    const summary = await handle.resourcesDone
    if (summary.resources !== 'released') throw new Error('Document resources were not released')
    return completed
  } finally {
    await handle.resourcesDone
  }
}
