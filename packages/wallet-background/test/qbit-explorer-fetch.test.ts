import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import {
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
  getQbitAccountHistory,
} from '../src/utils/qbit-api'
import { classifyQbitBroadcastError } from '../src/utils/qbit-broadcast'
import {
  QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS,
  QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS,
  QBIT_EXPLORER_HEADERS_TIMEOUT_MS,
  QBIT_EXPLORER_MAX_BODY_BYTES,
  QBIT_EXPLORER_REPLY_TIMEOUT_MS,
} from '../src/utils/qbit-explorer-fetch'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

const BASE = 'https://explorer.test/api'
const address = 'tq1zslowlink'
const script = `5220${'aa'.repeat(32)}`
const payer = 'tq1zslowpayer'
const payerScript = `5220${'bb'.repeat(32)}`
// What one P2MR input carries in the explorer's JSON.
const P2MR_INPUT_WITNESS_HEX = 7_400
const INPUTS_PER_TX = 16
// About a 1 Mbit/s link.
const SLOW_LINK = { chunkBytes: 128 * 1024, intervalMs: 1_000 }
const MB = 1024 * 1024

const isHistoryPage = ({ path }: { path: string }) => /\/txs(\/chain|\?|$)/.test(path)

/**
 * An address paid by 50 consolidations of 16 inputs each, so one history
 * page of them is several MB of witness hex.
 */
function consolidatedExplorer(surface: 'esplora' | 'mempool-qbit') {
  const explorer = new FakeQbitExplorer(surface)
  explorer.inputWitnessHexLength = P2MR_INPUT_WITNESS_HEX
  explorer.registerAddress(address, script)
  const funding = explorer.addTx({
    txid: fakeTxid(0, 9_000_000),
    inputs: [{ txid: fakeTxid(1, 9_000_000), vout: 0 }],
    outputs: Array.from({ length: 50 * INPUTS_PER_TX }, () => ({
      address: payer,
      script: payerScript,
      value: 1_000,
    })),
    height: 50,
  })
  for (let index = 0; index < 50; index += 1) {
    explorer.addTx({
      txid: fakeTxid(index),
      inputs: Array.from({ length: INPUTS_PER_TX }, (_, input) => ({
        txid: funding.txid,
        vout: index * INPUTS_PER_TX + input,
      })),
      outputs: [{ address, script, value: 15_000 }],
      height: 100 + index,
    })
  }
  return explorer
}

