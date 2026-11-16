import { describe, expect, it, vi } from 'vitest'

import {
  getQbitAddressUtxos,
  getQbitAddressUtxosClassified,
  getQbitAddressUtxosClassifiedPastLimit,
  getQbitSpendableBalanceV2,
  readQbitAddressUtxos,
} from '../src/utils/qbit-api'
import {
  QBIT_CLASSIFY_MAX_READS_IN_FLIGHT,
  QbitFundingTxReads,
} from '../src/utils/qbit-funding-tx-reads'
import {
  ACCOUNT_ADDRESS,
  ACCOUNT_SCRIPT,
  ClassifyReadsExplorer,
  OTHER_ADDRESS,
  flushMicrotasks,
  scriptOf,
  testTxid,
  unhandledRejectionsDuring,
} from './qbit-classify-reads-fake'

const address = ACCOUNT_ADDRESS
const other = OTHER_ADDRESS

const classify = (
  explorer: ClassifyReadsExplorer,
  target = address,
  options: Parameters<typeof getQbitAddressUtxosClassified>[2] = {}
) => getQbitAddressUtxosClassified(explorer.client as any, target, options)

/**
 * A payment to `target` listed confirmed at `height`, by default the tip's,
 * so that the listing's own newest block shows the outputs `fund` lists
 * deep: a read of outputs is served their kept facts whenever the tip
 * answers, as it reads them afresh while the tip is in flight and nothing
 * else is left. Being young, it is itself read afresh by every read of
 * outputs.
 */
function payNewest(explorer: ClassifyReadsExplorer, target = address, height?: number): string {
  const txid = testTxid(height ?? explorer.tipHeight, 70)
  explorer.addTx(txid, {
    vin: [explorer.input(testTxid(1, 71), 0)],
    outputs: [{ script: scriptOf(target), value: 4_000 }],
    confirmed: true,
  })
  explorer.list(target, {
    txid,
    vout: 0,
    value: 4_000,
    status: { confirmed: true, block_height: height ?? explorer.tipHeight },
  })
  return txid
}

/**
 * For each transaction read started that `counts`, in order, how many of
 * those it counts were in flight already.
 */
function inFlightAtStart(explorer: ClassifyReadsExplorer, counts: (txid: string) => boolean) {
  const atStart: number[] = []
  let inFlight = 0
  const getTx = explorer.client.getTx
  explorer.client.getTx = (txid, options) => {
    if (!counts(txid)) return getTx(txid, options)
    atStart.push(inFlight++)
    return getTx(txid, options).finally(() => {
      inFlight -= 1
    })
  }
  return atStart
}

const most = (values: readonly number[]): number => values.reduce((a, b) => Math.max(a, b), -1)

