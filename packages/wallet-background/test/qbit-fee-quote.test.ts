import { afterEach, describe, expect, it, vi } from 'vitest'

import { MempoolQbitClient, QbitApiError } from '@qbit-oss/api'
import {
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
  qbitFeeSummaryFromTiers,
  qbitUnavailableFeeSummary,
} from '../src/utils/qbit-api'
import { QBIT_EXPLORER_REPLY_TIMEOUT_MS } from '../src/utils/qbit-explorer-fetch'
import { FakeQbitExplorer, type FakeFailure } from './qbit-fake-explorer'

const BASE = 'https://explorer.test/api'

/** What the public explorers' `/fees/precise` answered on an empty mempool (#182). */
const EMPTY_MEMPOOL = {
  fastestFee: 1,
  halfHourFee: 0.5,
  hourFee: 0.25,
  economyFee: 0.25,
  minimumFee: 0.25,
}

const PRECISE = { method: 'GET', path: '/fees/precise' }
const RECOMMENDED = { method: 'GET', path: '/fees/recommended' }
const isPrecise = ({ path }: { path: string }) => path === '/fees/precise'
const isRecommended = ({ path }: { path: string }) => path === '/fees/recommended'

/** mempool-qbit whose `/fees/recommended` gives 2 bits/vB for every target. */
function mempoolQbit() {
  const explorer = new FakeQbitExplorer('mempool-qbit')
  explorer.feeRate = 2
  const client = new QbitWalletMempoolClient({ baseUrl: BASE, fetchFn: explorer.fetch })
  return { explorer, client }
}

const WHOLE_NUMBER_TIERS = [
  { target: 1, feeRate: 2 },
  { target: 2, feeRate: 2 },
  { target: 3, feeRate: 2 },
]

