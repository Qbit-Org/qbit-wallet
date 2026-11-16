import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { QbitApiError, type RequestOptions } from '@qbit-oss/api'
import {
  QBIT_BALANCE_READ_DEADLINE_MS,
  QbitWalletEsploraClient,
  getQbitAddressUtxos,
  getQbitAddressUtxosClassified,
  getQbitAddressUtxosClassifiedPastLimit,
  getQbitSpendableBalanceV2,
  readQbitAddressUtxos,
  readQbitAddressUtxosRidingOut,
} from '../src/utils/qbit-api'
import {
  QBIT_CLASSIFY_MAX_READS_IN_FLIGHT,
  QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT,
  QBIT_LISTING_RETRY_STATUSES,
  QBIT_LOOKUP_RETRY_STATUSES,
  QbitFundingTxReads,
  isQbitRideOutFailure,
  isQbitServerError,
} from '../src/utils/qbit-funding-tx-reads'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The real explorer client, through the wallet's own fetch, over an explorer
// served over fetch, which answers chosen requests with a server error page.
const BASE = 'https://explorer.test/api'
const OUTPUT_VALUE = 10_000
const txPath = (txid: string): string => `/tx/${txid}`

/** Cloudflare's page for a 502 its origin could not answer. */
const BAD_GATEWAY_PAGE =
  '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>'

/**
 * A `Retry-After` past the client's cap (`maxRetryAfterMs`, 30 s): the client
 * then hands the reply back at once rather than wait, which is how a lookup
 * ended on the explorer's 502 with no second request. A reply without one
 * the client retries twice by itself.
 */
const PAST_THE_CLIENT_CAP = '120'

function account(pubkeyByte: string) {
  const pubkey = hexToBytes(pubkeyByte.repeat(32))
  const script = bytesToHex(
    p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pubkey)))
  )
  return { address: p2mrAddressFromPubkey(pubkey, 'testnet4'), script }
}

const main = account('11')
const address = main.address
const listing = `/address/${address}/utxo`

/**
 * `explorer` with `count` payments to `holder`, each its own transaction,
 * younger than a coinbase must be to mature: every read of outputs reads
 * each one's transaction, and so does the balance.
 */
function fund(
  explorer: FakeQbitExplorer,
  holder: { address: string; script: string },
  count: number,
  salt = 0
): void {
  explorer.registerAddress(holder.address, holder.script)
  for (let index = 0; index < count; index += 1) {
    explorer.addTx({
      txid: fakeTxid(index, salt),
      inputs: [{ txid: fakeTxid(index, salt + 5_000_000), vout: 0 }],
      outputs: [{ address: holder.address, script: holder.script, value: OUTPUT_VALUE }],
      height: explorer.tipHeight - 600,
    })
  }
}

function accountExplorer(count: number): FakeQbitExplorer {
  const explorer = new FakeQbitExplorer()
  explorer.utxoLimit = 50_000
  fund(explorer, main, count)
  return explorer
}

/**
 * The fetch the client is handed: `explorer`'s, but a request `answers`
 * picks, by its path and how many requests that path has had, gets the
 * status it names with the error page, and `retryAfter` unless it is null,
 * `delayMs` after it was made.
 */