describe('classification reads are bounded (#169)', () => {
  it('reads its first 4,096 lookups up to 256 at a time and the rest 32 at a time, and at a lower bound a reader sets', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 5_000)
    const atStart = inFlightAtStart(explorer, () => true)

    const classified = await classify(explorer)

    expect(classified.confirmedSpendable).toHaveLength(5_000)
    expect(atStart).toHaveLength(5_000)
    // Its burst, at the bound: each started beside up to 255 others.
    expect(most(atStart.slice(0, 4_096))).toBe(255)
    // Past it, 32 at a time, the rate used and never passed.
    expect(most(atStart.slice(4_096))).toBe(31)
    expect(explorer.peak).toBe(256)
    expect(explorer.inFlight).toBe(0)

    // A reader's own bound, under the sustained rate, holds throughout.
    atStart.length = 0
    explorer.peak = 0
    await classify(explorer, address, {
      fundingTxReads: new QbitFundingTxReads({ maxReadsInFlight: 16 }),
    })
    expect(atStart).toHaveLength(5_000)
    expect(explorer.peak).toBe(16)
  })

  it.each([
    [4_096, 255],
    [4_097, 31],
  ])(
    'reads %i groups, the last of them started beside at most %i others',
    async (groups, beside) => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, groups)
      const atStart = inFlightAtStart(explorer, () => true)

      const classified = await classify(explorer, address, {
        fundingTxReads: new QbitFundingTxReads(),
      })

      expect(classified.confirmedSpendable).toHaveLength(groups)
      expect(atStart).toHaveLength(groups)
      expect(most(atStart.slice(0, 4_096))).toBe(255)
      expect(atStart.at(-1)).toBeLessThanOrEqual(beside)
      expect(explorer.peak).toBe(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    }
  )

  it('spends none of its burst on outputs it classifies from the listing: 20,000 a coinbase maturity deep, then 4,096 to read', async () => {
    const explorer = new ClassifyReadsExplorer()
    // The listing shows these deep: no read of them.
    explorer.fund(address, 20_000)
    // These it reads, all within the burst.
    explorer.fund(address, 4_096, { salt: 7, young: true })
    const atStart = inFlightAtStart(explorer, () => true)

    await getQbitSpendableBalanceV2(
      explorer.client as any,
      address,
      ACCOUNT_SCRIPT,
      undefined,
      undefined,
      {
        fundingTxReads: new QbitFundingTxReads(),
      }
    )

    expect(atStart).toHaveLength(4_096)
    expect(most(atStart)).toBe(255)
    expect(explorer.peak).toBe(256)
  })

  it('spends none of its burst on outputs its kept facts serve: 4,096 served, then 4,096 to read', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 4_096, { young: true })
    const fundingTxReads = new QbitFundingTxReads()
    const balance = () =>
      getQbitSpendableBalanceV2(
        explorer.client as any,
        address,
        ACCOUNT_SCRIPT,
        undefined,
        undefined,
        {
          fundingTxReads,
        }
      )
    await balance()
    // Served from what that read kept, ahead of the new ones in the listing.
    explorer.fund(address, 4_096, { salt: 9, young: true })
    const atStart = inFlightAtStart(explorer, () => true)
    explorer.peak = 0

    await balance()

    expect(atStart).toHaveLength(4_096)
    expect(most(atStart)).toBe(255)
    expect(explorer.peak).toBe(256)
  })

  it('holds two long classifications through one shared reader to the bound in their bursts, and to 32 each after them', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 5_000)
    explorer.fund(other, 5_000, { salt: 7 })
    const theirs = new Set(Array.from({ length: 5_000 }, (_, index) => testTxid(index, 7)))
    const mine = inFlightAtStart(explorer, txid => !theirs.has(txid))
    const others = inFlightAtStart(explorer, txid => theirs.has(txid))
    const fundingTxReads = new QbitFundingTxReads()

    const [first, second] = await Promise.all([
      classify(explorer, address, { fundingTxReads }),
      classify(explorer, other, { fundingTxReads }),
    ])

    expect(first.confirmedSpendable).toHaveLength(5_000)
    expect(second.confirmedSpendable).toHaveLength(5_000)
    expect(explorer.started).toHaveLength(10_000)
    // Their bursts share the bound; past them, each keeps to 32 of its own.
    expect(explorer.peak).toBe(256)
    expect(most(mine.slice(4_096))).toBeLessThanOrEqual(31)
    expect(most(others.slice(4_096))).toBeLessThanOrEqual(31)
    const limiter = fundingTxReads.limiter(explorer.client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
  })

  it('serves a short classification beside a long one past its burst at once, with a burst of its own', async () => {
    const explorer = new ClassifyReadsExplorer()
    // Its burst, then forty rounds of 32, twice what the short one may wait for.
    const longOutputs = 4_096 + 40 * 32
    explorer.fund(address, longOutputs)
    explorer.fund(other, 40, { salt: 7 })
    const fundingTxReads = new QbitFundingTxReads()
    // How many reads waited for a slot as each one started.
    let mostQueued = 0
    const getTx = explorer.client.getTx
    explorer.client.getTx = (txid, options) => {
      mostQueued = Math.max(mostQueued, fundingTxReads.limiter(explorer.client).queued)
      return getTx(txid, options)
    }

    const long = classify(explorer, address, { fundingTxReads })
    while (explorer.started.length < 4_096 + 32) await flushMicrotasks(1)
    mostQueued = 0
    explorer.peak = explorer.inFlight
    const started = explorer.started.length
    const short = await classify(explorer, other, { fundingTxReads })

    expect(short.confirmedSpendable).toHaveLength(40)
    // It did not wait behind the long read's: the long one had read only a
    // few rounds meanwhile.
    expect(explorer.started.length - started - 40).toBeLessThan(20 * 32)
    await expect(long).resolves.toMatchObject({
      confirmedSpendable: expect.objectContaining({ length: longOutputs }),
    })
    // The long one at its sustained rate left the short one its burst: none
    // of its reads waited for a slot.
    expect(mostQueued).toBe(0)
    expect(explorer.peak).toBeGreaterThan(32)
    expect(explorer.peak).toBeLessThanOrEqual(32 + 40)
  })

  it('holds the ancestors of own change to the same bound as funding reads', async () => {
    const explorer = new ClassifyReadsExplorer()
    // 300 pending sends of the account's own, each two unconfirmed
    // transactions deep on a confirmed output of its own.
    for (let index = 0; index < 300; index += 1) {
      const root = testTxid(index, 1)
      const parent = testTxid(index, 2)
      const change = testTxid(index, 3)
      explorer.addTx(root, {
        vin: [explorer.input(testTxid(index, 4), 0)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 30_000 }],
        confirmed: true,
      })
      explorer.addTx(parent, {
        vin: [explorer.input(root, 0, 30_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 20_000 }],
        confirmed: false,
      })
      explorer.addTx(change, {
        vin: [explorer.input(parent, 0, 20_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 10_000 }],
        confirmed: false,
      })
      explorer.list(address, { txid: change, vout: 0, value: 10_000, status: { confirmed: false } })
    }

    const classified = await classify(explorer)

    // Every change output was walked down to its confirmed root.
    expect(explorer.started).toHaveLength(900)
    expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(classified.unconfirmedSpendable).toHaveLength(300)
    // A send may take change only while its ancestors fit qbit Core's limit.
    expect(classified.unconfirmedOwnChange.length).toBeGreaterThan(0)
  })

  it('reads each transaction once in a classification, however many outputs or walks need it', async () => {
    const explorer = new ClassifyReadsExplorer()
    // Two outputs of one transaction.
    const twice = testTxid(1, 1)
    explorer.addTx(twice, {
      vin: [explorer.input(testTxid(1, 9), 0)],
      outputs: [
        { script: ACCOUNT_SCRIPT, value: 1_000 },
        { script: ACCOUNT_SCRIPT, value: 2_000 },
      ],
      confirmed: true,
    })
    explorer.list(address, {
      txid: twice,
      vout: 0,
      value: 1_000,
      status: { confirmed: true, block_height: 10 },
    })
    explorer.list(address, {
      txid: twice,
      vout: 1,
      value: 2_000,
      status: { confirmed: true, block_height: 10 },
    })
    // Two change outputs on one unconfirmed parent, which a walk reads once.
    const parent = testTxid(2, 1)
    explorer.addTx(parent, {
      vin: [explorer.input(twice, 2, 9_000)],
      outputs: [
        { script: ACCOUNT_SCRIPT, value: 4_000 },
        { script: ACCOUNT_SCRIPT, value: 4_000 },
      ],
      confirmed: false,
    })
    for (const [index, vout] of [
      [3, 0],
      [4, 1],
    ] as const) {
      const change = testTxid(index, 1)
      explorer.addTx(change, {
        vin: [explorer.input(parent, vout, 4_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 3_000 }],
        confirmed: false,
      })
      explorer.list(address, { txid: change, vout: 0, value: 3_000, status: { confirmed: false } })
    }
    // Change spending a listed funding transaction's other output: the walk
    // finds it confirmed without reading it again.
    const funding = testTxid(5, 1)
    explorer.addTx(funding, {
      vin: [explorer.input(testTxid(5, 9), 0)],
      outputs: [
        { script: ACCOUNT_SCRIPT, value: 6_000 },
        { script: ACCOUNT_SCRIPT, value: 7_000 },
      ],
      confirmed: true,
    })
    explorer.list(address, {
      txid: funding,
      vout: 1,
      value: 7_000,
      status: { confirmed: true, block_height: 20 },
    })
    const onFunding = testTxid(6, 1)
    explorer.addTx(onFunding, {
      vin: [explorer.input(funding, 0, 6_000)],
      outputs: [{ script: ACCOUNT_SCRIPT, value: 5_000 }],
      confirmed: false,
    })
    explorer.list(address, { txid: onFunding, vout: 0, value: 5_000, status: { confirmed: false } })

    const classified = await classify(explorer)

    expect(classified.confirmedSpendable).toHaveLength(3)
    expect(classified.unconfirmedOwnChange).toHaveLength(3)
    // The parent's own parent is `twice`, read as a funding transaction and
    // found confirmed by the walk without a second read.
    for (const txid of [twice, parent, funding, onFunding, testTxid(3, 1), testTxid(4, 1)]) {
      expect(explorer.readsOf(txid)).toBe(1)
    }
    expect(explorer.started).toHaveLength(6)
  })
})

