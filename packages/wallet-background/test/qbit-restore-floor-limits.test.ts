import { describe, expect, it } from 'vitest'

import {
  getQbitAccountHistory,
  observeQbitPqcSignatureActivity,
  observeQbitPqcSpentOutpoints,
  probeQbitAccountHistoryRevision,
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
} from '../src/utils/qbit-api'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'

const address = 'qbrt1zrestorefloor'
const script = `5220${'cc'.repeat(32)}`
const payer = 'qbrt1zpayer'
const payerScript = `5220${'bb'.repeat(32)}`
const BASE = 'https://explorer.test/api'

/**
 * A restored account's address, paid by `funded` coinbase rewards. The first
 * `spent` of those outputs are spent again in a later block and the next
 * `pendingSpent` by mempool transactions: one signature by the account's key
 * for each.
 */
function restoredAddressExplorer(
  surface: 'esplora' | 'mempool-qbit',
  { funded, spent = 0, pendingSpent = 0 }: { funded: number; spent?: number; pendingSpent?: number }
) {
  const explorer = new FakeQbitExplorer(surface)
  explorer.registerAddress(address, script)
  const funding = Array.from({ length: funded }, (_, index) =>
    explorer.addTx({
      txid: fakeTxid(index),
      inputs: [],
      outputs: [{ address, script, value: 10_000 }],
      coinbase: true,
      height: 100 + Math.floor(index / 4),
    })
  )
  const spend = (index: number, salt: number, height?: number) =>
    explorer.addTx({
      txid: fakeTxid(index, salt),
      inputs: [{ txid: funding[index]!.txid, vout: 0 }],
      outputs: [{ address: payer, script: payerScript, value: 9_000 }],
      ...(height === undefined ? {} : { height }),
    })
  for (let index = 0; index < spent; index += 1) spend(index, 6_000_000, 1_900)
  for (let index = spent; index < spent + pendingSpent; index += 1) spend(index, 7_000_000)
  return explorer
}

function clientFor(explorer: FakeQbitExplorer) {
  const options = { baseUrl: BASE, fetchFn: explorer.fetch as typeof fetch, retryBaseDelayMs: 0 }
  return explorer.surface === 'esplora'
    ? new QbitWalletEsploraClient(options)
    : new QbitWalletMempoolClient(options)
}

const historyRequests = (explorer: FakeQbitExplorer) =>
  explorer.requests.filter(request => /\/txs(?:\/chain|\?|$)/.test(request.path))

describe('restore floor scan at the history limits (real clients)', () => {
  it('walks an Esplora history of exactly 6,400 transactions to the end', async () => {
    const explorer = restoredAddressExplorer('esplora', { funded: 6_300, spent: 100 })

    await expect(
      observeQbitPqcSignatureActivity(clientFor(explorer), address, script)
    ).resolves.toEqual({ observedSignatures: 100, hasActivity: true, floorSource: 'history' })
    // 256 full pages and the empty page that ends the walk.
    expect(historyRequests(explorer)).toHaveLength(257)
  })

  it('reads an Esplora history past 6,400 transactions from its statistics', async () => {
    const explorer = restoredAddressExplorer('esplora', { funded: 6_301, spent: 100 })

    await expect(
      observeQbitPqcSignatureActivity(clientFor(explorer), address, script)
    ).resolves.toEqual({ observedSignatures: 100, hasActivity: true, floorSource: 'address-stats' })
    expect(historyRequests(explorer)).toEqual([])
  })

  it('reads an Esplora address with more pending spends than its mempool listing from its statistics', async () => {
    const explorer = restoredAddressExplorer('esplora', { funded: 100, spent: 4, pendingSpent: 51 })

    await expect(
      observeQbitPqcSignatureActivity(clientFor(explorer), address, script)
    ).resolves.toEqual({ observedSignatures: 55, hasActivity: true, floorSource: 'address-stats' })
    expect(historyRequests(explorer)).toEqual([])
  })

  it('walks the same pending set on mempool-qbit, which pages it', async () => {
    const explorer = restoredAddressExplorer('mempool-qbit', {
      funded: 100,
      spent: 4,
      pendingSpent: 51,
    })

    await expect(
      observeQbitPqcSignatureActivity(clientFor(explorer), address, script)
    ).resolves.toEqual({ observedSignatures: 55, hasActivity: true, floorSource: 'history' })
  })
})

