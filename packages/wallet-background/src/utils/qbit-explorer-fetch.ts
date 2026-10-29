import { QbitApiError, type RequestOptions } from '@qbit-oss/api'

/**
 * Time budgets for the wallet's explorer requests (#353).
 *
 * `@qbit-oss/api` arms one timer per attempt that spans the response headers
 * and the whole body (`timeoutMs`, 15 s by default), and takes no separate
 * body budget. A 50-row history page of consolidation transactions carries
 * about 7.4 KB of witness hex per input, so it can run to tens of MB, which a
 * slow link cannot deliver in 15 s. The clients' fetch is therefore wrapped:
 * history pages and transaction reads must start answering within 15 s and
 * may then take as long as their bytes keep arriving, under a per-attempt
 * ceiling; every other reply keeps the 15 s budget.
 */

/** Response headers must arrive within this, as under the client's default. */
export const QBIT_EXPLORER_HEADERS_TIMEOUT_MS = 15_000

/** A large body that sends no bytes for this long is a dead connection. */
export const QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS = 15_000

/**
 * Any other reply (statistics, outputs, fees, the tip, a submission's
 * answer) is small, so it keeps the client's default: headers and body
 * together within this.
 */
export const QBIT_EXPLORER_REPLY_TIMEOUT_MS = 15_000

/**
 * The clients' per-attempt `timeoutMs`, which only a large-body read can
 * reach: it stops a body that trickles in just faster than the idle budget.
 * The largest page, 50 consolidations of 106 inputs, is about 40 MB, which
 * fits at about 135 KB/s, a link of about 1 Mbit/s. It is also the ceiling
 * of the whole read, every attempt included (see `QbitWalletEsploraClient`):
 * a body still arriving when it is reached would arrive no faster on a
 * second try, so a page too slow for it fails after about 5 minutes, not 15.
 */
export const QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS = 300_000

/**
 * A reply body is buffered whole, so a longer one fails as unreadable rather
 * than exhausting the background worker's memory: about one and a half times
 * the largest page above.
 */
export const QBIT_EXPLORER_MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * Routes, relative to the base URL, whose bodies can be large: an address's
 * history pages, and a transaction (a consolidation carries about 7.4 KB of
 * witness hex per input).
 */
const LARGE_BODY_ROUTE = /^(?:\/address\/[^/?]+\/txs(?:[/?]|$)|\/tx\/[0-9a-f]{64}(?:\/hex)?$)/i
const READ_METHODS = new Set(['GET', 'HEAD'])

/** Whether `route`, relative to the base URL, is one whose body can be large. */
export function isQbitExplorerLargeBodyRoute(route: string): boolean {
  return LARGE_BODY_ROUTE.test(route)
}

export interface QbitExplorerFetchOptions {
  /** The fetch to wrap; the global one, looked up per request, by default. */
  fetchFn?: typeof fetch | undefined
  /** The client's base URL: routes are read after it, and errors do not quote it. */
  baseUrl: string
}

/**
 * One deadline shared by every explorer read an operation makes (a
 * broadcast with its lookups, a status check, a fee bump's assessment, a
 * consolidation batch), and one cancellation for all of them. Each read is
 * handed `read()`: the operation's signal, and the time left as its
 * `deadlineMs`, so the client aborts a read still in flight when the
 * deadline passes and fails it as `timeout`, as for any timeout. A read
 * that would start after the deadline fails the same way without being
 * sent. The signal aborts only when the operation is cancelled (nothing
 * waits for it any more), never at the deadline itself.
 */
export class QbitExplorerOperation {
  private expiresAt: number | undefined

  /**
   * The deadline starts now, or with `started: false` at `start()`: an
   * operation that first waits its turn (behind another send on the send
   * guard, or another batch of a consolidation) spends none of it waiting.
   */
  constructor(
    readonly budgetMs = Number.POSITIVE_INFINITY,
    readonly signal?: AbortSignal,
    options: { started?: boolean } = {}
  ) {
    if (options.started !== false) this.start()
  }

  /** Start the deadline, unless it has started already. */
  start(): void {
    this.expiresAt ??= Date.now() + this.budgetMs
  }

  /**
   * The time left before the deadline, in ms: never negative, unbounded
   * without one, and the whole budget until it starts.
   */
  remainingMs(): number {
    if (this.expiresAt === undefined) return this.budgetMs
    return Math.max(0, this.expiresAt - Date.now())
  }

