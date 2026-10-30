import { describe, expect, it } from 'vitest'

import {
  observeQbitPqcSignatureActivity,
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
