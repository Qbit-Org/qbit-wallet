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
 * ceiling; every other reply keeps the 15 s budget, which a request body
 * extends by the time it takes to upload (#130).
 */

/** Response headers must arrive within this, as under the client's default. */
export const QBIT_EXPLORER_HEADERS_TIMEOUT_MS = 15_000

/** A large body that sends no bytes for this long is a dead connection. */
export const QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS = 15_000

/**
 * Any other reply (statistics, outputs, fees, the tip, a submission's
 * answer) is small, so it keeps the client's default: headers and body
 * together within this, besides the time the request's own body takes to go
 * out (see `qbitExplorerReplyTimeoutMs`).
 */
export const QBIT_EXPLORER_REPLY_TIMEOUT_MS = 15_000

/**
 * The slowest upload a request body is given time for: 16 KiB/s, about
 * 130 kbit/s. `fetch` resolves only once the body has gone out, and reports
 * no progress while it does, so a stalled upload cannot be told from a slow
 * one; the reply's budget grows with the body instead. The largest standard
 * transaction is 400,000 bytes (see `QBIT_MAX_STANDARD_TX_WEIGHT`), about
 * 800 kB of hex, which in 15 s took about 430 kbit/s; it now has about 64 s.
 */
export const QBIT_EXPLORER_MIN_UPLOAD_BYTES_PER_SECOND = 16 * 1024

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
 * A reply body is buffered whole, so a longer one fails as `response_too_large`
 * rather than exhausting the background worker's memory: about one and a half
 * times the largest page above. It is the clients' default `maxResponseBytes`
 * (see `QbitWalletEsploraClient`), the limit the fetch below buffers to.
 */
export const QBIT_EXPLORER_MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * Routes, relative to the base URL, whose bodies can be large: an address's
 * history pages, and a transaction (a consolidation carries about 7.4 KB of
 * witness hex per input).
 */
const LARGE_BODY_ROUTE = /^(?:\/address\/[^/?]+\/txs(?:[/?]|$)|\/tx\/[0-9a-f]{64}(?:\/hex)?$)/i

/** Whether `route`, relative to the base URL, is one whose body can be large. */
export function isQbitExplorerLargeBodyRoute(route: string): boolean {
  return LARGE_BODY_ROUTE.test(route)
}

/**
 * The budget of a reply that is not a large body, for a request that sends
 * `body` (a submission's transaction hex, say): `QBIT_EXPLORER_REPLY_TIMEOUT_MS`
 * plus the time `body` takes to upload at
 * `QBIT_EXPLORER_MIN_UPLOAD_BYTES_PER_SECOND`, at most
 * `QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS`. A request without a body, or with one
 * whose size is not known up front (a stream, a form), keeps 15 s; a
 * one-input payment, about 8 kB of hex, gets half a second more.
 */
export function qbitExplorerReplyTimeoutMs(body?: BodyInit | null): number {
  const uploadMs = Math.ceil(
    (requestBodyBytes(body) * 1_000) / QBIT_EXPLORER_MIN_UPLOAD_BYTES_PER_SECOND
  )
  return Math.min(QBIT_EXPLORER_REPLY_TIMEOUT_MS + uploadMs, QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS)
}

/** The bytes `body` sends, where they are known before it is sent; 0 otherwise. */
function requestBodyBytes(body: BodyInit | null | undefined): number {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  if (typeof Blob === 'function' && body instanceof Blob) return body.size
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength
  return 0
}

export interface QbitExplorerFetchOptions {
  /** The fetch to wrap; the global one, looked up per request, by default. */
  fetchFn?: typeof fetch | undefined
  /** The client's base URL: routes are read after it, and errors do not quote it. */
  baseUrl: string
  /** The client's `maxResponseBytes` (default `QBIT_EXPLORER_MAX_BODY_BYTES`). */
  maxBodyBytes?: number | undefined
}

/**
 * The query parameter that makes a read fresh: a random nonce no other
 * request carries, so no cache keyed by URL, the browser's or one in front
 * of the explorer (electrs lets a reply be reused for 10 s), can answer it
 * with an earlier reply. The explorer ignores it. The wallet's explorer
 * fetch also sends such a read with `cache: 'no-store'`.
 */
export const QBIT_EXPLORER_FRESH_READ_PARAM = 'qbit_fresh'

/** `path`, relative to a base URL, as a fresh read of it (see `QBIT_EXPLORER_FRESH_READ_PARAM`). */
export function qbitExplorerFreshReadPath(path: string): string {
  const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return `${path}${path.includes('?') ? '&' : '?'}${QBIT_EXPLORER_FRESH_READ_PARAM}=${nonce}`
}

/** Whether `route`, relative to the base URL, is a fresh read. */
function isQbitExplorerFreshRead(route: string): boolean {
  const query = route.indexOf('?')
  return (
    query >= 0 && new URLSearchParams(route.slice(query + 1)).has(QBIT_EXPLORER_FRESH_READ_PARAM)
  )
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
 * stall before the headers. A submission's budget covers its upload as well
 * (see `qbitExplorerReplyTimeoutMs`): a large transaction on a slow link is
 * not cut off while it is still going out, and one whose upload stalls is a
 * timeout once that budget is spent. A body that fails on its own is handed
 * to the client as it arrived, with the failure at its end, so the client
 * judges it as before. A submission's reply that stalls, a 429 included,
 * rejects as a timeout, which the client reports as an unknown outcome: a
 * 429 whose body was not read may have said that the node has the
 * transaction. A body past `maxBodyBytes` rejects as `response_too_large`, as
 * the client's own limit does: a read is not retried, and a submission's
 * reply is an unknown outcome that is not sent again.
 */
export function createQbitExplorerFetch(options: QbitExplorerFetchOptions): typeof fetch {
  const { fetchFn } = options
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const maxBodyBytes = options.maxBodyBytes ?? QBIT_EXPLORER_MAX_BODY_BYTES

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

    // A large body's headers have their own budget; any other reply has one
    // for both, which also covers the upload of the request's own body: the
    // fetch below resolves only once that has gone out.
    const headersTimer = largeBody
      ? setTimeout(
          () => stalled(`no response headers within ${QBIT_EXPLORER_HEADERS_TIMEOUT_MS}ms`),
          QBIT_EXPLORER_HEADERS_TIMEOUT_MS
        )
      : undefined
    const replyTimeoutMs = largeBody ? undefined : qbitExplorerReplyTimeoutMs(init?.body)
    const replyTimer =
      replyTimeoutMs === undefined
        ? undefined
        : setTimeout(() => stalled(`no complete reply within ${replyTimeoutMs}ms`), replyTimeoutMs)
    let pending: Promise<Response> | undefined
    let response: Response
    try {
      const requestInit: RequestInit = { ...init, signal: controller.signal }
      if (route !== undefined && isQbitExplorerFreshRead(route)) requestInit.cache = 'no-store'
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
    const reader = response.body.getReader()
    const chunks: (Uint8Array | undefined)[] = []
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
          if (bytes > maxBodyBytes) {
            const url = errorUrl(href, baseUrl, route)
            const error = new QbitApiError(
              'response_too_large',
              `HTTP ${response.status} reply from ${url} exceeded ${maxBodyBytes} bytes; its body was discarded`,
              { status: response.status, url }
            )
            // The catch below releases the body and rethrows the abort's reason.
            controller.abort(error)
            throw error
          }
          chunks.push(chunk.value)
        } catch (error) {
          if (!controller.signal.aborted) {
            failure = { error }
          } else {
            // A stall, a body past the limit or the caller's abort: the request is
            // aborted; release the body too.
            reader.cancel(controller.signal.reason).catch(() => undefined)
            throw controller.signal.reason
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
