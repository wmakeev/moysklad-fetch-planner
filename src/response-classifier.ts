/** Only the intercepted 429 body is owned here; no transport or policy decisions. */
interface Response429 {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: ReadableStream<Uint8Array> | null
}

type Classification = 'generic429' | 'parallel1073'

interface KnownReaderWork {
  readonly readFailed: boolean
  readonly cancelFailed: boolean
  readonly readerReleased: boolean
}

function has1073(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('errors' in value)) return false
  if (!Array.isArray(value.errors)) return false
  return value.errors.some(
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 1073
  )
}

function decode1073(bytes: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return has1073(value)
  } catch {
    return false
  }
}

/**
 * Caller supplies monotonic time and calls expire at deadline (or cancel on abort).
 * result is logical classification; knownWork waits for the actual read AND cancel.
 * Its facts describe known reader work, never physical upload/transport release.
 */
export class ResponseClassifier {
  readonly status = 429
  readonly deadline: number
  readonly result: Promise<Classification>
  readonly knownWork: Promise<KnownReaderWork>
  private resolveResult: (value: Classification) => void = () => undefined
  private finished = false
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private cancelWork: Promise<void> | undefined
  private readFailed = false
  private cancelFailed = false
  private readerReleased = false

  constructor(
    response: Response429,
    startedAt: number,
    private readonly now: () => number
  ) {
    if (response.status !== 429) throw new TypeError('CLASSIFIER_REQUIRES_429')
    this.deadline = startedAt + 250
    this.result = new Promise(resolve => {
      this.resolveResult = resolve
    })
    this.knownWork = this.read(response)
  }

  expire(now: number): void {
    if (now >= this.deadline) this.cancel()
  }

  cancel(): void {
    if (this.finished) return
    this.finish('generic429')
    this.cancelReader()
  }

  private isFinished(): boolean {
    return this.finished
  }

  private finish(classification: Classification): void {
    if (this.finished) return
    this.finished = true
    this.resolveResult(classification)
  }

  private cancelReader(): void {
    if (!this.reader || this.cancelWork) return
    try {
      this.cancelWork = this.reader.cancel().catch(() => {
        this.cancelFailed = true
      })
    } catch {
      this.cancelFailed = true
    }
  }

  private async read(response: Response429): Promise<KnownReaderWork> {
    try {
      if (!response.body) {
        this.readerReleased = true
        this.finish('generic429')
      } else {
        this.reader = response.body.getReader()
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
        if (mediaType?.toLowerCase() !== 'application/json') {
          this.cancel()
        } else {
          const bytes = new Uint8Array(65536)
          let acceptedBytes = 0
          while (!this.isFinished()) {
            this.expire(this.now())
            if (this.isFinished()) break
            const chunk = await this.reader.read()
            this.expire(this.now())
            if (this.isFinished()) break
            if (chunk.done) {
              const parallel = decode1073(bytes.subarray(0, acceptedBytes))
              this.expire(this.now())
              this.finish(parallel ? 'parallel1073' : 'generic429')
              break
            }
            // Check before touching/copying/decoding the chunk, including at the exact cap.
            if (chunk.value.byteLength > bytes.byteLength - acceptedBytes) {
              this.cancel()
              break
            }
            bytes.set(chunk.value, acceptedBytes)
            acceptedBytes += chunk.value.byteLength
          }
        }
      }
    } catch {
      this.readFailed = true
      this.finish('generic429')
      this.cancelReader()
    } finally {
      await this.cancelWork
      if (this.reader) {
        this.reader.releaseLock()
        this.readerReleased = true
        this.reader = undefined
      }
    }
    return {
      readFailed: this.readFailed,
      cancelFailed: this.cancelFailed,
      readerReleased: this.readerReleased
    }
  }
}
