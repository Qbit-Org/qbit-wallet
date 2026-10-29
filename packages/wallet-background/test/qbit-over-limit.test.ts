import { describe, expect, it } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import {
  continueQbitAddressOutputScan,
  createQbitAddressOutputScan,
  findQbitSpentOutpoints,
  getQbitAddressOutputCounts,
  getQbitAddressUtxos,
  getQbitAddressUtxosClassifiedFromHistory,
  getQbitAddressUtxosClassifiedPastLimit,
  getQbitSpendableBalanceV2,
  qbitStatsSnapshot,
  QbitUtxoHistoryTooLargeError,
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
} from '../src/utils/qbit-api'
import { FakeQbitExplorer, fakeTxid, type FakeTx } from './qbit-fake-explorer'

const address = 'qbrt1zoverlimit'
const script = `5220${'aa'.repeat(32)}`
const payer = 'qbrt1zpayer'
const payerScript = `5220${'bb'.repeat(32)}`
const BASE = 'https://explorer.test/api'

/**
 * An address paid `funded` times by someone else, each payment its own
 * transaction, with some of those outputs spent again in blocks and some by
 * transactions still in the mempool, plus pending change and pending
 * payments: well over the explorer's 500-output listing limit.
 */
function overLimitExplorer(
  surface: 'esplora' | 'mempool-qbit' = 'esplora',
  { funded = 620, spentInBlocks = 60, spentInMempool = 10 } = {}
) {
  const explorer = new FakeQbitExplorer(surface)
  explorer.registerAddress(address, script)
  const funding: FakeTx[] = []
  for (let index = 0; index < funded; index += 1) {
    funding.push(
      explorer.addTx({
        txid: fakeTxid(index),
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        // Distinct values, so a largest-first choice is checkable.
        outputs: [
          { address, script, value: 10_000 + index },
          { address: payer, script: payerScript, value: 1_000 },
        ],
        height: 100 + Math.floor(index / 4),
      })
    )
  }
  // Two coinbase rewards, one mature and one not.
  const matureCoinbase = explorer.addTx({
    txid: fakeTxid(funded, 9),
    inputs: [],
    outputs: [{ address, script, value: 5_000_000 }],
    coinbase: true,
    height: 500,
  })
  const immatureCoinbase = explorer.addTx({
    txid: fakeTxid(funded + 1, 9),
    inputs: [],
    outputs: [{ address, script, value: 5_000_001 }],
    coinbase: true,
    height: explorer.tipHeight - 10,
  })
  // Spends confirmed in later blocks, a few inputs at a time.
  for (let index = 0; index < spentInBlocks; index += 3) {
    explorer.addTx({
      txid: fakeTxid(index, 6_000_000),
      inputs: funding.slice(index, index + 3).map(tx => ({ txid: tx.txid, vout: 0 })),
      outputs: [{ address: payer, script: payerScript, value: 25_000 }],
      height: 400 + index,
    })
  }
  const mempoolSpends = funding.slice(spentInBlocks, spentInBlocks + spentInMempool)
  explorer.addTx({
    txid: fakeTxid(0, 7_000_000),
    inputs: mempoolSpends.slice(0, -1).map(tx => ({ txid: tx.txid, vout: 0 })),
    outputs: [{ address: payer, script: payerScript, value: 80_000 }],
  })
  // Pending change of the account's own spend, and a pending payment from someone else.
  const ownChange = explorer.addTx({
    txid: fakeTxid(1, 7_000_000),
    inputs: [{ txid: mempoolSpends.at(-1)!.txid, vout: 0 }],
    outputs: [
      { address: payer, script: payerScript, value: 2_000 },
      { address, script, value: 7_000 },
    ],
  })
  const pendingPayment = explorer.addTx({
    txid: fakeTxid(2, 7_000_000),
    inputs: [{ txid: fakeTxid(3, 8_000_000), vout: 0 }],
    outputs: [{ address, script, value: 9_000 }],
  })
  return { explorer, funding, matureCoinbase, immatureCoinbase, ownChange, pendingPayment }
}

function clientFor(explorer: FakeQbitExplorer) {
  const options = { baseUrl: BASE, fetchFn: explorer.fetch as typeof fetch, retryBaseDelayMs: 0 }
  return explorer.surface === 'esplora'
    ? new QbitWalletEsploraClient(options)
    : new QbitWalletMempoolClient(options)
}

const keys = (utxos: readonly { txid: string; vout: number }[]) =>
  new Set(utxos.map(utxo => `${utxo.txid.toLowerCase()}:${utxo.vout}`))

