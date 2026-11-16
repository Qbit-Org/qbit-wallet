import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getQbitAddressUtxos,
  getQbitAddressUtxosClassified,
  getQbitSpendableBalanceV2,
  QBIT_BALANCE_READ_DEADLINE_MS,
  QbitWalletEsploraClient,
} from '../src/utils/qbit-api'
import { QbitFundingTxReads } from '../src/utils/qbit-funding-tx-reads'
import { ACCOUNT_ADDRESS, ACCOUNT_SCRIPT } from './qbit-classify-reads-fake'
import { FakeQbitExplorer, fakeTxid, type FakeTx } from './qbit-fake-explorer'

const address = ACCOUNT_ADDRESS
const script = ACCOUNT_SCRIPT
const payer = 'qbrt1zpayer'
const payerScript = `5220${'bb'.repeat(32)}`
const BASE = 'https://explorer.test/api'

let seed = 0

/**
 * A payment of `value` to `to` paying `toScript`, its own transaction,
 * confirmed `depth` blocks deep (1 in the tip block) or, without one, in the
 * mempool.
 */
function pay(
  explorer: FakeQbitExplorer,
  value: number,
  {
    depth,
    coinbase = false,
    to = address,
    toScript = script,
  }: { depth?: number; coinbase?: boolean; to?: string; toScript?: string } = {}
): FakeTx {
  seed += 1
  return explorer.addTx({
    txid: fakeTxid(seed, 21_000_000),
    inputs: coinbase ? [] : [{ txid: fakeTxid(seed, 22_000_000), vout: 0 }],
    outputs: [{ address: to, script: toScript, value }],
    coinbase,
    ...(depth !== undefined ? { height: explorer.tipHeight - depth + 1 } : {}),
  })
}

/** `count` payments of 10,000 sats and more to the account, from `depth` blocks deep down. */
function payDeep(explorer: FakeQbitExplorer, count: number, depth: number): FakeTx[] {
  return Array.from({ length: count }, (_, index) =>
    pay(explorer, 10_000 + index, { depth: depth + index })
  )
}

/** An unconfirmed payment of `value` from someone else, spending their confirmed output. */
function payPending(explorer: FakeQbitExplorer, value: number): FakeTx {
  const funding = pay(explorer, value + 1_000, { depth: 50, to: payer, toScript: payerScript })
  seed += 1
  return explorer.addTx({
    txid: fakeTxid(seed, 23_000_000),
    inputs: [{ txid: funding.txid, vout: 0 }],
    outputs: [{ address, script, value }],
  })
}

/** An explorer of the account (tip 2,000), its client, and one shared reader. */
function setup({ maxOutpoints }: { maxOutpoints?: number } = {}) {
  const explorer = new FakeQbitExplorer('esplora')
  explorer.registerAddress(address, script)
  const client = new QbitWalletEsploraClient({
    baseUrl: BASE,
    fetchFn: explorer.fetch as typeof fetch,
    retryBaseDelayMs: 0,
  })
  const fundingTxReads = new QbitFundingTxReads(maxOutpoints === undefined ? {} : { maxOutpoints })
  /** What `run` answers, the txids of the `/tx` reads it makes, and its tip reads. */
  const readsOf = async <T>(run: () => Promise<T>) => {
    const from = explorer.requests.length
    const value = await run()
    const made = explorer.requests.slice(from)
    return {
      value,
      txs: made.flatMap(({ path }) => path.match(/^\/tx\/([0-9a-f]{64})$/)?.[1] ?? []),
      tips: made.filter(({ path }) => path === '/blocks/tip/height').length,
    }
  }
  /** The balance of `target` through the shared reader. */
  const balance = (target = address) =>
    getQbitSpendableBalanceV2(
      client,
      target,
      target === address ? script : undefined,
      undefined,
      undefined,
      { fundingTxReads }
    )
  return { explorer, client, fundingTxReads, readsOf, balance }
}

const sum = (txs: readonly FakeTx[]) => txs.reduce((total, tx) => total + tx.outputs[0]!.value, 0)
const txids = (txs: readonly FakeTx[]) => new Set(txs.map(tx => tx.txid))

const split = ({
  available,
  immature = 0,
  pending = 0,
}: {
  available: number
  immature?: number
  pending?: number
}) => ({
  availableBalance: available,
  unavailableBalance: immature + pending,
  totalBalance: available + immature + pending,
  immatureBalance: immature,
  pendingBalance: pending,
})