  /**
   * The options for one read: the operation's signal and the time left, at
   * most `capMs` (a shorter budget of the read's own). Throws once the
   * operation is cancelled, and a `timeout` `QbitApiError` once no time is
   * left.
   */
  read(capMs = Number.POSITIVE_INFINITY): RequestOptions {
    this.throwIfOver()
    const deadlineMs = Math.min(this.remainingMs(), capMs)
    return {
      ...(this.signal === undefined ? {} : { signal: this.signal }),
      ...(Number.isFinite(deadlineMs) ? { deadlineMs: Math.max(1, Math.ceil(deadlineMs)) } : {}),
    }
  }

  /**
   * Settle with `promise`, a wait no explorer read of this operation bounds
   * (a shared fee quote, say), or reject as `read` does once the operation
   * is cancelled or its deadline passes. The wait itself is not cancelled.
   */
  async within<T>(promise: Promise<T>): Promise<T> {
    this.throwIfOver()
    const remaining = this.remainingMs()
    if (!Number.isFinite(remaining) && this.signal === undefined) return promise
    const { signal } = this
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          if (Number.isFinite(remaining)) {
            timer = setTimeout(() => reject(this.deadlineError()), remaining)
          }
          onAbort = (): void => reject(signal?.reason)
          signal?.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  private throwIfOver(): void {
    if (this.signal?.aborted) throw this.signal.reason
    if (this.remainingMs() <= 0) throw this.deadlineError()
  }

  private deadlineError(): QbitApiError {
    return new QbitApiError('timeout', `operation exceeded its ${this.budgetMs}ms deadline`)
  }
}

/**
 * A fetch for the `@qbit-oss/api` clients that applies the budgets above. A
 * request that misses one is aborted, its body is cancelled, and the fetch
 * rejects with a `timeout` `QbitApiError`, which the client retries (or, for
 * a submission, reports as an unknown outcome) as when its own timer fires.
 *
 * The body is buffered before the promise resolves, so the client sees the
 * stall before the headers. A body that fails on its own is handed to the
 * client as it arrived, with the failure at its end, so the client judges it
 * as before. So is a submission's 429 that stalls: a 429 proves nothing was
 * submitted, and the client retries it even when its body is lost.
 */
export function createQbitExplorerFetch(options: QbitExplorerFetchOptions): typeof fetch {
  const { fetchFn } = options
  const baseUrl = options.baseUrl.replace(/\/+$/, '')

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const callerSignal = init?.signal ?? undefined
    const forwardAbort = (): void => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) forwardAbort()
    else callerSignal?.addEventListener('abort', forwardAbort, { once: true })
    const release = (): void => callerSignal?.removeEventListener('abort', forwardAbort)

    const href = requestHref(input)
    const route = href.startsWith(baseUrl) ? href.slice(baseUrl.length) : undefined
    const largeBody = route !== undefined && isQbitExplorerLargeBodyRoute(route)
    let status: number | undefined = undefined
    const stalled = (reason: string): void =>
      controller.abort(stallError(errorUrl(href, baseUrl, route), reason, status))

    // A large body's headers have their own budget; any other reply has one for both.
    const headersTimer = largeBody
      ? setTimeout(
          () => stalled(`no response headers within ${QBIT_EXPLORER_HEADERS_TIMEOUT_MS}ms`),
          QBIT_EXPLORER_HEADERS_TIMEOUT_MS
        )
      : undefined
    const replyTimer = largeBody
      ? undefined
      : setTimeout(
          () => stalled(`no complete reply within ${QBIT_EXPLORER_REPLY_TIMEOUT_MS}ms`),
          QBIT_EXPLORER_REPLY_TIMEOUT_MS
        )
    let pending: Promise<Response> | undefined
    let response: Response
    try {
      const requestInit = { ...init, signal: controller.signal }
      pending = fetchFn ? fetchFn(input, requestInit) : globalThis.fetch(input, requestInit)
      response = await raceAbort(pending, controller.signal)
    } catch (error) {
      clearTimeout(replyTimer)
      release()
      // A fetch that ignores its signal may still deliver a response nobody reads.
      pending?.then(
        late => cancelBody(late.body, error),
        () => undefined
      )
      throw error
    } finally {
      clearTimeout(headersTimer)
    }
    status = response.status

    if (!hasGuardableBody(response)) {
      // The caller's abort still reaches the request while the client reads
      // (or, for a redirect, refuses and discards) the body itself.
      clearTimeout(replyTimer)
      return response
    }
    const submission = !READ_METHODS.has((init?.method ?? 'GET').toUpperCase())
    const keepReply = submission && status === 429

