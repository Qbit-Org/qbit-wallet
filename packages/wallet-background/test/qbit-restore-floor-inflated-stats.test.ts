import { beforeAll, describe, expect, it, vi } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { QbitHdKeyring, QbitPqcFloorsPendingError } from '@qbit/keyring-service/qbit-hd-keyring'
import {
  observeQbitPqcSignatureActivity,
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
} from '../src/utils/qbit-api'
import { FakeQbitExplorer } from './qbit-fake-explorer'

const address = 'qbrt1zinflatedfloor'
const script = `5220${'dd'.repeat(32)}`
const BASE = 'https://explorer.test/api'
const mnemonic = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const PQC_MAX_SIGNATURES = 1 << 30
const PQC_WARNING_SIGNATURE_THRESHOLD = 1 << 28
// One transaction fits in a 2,000,000-byte block: 43-byte outputs paying a
// P2MR address, inputs spending one of at least 3,728 bytes.
const MAX_OUTPUTS_PER_TX = 46_511
const MAX_INPUTS_PER_TX = 536

/** One scope of address statistics, 1,000 sats an output. */
function scope(txCount: number, funded: number, spent = 0) {
  return {
    tx_count: txCount,
    funded_txo_count: funded,
    funded_txo_sum: funded * 1_000,
    spent_txo_count: spent,
    spent_txo_sum: spent * 1_000,
  }
}

/**
 * An explorer that reports these statistics for every address, as a lying or
 * buggy one would, with no transactions behind them.
 */