function serverErrors(
  explorer: FakeQbitExplorer,
  answers: (path: string, nth: number) => number | undefined,
  retryAfter: string | null = PAST_THE_CLIENT_CAP,
  delayMs = 0
) {
  const seen = new Map<string, number>()
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`
    const nth = (seen.get(path) ?? 0) + 1
    seen.set(path, nth)
    const status = answers(path, nth)
    if (status === undefined) return explorer.fetch(input, init)
    explorer.requests.push({ method: init?.method ?? 'GET', path })
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    return new Response(status === 502 ? BAD_GATEWAY_PAGE : `HTTP ${status}`, {
      status,
      headers: {
        'content-type': 'text/html',
        ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
      },
    })
  }
}

const requestsOf = (explorer: FakeQbitExplorer, path: string): number =>
  explorer.requests.filter(request => request.path === path).length

/**
 * A burst of the explorer's 502s, for `serverErrors`: every request a path
 * `hit` picks gets one while the faked clock is `fromMs` to `toMs` past the
 * burst's making. `answered` counts, by path, the requests it answered.
 */
function burst(hit: (path: string) => boolean, fromMs: number, toMs: number) {
  const start = Date.now()
  const answered = new Map<string, number>()
  return {
    answered,
    answers: (path: string): number | undefined => {
      const at = Date.now() - start
      if (!hit(path) || at < fromMs || at >= toMs) return undefined
      answered.set(path, (answered.get(path) ?? 0) + 1)
      return 502
    },
  }
}

const isLookup = (path: string): boolean => path.startsWith('/tx/')

/** Every lookup answered after 100 ms, so a read runs on through a burst. */
const LOOKUPS_TAKE_100_MS = {
  match: (request: { path: string }) => isLookup(request.path),
  chunkBytes: 1 << 20,
  intervalMs: 100,
}

/** A read's outcome, once it has one, without awaiting it, and when it settled (`at`, in ms). */
function track<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: unknown; at?: number } = {
    settled: false,
  }
  const start = Date.now()
  promise.then(
    value => Object.assign(outcome, { settled: true, value, at: Date.now() - start }),
    error => Object.assign(outcome, { settled: true, error, at: Date.now() - start })
  )
  return outcome
}

/** Run the faked clock on until `outcome` has settled, or for two minutes. */
async function untilSettled(outcome: { settled: boolean }): Promise<void> {
  for (let spent = 0; !outcome.settled && spent < 120_000; spent += 100) {
    await vi.advanceTimersByTimeAsync(100)
  }
}

/** The send screen's read of outputs, the one read that rides out server errors. */
const ridingOut = (
  client: QbitWalletEsploraClient,
  target: string,
  options: Parameters<typeof readQbitAddressUtxosRidingOut>[2] = {}
) => readQbitAddressUtxosRidingOut(client, target, options).then(read => read.utxos)

/**
 * The client over `fetchFn`, with the transaction lookups it has in flight
 * counted, and for each lookup started, how many others were in flight then.
 */
function countedClient(fetchFn: typeof fetch, options: { retryBaseDelayMs?: number } = {}) {
  const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn, ...options })
  const lookups = { inFlight: 0, peak: 0, othersAtStart: new Map<string, number[]>() }
  const getTx = client.getTx.bind(client)
  client.getTx = ((txid: string, request?: RequestOptions) => {
    const started = lookups.othersAtStart.get(txid) ?? []
    started.push(lookups.inFlight)
    lookups.othersAtStart.set(txid, started)
    lookups.peak = Math.max(lookups.peak, ++lookups.inFlight)
    return getTx(txid, request).finally(() => {
      lookups.inFlight -= 1
    })
  }) as typeof client.getTx
  return { client, lookups }
}

const balanceOf = (client: QbitWalletEsploraClient) =>
  getQbitSpendableBalanceV2(client, address, main.script, undefined, undefined, {
    fundingTxReads: new QbitFundingTxReads(),
  })

/** A balance read's answer with the split unknown; `failed` when it got no further. */
const incomplete = (count: number, failed: boolean) => ({
  availableBalance: null,
  unavailableBalance: count * OUTPUT_VALUE,
  totalBalance: count * OUTPUT_VALUE,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  ...(failed ? { utxoReadFailed: true } : {}),
})

describe('a lookup the explorer answers with a server error, in the read that rides them out (#209)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads it again: one 502 among 5,000 lookups costs one more request', async () => {
    const explorer = accountExplorer(5_000)
    const victim = txPath(fakeTxid(2_500))
    const { client, lookups } = countedClient(
      serverErrors(explorer, (path, nth) => (path === victim && nth === 1 ? 502 : undefined))
    )
    const fundingTxReads = new QbitFundingTxReads()

    const utxos = await ridingOut(client, address, { fundingTxReads })

    expect(utxos).toHaveLength(5_000)
    expect(requestsOf(explorer, victim)).toBe(2)
    expect(requestsOf(explorer, txPath(fakeTxid(2_501)))).toBe(1)
    // Its burst at the bound, which the retry keeps to.
    expect(lookups.peak).toBe(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
  })

  it.each([500, 503, 504])('reads a lookup answered %i again too', async status => {
    const explorer = accountExplorer(50)
    const victim = txPath(fakeTxid(25))
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === victim && nth === 1 ? status : undefined))
    )

    const utxos = await ridingOut(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    expect(utxos).toHaveLength(50)
    expect(requestsOf(explorer, victim)).toBe(2)
  })

  it('fails as before with that error once a lookup is answered 502 five times', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(300)
    const victim = fakeTxid(150)
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === txPath(victim) && nth <= 5 ? 502 : undefined))
    )

    const outcome = ridingOut(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    }).catch((caught: unknown) => caught)
    await vi.advanceTimersByTimeAsync(500 + 1_500 + 4_000 + 8_000)
    const error = await outcome

    expect(error).toMatchObject({ kind: 'http', status: 502 })
    expect((error as Error).message).toContain(`HTTP 502 from`)
    expect((error as Error).message).toContain(txPath(victim))
    // Four more attempts, no more.
    expect(requestsOf(explorer, txPath(victim))).toBe(5)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads every lookup of a 502 burst again in the slot it holds, never more in flight than the bound', async () => {
    // Two mid-sized accounts through one shared reader, each a burst: their
    // reads together wait for every slot that frees.
    const explorer = accountExplorer(1_000)
    const other = account('22')
    fund(explorer, other, 1_000, 3_000_000)
    // Every lookup takes 100 ms, so the reads run on while the burst pauses.
    explorer.slowResponses.push({
      match: request => request.path.startsWith('/tx/'),
      chunkBytes: 1 << 20,
      intervalMs: 100,
    })
    // The first 100 lookups of the account, at once.
    const victims = new Set(Array.from({ length: 100 }, (_, index) => txPath(fakeTxid(index))))
    const { client, lookups } = countedClient(
      serverErrors(explorer, (path, nth) => (victims.has(path) && nth === 1 ? 502 : undefined))
    )
    const fundingTxReads = new QbitFundingTxReads()

    const [mine, theirs] = await Promise.all([
      ridingOut(client, address, { fundingTxReads }),
      ridingOut(client, other.address, { fundingTxReads }),
    ])

    expect(mine).toHaveLength(1_000)
    expect(theirs).toHaveLength(1_000)
    for (const victim of victims) expect(requestsOf(explorer, victim), victim).toBe(2)
    expect(lookups.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    // Each read again in the slot it held through its pause.
    const othersAtRetry = [...victims].map(
      victim => lookups.othersAtStart.get(victim.slice('/tx/'.length))![1]!
    )
    expect(Math.max(...othersAtRetry)).toBeLessThan(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
  })

  it('reads it again in the slot it held, before a read waiting for that slot starts', async () => {
    const explorer = accountExplorer(1)
    const other = account('22')
    fund(explorer, other, 1, 3_000_000)
    const mine = txPath(fakeTxid(0))
    const theirs = txPath(fakeTxid(0, 3_000_000))
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === mine && nth === 1 ? 502 : undefined))
    )
    // One slot: the other account's lookup waits for it.
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 1 })

    const first = ridingOut(client, address, { fundingTxReads })
    while (requestsOf(explorer, mine) === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const second = ridingOut(client, other.address, { fundingTxReads })

    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
    const lookups = explorer.requests.map(({ path }) => path).filter(isLookup)
    expect(lookups).toEqual([mine, mine, theirs])
  })

  it('pauses 500 ms, 1,500 ms, 4,000 ms and 8,000 ms before the second to the fifth attempt', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(3)
    const victim = txPath(fakeTxid(2))
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === victim && nth <= 4 ? 502 : undefined))
    )

    const read = ridingOut(client, address, { fundingTxReads: new QbitFundingTxReads() })
    await vi.advanceTimersByTimeAsync(1)
    expect(requestsOf(explorer, victim)).toBe(1)
    for (const [pauseMs, attempts] of [
      [500, 2],
      [1_500, 3],
      [4_000, 4],
      [8_000, 5],
    ] as const) {
      await vi.advanceTimersByTimeAsync(pauseMs - 2)
      expect(requestsOf(explorer, victim)).toBe(attempts - 1)
      await vi.advanceTimersByTimeAsync(2)
      expect(requestsOf(explorer, victim)).toBe(attempts)
    }

    await expect(read).resolves.toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rides out a 5 s burst of 502s on every lookup of a read past its burst, three requests a slot at most during it', async () => {
    vi.useFakeTimers()
    // Its burst of 4,096 takes 1.6 s; 2,000 more follow, 32 at a time.
    const explorer = accountExplorer(6_096)
    explorer.slowResponses.push(LOOKUPS_TAKE_100_MS)
    const outage = burst(isLookup, 3_000, 8_000)
    const { client, lookups } = countedClient(serverErrors(explorer, outage.answers))
    const fundingTxReads = new QbitFundingTxReads()
    const limiter = fundingTxReads.limiter(client)
    const rate = QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT

    const read = track(ridingOut(client, address, { fundingTxReads }))
    // Midway through the burst, every slot's lookup pauses in its slot.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(lookups.inFlight).toBe(0)
    expect(limiter.inFlight).toBe(rate)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(read.settled).toBe(true)
    expect(read.value).toHaveLength(6_096)
    expect(lookups.peak).toBe(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    // One lookup a slot met the burst, and asked within it at most three
    // times: as it met it, 500 ms and 2 s on; 6 s on, the burst is over. So
    // the explorer had at most 3 x 32 = 96 requests during the burst, where
    // 32 in flight at 100 ms a lookup make 1,600 in 5 s.
    expect(outage.answered.size).toBeLessThanOrEqual(rate)
    expect(Math.max(...outage.answered.values())).toBe(3)
    const requestsDuringBurst = [...outage.answered.values()].reduce((sum, n) => sum + n, 0)
    expect(requestsDuringBurst).toBeLessThanOrEqual(3 * rate)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails with the 502 once a 20 s burst outlasts the last pause, 14 s after the first lookup met it', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(2_000)
    const outage = burst(isLookup, 0, 20_000)
    const { client } = countedClient(serverErrors(explorer, outage.answers))
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(ridingOut(client, address, { fundingTxReads }))
    // The first lookups go out at once, and their last attempts 500 ms,
    // 1,500 ms, 4,000 ms and 8,000 ms on.
    const failsAt = 500 + 1_500 + 4_000 + 8_000
    await vi.advanceTimersByTimeAsync(failsAt - 1)
    expect(read.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(read).toMatchObject({ settled: true, error: { kind: 'http', status: 502 } })
    expect((read.error as Error).message).toContain('HTTP 502 from')
    // Only the first lookup of each slot, in its burst: none started after them.
    expect(outage.answered.size).toBe(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(Math.max(...outage.answered.values())).toBe(5)
    expect(Math.min(...outage.answered.values())).toBeGreaterThanOrEqual(4)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops at once, with no timer left and the limiter idle, when the caller gives up during the pause', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(3)
    const victim = txPath(fakeTxid(1))
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === victim && nth === 1 ? 502 : undefined))
    )
    const fundingTxReads = new QbitFundingTxReads()
    const caller = new AbortController()

    const outcome = ridingOut(client, address, {
      fundingTxReads,
      signal: caller.signal,
    }).catch((caught: unknown) => ({ caught }))
    await vi.advanceTimersByTimeAsync(250)
    expect(requestsOf(explorer, victim)).toBe(1)

    const reason = new Error('the send screen closed')
    caller.abort(reason)
    await expect(outcome).resolves.toEqual({ caught: reason })
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestsOf(explorer, victim)).toBe(1)
  })

  it('stops at once in the 8 s pause, with no timer left and the limiter idle, when the caller gives up', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(3)
    const victim = txPath(fakeTxid(1))
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === victim && nth <= 4 ? 502 : undefined))
    )
    const fundingTxReads = new QbitFundingTxReads()
    const caller = new AbortController()

    const outcome = ridingOut(client, address, {
      fundingTxReads,
      signal: caller.signal,
    }).catch((caught: unknown) => ({ caught }))
    // The fourth attempt fails 6 s on, and the last pause, of 8 s, begins.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestsOf(explorer, victim)).toBe(4)

    const reason = new Error('the send screen closed')
    caller.abort(reason)
    await expect(outcome).resolves.toEqual({ caught: reason })
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(requestsOf(explorer, victim)).toBe(4)
  })

  it('leaves another read the rest of the bound while every slot of a long one past its burst pauses through a burst of 502s', async () => {
    vi.useFakeTimers()
    // Past its burst of 4,096 after 1.6 s, then 32 at a time.
    const explorer = accountExplorer(6_096)
    const other = account('22')
    fund(explorer, other, 1_000, 3_000_000)
    explorer.slowResponses.push(LOOKUPS_TAKE_100_MS)
    const theirs = new Set(Array.from({ length: 1_000 }, (_, index) => fakeTxid(index, 3_000_000)))
    // The long read's lookups meet a 5 s burst from 3 s on; the other's do not.
    const outage = burst(path => isLookup(path) && !theirs.has(path.slice(4)), 3_000, 8_000)
    const { client, lookups } = countedClient(serverErrors(explorer, outage.answers))
    const theirLookups = { inFlight: 0, peak: 0 }
    const getTx = client.getTx.bind(client)
    client.getTx = ((txid: string, request?: RequestOptions) => {
      if (!theirs.has(txid)) return getTx(txid, request)
      theirLookups.peak = Math.max(theirLookups.peak, ++theirLookups.inFlight)
      return getTx(txid, request).finally(() => {
        theirLookups.inFlight -= 1
      })
    }) as typeof client.getTx
    const fundingTxReads = new QbitFundingTxReads()
    const limiter = fundingTxReads.limiter(client)

    const mine = track(ridingOut(client, address, { fundingTxReads }))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(limiter.inFlight).toBe(QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT)
    expect(lookups.inFlight).toBe(0)
    const read = track(ridingOut(client, other.address, { fundingTxReads }))
    await vi.advanceTimersByTimeAsync(1_000)

    // A burst of its own, in the slots the paused ones leave, while they pause on.
    expect(read.settled).toBe(true)
    expect(read.value).toHaveLength(1_000)
    expect(theirLookups.peak).toBe(
      QBIT_CLASSIFY_MAX_READS_IN_FLIGHT - QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT
    )
    expect(mine.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mine.value).toHaveLength(6_096)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads a 502 the client retried itself again, once that one persists past its own attempts', async () => {
    const explorer = accountExplorer(20)
    const victim = txPath(fakeTxid(7))
    // No Retry-After: the client makes three attempts by itself first.
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === victim && nth <= 4 ? 502 : undefined), null),
      { retryBaseDelayMs: 1 }
    )

    const utxos = await ridingOut(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    expect(utxos).toHaveLength(20)
    // The client's three, then the wallet's second attempt, which the client
    // makes twice.
    expect(requestsOf(explorer, victim)).toBe(5)
  })

  it('leaves a 429 to the client, which follows its Retry-After', async () => {
    const explorer = accountExplorer(20)
    const victim = txPath(fakeTxid(7))
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === victim && nth === 1 ? 429 : undefined))
    )

    const error = await ridingOut(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ kind: 'rate_limit', status: 429 })
    expect(requestsOf(explorer, victim)).toBe(1)
  })
})

describe('the output listing, when the explorer answers it with a server error (#209)', () => {
  it('asks for it again after a 502 in the read that rides them out, and not for the balance', async () => {
    const explorer = accountExplorer(200)
    let failNext = true
    const { client } = countedClient(
      serverErrors(explorer, path => {
        if (path !== listing || !failNext) return undefined
        failNext = false
        return 502
      })
    )

    await expect(
      ridingOut(client, address, { fundingTxReads: new QbitFundingTxReads() })
    ).resolves.toHaveLength(200)
    expect(requestsOf(explorer, listing)).toBe(2)

    failNext = true
    await expect(balanceOf(client)).resolves.toEqual(incomplete(200, true))
    expect(requestsOf(explorer, listing)).toBe(3)
  })

  it.each([
    ['after the client retried it', null, 3],
    ['handed back at once', PAST_THE_CLIENT_CAP, 1],
  ])(
    'leaves a bare 500 %s to the refusal rule, as before',
    async (_label, retryAfter, listings) => {
      // More confirmed outputs than the wallet assumes a bare 500 refuses.
      const explorer = accountExplorer(600)
      const { client } = countedClient(
        serverErrors(explorer, path => (path === listing ? 500 : undefined), retryAfter),
        { retryBaseDelayMs: 1 }
      )

      // Read from the history instead, as for the explorer's limit.
      await expect(
        ridingOut(client, address, { fundingTxReads: new QbitFundingTxReads() })
      ).resolves.toHaveLength(600)
      expect(requestsOf(explorer, listing)).toBe(listings)
    }
  )

  it("rides out a lookup of an address past the explorer's limit, read from its history, as asked", async () => {
    const explorer = accountExplorer(30)
    explorer.utxoLimit = 20
    // An unconfirmed payment: the walk of the history reads its transaction.
    const pending = fakeTxid(1, 8_000_000)
    explorer.addTx({
      txid: pending,
      inputs: [{ txid: fakeTxid(2, 8_000_000), vout: 0 }],
      outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
    })
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) =>
        path === txPath(pending) && nth === 1 ? 502 : undefined
      )
    )

    // Its own payments, not the unconfirmed one from someone else.
    await expect(
      ridingOut(client, address, { fundingTxReads: new QbitFundingTxReads() })
    ).resolves.toHaveLength(30)
    expect(requestsOf(explorer, listing)).toBe(1)
    expect(requestsOf(explorer, txPath(pending))).toBe(2)
  })

  it('leaves a refusal the explorer states alone', async () => {
    const explorer = accountExplorer(30)
    explorer.utxoLimit = 20
    const { client } = countedClient(serverErrors(explorer, () => undefined))

    await expect(
      ridingOut(client, address, { fundingTxReads: new QbitFundingTxReads() })
    ).resolves.toHaveLength(30)
    expect(requestsOf(explorer, listing)).toBe(1)
    await expect(balanceOf(client)).resolves.toMatchObject({
      totalBalance: 30 * OUTPUT_VALUE,
      utxoLimitExceeded: true,
    })
    expect(requestsOf(explorer, listing)).toBe(2)
  })
})

describe("the classification's tip, when the explorer answers it with a server error (#209)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const TIP = '/blocks/tip/height'
  const REWARD = fakeTxid(1, 7_000_000)
  const REWARD_VALUE = 5 * OUTPUT_VALUE

  /**
   * An account of 20 payments and, with `reward`, a coinbase output younger
   * than a coinbase must be to mature, whose maturity only the tip can
   * judge; the tip's requests answered as `tip` picks by their count.
   */
  function rewardedAccount(tip: (nth: number) => number | undefined, { reward = true } = {}) {
    const explorer = accountExplorer(20)
    const height = explorer.tipHeight - 600
    if (reward) {
      explorer.addTx({
        txid: REWARD,
        inputs: [],
        outputs: [{ address, script: main.script, value: REWARD_VALUE }],
        height,
        coinbase: true,
      })
    }
    const { client } = countedClient(
      serverErrors(explorer, (path, nth) => (path === TIP ? tip(nth) : undefined))
    )
    return { explorer, client, height }
  }

  it('reads the tip again after two 502s in the read that rides them out, and judges the reward by it; the balance fails at once', async () => {
    vi.useFakeTimers()
    const outputs = rewardedAccount(nth => (nth <= 2 ? 502 : undefined))
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(readQbitAddressUtxosRidingOut(outputs.client, address, { fundingTxReads }))
    // Its second attempt failed 500 ms on, and its third goes out 1,500 ms
    // later; the lookups are done, and the tip holds no slot meanwhile.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(read.settled).toBe(false)
    expect(requestsOf(outputs.explorer, TIP)).toBe(2)
    expect(fundingTxReads.limiter(outputs.client).inFlight).toBe(0)
    await vi.advanceTimersByTimeAsync(1_010)

    expect(read.settled).toBe(true)
    // The reward is immature: it is not among them, and says when it matures.
    expect(read.value?.matureAt).toBe(outputs.height + 999)
    expect(read.value?.utxos).toHaveLength(20)
    expect(requestsOf(outputs.explorer, TIP)).toBe(3)

    // The balance asks for it once, as 1.0.9 did: the client hands the 502
    // back, and the reward's maturity cannot be judged.
    const balance = rewardedAccount(nth => (nth <= 2 ? 502 : undefined))
    const answer = track(balanceOf(balance.client))
    await vi.advanceTimersByTimeAsync(0)
    const total = 20 * OUTPUT_VALUE + REWARD_VALUE
    expect(answer.value).toEqual({
      ...incomplete(20, true),
      unavailableBalance: total,
      totalBalance: total,
    })
    expect(answer.at).toBe(0)
    expect(requestsOf(balance.explorer, TIP)).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails as before once the tip is answered 502 throughout, 14 s on, with a reward to judge; without one it reads on', async () => {
    vi.useFakeTimers()
    const rewarded = rewardedAccount(() => 502)
    const fundingTxReads = new QbitFundingTxReads()
    const failsAt = 500 + 1_500 + 4_000 + 8_000

    const read = track(ridingOut(rewarded.client, address, { fundingTxReads }))
    await vi.advanceTimersByTimeAsync(failsAt - 1)
    expect(read.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(read).toMatchObject({ settled: true, error: { kind: 'http', status: 502 } })
    expect((read.error as Error).message).toContain(TIP)
    expect(requestsOf(rewarded.explorer, TIP)).toBe(5)
    const limiter = fundingTxReads.limiter(rewarded.client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)

    // The balance, which does not ride them out, answers the total with the
    // split unknown at once.
    const balance = rewardedAccount(() => 502)
    const answer = track(balanceOf(balance.client))
    await vi.advanceTimersByTimeAsync(0)
    const total = 20 * OUTPUT_VALUE + REWARD_VALUE
    expect(answer.value).toEqual({
      ...incomplete(20, true),
      unavailableBalance: total,
      totalBalance: total,
    })
    expect(requestsOf(balance.explorer, TIP)).toBe(1)

    // Without a reward nothing waits for the tip: the read ends in the
    // tip's first pause, and that ends with it.
    const plain = rewardedAccount(() => 502, { reward: false })
    const outputs = track(
      ridingOut(plain.client, address, { fundingTxReads: new QbitFundingTxReads() })
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(outputs.value).toHaveLength(20)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(failsAt)
    expect(requestsOf(plain.explorer, TIP)).toBe(1)
  })

  it('leaves a bare 500 on the tip to the client, as before', async () => {
    const explorer = accountExplorer(20)
    explorer.addTx({
      txid: REWARD,
      inputs: [],
      outputs: [{ address, script: main.script, value: REWARD_VALUE }],
      height: explorer.tipHeight - 600,
      coinbase: true,
    })
    // No Retry-After: the client makes three attempts by itself.
    const { client } = countedClient(
      serverErrors(explorer, path => (path === TIP ? 500 : undefined), null),
      { retryBaseDelayMs: 1 }
    )

    const error = await ridingOut(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ kind: 'http', status: 500 })
    expect(requestsOf(explorer, TIP)).toBe(3)
  })
})

describe("a read that does not ride out server errors, as every read but the send screen's (#209)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const TIP = '/blocks/tip/height'
  const victim = fakeTxid(7)
  const pathOf = { lookup: txPath(victim), listing, tip: TIP } as const

  /** The account, with a reward whose maturity needs the tip, `path` answered `status`. */
  function failing(path: string, status: number, retryAfter: string | null) {
    const explorer = accountExplorer(20)
    explorer.addTx({
      txid: fakeTxid(1, 7_000_000),
      inputs: [],
      outputs: [{ address, script: main.script, value: 5 * OUTPUT_VALUE }],
      height: explorer.tipHeight - 600,
      coinbase: true,
    })
    const { client } = countedClient(
      serverErrors(explorer, requested => (requested === path ? status : undefined), retryAfter)
    )
    return { explorer, client }
  }

  it.each(
    (['lookup', 'listing', 'tip'] as const).flatMap(target =>
      (
        [
          // The client's three attempts, 300 ms and 600 ms apart.
          ['a 502 without Retry-After', 502, null, 3, 900],
          // Past the client's cap: handed back at once.
          ['a 502 with Retry-After past the client cap', 502, '60', 1, 0],
          // The client waits as it is told, twice.
          ['a 503 with Retry-After: 5', 503, '5', 3, 10_000],
        ] as const
      ).map(failure => [target, ...failure] as const)
    )
  )(
    'fails the read of outputs on its %s answered %s as the client alone does, as 1.0.9 did',
    async (target, _label, status, retryAfter, requests, ms) => {
      vi.useFakeTimers()
      const path = pathOf[target]
      // The explorer client alone, as 1.0.9 read each of them.
      const alone = failing(path, status, retryAfter)
      const call = track<unknown>(
        target === 'lookup'
          ? alone.client.getTx(victim)
          : target === 'listing'
            ? alone.client.getAddressUtxos(address)
            : alone.client.getTipHeight()
      )
      await untilSettled(call)
      expect([requestsOf(alone.explorer, path), call.at]).toEqual([requests, ms])

      const wallet = failing(path, status, retryAfter)
      const read = track(
        getQbitAddressUtxos(wallet.client, address, { fundingTxReads: new QbitFundingTxReads() })
      )
      await untilSettled(read)

      expect(read.error).toMatchObject({ kind: 'http', status })
      expect([requestsOf(wallet.explorer, path), read.at]).toEqual([requests, ms])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([
    ['getQbitAddressUtxos', getQbitAddressUtxos],
    ['readQbitAddressUtxos', readQbitAddressUtxos],
    ['getQbitAddressUtxosClassified', getQbitAddressUtxosClassified],
    ['getQbitAddressUtxosClassifiedPastLimit', getQbitAddressUtxosClassifiedPastLimit],
  ] as const)(
    'takes no ride-out from a caller of %s: the option is not one it accepts',
    async (_name, read) => {
      const explorer = accountExplorer(20)
      const { client } = countedClient(
        serverErrors(explorer, path => (path === txPath(victim) ? 502 : undefined))
      )
      const stray = { fundingTxReads: new QbitFundingTxReads(), rideOutServerErrors: true }

      await expect(read(client, address, stray as any)).rejects.toMatchObject({ status: 502 })
      expect(requestsOf(explorer, txPath(victim))).toBe(1)
    }
  )

  it('gives the balance with one lookup answering 502 its incomplete, failed answer as soon as 1.0.9, well within its deadline', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(300)
    const { client } = countedClient(
      serverErrors(explorer, path => (path === txPath(victim) ? 502 : undefined), null)
    )

    const read = track(balanceOf(client))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(300, true))
    // The client's three attempts, 300 ms and 600 ms apart, and no more.
    expect(requestsOf(explorer, txPath(victim))).toBe(3)
    expect(read.at).toBe(900)
    expect(read.at).toBeLessThan(QBIT_BALANCE_READ_DEADLINE_MS / 20)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the ride-out, bounded in time (#209)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    // Attempts at 0, 0.5, 2, 6 and 14 s.
    ['a 502 with Retry-After past the client cap', 5, 14_000, 502, '60', 0],
    // Each attempt the client's three, 0.9 s: the last begins at 17.6 s.
    ['a 502 without Retry-After', 15, 18_500, 502, null, 0],
    // Each attempt 10 s: the third would begin at 22 s, past the budget.
    ['a 503 with Retry-After: 5', 6, 20_500, 503, '5', 0],
    // One client call of 60 s, as 1.0.9: no wallet attempt after it.
    ['a 503 with Retry-After: 30', 3, 60_000, 503, '30', 0],
    // Attempts at 0, 5.5 and 12 s, each answered 5 s later: the fourth would
    // begin at 21 s, so none is waited for.
    ['a 502 past the cap, each answered 5 s on', 3, 17_000, 502, '60', 5_000],
    // The budget bounds when an attempt begins, not how long it runs: the
    // second call, of 18 s, begins at 18.5 s; the client alone took 18 s.
    ['a 503 with Retry-After: 9', 6, 36_500, 503, '9', 0],
    // Calls of 18.9 s, the second beginning at 19.4 s; the client alone took 18.9 s.
    ['a 502 without Retry-After, each answered 6 s on', 6, 38_300, 502, null, 6_000],
  ] as const)(
    'gives up a lookup answered %s within 20 s of its first attempt: %i requests, failing at %i ms',
    async (_label, requests, ms, status, retryAfter, delayMs) => {
      vi.useFakeTimers()
      const explorer = accountExplorer(20)
      const victim = txPath(fakeTxid(7))
      const { client } = countedClient(
        serverErrors(explorer, path => (path === victim ? status : undefined), retryAfter, delayMs)
      )

      const read = track(ridingOut(client, address, { fundingTxReads: new QbitFundingTxReads() }))
      await untilSettled(read)

      expect(read.error).toMatchObject({ kind: 'http', status })
      expect([requestsOf(explorer, victim), read.at]).toEqual([requests, ms])
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('an ancestor of own change the explorer answers 500 every time (#209)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Three payments, and the account's own change two unconfirmed
   * transactions deep on a confirmed output of its own, the middle one
   * answered 500 every time; each lookup answered `latencyMs` on.
   */
  function ancestorFailing(latencyMs: number) {
    const explorer = accountExplorer(3)
    const root = fakeTxid(1, 7_000_000)
    const parent = fakeTxid(2, 7_000_000)
    const change = fakeTxid(3, 7_000_000)
    explorer.addTx({
      txid: root,
      inputs: [{ txid: fakeTxid(9, 7_000_000), vout: 0 }],
      outputs: [{ address, script: main.script, value: 30_000 }],
      height: explorer.tipHeight - 10,
    })
    explorer.addTx({
      txid: parent,
      inputs: [{ txid: root, vout: 0 }],
      outputs: [{ address, script: main.script, value: 20_000 }],
    })
    explorer.addTx({
      txid: change,
      inputs: [{ txid: parent, vout: 0 }],
      outputs: [{ address, script: main.script, value: 10_000 }],
    })
    if (latencyMs > 0) {
      explorer.slowResponses.push({ ...LOOKUPS_TAKE_100_MS, intervalMs: latencyMs })
    }
    const { client } = countedClient(
      serverErrors(explorer, path => (path === txPath(parent) ? 500 : undefined), null, latencyMs)
    )
    return { explorer, client, parent, change }
  }

  it('costs its output its standing as own change as fast as 1.0.9, in the read that rides out server errors too', async () => {
    vi.useFakeTimers()
    const { explorer, client, parent, change } = ancestorFailing(0)

    const read = track(ridingOut(client, address, { fundingTxReads: new QbitFundingTxReads() }))
    await untilSettled(read)

    // The client's three attempts, 300 ms and 600 ms apart, and none more.
    expect(requestsOf(explorer, txPath(parent))).toBe(3)
    expect(read.at).toBe(900)
    // The three payments: the change is not shown to be the account's own.
    expect(read.value).toHaveLength(3)
    expect(read.value?.some(utxo => utxo.txid === change)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves the balance complete, at 100 ms a request, well within its deadline', async () => {
    vi.useFakeTimers()
    const { client } = ancestorFailing(100)

    const balance = track(balanceOf(client))
    await untilSettled(balance)

    expect(balance.value).not.toHaveProperty('utxoReadIncomplete')
    expect(balance.value?.availableBalance).toBe(3 * OUTPUT_VALUE)
    expect(balance.at).toBeLessThan(2_000)
  })
})

describe('isQbitRideOutFailure', () => {
  it("is a failure the send screen's read rides out, by the read the client names, and nothing else", async () => {
    const TIP = '/blocks/tip/height'
    const victim = fakeTxid(7)
    const failureOf = async (
      path: string,
      status: number,
      call: (client: QbitWalletEsploraClient) => Promise<unknown>
    ) => {
      const explorer = accountExplorer(20)
      const { client } = countedClient(
        serverErrors(explorer, requested => (requested === path ? status : undefined))
      )
      return call(client).catch((caught: unknown) => caught)
    }
    const lookup = (status: number) =>
      failureOf(txPath(victim), status, client => client.getTx(victim))
    const listed = (status: number) =>
      failureOf(listing, status, client => client.getAddressUtxos(address))
    const tip = (status: number) => failureOf(TIP, status, client => client.getTipHeight())
    const stats = (status: number) =>
      failureOf(`/address/${address}`, status, client => client.getAddressStats(address))

    for (const status of [500, 502, 503, 504]) {
      expect(isQbitRideOutFailure(await lookup(status)), `lookup ${status}`).toBe(true)
    }
    for (const status of [502, 503, 504]) {
      expect(isQbitRideOutFailure(await listed(status)), `listing ${status}`).toBe(true)
      expect(isQbitRideOutFailure(await tip(status)), `tip ${status}`).toBe(true)
    }
    // A bare 500 on the listing is the refusal rule's, and on the tip the
    // client's; the statistics are read once; a 429 and a 404 are the client's.
    expect(isQbitRideOutFailure(await listed(500))).toBe(false)
    expect(isQbitRideOutFailure(await tip(500))).toBe(false)
    expect(isQbitRideOutFailure(await stats(502))).toBe(false)
    expect(isQbitRideOutFailure(await lookup(429))).toBe(false)
    expect(isQbitRideOutFailure(await lookup(404))).toBe(false)
    expect(isQbitRideOutFailure(new Error('HTTP 502'))).toBe(false)
    expect(isQbitRideOutFailure(undefined)).toBe(false)
  })
})

describe('isQbitServerError', () => {
  it('is the HTTP error, or a body lost, of one of the statuses it is given', () => {
    const error = (kind: QbitApiError['kind'], message: string, status?: number) =>
      new QbitApiError(kind, message, status === undefined ? {} : { status })
    const lostBody = (status: number) =>
      error('parse', 'failed to read response body from https://explorer.test/tx', status)

    for (const status of [500, 502, 503, 504]) {
      expect(
        isQbitServerError(error('http', `HTTP ${status}`, status), QBIT_LOOKUP_RETRY_STATUSES)
      ).toBe(true)
      expect(isQbitServerError(lostBody(status), QBIT_LOOKUP_RETRY_STATUSES)).toBe(true)
    }
    // The listing's leave a bare 500 to the refusal rule.
    expect(isQbitServerError(error('http', 'HTTP 500', 500), QBIT_LISTING_RETRY_STATUSES)).toBe(
      false
    )
    expect(isQbitServerError(error('http', 'HTTP 502', 502), QBIT_LISTING_RETRY_STATUSES)).toBe(
      true
    )
    for (const other of [
      error('rate_limit', 'HTTP 429', 429),
      error('not_found', 'HTTP 404', 404),
      error('payload_too_large', 'HTTP 413', 413),
      error('http', 'HTTP 501', 501),
      error('timeout', 'request timed out', 502),
      error('parse', 'failed to parse JSON from /tx', 502),
      error('http', 'HTTP 502'),
      new Error('HTTP 502'),
      undefined,
    ]) {
      expect(isQbitServerError(other, QBIT_LOOKUP_RETRY_STATUSES)).toBe(false)
    }
  })
})