/** Advance fake time until `promise` settles; resolves to its outcome and the time it took. */
async function settle<T>(promise: Promise<T>, stepMs = 100, maxMs = 30 * 60_000) {
  const startedAt = Date.now()
  let outcome: { value: T } | { error: unknown } | undefined
  promise.then(
    value => (outcome = { value }),
    error => (outcome = { error })
  )
  while (outcome === undefined && Date.now() - startedAt < maxMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  if (outcome === undefined) throw new Error(`still pending after ${maxMs}ms`)
  return { ...outcome, elapsedMs: Date.now() - startedAt }
}

function expectTimeout(error: unknown) {
  expect(QbitApiError.is(error)).toBe(true)
  expect((error as QbitApiError).kind).toBe('timeout')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('explorer reads over a slow link (#353)', () => {
  for (const surface of ['esplora', 'mempool-qbit'] as const) {
    it(`loads the account history when a multi-MB ${surface} page takes longer than 15 s`, async () => {
      const explorer = consolidatedExplorer(surface)
      explorer.slowResponses.push({ match: isHistoryPage, ...SLOW_LINK })
      // As the wallet controller builds its clients: the base URL only, over the global fetch.
      vi.stubGlobal('fetch', explorer.fetch)
      const client =
        surface === 'esplora'
          ? new QbitWalletEsploraClient({ baseUrl: BASE })
          : new QbitWalletMempoolClient({ baseUrl: BASE })

      const result = await settle(getQbitAccountHistory(client, [address], { start: 0, limit: 50 }))

      expect(result).not.toHaveProperty('error')
      const history = (result as { value: Awaited<ReturnType<typeof getQbitAccountHistory>> }).value
      expect(history.total).toBe(50)
      expect(history.detail).toHaveLength(50)
      // Each history page arrived once, slower than the former 15 s attempt budget.
      const pageBytes = JSON.stringify(
        explorer
          .history(address)
          .slice(0, surface === 'esplora' ? 25 : 50)
          .map(tx => explorer.esploraTx(tx))
      ).length
      expect(pageBytes).toBeGreaterThan(2.5 * MB)
      expect((pageBytes / SLOW_LINK.chunkBytes) * SLOW_LINK.intervalMs).toBeGreaterThan(
        QBIT_EXPLORER_HEADERS_TIMEOUT_MS
      )
      expect(explorer.releasedBodies).toEqual([])
      expect(explorer.abortedRequests).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })
  }

  it('reads a consolidation transaction that takes longer than 15 s', async () => {
    const explorer = consolidatedExplorer('esplora')
    const txid = fakeTxid(0)
    explorer.slowResponses.push({
      match: ({ path }) => path === `/tx/${txid}`,
      chunkBytes: 4 * 1024,
      intervalMs: 1_000,
    })
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    const result = await settle(client.getTx(txid))

    expect(result).toMatchObject({ value: { txid } })
    expect(result.elapsedMs).toBeGreaterThan(QBIT_EXPLORER_REPLY_TIMEOUT_MS)
  })

  it('aborts and releases a page whose body stalls, once no bytes arrive for the idle budget', async () => {
    const explorer = consolidatedExplorer('mempool-qbit')
    explorer.slowResponses.push({ match: isHistoryPage, ...SLOW_LINK, stallAfterBytes: 1 * MB })
    const client = new QbitWalletMempoolClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    const result = await settle(client.getAddressHistoryPage(address))

    expect(result).toHaveProperty('error')
    const error = (result as { error: unknown }).error
    expectTimeout(error)
    expect(error).toMatchObject({ status: 200 })
    expect((error as Error).message).toContain(
      `no response body bytes for ${QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS}ms`
    )
    // Three attempts, each cut QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS after its
    // last byte, long before the attempt ceiling.
    const sendMs = (MB / SLOW_LINK.chunkBytes) * SLOW_LINK.intervalMs
    expect(result.elapsedMs).toBeGreaterThanOrEqual(
      3 * (sendMs + QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS)
    )
    expect(result.elapsedMs).toBeLessThan(QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS)
    const page = `/address/${address}/txs`
    expect(explorer.requests.filter(isHistoryPage)).toHaveLength(3)
    expect(explorer.releasedBodies).toEqual([page, page, page])
    expect(explorer.abortedRequests).toEqual([page, page, page])
  })

  it('aborts a request whose headers never arrive at the headers budget', async () => {
    const explorer = consolidatedExplorer('esplora')
    explorer.slowResponses.push({ match: isHistoryPage, ...SLOW_LINK, stallHeaders: true })
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    const result = await settle(client.getAddressHistoryPage(address))

    const error = (result as { error: unknown }).error
    expectTimeout(error)
    expect((error as Error).message).toContain(
      `no response headers within ${QBIT_EXPLORER_HEADERS_TIMEOUT_MS}ms`
    )
    // The base URL's path is not named, since it can carry an API token; the route is.
    expect((error as QbitApiError).url).toBe(
      `https://explorer.test/.../address/${address}/txs/chain`
    )
    expect(result.elapsedMs).toBeGreaterThanOrEqual(3 * QBIT_EXPLORER_HEADERS_TIMEOUT_MS)
    // Plus the client's two backoffs (300 ms, 600 ms).
    expect(result.elapsedMs).toBeLessThan(3 * QBIT_EXPLORER_HEADERS_TIMEOUT_MS + 2_000)
    expect(explorer.abortedRequests).toHaveLength(3)
  })

  for (const [label, extra] of [
    ['by default', {}],
    ['when timeoutMs is passed as undefined', { timeoutMs: undefined }],
  ] as const) {
    it(`stops a body that trickles in just inside the idle budget at the attempt ceiling ${label}`, async () => {
      const explorer = consolidatedExplorer('esplora')
      explorer.slowResponses.push({
        match: isHistoryPage,
        chunkBytes: 1_024,
        intervalMs: QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS - 1_000,
      })
      const client = new QbitWalletEsploraClient({
        baseUrl: BASE,
        fetchFn: explorer.fetch,
        ...(extra as { timeoutMs?: number }),
      })

      const result = await settle(client.getAddressHistoryPage(address), 1_000)

      expectTimeout((result as { error: unknown }).error)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(3 * QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS)
      expect(result.elapsedMs).toBeLessThan(3 * QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS + 5_000)
      expect(explorer.releasedBodies).toHaveLength(3)
    })
  }

  it('reports a body cut off by a reset as the client always has: parse, with its status, not retried', async () => {
    const explorer = consolidatedExplorer('mempool-qbit')
    explorer.slowResponses.push({ match: isHistoryPage, ...SLOW_LINK, resetAfterBytes: 1 * MB })
    const client = new QbitWalletMempoolClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    const result = await settle(client.getAddressHistoryPage(address))

    expect((result as { error: unknown }).error).toMatchObject({ kind: 'parse', status: 200 })
    expect(explorer.requests.filter(isHistoryPage)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a slow body as soon as the caller aborts the read', async () => {
    const explorer = consolidatedExplorer('mempool-qbit')
    explorer.slowResponses.push({ match: isHistoryPage, ...SLOW_LINK })
    const client = new QbitWalletMempoolClient({ baseUrl: BASE, fetchFn: explorer.fetch })
    const caller = new AbortController()

    const outcome = client.getAddressHistory(address, { signal: caller.signal }).catch(e => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(explorer.requests.filter(isHistoryPage)).toHaveLength(1)
    caller.abort()
    const error = await outcome
    await vi.advanceTimersByTimeAsync(0)

    expect(QbitApiError.is(error) && error.kind).toBe('aborted')
    const page = `/address/${address}/txs`
    expect(explorer.releasedBodies).toEqual([page])
    expect(explorer.abortedRequests).toEqual([page])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the 15 s budget, headers and body together, for a small reply that trickles', async () => {
    const explorer = consolidatedExplorer('esplora')
    explorer.slowResponses.push({
      match: ({ path }) => path === '/blocks/tip/height',
      chunkBytes: 1,
      intervalMs: 5_000,
    })
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    const result = await settle(client.getTipHeight())

    const error = (result as { error: unknown }).error
    expectTimeout(error)
    expect((error as Error).message).toContain(
      `no complete reply within ${QBIT_EXPLORER_REPLY_TIMEOUT_MS}ms`
    )
    expect(result.elapsedMs).toBeGreaterThanOrEqual(3 * QBIT_EXPLORER_REPLY_TIMEOUT_MS)
    expect(result.elapsedMs).toBeLessThan(3 * QBIT_EXPLORER_REPLY_TIMEOUT_MS + 2_000)
    expect(explorer.releasedBodies).toHaveLength(3)
  })

  it('hides the host when the base URL has an @ after its authority', async () => {
    const explorer = consolidatedExplorer('esplora')
    explorer.slowResponses.push({ match: () => true, ...SLOW_LINK, stallHeaders: true })
    const client = new QbitWalletEsploraClient({
      baseUrl: 'https://apikey:8443/x@explorer.test/api',
      fetchFn: explorer.fetch,
    })

    const result = await settle(client.getTipHeight())

    const error = (result as { error: unknown }).error
    expectTimeout(error)
    expect((error as QbitApiError).url).toBe('.../blocks/tip/height')
    expect((error as Error).message).not.toContain('apikey')
  })

  it('fails a body longer than the buffer limit as unreadable, and releases it', async () => {
    // 1 MiB chunks of one shared buffer, without end.
    const chunk = new Uint8Array(MB)
    let sentBytes = 0
    let cancelled = false
    let signal: AbortSignal | undefined
    const endless = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          sentBytes += chunk.byteLength
          stream.enqueue(chunk)
        },
        cancel() {
          cancelled = true
        },
      })
      const response = new Response(body, { status: 200 })
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    })
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: endless })

    const error = await client.getAddressHistoryPage(address).catch(e => e)

    expect(error).toMatchObject({ kind: 'parse', status: 200 })
    expect(endless).toHaveBeenCalledTimes(1)
    expect(sentBytes).toBeGreaterThan(QBIT_EXPLORER_MAX_BODY_BYTES)
    expect(sentBytes).toBeLessThanOrEqual(QBIT_EXPLORER_MAX_BODY_BYTES + 3 * MB)
    expect(cancelled).toBe(true)
    expect(signal?.aborted).toBe(true)
  })

  it("keeps the client's own error when there is no fetch at all", () => {
    vi.stubGlobal('fetch', undefined)

    expect(() => new QbitWalletEsploraClient({ baseUrl: BASE })).toThrow(
      'no fetch implementation available'
    )
  })

  it("keeps the client's own error for a missing base URL", () => {
    expect(() => new QbitWalletMempoolClient({ baseUrl: undefined as unknown as string })).toThrow(
      'EsploraClient requires a baseUrl'
    )
  })

  it('still refuses a redirect', async () => {
    const explorer = consolidatedExplorer('esplora')
    explorer.failures.push(({ path }) =>
      path === '/blocks/tip/height' ? { status: 302 } : undefined
    )
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    await expect(client.getTipHeight()).rejects.toMatchObject({ kind: 'http', status: 302 })
  })
})