function statsExplorer(
  chain: ReturnType<typeof scope>,
  mempool = scope(0, 0),
  surface: 'esplora' | 'mempool-qbit' = 'esplora'
) {
  const explorer = new FakeQbitExplorer(surface)
  explorer.stats = (requested: string) => ({
    address: requested,
    chain_stats: chain,
    mempool_stats: mempool,
  })
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

function observe(explorer: FakeQbitExplorer) {
  return observeQbitPqcSignatureActivity(clientFor(explorer), address, script)
}

describe('restore floor from inflated address statistics', () => {
  beforeAll(async () => {
    await init()
  })

  it('refuses a floor of the whole signature budget and leaves the signing gate as it was', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic,
      activeIndexes: [0],
      hdPath: "m/87'/0'/0'/0",
      pqcFloorsPending: true,
    })
    const [account] = await keyring.getQbitAccounts()
    const scan = (explorer: FakeQbitExplorer) =>
      keyring.scanPqcSignatureCounterFloors(
        candidate =>
          observeQbitPqcSignatureActivity(
            clientFor(explorer),
            candidate.addresses.mainnet,
            candidate.scriptPubKey
          ),
        { lookahead: 0 }
      )
    // Just past the 6,400-transaction read cap, so the floor comes from the
    // statistics alone.
    const inflated = statsExplorer(scope(6_401, PQC_MAX_SIGNATURES, PQC_MAX_SIGNATURES))

    await expect(scan(inflated)).rejects.toThrow(`qbit address ${account!.addresses.mainnet} `)
    expect(historyRequests(inflated)).toEqual([])
    expect(keyring.pqcFloorsPending).toBe(true)
    expect(await keyring.getPqcSignatureCounter(account!.pubkey)).toBe(0)
    expect((await keyring.getQbitAccounts())[0]!.signatureCounter).toMatchObject({
      count: 0,
      knownOnChainSignatures: 0,
    })
    await expect(
      keyring.assertPqcSignatureCounterAvailable(account!.pubkey)
    ).rejects.toBeInstanceOf(QbitPqcFloorsPendingError)

    // A later scan against an honest explorer still completes the restore.
    await expect(scan(statsExplorer(scope(6_401, 9_000, 100)))).resolves.toMatchObject({
      floorSources: [{ index: 0, source: 'address-stats' }],
    })
    expect(keyring.pqcFloorsPending).toBe(false)
    expect(await keyring.getPqcSignatureCounter(account!.pubkey)).toBe(100)
    await expect(keyring.assertPqcSignatureCounterAvailable(account!.pubkey)).resolves.toBe(
      undefined
    )
  })

  it('refuses self-consistent statistics that claim the warning threshold or more', async () => {
    // Enough transactions to carry 2^30 spends.
    const txCount = 2_100_000
    const refused = `qbit address ${address} stats claim ${PQC_WARNING_SIGNATURE_THRESHOLD} signatures, at or above the ${PQC_WARNING_SIGNATURE_THRESHOLD}-signature warning threshold`

    await expect(
      observe(
        statsExplorer(
          scope(txCount, PQC_WARNING_SIGNATURE_THRESHOLD, PQC_WARNING_SIGNATURE_THRESHOLD)
        )
      )
    ).rejects.toThrow(refused)
    // Confirmed and pending spends count together.
    await expect(
      observe(
        statsExplorer(
          scope(txCount, PQC_WARNING_SIGNATURE_THRESHOLD, PQC_WARNING_SIGNATURE_THRESHOLD - 1),
          scope(1, 0, 1)
        )
      )
    ).rejects.toThrow(refused)
    await expect(
      observe(
        statsExplorer(
          scope(txCount, PQC_MAX_SIGNATURES, PQC_MAX_SIGNATURES),
          scope(0, 0),
          'mempool-qbit'
        )
      )
    ).rejects.toThrow(`qbit address ${address} stats claim ${PQC_MAX_SIGNATURES} signatures`)

    await expect(
      observe(
        statsExplorer(
          scope(txCount, PQC_WARNING_SIGNATURE_THRESHOLD, PQC_WARNING_SIGNATURE_THRESHOLD - 1)
        )
      )
    ).resolves.toEqual({
      observedSignatures: PQC_WARNING_SIGNATURE_THRESHOLD - 1,
      hasActivity: true,
      floorSource: 'address-stats',
    })
  })

  it('refuses statistics that list more outputs than their transactions can carry', async () => {
    const tooMany = (scopeName: 'chain' | 'mempool') =>
      `qbit address ${address} ${scopeName} stats list more outputs than its transactions can carry`
    const cases: [ReturnType<typeof scope>, ReturnType<typeof scope>, string][] = [
      // Spends past the cap's 6,401 transactions, far below the warning threshold.
      [
        scope(6_401, 6_401 * MAX_INPUTS_PER_TX + 1, 6_401 * MAX_INPUTS_PER_TX + 1),
        scope(0, 0),
        tooMany('chain'),
      ],
      // Funding alone, with a small floor.
      [scope(6_401, 6_401 * MAX_OUTPUTS_PER_TX + 1, 100), scope(0, 0), tooMany('chain')],
      // More pending spends than an Esplora mempool listing holds.
      [scope(1, 30_000), scope(51, 0, 51 * MAX_INPUTS_PER_TX + 1), tooMany('mempool')],
      [scope(6_401, 6_401), scope(1, MAX_OUTPUTS_PER_TX + 1), tooMany('mempool')],
    ]
    for (const [chain, mempool, message] of cases) {
      const explorer = statsExplorer(chain, mempool)
      await expect(observe(explorer)).rejects.toThrow(message)
      expect(historyRequests(explorer)).toEqual([])
    }
  })

  it('accepts a history that carries the most outputs its transactions can', async () => {
    const chain = scope(6_401, 6_401 * MAX_OUTPUTS_PER_TX, 6_401 * MAX_INPUTS_PER_TX)
    for (const surface of ['esplora', 'mempool-qbit'] as const) {
      await expect(observe(statsExplorer(chain, scope(0, 0), surface))).resolves.toEqual({
        observedSignatures: 3_430_936,
        hasActivity: true,
        floorSource: 'address-stats',
      })
    }
    await expect(
      observe(statsExplorer(scope(1, 30_000), scope(51, 0, 51 * MAX_INPUTS_PER_TX)))
    ).resolves.toEqual({
      observedSignatures: 27_336,
      hasActivity: true,
      floorSource: 'address-stats',
    })
    await expect(
      observe(statsExplorer(scope(6_401, 6_401), scope(1, MAX_OUTPUTS_PER_TX)))
    ).resolves.toEqual({ observedSignatures: 0, hasActivity: true, floorSource: 'address-stats' })
  })

  it('refuses missing, malformed and nonfinite statistics before any bound', async () => {
    const tipHash = 'ab'.repeat(32)
    const over = scope(6_401, 6_401, 100)
    for (const [field, value] of [
      ['tx_count', undefined],
      ['tx_count', null],
      ['tx_count', '6401'],
      ['tx_count', Number.NaN],
      ['tx_count', Number.POSITIVE_INFINITY],
      ['tx_count', -6_401],
      ['tx_count', 6_401.5],
      ['tx_count', 2 ** 53],
      ['spent_txo_count', Number.POSITIVE_INFINITY],
      ['funded_txo_count', Number.POSITIVE_INFINITY],
    ] as const) {
      const client = {
        getTipHash: vi.fn().mockResolvedValue(tipHash),
        getAddressStats: vi.fn().mockResolvedValue({
          address,
          chain_stats: { ...over, [field]: value },
          mempool_stats: scope(0, 0),
        }),
        getAddressMempoolTxs: vi.fn(),
        getAddressHistory: vi.fn(),
      }
      await expect(observeQbitPqcSignatureActivity(client as any, address, script)).rejects.toThrow(
        `invalid chain ${field} for qbit address ${address}`
      )
      expect(client.getAddressHistory).not.toHaveBeenCalled()
    }
  })
})