/** What a send may select: confirmed mature unspent outputs and the account's own pending change. */
function expectedSendable(fixture: ReturnType<typeof overLimitExplorer>) {
  const { explorer, immatureCoinbase, ownChange, pendingPayment } = fixture
  const expected = explorer.unspent(address)
  expected.delete(`${immatureCoinbase.txid}:0`)
  expected.delete(`${pendingPayment.txid}:0`)
  expect(expected.has(`${ownChange.txid}:1`)).toBe(true)
  return expected
}

const pageRequests = (explorer: FakeQbitExplorer) =>
  explorer.requests.filter(request => /\/txs(\/chain|\?|$)/.test(request.path)).length

describe('outputs of an address over the explorer UTXO limit (#277)', () => {
  for (const surface of ['esplora', 'mempool-qbit'] as const) {
    it(`reads the exact unspent set from paged history when ${surface} refuses the listing`, async () => {
      const fixture = overLimitExplorer(surface)
      const { explorer } = fixture
      const client = clientFor(explorer)

      const utxos = await getQbitAddressUtxos(client, address)

      expect(keys(utxos)).toEqual(expectedSendable(fixture))
      // The listing was refused and the history was read across many pages.
      expect(explorer.requests.some(request => request.path.endsWith('/utxo'))).toBe(true)
      expect(pageRequests(explorer)).toBeGreaterThan(surface === 'esplora' ? 25 : 12)
      // Confirmed outputs come first, and only the account's own change is pending.
      const ownChangeKey = `${fixture.ownChange.txid}:1`
      expect(utxos.at(-1)).toMatchObject({ txid: fixture.ownChange.txid, unconfirmed: true })
      expect(
        utxos.filter(utxo => utxo.unconfirmed).map(utxo => `${utxo.txid}:${utxo.vout}`)
      ).toEqual([ownChangeKey])
    })
  }

  it('classifies immature rewards and pending payments as the listing would', async () => {
    const fixture = overLimitExplorer()
    const classified = await getQbitAddressUtxosClassifiedPastLimit(
      clientFor(fixture.explorer),
      address
    )

    expect(keys(classified.immature)).toEqual(new Set([`${fixture.immatureCoinbase.txid}:0`]))
    expect(keys(classified.unconfirmedSpendable)).toEqual(
      new Set([`${fixture.ownChange.txid}:1`, `${fixture.pendingPayment.txid}:0`])
    )
    expect(keys(classified.unconfirmedOwnChange)).toEqual(new Set([`${fixture.ownChange.txid}:1`]))
    expect(keys(classified.confirmedSpendable).has(`${fixture.matureCoinbase.txid}:0`)).toBe(true)
  })

  it('leaves the outputs unknown when a history page fails, never fewer', async () => {
    const fixture = overLimitExplorer()
    const { explorer } = fixture
    const confirmed = explorer.history(address).filter(tx => tx.height !== undefined)
    const failingCursor = confirmed[25 * 3 - 1]!.txid
    explorer.failures.push(({ path }) =>
      path.endsWith(`/txs/chain/${failingCursor}`) ? { status: 503 } : undefined
    )
    const client = clientFor(explorer)

    await expect(getQbitAddressUtxos(client, address)).rejects.toMatchObject({
      kind: 'http',
      status: 503,
    })
    // The balance keeps the statistics total and never walks the history.
    const pagesBefore = pageRequests(explorer)
    await expect(getQbitSpendableBalanceV2(client, address)).resolves.toMatchObject({
      utxoLimitExceeded: true,
      // Unknown, not a measured 0 (#341).
      availableBalance: null,
      immatureBalance: null,
      pendingBalance: null,
      totalBalance:
        explorer.stats(address).chain_stats.funded_txo_sum -
        explorer.stats(address).chain_stats.spent_txo_sum +
        explorer.stats(address).mempool_stats.funded_txo_sum -
        explorer.stats(address).mempool_stats.spent_txo_sum,
    })
    expect(pageRequests(explorer)).toBe(pagesBefore)
  })

  it('leaves the outputs unknown when a page silently drops a row', async () => {
    const fixture = overLimitExplorer()
    const { explorer } = fixture
    const confirmed = explorer.history(address).filter(tx => tx.height !== undefined)
    const cursor = confirmed[24]!.txid
    // The second page comes back one spent output short, which no count
    // check on a single page could notice. @qbit-oss/api compares the whole
    // history with the address stats and reports the shortfall as an
    // invalid_cursor error, which the stability retry treats as a moved
    // snapshot.
    explorer.failures.push(({ path }) => {
      if (!path.endsWith(`/txs/chain/${cursor}`)) return undefined
      const page = confirmed.slice(25, 50).filter((_, index) => index !== 3)
      return { status: 200, body: JSON.stringify(page.map(tx => explorer.esploraTx(tx))) }
    })

    await expect(
      getQbitAddressUtxosClassifiedFromHistory(clientFor(explorer), address, {
        stabilityRetries: 0,
      })
    ).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining('but the address stats count'),
    })
  })

  it('leaves the outputs unknown when the history does not reconcile with the statistics', async () => {
    const fixture = overLimitExplorer()
    const { explorer } = fixture
    // A history row reports a different value than the statistics counted.
    const target = fixture.funding[300]!
    explorer.failures.push(({ path }) => {
      if (!/\/txs\/chain/.test(path)) return undefined
      const cursor = path.match(/\/txs\/chain\/([0-9a-f]{64})$/)?.[1]
      const confirmed = explorer.history(address).filter(tx => tx.height !== undefined)
      const start = cursor ? confirmed.findIndex(tx => tx.txid === cursor) + 1 : 0
      const page = confirmed.slice(start, start + 25).map(tx => {
        const row = explorer.esploraTx(tx)
        if (tx.txid === target.txid) row.vout[0]!.value += 1
        return row
      })
      return { status: 200, body: JSON.stringify(page) }
    })

    await expect(
      getQbitAddressUtxosClassifiedFromHistory(clientFor(explorer), address, {
        stabilityRetries: 0,
      })
    ).rejects.toThrow('does not reconcile with its statistics')
  })

  it('reads a history that moved during the walk again instead of returning either view', async () => {
    const fixture = overLimitExplorer()
    const { explorer } = fixture
    let arrived: FakeTx | undefined
    explorer.failures.push(({ path }) => {
      if (!arrived && /\/txs\/chain\/[0-9a-f]{64}$/.test(path)) {
        arrived = explorer.addTx({
          txid: fakeTxid(99, 9_000_000),
          inputs: [{ txid: fakeTxid(98, 9_000_000), vout: 0 }],
          outputs: [{ address, script, value: 12_345 }],
          height: explorer.tipHeight - 1_500,
        })
      }
      return undefined
    })

    const classified = await getQbitAddressUtxosClassifiedFromHistory(
      clientFor(explorer),
      address,
      {
        retryBaseDelayMs: 0,
      }
    )

    expect(keys(classified.confirmedSpendable).has(`${arrived!.txid}:0`)).toBe(true)
  })

  it('refuses a history over the read limit before reading any page', async () => {
    const { explorer } = overLimitExplorer()
    const client = clientFor(explorer)

    await expect(
      getQbitAddressUtxosClassifiedFromHistory(client, address, { maxTransactions: 600 })
    ).rejects.toBeInstanceOf(QbitUtxoHistoryTooLargeError)
    expect(pageRequests(explorer)).toBe(0)
  })

  it('treats a walk the client page ceiling cuts short as too large, not as complete', async () => {
    const { explorer } = overLimitExplorer('mempool-qbit')
    const client = new QbitWalletMempoolClient({
      baseUrl: BASE,
      fetchFn: explorer.fetch as typeof fetch,
      retryBaseDelayMs: 0,
      maxAddressHistoryPages: 5,
    })

    await expect(getQbitAddressUtxos(client, address)).rejects.toBeInstanceOf(
      QbitUtxoHistoryTooLargeError
    )
  })

  it('keeps every other listing failure, and a 500 within the limit, as it was', async () => {
    const { explorer } = overLimitExplorer('esplora', { funded: 400 })
    explorer.failures.push(({ path }) =>
      path.endsWith('/utxo')
        ? { status: 500, body: '{"error":"Failed to get address"}' }
        : undefined
    )

    await expect(getQbitAddressUtxos(clientFor(explorer), address)).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    })
    expect(pageRequests(explorer)).toBe(0)
  })

  it('reports the confirmed and pending output counts the explorer limit sees', async () => {
    const { explorer } = overLimitExplorer()
    const stats = explorer.stats(address)

    await expect(getQbitAddressOutputCounts(clientFor(explorer), address)).resolves.toEqual({
      confirmedUnspent: stats.chain_stats.funded_txo_count - stats.chain_stats.spent_txo_count,
      pendingSpent: 10,
      pendingFunded: 2,
    })
  })
})