/** The total with the split unknown, as a read that did not finish answers. */
const incomplete = (total: number, failed = false) => ({
  availableBalance: null,
  unavailableBalance: total,
  totalBalance: total,
  immatureBalance: null,
  pendingBalance: null,
  utxoReadIncomplete: true,
  ...(failed ? { utxoReadFailed: true } : {}),
})

const TIP_PATH = '/blocks/tip/height'

/** The txids of the `/tx` reads `explorer` was asked for since its request `from`. */
const txReadsSince = (explorer: FakeQbitExplorer, from = 0): string[] =>
  explorer.requests
    .slice(from)
    .flatMap(({ path }) => path.match(/^\/tx\/([0-9a-f]{64})$/)?.[1] ?? [])

/** How many tip reads `explorer` was asked for since its request `from`. */
const tipReadsSince = (explorer: FakeQbitExplorer, from = 0): number =>
  explorer.requests.slice(from).filter(({ path }) => path === TIP_PATH).length

/** Every listing from now on answers 5 ms late, so that the tip, asked for with it, answers first. */
const slowListing = (explorer: FakeQbitExplorer): void => {
  explorer.slowResponses.push({
    match: ({ path }) => path.endsWith('/utxo'),
    chunkBytes: 50_000_000,
    intervalMs: 5,
  })
}

describe('the balance of outputs a coinbase maturity deep, from the listing alone', () => {
  it('reads no transaction of an output the listing shows a coinbase maturity deep, and the tip once a poll', async () => {
    const { explorer, readsOf, balance } = setup()
    const deep = payDeep(explorer, 40, 1_200)
    // The newest payment, which the listing cannot show deep: only the tip can.
    const young = pay(explorer, 7_000, { depth: 1 })
    const total = sum([...deep, young])

    const cold = await readsOf(() => balance())
    expect(cold.value).toEqual(split({ available: total }))
    // The young one's transaction alone, and the tip, asked for with the listing.
    expect(cold.txs).toEqual([young.txid])
    expect(cold.tips).toBe(1)

    // Its facts kept, no transaction is read; the tip is asked for all the same.
    const steady = await readsOf(() => balance())
    expect(steady.value).toEqual(split({ available: total }))
    expect(steady.txs).toEqual([])
    expect(steady.tips).toBe(1)
  })

  it('reads the young and unconfirmed outputs alone, and splits a mixed account exactly', async () => {
    const { explorer, readsOf, balance } = setup()
    const deep = payDeep(explorer, 30, 1_500)
    const reward = pay(explorer, 5_000_000, { depth: 11, coinbase: true })
    const young = pay(explorer, 7_000, { depth: 21 })
    const pending = payPending(explorer, 9_000)

    const read = await readsOf(() => balance())

    expect(read.value).toEqual(
      split({ available: sum([...deep, young]), immature: 5_000_000, pending: 9_000 })
    )
    expect(read.txs).toHaveLength(3)
    expect(new Set(read.txs)).toEqual(txids([reward, young, pending]))
  })

  it('reads an output 999 blocks deep, and not one 1,000 deep', async () => {
    const { explorer, readsOf, balance } = setup()
    const newest = pay(explorer, 7_000, { depth: 1 })
    const younger = pay(explorer, 11_000, { depth: 999 })
    const mature = pay(explorer, 13_000, { depth: 1_000 })

    const read = await readsOf(() => balance())

    expect(read.value).toEqual(split({ available: sum([newest, younger, mature]) }))
    expect(read.txs).toHaveLength(2)
    expect(new Set(read.txs)).toEqual(txids([newest, younger]))
  })

  it("reads no transaction of an old account's outputs the tip shows deep, poll after poll, the tip answering before the listing", async () => {
    const { explorer, readsOf, balance } = setup()
    // The newest 1,200 blocks deep: the listing alone shows none of them deep.
    const deep = payDeep(explorer, 50, 1_200)
    slowListing(explorer)

    for (let poll = 0; poll < 3; poll += 1) {
      const read = await readsOf(() => balance())
      expect(read.value).toEqual(split({ available: sum(deep) }))
      // Asked for with the listing, the tip has answered before any of them
      // is classified: it shows every one deep, and none is read.
      expect(read.txs).toEqual([])
      expect(read.tips).toBe(1)
    }
  })

  it("reads no transaction of an old account's kept outputs for a send, the tip answering before the listing", async () => {
    const { explorer, client, fundingTxReads, readsOf } = setup()
    const deep = payDeep(explorer, 50, 1_200)
    // The first read of outputs reads every one, and keeps them.
    const first = await readsOf(() => getQbitAddressUtxos(client, address, { fundingTxReads }))
    expect(first.txs).toHaveLength(50)
    slowListing(explorer)

    // The next is served them all: the tip, already in, shows each a coinbase
    // maturity deep, so a kept "not a coinbase" answer may serve a send.
    const next = await readsOf(() => getQbitAddressUtxos(client, address, { fundingTxReads }))
    expect(new Set(next.value.map(utxo => utxo.txid))).toEqual(txids(deep))
    expect(next.txs).toEqual([])
    expect(next.tips).toBe(1)
  })

  it('reads the statistics, the listing and the tip of an account with no output, and nothing else', async () => {
    const { explorer, balance } = setup()

    await expect(balance()).resolves.toEqual(split({ available: 0 }))

    expect(explorer.requests.map(({ path }) => path).sort()).toEqual(
      [`/address/${address}`, `/address/${address}/utxo`, TIP_PATH].sort()
    )
  })

  it('reads every output the tip would have to show deep when the tip cannot be read', async () => {
    const { explorer, readsOf, balance } = setup()
    const deep = payDeep(explorer, 20, 1_200)
    explorer.failures.push(({ path }) =>
      path === '/blocks/tip/height' ? { status: 503, body: 'unavailable' } : undefined
    )

    const read = await readsOf(() => balance())

    expect(read.value).toEqual(split({ available: sum(deep) }))
    expect(read.txs).toHaveLength(20)
    expect(new Set(read.txs)).toEqual(txids(deep))
  })

  it('reads every output of an address it cannot derive the script of, as before', async () => {
    const { explorer, readsOf, balance } = setup()
    const other = 'qbrt1zundecodable'
    explorer.registerAddress(other, script)
    const outputs = [
      ...Array.from({ length: 10 }, (_, index) =>
        pay(explorer, 10_000 + index, { depth: 1_500 + index, to: other })
      ),
      pay(explorer, 1_000, { depth: 1, to: other }),
    ]

    const read = await readsOf(() => balance(other))

    expect(read.value).toEqual(split({ available: sum(outputs) }))
    expect(read.txs).toHaveLength(11)
    expect(new Set(read.txs)).toEqual(txids(outputs))
  })
})