describe('a classification that fails or is cancelled (#169)', () => {
  it('rejects the lookups waiting past its burst as its caller gives up, though those in flight are stuck, and leaves them unmarked', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 4_096 + 100)
    const fundingTxReads = new QbitFundingTxReads()
    // Past the burst, every read in flight is stuck on the network, deaf to
    // the abort, until released.
    const stuck: { txid: string; release: () => void }[] = []
    const getTx = explorer.client.getTx
    let answered = 0
    explorer.client.getTx = (txid, options) => {
      if (answered++ < 4_096) return getTx(txid, options)
      return new Promise((resolve, reject) => {
        stuck.push({ txid, release: () => getTx(txid).then(resolve, reject) })
      })
    }
    const caller = new AbortController()

    const read = classify(explorer, address, { fundingTxReads, signal: caller.signal })
    read.catch(() => undefined)
    while (stuck.length < 32) await flushMicrotasks(1)
    await flushMicrotasks()
    const view = fundingTxReads.begin(explorer.client)
    const markedOf = () =>
      Array.from({ length: 4_196 }, (_, index) => testTxid(index)).filter(txid =>
        view.fetchingElsewhere(txid)
      )
    // 32 in flight and 68 waiting their turn, all marked as being read.
    expect(stuck).toHaveLength(32)
    expect(markedOf()).toHaveLength(100)

    const reason = new Error('the send screen closed')
    caller.abort(reason)
    await expect(read).rejects.toBe(reason)
    await flushMicrotasks()

    // The 68 waiting were rejected at once: only the stuck ones are still read.
    expect(markedOf().sort()).toEqual(stuck.map(({ txid }) => txid).sort())
    for (const { release } of stuck) release()
    await flushMicrotasks()
    expect(markedOf()).toEqual([])
    const limiter = fundingTxReads.limiter(explorer.client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
  })

  it('stops at the first failed read, cancels the rest and rejects with that failure', async () => {
    const explorer = new ClassifyReadsExplorer()
    const bound = QBIT_CLASSIFY_MAX_READS_IN_FLIGHT
    // Twenty rounds of the bound, one failing in the second.
    const outputs = 20 * bound
    const failing = bound + 4
    explorer.fund(address, outputs)
    const failure = new Error('HTTP 500 from /tx')
    explorer.failures.set(testTxid(failing), failure)
    const fundingTxReads = new QbitFundingTxReads()

    const unhandled = await unhandledRejectionsDuring(async () => {
      await expect(classify(explorer, address, { fundingTxReads })).rejects.toBe(failure)
      const startedWhenItRejected = explorer.started.length
      await flushMicrotasks()
      // Nothing starts once it has failed.
      expect(explorer.started.length).toBe(startedWhenItRejected)
    })

    expect(unhandled).toEqual([])
    // No further than the rounds already under way when it failed.
    expect(explorer.started.length).toBeLessThan(4 * bound)
    expect(explorer.inFlight).toBe(0)
    const limiter = fundingTxReads.limiter(explorer.client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    // What it read before failing is kept; the limiter takes the next one.
    expect(fundingTxReads.size).toBeGreaterThanOrEqual(failing)
    explorer.failures.clear()
    explorer.started.length = 0
    await expect(classify(explorer, address, { fundingTxReads })).resolves.toMatchObject({
      confirmedSpendable: expect.any(Array),
    })
    expect(explorer.started.length).toBeLessThanOrEqual(outputs - failing)
    expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
  })

  it('cancels every read in flight when one fails, and starts no other', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 500)
    explorer.hold()
    const failure = new Error('HTTP 502 from /tx')

    const unhandled = await unhandledRejectionsDuring(async () => {
      const running = classify(explorer)
      await flushMicrotasks()
      expect(explorer.started).toHaveLength(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
      explorer.fail(testTxid(5), failure)
      await expect(running).rejects.toBe(failure)
      explorer.release()
      await flushMicrotasks()
    })

    expect(unhandled).toEqual([])
    expect(explorer.started).toHaveLength(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    // The others were in flight, and were cancelled rather than answered.
    expect(explorer.aborted).toHaveLength(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT - 1)
    expect(explorer.inFlight).toBe(0)
  })

  it('keeps an ancestor it cannot read a failure of that output only', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 30)
    const parent = testTxid(1, 2)
    const change = testTxid(1, 3)
    explorer.addTx(change, {
      vin: [explorer.input(parent, 0)],
      outputs: [{ script: ACCOUNT_SCRIPT, value: 9_000 }],
      confirmed: false,
    })
    explorer.list(address, { txid: change, vout: 0, value: 9_000, status: { confirmed: false } })
    explorer.failures.set(parent, new Error('offline'))

    const classified = await classify(explorer)

    expect(classified.confirmedSpendable).toHaveLength(30)
    expect(classified.unconfirmedSpendable).toHaveLength(1)
    expect(classified.unconfirmedOwnChange).toHaveLength(0)
  })

  it('stops scheduling once its signal aborts, cancels the reads in flight and leaves the limiter idle', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 1_000)
    explorer.hold()
    const fundingTxReads = new QbitFundingTxReads()
    const controller = new AbortController()
    const reason = new Error('the balance card closed')

    const unhandled = await unhandledRejectionsDuring(async () => {
      const running = classify(explorer, address, { fundingTxReads, signal: controller.signal })
      await flushMicrotasks()
      expect(explorer.started).toHaveLength(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
      controller.abort(reason)
      await expect(running).rejects.toBe(reason)
      await flushMicrotasks()
    })

    expect(unhandled).toEqual([])
    expect(explorer.started).toHaveLength(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(explorer.aborted).toHaveLength(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(explorer.inFlight).toBe(0)
    const limiter = fundingTxReads.limiter(explorer.client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
    // The same limiter runs the next classification whole.
    explorer.release()
    await expect(classify(explorer, address, { fundingTxReads })).resolves.toMatchObject({
      confirmedSpendable: expect.objectContaining({ length: 1_000 }),
    })
    expect(explorer.peak).toBe(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
  })

  it("never cancels another caller's reads when one caller gives up", async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 200)
    explorer.fund(other, 200, { salt: 7 })
    explorer.hold()
    const fundingTxReads = new QbitFundingTxReads()
    const controller = new AbortController()
    const reason = new Error('gave up')

    const abandoned = classify(explorer, address, { fundingTxReads, signal: controller.signal })
    const kept = classify(explorer, other, { fundingTxReads })
    await flushMicrotasks()
    controller.abort(reason)
    await expect(abandoned).rejects.toBe(reason)
    explorer.release()

    const classified = await kept
    expect(classified.confirmedSpendable).toHaveLength(200)
    const otherTxids = new Set(Array.from({ length: 200 }, (_, index) => testTxid(index, 7)))
    expect(explorer.aborted.length).toBeGreaterThan(0)
    expect(explorer.aborted.filter(txid => otherTxids.has(txid))).toEqual([])
    expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
  })

  it('keeps the send path failing on a failed funding read', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 50)
    const failure = new Error('HTTP 503 from /tx')
    explorer.failures.set(testTxid(10), failure)
    await expect(
      getQbitAddressUtxos(explorer.client as any, address, {
        fundingTxReads: new QbitFundingTxReads(),
      })
    ).rejects.toBe(failure)
  })
})

/**
 * The account's pending payment A, which pays it twice (A:0, A:1) and more
 * (`extra` further outputs) from a confirmed output of its own, and its own
 * change spending A:0 (B) and each extra output (C, D …). The change is
 * listed first, then `between` confirmed outputs, then A:1: each walk from
 * the change reads A as an ancestor before A's own outputs are classified.
 */
function listPaymentSpentByChange(explorer: ClassifyReadsExplorer, between: number, extra = 0) {
  const root = testTxid(1, 20)
  const payment = testTxid(1, 21)
  explorer.addTx(root, {
    vin: [explorer.input(testTxid(1, 23), 0)],
    outputs: [{ script: ACCOUNT_SCRIPT, value: 90_000 }],
    confirmed: true,
  })
  explorer.addTx(payment, {
    vin: [explorer.input(root, 0, 90_000)],
    outputs: [
      { script: ACCOUNT_SCRIPT, value: 20_000 },
      { script: ACCOUNT_SCRIPT, value: 25_000 },
      ...Array.from({ length: extra }, () => ({ script: ACCOUNT_SCRIPT, value: 10_000 })),
    ],
    confirmed: false,
  })
  const changes = [0, ...Array.from({ length: extra }, (_, index) => index + 2)].map(
    (vout, index) => {
      const change = testTxid(index + 2, 22)
      explorer.addTx(change, {
        vin: [explorer.input(payment, vout, vout === 0 ? 20_000 : 10_000)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 5_000 }],
        confirmed: false,
      })
      explorer.list(address, { txid: change, vout: 0, value: 5_000, status: { confirmed: false } })
      return change
    }
  )
  explorer.fund(address, between, { salt: 30 })
  explorer.list(address, { txid: payment, vout: 1, value: 25_000, status: { confirmed: false } })
  return { payment, changes }
}

/**
 * The first read of `txid` fails with `error`, and those after it answer.
 * The reads themselves are left as they are: nothing here handles their
 * rejections for the code under test.
 */
function failFirstReadOf(explorer: ClassifyReadsExplorer, txid: string, error: unknown): void {
  explorer.failures.set(txid, error)
  const getTx = explorer.client.getTx
  let reads = 0
  explorer.client.getTx = (id, options) => {
    if (id === txid && ++reads === 2) explorer.failures.delete(txid)
    return getTx(id, options)
  }
}

const outpoints = (utxos: readonly { txid: string; vout: number }[]): string[] =>
  utxos.map(({ txid, vout }) => `${txid}:${vout}`)