describe('balance split of an address over the explorer UTXO limit, from a read of its outputs', () => {
  /** The fixture's total as its statistics give it. */
  function totalOf(explorer: FakeQbitExplorer) {
    const { chain_stats: chain, mempool_stats: mempool } = explorer.stats(address)
    return (
      chain.funded_txo_sum - chain.spent_txo_sum + mempool.funded_txo_sum - mempool.spent_txo_sum
    )
  }

  /** A read of the outputs from history, kept with the statistics it ran against. */
  async function readOf(explorer: FakeQbitExplorer) {
    const stats = qbitStatsSnapshot(explorer.stats(address))
    const utxos = await getQbitAddressUtxos(clientFor(explorer), address)
    const readOutputs = (current: string) => (current === stats ? utxos : undefined)
    return { utxos, readOutputs }
  }

  const sum = (utxos: readonly { satoshis: number }[]) =>
    utxos.reduce((total, utxo) => total + utxo.satoshis, 0)

  it('takes the split from a read made against the statistics as they read now', async () => {
    const { explorer } = overLimitExplorer()
    const { utxos, readOutputs } = await readOf(explorer)

    const balance = await getQbitSpendableBalanceV2(
      clientFor(explorer),
      address,
      script,
      undefined,
      readOutputs
    )

    const total = totalOf(explorer)
    expect(sum(utxos)).toBeLessThan(total)
    expect(balance).toEqual({
      availableBalance: sum(utxos),
      unavailableBalance: total - sum(utxos),
      totalBalance: total,
      immatureBalance: null,
      pendingBalance: null,
      utxoLimitExceeded: true,
    })
  })

  it('keeps the split unknown once a transaction moved the statistics', async () => {
    const { explorer } = overLimitExplorer()
    const { readOutputs } = await readOf(explorer)
    explorer.addTx({
      txid: fakeTxid(4, 8_000_000),
      inputs: [{ txid: fakeTxid(5, 8_000_000), vout: 0 }],
      outputs: [{ address, script, value: 3_000 }],
    })

    const balance = await getQbitSpendableBalanceV2(
      clientFor(explorer),
      address,
      script,
      undefined,
      readOutputs
    )

    expect(balance).toEqual({
      availableBalance: null,
      unavailableBalance: totalOf(explorer),
      totalBalance: totalOf(explorer),
      immatureBalance: null,
      pendingBalance: null,
      utxoLimitExceeded: true,
    })
  })

  it('counts a reserved output as unavailable', async () => {
    const { explorer } = overLimitExplorer()
    const { utxos, readOutputs } = await readOf(explorer)
    const held = utxos[0]!

    const balance = await getQbitSpendableBalanceV2(
      clientFor(explorer),
      address,
      script,
      async () => new Set([`${held.txid}:${held.vout}`]),
      readOutputs
    )

    expect(balance.availableBalance).toBe(sum(utxos) - held.satoshis)
    expect(balance.unavailableBalance).toBe(totalOf(explorer) - sum(utxos) + held.satoshis)
  })

  it("counts only the account's own script", async () => {
    const { explorer } = overLimitExplorer()
    const { utxos } = await readOf(explorer)
    const stats = qbitStatsSnapshot(explorer.stats(address))
    const foreign = {
      ...utxos[0]!,
      txid: fakeTxid(9, 9_000_000),
      satoshis: 1_000,
      scriptPk: payerScript,
    }
    // Well under the total even with the foreign output, so no cap hides it.
    expect(sum(utxos) + foreign.satoshis).toBeLessThan(totalOf(explorer))

    const balance = await getQbitSpendableBalanceV2(
      clientFor(explorer),
      address,
      script,
      undefined,
      current => (current === stats ? [...utxos, foreign] : undefined)
    )

    expect(balance.availableBalance).toBe(sum(utxos))
    expect(balance.unavailableBalance).toBe(totalOf(explorer) - sum(utxos))
  })

  it('never counts an output without a scriptPubKey, script on record or not', async () => {
    const { explorer } = overLimitExplorer()
    const { utxos } = await readOf(explorer)
    const stats = qbitStatsSnapshot(explorer.stats(address))
    const unlabelled = { ...utxos[0]!, txid: fakeTxid(9, 9_000_000), satoshis: 1_000, scriptPk: '' }
    const outputs = [...utxos, unlabelled]

    for (const accountScript of [script, undefined]) {
      const balance = await getQbitSpendableBalanceV2(
        clientFor(explorer),
        address,
        accountScript,
        undefined,
        current => (current === stats ? outputs : undefined)
      )
      expect(balance.availableBalance).toBe(sum(utxos))
    }
  })

  it('never shows more available than the total', async () => {
    const { explorer } = overLimitExplorer()
    const { utxos } = await readOf(explorer)
    const stats = qbitStatsSnapshot(explorer.stats(address))
    const inflated = utxos.map(utxo => ({ ...utxo, satoshis: utxo.satoshis * 10 }))

    const balance = await getQbitSpendableBalanceV2(
      clientFor(explorer),
      address,
      script,
      undefined,
      current => (current === stats ? inflated : undefined)
    )

    expect(balance.availableBalance).toBe(totalOf(explorer))
    expect(balance.unavailableBalance).toBe(0)
  })

  it('takes the split from the statistics the limit check read, without reading them again', async () => {
    const { explorer } = overLimitExplorer()
    const { utxos, readOutputs } = await readOf(explorer)
    const statsReads = () =>
      explorer.requests.filter(request => request.path === `/address/${address}`).length
    const before = statsReads()

    const balance = await getQbitSpendableBalanceV2(
      clientFor(explorer),
      address,
      script,
      undefined,
      readOutputs
    )

    expect(balance.availableBalance).toBe(sum(utxos))
    // One for the total, one for the limit check, which the split reuses.
    expect(statsReads() - before).toBe(2)
  })
})