describe('a read of outputs to spend, beside the balance read', () => {
  it('still reads every deep output on a reader the balance read, and keeps them', async () => {
    const { explorer, client, fundingTxReads, readsOf, balance } = setup()
    const deep = payDeep(explorer, 40, 1_200)
    // The newest payment, by which the listing alone shows the rest deep.
    const young = pay(explorer, 7_000, { depth: 1 })
    expect((await readsOf(() => balance())).txs).toEqual([young.txid])

    const send = await readsOf(() => getQbitAddressUtxos(client, address, { fundingTxReads }))
    expect(send.value).toHaveLength(41)
    expect(send.txs).toHaveLength(41)
    expect(new Set(send.txs)).toEqual(txids([...deep, young]))
    // What it kept serves the next one; the young one is read afresh, as ever.
    const again = await readsOf(() => getQbitAddressUtxos(client, address, { fundingTxReads }))
    expect(again.txs).toEqual([young.txid])
  })

  it('still refuses a deep output whose transaction disagrees with its listing, which the balance does not read', async () => {
    const { explorer, client, fundingTxReads, balance } = setup()
    const deep = payDeep(explorer, 10, 1_200)
    // The newest payment, by which the listing alone shows the rest deep.
    const young = pay(explorer, 7_000, { depth: 1 })
    const target = deep[4]!
    explorer.failures.push(({ path }) => {
      if (path !== `/tx/${target.txid}`) return undefined
      const tx = explorer.esploraTx(target)
      tx.vout[0]!.value += 1
      return { status: 200, body: JSON.stringify(tx) }
    })

    // The listing and the statistics agree, and the balance reads no more.
    await expect(balance()).resolves.toEqual(split({ available: sum([...deep, young]) }))
    await expect(getQbitAddressUtxos(client, address, { fundingTxReads })).rejects.toThrow(
      'output value mismatch'
    )
  })
})

