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
  QbitWalletEsploraClient,
  getQbitAddressUtxos,
  getQbitAddressUtxosClassified,
  getQbitSpendableBalanceV2,
} from '../src/utils/qbit-api'
import {
  QBIT_BODY_READ_RETRY_PAUSES_MS,
  QBIT_CLASSIFY_MAX_READS_IN_FLIGHT,
  QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT,
  QbitFundingTxReads,
  isQbitBodyReadFailure,
  QBIT_LOOKUP_RETRY_STATUSES,
  withQbitReadRetries,
} from '../src/utils/qbit-funding-tx-reads'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

// The real explorer client, through the wallet's own fetch, over an explorer
// served over fetch: a reply's connection lost in the middle of its body
// reaches the classification as it does in the browser.
const BASE = 'https://explorer.test/api'
const pubkeyHex = '11'.repeat(32)
const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
const accountScript = bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)))
const address = p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'testnet4')
const OUTPUT_VALUE = 10_000
const listing = `/address/${address}/utxo`
const txPath = (txid: string): string => `/tx/${txid}`

/**
 * An explorer of the account paid `count` times, each payment its own
 * transaction, younger than a coinbase must be to mature: the balance reads
 * each one's transaction, and so does every read of outputs.
 */
function accountExplorer(count: number): FakeQbitExplorer {
  const explorer = new FakeQbitExplorer()
  explorer.utxoLimit = 50_000
  explorer.registerAddress(address, accountScript)
  for (let index = 0; index < count; index += 1) {
    explorer.addTx({
      txid: fakeTxid(index),
      inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
      outputs: [{ address, script: accountScript, value: OUTPUT_VALUE }],
      height: explorer.tipHeight - 600 + Math.floor(index / 50),
    })
  }
  return explorer
}

/**
 * Another account, of the key `pubkeyByte` repeated, paid `count` times on
 * `explorer`, younger than a coinbase must be to mature: its address.
 */
function otherAccount(explorer: FakeQbitExplorer, pubkeyByte: string, count: number): string {
  const pubkey = hexToBytes(pubkeyByte.repeat(32))
  const script = bytesToHex(
    p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pubkey)))
  )
  const other = p2mrAddressFromPubkey(pubkey, 'testnet4')
  explorer.registerAddress(other, script)
  const salt = parseInt(pubkeyByte, 16) * 1_000_000
  for (let index = 0; index < count; index += 1) {
    explorer.addTx({
      txid: fakeTxid(index, salt),
      inputs: [{ txid: fakeTxid(index, salt + 500_000), vout: 0 }],
      outputs: [{ address: other, script, value: OUTPUT_VALUE }],
      height: explorer.tipHeight - 600,
    })
  }
  return other
}

/** The reply to `path` loses its connection after a few bytes of its body, the first `times` times. */
function cutBody(explorer: FakeQbitExplorer, path: string, times: number): void {
  let cut = 0
  explorer.slowResponses.push({
    match: request => request.path === path && cut++ < times,
    chunkBytes: 4,
    intervalMs: 0,
    resetAfterBytes: 4,
  })
}

const requestsOf = (explorer: FakeQbitExplorer, path: string): number =>
  explorer.requests.filter(request => request.path === path).length

/**
 * The client, with the transaction lookups it has in flight counted, and for
 * each lookup started, how many others were in flight then.
 */