describe('Available past the limit and from the listing, for the same outputs', () => {
  const OUTPUTS = 510
  const VALUE = 10_000
  const CHANGE = 4_000
  const PAYMENT = 50_000

  /**
   * An address just past the 500-output limit with its own pending send,
   * whose change comes back unconfirmed, and a larger pending payment from
   * someone else. `listingLimit` decides whether the explorer lists it.
   */
  function pendingChangeExplorer(listingLimit: number) {
    const explorer = new FakeQbitExplorer('esplora')
    explorer.utxoLimit = listingLimit
    explorer.registerAddress(address, script)
    explorer.registerAddress(payer, payerScript)
    for (let index = 0; index < OUTPUTS; index += 1) {
      explorer.addTx({
        txid: fakeTxid(index),
        inputs: [{ txid: fakeTxid(index, 5_000_000), vout: 0 }],
        outputs: [{ address, script, value: VALUE }],
        height: 100 + Math.floor(index / 4),
      })
    }
    explorer.addTx({
      txid: fakeTxid(1, 7_000_000),
      inputs: [{ txid: fakeTxid(0), vout: 0 }],
      outputs: [
        { address: payer, script: payerScript, value: VALUE - CHANGE - 1_000 },
        { address, script, value: CHANGE },
      ],
    })
    explorer.addTx({
      txid: fakeTxid(2, 7_000_000),
      inputs: [{ txid: fakeTxid(3, 8_000_000), vout: 0 }],
      outputs: [{ address, script, value: PAYMENT }],
    })
    return explorer
  }

  const CONFIRMED = OUTPUTS * VALUE
  const TOTAL = CONFIRMED - VALUE + CHANGE + PAYMENT

  it('reports the same Available on both paths, own unconfirmed change included', async () => {
    const listed = await getQbitSpendableBalanceV2(
      clientFor(pendingChangeExplorer(10_000)),
      address,
      script
    )
    const pastLimit = pendingChangeExplorer(500)
    const stats = qbitStatsSnapshot(pastLimit.stats(address))
    const utxos = await getQbitAddressUtxos(clientFor(pastLimit), address)
    expect(utxos.filter(utxo => utxo.unconfirmed).map(utxo => utxo.satoshis)).toEqual([CHANGE])

    const read = await getQbitSpendableBalanceV2(
      clientFor(pastLimit),
      address,
      script,
      undefined,
      current => (current === stats ? utxos : undefined)
    )

    expect(listed.availableBalance).toBe(CONFIRMED - VALUE + CHANGE)
    expect(read.availableBalance).toBe(listed.availableBalance)
    expect(read.totalBalance).toBe(TOTAL)
  })

  it('bounds the confirmed outputs by the confirmed balance, as the listing path does', async () => {
    const pastLimit = pendingChangeExplorer(500)
    const stats = qbitStatsSnapshot(pastLimit.stats(address))
    const utxos = await getQbitAddressUtxos(clientFor(pastLimit), address)
    // More confirmed value than the statistics hold, as from a lagging index.
    const inflated = utxos.map(utxo =>
      utxo.unconfirmed ? utxo : { ...utxo, satoshis: utxo.satoshis * 2 }
    )

    const read = await getQbitSpendableBalanceV2(
      clientFor(pastLimit),
      address,
      script,
      undefined,
      current => (current === stats ? inflated : undefined)
    )

    // The confirmed balance, plus the change, under the total.
    expect(read.availableBalance).toBe(CONFIRMED + CHANGE)
    expect(read.availableBalance).toBeLessThan(TOTAL)
  })
})