describe('full history reads past whole pages of mempool rows on qbit-electrs (real clients)', () => {
  /**
   * `pendingSpent` pending rows, so they fill whole combined pages (50 each),
   * on an explorer that answers the last one's cursor with an empty page.
   */
  function fullPendingPagesExplorer(pendingSpent: number) {
    const explorer = restoredAddressExplorer('mempool-qbit', {
      funded: 200,
      spent: 4,
      pendingSpent,
    })
    explorer.emptyPageAfterLastMempoolRow = true
    const pending = explorer.history(address).filter(tx => tx.height === undefined)
    expect(pending).toHaveLength(pendingSpent)
    return { explorer, lastMempoolRow: pending.at(-1)!, rowBefore: pending.at(-2)! }
  }

  for (const pendingSpent of [50, 100]) {
    it(`takes the floor from the whole history with ${pendingSpent} pending rows`, async () => {
      const { explorer, lastMempoolRow, rowBefore } = fullPendingPagesExplorer(pendingSpent)
      const client = clientFor(explorer)
      // The explorer does answer the last pending row's cursor with nothing.
      await expect(client.getAddressHistoryPage(address, lastMempoolRow.txid)).resolves.toEqual([])
      explorer.requests.length = 0

      await expect(observeQbitPqcSignatureActivity(client, address, script)).resolves.toEqual({
        observedSignatures: 4 + pendingSpent,
        hasActivity: true,
        floorSource: 'history',
      })
      // It stepped back one row, to the cursor that lists the last pending row again.
      const paths = historyRequests(explorer).map(request => request.path)
      const emptyPage = paths.indexOf(`/address/${address}/txs?after_txid=${lastMempoolRow.txid}`)
      expect(emptyPage).toBeGreaterThan(0)
      expect(paths[emptyPage + 1]).toBe(`/address/${address}/txs?after_txid=${rowBefore.txid}`)
    })

    it(`finds every spender of the account's outputs with ${pendingSpent} pending rows`, async () => {
      const { explorer } = fullPendingPagesExplorer(pendingSpent)

      const spent = await observeQbitPqcSpentOutpoints(clientFor(explorer), address, script)

      const expected = new Map<string, string>()
      for (const tx of explorer.history(address)) {
        for (const input of tx.inputs) expected.set(`${input.txid}:${input.vout}`, tx.txid)
      }
      expect(expected.size).toBe(4 + pendingSpent)
      expect(new Map(spent)).toEqual(expected)
    })

    it(`loads the whole activity history with ${pendingSpent} pending rows`, async () => {
      const { explorer } = fullPendingPagesExplorer(pendingSpent)

      const result = await getQbitAccountHistory(clientFor(explorer), [address], {
        start: 0,
        limit: 1_000,
      })

      expect(result.total).toBe(200 + 4 + pendingSpent)
      expect(new Set(result.detail.map(item => item.txid))).toEqual(
        new Set(explorer.history(address).map(tx => tx.txid))
      )
      expect(result.detail.filter(item => item.confirmations === 0)).toHaveLength(pendingSpent)
    })

    it(`probes the activity revision with ${pendingSpent} pending rows`, async () => {
      const { explorer } = fullPendingPagesExplorer(pendingSpent)

      await expect(
        probeQbitAccountHistoryRevision(clientFor(explorer), [address])
      ).resolves.toMatchObject({ hasConfirmedHistory: true })
    })
  }

  it('takes no floor when the pending row it stepped back over has left', async () => {
    const { explorer, lastMempoolRow, rowBefore } = fullPendingPagesExplorer(50)
    // It leaves between the empty page and the page that should list it again.
    explorer.failures.push(({ path }) => {
      if (path.endsWith(`?after_txid=${rowBefore.txid}`)) explorer.removeTx(lastMempoolRow.txid)
      return undefined
    })

    await expect(
      observeQbitPqcSignatureActivity(clientFor(explorer), address, script)
    ).rejects.toMatchObject({ kind: 'invalid_cursor' })
  })
})