    const reader = response.body.getReader()
    let chunks: (Uint8Array | undefined)[] = []
    let bytes = 0
    let failure: { error: unknown } | undefined
    try {
      while (failure === undefined) {
        const idleTimer = largeBody
          ? setTimeout(
              () => stalled(`no response body bytes for ${QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS}ms`),
              QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS
            )
          : undefined
        try {
          const chunk = await raceAbort(reader.read(), controller.signal)
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > QBIT_EXPLORER_MAX_BODY_BYTES) {
            // Unreadable, as the client reports a body it cannot read.
            const error = new RangeError(
              `response body exceeds ${QBIT_EXPLORER_MAX_BODY_BYTES} bytes`
            )
            failure = { error }
            chunks = []
            controller.abort(error)
            reader.cancel(error).catch(() => undefined)
            break
          }
          chunks.push(chunk.value)
        } catch (error) {
          if (!controller.signal.aborted) {
            failure = { error }
          } else {
            // A stall or the caller's abort: the request is aborted; release the body too.
            reader.cancel(controller.signal.reason).catch(() => undefined)
            if (!keepReply) throw controller.signal.reason
            // A caller's abort has already ended the client's wait; only a stall reaches it.
            failure = { error: controller.signal.reason }
          }
        } finally {
          clearTimeout(idleTimer)
        }
      }
    } finally {
      clearTimeout(replyTimer)
      release()
    }

    let next = 0
    const replay = new ReadableStream<Uint8Array>({
      pull(stream): void {
        const chunk = chunks[next]
        if (chunk !== undefined) {
          // Dropped once handed over, so a large page is not held twice.
          chunks[next++] = undefined
          stream.enqueue(chunk)
        } else if (failure !== undefined) {
          stream.error(failure.error)
        } else {
          stream.close()
        }
      },
    })
    return withBody(response, replay)
  }
}

/**
 * Whether `response` has a web-stream body this can buffer and re-wrap. A
 * redirect is passed through unread, with its `type` and `redirected`, for
 * the client to refuse; an opaque one has status 0.
 */
function hasGuardableBody(
  response: Response
): response is Response & { body: ReadableStream<Uint8Array> } {
  const { body, status } = response
  const redirect = (status >= 300 && status <= 399) || response.redirected === true
  return (
    typeof body?.getReader === 'function' &&
    !redirect &&
    status >= 200 &&
    status <= 599 &&
    // `new Response` rejects a body for these.
    status !== 204 &&
    status !== 205
  )
}

/** `response`'s status, URL and headers with `body` in place of its own. */
function withBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  const { status, statusText } = response
  let rebuilt: Response
  try {
    rebuilt = new Response(body, { status, statusText })
  } catch {
    // A custom fetch's status text may not be one the constructor accepts.
    rebuilt = new Response(body, { status })
  }
  // A constructed Response has no URL and re-parses headers; the client reads
  // the fetched ones (redirect checks, Retry-After, error messages).
  Object.defineProperties(rebuilt, {
    url: { value: response.url },
    headers: { value: response.headers },
  })
  return rebuilt
}

/** Settle with `promise`, or reject with the abort reason as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** Best-effort release of a body nobody will read; a custom fetch's may not be a web stream. */
function cancelBody(body: ReadableStream<Uint8Array> | null | undefined, reason: unknown): void {
  if (typeof body?.cancel !== 'function') return
  body.cancel(reason).catch(() => undefined)
}

/** The attempt's `timeout`, as the client would raise it, with the status once the headers arrived. */
function stallError(url: string, reason: string, status?: number): QbitApiError {
  return new QbitApiError('timeout', `request timed out: ${reason}: ${url}`, {
    url,
    ...(status === undefined ? {} : { status }),
  })
}

function requestHref(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/**
 * The request URL as errors show it. A client passes a fetchFn's own
 * `QbitApiError` through unredacted, so the base URL, whose path can carry an
 * API token, is shown as its origin and `/...`, then the route. As in the
 * client, an `@` after the authority (a password with a raw `/` misread as a
 * host and port) hides the origin too.
 */
function errorUrl(href: string, baseUrl: string, route: string | undefined): string {
  let origin = '...'
  try {
    const authorityEnd = baseUrl.indexOf('/', baseUrl.indexOf('//') + 2)
    if (authorityEnd < 0 || !baseUrl.slice(authorityEnd).includes('@')) {
      origin = `${new URL(href).origin}/...`
    }
  } catch {
    // Not parsable here: show none of it.
  }
  return `${origin}${route ?? ''}`
}