describe('resumable output scan for consolidation (#277)', () => {
  it('reads only as many pages as it needs and continues from its cursor', async () => {
    const { explorer } = overLimitExplorer()
    const client = clientFor(explorer)
    const scan = createQbitAddressOutputScan(address)

    const read = await continueQbitAddressOutputScan(client, scan, {
      maxPages: 100,
      enough: current => current.candidates.size >= 106,
    })

    // About 25 outputs a page: it stops on the first page that brings it to 106.
    expect(read).toBeLessThanOrEqual(6)
    expect(scan.candidates.size).toBeGreaterThanOrEqual(106)
    expect(scan.candidates.size).toBeLessThan(106 + 25)
    expect(scan.exhausted).toBe(false)
    const cursor = scan.afterTxid
    const candidatesBefore = new Set(scan.candidates.keys())

    await continueQbitAddressOutputScan(client, scan, { maxPages: 1 })
    expect(explorer.requests.at(-1)!.path).toContain(`/txs/chain/${cursor}`)
    for (const key of candidatesBefore) expect(scan.candidates.has(key)).toBe(true)
  })

  it('ends with every confirmed output no walked transaction spends', async () => {
    const fixture = overLimitExplorer('mempool-qbit')
    const { explorer } = fixture
    const scan = createQbitAddressOutputScan(address)

    await continueQbitAddressOutputScan(clientFor(explorer), scan, { maxPages: 1_000 })

    expect(scan.exhausted).toBe(true)
    // mempool-qbit's combined pages carry the mempool spends too.
    expect(new Set(scan.candidates.keys())).toEqual(
      explorer.unspent(address, { confirmedOnly: true })
    )
  })

  it('counts a spend whose prevout a row omits as a spend of this address', async () => {
    const fixture = overLimitExplorer('mempool-qbit')
    const { explorer } = fixture
    explorer.omitHistoryPrevouts = true
    const scan = createQbitAddressOutputScan(address)

    await continueQbitAddressOutputScan(clientFor(explorer), scan, { maxPages: 1_000 })

    expect(new Set(scan.candidates.keys())).toEqual(
      explorer.unspent(address, { confirmedOnly: true })
    )
  })

  it('leaves the scan where it was when a page fails, so a retry resumes there', async () => {
    const { explorer } = overLimitExplorer()
    const client = clientFor(explorer)
    const scan = createQbitAddressOutputScan(address)
    await continueQbitAddressOutputScan(client, scan, { maxPages: 2 })
    const snapshot = {
      afterTxid: scan.afterTxid,
      pagesRead: scan.pagesRead,
      candidates: [...scan.candidates.keys()],
      spent: [...scan.spent],
    }
    let failing = true
    explorer.failures.push(({ path }) =>
      failing && path.endsWith(`/txs/chain/${snapshot.afterTxid}`) ? { status: 503 } : undefined
    )

    await expect(
      continueQbitAddressOutputScan(client, scan, { maxPages: 3 })
    ).rejects.toBeInstanceOf(QbitApiError)
    expect({
      afterTxid: scan.afterTxid,
      pagesRead: scan.pagesRead,
      candidates: [...scan.candidates.keys()],
      spent: [...scan.spent],
    }).toEqual(snapshot)

    failing = false
    await continueQbitAddressOutputScan(client, scan, { maxPages: 1 })
    expect(scan.pagesRead).toBe(snapshot.pagesRead + 1)
  })

  it('refuses a page that repeats its cursor before changing anything', async () => {
    const { explorer } = overLimitExplorer()
    const client = clientFor(explorer)
    const scan = createQbitAddressOutputScan(address)
    await continueQbitAddressOutputScan(client, scan, { maxPages: 1 })
    const firstPage = explorer
      .history(address)
      .filter(tx => tx.height !== undefined)
      .slice(0, 25)
    explorer.failures.push(({ path }) =>
      path.includes('/txs/chain/')
        ? { status: 200, body: JSON.stringify(firstPage.map(tx => explorer.esploraTx(tx))) }
        : undefined
    )
    const candidates = scan.candidates.size

    await expect(
      continueQbitAddressOutputScan(client, scan, { maxPages: 1 })
    ).rejects.toMatchObject({
      kind: 'invalid_cursor',
    })
    expect(scan.candidates.size).toBe(candidates)
    expect(scan.pagesRead).toBe(1)
  })
})