describe("the wallet's own ceiling, counting only the outputs still to read", () => {
  it('splits an address with more deep outputs than the reader keeps, reading only the rest', async () => {
    const { explorer, readsOf, balance } = setup({ maxOutpoints: 100 })
    const deep = payDeep(explorer, 150, 1_200)
    const young = pay(explorer, 7_000, { depth: 1 })

    const read = await readsOf(() => balance())

    expect(read.value).toEqual(split({ available: sum([...deep, young]) }))
    expect(read.txs).toEqual([young.txid])
  })

  it('splits an old address its listing alone shows over the cap, the tip having shown it deep by then', async () => {
    const { explorer, readsOf, balance } = setup({ maxOutpoints: 100 })
    const deep = payDeep(explorer, 150, 1_200)
    slowListing(explorer)

    const read = await readsOf(() => balance())

    // Asked for with the listing, the tip has answered when the outputs are
    // counted: it shows every one deep, so none is left to read.
    expect(read.value).toEqual(split({ available: sum(deep) }))
    expect(read.txs).toEqual([])
    expect(read.tips).toBe(1)
  })

  it('still refuses more young outputs than the reader keeps, reading none of them', async () => {
    const { explorer, readsOf, balance } = setup({ maxOutpoints: 100 })
    const young = Array.from({ length: 101 }, (_, index) =>
      pay(explorer, 10_000 + index, { depth: 1 + index })
    )
    const total = sum([...young, ...payDeep(explorer, 50, 1_200)])

    const read = await readsOf(() => balance())

    // The total, the split unknown, and a poll that backs off.
    expect(read.value).toEqual({
      availableBalance: null,
      unavailableBalance: total,
      totalBalance: total,
      immatureBalance: null,
      pendingBalance: null,
      utxoReadIncomplete: true,
      utxoReadFailed: true,
    })
    expect(read.txs).toEqual([])
  })
})