describe('the wallet mempool-qbit client reads history as @qbit-oss/api does (real clients)', () => {
  const pageRequests = (explorer: FakeQbitExplorer) =>
    historyRequests(explorer).map(request => request.path)
  const topPageRequests = (explorer: FakeQbitExplorer) =>
    pageRequests(explorer).filter(path => path === `/address/${address}/txs`)

  /** A confirmed payment to the address from an old block, so it lands near the end of the walk. */
  function payInOldBlock(explorer: FakeQbitExplorer, seed: number) {
    return explorer.addTx({
      txid: fakeTxid(seed, 8_000_000),
      inputs: [],
      outputs: [{ address, script, value: 10_000 }],
      coinbase: true,
      height: 99,
    })
  }

  it('walks the history again, once, when the statistics move during the walk', async () => {
    const explorer = restoredAddressExplorer('mempool-qbit', {
      funded: 200,
      spent: 4,
      pendingSpent: 50,
    })
    explorer.emptyPageAfterLastMempoolRow = true
    let arrived: ReturnType<typeof payInOldBlock> | undefined
    explorer.failures.push(({ path }) => {
      if (!arrived && path.includes('?after_txid=')) arrived = payInOldBlock(explorer, 1)
      return undefined
    })

    const history = await clientFor(explorer).getAddressHistory(address)

    expect(history.confirmed.map(tx => tx.txid)).toContain(arrived!.txid)
    expect(history.confirmed).toHaveLength(200 + 4 + 1)
    expect(history.mempool).toHaveLength(50)
    expect(topPageRequests(explorer)).toHaveLength(2)
  })

  it('rejects when the statistics move during each walk', async () => {
    const explorer = restoredAddressExplorer('mempool-qbit', {
      funded: 200,
      spent: 4,
      pendingSpent: 50,
    })
    explorer.emptyPageAfterLastMempoolRow = true
    let arrivals = 0
    let walks = 0
    explorer.failures.push(({ path }) => {
      if (path === `/address/${address}/txs`) walks += 1
      if (path.includes('?after_txid=') && arrivals < walks) payInOldBlock(explorer, ++arrivals)
      return undefined
    })

    await expect(clientFor(explorer).getAddressHistory(address)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining('changed during each of 2'),
    })
    expect(topPageRequests(explorer)).toHaveLength(2)
  })

  it("stops the whole walk once the caller's signal aborts", async () => {
    const explorer = restoredAddressExplorer('mempool-qbit', {
      funded: 200,
      spent: 4,
      pendingSpent: 50,
    })
    explorer.emptyPageAfterLastMempoolRow = true
    const controller = new AbortController()
    explorer.failures.push(({ path }) => {
      if (path.includes('?after_txid=')) controller.abort()
      return undefined
    })

    await expect(
      clientFor(explorer).getAddressHistory(address, { signal: controller.signal })
    ).rejects.toMatchObject({ kind: 'aborted' })
    expect(pageRequests(explorer).filter(path => path.includes('?after_txid='))).toHaveLength(1)
  })

  it("holds the whole walk to the caller's deadline", async () => {
    const explorer = restoredAddressExplorer('mempool-qbit', {
      funded: 200,
      spent: 4,
      pendingSpent: 50,
    })
    explorer.emptyPageAfterLastMempoolRow = true
    explorer.slowResponses.push({
      match: ({ path }) => path.includes('?after_txid='),
      chunkBytes: 1,
      intervalMs: 1,
      stallHeaders: true,
    })

    await expect(
      clientFor(explorer).getAddressHistory(address, { deadlineMs: 200 })
    ).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('skips a confirmed row a later page repeats, as the library does', async () => {
    const explorer = restoredAddressExplorer('mempool-qbit', {
      funded: 200,
      spent: 4,
      pendingSpent: 40,
    })
    const rows = explorer.history(address)
    // The first page holds the 40 pending rows and 10 confirmed ones.
    const secondPage = `/address/${address}/txs?after_txid=${rows[49]!.txid}`
    let reads = 0
    explorer.failures.push(({ path }) => {
      if (path !== secondPage || ++reads < 2) return undefined
      // The account history's recent read sees the page shifted by one row.
      const page = [rows[44]!, ...rows.slice(50, 99)].map(tx => explorer.esploraTx(tx))
      return { status: 200, body: JSON.stringify(page) }
    })

    const result = await getQbitAccountHistory(clientFor(explorer), [address], {
      start: 0,
      limit: 1_000,
    })

    expect(reads).toBe(2)
    expect(result.total).toBe(200 + 4 + 40)
  })

  it('reads no page past a short one for the newest confirmed rows', async () => {
    const explorer = restoredAddressExplorer('mempool-qbit', { funded: 5 })

    const result = await getQbitAccountHistory(clientFor(explorer), [address], {
      start: 0,
      limit: 1_000,
    })

    expect(result.total).toBe(5)
    // Only the full walk reads the empty page that ends the history.
    expect(pageRequests(explorer).filter(path => path.includes('?after_txid='))).toHaveLength(1)
  })
})