/** `count` more pending payments to the address, from someone else. */
function addPendingPayments(explorer: FakeQbitExplorer, count: number): FakeTx[] {
  return Array.from({ length: count }, (_, index) =>
    explorer.addTx({
      txid: fakeTxid(index, 9_000_000),
      inputs: [{ txid: fakeTxid(index, 9_500_000), vout: 0 }],
      outputs: [{ address, script, value: 3_000 }],
    })
  )
}

describe('output scan past a page of mempool rows on qbit-electrs (#343)', () => {
  /** The over-limit fixture with exactly one combined page (50 rows) of mempool rows. */
  function fullMempoolPage() {
    const fixture = overLimitExplorer('mempool-qbit')
    const { explorer } = fixture
    explorer.emptyPageAfterLastMempoolRow = true
    const pending = () => explorer.history(address).filter(tx => tx.height === undefined)
    addPendingPayments(explorer, 50 - pending().length)
    expect(pending()).toHaveLength(50)
    return { ...fixture, lastMempoolRow: pending().at(-1)!, rowBefore: pending().at(-2)! }
  }

  it('reads on into the confirmed rows when the page after the last mempool row is empty', async () => {
    const { explorer, lastMempoolRow, rowBefore } = fullMempoolPage()
    const client = clientFor(explorer)
    // The explorer does answer the last mempool row's cursor with nothing.
    await expect(client.getAddressHistoryPage(address, lastMempoolRow.txid)).resolves.toEqual([])
    const scan = createQbitAddressOutputScan(address)

    await continueQbitAddressOutputScan(client, scan, { maxPages: 1_000 })

    expect(scan.exhausted).toBe(true)
    expect(new Set(scan.candidates.keys())).toEqual(
      explorer.unspent(address, { confirmedOnly: true })
    )
    expect(scan.candidates.size).toBeGreaterThan(500)
    // It stepped back one row, to the cursor that lists the mempool row again.
    const pages = explorer.requests.map(request => request.path).filter(path => /\/txs/.test(path))
    expect(pages.slice(1, 4)).toEqual([
      `/address/${address}/txs`,
      `/address/${address}/txs?after_txid=${lastMempoolRow.txid}`,
      `/address/${address}/txs?after_txid=${rowBefore.txid}`,
    ])
  })

  it('reads on when a call ends on the empty page and the next continues', async () => {
    const { explorer } = fullMempoolPage()
    const client = clientFor(explorer)
    const scan = createQbitAddressOutputScan(address)

    for (let calls = 0; calls < 100 && !scan.exhausted; calls += 1) {
      await continueQbitAddressOutputScan(client, scan, { maxPages: 1 })
    }

    expect(scan.exhausted).toBe(true)
    expect(new Set(scan.candidates.keys())).toEqual(
      explorer.unspent(address, { confirmedOnly: true })
    )
  })

  it('ends at the last mempool row of an address with no confirmed history', async () => {
    const explorer = new FakeQbitExplorer('mempool-qbit')
    explorer.emptyPageAfterLastMempoolRow = true
    addPendingPayments(explorer, 50)
    const scan = createQbitAddressOutputScan(address)

    const read = await continueQbitAddressOutputScan(clientFor(explorer), scan, {
      maxPages: 1_000,
    })

    // The full page, the empty one, and the stepped-back page holding the last row alone.
    expect(read).toBe(3)
    expect(scan.exhausted).toBe(true)
    expect(scan.candidates.size).toBe(0)
  })

  it('refuses a stepped-back page that does not start with the row it stepped back over', async () => {
    const { explorer, lastMempoolRow } = fullMempoolPage()
    const client = clientFor(explorer)
    const scan = createQbitAddressOutputScan(address)
    await continueQbitAddressOutputScan(client, scan, { maxPages: 2 })
    expect(scan.exhausted).toBe(false)
    const snapshot = { ...scan, candidates: scan.candidates.size, spent: scan.spent.size }
    // The last mempool row leaves the mempool, so the row before it is now last.
    explorer.removeTx(lastMempoolRow.txid)

    await expect(
      continueQbitAddressOutputScan(client, scan, { maxPages: 1 })
    ).rejects.toMatchObject({ kind: 'invalid_cursor' })
    expect({ ...scan, candidates: scan.candidates.size, spent: scan.spent.size }).toEqual(snapshot)
  })
})