describe('a tip that hangs while every other read answers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The read's outcome, once it has one, without awaiting it. */
  function track<T>(promise: Promise<T>) {
    const outcome: { settled: boolean; value?: T; error?: unknown } = { settled: false }
    promise.then(
      value => Object.assign(outcome, { settled: true, value }),
      error => Object.assign(outcome, { settled: true, error })
    )
    return outcome
  }

  /** Every tip read from now on: its headers never arrive, until its signal aborts. */
  const hangTip = (explorer: FakeQbitExplorer): void => {
    explorer.slowResponses.push({
      match: ({ path }) => path === TIP_PATH,
      chunkBytes: 1,
      intervalMs: 1_000,
      stallHeaders: true,
    })
  }

  /**
   * An ordinary account under a tip of 5,000: three payments, none a
   * coinbase output, 3, 40 and 2,500 blocks deep. The listing's newest block
   * shows the last one deep; only the tip could show the other two deep.
   */
  function ordinaryAccount() {
    const context = setup()
    context.explorer.tipHeight = 5_000
    const payments = [3, 40, 2_500].map((depth, index) =>
      pay(context.explorer, 10_000 * (index + 1), { depth })
    )
    return { ...context, payments }
  }

  it('splits an account with no coinbase output at once, reading only its young outputs, and reads the tip no longer', async () => {
    const { explorer, balance, payments } = ordinaryAccount()
    hangTip(explorer)

    const poll = track(balance())
    await vi.advanceTimersByTimeAsync(100)

    // Long before the deadline, the full split, as 1.0.9 gave it.
    expect(poll).toMatchObject({ settled: true, value: split({ available: 60_000 }) })
    // The two the listing cannot show deep, read rather than wait for the
    // tip; the third is 2,500 blocks below the newest.
    expect(txReadsSince(explorer)).toHaveLength(2)
    expect(new Set(txReadsSince(explorer))).toEqual(txids(payments.slice(0, 2)))
    // The tip asked for once, and not read on once the read had ended.
    expect(tipReadsSince(explorer)).toBe(1)
    expect(explorer.abortedRequests).toEqual([TIP_PATH])

    // The next poll is served what that one kept: no transaction is read,
    // and the tip, asked for with the listing, is again not read on.
    const from = explorer.requests.length
    const next = track(balance())
    await vi.advanceTimersByTimeAsync(100)
    expect(next).toMatchObject({ settled: true, value: split({ available: 60_000 }) })
    expect(txReadsSince(explorer, from)).toEqual([])
    expect(tipReadsSince(explorer, from)).toBe(1)
    expect(explorer.abortedRequests).toEqual([TIP_PATH, TIP_PATH])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads kept young outputs afresh at once for a send, rather than wait for the tip', async () => {
    const { explorer, client, fundingTxReads, balance, payments } = ordinaryAccount()
    // A poll while the tip answers keeps the young two.
    const primed = track(balance())
    await vi.advanceTimersByTimeAsync(100)
    expect(primed).toMatchObject({ settled: true, value: split({ available: 60_000 }) })
    expect(fundingTxReads.size).toBe(2)
    hangTip(explorer)
    const from = explorer.requests.length

    const send = track(getQbitAddressUtxos(client, address, { fundingTxReads }))
    await vi.advanceTimersByTimeAsync(100)

    expect(send.settled).toBe(true)
    expect(send.value).toHaveLength(3)
    // Every one read: the kept young ones afresh, as a send needs while the
    // tip has not shown them deep, and the deep one, whose facts nothing kept.
    expect(txReadsSince(explorer, from)).toHaveLength(3)
    expect(new Set(txReadsSince(explorer, from))).toEqual(txids(payments))
    expect(tipReadsSince(explorer, from)).toBe(1)
    expect(explorer.abortedRequests).toEqual([TIP_PATH])
  })

  it('still waits for the tip to judge a young reward mature, as 1.0.9 did, answering the total with the split unknown at the deadline', async () => {
    const { explorer, balance, payments } = ordinaryAccount()
    const reward = pay(explorer, 5_000_000, { depth: 11, coinbase: true })
    const total = 60_000 + 5_000_000
    hangTip(explorer)

    const first = track(balance())
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS - 1)

    // Its maturity needs the tip: the read waits for it...
    expect(first.settled).toBe(false)
    // ...having read every transaction it needs meanwhile, the reward's too.
    expect(txReadsSince(explorer)).toHaveLength(3)
    expect(new Set(txReadsSince(explorer))).toEqual(txids([payments[0]!, payments[1]!, reward]))
    await vi.advanceTimersByTimeAsync(1)
    // At the deadline, the total with the split unknown: it kept facts the
    // next poll is served, so it does not back off.
    expect(first).toMatchObject({ settled: true, value: incomplete(total) })

    // The next poll reads nothing, waits for the tip again, and keeps
    // nothing new by its deadline: it backs off.
    const from = explorer.requests.length
    const second = track(balance())
    await vi.advanceTimersByTimeAsync(QBIT_BALANCE_READ_DEADLINE_MS)
    expect(second).toMatchObject({ settled: true, value: incomplete(total, true) })
    expect(txReadsSince(explorer, from)).toEqual([])
  })

  it('answers an address its listing alone shows over the cap at once, not waiting for the tip', async () => {
    const { explorer, balance } = setup({ maxOutpoints: 100 })
    const deep = payDeep(explorer, 150, 1_200)
    hangTip(explorer)

    const poll = track(balance())
    await vi.advanceTimersByTimeAsync(100)

    expect(poll).toMatchObject({ settled: true, value: incomplete(sum(deep), true) })
    expect(txReadsSince(explorer)).toEqual([])
    // Asked for with the listing, and not read on once the read had ended.
    expect(tipReadsSince(explorer)).toBe(1)
    expect(explorer.abortedRequests).toEqual([TIP_PATH])
  })

  describe.each([
    [
      'refuses it, the address being over its limit',
      (explorer: FakeQbitExplorer) => {
        explorer.utxoLimit = 5
      },
    ],
    [
      'fails',
      (explorer: FakeQbitExplorer) => {
        explorer.failures.push(({ path }) =>
          path.endsWith('/utxo') ? { status: 404, body: 'not found' } : undefined
        )
      },
    ],
  ])('when the listing %s', (_outcome, breakListing) => {
    it('leaves no tip read behind, for a read of outputs or the balance', async () => {
      const { explorer, client, fundingTxReads, balance } = ordinaryAccount()
      for (let index = 0; index < 7; index += 1) pay(explorer, 1_000 + index, { depth: 1_500 })
      breakListing(explorer)
      hangTip(explorer)

      // One after the other: reads in flight together share one tip request.
      for (const [index, read] of [
        () => getQbitAddressUtxosClassified(client, address, { fundingTxReads }),
        () => balance(),
      ].entries()) {
        const outcome = track(read())
        await vi.advanceTimersByTimeAsync(1_000)

        expect(outcome.settled).toBe(true)
        // It asked for the tip with its listing, and stopped it once the
        // listing had failed: no request left in flight, no timer left.
        expect(tipReadsSince(explorer)).toBe(index + 1)
        expect(explorer.abortedRequests).toHaveLength(index + 1)
        expect(vi.getTimerCount()).toBe(0)
      }
      expect(new Set(explorer.abortedRequests)).toEqual(new Set([TIP_PATH]))
      expect(txReadsSince(explorer)).toEqual([])
    })
  })
})