describe('an ancestor read that fails, of a transaction listed too (#169)', () => {
  // More outputs between the change and the payment's own than workers take
  // at once, so the walk reaches the payment before that output is taken.
  const between = 2 * QBIT_CLASSIFY_MAX_READS_IN_FLIGHT

  it("keeps it a failure of the walk only: the transaction's own outputs read it afresh", async () => {
    const explorer = new ClassifyReadsExplorer()
    const { payment, changes } = listPaymentSpentByChange(explorer, between)
    const failure = new Error('HTTP 503 from /tx')
    failFirstReadOf(explorer, payment, failure)

    let classified!: Awaited<ReturnType<typeof classify>>
    const unhandled = await unhandledRejectionsDuring(async () => {
      classified = await classify(explorer)
    })

    expect(unhandled).toEqual([])
    expect(classified.confirmedSpendable).toHaveLength(between)
    expect(outpoints(classified.unconfirmedSpendable)).toEqual([`${changes[0]}:0`, `${payment}:1`])
    // The change's walk could not read the payment: someone else's for this
    // read. The payment's own output was read afresh and is the account's.
    expect(outpoints(classified.unconfirmedOwnChange)).toEqual([`${payment}:1`])
    // The failed read by the walk, and one more for its own output.
    expect(explorer.readsOf(payment)).toBe(2)
    expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(explorer.inFlight).toBe(0)
  })

  it('keeps the send path readable then too', async () => {
    const explorer = new ClassifyReadsExplorer()
    const { payment, changes } = listPaymentSpentByChange(explorer, between)
    failFirstReadOf(explorer, payment, new Error('HTTP 503 from /tx'))

    const utxos = await getQbitAddressUtxos(explorer.client as any, address, {
      fundingTxReads: new QbitFundingTxReads(),
    })

    // The confirmed outputs and the payment's own; not the change whose walk failed.
    expect(utxos).toHaveLength(between + 1)
    expect(outpoints(utxos)).toContain(`${payment}:1`)
    expect(outpoints(utxos)).not.toContain(`${changes[0]}:0`)
  })

  it('shares that failure between the walks that reach it, and reads it once more for its own outputs', async () => {
    const explorer = new ClassifyReadsExplorer()
    const { payment, changes } = listPaymentSpentByChange(explorer, between, 2)
    failFirstReadOf(explorer, payment, new Error('timed out'))

    const classified = await classify(explorer)

    expect(outpoints(classified.unconfirmedSpendable)).toEqual([
      ...changes.map(change => `${change}:0`),
      `${payment}:1`,
    ])
    expect(outpoints(classified.unconfirmedOwnChange)).toEqual([`${payment}:1`])
    expect(explorer.readsOf(payment)).toBe(2)
  })

  it('still fails on the read for its own outputs when that one fails too', async () => {
    const explorer = new ClassifyReadsExplorer()
    const { payment } = listPaymentSpentByChange(explorer, between)
    const failure = new Error('HTTP 503 from /tx')
    explorer.failures.set(payment, failure)

    const unhandled = await unhandledRejectionsDuring(async () => {
      await expect(classify(explorer)).rejects.toBe(failure)
      await flushMicrotasks()
    })

    expect(unhandled).toEqual([])
    expect(explorer.readsOf(payment)).toBe(2)
    expect(explorer.inFlight).toBe(0)
  })

  /**
   * Hold the first read of `txid`, which the change's walk starts, until
   * `release` answers it with `first`; every later read of it answers with
   * `later`, or the transaction. `reads()` counts the reads of it.
   */
  function holdFirstReadOf(
    explorer: ClassifyReadsExplorer,
    txid: string,
    first: unknown,
    later?: unknown
  ) {
    const getTx = explorer.client.getTx
    let reads = 0
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    explorer.client.getTx = (id, options) => {
      if (id !== txid) return getTx(id, options)
      reads += 1
      if (reads > 1) return later === undefined ? getTx(id, options) : Promise.reject(later)
      return released.then(() => Promise.reject(first))
    }
    return { release, reads: () => reads }
  }

  it("reads it afresh for its own outputs when they joined the walk's read and it failed", async () => {
    const explorer = new ClassifyReadsExplorer()
    const { payment, changes } = listPaymentSpentByChange(explorer, between)
    const held = holdFirstReadOf(explorer, payment, new Error('HTTP 503 from /tx'))

    let classified!: Awaited<ReturnType<typeof classify>>
    const unhandled = await unhandledRejectionsDuring(async () => {
      const running = classify(explorer)
      // The walk's read is held while the other outputs are read and the
      // payment's own output, last in the listing, asks for it too.
      await flushMicrotasks(500)
      expect(held.reads()).toBe(1)
      held.release()
      classified = await running
    })

    expect(unhandled).toEqual([])
    expect(held.reads()).toBe(2)
    expect(classified.confirmedSpendable).toHaveLength(between)
    expect(outpoints(classified.unconfirmedSpendable)).toEqual([`${changes[0]}:0`, `${payment}:1`])
    // The change loses only its own-change standing; the payment's own output is classified.
    expect(outpoints(classified.unconfirmedOwnChange)).toEqual([`${payment}:1`])
    expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
  })

  it('fails with the fresh read for its own outputs when that one fails too', async () => {
    const explorer = new ClassifyReadsExplorer()
    listPaymentSpentByChange(explorer, between)
    const payment = testTxid(1, 21)
    const fresh = new Error('HTTP 502 from /tx')
    const held = holdFirstReadOf(explorer, payment, new Error('HTTP 503 from /tx'), fresh)

    const unhandled = await unhandledRejectionsDuring(async () => {
      const running = classify(explorer)
      running.catch(() => undefined)
      await flushMicrotasks(500)
      held.release()
      await expect(running).rejects.toBe(fresh)
      await flushMicrotasks()
    })

    expect(unhandled).toEqual([])
    expect(held.reads()).toBe(2)
    expect(explorer.inFlight).toBe(0)
  })

  it('reads nothing afresh once the caller has given up', async () => {
    const explorer = new ClassifyReadsExplorer()
    listPaymentSpentByChange(explorer, 30)
    const payment = testTxid(1, 21)
    const held = holdFirstReadOf(explorer, payment, new Error('HTTP 503 from /tx'))
    const fundingTxReads = new QbitFundingTxReads()
    const controller = new AbortController()
    const reason = new Error('the send screen closed')

    const unhandled = await unhandledRejectionsDuring(async () => {
      const running = classify(explorer, address, { fundingTxReads, signal: controller.signal })
      running.catch(() => undefined)
      await flushMicrotasks(500)
      controller.abort(reason)
      held.release()
      await expect(running).rejects.toBe(reason)
      await flushMicrotasks()
    })

    expect(unhandled).toEqual([])
    expect(held.reads()).toBe(1)
    const limiter = fundingTxReads.limiter(explorer.client)
    expect([limiter.inFlight, limiter.queued]).toEqual([0, 0])
  })

  it('reads it afresh at most once, in turn with the other reads, for a send too', async () => {
    const explorer = new ClassifyReadsExplorer()
    const { payment, changes } = listPaymentSpentByChange(explorer, between)
    const held = holdFirstReadOf(explorer, payment, new Error('HTTP 503 from /tx'))
    const fundingTxReads = new QbitFundingTxReads()

    const running = getQbitAddressUtxos(explorer.client as any, address, { fundingTxReads })
    await flushMicrotasks(2_000)
    held.release()
    const utxos = await running

    expect(held.reads()).toBe(2)
    expect(outpoints(utxos)).toContain(`${payment}:1`)
    expect(outpoints(utxos)).not.toContain(`${changes[0]}:0`)
    expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    expect(fundingTxReads.limiter(explorer.client).inFlight).toBe(0)
  })

  it.each([
    ['answers', undefined, 1],
    ['fails', new Error('HTTP 503 from /tx'), 1],
  ])(
    'lets a walk share the read of a listed transaction that is read for its own outputs first, which %s',
    async (_outcome, failure, reads) => {
      const explorer = new ClassifyReadsExplorer()
      // The payment's own output first: its read is in flight when the walk reaches it.
      const { payment, changes } = listPaymentSpentByChange(explorer, 0)
      const listing = explorer.listings.get(address)!
      explorer.listings.set(address, [listing[1], listing[0]])
      if (failure) explorer.failures.set(payment, failure)

      const classifying = classify(explorer)

      if (failure) {
        // A failed read of a funding transaction fails the classification, walk or no walk.
        await expect(classifying).rejects.toBe(failure)
      } else {
        const classified = await classifying
        expect(outpoints(classified.unconfirmedOwnChange)).toEqual([
          `${payment}:1`,
          `${changes[0]}:0`,
        ])
      }
      expect(explorer.readsOf(payment)).toBe(reads)
    }
  )
})

