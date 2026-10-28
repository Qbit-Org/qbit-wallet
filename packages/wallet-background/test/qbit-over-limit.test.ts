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