/** Advance fake time until `promise` settles; resolves to its outcome and the time it took. */
async function settle<T>(promise: Promise<T>, stepMs = 100, maxMs = 10 * 60_000) {
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

afterEach(() => {
  vi.useRealTimers()
})

describe('mempool-qbit fee quote from /fees/precise (#182)', () => {
  it('quotes rates below 1 bit/vB from one request to the precise endpoint', async () => {
    const { explorer, client } = mempoolQbit()
    explorer.preciseFees = EMPTY_MEMPOOL

    const tiers = await client.getFeeTiers()

    expect(tiers).toEqual([
      { target: 1, feeRate: 1 },
      { target: 2, feeRate: 0.5 },
      { target: 3, feeRate: 0.25 },
    ])
    expect(
      qbitFeeSummaryFromTiers(tiers, 'mempool-qbit', { freshness: 'live', fetchedAt: 5_000 })
    ).toEqual({
      list: [
        { title: 'Slow', desc: '~3 min (3 blocks)', feeRate: 0.25, targetBlocks: 3 },
        { title: 'Normal', desc: '~2 min (2 blocks)', feeRate: 0.5, targetBlocks: 2 },
        { title: 'Fast', desc: '~1 min (1 block)', feeRate: 1, targetBlocks: 1 },
      ],
      quote: {
        source: 'mempool-qbit',
        availability: 'available',
        freshness: 'live',
        fetchedAt: 5_000,
      },
    })
    expect(explorer.requests).toEqual([PRECISE])
  })

  it('reads the precise endpoint under the base URL the whole-number one uses', async () => {
    const urls: string[] = []
    const answer = (fees: unknown) => async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(JSON.stringify(fees), { status: 200 })
    }
    const baseUrl = 'https://explorer.test/api/v1'

    await new QbitWalletMempoolClient({ baseUrl, fetchFn: answer(EMPTY_MEMPOOL) }).getFeeTiers()
    // Every reply lacks hourFee, so the whole-number read follows, and fails too.
    const incomplete = answer({ fastestFee: 1, halfHourFee: 0.5 })
    await expect(
      new QbitWalletMempoolClient({ baseUrl, fetchFn: incomplete }).getFeeTiers()
    ).rejects.toMatchObject({ kind: 'parse' })

    expect(urls).toEqual([
      'https://explorer.test/api/v1/fees/precise',
      'https://explorer.test/api/v1/fees/precise',
      'https://explorer.test/api/v1/fees/recommended',
    ])
  })

  const body = (value: unknown) => ({ status: 200, body: JSON.stringify(value) })
  it.each([
    ['HTTP 404', { status: 404, body: 'not found' }],
    ['HTTP 500', { status: 500 }],
    ['a body that is not JSON', { status: 200, body: '{"fastestFee":1,' }],
    ['an array', body([1, 0.5, 0.25])],
    ['null', body(null)],
    ['a string', body('0.25')],
    ['a missing hourFee', body({ fastestFee: 1, halfHourFee: 0.5 })],
    ['a rate given as a string', body({ ...EMPTY_MEMPOOL, hourFee: '0.25' })],
    ['a rate of 0', body({ ...EMPTY_MEMPOOL, hourFee: 0 })],
    ['a negative rate', body({ ...EMPTY_MEMPOOL, halfHourFee: -0.5 })],
    ['a null rate', body({ ...EMPTY_MEMPOOL, halfHourFee: null })],
    [
      'a rate JSON reads as Infinity',
      { status: 200, body: '{"fastestFee":1e999,"halfHourFee":0.5,"hourFee":0.25}' },
    ],
    ['a rate above 10,000 bits/vB', body({ ...EMPTY_MEMPOOL, fastestFee: 10_000.01 })],
    ['a slower tier that costs more', body({ ...EMPTY_MEMPOOL, halfHourFee: 1.01 })],
  ])(
    'falls back to the whole-number tiers when the precise endpoint answers %s',
    async (_label, reply) => {
      const { explorer, client } = mempoolQbit()
      explorer.failures.push(request => (isPrecise(request) ? reply : undefined))

      await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)

      expect(explorer.requests).toEqual([PRECISE, RECOMMENDED])
    }
  )

  it('falls back when the precise read fails on the network', async () => {
    const { explorer, client } = mempoolQbit()
    explorer.failures.push(request =>
      isPrecise(request) ? new TypeError('fetch failed') : undefined
    )

    await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED])
  })

  it('falls back after the precise read’s own 5 s deadline, not the 15 s reply budget', async () => {
    vi.useFakeTimers()
    const { explorer, client } = mempoolQbit()
    explorer.slowResponses.push({
      match: isPrecise,
      chunkBytes: 1,
      intervalMs: 1,
      stallHeaders: true,
    })
    expect(QBIT_EXPLORER_REPLY_TIMEOUT_MS).toBe(15_000)

    const result = await settle(client.getFeeTiers())

    expect(result).toMatchObject({ value: WHOLE_NUMBER_TIERS })
    // One attempt, given up at 5 s, then the whole-number read, sent at once.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5_000)
    expect(result.elapsedMs).toBeLessThan(5_500)
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED])
    expect(explorer.abortedRequests).toEqual(['/fees/precise'])

    // A refresh a minute later, once the controller's quote has expired,
    // does not wait for the route again (see the cool-down below).
    await vi.advanceTimersByTimeAsync(60_000)
    const next = await settle(client.getFeeTiers())
    expect(next).toMatchObject({ value: WHOLE_NUMBER_TIERS })
    expect(next.elapsedMs).toBeLessThanOrEqual(100)
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED, RECOMMENDED])
  })

  it('leaves the rest of the caller’s deadline to the whole-number read', async () => {
    vi.useFakeTimers()
    const { explorer, client } = mempoolQbit()
    for (const match of [isPrecise, isRecommended]) {
      explorer.slowResponses.push({ match, chunkBytes: 1, intervalMs: 1, stallHeaders: true })
    }

    const result = await settle(client.getFeeTiers({ deadlineMs: 8_000 }))

    // The precise read is given up at 5 s and the whole-number read at the
    // caller's 8 s, the call's error.
    const error = (result as { error: QbitApiError }).error
    expect(QbitApiError.is(error)).toBe(true)
    expect({ kind: error.kind, message: error.message }).toEqual({
      kind: 'timeout',
      message: 'operation exceeded its 8000ms deadline',
    })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(8_000)
    expect(result.elapsedMs).toBeLessThan(8_200)
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED])
    expect(explorer.abortedRequests).toEqual(['/fees/precise', '/fees/recommended'])
  })

  it('tries the precise read once, while the whole-number read keeps its retries', async () => {
    vi.useFakeTimers()
    const { explorer, client } = mempoolQbit()
    let recommendedFailures = 2
    explorer.failures.push(request => {
      if (isPrecise(request)) return { status: 503 }
      if (isRecommended(request) && recommendedFailures > 0) {
        recommendedFailures -= 1
        return { status: 503 }
      }
      return undefined
    })

    const result = await settle(client.getFeeTiers())

    expect(result).toMatchObject({ value: WHOLE_NUMBER_TIERS })
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED, RECOMMENDED, RECOMMENDED])
  })

  it('rejects with the whole-number read’s own error when that fails too', async () => {
    const failing = () => {
      const { explorer, client } = mempoolQbit()
      explorer.failures.push(request =>
        isPrecise(request) || isRecommended(request) ? { status: 404, body: 'gone' } : undefined
      )
      return { explorer, client }
    }
    const reference = failing()
    // What the client's whole-number read alone rejects with, as before #182.
    const before = await MempoolQbitClient.prototype.getFeeTiers
      .call(reference.client)
      .catch(error => error)
    const { explorer, client } = failing()

    const error = await client.getFeeTiers().catch(caught => caught)

    expect(QbitApiError.is(before)).toBe(true)
    expect(error).toBeInstanceOf(QbitApiError)
    expect({ kind: error.kind, status: error.status, message: error.message }).toEqual({
      kind: before.kind,
      status: before.status,
      message: before.message,
    })
    expect(error).toMatchObject({ kind: 'not_found', status: 404 })
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED])
  })

  it('stops at the caller’s abort during the precise read, with no fallback request', async () => {
    vi.useFakeTimers()
    const { explorer, client } = mempoolQbit()
    explorer.slowResponses.push({
      match: isPrecise,
      chunkBytes: 1,
      intervalMs: 1,
      stallHeaders: true,
    })
    const caller = new AbortController()

    const outcome = client.getFeeTiers({ signal: caller.signal }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1_000)
    caller.abort()
    const error = await outcome
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(QbitApiError.is(error) && error.kind).toBe('aborted')
    expect(explorer.requests).toEqual([PRECISE])
    expect(explorer.abortedRequests).toEqual(['/fees/precise'])
  })

  it('sends nothing for a caller that aborted before the call', async () => {
    const { explorer, client } = mempoolQbit()
    const caller = new AbortController()
    caller.abort()

    const error = await client.getFeeTiers({ signal: caller.signal }).catch(caught => caught)

    expect(QbitApiError.is(error) && error.kind).toBe('aborted')
    expect(explorer.requests).toEqual([])
  })

  it('holds both reads to the caller’s one deadline', async () => {
    vi.useFakeTimers()
    // The precise read outlives the deadline: no fallback read follows.
    const stalled = mempoolQbit()
    stalled.explorer.slowResponses.push({
      match: isPrecise,
      chunkBytes: 1,
      intervalMs: 1,
      stallHeaders: true,
    })
    const first = await settle(stalled.client.getFeeTiers({ deadlineMs: 5_000 }))
    expect(QbitApiError.is((first as { error: unknown }).error)).toBe(true)
    expect((first as { error: QbitApiError }).error.kind).toBe('timeout')
    expect(first.elapsedMs).toBeLessThan(5_200)
    expect(stalled.explorer.requests).toEqual([PRECISE])

    // The precise read fails at once and the fallback stalls: the same
    // deadline ends the call, well before the reply budget of 15 s.
    const slowFallback = mempoolQbit()
    slowFallback.explorer.failures.push(request =>
      isPrecise(request) ? { status: 404 } : undefined
    )
    slowFallback.explorer.slowResponses.push({
      match: isRecommended,
      chunkBytes: 1,
      intervalMs: 1,
      stallHeaders: true,
    })
    const second = await settle(slowFallback.client.getFeeTiers({ deadlineMs: 5_000 }))
    expect((second as { error: QbitApiError }).error.kind).toBe('timeout')
    expect(second.elapsedMs).toBeLessThan(5_200)
    expect(slowFallback.explorer.requests).toEqual([PRECISE, RECOMMENDED])
  })

  it('never asks an Esplora explorer for precise rates', async () => {
    const explorer = new FakeQbitExplorer('esplora')
    explorer.feeRate = 0.5
    const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch })

    await expect(client.getFeeTiers()).resolves.toEqual([
      { target: 1, feeRate: 0.5 },
      { target: 6, feeRate: 0.5 },
      { target: 20, feeRate: 0.5 },
    ])
    expect(explorer.requests).toEqual([{ method: 'GET', path: '/fee-estimates' }])
  })
})