describe('funding-transaction facts kept between reads (#169)', () => {
  it('classifies an unchanged output set again without reading a transaction', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 2_000, { coinbaseCount: 1_000 })
    const fundingTxReads = new QbitFundingTxReads()
    const first = await classify(explorer, address, { fundingTxReads })
    explorer.started.length = 0

    const second = await classify(explorer, address, { fundingTxReads })

    expect(explorer.started).toEqual([])
    expect(second).toEqual(first)
    // The send path takes them from the same facts.
    await expect(
      getQbitAddressUtxos(explorer.client as any, address, { fundingTxReads })
    ).resolves.toHaveLength(first.confirmedSpendable.length)
    expect(explorer.started).toEqual([])
  })

  it('reads an unconfirmed output afresh every time, and serves it once it confirms deep enough', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 20)
    payNewest(explorer)
    const pending = testTxid(1, 5)
    explorer.addTx(pending, {
      vin: [explorer.input(testTxid(1, 6), 0)],
      outputs: [{ script: ACCOUNT_SCRIPT, value: 8_000 }],
      confirmed: false,
    })
    explorer.list(address, { txid: pending, vout: 0, value: 8_000, status: { confirmed: false } })
    const fundingTxReads = new QbitFundingTxReads()

    await classify(explorer, address, { fundingTxReads })
    await classify(explorer, address, { fundingTxReads })
    expect(explorer.readsOf(pending)).toBe(2)
    expect(explorer.readsOf(testTxid(0))).toBe(1)

    // It confirms: no coinbase, it is still read afresh while a coinbase
    // that young would be immature...
    const listed = explorer.listings.get(address)!.at(-1)!
    listed.status = { confirmed: true, block_height: 1_900 }
    await classify(explorer, address, { fundingTxReads })
    expect(explorer.readsOf(pending)).toBe(3)
    // ...and the facts kept serve it once it is 1,000 blocks deep, as the
    // listing's newest block, at the tip, shows it.
    explorer.tipHeight = 2_899
    payNewest(explorer, address, 2_899)
    const classified = await classify(explorer, address, { fundingTxReads })
    expect(explorer.readsOf(pending)).toBe(3)
    expect(classified.confirmedSpendable.map(utxo => utxo.txid)).toContain(pending)
  })

  describe('a kept "not a coinbase" answer, which a send relies on to skip coinbase maturity', () => {
    /** A coinbase reward to the account, listed confirmed at `height`. */
    function reward(explorer: ClassifyReadsExplorer, height: number) {
      const txid = testTxid(1, 11)
      explorer.addTx(txid, {
        vin: [{ is_coinbase: true }],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 5_000_000 }],
        confirmed: true,
      })
      explorer.list(address, {
        txid,
        vout: 0,
        value: 5_000_000,
        status: { confirmed: true, block_height: height },
      })
      return txid
    }

    it('cannot make a young coinbase reward spendable after the one read it was wrong for', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 5)
      // Ten blocks deep: a coinbase output there is still immature.
      const txid = reward(explorer, explorer.tipHeight - 9)
      const fundingTxReads = new QbitFundingTxReads()
      // One wrong answer: the explorer says the reward is no coinbase.
      const tx = explorer.txs.get(txid)!
      tx['vin'] = [explorer.input(testTxid(1, 12), 0, 5_000_000)]
      const wrong = await classify(explorer, address, { fundingTxReads })
      expect(wrong.confirmedSpendable.map(utxo => utxo.txid)).toContain(txid)
      // The explorer answers right again.
      tx['vin'] = [{ is_coinbase: true }]

      const classified = await classify(explorer, address, { fundingTxReads })
      const sendable = await getQbitAddressUtxos(explorer.client as any, address, {
        fundingTxReads,
      })

      // A send may not select it: the reward was read afresh while young,
      // and that read's answer is the one kept since.
      expect(sendable.map(utxo => utxo.txid)).not.toContain(txid)
      expect(classified.confirmedSpendable.map(utxo => utxo.txid)).not.toContain(txid)
      expect(classified.immature.map(utxo => utxo.txid)).toEqual([txid])
      expect(explorer.readsOf(txid)).toBe(2)
    })

    it('is served once the output is as deep as a coinbase must be to mature, and read afresh until then', async () => {
      const explorer = new ClassifyReadsExplorer()
      // At the tip, the newest payment: each depth below is the listing's own.
      const newest = payNewest(explorer)
      // One block short of maturity, and exactly mature (1,000 deep).
      const young = testTxid(1, 13)
      const deep = testTxid(2, 13)
      for (const [txid, height] of [
        [young, explorer.tipHeight - 998],
        [deep, explorer.tipHeight - 999],
      ] as const) {
        explorer.addTx(txid, {
          vin: [explorer.input(testTxid(3, 13), 0)],
          outputs: [{ script: ACCOUNT_SCRIPT, value: 7_000 }],
          confirmed: true,
        })
        explorer.list(address, {
          txid,
          vout: 0,
          value: 7_000,
          status: { confirmed: true, block_height: height },
        })
      }
      const fundingTxReads = new QbitFundingTxReads()

      for (let poll = 0; poll < 3; poll += 1) {
        const classified = await classify(explorer, address, { fundingTxReads })
        expect(classified.confirmedSpendable.map(utxo => utxo.txid).sort()).toEqual(
          [newest, young, deep].sort()
        )
      }

      expect(explorer.readsOf(young)).toBe(3)
      expect(explorer.readsOf(deep)).toBe(1)
      // One tip read a classification, asked for with the listing, to tell
      // which kept answers may serve.
      expect(explorer.tipReads).toBe(3)
    })

    it('serves kept coinbase answers at any depth, judging maturity from the fresh tip', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 50, { coinbaseCount: 50 })
      const txid = reward(explorer, explorer.tipHeight - 9)
      const fundingTxReads = new QbitFundingTxReads()
      await classify(explorer, address, { fundingTxReads })
      explorer.started.length = 0

      const young = await classify(explorer, address, { fundingTxReads })
      explorer.tipHeight += 991
      const mature = await classify(explorer, address, { fundingTxReads })

      // A mining payout address still polls without a /tx read.
      expect(explorer.started).toEqual([])
      expect(young.immature.map(utxo => utxo.txid)).toEqual([txid])
      expect(mature.immature).toEqual([])
      expect(mature.confirmedSpendable.map(utxo => utxo.txid)).toContain(txid)
    })

    it('keeps the strict rule for every read of outputs, whatever its options say', async () => {
      const explorer = new ClassifyReadsExplorer()
      const young = testTxid(1, 14)
      explorer.addTx(young, {
        vin: [explorer.input(testTxid(2, 14), 0)],
        outputs: [{ script: ACCOUNT_SCRIPT, value: 7_000 }],
        confirmed: true,
      })
      explorer.list(address, {
        txid: young,
        vout: 0,
        value: 7_000,
        status: { confirmed: true, block_height: explorer.tipHeight - 9 },
      })
      const fundingTxReads = new QbitFundingTxReads()
      const client = explorer.client as any
      // Even an option the balance read sets for itself is not taken from a caller.
      const options = { fundingTxReads, balanceOnly: true } as any
      const reads = [
        () => getQbitAddressUtxosClassified(client, address, { fundingTxReads }),
        () => getQbitAddressUtxosClassified(client, address, options),
        () => getQbitAddressUtxos(client, address, options),
        () => readQbitAddressUtxos(client, address, options),
        () => getQbitAddressUtxosClassifiedPastLimit(client, address, options),
      ]

      for (const read of reads) await read()

      expect(explorer.readsOf(young)).toBe(reads.length)
    })

    it('never lets the balance hand a young reward to a send after one wrong answer', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 5)
      const txid = reward(explorer, explorer.tipHeight - 9)
      const fundingTxReads = new QbitFundingTxReads()
      const client = explorer.client as any
      const balance = () =>
        getQbitSpendableBalanceV2(client, address, ACCOUNT_SCRIPT, undefined, undefined, {
          fundingTxReads,
        })
      const sendable = async () =>
        (await getQbitAddressUtxos(client, address, { fundingTxReads })).map(utxo => utxo.txid)
      const tx = explorer.txs.get(txid)!
      // One wrong answer, during a balance poll: the reward is no coinbase.
      tx['vin'] = [explorer.input(testTxid(1, 12), 0, 5_000_000)]
      const wrong = await balance()
      tx['vin'] = [{ is_coinbase: true }]
      const funded = wrong.totalBalance - 5_000_000

      // The residual: the balance serves the kept answer at any depth, so it
      // still counts the reward as Available, without reading it again...
      const before = explorer.readsOf(txid)
      await expect(balance()).resolves.toMatchObject({ availableBalance: wrong.totalBalance })
      expect(explorer.readsOf(txid)).toBe(before)
      // ...but no read of outputs hands it to a send, the first one after the
      // wrong answer or any later one.
      expect(await sendable()).not.toContain(txid)
      expect(await sendable()).not.toContain(txid)
      // That read's answer replaced the kept one: the balance no longer counts it.
      await expect(balance()).resolves.toMatchObject({
        availableBalance: funded,
        immatureBalance: 5_000_000,
      })
    })

    /** `count` payments to the account that are not coinbase outputs, listed confirmed at `height`. */
    function payments(
      explorer: ClassifyReadsExplorer,
      count: number,
      height: number,
      salt: number
    ): string[] {
      return Array.from({ length: count }, (_, index) => {
        const txid = testTxid(index, salt)
        explorer.addTx(txid, {
          vin: [explorer.input(testTxid(index, salt + 1), 0)],
          outputs: [{ script: ACCOUNT_SCRIPT, value: 6_000 }],
          confirmed: true,
        })
        explorer.list(address, {
          txid,
          vout: 0,
          value: 6_000,
          status: { confirmed: true, block_height: height },
        })
        return txid
      })
    }

    it('reads afresh only what the listing cannot show deep when the tip cannot be read, rather than failing an account with no coinbase output', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 30)
      // Ten blocks deep: the listing's own newest block puts the rest far below it.
      const young = payments(explorer, 3, explorer.tipHeight - 9, 15)
      const fundingTxReads = new QbitFundingTxReads()
      await classify(explorer, address, { fundingTxReads })
      explorer.started.length = 0
      explorer.tipReads = 0
      explorer.tipFailure = new Error('HTTP 503 from /blocks/tip/height')

      const classified = await classify(explorer, address, { fundingTxReads })

      expect(classified.confirmedSpendable).toHaveLength(33)
      expect(explorer.started.sort()).toEqual([...young].sort())
      expect(explorer.tipReads).toBe(1)
    })

    it('reads only the young ones of 20,000 kept outputs when the tip cannot be read', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 20_000)
      const young = payments(explorer, 5, explorer.tipHeight - 9, 15)
      const fundingTxReads = new QbitFundingTxReads()
      await classify(explorer, address, { fundingTxReads })
      explorer.started.length = 0
      explorer.tipFailure = new Error('HTTP 503 from /blocks/tip/height')

      const sendable = await getQbitAddressUtxos(explorer.client as any, address, {
        fundingTxReads,
      })

      expect(sendable).toHaveLength(20_005)
      expect(explorer.started.sort()).toEqual([...young].sort())
    })

    it('serves kept outputs the listing alone shows deep without waiting on the tip it asked for', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 2_000)
      const fundingTxReads = new QbitFundingTxReads()
      await classify(explorer, address, { fundingTxReads })
      // New payments of ten blocks ago, not read yet; the tip hangs.
      const fresh = payments(explorer, 3, explorer.tipHeight - 9, 15)
      explorer.started.length = 0
      explorer.tipReads = 0
      explorer.holdTip()

      // It answers while the tip, asked for with the listing, still hangs.
      const classified = await classify(explorer, address, { fundingTxReads })

      expect(classified.confirmedSpendable).toHaveLength(2_003)
      expect(explorer.started.sort()).toEqual([...fresh].sort())
      expect(explorer.tipReads).toBe(1)
      explorer.releaseTip()
    })

    it('never takes the listing for the tip in judging a coinbase output mature', async () => {
      const explorer = new ClassifyReadsExplorer()
      // A reward the tip says is ten blocks deep, and a payment the listing
      // puts 1,500 blocks above it, as a listing ahead of the tip would.
      const txid = reward(explorer, explorer.tipHeight - 9)
      payments(explorer, 1, explorer.tipHeight + 1_491, 15)
      const fundingTxReads = new QbitFundingTxReads()
      await classify(explorer, address, { fundingTxReads })

      const classified = await classify(explorer, address, { fundingTxReads })
      const sendable = await getQbitAddressUtxos(explorer.client as any, address, {
        fundingTxReads,
      })

      expect(classified.immature.map(utxo => utxo.txid)).toEqual([txid])
      expect(sendable.map(utxo => utxo.txid)).not.toContain(txid)
    })

    it('goes on with the outputs that need no tip while the tip hangs, then reads the rest afresh rather than wait', async () => {
      const explorer = new ClassifyReadsExplorer()
      // Young payments first in the listing: more of them than workers.
      const young = payments(explorer, 20, explorer.tipHeight - 9, 15)
      explorer.fund(address, 10)
      const fundingTxReads = new QbitFundingTxReads()
      await classify(explorer, address, { fundingTxReads })
      // Old payments the wallet has not read yet, after them in the listing.
      const old = payments(explorer, 40, 150, 17)
      explorer.started.length = 0
      explorer.tipReads = 0
      explorer.holdTip()

      // It answers while the tip still hangs.
      const classified = await classify(explorer, address, { fundingTxReads })

      expect(classified.confirmedSpendable).toHaveLength(70)
      // Every old one first, and only then the young ones, whose kept facts
      // only the tip could have let serve.
      expect([...explorer.started.slice(0, 40)].sort()).toEqual([...old].sort())
      expect([...explorer.started.slice(40)].sort()).toEqual([...young].sort())
      expect(explorer.tipReads).toBe(1)
      explorer.releaseTip()
    })
  })

  describe("the output script, which only the address's own may be kept as", () => {
    // A valid P2MR script, but not the one the address is paid with.
    const wrongScript = `5220${'dd'.repeat(32)}`

    /** A payment to the account listed confirmed at `height`, whose first answer gives `wrongScript`. */
    function answeredWrongOnce(explorer: ClassifyReadsExplorer, height: number) {
      const txid = testTxid(1, 40)
      explorer.addTx(txid, {
        vin: [explorer.input(testTxid(2, 40), 0)],
        outputs: [{ script: wrongScript, value: 8_000 }],
        confirmed: true,
      })
      explorer.list(address, {
        txid,
        vout: 0,
        value: 8_000,
        status: { confirmed: true, block_height: height },
      })
      const right = () => {
        ;(explorer.txs.get(txid)!['vout'] as { scriptpubkey: string }[])[0]!.scriptpubkey =
          ACCOUNT_SCRIPT
      }
      return { txid, right }
    }

    const scriptOfOutput = (utxos: readonly { txid: string; scriptPk: string }[], txid: string) =>
      utxos.find(utxo => utxo.txid === txid)?.scriptPk

    it('keeps no wrong script from one answer: the next read of outputs reads it again', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 5)
      payNewest(explorer)
      // Deep, so a kept answer would serve the read of outputs.
      const { txid, right } = answeredWrongOnce(explorer, 100)
      const fundingTxReads = new QbitFundingTxReads()
      const read = () => getQbitAddressUtxos(explorer.client as any, address, { fundingTxReads })

      // The one wrong answer is used for that read, as ever.
      expect(scriptOfOutput(await read(), txid)).toBe(wrongScript)
      right()

      expect(scriptOfOutput(await read(), txid)).toBe(ACCOUNT_SCRIPT)
      expect(explorer.readsOf(txid)).toBe(2)
      // The right one is kept, and serves from then on.
      expect(scriptOfOutput(await read(), txid)).toBe(ACCOUNT_SCRIPT)
      expect(explorer.readsOf(txid)).toBe(2)
    })

    it('keeps no wrong script for the balance either, which serves any depth', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 5)
      const { txid, right } = answeredWrongOnce(explorer, explorer.tipHeight - 9)
      const fundingTxReads = new QbitFundingTxReads()
      const balance = () =>
        getQbitSpendableBalanceV2(
          explorer.client as any,
          address,
          ACCOUNT_SCRIPT,
          undefined,
          undefined,
          { fundingTxReads }
        )
      const wrong = await balance()
      // Paid to another script, as the answer said: not the account's to spend.
      expect(wrong.availableBalance).toBe(wrong.totalBalance - 8_000)
      right()

      await expect(balance()).resolves.toMatchObject({ availableBalance: wrong.totalBalance })
      expect(explorer.readsOf(txid)).toBe(2)
    })

    it('never serves a kept fact to a read of another address that lists the same outpoint', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 3)
      const newest = payNewest(explorer)
      const fundingTxReads = new QbitFundingTxReads()
      await classify(explorer, address, { fundingTxReads })
      // Another address's listing names one of this address's outputs.
      const shared = explorer.listings.get(address)![1]!
      explorer.list(other, { ...shared, status: { ...shared.status } })
      explorer.started.length = 0

      const classified = await classify(explorer, other, { fundingTxReads })

      expect(explorer.started).toEqual([shared.txid])
      // Classified from the fresh answer: it pays this address's script.
      expect(scriptOfOutput(classified.confirmedSpendable, shared.txid)).toBe(ACCOUNT_SCRIPT)
      // What this address keeps still serves it: only its young newest
      // payment is read afresh, as every read of outputs reads it.
      explorer.started.length = 0
      await classify(explorer, address, { fundingTxReads })
      expect(explorer.started).toEqual([newest])
    })

    it('keeps and serves nothing for an address it cannot decode, its reads still bounded', async () => {
      const explorer = new ClassifyReadsExplorer()
      const undecodable = 'qbrt1znotanaddress'
      // More than the bound, so that only the bound holds its reads to it.
      const outputs = 2 * QBIT_CLASSIFY_MAX_READS_IN_FLIGHT
      for (let index = 0; index < outputs; index += 1) {
        const txid = testTxid(index, 41)
        explorer.addTx(txid, {
          vin: [explorer.input(testTxid(index, 42), 0)],
          outputs: [{ script: ACCOUNT_SCRIPT, value: 1_000 }],
          confirmed: true,
        })
        explorer.list(undecodable, {
          txid,
          vout: 0,
          value: 1_000,
          status: { confirmed: true, block_height: 100 },
        })
      }
      const fundingTxReads = new QbitFundingTxReads()

      await classify(explorer, undecodable, { fundingTxReads })
      await classify(explorer, undecodable, { fundingTxReads })

      expect(explorer.started).toHaveLength(2 * outputs)
      expect(fundingTxReads.size).toBe(0)
      expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
    })
  })

  it('refuses a kept output whose listed value no longer matches, and reads it afresh next time', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 10)
    payNewest(explorer)
    const fundingTxReads = new QbitFundingTxReads()
    await classify(explorer, address, { fundingTxReads })
    const listed = explorer.listings.get(address)![3]!
    listed.value += 1
    explorer.started.length = 0

    await expect(classify(explorer, address, { fundingTxReads })).rejects.toThrow(
      `qbit UTXO output value mismatch for ${listed.txid}:0`
    )
    expect(explorer.readsOf(listed.txid)).toBe(0)
    // Not served again: the next read asks the explorer, which still disagrees.
    await expect(classify(explorer, address, { fundingTxReads })).rejects.toThrow(
      'qbit UTXO output value mismatch'
    )
    expect(explorer.readsOf(listed.txid)).toBe(1)
  })

  it('serves nothing after a clear, and keeps nothing a read that began before it finds', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 100)
    const fundingTxReads = new QbitFundingTxReads()
    await classify(explorer, address, { fundingTxReads })

    fundingTxReads.clear()
    explorer.started.length = 0
    await classify(explorer, address, { fundingTxReads })
    expect(explorer.started).toHaveLength(100)

    // A read in flight across a clear (a lock, a reset, a network switch).
    fundingTxReads.clear()
    explorer.hold()
    const running = classify(explorer, address, { fundingTxReads })
    await flushMicrotasks()
    fundingTxReads.clear()
    explorer.release()
    await running
    expect(fundingTxReads.size).toBe(0)
    explorer.started.length = 0
    await classify(explorer, address, { fundingTxReads })
    expect(explorer.started).toHaveLength(100)
  })

  describe('a clear while the listing is in flight', () => {
    /** `explorer`'s client, with its next listing held until `release`. */
    function holdingNextListing(explorer: ClassifyReadsExplorer) {
      let release: () => void = () => undefined
      const released = new Promise<void>(resolve => (release = resolve))
      let held = false
      const client = {
        ...explorer.client,
        getAddressUtxos: async (target: string) => {
          if (!held) {
            held = true
            await released
          }
          return explorer.client.getAddressUtxos(target)
        },
      }
      return { client, release }
    }

    // Each over outputs whose kept facts it would be served: a read of
    // outputs is served them a coinbase maturity deep, and the balance reads
    // the transactions of younger ones alone.
    const readers: [
      string,
      (client: unknown, fundingTxReads?: QbitFundingTxReads) => Promise<unknown>,
      { young: boolean },
    ][] = [
      [
        'a classification',
        (client, fundingTxReads) =>
          getQbitAddressUtxosClassified(
            client as any,
            address,
            fundingTxReads ? { fundingTxReads } : {}
          ),
        { young: false },
      ],
      [
        'a read of outputs for a send',
        (client, fundingTxReads) =>
          getQbitAddressUtxos(client as any, address, fundingTxReads ? { fundingTxReads } : {}),
        { young: false },
      ],
      [
        'a balance read',
        (client, fundingTxReads) =>
          getQbitSpendableBalanceV2(
            client as any,
            address,
            ACCOUNT_SCRIPT,
            undefined,
            undefined,
            fundingTxReads ? { fundingTxReads } : {}
          ),
        { young: true },
      ],
    ]

    for (const [name, read, { young }] of readers) {
      it(`leaves ${name} keeping nothing, and served nothing, though it completes alike`, async () => {
        const explorer = new ClassifyReadsExplorer()
        // More than the bound, so that the bound is what holds its reads to it.
        const outputs = 2 * QBIT_CLASSIFY_MAX_READS_IN_FLIGHT
        explorer.fund(address, outputs, { young })
        const expected = await read(explorer.client)
        const fundingTxReads = new QbitFundingTxReads()

        // Begun before a clear, listed after it: it keeps nothing.
        const first = holdingNextListing(explorer)
        const running = read(first.client, fundingTxReads)
        await flushMicrotasks()
        fundingTxReads.clear()
        first.release()
        await expect(running).resolves.toEqual(expected)
        expect(fundingTxReads.size).toBe(0)

        // Nor is it served what a read begun after the clear keeps.
        const second = holdingNextListing(explorer)
        const stale = read(second.client, fundingTxReads)
        await flushMicrotasks()
        fundingTxReads.clear()
        explorer.started.length = 0
        await expect(read(explorer.client, fundingTxReads)).resolves.toEqual(expected)
        // The first read kept nothing for it.
        expect(explorer.started).toHaveLength(outputs)
        explorer.started.length = 0
        explorer.peak = 0
        second.release()
        await expect(stale).resolves.toEqual(expected)
        expect(explorer.started).toHaveLength(outputs)
        // Still within the limiter's bound.
        expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
        expect(fundingTxReads.size).toBe(outputs)
      })
    }
  })

  it('serves and keeps nothing while the wallet reads locked', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 50)
    let unlocked = true
    const fundingTxReads = new QbitFundingTxReads({ usable: () => unlocked })
    await classify(explorer, address, { fundingTxReads })

    unlocked = false
    explorer.started.length = 0
    await classify(explorer, address, { fundingTxReads })
    expect(explorer.started).toHaveLength(50)
  })

  it('never serves facts read through one client to another', async () => {
    const mainnet = new ClassifyReadsExplorer()
    const testnet = new ClassifyReadsExplorer()
    mainnet.fund(address, 30)
    testnet.fund(address, 30)
    const fundingTxReads = new QbitFundingTxReads()
    await classify(mainnet, address, { fundingTxReads })

    await classify(testnet, address, { fundingTxReads })
    expect(testnet.started).toHaveLength(30)
  })

  it('stays within its cap, least recently used first, and classifies an address over it correctly', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 250)
    const fundingTxReads = new QbitFundingTxReads({ maxOutpoints: 100 })
    const uncapped = await classify(explorer)

    const first = await classify(explorer, address, { fundingTxReads })
    expect(fundingTxReads.size).toBe(100)
    const second = await classify(explorer, address, { fundingTxReads })

    expect(fundingTxReads.size).toBe(100)
    expect(first).toEqual(uncapped)
    expect(second).toEqual(uncapped)
  })

  it('reads only what the other account pushed out when polls take turns between two that fit only one at a time', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 60, { young: true })
    explorer.fund(other, 60, { salt: 7, young: true })
    const fundingTxReads = new QbitFundingTxReads({ maxOutpoints: 100 })
    /** The `/tx` reads of one balance poll of `target`, which completes. */
    const poll = async (target: string): Promise<number> => {
      explorer.started.length = 0
      const balance = await getQbitSpendableBalanceV2(
        explorer.client as any,
        target,
        scriptOf(target),
        undefined,
        undefined,
        { fundingTxReads }
      )
      expect(balance.availableBalance).not.toBeNull()
      return explorer.started.length
    }

    expect(await poll(address)).toBe(60)
    expect(await poll(address)).toBe(0)
    // The other account's facts push out the 20 least recently used.
    expect(await poll(other)).toBe(60)
    expect(await poll(other)).toBe(0)
    // Back again: only those 20 are read, pushing out 20 of the other's.
    expect(await poll(address)).toBe(20)
    expect(await poll(address)).toBe(0)
    expect(await poll(other)).toBe(20)
    expect(fundingTxReads.size).toBe(100)
  })

  describe('a balance read beside a read of another address, the two past the cap together', () => {
    const balanceOptions = (fundingTxReads: QbitFundingTxReads, deadlineMs?: number) => ({
      fundingTxReads,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    })

    it('completes, then reads once what the other read pushed out, then nothing', async () => {
      const explorer = new ClassifyReadsExplorer()
      explorer.fund(address, 60, { young: true })
      explorer.fund(other, 60, { salt: 7 })
      const fundingTxReads = new QbitFundingTxReads({ maxOutpoints: 100 })
      const poll = () =>
        getQbitSpendableBalanceV2(
          explorer.client as any,
          address,
          scriptOf(address),
          undefined,
          undefined,
          balanceOptions(fundingTxReads)
        )

      const [balance, outputs] = await Promise.all([
        poll(),
        getQbitAddressUtxos(explorer.client as any, other, { fundingTxReads }),
      ])
      expect(balance.availableBalance).toBe(balance.totalBalance)
      expect(outputs).toHaveLength(60)

      explorer.started.length = 0
      expect((await poll()).availableBalance).toBe(balance.totalBalance)
      const readAgain = explorer.started.length
      expect(readAgain).toBeGreaterThan(0)
      expect(readAgain).toBeLessThanOrEqual(20)
      explorer.started.length = 0
      await poll()
      expect(explorer.started).toEqual([])
    })

    it('reports a read cut off at its deadline failed when the other read pushed out all it kept', async () => {
      vi.useFakeTimers()
      try {
        const explorer = new ClassifyReadsExplorer()
        explorer.fund(address, 50, { young: true })
        explorer.fund(other, 200, { salt: 7 })
        const fundingTxReads = new QbitFundingTxReads({ maxOutpoints: 100 })
        // One of the address's transactions never answers, so its balance
        // read runs to the deadline, having kept the facts of the other 49.
        const hanging = testTxid(49)
        const client = {
          ...explorer.client,
          getTx: (txid: string, options?: { signal?: AbortSignal }) =>
            txid === hanging
              ? new Promise<never>((_resolve, reject) => {
                  options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                    once: true,
                  })
                })
              : explorer.client.getTx(txid, options),
        }
        let balance: unknown
        void getQbitSpendableBalanceV2(
          client as any,
          address,
          scriptOf(address),
          undefined,
          undefined,
          balanceOptions(fundingTxReads, 1_000)
        ).then(answer => (balance = answer))
        let outputs: unknown[] | undefined
        void getQbitAddressUtxos(client as any, other, { fundingTxReads }).then(
          answer => (outputs = answer)
        )
        await vi.advanceTimersByTimeAsync(1_000)

        expect(outputs).toHaveLength(200)
        // The other read's 200 pushed out all 49: nothing for the next read.
        expect(fundingTxReads.size).toBe(100)
        expect(balance).toMatchObject({
          availableBalance: null,
          utxoReadIncomplete: true,
          utxoReadFailed: true,
        })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('splits the reads of two classifications of the same outputs between them', async () => {
    const explorer = new ClassifyReadsExplorer()
    explorer.fund(address, 1_000)
    const fundingTxReads = new QbitFundingTxReads()

    const [balance, send] = await Promise.all([
      classify(explorer, address, { fundingTxReads }),
      getQbitAddressUtxos(explorer.client as any, address, { fundingTxReads }),
    ])

    expect(balance.confirmedSpendable).toHaveLength(1_000)
    expect(send).toHaveLength(1_000)
    // Each funding transaction about once, not once per caller.
    expect(explorer.started.length).toBeLessThanOrEqual(
      1_000 + 2 * QBIT_CLASSIFY_MAX_READS_IN_FLIGHT
    )
    expect(explorer.peak).toBeLessThanOrEqual(QBIT_CLASSIFY_MAX_READS_IN_FLIGHT)
  })
})