function countedClient(
  explorer: FakeQbitExplorer,
  options: { retryBaseDelayMs?: number; maxResponseBytes?: number } = {}
) {
  const client = new QbitWalletEsploraClient({ baseUrl: BASE, fetchFn: explorer.fetch, ...options })
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

const fullSplit = (count: number) => ({
  availableBalance: count * OUTPUT_VALUE,
  unavailableBalance: 0,
  totalBalance: count * OUTPUT_VALUE,
  immatureBalance: 0,
  pendingBalance: 0,
})

const incompleteAndFailed = (count: number) => ({
  availableBalance: null,
  unavailableBalance: count * OUTPUT_VALUE,
  totalBalance: count * OUTPUT_VALUE,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  utxoReadFailed: true,
})

describe('a reply whose body could not be read (#209)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads it again in the slot it holds: one lost body among 5,000 lookups costs one more request', async () => {
    const explorer = accountExplorer(5_000)
    // Two more accounts read through the same shared reader meanwhile, each
    // at the sustained rate, the three together past the reader's bound of
    // two such rates: reads wait for every slot that frees.
    const others = [otherAccount(explorer, '22', 5_000), otherAccount(explorer, '33', 5_000)]
    const bound = 2 * QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT
    const victim = fakeTxid(10)
    cutBody(explorer, txPath(victim), 1)
    // Every lookup takes a few ms, so the others are still being read when it is read again.
    explorer.slowResponses.push({
      match: request => request.path.startsWith('/tx/'),
      chunkBytes: 1 << 20,
      intervalMs: 5,
    })
    const { client, lookups } = countedClient(explorer)
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: bound })

    const [utxos, ...read] = await Promise.all([
      getQbitAddressUtxos(client, address, { fundingTxReads }),
      ...others.map(other => getQbitAddressUtxos(client, other, { fundingTxReads })),
    ])

    expect(utxos).toHaveLength(5_000)
    expect(read.map(outputs => outputs.length)).toEqual([5_000, 5_000])
    expect(requestsOf(explorer, txPath(victim))).toBe(2)
    expect(requestsOf(explorer, txPath(fakeTxid(11)))).toBe(1)
    // Read again in the slot it held through the pause, beside every other slot's read.
    expect(lookups.othersAtStart.get(victim)?.[1]).toBe(bound - 1)
    expect(lookups.peak).toBe(bound)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
  })

  it('reads a lost body again in the slot it held, before a read waiting for that slot starts', async () => {
    const explorer = accountExplorer(1)
    const other = otherAccount(explorer, '22', 1)
    const mine = txPath(fakeTxid(0))
    const theirs = txPath(fakeTxid(0, 0x22 * 1_000_000))
    cutBody(explorer, mine, 1)
    const { client } = countedClient(explorer)
    // One slot: the other account's lookup waits for it.
    const fundingTxReads = new QbitFundingTxReads({ maxReadsInFlight: 1 })

    const first = getQbitAddressUtxos(client, address, { fundingTxReads })
    while (requestsOf(explorer, mine) === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const second = getQbitAddressUtxos(client, other, { fundingTxReads })

    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
    const lookups = explorer.requests
      .map(({ path }) => path)
      .filter(path => path.startsWith('/tx/'))
    expect(lookups).toEqual([mine, mine, theirs])
  })

  it('gives a balance read its full split, not an incomplete one, after one lost body among 5,000', async () => {
    const explorer = accountExplorer(5_000)
    const victim = fakeTxid(4_321)
    cutBody(explorer, txPath(victim), 1)
    const { client, lookups } = countedClient(explorer)

    const balance = await getQbitSpendableBalanceV2(
      client,
      address,
      accountScript,
      undefined,
      undefined,
      { fundingTxReads: new QbitFundingTxReads() }
    )

    expect(balance).toEqual(fullSplit(5_000))
    expect(requestsOf(explorer, txPath(victim))).toBe(2)
    expect(lookups.peak).toBe(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
  })

  it('fails as before with that error once the body is lost three times: the send path, then the balance', async () => {
    const explorer = accountExplorer(300)
    const victim = fakeTxid(150)
    cutBody(explorer, txPath(victim), 6)
    const { client } = countedClient(explorer)

    const error = await getQbitAddressUtxos(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    }).catch((caught: unknown) => caught)

    expect(isQbitBodyReadFailure(error)).toBe(true)
    expect(error).toMatchObject({ kind: 'parse', status: 200 })
    expect((error as Error).message).toContain(`failed to read response body from`)
    expect((error as Error).message).toContain(txPath(victim))
    // Two more attempts, no more.
    expect(requestsOf(explorer, txPath(victim))).toBe(3)

    // The balance read: the total, the split unknown, and failed.
    const balance = await getQbitSpendableBalanceV2(
      client,
      address,
      accountScript,
      undefined,
      undefined,
      { fundingTxReads: new QbitFundingTxReads() }
    )
    expect(balance).toEqual(incompleteAndFailed(300))
    expect(requestsOf(explorer, txPath(victim))).toBe(6)
  })

  it('pauses 100 ms before the second attempt and 300 ms before the third', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(3)
    const victim = fakeTxid(2)
    cutBody(explorer, txPath(victim), 2)
    const { client } = countedClient(explorer)
    const fundingTxReads = new QbitFundingTxReads()

    const read = getQbitAddressUtxos(client, address, { fundingTxReads })
    await vi.advanceTimersByTimeAsync(1)
    expect(requestsOf(explorer, txPath(victim))).toBe(1)
    await vi.advanceTimersByTimeAsync(98)
    expect(requestsOf(explorer, txPath(victim))).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(requestsOf(explorer, txPath(victim))).toBe(2)
    await vi.advanceTimersByTimeAsync(298)
    expect(requestsOf(explorer, txPath(victim))).toBe(2)
    await vi.advanceTimersByTimeAsync(2)
    expect(requestsOf(explorer, txPath(victim))).toBe(3)

    await expect(read).resolves.toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('asks for the listing again when its body is lost once', async () => {
    const explorer = accountExplorer(200)
    cutBody(explorer, listing, 1)
    const { client } = countedClient(explorer)

    const utxos = await getQbitAddressUtxos(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    expect(utxos).toHaveLength(200)
    expect(requestsOf(explorer, listing)).toBe(2)

    // And the balance read's listing too.
    cutBody(explorer, listing, 1)
    await expect(
      getQbitSpendableBalanceV2(client, address, accountScript, undefined, undefined, {
        fundingTxReads: new QbitFundingTxReads(),
      })
    ).resolves.toEqual(fullSplit(200))
    expect(requestsOf(explorer, listing)).toBe(4)
  })

  it('stops at once, with no timer left and the limiter idle, when the caller gives up during the pause', async () => {
    vi.useFakeTimers()
    const explorer = accountExplorer(3)
    const victim = fakeTxid(1)
    cutBody(explorer, txPath(victim), 1)
    const { client } = countedClient(explorer)
    const fundingTxReads = new QbitFundingTxReads()
    const caller = new AbortController()

    const outcome = getQbitAddressUtxos(client, address, {
      fundingTxReads,
      signal: caller.signal,
    }).catch((caught: unknown) => ({ caught }))
    // The lost body is in, and the pause before the next attempt has begun.
    await vi.advanceTimersByTimeAsync(QBIT_BODY_READ_RETRY_PAUSES_MS[0]! / 2)
    expect(requestsOf(explorer, txPath(victim))).toBe(1)

    const reason = new Error('the send screen closed')
    caller.abort(reason)
    await expect(outcome).resolves.toEqual({ caught: reason })
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
    const limiter = fundingTxReads.limiter(client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    // Nothing more was read.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestsOf(explorer, txPath(victim))).toBe(1)
  })

  it('makes no further attempt once another failure has stopped the classification during the pause', async () => {
    const explorer = accountExplorer(20)
    const victim = fakeTxid(3)
    const missing = fakeTxid(17)
    cutBody(explorer, txPath(victim), 1)
    // Not found, and slow to say so: the pause has begun by then.
    explorer.failures.push(request =>
      request.path === txPath(missing) ? { status: 404 } : undefined
    )
    explorer.slowResponses.push({
      match: request => request.path === txPath(missing),
      chunkBytes: 1_000,
      intervalMs: 20,
    })
    const { client } = countedClient(explorer)

    const error = await getQbitAddressUtxos(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    }).catch((caught: unknown) => caught)
    await new Promise(resolve => setTimeout(resolve, 2 * QBIT_BODY_READ_RETRY_PAUSES_MS[0]!))

    expect(error).toMatchObject({ kind: 'not_found', status: 404 })
    expect(requestsOf(explorer, txPath(victim))).toBe(1)
  })

  it.each([
    [
      'a body that is not valid JSON',
      (path: string) => (request: { path: string }) =>
        request.path === path ? { status: 200, body: '{"txid":' } : undefined,
      { kind: 'parse' },
    ],
    [
      'a 404',
      (path: string) => (request: { path: string }) =>
        request.path === path ? { status: 404 } : undefined,
      { kind: 'not_found', status: 404 },
    ],
  ])('reads %s once, failing as before', async (_label, failure, failed) => {
    const explorer = accountExplorer(50)
    const victim = fakeTxid(25)
    explorer.failures.push(failure(txPath(victim)))
    const { client } = countedClient(explorer)

    const error = await getQbitAddressUtxos(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject(failed)
    expect(isQbitBodyReadFailure(error)).toBe(false)
    expect(requestsOf(explorer, txPath(victim))).toBe(1)

    const balance = await getQbitSpendableBalanceV2(
      client,
      address,
      accountScript,
      undefined,
      undefined,
      { fundingTxReads: new QbitFundingTxReads() }
    )
    expect(balance).toEqual(incompleteAndFailed(50))
    expect(requestsOf(explorer, txPath(victim))).toBe(2)
  })

  it('reads the listing a refusal the explorer states once, and the outputs from history as before', async () => {
    const explorer = accountExplorer(30)
    explorer.utxoLimit = 20
    const { client } = countedClient(explorer)

    const utxos = await getQbitAddressUtxos(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })
    expect(utxos).toHaveLength(30)
    // The requests of the base: the listing once, the statistics before and
    // after the walk, each history page once.
    const counts = new Map<string, number>()
    for (const { path } of explorer.requests) counts.set(path, (counts.get(path) ?? 0) + 1)
    expect(counts.get(listing)).toBe(1)
    expect(counts.get(`/address/${address}`)).toBe(4)
    for (const [path, count] of counts) {
      if (path.includes('/txs')) expect(count, path).toBe(1)
    }
    expect(explorer.requests).toHaveLength(10)

    explorer.requests.length = 0
    const balance = await getQbitSpendableBalanceV2(
      client,
      address,
      accountScript,
      undefined,
      undefined,
      { fundingTxReads: new QbitFundingTxReads() }
    )
    expect(balance).toMatchObject({ totalBalance: 30 * OUTPUT_VALUE, utxoLimitExceeded: true })
    expect(requestsOf(explorer, listing)).toBe(1)
  })
})

describe('the ancestors of own change, when a body is lost (#209)', () => {
  /**
   * The account's pending change, 10,000, of its own pending payment, which
   * spends a confirmed output of its own, beside three confirmed payments:
   * classifying the change walks to its parent and on to that output.
   */
  function pendingChangeExplorer() {
    const explorer = accountExplorer(3)
    const root = fakeTxid(1, 7_000_000)
    const parent = fakeTxid(2, 7_000_000)
    const change = fakeTxid(3, 7_000_000)
    explorer.addTx({
      txid: root,
      inputs: [{ txid: fakeTxid(9, 7_000_000), vout: 0 }],
      outputs: [{ address, script: accountScript, value: 30_000 }],
      height: explorer.tipHeight - 10,
    })
    explorer.addTx({
      txid: parent,
      inputs: [{ txid: root, vout: 0 }],
      outputs: [{ address, script: accountScript, value: 20_000 }],
    })
    explorer.addTx({
      txid: change,
      inputs: [{ txid: parent, vout: 0 }],
      outputs: [{ address, script: accountScript, value: 10_000 }],
    })
    return { explorer, parent, change }
  }

  const outpoints = (utxos: readonly { txid: string; vout: number }[]): string[] =>
    utxos.map(({ txid, vout }) => `${txid}:${vout}`)

  it("reads a walk's ancestor again when its body is lost once: the change stays the account's own", async () => {
    const { explorer, parent, change } = pendingChangeExplorer()
    cutBody(explorer, txPath(parent), 1)
    const { client } = countedClient(explorer)

    const classified = await getQbitAddressUtxosClassified(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    expect(requestsOf(explorer, txPath(parent))).toBe(2)
    expect(classified.confirmedSpendable).toHaveLength(3)
    expect(outpoints(classified.unconfirmedOwnChange)).toEqual([`${change}:0`])
  })

  it('costs only that output its own-change standing when the ancestor body is lost three times', async () => {
    const { explorer, parent, change } = pendingChangeExplorer()
    cutBody(explorer, txPath(parent), 3)
    const { client } = countedClient(explorer)

    const classified = await getQbitAddressUtxosClassified(client, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    expect(requestsOf(explorer, txPath(parent))).toBe(3)
    expect(classified.confirmedSpendable).toHaveLength(3)
    expect(outpoints(classified.unconfirmedSpendable)).toEqual([`${change}:0`])
    expect(classified.unconfirmedOwnChange).toEqual([])
  })
})

describe('withQbitReadRetries', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('makes no further attempt, and starts no pause, for a read given up on as its body failed', async () => {
    // The client's own failure, for a reply whose body was lost.
    const explorer = accountExplorer(1)
    cutBody(explorer, txPath(fakeTxid(0)), 1)
    const lost = await countedClient(explorer)
      .client.getTx(fakeTxid(0))
      .catch((caught: unknown) => caught)
    expect(isQbitBodyReadFailure(lost)).toBe(true)

    vi.useFakeTimers()
    const caller = new AbortController()
    const reason = new Error('the classification stopped')
    const read = vi.fn(async () => {
      caller.abort(reason)
      throw lost
    })

    await expect(withQbitReadRetries(read, caller.signal, QBIT_LOOKUP_RETRY_STATUSES)).rejects.toBe(
      reason
    )
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('isQbitBodyReadFailure', () => {
  /** What the client rejects with for a read of `path` served as `serve` sets up. */
  async function failureOf(
    serve: (explorer: FakeQbitExplorer, path: string) => void,
    options: { retryBaseDelayMs?: number; maxResponseBytes?: number } = {}
  ): Promise<unknown> {
    const explorer = accountExplorer(1)
    const path = txPath(fakeTxid(0))
    serve(explorer, path)
    const { client } = countedClient(explorer, { retryBaseDelayMs: 1, ...options })
    return client.getTx(fakeTxid(0)).catch((caught: unknown) => caught)
  }

  it('is the client failing to read the body of a reply it does not retry, and nothing else', async () => {
    const reply = (status: number, body?: string) => (explorer: FakeQbitExplorer, path: string) =>
      explorer.failures.push(request =>
        request.path === path ? { status, ...(body === undefined ? {} : { body }) } : undefined
      )
    const cut = (explorer: FakeQbitExplorer, path: string) => cutBody(explorer, path, 10)

    // A 200 whose body is lost: the client gives up at once.
    const lost = await failureOf(cut)
    expect(lost).toMatchObject({ kind: 'parse', status: 200 })
    expect(isQbitBodyReadFailure(lost)).toBe(true)
    // A 404 whose body is lost, which no attempt of the client repeats either.
    const lostNotFound = await failureOf((explorer, path) => {
      reply(404)(explorer, path)
      cutBody(explorer, path, 10)
    })
    expect(lostNotFound).toMatchObject({ kind: 'parse', status: 404 })
    expect(isQbitBodyReadFailure(lostNotFound)).toBe(true)

    // A 503 whose body is lost: the client retried it already.
    const lostUnavailable = await failureOf((explorer, path) => {
      reply(503)(explorer, path)
      cutBody(explorer, path, 10)
    })
    expect(lostUnavailable).toMatchObject({ kind: 'parse', status: 503 })
    expect(isQbitBodyReadFailure(lostUnavailable)).toBe(false)

    for (const [serve, kind] of [
      [reply(200, '{"txid":'), 'parse'],
      [reply(404), 'not_found'],
      [reply(400, 'bad request'), 'http'],
    ] as const) {
      const failure = await failureOf(serve)
      expect(failure).toMatchObject({ kind })
      expect(isQbitBodyReadFailure(failure)).toBe(false)
    }
    // A reply over the client's size limit.
    const tooLarge = await failureOf(() => undefined, { maxResponseBytes: 64 })
    expect(tooLarge).toMatchObject({ kind: 'response_too_large' })
    expect(isQbitBodyReadFailure(tooLarge)).toBe(false)

    // Errors of other kinds, or without the reply's status.
    for (const error of [
      new QbitApiError('timeout', 'request timed out', { status: 200 }),
      new QbitApiError('aborted', 'request abandoned'),
      new QbitApiError('network', 'network error'),
      new QbitApiError('parse', 'failed to read response body from https://explorer.test/tx'),
      new QbitApiError('parse', 'failed to parse JSON from /tx', { status: 200 }),
      new TypeError('terminated'),
      undefined,
    ]) {
      expect(isQbitBodyReadFailure(error)).toBe(false)
    }
  })
})