describe('explorer submissions keep their outcome classification (#353)', () => {
  it('reports a reply that stalls after its headers as an unknown outcome, sent once', async () => {
    const explorer = new FakeQbitExplorer('esplora')
    explorer.slowResponses.push({
      match: ({ method }) => method === 'POST',
      ...SLOW_LINK,
      stallAfterBytes: 0,
    })
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    const result = await settle(client.broadcastTx('00'))

    const error = (result as { error: unknown }).error
    expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
    // Reported to the user as a timeout, as when the client's own timer fired.
    expect(classifyQbitBroadcastError(error)).toMatchObject({
      reason: 'timeout',
      definitiveRejection: false,
    })
    expect(result.elapsedMs).toBeLessThan(QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS + 1_000)
    expect(explorer.requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(explorer.releasedBodies).toEqual(['/tx'])
  })

  it('retries a 429 whose body stalls, since nothing was submitted', async () => {
    const explorer = new FakeQbitExplorer('esplora')
    explorer.failures.push(({ method }) =>
      method === 'POST' ? { status: 429, body: 'slow down' } : undefined
    )
    explorer.slowResponses.push({
      match: ({ method }) => method === 'POST',
      ...SLOW_LINK,
      stallAfterBytes: 0,
    })
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    const result = await settle(client.broadcastTx('00'))

    const error = (result as { error: unknown }).error
    expect(QbitApiError.is(error) && error.kind).toBe('rate_limit')
    expect(explorer.requests.filter(request => request.method === 'POST')).toHaveLength(3)
    // Each stalled 429 is let go at the idle budget, not the attempt ceiling.
    expect(result.elapsedMs).toBeLessThan(3 * (QBIT_EXPLORER_BODY_IDLE_TIMEOUT_MS + 1_000))
    expect(explorer.releasedBodies).toEqual(['/tx', '/tx', '/tx'])
  })
})