describe('the precise read’s cool-down after it fails (#182)', () => {
  /** The tiers of `EMPTY_MEMPOOL`. */
  const PRECISE_TIERS = [
    { target: 1, feeRate: 1 },
    { target: 2, feeRate: 0.5 },
    { target: 3, feeRate: 0.25 },
  ]

  /** Make the precise endpoint answer with `failure`, until the returned function is called. */
  function failPrecise(explorer: FakeQbitExplorer, failure: NonNullable<ReturnType<FakeFailure>>) {
    let failing = true
    explorer.failures.push(request => (failing && isPrecise(request) ? failure : undefined))
    return () => {
      failing = false
    }
  }

  /** A mempool-qbit client whose precise endpoint answers `EMPTY_MEMPOOL`. */
  function preciseMempoolQbit() {
    const quote = mempoolQbit()
    quote.explorer.preciseFees = EMPTY_MEMPOOL
    return quote
  }

  const body = (value: unknown) => ({ status: 200, body: JSON.stringify(value) })
  it.each([
    ['HTTP 404', { status: 404, body: 'not found' }],
    ['HTTP 429', { status: 429, body: 'Too Many Requests' }],
    ['HTTP 503', { status: 503 }],
    ['a body that is not JSON', { status: 200, body: '{"fastestFee":1,' }],
    ['a missing hourFee', body({ fastestFee: 1, halfHourFee: 0.5 })],
    ['tiers that make no available quote', body({ ...EMPTY_MEMPOOL, halfHourFee: 1.01 })],
    ['a network failure', new TypeError('fetch failed')],
  ] as const)(
    'reads only the whole-number tiers on a refresh after the precise endpoint gave %s',
    async (_label, failure) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_000_000)
      const { explorer, client } = preciseMempoolQbit()
      failPrecise(explorer, failure)

      await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)
      expect(explorer.requests).toEqual([PRECISE, RECOMMENDED])

      // The next refresh, once the controller's 60 s quote has expired.
      vi.setSystemTime(1_060_000)
      await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)
      expect(explorer.requests).toEqual([PRECISE, RECOMMENDED, RECOMMENDED])
    }
  )

  it('tries the precise read again once 10 minutes have passed since it failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const { explorer, client } = preciseMempoolQbit()
    const recover = failPrecise(explorer, { status: 404, body: 'not found' })
    const paths = () => explorer.requests.map(request => request.path)

    await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)
    vi.setSystemTime(1_599_999)
    await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)
    expect(paths()).toEqual(['/fees/precise', '/fees/recommended', '/fees/recommended'])

    // At 10 minutes the precise read is sent again; it fails again, and so
    // starts a new cool-down.
    vi.setSystemTime(1_600_000)
    await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)
    vi.setSystemTime(2_199_999)
    await expect(client.getFeeTiers()).resolves.toEqual(WHOLE_NUMBER_TIERS)
    expect(paths().slice(3)).toEqual(['/fees/precise', '/fees/recommended', '/fees/recommended'])

    // Once the route answers, every refresh reads it first again.
    recover()
    vi.setSystemTime(2_200_000)
    await expect(client.getFeeTiers()).resolves.toEqual(PRECISE_TIERS)
    vi.setSystemTime(2_260_000)
    await expect(client.getFeeTiers()).resolves.toEqual(PRECISE_TIERS)
    expect(paths().slice(6)).toEqual(['/fees/precise', '/fees/precise'])
  })

  it('ends the cool-down once a precise read succeeds', async () => {
    vi.useFakeTimers()
    const { explorer, client } = preciseMempoolQbit()
    // The reply's headers come at once and its 600-byte body over 6 s.
    explorer.slowResponses.push({
      match: isPrecise,
      chunkBytes: 10,
      intervalMs: 100,
      padToBytes: 600,
    })
    const outcomes: { first?: unknown; second?: unknown } = {}

    void client.getFeeTiers().then(tiers => (outcomes.first = tiers))
    await vi.advanceTimersByTimeAsync(2_000)
    // Joins the first call's request, which is still in flight, with 5 s of its own.
    void client.getFeeTiers().then(tiers => (outcomes.second = tiers))
    // At 5 s the first call gives the precise read up, which starts a
    // cool-down, and quotes the whole-number tiers.
    await vi.advanceTimersByTimeAsync(3_100)
    expect(outcomes).toEqual({ first: WHOLE_NUMBER_TIERS })
    // At 6 s the reply is complete, and the second call quotes it.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(outcomes).toEqual({ first: WHOLE_NUMBER_TIERS, second: PRECISE_TIERS })
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED])

    // That success ended the cool-down: the next refresh reads the route.
    explorer.slowResponses = []
    const next = await settle(client.getFeeTiers())
    expect(next).toMatchObject({ value: PRECISE_TIERS })
    expect(explorer.requests).toEqual([PRECISE, RECOMMENDED, PRECISE])
  })

  it('starts no cool-down when the caller ends the call during the precise read', async () => {
    vi.useFakeTimers()
    const { explorer, client } = preciseMempoolQbit()
    explorer.slowResponses.push({
      match: isPrecise,
      chunkBytes: 1,
      intervalMs: 1,
      stallHeaders: true,
    })

    // The caller's abort, at 1 s.
    const caller = new AbortController()
    const aborted = client.getFeeTiers({ signal: caller.signal }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1_000)
    caller.abort()
    const abortError = await aborted
    expect(QbitApiError.is(abortError) && abortError.kind).toBe('aborted')

    // The caller's own deadline, 3 s, shorter than the precise read's 5 s.
    const timedOut = await settle(client.getFeeTiers({ deadlineMs: 3_000 }))
    const timeoutError = (timedOut as { error: QbitApiError }).error
    expect({ kind: timeoutError.kind, message: timeoutError.message }).toEqual({
      kind: 'timeout',
      message: 'operation exceeded its 3000ms deadline',
    })
    expect(timedOut.elapsedMs).toBeGreaterThanOrEqual(3_000)
    expect(timedOut.elapsedMs).toBeLessThan(3_200)
    // Neither call read the whole-number tiers.
    expect(explorer.requests).toEqual([PRECISE, PRECISE])

    // Nor did either start a cool-down: the next refresh reads the route.
    explorer.slowResponses = []
    const next = await settle(client.getFeeTiers())
    expect(next).toMatchObject({ value: PRECISE_TIERS })
    expect(explorer.requests).toEqual([PRECISE, PRECISE, PRECISE])
  })

  it('keeps a cool-down to the client whose precise read failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const failed = preciseMempoolQbit()
    failPrecise(failed.explorer, { status: 404, body: 'not found' })
    await failed.client.getFeeTiers()
    const other = preciseMempoolQbit()

    vi.setSystemTime(1_060_000)
    await expect(other.client.getFeeTiers()).resolves.toEqual(PRECISE_TIERS)
    expect(other.explorer.requests).toEqual([PRECISE])
  })
})

