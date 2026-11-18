import { afterEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError, type RequestOptions } from '@qbit-oss/api'
import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import {
  QBIT_BALANCE_READ_DEADLINE_MS,
  QbitWalletEsploraClient,
  getQbitSpendableBalanceV2,
} from '../src/utils/qbit-api'
import { QbitBalanceReuse, type QbitBalanceReuseView } from '../src/utils/qbit-balance-reuse'
import {
  QBIT_BALANCE_READ_FAILED_LOOKUPS,
  QBIT_BALANCE_READ_FAILURE_GRACE_MS,
  QbitClassificationReads,
  QBIT_BALANCE_READ_RETRY_PAUSES_MS,
  QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS,
  QBIT_CLASSIFY_MAX_READS_IN_FLIGHT,
  QbitFundingTxReads,
} from '../src/utils/qbit-funding-tx-reads'
import {
  FRESH_STATS,
  address as REUSE_ADDRESS,
  LISTING as REUSE_LISTING,
  ReuseAccount,
  STATS as REUSE_STATS,
  TIP as REUSE_TIP,
  route,
  split,
  sum,
} from './qbit-balance-reuse-fixture'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The balance read (`getQbitSpendableBalanceV2`) through the real explorer
// client and the wallet's own fetch, over an explorer served over fetch that
// answers chosen requests with a server error page.
const BASE = 'https://explorer.test/api'
const OUTPUT_VALUE = 10_000
const TIP = '/blocks/tip/height'
const txPath = (txid: string): string => `/tx/${txid}`
const isLookup = (path: string): boolean => path.startsWith('/tx/')

/** The explorer's 502: its CDN's page, sent with `Retry-After: 60`. */
const BAD_GATEWAY_PAGE =
  '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>'

/**
 * The explorer's own `Retry-After`, past the client's cap (30 s): the client
 * hands the reply back at once, with no attempt of its own.
 */
const EXPLORERS_RETRY_AFTER = '60'

function account(pubkeyByte: string) {
  const pubkey = hexToBytes(pubkeyByte.repeat(32))
  const script = bytesToHex(
    p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pubkey)))
  )
  return { address: p2mrAddressFromPubkey(pubkey, 'testnet4'), script }
}

const main = account('11')
const other = account('22')
const address = main.address
const STATS = `/address/${address}`
const LISTING = `/address/${address}/utxo`

/**
 * `count` payments to `holder`, each its own transaction, 600 blocks deep:
 * younger than a coinbase must be to mature, so the balance reads each one's
 * transaction.
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
 * A request as the explorer was asked for it, and when, in ms after
 * `failing` was called; `ended` once it was answered or given up.
 */
interface Logged {
  path: string
  at: number
  ended?: boolean
}

/**
 * How `failing` answers a request it picks: a status with the error page,
 * one `delayMs` later than the others, or never until it is given up.
 */
type Failure = number | { status: number; delayMs: number } | 'hang'

/**
 * The fetch the client is handed, and a log of every request made through
 * it: `explorer`'s, but a request `answers` picks, by its path and how many
 * requests that path has had, gets the status it names with the error page,
 * `Retry-After` as given (the explorer's by default; none when null),
 * `delayMs` after it was made, or as soon as its signal aborts; or, given
 * 'hang', no reply until its signal aborts. `served` is told the path of
 * each request once its reply is made.
 */