describe('outputs read from history past whole pages of mempool rows on qbit-electrs', () => {
  /** The over-limit fixture with `pendingRows` pending rows, a whole number of combined pages. */
  function fullMempoolPages(pendingRows: number) {
    const fixture = overLimitExplorer('mempool-qbit')
    const { explorer } = fixture
    explorer.emptyPageAfterLastMempoolRow = true
    const pending = () => explorer.history(address).filter(tx => tx.height === undefined)
    const payments = addPendingPayments(explorer, pendingRows - pending().length)
    expect(pending()).toHaveLength(pendingRows)
    return { ...fixture, payments, lastMempoolRow: pending().at(-1)!, rowBefore: pending().at(-2)! }
  }

  for (const pendingRows of [50, 100]) {
    it(`reads every output with ${pendingRows} pending rows`, async () => {
      const fixture = fullMempoolPages(pendingRows)
      const { explorer, lastMempoolRow, rowBefore } = fixture

      const classified = await getQbitAddressUtxosClassifiedFromHistory(
        clientFor(explorer),
        address,
        { stabilityRetries: 0 }
      )

      // Pending payments from someone else are not sendable.
      const expected = expectedSendable(fixture)
      for (const payment of fixture.payments) expected.delete(`${payment.txid}:0`)
      expect(keys([...classified.confirmedSpendable, ...classified.unconfirmedOwnChange])).toEqual(
        expected
      )
      expect(classified.confirmedSpendable.length).toBeGreaterThan(500)
      // It stepped back one row, to the cursor that lists the last pending row again.
      const pages = explorer.requests
        .map(request => request.path)
        .filter(path => /\/txs/.test(path))
      const emptyPage = pages.indexOf(`/address/${address}/txs?after_txid=${lastMempoolRow.txid}`)
      expect(emptyPage).toBeGreaterThan(0)
      expect(pages[emptyPage + 1]).toBe(`/address/${address}/txs?after_txid=${rowBefore.txid}`)
    })
  }

  it('reads them on the send path without waiting for a retry', async () => {
    const fixture = fullMempoolPages(50)
    const expected = expectedSendable(fixture)
    for (const payment of fixture.payments) expected.delete(`${payment.txid}:0`)

    await expect(
      getQbitAddressUtxos(clientFor(fixture.explorer), address).then(keys)
    ).resolves.toEqual(expected)
  })

  it('refuses a page row that does not touch the address, as the library walk does', async () => {
    const { explorer } = fullMempoolPages(50)
    const foreign = explorer.esploraTx({
      txid: fakeTxid(1, 9_900_000),
      inputs: [],
      outputs: [{ address: payer, script: payerScript, value: 1_000 }],
      coinbase: true,
      height: 150,
      order: 0,
    })
    explorer.failures.push(({ path }) => {
      if (!path.endsWith(`/address/${address}/txs`)) return undefined
      const rows = explorer
        .history(address)
        .slice(0, 50)
        .map(tx => explorer.esploraTx(tx))
      rows[10] = foreign
      return { status: 200, body: JSON.stringify(rows) }
    })

    await expect(
      getQbitAddressUtxosClassifiedFromHistory(clientFor(explorer), address, {
        stabilityRetries: 0,
      })
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('leaves the outputs unknown when the pending row it stepped back over has left', async () => {
    const { explorer, lastMempoolRow, rowBefore } = fullMempoolPages(50)
    explorer.failures.push(({ path }) => {
      if (path.endsWith(`?after_txid=${rowBefore.txid}`)) explorer.removeTx(lastMempoolRow.txid)
      return undefined
    })

    await expect(
      getQbitAddressUtxosClassifiedFromHistory(clientFor(explorer), address, {
        stabilityRetries: 0,
      })
    ).rejects.toMatchObject({ kind: 'invalid_cursor' })
  })
})

describe('findQbitSpentOutpoints (#277)', () => {
  it('reads each funding transaction once, at most eight at a time', async () => {
    const fixture = overLimitExplorer()
    const { explorer } = fixture
    let inFlight = 0
    let peak = 0
    const client = {
      getTxOutspends: async (txid: string) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 1))
        inFlight -= 1
        return clientFor(explorer).getTxOutspends(txid)
      },
    }
    const outputs = fixture.funding.slice(50, 90).flatMap(tx => [
      { txid: tx.txid, vout: 0, outputCount: 2 },
      { txid: tx.txid, vout: 1, outputCount: 2 },
    ])

    const spent = await findQbitSpentOutpoints(client, outputs)

    expect(peak).toBeLessThanOrEqual(8)
    // Outputs 50..59 are spent in blocks (up to 60), 60..68 by the mempool,
    // and 69 by the pending change.
    expect(spent).toEqual(new Set(fixture.funding.slice(50, 70).map(tx => `${tx.txid}:0`)))
  })

  it('fails closed on an answer that does not cover every output', async () => {
    const txid = fakeTxid(1)
    const client = { getTxOutspends: async () => [{ spent: false }] }

    await expect(
      findQbitSpentOutpoints(client, [{ txid, vout: 0, outputCount: 2 }])
    ).rejects.toThrow('invalid qbit outspends')
    await expect(
      findQbitSpentOutpoints(client, [{ txid, vout: 2, outputCount: 2 }])
    ).rejects.toThrow('invalid qbit outpoint')
  })
})