describe('qbit fee tiers as the wallet quotes them (#182)', () => {
  /** Esplora tiers for targets 2, 6 and 20, fastest first. */
  const esplora = (fast: number, normal: number, slow: number) => [
    { target: 2, feeRate: fast },
    { target: 6, feeRate: normal },
    { target: 20, feeRate: slow },
  ]
  const rates = (summary: ReturnType<typeof qbitFeeSummaryFromTiers>) =>
    summary.list.map(tier => tier.feeRate)

  it('keeps a rate given in hundredths of a bit/vB as it is', () => {
    // Multiplying by 100 and rounding up would move 0.28, 0.55, 1.1 and 2.2.
    for (const feeRate of [0.25, 0.28, 0.29, 0.55, 1, 1.1, 1.15, 2.2, 3, 9.99, 10_000]) {
      const summary = qbitFeeSummaryFromTiers(esplora(feeRate, feeRate, feeRate))
      expect(summary.quote?.availability).toBe('available')
      expect(rates(summary)).toEqual([feeRate, feeRate, feeRate])
    }
  })

  it('rounds any other rate up to the next hundredth of a bit/vB', () => {
    for (const [feeRate, quoted] of [
      [0.251, 0.26],
      [0.2501, 0.26],
      [0.259, 0.26],
      [1.001, 1.01],
      [1.0000001, 1.01],
      [2.345, 2.35],
      [9_999.991, 10_000],
    ] as const) {
      const summary = qbitFeeSummaryFromTiers(esplora(feeRate, feeRate, feeRate))
      expect(summary.quote?.availability).toBe('available')
      expect(rates(summary)).toEqual([quoted, quoted, quoted])
    }
  })

  it('raises a positive rate below the 0.25 bits/vB relay floor to it', () => {
    expect(rates(qbitFeeSummaryFromTiers(esplora(0.5, 0.24, 0.07)))).toEqual([0.25, 0.25, 0.5])
    expect(rates(qbitFeeSummaryFromTiers(esplora(0.001, 0.001, 0.0000001)))).toEqual([
      0.25, 0.25, 0.25,
    ])
  })

  it('checks the ceiling on the rate as the provider sent it', () => {
    expect(rates(qbitFeeSummaryFromTiers(esplora(10_000, 1, 1)))).toEqual([1, 1, 10_000])
    expect(qbitFeeSummaryFromTiers(esplora(10_000.001, 1, 1)).quote).toMatchObject({
      availability: 'unavailable',
      fallbackReason: 'invalid',
    })
  })

  it('compares tiers once rounded: rates that round to one hundredth are equal', () => {
    // 0.255 costs more than 0.251 as sent; both are quoted as 0.26.
    const equal = qbitFeeSummaryFromTiers(esplora(0.251, 0.255, 0.252))
    expect(equal.quote?.availability).toBe('available')
    expect(rates(equal)).toEqual([0.26, 0.26, 0.26])
    // 0.261 is still quoted above 0.26: the slower target costs more.
    expect(qbitFeeSummaryFromTiers(esplora(0.251, 0.261, 0.25)).quote).toMatchObject({
      availability: 'unavailable',
      fallbackReason: 'invalid',
    })
  })

  it('quotes whole-number tiers exactly as before', () => {
    expect(
      qbitFeeSummaryFromTiers(
        [
          { target: 3, feeRate: 1 },
          { target: 2, feeRate: 3 },
          { target: 1, feeRate: 9 },
        ],
        'mempool-qbit'
      ).list.map(tier => tier.feeRate)
    ).toEqual([1, 3, 9])
  })

  it('prices every tier at 1 bit/vB without an estimate, not at the 0.25 floor', () => {
    for (const surface of ['esplora', 'mempool-qbit'] as const) {
      const summary = qbitUnavailableFeeSummary(surface, 'unavailable')
      expect(rates(summary)).toEqual([1, 1, 1])
      expect(summary.quote).toEqual({
        source: surface,
        availability: 'unavailable',
        freshness: 'fallback',
        fallbackReason: 'unavailable',
      })
    }
    expect(rates(qbitFeeSummaryFromTiers([]))).toEqual([1, 1, 1])
    expect(rates(qbitFeeSummaryFromTiers(esplora(0, 1, 1)))).toEqual([1, 1, 1])
  })
})