function failing(
  explorer: FakeQbitExplorer,
  answers: (path: string, nth: number) => Failure | undefined,
  {
    retryAfter = EXPLORERS_RETRY_AFTER,
    delayMs = 0,
    served,
  }: { retryAfter?: string | null; delayMs?: number; served?: (path: string) => void } = {}
) {
  const seen = new Map<string, number>()
  const log: Logged[] = []
  const start = Date.now()
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`
    const nth = (seen.get(path) ?? 0) + 1
    seen.set(path, nth)
    const entry: Logged = { path, at: Date.now() - start }
    log.push(entry)
    const failure = answers(path, nth)
    if (failure === undefined) {
      const reply = await explorer.fetch(input, init)
      served?.(path)
      entry.ended = true
      return reply
    }
    explorer.requests.push({ method: init?.method ?? 'GET', path })
    const status = typeof failure === 'object' ? failure.status : failure === 'hang' ? 0 : failure
    const waitMs = typeof failure === 'object' ? failure.delayMs : failure === 'hang' ? -1 : delayMs
    if (waitMs !== 0) {
      const signal = init?.signal ?? undefined
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer)
          entry.ended = true
          reject(signal?.reason)
        }
        const timer =
          waitMs < 0
            ? undefined
            : setTimeout(() => {
                signal?.removeEventListener('abort', onAbort)
                resolve()
              }, waitMs)
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    entry.ended = true
    const reply = new Response(status === 502 ? BAD_GATEWAY_PAGE : `HTTP ${status}`, {
      status,
      headers: {
        'content-type': 'text/html',
        ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
      },
    })
    served?.(path)
    return reply
  }
  return { fetchFn, log }
}

const clientOf = (fetchFn: typeof fetch): QbitWalletEsploraClient =>
  new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn })

const balanceOf = (
  client: QbitWalletEsploraClient,
  fundingTxReads = new QbitFundingTxReads(),
  options: {
    deadlineMs?: number
    signal?: AbortSignal
    holder?: typeof main
    reuse?: QbitBalanceReuseView
  } = {}
) =>
  getQbitSpendableBalanceV2(
    client,
    (options.holder ?? main).address,
    (options.holder ?? main).script,
    undefined,
    undefined,
    {
      fundingTxReads,
      ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.reuse ? { reuse: options.reuse } : {}),
    }
  )

/** Every one of `count` payments available. */
const complete = (count: number) => ({
  availableBalance: count * OUTPUT_VALUE,
  unavailableBalance: 0,
  totalBalance: count * OUTPUT_VALUE,
  immatureBalance: 0,
  pendingBalance: 0,
})

/** The total of `count` payments with the split unknown; `failed` when the read failed. */
const incomplete = (count: number, failed: boolean) => ({
  availableBalance: null,
  unavailableBalance: count * OUTPUT_VALUE,
  totalBalance: count * OUTPUT_VALUE,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  ...(failed ? { utxoReadFailed: true } : {}),
})

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

const requestsTo = (log: readonly Logged[], path: string): number[] =>
  log.filter(request => request.path === path).map(request => request.at)

const lookupsIn = (log: readonly Logged[]): string[] =>
  log.filter(request => isLookup(request.path)).map(request => request.path)

describe('the balance read, when the explorer answers a lookup with a server error', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads a lookup answered 502 with Retry-After: 60 again 500 ms on, and gives the full split for one request more', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(300)
    const victim = txPath(fakeTxid(150))
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === victim && nth === 1 ? 502 : undefined
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.value).toEqual(complete(300))
    expect(read.at).toBe(QBIT_BALANCE_READ_RETRY_PAUSES_MS[0])
    // The statistics, the listing, the tip and the 300 lookups, and the
    // victim's second attempt.
    expect(log).toHaveLength(3 + 300 + 1)
    expect(requestsTo(log, victim)).toEqual([0, 500])
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['a 500', 500, EXPLORERS_RETRY_AFTER, 1, 2],
    ['a 503', 503, EXPLORERS_RETRY_AFTER, 1, 2],
    ['a 504', 504, EXPLORERS_RETRY_AFTER, 1, 2],
    // The client's own three attempts, then the read's second.
    ['a 502 the client retried itself', 502, null, 3, 4],
  ] as const)(
    'reads a lookup answered %s again',
    async (_label, status, retryAfter, failures, requests) => {
      vi.useFakeTimers()
      const explorer = accountExplorer(50)
      const victim = txPath(fakeTxid(25))
      const { fetchFn, log } = failing(
        explorer,
        (path, nth) => (path === victim && nth <= failures ? status : undefined),
        { retryAfter }
      )

      const read = track(balanceOf(clientOf(fetchFn)))
      await untilSettled(read)

      expect(read.value).toEqual(complete(50))
      expect(requestsTo(log, victim)).toHaveLength(requests)
    }
  )

  it('pauses with no slot of the limiter held: a read waiting for the slot goes first', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    fund(explorer, other, 5, 3_000_000)
    const victim = txPath(fakeTxid(0))
    const { fetchFn } = failing(explorer, (path, nth) =>
      path === victim && nth === 1 ? 502 : undefined
    )
    const client = clientOf(fetchFn)
    // One read in flight at a time through this client.
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 1 })

    const mine = track(balanceOf(client, fundingTxReads))
    const theirs = track(balanceOf(client, fundingTxReads, { holder: other }))
    await untilSettled(mine)

    expect(mine.value).toEqual(complete(20))
    expect(theirs.value).toEqual(complete(5))
    // Read in the pause, which held no slot.
    expect(theirs.at).toBeLessThan(QBIT_BALANCE_READ_RETRY_PAUSES_MS[0]!)
    expect(mine.at).toBe(QBIT_BALANCE_READ_RETRY_PAUSES_MS[0])
  })

  it('answers the split unknown and failed when a lookup fails throughout, keeps every other fact, and the next read asks for that one alone', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(300)
    const victim = txPath(fakeTxid(150))
    let healed = false
    const { fetchFn, log } = failing(explorer, path =>
      !healed && path === victim ? 502 : undefined
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const first = track(balanceOf(client, fundingTxReads))
    await untilSettled(first)

    expect(first.value).toEqual(incomplete(300, true))
    // Three attempts, 500 ms and 1,500 ms apart.
    expect(requestsTo(log, victim)).toEqual([0, 500, 2_000])
    expect(first.at).toBe(2_000)
    expect(fundingTxReads.size).toBe(299)

    let from = log.length
    const second = track(balanceOf(client, fundingTxReads))
    await untilSettled(second)
    expect(second.value).toEqual(incomplete(300, true))
    expect(lookupsIn(log.slice(from))).toEqual([victim, victim, victim])

    healed = true
    from = log.length
    const third = track(balanceOf(client, fundingTxReads))
    await untilSettled(third)
    expect(third.value).toEqual(complete(300))
    expect(lookupsIn(log.slice(from))).toEqual([victim])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets the lookups in flight run to their end when one fails at once, and keeps what they read', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    // Every lookup answered 100 ms on, but one, refused at once.
    explorer.slowResponses.push({
      match: request => isLookup(request.path),
      chunkBytes: 1 << 20,
      intervalMs: 100,
    })
    const victim = txPath(fakeTxid(0))
    const { fetchFn, log } = failing(explorer, path => (path === victim ? 404 : undefined))
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(50, true))
    // The others' answers, 100 ms on, were waited for and kept.
    expect(read.at).toBe(100)
    expect(fundingTxReads.size).toBe(49)
    expect(explorer.abortedRequests).toEqual([])
    const from = log.length
    await balanceOf(client, fundingTxReads).catch(() => undefined)
    expect(lookupsIn(log.slice(from))).toEqual([victim])
  })
})

describe('the balance read, when the explorer answers its statistics, listing or tip with a server error', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the statistics again after a 502 and completes', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === STATS && nth === 1 ? 502 : undefined
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual(complete(50))
    expect(requestsTo(log, STATS)).toEqual([0, 500])
  })

  it('reads the statistics again after a 502 with a place among the kept answers, asked for with the listing', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === STATS && nth === 1 ? 502 : undefined
    )

    const read = track(
      getQbitSpendableBalanceV2(clientOf(fetchFn), address, main.script, undefined, undefined, {
        fundingTxReads: new QbitFundingTxReads(),
        reuse: new QbitBalanceReuse().begin(),
      })
    )
    await untilSettled(read)

    expect(read.value).toEqual(complete(50))
    expect(requestsTo(log, STATS)).toEqual([0, 500])
  })

  it('reads the statistics again, fresh, after a 502 on a poll that reuses a kept answer, and still reuses it', async () => {
    const account = new ReuseAccount()
    const total = sum(account.payments)
    await account.poll()
    await account.poll()
    // The next poll reads the statistics fresh, and the tip, and no listing.
    let failed = 0
    account.explorer.failures.push(({ path }) =>
      route(path) === REUSE_STATS && failed++ === 0
        ? { status: 502, body: BAD_GATEWAY_PAGE, headers: { 'retry-after': '60' } }
        : undefined
    )

    const reused = await account.poll()

    expect(reused.requests).toEqual([FRESH_STATS, REUSE_TIP, FRESH_STATS])
    expect(reused.value).toEqual(split({ available: total }))
  })

  it('rejects as before, with the 502, once the statistics fail throughout, and reads no more of the outputs', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    // The listing answered 3 s on, so the read is still listing when it fails.
    explorer.slowResponses.push({
      match: request => request.path === LISTING,
      chunkBytes: 1 << 20,
      intervalMs: 3_000,
    })
    const { fetchFn, log } = failing(explorer, path => (path === STATS ? 502 : undefined))
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.error).toMatchObject({ kind: 'http', status: 502 })
    expect(read.at).toBe(2_000)
    expect(requestsTo(log, STATS)).toEqual([0, 500, 2_000])
    expect(lookupsIn(log)).toEqual([])
    expect(explorer.abortedRequests).toEqual([LISTING])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads the listing again after a 502 and completes', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === LISTING && nth === 1 ? 502 : undefined
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual(complete(50))
    expect(requestsTo(log, LISTING)).toEqual([0, 500])
  })

  it.each([
    // An address under the limit a bare 500 means: an ordinary failure.
    ['a bare 500 the client hands back at once', 500, EXPLORERS_RETRY_AFTER, 1],
    ['a bare 500 the client retried itself', 500, null, 3],
  ] as const)(
    'judges %s on the listing as before, without reading it again',
    async (_label, status, retryAfter, requests) => {
      vi.useFakeTimers()
      const explorer = accountExplorer(50)
      const { fetchFn, log } = failing(explorer, path => (path === LISTING ? status : undefined), {
        retryAfter,
      })

      const read = track(balanceOf(clientOf(fetchFn)))
      await untilSettled(read)

      expect(read.value).toEqual(incomplete(50, true))
      expect(requestsTo(log, LISTING)).toHaveLength(requests)
    }
  )

  it("judges the explorer's refusal of the listing, a 413, as before, without reading it again", async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(30)
    explorer.utxoLimit = 20
    const { fetchFn, log } = failing(explorer, () => undefined)

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toMatchObject({ totalBalance: 30 * OUTPUT_VALUE, utxoLimitExceeded: true })
    expect(requestsTo(log, LISTING)).toEqual([0])
  })

  it("reads the statistics again after a 502 when checking the explorer's refusal of the listing", async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(30)
    explorer.utxoLimit = 20
    // The first statistics, read with the listing, answer; the second, read
    // to check the refusal, are answered 502 once.
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === STATS && nth === 2 ? 502 : undefined
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toMatchObject({ totalBalance: 30 * OUTPUT_VALUE, utxoLimitExceeded: true })
    expect(requestsTo(log, STATS)).toEqual([0, 0, 500])
  })

  it('reads the tip again after a 502 and judges a young reward immature by it', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    const reward = 5 * OUTPUT_VALUE
    explorer.addTx({
      txid: fakeTxid(1, 7_000_000),
      inputs: [],
      outputs: [{ address, script: main.script, value: reward }],
      height: explorer.tipHeight - 600,
      coinbase: true,
    })
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === TIP && nth === 1 ? 502 : undefined
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual({
      ...complete(20),
      unavailableBalance: reward,
      totalBalance: 20 * OUTPUT_VALUE + reward,
      immatureBalance: reward,
    })
    expect(requestsTo(log, TIP)).toEqual([0, 500])
  })
})

describe("the balance read's ride-out, within its deadline", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('begins no attempt after its deadline, answers by it, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    // Every lookup answered 502, each 1 s on: attempts at 0 and 1.5 s, the
    // second still unanswered at the 2 s deadline.
    const { fetchFn, log } = failing(explorer, path => (isLookup(path) ? 502 : undefined), {
      delayMs: 1_000,
    })
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(client, fundingTxReads, { deadlineMs: 2_000 }))
    await untilSettled(read)

    // Cut off by the deadline with nothing kept: failed.
    expect(read.value).toEqual(incomplete(20, true))
    expect(read.at).toBe(2_000)
    const lookups = log.filter(request => isLookup(request.path))
    expect(lookups).toHaveLength(40)
    expect(new Set(lookups.map(request => request.at))).toEqual(new Set([0, 1_500]))
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log.filter(request => isLookup(request.path))).toHaveLength(40)
  })

  it("rejects at once with the caller's reason when the caller gives up during a pause", async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    const victim = txPath(fakeTxid(7))
    const { fetchFn, log } = failing(explorer, path => (path === victim ? 502 : undefined))
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()
    const caller = new AbortController()
    const reason = new Error('the popup closed')

    const read = track(balanceOf(client, fundingTxReads, { signal: caller.signal }))
    await vi.advanceTimersByTimeAsync(200)
    expect(read.settled).toBe(false)
    caller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)

    expect(read).toMatchObject({ settled: true, error: reason, at: 200 })
    expect(requestsTo(log, victim)).toEqual([0])
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not read again a lookup the client already waited on for a Retry-After within its cap: it fails at 10 s with the 503, as before', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    const victim = txPath(fakeTxid(25))
    const { fetchFn, log } = failing(explorer, path => (path === victim ? 503 : undefined), {
      retryAfter: '5',
    })
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(clientOf(fetchFn), fundingTxReads))
    await untilSettled(read)

    // The client's three attempts, 5 s apart: a further one would begin
    // more than 5 s after the first (`QBIT_BALANCE_READ_RIDE_OUT_MS`).
    expect(read.value).toEqual(incomplete(50, true))
    expect(read.at).toBe(10_000)
    expect(requestsTo(log, victim)).toEqual([0, 5_000, 10_000])
    expect(fundingTxReads.size).toBe(49)
  })

  it('reports a read that met a failure and then ran out of time as failed, though it kept facts for the next', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(21)
    const victim = txPath(fakeTxid(0))
    // Ten lookups answered 100 ms on, the other ten 5 s on, past the
    // deadline, which comes before the wait after a failure ends.
    const fast = new Set(Array.from({ length: 10 }, (_, index) => txPath(fakeTxid(index + 1))))
    explorer.slowResponses.push(
      { match: request => fast.has(request.path), chunkBytes: 1 << 20, intervalMs: 100 },
      { match: request => isLookup(request.path), chunkBytes: 1 << 20, intervalMs: 5_000 }
    )
    const { fetchFn } = failing(explorer, path => (path === victim ? 404 : undefined))
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(clientOf(fetchFn), fundingTxReads, { deadlineMs: 2_000 }))
    await untilSettled(read)

    expect(read.at).toBe(2_000)
    expect(fundingTxReads.size).toBe(10)
    expect(read.value).toEqual(incomplete(21, true))
  })
})

describe('the balance read against an explorer that keeps failing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * The most lookups a balance read sends an explorer that fails every one:
   * as many as it has in flight, a few more until enough have failed, and
   * two more attempts each for those that ride out.
   */
  const MOST_LOOKUPS =
    QBIT_CLASSIFY_MAX_READS_IN_FLIGHT +
    QBIT_BALANCE_READ_FAILED_LOOKUPS -
    1 +
    2 * QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS

  /**
   * Lookups each answered 502 once: as many as ride out, and one fewer than
   * stop the read, so the rest fail at once and the read goes on.
   */
  const ONE_SHORT_OF_STOPPING =
    QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS + QBIT_BALANCE_READ_FAILED_LOOKUPS - 1

  it(`rides out at most ${QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS} lookups of a read, and keeps what they read`, async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(ONE_SHORT_OF_STOPPING)
    // Every lookup answered 502 once.
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      isLookup(path) && nth === 1 ? 502 : undefined
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(ONE_SHORT_OF_STOPPING, true))
    expect(read.at).toBe(500)
    expect(lookupsIn(log)).toHaveLength(ONE_SHORT_OF_STOPPING + QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS)
    expect(fundingTxReads.size).toBe(QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS)

    // The next read asks only for the rest, and completes.
    const from = log.length
    const next = track(balanceOf(client, fundingTxReads))
    await untilSettled(next)
    expect(next.value).toEqual(complete(ONE_SHORT_OF_STOPPING))
    expect(lookupsIn(log.slice(from))).toHaveLength(
      ONE_SHORT_OF_STOPPING - QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS
    )
  })

  it('gives every read a ride-out budget of its own: a later read rides out its lookups again', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(ONE_SHORT_OF_STOPPING)
    // Every lookup answered 502 once, those of payments made later included.
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      isLookup(path) && nth === 1 ? 502 : undefined
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()
    const first = track(balanceOf(client, fundingTxReads))
    await untilSettled(first)
    expect(lookupsIn(log)).toHaveLength(ONE_SHORT_OF_STOPPING + QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS)

    // Five payments more, each answered 502 once, ride out in the next read.
    fund(explorer, main, 5, 600_000)
    const from = log.length
    const next = track(balanceOf(client, fundingTxReads))
    await untilSettled(next)

    expect(next.value).toEqual(complete(ONE_SHORT_OF_STOPPING + 5))
    expect(lookupsIn(log.slice(from))).toHaveLength(
      ONE_SHORT_OF_STOPPING - QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS + 2 * 5
    )
  })

  it(`stops riding out once it starts no more lookups: ${QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS + QBIT_BALANCE_READ_FAILED_LOOKUPS} lookups answered 502 once cost one request each`, async () => {
    vi.useFakeTimers()
    const count = QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS + QBIT_BALANCE_READ_FAILED_LOOKUPS
    const explorer = accountExplorer(count)
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      isLookup(path) && nth === 1 ? 502 : undefined
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    // The answer is decided once it stops: the ride-outs pausing make no
    // attempt more.
    expect(read.value).toEqual(incomplete(count, true))
    expect(read.at).toBe(0)
    expect(lookupsIn(log)).toHaveLength(count)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it(`starts no more lookups once ${QBIT_BALANCE_READ_FAILED_LOOKUPS} have failed`, async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    // Every lookup refused at once, never ridden out.
    const { fetchFn, log } = failing(explorer, path => (isLookup(path) ? 404 : undefined))
    const client = clientOf(fetchFn)
    // Four in flight at a time: four workers, each starting its next lookup
    // once its last has failed.
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 4 })

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(50, true))
    const sent = lookupsIn(log).length
    expect(sent).toBeGreaterThanOrEqual(QBIT_BALANCE_READ_FAILED_LOOKUPS)
    expect(sent).toBeLessThanOrEqual(4 + QBIT_BALANCE_READ_FAILED_LOOKUPS - 1)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
  })

  it.each([8, 12])(
    'keeps the split, as before, when %i walks of own change fail: those outputs Pending',
    async walks => {
      vi.useFakeTimers()
      const explorer = new FakeQbitExplorer()
      explorer.utxoLimit = 50_000
      explorer.registerAddress(main.address, main.script)
      // `walks` outputs of own change, each on an unconfirmed parent the
      // explorer refuses, and 20 payments.
      const parents = new Set<string>()
      for (let index = 0; index < walks; index += 1) {
        const parent = fakeTxid(index, 8_000_000)
        parents.add(txPath(parent))
        explorer.addTx({
          txid: parent,
          inputs: [{ txid: fakeTxid(index, 8_500_000), vout: 0 }],
          outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
        })
        explorer.addTx({
          txid: fakeTxid(index, 9_000_000),
          inputs: [{ txid: parent, vout: 0 }],
          outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
        })
      }
      fund(explorer, main, 20)
      const { fetchFn, log } = failing(explorer, path => (parents.has(path) ? 404 : undefined))

      const read = track(balanceOf(clientOf(fetchFn)))
      await untilSettled(read)

      // As 1.0.10 answers: the change is not shown to be the account's own.
      expect(read.value).toEqual({
        availableBalance: 20 * OUTPUT_VALUE,
        unavailableBalance: walks * OUTPUT_VALUE,
        totalBalance: (20 + walks) * OUTPUT_VALUE,
        immatureBalance: 0,
        pendingBalance: walks * OUTPUT_VALUE,
      })
      expect(lookupsIn(log).filter(path => parents.has(path))).toHaveLength(walks)
    }
  )

  it('keeps the split, as before, when 300 walks of own change fail, more groups than it has slots', async () => {
    vi.useFakeTimers()
    const explorer = new FakeQbitExplorer()
    explorer.utxoLimit = 50_000
    explorer.registerAddress(main.address, main.script)
    const parents = new Set<string>()
    for (let index = 0; index < 300; index += 1) {
      const parent = fakeTxid(index, 8_000_000)
      parents.add(txPath(parent))
      explorer.addTx({
        txid: parent,
        inputs: [{ txid: fakeTxid(index, 8_500_000), vout: 0 }],
        outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
      })
      explorer.addTx({
        txid: fakeTxid(index, 9_000_000),
        inputs: [{ txid: parent, vout: 0 }],
        outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
      })
    }
    fund(explorer, main, 20)
    const { fetchFn } = failing(explorer, path => (parents.has(path) ? 404 : undefined))

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual({
      availableBalance: 20 * OUTPUT_VALUE,
      unavailableBalance: 300 * OUTPUT_VALUE,
      totalBalance: 320 * OUTPUT_VALUE,
      immatureBalance: 0,
      pendingBalance: 300 * OUTPUT_VALUE,
    })
  })

  it('waits after its first failure, not after each: failures at 0, 2.5 and 5 s beside a lookup that never answers end it at 3 s', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(30)
    const { fetchFn } = failing(explorer, path =>
      path === txPath(fakeTxid(1))
        ? 404
        : path === txPath(fakeTxid(2))
          ? { status: 404, delayMs: 2_500 }
          : path === txPath(fakeTxid(3))
            ? { status: 404, delayMs: 5_000 }
            : path === txPath(fakeTxid(4))
              ? 'hang'
              : undefined
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(30, true))
    expect(read.at).toBe(QBIT_BALANCE_READ_FAILURE_GRACE_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts answers that fail the checks towards stopping: an explorer answering the wrong transaction is not read to the end', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    // Every lookup answered with a well-formed transaction of another txid.
    explorer.failures.push(({ path }) => {
      const tx = isLookup(path) ? explorer.txs.get(path.slice('/tx/'.length)) : undefined
      if (!tx) return undefined
      return {
        status: 200,
        body: JSON.stringify({ ...explorer.esploraTx(tx), txid: fakeTxid(1, 77_000_000) }),
      }
    })
    const { fetchFn, log } = failing(explorer, () => undefined)
    const client = clientOf(fetchFn)
    // Four in flight at a time: four workers, each starting its next lookup
    // once its last has failed.
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 4 })

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(50, true))
    const sent = lookupsIn(log).length
    expect(sent).toBeGreaterThanOrEqual(QBIT_BALANCE_READ_FAILED_LOOKUPS)
    expect(sent).toBeLessThanOrEqual(4 + QBIT_BALANCE_READ_FAILED_LOOKUPS - 1)
    expect(fundingTxReads.size).toBe(0)
  })

  it('lets the lookups in flight run to their end once it starts no more, and keeps what they read', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    explorer.slowResponses.push({
      match: request => isLookup(request.path),
      chunkBytes: 1 << 20,
      intervalMs: 100,
    })
    // The first eight refused at once; the rest answered 100 ms on.
    const refused = new Set(Array.from({ length: 8 }, (_, index) => txPath(fakeTxid(index))))
    const { fetchFn, log } = failing(explorer, path => (refused.has(path) ? 404 : undefined))
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 16 })

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(50, true))
    const sent = lookupsIn(log)
    expect(sent.length).toBeLessThan(50)
    // Every lookup sent that was not refused was answered, and kept.
    expect(fundingTxReads.size).toBe(sent.length - refused.size)
    expect(explorer.abortedRequests).toEqual([])
  })

  it.each([
    // The explorer's own: one request a client call, answered at once.
    ['its own 502 (Retry-After: 60)', EXPLORERS_RETRY_AFTER, 1, MOST_LOOKUPS, 0],
    // The client's three requests a call, 300 ms and 600 ms apart: the
    // first lookups fail at 0.9 s, and those started before it stopped
    // after one more call.
    [
      'a 502 the client retries itself',
      null,
      3,
      3 * (MOST_LOOKUPS - QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS),
      900,
    ],
  ] as const)(
    'sends a bounded number of lookup requests to an explorer that fails every one with %s, and answers as soon as it stops',
    async (_label, retryAfter, perCall, most, at) => {
      vi.useFakeTimers()
      const explorer = accountExplorer(1_000)
      const { fetchFn, log } = failing(explorer, path => (isLookup(path) ? 502 : undefined), {
        retryAfter,
      })
      const client = clientOf(fetchFn)
      const fundingTxReads = new QbitFundingTxReads()

      const read = track(balanceOf(client, fundingTxReads))
      await untilSettled(read)

      expect(read.value).toEqual(incomplete(1_000, true))
      // Stopped with its first lookups, the ride-outs pausing cut short.
      expect(read.at).toBeLessThanOrEqual(2 * at)
      expect(read.at).toBeGreaterThanOrEqual(at)
      const sent = lookupsIn(log).length
      expect(sent).toBeGreaterThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT * perCall)
      expect(sent).toBeLessThanOrEqual(most)
      const limiter = fundingTxReads.limiter(client)
      expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('makes three attempts each at the statistics, listing and tip of an explorer that fails them all, and rejects with the 502', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    const { fetchFn, log } = failing(explorer, () => 502)

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.error).toMatchObject({ kind: 'http', status: 502 })
    expect(read.at).toBe(2_000)
    expect(requestsTo(log, STATS)).toEqual([0, 500, 2_000])
    expect(log.length).toBeLessThanOrEqual(9)
    expect(lookupsIn(log)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('two balance reads of one address at once, as the poll and another caller make them', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('share the statistics, listing and lookups, a retry included: neither fails, and none shared is asked for twice where one read alone asks once', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    // Every reply 50 ms on, so that a request is still in flight when the
    // other read asks for the same.
    explorer.slowResponses.push({
      match: () => true,
      chunkBytes: 1 << 20,
      intervalMs: 50,
    })
    const victim = txPath(fakeTxid(25))
    const { fetchFn, log } = failing(
      explorer,
      (path, nth) =>
        (path === STATS || path === LISTING || path === victim) && nth === 1 ? 502 : undefined,
      { delayMs: 50 }
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const poll = track(balanceOf(client, fundingTxReads))
    const other = track(balanceOf(client, fundingTxReads))
    await untilSettled(poll)
    await untilSettled(other)

    expect(poll.value).toEqual(complete(50))
    expect(other.value).toEqual(complete(50))
    // As one read alone: a 502 and one more request for each of the three
    // answered 502 once, the tip once, and every other lookup once.
    expect(requestsTo(log, STATS)).toEqual([0, 550])
    expect(requestsTo(log, LISTING)).toEqual([0, 550])
    // Each read asks for the listing again, fresh, as its statistics answered
    // on their second attempt: a fresh read is never shared.
    expect(
      log.filter(request => request.path.startsWith(`${LISTING}?`)).map(request => request.at)
    ).toEqual([600, 600])
    expect(requestsTo(log, TIP)).toEqual([0])
    expect(requestsTo(log, victim)).toHaveLength(2)
    expect(lookupsIn(log)).toHaveLength(51)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the balance read, when its statistics answer on a later attempt than its listing was asked for with', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const foreign = account('33')

  /**
   * Ten payments a coinbase maturity deep and, once `land` is called, a block
   * that spends the first to another address and pays the account a young
   * reward of five payments.
   */
  function blockLater() {
    const explorer = new FakeQbitExplorer()
    explorer.utxoLimit = 50_000
    explorer.registerAddress(foreign.address, foreign.script)
    explorer.registerAddress(main.address, main.script)
    for (let index = 0; index < 10; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index),
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
        height: explorer.tipHeight - 1_200,
      })
    }
    let landed = false
    const land = (): void => {
      if (landed) return
      landed = true
      explorer.addTx({
        txid: fakeTxid(1, 12_000_000),
        inputs: [{ txid: fakeTxid(0), vout: 0 }],
        outputs: [{ address: foreign.address, script: foreign.script, value: OUTPUT_VALUE - 100 }],
        height: explorer.tipHeight,
      })
      explorer.addTx({
        txid: fakeTxid(2, 12_000_000),
        inputs: [],
        outputs: [{ address, script: main.script, value: 5 * OUTPUT_VALUE }],
        height: explorer.tipHeight,
        coinbase: true,
      })
    }
    return { explorer, land }
  }

  /** What a read with nothing kept gives for the explorer as it is now. */
  async function freshRead(explorer: FakeQbitExplorer) {
    const read = track(balanceOf(clientOf(failing(explorer, () => undefined).fetchFn)))
    await untilSettled(read)
    return read.value
  }

  /** The account once the block has landed: one payment spent, a young reward. */
  const AFTER_THE_BLOCK = {
    availableBalance: 9 * OUTPUT_VALUE,
    unavailableBalance: 5 * OUTPUT_VALUE,
    totalBalance: 14 * OUTPUT_VALUE,
    immatureBalance: 5 * OUTPUT_VALUE,
    pendingBalance: 0,
  }

  it.each(
    (
      [
        // The wallet's own second attempt, 500 ms on.
        ["the explorer's 502 (Retry-After: 60)", 502, EXPLORERS_RETRY_AFTER, [0, 500]],
        // The client's own, 300 ms on.
        ['a 502 the client retries itself', 502, null, [0, 300]],
        // The client's own, after the second it is told to wait.
        ['a 503 with Retry-After: 1', 503, '1', [0, 1_000]],
      ] as const
    ).flatMap(([label, ...rest]) => [
      [label, false, ...rest] as const,
      [label, true, ...rest] as const,
    ])
  )(
    'asks for the listing again when the statistics answered %s once and a block landed after the listing (reuse: %s)',
    async (_label, withReuse, status, retryAfter, statsAt) => {
      vi.useFakeTimers()
      const { explorer, land } = blockLater()
      // The block lands once the first listing has been served.
      const { fetchFn, log } = failing(
        explorer,
        (path, nth) => (path === STATS && nth === 1 ? status : undefined),
        { retryAfter, served: path => (path === LISTING ? land() : undefined) }
      )

      const read = track(
        balanceOf(clientOf(fetchFn), new QbitFundingTxReads(), {
          ...(withReuse ? { reuse: new QbitBalanceReuse().begin() } : {}),
        })
      )
      await untilSettled(read)

      // Never more Available than a fresh read of the same explorer gives.
      expect(read.value).toEqual(AFTER_THE_BLOCK)
      expect(read.value).toEqual(await freshRead(explorer))
      expect(requestsTo(log, STATS)).toEqual(statsAt)
      // The first listing, and one asked for fresh once the statistics answered.
      expect(requestsTo(log, LISTING)).toEqual([0])
      expect(
        log.filter(request => request.path.startsWith(`${LISTING}?`)).map(request => request.at)
      ).toEqual([statsAt[1]])
    }
  )

  it.each([false, true])(
    'asks for the listing once, as before, when the statistics answer first time (reuse: %s)',
    async withReuse => {
      vi.useFakeTimers()
      const explorer = accountExplorer(50)
      const { fetchFn, log } = failing(explorer, () => undefined)

      const read = track(
        balanceOf(clientOf(fetchFn), new QbitFundingTxReads(), {
          ...(withReuse ? { reuse: new QbitBalanceReuse().begin() } : {}),
        })
      )
      await untilSettled(read)

      expect(read.value).toEqual(complete(50))
      expect(log.filter(request => !isLookup(request.path)).map(request => request.path)).toEqual([
        STATS,
        TIP,
        LISTING,
      ])
      expect(lookupsIn(log)).toHaveLength(50)
    }
  )

  it('takes a listing newer than the statistics as it is: Available is then bounded by the older statistics', async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    // The statistics answer at once, before the block; the listing is
    // answered 502 once and read again 500 ms on, after it.
    const { fetchFn, log } = failing(
      explorer,
      (path, nth) => (path === LISTING && nth === 1 ? 502 : undefined),
      { served: path => (path === STATS ? land() : undefined) }
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    // The older statistics' confirmed balance (ten payments) bounds what the
    // newer listing can spend (nine), which is what a fresh read gives.
    expect(read.value).toMatchObject({ availableBalance: 9 * OUTPUT_VALUE })
    expect((read.value as { availableBalance: number }).availableBalance).toBeLessThanOrEqual(
      ((await freshRead(explorer)) as { availableBalance: number }).availableBalance
    )
    expect(requestsTo(log, STATS)).toEqual([0])
    expect(requestsTo(log, LISTING)).toEqual([0, 500])
    expect(log.some(request => request.path.startsWith(`${LISTING}?`))).toBe(false)
  })

  it.each([
    // The client waits the second it is told to, then asks again.
    ['a 503 with Retry-After: 1, joined 500 ms in', 503, '1', 500, 1],
    // The client asks again 300 ms on.
    ['a 502 without Retry-After, joined 100 ms in', 502, null, 100, 1],
    // Between the client's second and third requests, 300 ms and 900 ms on.
    ['a 502 without Retry-After twice, joined 500 ms in', 502, null, 500, 2],
  ] as const)(
    "asks for the listing again when it joined another caller's request for the statistics that the client then read again: %s",
    async (_label, status, retryAfter, joinAt, failures) => {
      vi.useFakeTimers()
      const { explorer, land } = blockLater()
      const { fetchFn, log } = failing(
        explorer,
        (path, nth) => (path === STATS && nth <= failures ? status : undefined),
        { retryAfter, served: path => (path === LISTING ? land() : undefined) }
      )
      const client = clientOf(fetchFn)
      // Another caller's read of the statistics, not fresh, which the read joins.
      const otherStats = track(client.getAddressBalance(address))
      await vi.advanceTimersByTimeAsync(joinAt)

      const read = track(balanceOf(client))
      await untilSettled(read)
      await untilSettled(otherStats)

      // The request that answered went out after the read's listing did.
      expect(read.value).toEqual(AFTER_THE_BLOCK)
      expect(read.value).toEqual(await freshRead(explorer))
      expect(log.filter(request => request.path.startsWith(`${LISTING}?`))).toHaveLength(1)
    }
  )

  it("asks for the listing again in each of two overlapping balance reads, the second joining the first's statistics request after it went out", async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    let listings = 0
    // The statistics' first request answered 502, which the client reads
    // again 300 ms on; the block lands once the second read's listing has
    // been served.
    const { fetchFn } = failing(
      explorer,
      (path, nth) => (path === STATS && nth === 1 ? 502 : undefined),
      {
        retryAfter: null,
        served: path => {
          if (path === LISTING && ++listings === 2) land()
        },
      }
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const first = track(balanceOf(client, fundingTxReads))
    await vi.advanceTimersByTimeAsync(100)
    const second = track(balanceOf(client, fundingTxReads))
    await untilSettled(first)
    await untilSettled(second)

    expect(first.value).toEqual(AFTER_THE_BLOCK)
    expect(second.value).toEqual(AFTER_THE_BLOCK)
  })

  it("asks for the listing again when it joins another read's listing request, sent before its own request for the statistics", async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    // The listing answered 300 ms on, as of when it was asked for; the block
    // lands 50 ms in, before the second read asks for the statistics.
    explorer.slowResponses.push({
      match: request => request.path === LISTING,
      chunkBytes: 1 << 20,
      intervalMs: 300,
    })
    const { fetchFn, log } = failing(explorer, () => undefined)
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const first = track(balanceOf(client, fundingTxReads))
    await vi.advanceTimersByTimeAsync(50)
    land()
    await vi.advanceTimersByTimeAsync(50)
    const second = track(balanceOf(client, fundingTxReads))
    await untilSettled(first)
    await untilSettled(second)

    // The second read's statistics, after the block, are newer than the
    // listing it joined: it lists again.
    expect(second.value).toEqual(AFTER_THE_BLOCK)
    expect(requestsTo(log, LISTING)).toEqual([0])
    expect(log.filter(request => request.path.startsWith(`${LISTING}?`)).map(r => r.at)).toEqual([
      100,
    ])
  })

  it('asks for the listing once when it joins a request for the statistics that answers first time', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    // Every statistics reply 100 ms on, so the read joins one in flight.
    explorer.slowResponses.push({
      match: request => request.path === STATS,
      chunkBytes: 1 << 20,
      intervalMs: 100,
    })
    const { fetchFn, log } = failing(explorer, () => undefined)
    const client = clientOf(fetchFn)
    const switcher = track(client.getAddressBalance(address))
    await vi.advanceTimersByTimeAsync(50)

    const read = track(balanceOf(client))
    await untilSettled(read)
    await untilSettled(switcher)

    expect(read.value).toEqual(complete(20))
    expect(requestsTo(log, STATS)).toEqual([0])
    expect(
      log.filter(request => request.path.split('?')[0] === LISTING).map(request => request.path)
    ).toEqual([LISTING])
  })

  it('takes no fresh request for the statistics another caller sends while its own are in flight for a newer one', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    explorer.slowResponses.push({
      match: request => request.path === STATS,
      chunkBytes: 1 << 20,
      intervalMs: 200,
    })
    const { fetchFn, log } = failing(explorer, () => undefined)
    const client = clientOf(fetchFn)

    const read = track(balanceOf(client))
    await vi.advanceTimersByTimeAsync(100)
    // Another caller's fresh read of the statistics, which joins no other.
    const other = track(client.getAddressStats(address, { fresh: true } as RequestOptions))
    await untilSettled(read)
    await untilSettled(other)

    // No read joins a fresh request, so none counts: one listing, as before.
    expect(read.value).toEqual(complete(20))
    expect(
      log.filter(request => request.path.split('?')[0] === LISTING).map(request => request.at)
    ).toEqual([0])
  })

  it('asks for the listing again when the counts of statistics requests started again at their cap while it read', async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    let onStatsSent: (() => void) | undefined
    const { fetchFn } = failing(
      explorer,
      // Answered 10 ms on, once the read has asked for its listing.
      (path, nth) => (path === STATS && nth === 1 ? { status: 502, delayMs: 10 } : undefined),
      {
        retryAfter: null,
        served: path => {
          if (path === LISTING) land()
          if (path === STATS) onStatsSent?.()
        },
      }
    )
    const client = clientOf(fetchFn)
    // 4,095 other addresses' statistics, so the account's is the 4,096th counted.
    const addresses = Array.from({ length: 4_096 }, (_, index) =>
      p2mrAddressFromPubkey(hexToBytes((index + 1).toString(16).padStart(64, '0')), 'testnet4')
    )
    for (const other of addresses.slice(0, 4_095))
      await client.getAddressBalance(other).catch(() => undefined)
    // One more address before the client's second request for the account's:
    // the counts start again, and the account's reads 1 after it as before.
    onStatsSent = () => {
      onStatsSent = undefined
      void client.getAddressBalance(addresses[4_095]!).catch(() => undefined)
    }

    const read = track(balanceOf(client))
    await untilSettled(read)

    expect(read.value).toEqual(AFTER_THE_BLOCK)
  })

  it.each([
    // The explorer's own 502, answered at once.
    ["the explorer's 502 (Retry-After: 60), answered at once", EXPLORERS_RETRY_AFTER, 0, 1],
    // A 502 the client retries twice itself, each answered 300 ms on.
    ['a 502 without Retry-After, answered 300 ms on', null, 300, 3],
  ] as const)(
    'keeps to the bounds of a read that lists once when it lists again and every lookup fails with %s',
    async (_label, retryAfter, delayMs, perCall) => {
      vi.useFakeTimers()
      const counts = async (listsAgain: boolean) => {
        const explorer = accountExplorer(1_000)
        const { fetchFn, log } = failing(
          explorer,
          (path, nth) =>
            listsAgain && path === STATS && nth === 1
              ? 502
              : isLookup(path)
                ? { status: 502, delayMs }
                : undefined,
          { retryAfter }
        )
        const client = clientOf(fetchFn)
        const fundingTxReads = new QbitFundingTxReads()

        const read = track(balanceOf(client, fundingTxReads))
        await untilSettled(read)

        expect(read.value).toEqual(incomplete(1_000, true))
        expect(log.filter(request => request.path.startsWith(`${LISTING}?`))).toHaveLength(
          listsAgain ? 1 : 0
        )
        const limiter = fundingTxReads.limiter(client)
        expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
        expect(vi.getTimerCount()).toBe(0)
        const lookups = log.filter(request => isLookup(request.path))
        return { started: new Set(lookups.map(request => request.path)).size, sent: lookups.length }
      }

      const once = await counts(false)
      const again = await counts(true)

      // One classification: listing again costs no lookup more.
      expect(again).toEqual(once)
      expect(again.started).toBeLessThanOrEqual(
        QBIT_CLASSIFY_MAX_READS_IN_FLIGHT + QBIT_BALANCE_READ_FAILED_LOOKUPS - 1
      )
      expect(again.sent).toBeLessThanOrEqual(
        perCall *
          (QBIT_CLASSIFY_MAX_READS_IN_FLIGHT +
            QBIT_BALANCE_READ_FAILED_LOOKUPS -
            1 +
            2 * QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS)
      )
    }
  )

  it('stops a first listing that never answers as it throws it away, and answers from the one asked for again', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(30)
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === STATS && nth === 1 ? 502 : path === LISTING ? 'hang' : undefined
    )
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(clientOf(fetchFn), fundingTxReads))
    await untilSettled(read)
    await vi.advanceTimersByTimeAsync(0)

    expect(read.value).toEqual(complete(30))
    expect(read.at).toBe(500)
    // Nothing of the first listing is left in flight.
    expect(log.filter(request => !request.ended)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("judges a reward the block paid by the read's one tip, which answers only after it lists again", async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    // The tip answers 1 s on, after the listing asked for again.
    let tips = 0
    explorer.slowResponses.push({
      match: request => request.path === TIP && tips++ === 0,
      chunkBytes: 1 << 20,
      intervalMs: 1_000,
    })
    const { fetchFn } = failing(
      explorer,
      (path, nth) => (path === STATS && nth === 1 ? 502 : undefined),
      {
        served: path => (path === LISTING ? land() : undefined),
      }
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual(AFTER_THE_BLOCK)
  })

  it.each([
    // The verifier's: eight lookups answered 502 once, their replies 100 ms
    // late, so their pauses end at 600 ms, after the read lists again at 500.
    ['eight lookups answered 502 once, 100 ms late', 0, 100],
    // The review's: the statistics answered 502 at 200 ms, read again at
    // 700; each lookup answered 502 at 300 ms, read again at 800.
    ['every lookup answered 502 once, 300 ms late, the statistics 200 ms late', 200, 300],
  ] as const)(
    'rides out a burst that also hit its statistics: %s, and completes',
    async (_label, statsDelayMs, lookupDelayMs) => {
      vi.useFakeTimers()
      const count = statsDelayMs === 0 ? 50 : 10
      const explorer = accountExplorer(count)
      const victims = new Set(
        Array.from(
          { length: statsDelayMs === 0 ? QBIT_BALANCE_READ_FAILED_LOOKUPS : count },
          (_, index) => txPath(fakeTxid(index))
        )
      )
      const { fetchFn, log } = failing(explorer, (path, nth) =>
        path === STATS && nth === 1
          ? { status: 502, delayMs: statsDelayMs }
          : victims.has(path) && nth === 1
            ? { status: 502, delayMs: lookupDelayMs }
            : undefined
      )
      const fundingTxReads = new QbitFundingTxReads()

      const read = track(balanceOf(clientOf(fetchFn), fundingTxReads))
      await untilSettled(read)

      // Its lookups, all of the listing asked for again, rode the burst out.
      expect(read.value).toEqual(complete(count))
      expect(log.filter(request => request.path.startsWith(`${LISTING}?`))).toHaveLength(1)
      expect(fundingTxReads.size).toBe(count)
    }
  )

  it('classifies the listing asked for again once it has answered, though it comes late, and rides out a burst its lookups meet', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    // The read lists again at 500 ms, and the fresh listing comes 300 ms
    // late, so its classification begins at 800; eight of its lookups are
    // answered 502 once, 100 ms late, and made again 500 ms on.
    explorer.slowResponses.push({
      match: request => request.path.startsWith(`${LISTING}?`),
      chunkBytes: 1 << 20,
      intervalMs: 300,
    })
    const victims = new Set(
      Array.from({ length: QBIT_BALANCE_READ_FAILED_LOOKUPS }, (_, index) =>
        txPath(fakeTxid(index))
      )
    )
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === STATS && nth === 1
        ? 502
        : victims.has(path) && nth === 1
          ? { status: 502, delayMs: 100 }
          : undefined
    )

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    // No lookup went out before the listing it classifies had answered.
    expect(read.value).toEqual(complete(50))
    for (const victim of victims) expect(requestsTo(log, victim)).toEqual([800, 1_400])
    expect(
      Math.min(...log.filter(request => isLookup(request.path)).map(request => request.at))
    ).toBe(800)
  })

  it.each(
    [8, 16, 17, 20, 32].flatMap(burst =>
      (['first', 'last', 'spread'] as const).flatMap(position =>
        (['quick', 'outlasting'] as const).map(shape => [burst, position, shape] as const)
      )
    )
  )(
    'completes when the statistics were answered 502 once and %i lookups (the %s of 40) 502 too, %s',
    async (burst, position, shape) => {
      vi.useFakeTimers()
      const explorer = accountExplorer(40)
      const indices = Array.from({ length: burst }, (_, index) =>
        position === 'first'
          ? index
          : position === 'last'
            ? 40 - burst + index
            : Math.floor((index * 40) / burst)
      )
      const victims = new Set(indices.map(index => txPath(fakeTxid(index))))
      const start = Date.now()
      // Quick: each answered 502 at once, once. Outlasting: the explorer
      // answers them 502 for 1.2 s, past the statistics' second attempt at
      // 500 ms, so each lookup meets it twice.
      const { fetchFn, log } = failing(explorer, (path, nth) =>
        path === STATS && nth === 1
          ? 502
          : victims.has(path) && (shape === 'quick' ? nth === 1 : Date.now() - start < 1_200)
            ? 502
            : undefined
      )
      const fundingTxReads = new QbitFundingTxReads()

      const read = track(balanceOf(clientOf(fetchFn), fundingTxReads))
      await untilSettled(read)

      // Each burst-hit lookup took one ride-out of the read's 32.
      expect(read.value).toEqual(complete(40))
      expect(fundingTxReads.size).toBe(40)
      expect(log.filter(request => request.path.startsWith(`${LISTING}?`))).toHaveLength(1)
      for (const victim of victims) {
        expect(requestsTo(log, victim)).toHaveLength(shape === 'quick' ? 2 : 3)
      }
      expect(lookupsIn(log)).toHaveLength(40 + burst * (shape === 'quick' ? 1 : 2))
    }
  )

  it('never classifies the listing it throws away: no lookup is sent for it', async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    // A young payment, in the first listing only: the block spends it.
    explorer.addTx({
      txid: fakeTxid(3, 12_000_000),
      inputs: [{ txid: fakeTxid(4, 12_000_000), vout: 0 }],
      outputs: [{ address, script: main.script, value: OUTPUT_VALUE }],
      height: explorer.tipHeight - 600,
    })
    const young = txPath(fakeTxid(3, 12_000_000))
    const { fetchFn, log } = failing(
      explorer,
      (path, nth) => (path === STATS && nth === 1 ? 502 : undefined),
      {
        served: path => {
          if (path !== LISTING) return
          land()
          explorer.addTx({
            txid: fakeTxid(5, 12_000_000),
            inputs: [{ txid: fakeTxid(3, 12_000_000), vout: 0 }],
            outputs: [
              { address: foreign.address, script: foreign.script, value: OUTPUT_VALUE - 100 },
            ],
            height: explorer.tipHeight,
          })
        },
      }
    )
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(clientOf(fetchFn), fundingTxReads))
    await untilSettled(read)
    const fresh = failing(explorer, () => undefined)
    const freshValue = track(balanceOf(clientOf(fresh.fetchFn)))
    await untilSettled(freshValue)

    expect(read.value).toEqual(AFTER_THE_BLOCK)
    expect(read.value).toEqual(freshValue.value)
    // The first listing was served at once and thrown away at 500 ms; the
    // lookups are those of a fresh read, every one after the listing asked
    // for again.
    expect(requestsTo(log, young)).toEqual([])
    expect(new Set(lookupsIn(log))).toEqual(new Set(lookupsIn(fresh.log)))
    expect(log.filter(request => isLookup(request.path)).every(request => request.at >= 500)).toBe(
      true
    )
  })

  it('starts no lookup until the statistics answer, though the listing answered first: they start when the statistics do', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    // The statistics answer 300 ms on, the listing at once.
    explorer.slowResponses.push({
      match: request => request.path === STATS,
      chunkBytes: 1 << 20,
      intervalMs: 300,
    })
    const { fetchFn, log } = failing(explorer, () => undefined)

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual(complete(20))
    expect(log.filter(request => !isLookup(request.path)).map(request => request.path)).toEqual([
      STATS,
      TIP,
      LISTING,
    ])
    expect(
      new Set(log.filter(request => isLookup(request.path)).map(request => request.at))
    ).toEqual(new Set([300]))
  })

  it.each([
    ["the explorer's refusal, a 413", 'refused'],
    ['a bare 500', 500],
    ['a 502 once', 'once'],
    ['a 502 throughout', 502],
    ['no answer', 'hang'],
  ] as const)(
    'judges a listing asked for again met with %s as a first listing so met, by its deadline, leaving nothing behind',
    async (_label, fate) => {
      vi.useFakeTimers()
      const outcome = async (listsAgain: boolean) => {
        const explorer = accountExplorer(30)
        if (fate === 'refused' && !listsAgain) explorer.utxoLimit = 20
        let listings = 0
        const { fetchFn, log } = failing(
          explorer,
          (path, nth) => {
            if (listsAgain && path === STATS && nth === 1) return 502
            const target = listsAgain ? path.startsWith(`${LISTING}?`) : path === LISTING
            if (!target || fate === 'refused') return undefined
            listings += 1
            if (fate === 'once') return listings === 1 ? 502 : undefined
            return fate
          },
          {
            served: path => {
              // Refused once the first listing has been served.
              if (fate === 'refused' && listsAgain && path === LISTING) explorer.utxoLimit = 20
            },
          }
        )
        const client = clientOf(fetchFn)
        const fundingTxReads = new QbitFundingTxReads()

        const read = track(balanceOf(client, fundingTxReads))
        await untilSettled(read)

        expect(read.settled).toBe(true)
        expect(read.at).toBeLessThanOrEqual(QBIT_BALANCE_READ_DEADLINE_MS)
        const limiter = fundingTxReads.limiter(client)
        expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
        expect(vi.getTimerCount()).toBe(0)
        expect(log.filter(request => !request.ended)).toEqual([])
        const sent = log.length
        await vi.advanceTimersByTimeAsync(30_000)
        expect(log).toHaveLength(sent)
        return read.value
      }

      const first = await outcome(false)
      expect(await outcome(true)).toEqual(first)
    }
  )

  it.each([
    ["during the statistics' pause", 200],
    ['while the listing asked for again is in flight', 600],
    ['while a lookup of it pauses after a 502', 1_000],
  ] as const)(
    "rejects with the caller's reason when the caller gives up %s, leaving nothing behind",
    async (_label, abortAt) => {
      vi.useFakeTimers()
      const explorer = accountExplorer(20)
      // The fresh listing answers 300 ms on, at 800 ms; one lookup of it is
      // answered 502 once, and made again 500 ms on.
      explorer.slowResponses.push({
        match: request => request.path.startsWith(`${LISTING}?`),
        chunkBytes: 1 << 20,
        intervalMs: 300,
      })
      const victim = txPath(fakeTxid(7))
      const { fetchFn, log } = failing(explorer, (path, nth) =>
        path === STATS && nth === 1 ? 502 : path === victim && nth === 1 ? 502 : undefined
      )
      const client = clientOf(fetchFn)
      const fundingTxReads = new QbitFundingTxReads()
      const caller = new AbortController()
      const reason = new Error('the popup closed')

      const read = track(balanceOf(client, fundingTxReads, { signal: caller.signal }))
      await vi.advanceTimersByTimeAsync(abortAt)
      expect(read.settled).toBe(false)
      caller.abort(reason)
      await vi.advanceTimersByTimeAsync(0)

      expect(read).toMatchObject({ settled: true, error: reason, at: abortAt })
      const limiter = fundingTxReads.limiter(client)
      expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
      expect(vi.getTimerCount()).toBe(0)
      expect(log.filter(request => !request.ended)).toEqual([])
      const sent = log.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(log).toHaveLength(sent)
    }
  )

  it('asks for the listing again when it joins a listing call that the counts carried over as they started again at their cap', async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    // Another caller's listing, as of 0 ms, delivered 1 s on; another
    // caller's statistics, asked for at 100 ms, after the block, delivered
    // 500 ms on.
    explorer.slowResponses.push(
      { match: request => request.path === LISTING, chunkBytes: 1 << 20, intervalMs: 1_000 },
      { match: request => request.path === STATS, chunkBytes: 1 << 20, intervalMs: 500 }
    )
    const { fetchFn } = failing(explorer, () => undefined)
    const client = clientOf(fetchFn)
    // 4,095 other addresses counted already.
    const addresses = Array.from({ length: 4_097 }, (_, index) =>
      p2mrAddressFromPubkey(hexToBytes((index + 1).toString(16).padStart(64, '0')), 'testnet4')
    )
    for (const other of addresses.slice(0, 4_095)) await client.getAddressBalance(other)
    const otherListing = client.getAddressUtxos(address)
    await vi.advanceTimersByTimeAsync(50)
    land()
    await vi.advanceTimersByTimeAsync(50)
    const otherStats = client.getAddressBalance(address)
    await vi.advanceTimersByTimeAsync(100)
    // Two more addresses: the counts start again, but for the account's,
    // whose listing call is still under way.
    await client.getAddressBalance(addresses[4_095]!)
    await client.getAddressBalance(addresses[4_096]!)
    await vi.advanceTimersByTimeAsync(100)

    // The read joins both: its statistics went out after that listing.
    const read = track(balanceOf(client))
    await untilSettled(read)
    await untilSettled(track(otherListing))
    await untilSettled(track(otherStats))

    expect(read.value).toEqual(AFTER_THE_BLOCK)
  })

  it('notes the end of a listing call that started the counts again: later polls list once', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(20)
    const { fetchFn, log } = failing(explorer, () => undefined)
    const client = clientOf(fetchFn)
    // 4,096 addresses counted: the account's listing is the call that starts
    // the counts again.
    const addresses = Array.from({ length: 4_096 }, (_, index) =>
      p2mrAddressFromPubkey(hexToBytes((index + 1).toString(16).padStart(64, '0')), 'testnet4')
    )
    for (const other of addresses) await client.getAddressBalance(other)
    await client.getAddressUtxos(address)

    for (let poll = 0; poll < 3; poll += 1) {
      const from = log.length
      const read = track(balanceOf(client))
      await untilSettled(read)
      expect(read.value).toEqual(complete(20))
      // No listing call is left counted as under way: no second listing.
      expect(
        log.slice(from).filter(request => request.path.split('?')[0] === LISTING)
      ).toHaveLength(1)
    }
  })

  it('counts from the listing it joins, which a fresh listing another caller sends does not move', async () => {
    vi.useFakeTimers()
    const { explorer, land } = blockLater()
    // One caller's listing, as of 0 ms, delivered 500 ms on; the block lands
    // 20 ms in; another caller asks for the statistics at 30 ms, delivered
    // 300 ms on; a third asks for the listing fresh at 40 ms.
    explorer.slowResponses.push(
      { match: request => request.path === LISTING, chunkBytes: 1 << 20, intervalMs: 500 },
      { match: request => request.path === STATS, chunkBytes: 1 << 20, intervalMs: 300 }
    )
    const { fetchFn } = failing(explorer, () => undefined)
    const client = clientOf(fetchFn)
    const listing = client.getAddressUtxos(address)
    await vi.advanceTimersByTimeAsync(20)
    land()
    await vi.advanceTimersByTimeAsync(10)
    const stats = client.getAddressBalance(address)
    await vi.advanceTimersByTimeAsync(10)
    const freshListing = client.getAddressUtxos(address, { fresh: true } as RequestOptions)
    await vi.advanceTimersByTimeAsync(10)

    // The read joins both calls: its statistics went out after the listing.
    const read = track(balanceOf(client))
    await untilSettled(read)
    await untilSettled(track(Promise.all([listing, stats, freshListing])))

    expect(read.value).toEqual(AFTER_THE_BLOCK)
  })

  it('keeps nothing for reuse from a read whose statistics answered on a later attempt', async () => {
    const account = new ReuseAccount()
    let failed = 0
    account.explorer.failures.push(({ path }) =>
      route(path) === REUSE_STATS && failed++ === 0
        ? { status: 502, body: BAD_GATEWAY_PAGE, headers: { 'retry-after': '60' } }
        : undefined
    )

    const first = await account.poll()
    const next = await account.poll()

    expect(first.value).toEqual(split({ available: sum(account.payments) }))
    expect(first.requests.map(route)).toEqual([
      REUSE_STATS,
      REUSE_TIP,
      REUSE_LISTING,
      REUSE_STATS,
      REUSE_LISTING,
    ])
    // No candidate was kept, so the next poll lists as with nothing kept, not fresh.
    expect(next.requests.slice(0, 3)).toEqual([REUSE_STATS, REUSE_TIP, REUSE_LISTING])
  })

  it("confirms a kept candidate with one fresh listing while another caller's listing is in flight, and the next poll reuses it", async () => {
    const account = new ReuseAccount()
    const first = await account.poll()
    // Another caller's listing, not fresh, as the Send screen's, held in
    // flight while the next poll confirms the candidate the first kept.
    const held = account.hold(path => path === REUSE_LISTING)
    const other = account.client.getAddressUtxos(REUSE_ADDRESS)
    await held.arrived

    const confirming = await account.poll()
    held.release()
    await other
    const reusing = await account.poll()

    expect(first.value).toEqual(split({ available: sum(account.payments) }))
    expect(confirming.value).toEqual(first.value)
    // Its listing is fresh and joins no call: its own statistics, sent
    // before it, are not newer than it, so it lists once.
    expect(confirming.requests.map(route)).toEqual([REUSE_STATS, REUSE_TIP, REUSE_LISTING])
    expect(confirming.requests[2]).not.toBe(REUSE_LISTING)
    expect(reusing.value).toEqual(first.value)
    expect(reusing.requests.map(route)).toEqual([REUSE_STATS, REUSE_TIP])
  })
})

describe("a balance read's classification, once it starts no more lookups", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends no further attempt of a lookup waiting for a slot', async () => {
    vi.useFakeTimers()
    const txid = fakeTxid(1)
    const sent: number[] = []
    const start = Date.now()
    const client = {
      getTx: (requested: string): Promise<never> => {
        sent.push(Date.now() - start)
        return Promise.reject(
          new QbitApiError('http', `HTTP 502 from /tx/${requested}`, {
            status: 502,
            url: `${BASE}/tx/${requested}`,
          })
        )
      },
    }
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 1 })
    const reads = new QbitClassificationReads(
      client as never,
      fundingTxReads,
      undefined,
      undefined,
      false,
      false,
      true
    )
    // The one slot, held by another read until it is let go.
    let letGo: () => void = () => undefined
    const holding = fundingTxReads
      .limiter(client)
      .run(() => new Promise<void>(resolve => (letGo = resolve)))

    const lookup = reads.tx(txid, true).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    // Its first attempt waits for the slot; let it go out, and fail.
    letGo()
    await holding
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([0])
    // Its further attempt, due at 500 ms, then waits for the slot again.
    const again = fundingTxReads
      .limiter(client)
      .run(() => new Promise<void>(resolve => (letGo = resolve)))
    await vi.advanceTimersByTimeAsync(500)
    // Answers that failed the checks, enough to stop it.
    for (let failure = 0; failure < QBIT_BALANCE_READ_FAILED_LOOKUPS; failure += 1)
      reads.answerRefused()
    letGo()
    await again
    await vi.advanceTimersByTimeAsync(0)

    // Refused at the slot: no second request.
    expect(reads.taking).toBe(false)
    expect(sent).toEqual([0])
    expect(await lookup).toMatchObject({ kind: 'aborted' })
    reads.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the balance read, when one of its reads keeps failing or never answers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives a lookup answered 502 without Retry-After, which the client retries itself, one client call more: it fails at 2.3 s after six requests', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(50)
    const victim = txPath(fakeTxid(25))
    const { fetchFn, log } = failing(explorer, path => (path === victim ? 502 : undefined), {
      retryAfter: null,
    })

    const read = track(balanceOf(clientOf(fetchFn)))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(50, true))
    // Two client calls of three requests, 300 ms and 600 ms apart, 500 ms
    // between them; a third would begin at 3.8 s, past the 3 s ride-out.
    expect(requestsTo(log, victim)).toEqual([0, 300, 900, 1_400, 1_700, 2_300])
    expect(read.at).toBe(2_300)
  })

  it('answers a failed lookup beside one that never answers once the wait after the failure ends, not at the deadline', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(30)
    const hung = txPath(fakeTxid(1))
    explorer.slowResponses.push({
      match: request => request.path === hung,
      chunkBytes: 1 << 20,
      intervalMs: 0,
      stallHeaders: true,
    })
    const refused = txPath(fakeTxid(2))
    const { fetchFn, log } = failing(explorer, path => (path === refused ? 404 : undefined))
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads()

    const read = track(balanceOf(client, fundingTxReads))
    await untilSettled(read)

    expect(read.value).toEqual(incomplete(30, true))
    expect(read.at).toBe(QBIT_BALANCE_READ_FAILURE_GRACE_MS)
    expect(read.at).toBeLessThan(QBIT_BALANCE_READ_DEADLINE_MS)
    // The others' answers were kept; the hung one was cancelled.
    expect(fundingTxReads.size).toBe(28)
    expect(explorer.abortedRequests).toEqual([hung])
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
    const sent = log.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(log).toHaveLength(sent)
  })

  it('counts the ride-out from a lookup first request, not from its wait for a slot', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(1)
    fund(explorer, other, 1, 3_000_000)
    // The other read's one lookup holds the only slot for 4 s.
    const holding = txPath(fakeTxid(0, 3_000_000))
    explorer.slowResponses.push({
      match: request => request.path === holding,
      chunkBytes: 1 << 20,
      intervalMs: 4_000,
    })
    const victim = txPath(fakeTxid(0))
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === victim && nth === 1 ? 502 : undefined
    )
    const client = clientOf(fetchFn)
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 1 })

    const theirs = track(balanceOf(client, fundingTxReads, { holder: other }))
    await vi.advanceTimersByTimeAsync(0)
    const mine = track(balanceOf(client, fundingTxReads))
    await untilSettled(mine)
    await untilSettled(theirs)

    // Sent at 4 s, it still rides out: its clock started then.
    expect(requestsTo(log, victim)).toEqual([4_000, 4_500])
    expect(mine.value).toEqual(complete(1))
    expect(theirs.value).toEqual(complete(1))
  })

  it("reads the tip again after a 502 to judge an over-limit address's outputs read from its history", async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(30)
    explorer.utxoLimit = 20
    // The first tip, asked for with the listing, answers; the one asked for
    // to judge the history's outputs is answered 502 once.
    const { fetchFn, log } = failing(explorer, (path, nth) =>
      path === TIP && nth === 2 ? 502 : undefined
    )
    const outputs = Array.from({ length: 30 }, (_, index) => ({
      txid: fakeTxid(index),
      vout: 0,
      satoshis: OUTPUT_VALUE,
      scriptPk: main.script,
    }))

    const read = track(
      getQbitSpendableBalanceV2(
        clientOf(fetchFn),
        address,
        main.script,
        undefined,
        // A reward the read of the history left out, maturing later.
        () => ({ outputs, matureAt: explorer.tipHeight + 10 }),
        { fundingTxReads: new QbitFundingTxReads() }
      )
    )
    await untilSettled(read)

    expect(read.value).toMatchObject({
      availableBalance: 30 * OUTPUT_VALUE,
      totalBalance: 30 * OUTPUT_VALUE,
      utxoLimitExceeded: true,
    })
    expect(requestsTo(log, TIP)).toEqual([0, 0, 500])
  })
})
