import { describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import { AddressType } from '@qbit/wallet-types'
import {
  classifyQbitProtectedAssetCoverage,
  discoverQbitActiveIndexes,
  findActiveQbitAddressGroups,
  getQbitAccountHistory,
  getQbitAddressSummaries,
  getQbitAddressUtxos,
  getQbitRawTransactionHex,
  getQbitAddressUtxosClassified,
  getQbitSpendableBalanceV2,
  getQbitTxSpenders,
  MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES,
  observeQbitPqcSignatureActivity,
  observeQbitPqcSpentOutpoints,
  probeQbitAccountHistoryRevision,
  qbitAddressHasUnconfirmedSpends,
  qbitAmountFromSats,
  qbitBalanceToWalletBalance,
  qbitBalanceToSummary,
  qbitFeeSummaryFromTiers,
  qbitStatsToAddressSummary,
  qbitTxToHistoryItem,
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
} from '../src/utils/qbit-api'

const address = 'qbrt1zexample'
const scriptPubKey = `5220${'11'.repeat(32)}`
const tipHash = 'aa'.repeat(32)
const witnessTransactionHex =
  '0200000000010111111111111111111111111111111111111111111111111111111111111111110100000000fdffffff01d20400000000000022522022222222222222222222222222222222222222222222222222222222222222220204aabbccdd015100000000'
const witnessTransactionTxid = 'af3874efbf6ee007cf7450b79b7d2dcc18bb9efc6a908bbeaa44fd22eb447c12'

/** A confirmed transaction that paid the test account's own script. */
const confirmedOwnParentTxid = 'c0'.repeat(32)
const confirmedOwnParent = {
  txid: confirmedOwnParentTxid,
  vin: [{ txid: 'cf'.repeat(32), vout: 0, is_coinbase: false, prevout: null }],
  vout: [{ scriptpubkey: scriptPubKey, value: 100_000 }],
  status: { confirmed: true, block_height: 9 },
}

/** An input spending an output of the test account's own script. */
function ownInput(value: number, txid = confirmedOwnParentTxid) {
  return { txid, vout: 0, is_coinbase: false, prevout: { scriptpubkey: scriptPubKey, value } }
}

function historyStats(
  chainTxCount = 0,
  mempoolTxCount = 0,
  chainSpentCount = 0,
  mempoolSpentCount = 0
) {
  return {
    address,
    chain_stats: {
      funded_txo_count: Math.max(chainTxCount, chainSpentCount),
      funded_txo_sum: Math.max(chainTxCount, chainSpentCount),
      spent_txo_count: chainSpentCount,
      spent_txo_sum: chainSpentCount,
      tx_count: chainTxCount,
    },
    mempool_stats: {
      funded_txo_count: Math.max(mempoolTxCount, mempoolSpentCount),
      funded_txo_sum: Math.max(mempoolTxCount, mempoolSpentCount),
      spent_txo_count: mempoolSpentCount,
      spent_txo_sum: mempoolSpentCount,
      tx_count: mempoolTxCount,
    },
  }
}

function historyTx(index: number, confirmed: boolean, inputScripts = [scriptPubKey]) {
  return {
    txid: index.toString(16).padStart(64, '0'),
    version: 2,
    locktime: 0,
    vin: inputScripts.map((inputScript, inputIndex) => ({
      txid: (index * 100 + inputIndex).toString(16).padStart(64, '0'),
      vout: inputIndex,
      prevout: {
        scriptpubkey: inputScript,
        scriptpubkey_asm: '',
        scriptpubkey_type: 'v2_p2mr',
        scriptpubkey_address: address,
        value: 1,
      },
      scriptsig: '',
      scriptsig_asm: '',
      is_coinbase: false,
      sequence: 0xfffffffd,
    })),
    vout: [],
    size: 1,
    weight: 1,
    fee: 0,
    status: confirmed ? { confirmed: true, block_height: 1 } : { confirmed: false },
  }
}

const secondAddress = 'qbrt1zsecond'
const externalAddress = 'qbrt1zexternal'
const externalOutputAddress = 'qbrt1zexternaloutput'

function accountHistoryTx({
  txid = 'ab'.repeat(32),
  inputs = [],
  outputs = [],
  confirmed = true,
  blockHeight = 8,
  blockTime = 123,
}: {
  txid?: string
  inputs?: {
    address?: string
    value?: number
    missingPrevout?: boolean
    coinbase?: boolean
    txid?: string
    vout?: number
  }[]
  outputs?: { address?: string; value: number; scriptType?: string }[]
  confirmed?: boolean
  blockHeight?: number
  blockTime?: number
}) {
  return {
    txid,
    version: 2,
    locktime: 0,
    vin: inputs.map((input, index) => ({
      txid:
        input.coinbase === true
          ? '00'.repeat(32)
          : (input.txid ?? (index + 1).toString(16).padStart(64, '0')),
      vout: input.coinbase === true ? 0xffffffff : (input.vout ?? index),
      prevout:
        input.coinbase || input.missingPrevout
          ? null
          : {
              scriptpubkey: '51',
              scriptpubkey_asm: 'OP_PUSHNUM_1',
              scriptpubkey_type: 'v2_p2mr',
              ...(input.address ? { scriptpubkey_address: input.address } : {}),
              value: input.value ?? 0,
            },
      scriptsig: '',
      scriptsig_asm: '',
      is_coinbase: input.coinbase === true,
      sequence: 0xfffffffd,
    })),
    vout: outputs.map(output => ({
      scriptpubkey: output.scriptType === 'op_return' ? '6a00' : '51',
      scriptpubkey_asm: output.scriptType === 'op_return' ? 'OP_RETURN OP_0' : 'OP_PUSHNUM_1',
      scriptpubkey_type: output.scriptType ?? 'v2_p2mr',
      ...(output.address ? { scriptpubkey_address: output.address } : {}),
      value: output.value,
    })),
    size: 100,
    weight: 100,
    fee: 10,
    status: confirmed
      ? { confirmed: true, block_height: blockHeight, block_time: blockTime }
      : { confirmed: false },
  }
}

function accountHistoryClient(
  histories: Record<string, { confirmed: any[]; mempool: any[] }>,
  overrides: Record<string, unknown> = {}
) {
  const stats = new Map(
    Object.entries(histories).map(([itemAddress, history]) => [
      itemAddress,
      {
        address: itemAddress,
        chain_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: history.confirmed.length,
        },
        mempool_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: history.mempool.length,
        },
      },
    ])
  )
  return {
    getTipHash: vi.fn().mockResolvedValue(tipHash),
    getTipHeight: vi.fn().mockResolvedValue(10),
    getAddressStats: vi.fn(async (itemAddress: string) => stats.get(itemAddress)),
    getAddressHistory: vi.fn(async (itemAddress: string) => histories[itemAddress]),
    getAddressTxs: vi.fn(
      async (itemAddress: string) => histories[itemAddress]?.confirmed.slice(0, 25) ?? []
    ),
    getAddressMempoolTxs: vi.fn(
      async (itemAddress: string) => histories[itemAddress]?.mempool ?? []
    ),
    ...overrides,
  }
}

describe('qbit Esplora wallet adapters', () => {
  it('maps satoshi balances into existing wallet balance shapes', () => {
    const balance = {
      address,
      confirmedSats: 123_456_789,
      mempoolSats: 10_000,
      totalSats: 123_466_789,
    }

    expect(qbitAmountFromSats(123_456_789)).toBe('1.23456789')
    expect(qbitBalanceToWalletBalance(balance)).toMatchObject({
      confirm_amount: '1.23456789',
      pending_amount: '0.00010000',
      amount: '1.23466789',
    })
    expect(qbitBalanceToSummary(balance)).toEqual({
      availableBalance: 123_456_789,
      unavailableBalance: 10_000,
      totalBalance: 123_466_789,
    })
  })

  it('maps address stats into existing summary shape', () => {
    expect(
      qbitStatsToAddressSummary({
        address,
        chain_stats: {
          funded_txo_count: 2,
          funded_txo_sum: 2000,
          spent_txo_count: 1,
          spent_txo_sum: 500,
          tx_count: 2,
        },
        mempool_stats: {
          funded_txo_count: 1,
          funded_txo_sum: 250,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 1,
        },
      })
    ).toEqual({
      address,
      totalSatoshis: 1750,
      spendableSatoshis: 1750,
    })
  })

  it('maps multi-address qbit stats in input order', async () => {
    const fundedAddress = `${address}funded`
    const emptyAddress = `${address}empty`
    const client = {
      getAddressStats: vi.fn(async (item: string) => ({
        address: item,
        chain_stats: {
          funded_txo_count: item === fundedAddress ? 1 : 0,
          funded_txo_sum: item === fundedAddress ? 5000 : 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: item === fundedAddress ? 1 : 0,
        },
        mempool_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 0,
        },
      })),
    }

    await expect(
      getQbitAddressSummaries(client as any, `${emptyAddress},${fundedAddress}`)
    ).resolves.toEqual([
      { address: emptyAddress, totalSatoshis: 0, spendableSatoshis: 0 },
      { address: fundedAddress, totalSatoshis: 5000, spendableSatoshis: 5000 },
    ])
  })

  it('keeps funded and spent-only qbit restore addresses aligned with pubkeys and sats', async () => {
    const fundedAddress = `${address}funded`
    const spentAddress = `${address}spent`
    const emptyAddress = `${address}empty`
    const client = {
      getAddressStats: vi.fn(async (item: string) => ({
        address: item,
        chain_stats: {
          funded_txo_count: item === emptyAddress ? 0 : 1,
          funded_txo_sum: item === emptyAddress ? 0 : 7000,
          spent_txo_count: item === spentAddress ? 1 : 0,
          spent_txo_sum: item === spentAddress ? 7000 : 0,
          tx_count: item === fundedAddress ? 1 : item === spentAddress ? 2 : 0,
        },
        mempool_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 0,
        },
      })),
    }

    await expect(
      findActiveQbitAddressGroups(client as any, [
        {
          type: AddressType.P2MR,
          address_arr: [emptyAddress, fundedAddress, spentAddress],
          pubkey_arr: ['empty-pubkey', 'funded-pubkey', 'spent-pubkey'],
        },
      ])
    ).resolves.toEqual([
      {
        type: AddressType.P2MR,
        address_arr: [fundedAddress, spentAddress],
        pubkey_arr: ['funded-pubkey', 'spent-pubkey'],
        satoshis_arr: [7000, 0],
      },
    ])
  })

  it('rejects qbit restore discovery stats for a different address', async () => {
    const restoreAddress = `${address}restore`
    const client = {
      getAddressStats: vi.fn().mockResolvedValue(historyStats()),
    }

    await expect(
      findActiveQbitAddressGroups(client as any, [
        {
          type: AddressType.P2MR,
          address_arr: [restoreAddress],
          pubkey_arr: ['restore-pubkey'],
        },
      ])
    ).rejects.toThrow(`invalid qbit address stats for ${restoreAddress}`)
  })

  it('proves an inactive zero floor with complete qbit history', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats()),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).resolves.toEqual({ observedSignatures: 0, hasActivity: false })
    expect(client.getTipHash).toHaveBeenCalledTimes(2)
    expect(client.getAddressStats).toHaveBeenCalledTimes(2)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledTimes(1)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(1)
  })

  it('rejects history that contradicts stable zero qbit stats', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats()),
      getAddressMempoolTxs: vi.fn(),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [historyTx(1, true)],
        mempool: [],
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`incomplete qbit confirmed history for ${address}`)
    expect(client.getAddressMempoolTxs).not.toHaveBeenCalled()
  })

  it('counts every matching qbit input as a consumed signature', async () => {
    const fundingTx = historyTx(1, true, [])
    const spendTx = historyTx(2, true, [scriptPubKey, scriptPubKey.toUpperCase(), '51'])
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(2, 0, 2)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [spendTx, fundingTx],
        mempool: [],
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).resolves.toEqual({ observedSignatures: 2, hasActivity: true })
    expect(client.getAddressStats).toHaveBeenCalledTimes(2)
  })

  it('reports unconfirmed spends from validated address stats', async () => {
    const client = {
      getAddressStats: vi
        .fn()
        .mockResolvedValueOnce(historyStats(2, 0, 2))
        .mockResolvedValueOnce(historyStats(2, 1, 2, 1)),
    }

    await expect(qbitAddressHasUnconfirmedSpends(client as any, address)).resolves.toBe(false)
    await expect(qbitAddressHasUnconfirmedSpends(client as any, address)).resolves.toBe(true)
  })

  it('rejects unconfirmed-spend checks built on invalid address stats', async () => {
    const client = {
      getAddressStats: vi.fn().mockResolvedValue({
        ...historyStats(1, 0, 1),
        address: 'qbrt1zother',
      }),
    }

    await expect(qbitAddressHasUnconfirmedSpends(client as any, address)).rejects.toThrow(
      'invalid qbit address stats'
    )
  })

  it('returns exact spender evidence from complete stable qbit history', async () => {
    const fundingTx = historyTx(1, true, [])
    const spendTx = historyTx(2, true, [scriptPubKey, scriptPubKey.toUpperCase(), '51'])
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(2, 0, 2)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [spendTx, fundingTx],
        mempool: [],
      }),
    }

    await expect(
      observeQbitPqcSpentOutpoints(client as any, address, scriptPubKey)
    ).resolves.toEqual(
      new Map([
        [`${spendTx.vin[0]!.txid}:0`, spendTx.txid],
        [`${spendTx.vin[1]!.txid}:1`, spendTx.txid],
      ])
    )
  })

  it('consumes complete qbit history once and combines confirmed and mempool signatures', async () => {
    const confirmedTxs = Array.from({ length: 25 }, (_, index) => historyTx(index + 1, true))
    const finalTx = historyTx(26, true)
    const mempoolTx = historyTx(27, false)
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(26, 1, 26, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([mempoolTx]),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [...confirmedTxs, finalTx],
        mempool: [mempoolTx],
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).resolves.toEqual({ observedSignatures: 27, hasActivity: true })
    expect(client.getAddressHistory).toHaveBeenCalledTimes(1)
    // Twice the one-read budget: @qbit-oss/api counts its rescan against it.
    expect(client.getAddressHistory).toHaveBeenCalledWith(address, {
      maxPages: 512,
      maxTransactions: 12_800,
    })
  })

  it('rejects an incomplete qbit confirmed history', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(2)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [historyTx(1, true)],
        mempool: [],
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`incomplete qbit confirmed history for ${address}`)
  })

  it('propagates a bounded qbit history scan failure', async () => {
    const scanError = new Error('qbit history exceeded its request budget')
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats()),
      getAddressMempoolTxs: vi.fn(),
      getAddressHistory: vi.fn().mockRejectedValue(scanError),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toBe(scanError)
    expect(client.getAddressMempoolTxs).not.toHaveBeenCalled()
  })

  it('rejects reported qbit history above the configured transaction cap before scanning', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(2)),
      getAddressHistory: vi.fn(),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        maxHistoryTransactions: 1,
      })
    ).rejects.toThrow(`qbit address history exceeds the 1-transaction limit for ${address}`)
    expect(client.getAddressHistory).not.toHaveBeenCalled()
  })

  it('rejects missing non-coinbase prevouts while counting qbit signatures', async () => {
    const tx = historyTx(1, true)
    tx.vin[0]!.prevout = null as any
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(1, 0, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [tx], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`missing prevout while scanning qbit transaction ${tx.txid}`)
  })

  it('rejects a qbit history snapshot that changes during the scan', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi
        .fn()
        .mockResolvedValueOnce(historyStats(1, 0, 1))
        .mockResolvedValueOnce(historyStats(1, 1, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [historyTx(1, true)],
        mempool: [],
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`qbit address history changed while scanning ${address}`)
  })

  it('rejects a qbit chain-tip change even when aggregate stats stay equal', async () => {
    const confirmedTx = {
      ...historyTx(1, true),
      status: { confirmed: true, block_height: 7, block_hash: 'cc'.repeat(32) },
    }
    const client = {
      getTipHash: vi.fn().mockResolvedValueOnce(tipHash).mockResolvedValueOnce('bb'.repeat(32)),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(1, 0, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [confirmedTx], mempool: [] }),
    }

    // The address endpoints cannot show whether their index already includes
    // the block the tip endpoint reports, so an unchanged re-read would prove
    // nothing; the advance fails the observation without a second history read.
    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`qbit address history changed while scanning ${address}`)
    expect(client.getTipHash).toHaveBeenCalledTimes(2)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(1)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledTimes(1)
  })

  it('re-observes an address from scratch after a qbit chain-tip advance', async () => {
    // A block landed during the first window; by the retry the index has
    // caught up and shows the spend that block confirmed. The retry counts
    // it because it re-reads everything rather than reusing the first read.
    const firstSpend = historyTx(1, true)
    const secondSpend = historyTx(2, true)
    const client = {
      getTipHash: vi
        .fn()
        .mockResolvedValueOnce(tipHash)
        .mockResolvedValueOnce('bb'.repeat(32))
        .mockResolvedValue('bb'.repeat(32)),
      getAddressStats: vi
        .fn()
        .mockResolvedValueOnce(historyStats(1, 0, 1))
        .mockResolvedValueOnce(historyStats(1, 0, 1))
        .mockResolvedValue(historyStats(2, 0, 2)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi
        .fn()
        .mockResolvedValueOnce({ confirmed: [firstSpend], mempool: [] })
        .mockResolvedValue({ confirmed: [firstSpend, secondSpend], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 1,
        retryBaseDelayMs: 0,
      })
    ).resolves.toEqual({ observedSignatures: 2, hasActivity: true })
    expect(client.getTipHash).toHaveBeenCalledTimes(4)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('waits out the tip-advance settle floor before re-observing an address', async () => {
    vi.useFakeTimers()
    try {
      const client = {
        getTipHash: vi.fn().mockResolvedValueOnce(tipHash).mockResolvedValue('bb'.repeat(32)),
        getAddressStats: vi.fn().mockResolvedValue(historyStats(1, 0, 1)),
        getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
        getAddressHistory: vi
          .fn()
          .mockResolvedValue({ confirmed: [historyTx(1, true)], mempool: [] }),
      }
      let settled = false
      const observation = observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 1,
        retryBaseDelayMs: 0,
        tipAdvanceSettleMs: 10_000,
      }).then(result => {
        settled = true
        return result
      })

      // The first attempt straddles the advance. The retry is held for the
      // settle floor even though the ordinary back-off would fire at once.
      await vi.advanceTimersByTimeAsync(9_999)
      expect(client.getAddressHistory).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(observation).resolves.toEqual({ observedSignatures: 1, hasActivity: true })
      expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hold a churn retry for the tip-advance settle floor', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi
        .fn()
        .mockResolvedValueOnce(historyStats(1, 0, 1))
        .mockResolvedValueOnce(historyStats(1, 1, 1))
        .mockResolvedValue(historyStats(1, 0, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi
        .fn()
        .mockResolvedValue({ confirmed: [historyTx(1, true)], mempool: [] }),
    }
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      await expect(
        observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
          stabilityRetries: 1,
          retryBaseDelayMs: 0,
          tipAdvanceSettleMs: 10_000,
        })
      ).resolves.toEqual({ observedSignatures: 1, hasActivity: true })
      expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
      expect(setTimeoutSpy).not.toHaveBeenCalled()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('rejects a tip-advance settle floor above the retry delay cap', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn(),
      getAddressMempoolTxs: vi.fn(),
      getAddressHistory: vi.fn(),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        tipAdvanceSettleMs: 30_001,
      })
    ).rejects.toThrow('tipAdvanceSettleMs must be an integer between 0 and 30000')
    expect(client.getTipHash).not.toHaveBeenCalled()
  })

  it('fails a qbit observation whose every attempt straddles a chain-tip advance', async () => {
    let tipReads = 0
    const client = {
      getTipHash: vi.fn(async () => (tipReads++).toString(16).padStart(64, '0')),
      getAddressStats: vi.fn().mockResolvedValue(historyStats()),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 2,
        retryBaseDelayMs: 0,
      })
    ).rejects.toThrow(`qbit address history changed while scanning ${address}`)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(3)
  })

  it('rejects a same-size qbit mempool replacement during the scan', async () => {
    const firstMempoolTx = historyTx(1, false)
    const replacementMempoolTx = historyTx(2, false)
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(0, 1, 0, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([replacementMempoolTx]),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [],
        mempool: [firstMempoolTx],
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`qbit address history changed while scanning ${address}`)
  })

  it('retries a moving qbit observation a bounded number of times per address', async () => {
    // Every attempt reads stats twice; the first three attempts see the
    // mempool change between those reads and every later attempt is stable.
    let statsReads = 0
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn(async () => {
        const read = statsReads++
        const unstableAttempt = Math.floor(read / 2) < 3
        return unstableAttempt && read % 2 === 1 ? historyStats(1, 1, 1) : historyStats(1, 0, 1)
      }),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [historyTx(1, true)], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 2,
        retryBaseDelayMs: 0,
      })
    ).rejects.toThrow(`qbit address history changed while scanning ${address}`)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(3)

    statsReads = 0
    client.getAddressHistory.mockClear()
    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 3,
        retryBaseDelayMs: 0,
      })
    ).resolves.toEqual({ observedSignatures: 1, hasActivity: true })
    expect(client.getAddressHistory).toHaveBeenCalledTimes(4)
  })

  it('does not retry a qbit observation by default or beyond the retry cap', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi
        .fn()
        .mockResolvedValueOnce(historyStats(1, 0, 1))
        .mockResolvedValue(historyStats(1, 1, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [historyTx(1, true)], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`qbit address history changed while scanning ${address}`)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(1)

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 6,
      })
    ).rejects.toThrow('stabilityRetries must be an integer between 0 and 5')
    expect(client.getAddressHistory).toHaveBeenCalledTimes(1)
  })

  it('does not retry a qbit observation that fails for a non-transient reason', async () => {
    const tx = historyTx(1, true)
    tx.vin[0]!.prevout = null as any
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(1, 0, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [tx], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 3,
        retryBaseDelayMs: 0,
      })
    ).rejects.toThrow(`missing prevout while scanning qbit transaction ${tx.txid}`)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(1)
  })

  it('retries a qbit observation whose stats briefly lag the complete history', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi
        .fn()
        .mockResolvedValueOnce(historyStats(1, 0, 1))
        .mockResolvedValue(historyStats()),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey, {
        stabilityRetries: 1,
        retryBaseDelayMs: 0,
      })
    ).resolves.toEqual({ observedSignatures: 0, hasActivity: false })
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('retries a qbit observation whose history pagination shifted under the read', async () => {
    // mempool-qbit pages combined history by txid cursor; a transaction that
    // lands between pages repeats or stalls the cursor, which @qbit-oss/api
    // reports as `invalid_cursor`. The account history loader already retries
    // that; a restore floor scan must classify it the same way.
    const shiftedPagination = () =>
      new QbitApiError(
        'invalid_cursor',
        `mempool-qbit address history cursor stopped advancing: (missing) (${address})`
      )
    const clientFor = (historyFailures: QbitApiError[]) => {
      const getAddressHistory = vi.fn()
      for (const failure of historyFailures) getAddressHistory.mockRejectedValueOnce(failure)
      getAddressHistory.mockResolvedValue({ confirmed: [historyTx(1, true)], mempool: [] })
      return {
        getTipHash: vi.fn().mockResolvedValue(tipHash),
        getAddressStats: vi.fn().mockResolvedValue(historyStats(1, 0, 1)),
        getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
        getAddressHistory,
      }
    }

    const unretried = clientFor([shiftedPagination()])
    await expect(
      observeQbitPqcSignatureActivity(unretried as any, address, scriptPubKey)
    ).rejects.toThrow('address history cursor stopped advancing')
    expect(unretried.getAddressHistory).toHaveBeenCalledTimes(1)

    const retried = clientFor([shiftedPagination()])
    await expect(
      observeQbitPqcSignatureActivity(retried as any, address, scriptPubKey, {
        stabilityRetries: 1,
        retryBaseDelayMs: 0,
      })
    ).resolves.toEqual({ observedSignatures: 1, hasActivity: true })
    expect(retried.getAddressHistory).toHaveBeenCalledTimes(2)

    // Other explorer failures are not pagination churn and are never retried.
    const capped = clientFor([
      new QbitApiError('pagination_limit', `esplora address history exceeded 4 pages: ${address}`),
    ])
    await expect(
      observeQbitPqcSignatureActivity(capped as any, address, scriptPubKey, {
        stabilityRetries: 1,
        retryBaseDelayMs: 0,
      })
    ).rejects.toThrow('address history exceeded 4 pages')
    expect(capped.getAddressHistory).toHaveBeenCalledTimes(1)
  })

  it('retries qbit spent-outpoint evidence with the same per-address bound', async () => {
    const spendTx = historyTx(2, true)
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi
        .fn()
        .mockResolvedValueOnce(historyStats(1, 0, 1))
        .mockResolvedValueOnce(historyStats(1, 1, 1))
        .mockResolvedValue(historyStats(1, 0, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [spendTx], mempool: [] }),
    }

    await expect(
      observeQbitPqcSpentOutpoints(client as any, address, scriptPubKey, {
        stabilityRetries: 1,
        retryBaseDelayMs: 0,
      })
    ).resolves.toEqual(new Map([[`${spendTx.vin[0]!.txid}:0`, spendTx.txid]]))
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('rejects qbit history whose detailed inputs omit a reported spend', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(1, 0, 1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({
        confirmed: [historyTx(1, true, ['51'])],
        mempool: [],
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`incomplete qbit spent-input history for ${address}`)
  })

  it('rejects qbit address stats with a missing required field', async () => {
    const stats = historyStats() as any
    delete stats.chain_stats.spent_txo_count
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(stats),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`invalid chain spent_txo_count for qbit address ${address}`)
  })

  it('rejects qbit stats returned for a different address', async () => {
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue({
        ...historyStats(),
        address: `${address}other`,
      }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`invalid qbit address stats for ${address}`)
  })

  it.each([
    ['chain', 'funded_txo_sum'],
    ['chain', 'spent_txo_sum'],
    ['mempool', 'funded_txo_sum'],
    ['mempool', 'spent_txo_sum'],
  ] as const)('rejects nonzero %s %s without a corresponding count', async (scope, field) => {
    const stats = historyStats() as any
    stats[`${scope}_stats`][field] = 1
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(stats),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`inconsistent ${scope} stats for qbit address ${address}`)
  })

  it.each(['chain', 'mempool'] as const)(
    'rejects %s output activity with a zero transaction count',
    async scope => {
      const stats = historyStats() as any
      stats[`${scope}_stats`].funded_txo_count = 1
      const client = {
        getTipHash: vi.fn().mockResolvedValue(tipHash),
        getAddressStats: vi.fn().mockResolvedValue(stats),
      }

      await expect(
        observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
      ).rejects.toThrow(`inconsistent ${scope} stats for qbit address ${address}`)
    }
  )

  it.each(['maxHistoryPages', 'maxHistoryTransactions'] as const)(
    'rejects invalid %s values',
    async option => {
      const invalidValues = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
      for (const value of invalidValues) {
        await expect(
          observeQbitPqcSignatureActivity({} as any, address, scriptPubKey, {
            [option]: value,
          })
        ).rejects.toThrow(`${option} must be a positive integer`)
      }
    }
  )

  it('rejects duplicate transactions returned by complete qbit history', async () => {
    const tx = historyTx(1, true)
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getAddressStats: vi.fn().mockResolvedValue(historyStats(1)),
      getAddressMempoolTxs: vi.fn().mockResolvedValue([]),
      getAddressHistory: vi.fn().mockResolvedValue({ confirmed: [tx, tx], mempool: [] }),
    }

    await expect(
      observeQbitPqcSignatureActivity(client as any, address, scriptPubKey)
    ).rejects.toThrow(`duplicate transaction returned in qbit chain history for ${address}`)
  })

  it('hydrates qbit UTXOs with scriptPubKeys from tx detail', async () => {
    const txid = 'aa'.repeat(32)
    const client = {
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid,
          vout: 1,
          value: 42_000,
          status: { confirmed: true, block_height: 10 },
        },
      ]),
      getTx: vi.fn().mockResolvedValue({
        txid,
        vin: [{ is_coinbase: false }],
        vout: [
          { scriptpubkey: '51', value: 1 },
          { scriptpubkey: `5220${'11'.repeat(32)}`, value: 42_000 },
        ],
      }),
    }

    await expect(getQbitAddressUtxos(client as any, address)).resolves.toEqual([
      {
        txid,
        vout: 1,
        satoshis: 42_000,
        scriptPk: `5220${'11'.repeat(32)}`,
        addressType: AddressType.P2MR,
      },
    ])
  })

  it.each([
    {
      name: 'a transaction id for another transaction',
      mutate: (fixture: any) => {
        fixture.tx.txid = 'bb'.repeat(32)
      },
      message: 'transaction id mismatch',
    },
    {
      name: 'a missing referenced output',
      mutate: (fixture: any) => {
        fixture.tx.vout = []
      },
      message: 'missing output',
    },
    {
      name: 'a contradictory output value',
      mutate: (fixture: any) => {
        fixture.tx.vout[0].value += 1
      },
      message: 'output value mismatch',
    },
    {
      name: 'a non-P2MR output script',
      mutate: (fixture: any) => {
        fixture.tx.vout[0].scriptpubkey = '51'
      },
      message: 'invalid P2MR output script',
    },
  ])('rejects an indexer UTXO backed by $name', async ({ mutate, message }) => {
    const txid = 'a1'.repeat(32)
    const fixture = {
      utxo: {
        txid,
        vout: 0,
        value: 42_000,
        status: { confirmed: true, block_height: 10 },
      },
      tx: {
        txid,
        vin: [{ is_coinbase: false }],
        vout: [{ scriptpubkey: scriptPubKey, value: 42_000 }],
      },
    }
    mutate(fixture)
    const client = {
      getAddressUtxos: vi.fn().mockResolvedValue([fixture.utxo]),
      getTx: vi.fn().mockResolvedValue(fixture.tx),
    }

    await expect(getQbitAddressUtxos(client as any, address)).rejects.toThrow(message)
  })

  it('rejects duplicate outpoints before fetching transaction detail', async () => {
    const txid = 'a2'.repeat(32)
    const utxo = {
      txid,
      vout: 0,
      value: 42_000,
      status: { confirmed: true, block_height: 10 },
    }
    const client = {
      getAddressUtxos: vi.fn().mockResolvedValue([utxo, { ...utxo }]),
      getTx: vi.fn(),
    }

    await expect(getQbitAddressUtxos(client as any, address)).rejects.toThrow(
      `duplicate qbit UTXO ${txid}:0`
    )
    expect(client.getTx).not.toHaveBeenCalled()
  })

  it.each([
    ['non-hex txid', { txid: 'not-a-txid' }],
    ['negative vout', { vout: -1 }],
    ['fractional value', { value: 1.5 }],
    ['confirmed output without a block height', { status: { confirmed: true } }],
  ])('rejects malformed indexer UTXO field: %s', async (_name, override) => {
    const txid = 'a3'.repeat(32)
    const client = {
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid,
          vout: 0,
          value: 42_000,
          status: { confirmed: true, block_height: 10 },
          ...override,
        },
      ]),
      getTx: vi.fn(),
    }

    await expect(getQbitAddressUtxos(client as any, address)).rejects.toThrow(
      'invalid qbit UTXO'
    )
    expect(client.getTx).not.toHaveBeenCalled()
  })

  it('filters immature qbit coinbase UTXOs before wallet selection', async () => {
    const matureTxid = 'aa'.repeat(32)
    const immatureTxid = 'bb'.repeat(32)
    const boundaryTxid = 'ab'.repeat(32)
    const client = {
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          // 500 confirmations is below Qbit's 1,000-block consensus maturity.
          txid: immatureTxid,
          vout: 0,
          value: 25_000,
          status: { confirmed: true, block_height: 1501 },
        },
        {
          // 999 confirmations: one block short of maturity.
          txid: boundaryTxid,
          vout: 2,
          value: 11_000,
          status: { confirmed: true, block_height: 1002 },
        },
        {
          // Exactly 1,000 confirmations: first spendable height.
          txid: matureTxid,
          vout: 1,
          value: 42_000,
          status: { confirmed: true, block_height: 1001 },
        },
      ]),
      getTipHeight: vi.fn().mockResolvedValue(2000),
      getTx: vi.fn(async (txid: string) => ({
        vin: [{ is_coinbase: true }],
        vout: [
          { scriptpubkey: `5220${'22'.repeat(32)}`, value: 25_000 },
          { scriptpubkey: `5220${'11'.repeat(32)}`, value: 42_000 },
          { scriptpubkey: `5220${'33'.repeat(32)}`, value: 11_000 },
        ],
        txid,
      })),
    }

    await expect(getQbitAddressUtxos(client as any, address)).resolves.toEqual([
      {
        txid: matureTxid,
        vout: 1,
        satoshis: 42_000,
        scriptPk: `5220${'11'.repeat(32)}`,
        addressType: AddressType.P2MR,
      },
    ])
  })

  it('fetches tip height once when filtering multiple qbit coinbase UTXOs', async () => {
    const firstTxid = '10'.repeat(32)
    const secondTxid = '20'.repeat(32)
    const thirdTxid = '30'.repeat(32)
    const client = {
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid: firstTxid,
          vout: 0,
          value: 11_000,
          status: { confirmed: true, block_height: 1001 },
        },
        {
          txid: secondTxid,
          vout: 0,
          value: 22_000,
          status: { confirmed: true, block_height: 1002 },
        },
        {
          txid: thirdTxid,
          vout: 0,
          value: 33_000,
          status: { confirmed: true, block_height: 1003 },
        },
      ]),
      getTipHeight: vi.fn().mockResolvedValue(2002),
      getTx: vi.fn(async (txid: string) => ({
        vin: [{ is_coinbase: true }],
        vout: [
          {
            scriptpubkey: `5220${txid.slice(0, 64)}`,
            value: txid === firstTxid ? 11_000 : txid === secondTxid ? 22_000 : 33_000,
          },
        ],
        txid,
      })),
    }

    await expect(getQbitAddressUtxos(client as any, address)).resolves.toHaveLength(3)
    expect(client.getTipHeight).toHaveBeenCalledTimes(1)
  })

  it('excludes immature qbit coinbase UTXOs from available balance', async () => {
    const matureTxid = 'cc'.repeat(32)
    const immatureTxid = 'dd'.repeat(32)
    const client = {
      getAddressBalance: vi.fn().mockResolvedValue({
        address,
        confirmedSats: 67_000,
        mempoolSats: 0,
        totalSats: 67_000,
      }),
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid: immatureTxid,
          vout: 0,
          value: 25_000,
          status: { confirmed: true, block_height: 1501 },
        },
        {
          txid: matureTxid,
          vout: 1,
          value: 42_000,
          status: { confirmed: true, block_height: 1001 },
        },
      ]),
      getTipHeight: vi.fn().mockResolvedValue(2000),
      getTx: vi.fn(async (txid: string) => ({
        vin: [{ is_coinbase: true }],
        vout: [
          { scriptpubkey: `5220${'44'.repeat(32)}`, value: 25_000 },
          { scriptpubkey: `5220${'33'.repeat(32)}`, value: 42_000 },
        ],
        txid,
      })),
    }

    await expect(getQbitSpendableBalanceV2(client as any, address)).resolves.toEqual({
      availableBalance: 42_000,
      unavailableBalance: 25_000,
      totalBalance: 67_000,
      immatureBalance: 25_000,
      pendingBalance: 0,
    })
  })

  describe('an address over the explorer UTXO limit', () => {
    const overLimitStats = (unspent: number) => ({
      address,
      chain_stats: {
        funded_txo_count: unspent + 86,
        funded_txo_sum: (unspent + 86) * 1_000,
        spent_txo_count: 86,
        spent_txo_sum: 86_000,
        tx_count: unspent + 86,
      },
      mempool_stats: {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      },
    })
    const listingRefused = new QbitApiError('http', 'HTTP 500 from /utxo', {
      status: 500,
      url: `https://explorer.test/api/address/${address}/utxo`,
      responseBody: '{"error":"Failed to get address"}',
    })
    const clientFor = (unspent: number) => ({
      getAddressBalance: vi.fn().mockResolvedValue({
        address,
        confirmedSats: unspent * 1_000,
        mempoolSats: 0,
        totalSats: unspent * 1_000,
      }),
      getAddressStats: vi.fn().mockResolvedValue(overLimitStats(unspent)),
      getAddressUtxos: vi.fn().mockRejectedValue(listingRefused),
      getTipHeight: vi.fn(),
      getTx: vi.fn(),
    })

    it('reports the statistics total as unavailable instead of failing the balance', async () => {
      await expect(getQbitSpendableBalanceV2(clientFor(501) as any, address)).resolves.toEqual({
        availableBalance: 0,
        unavailableBalance: 501_000,
        totalBalance: 501_000,
        immatureBalance: 0,
        pendingBalance: 0,
        utxoLimitExceeded: true,
      })
    })

    it('counts confirmed outputs only, as electrs applies its limit before the mempool', async () => {
      const client = clientFor(550)
      const stats = overLimitStats(550)
      stats.mempool_stats = {
        funded_txo_count: 1,
        funded_txo_sum: 400_000,
        spent_txo_count: 106,
        spent_txo_sum: 106_000,
        tx_count: 1,
      }
      client.getAddressStats.mockResolvedValue(stats)
      await expect(getQbitSpendableBalanceV2(client as any, address)).resolves.toMatchObject({
        utxoLimitExceeded: true,
      })
    })

    it('keeps a 500 for an address within the limit an ordinary failure', async () => {
      await expect(getQbitSpendableBalanceV2(clientFor(500) as any, address)).rejects.toBe(
        listingRefused
      )
    })

    it('keeps the listing failure when the statistics fail as well', async () => {
      const client = clientFor(501)
      client.getAddressStats.mockRejectedValue(new Error('stats unavailable'))
      await expect(getQbitSpendableBalanceV2(client as any, address)).rejects.toBe(listingRefused)
    })

    it('does not treat a 500 from a per-output lookup as the limit', async () => {
      const client = clientFor(501)
      const lookupFailure = new QbitApiError('http', 'HTTP 500 from /tx', {
        status: 500,
        url: `https://explorer.test/api/tx/${'ab'.repeat(32)}`,
      })
      client.getAddressUtxos.mockRejectedValue(lookupFailure)
      await expect(getQbitSpendableBalanceV2(client as any, address)).rejects.toBe(lookupFailure)
      expect(client.getAddressStats).not.toHaveBeenCalled()
    })

    it('does not treat other listing failures as the limit', async () => {
      const client = clientFor(501)
      const timeout = new QbitApiError('timeout', 'request timed out')
      client.getAddressUtxos.mockRejectedValue(timeout)
      await expect(getQbitSpendableBalanceV2(client as any, address)).rejects.toBe(timeout)
      expect(client.getAddressStats).not.toHaveBeenCalled()
    })
  })

  it('classifies immature coinbase UTXOs separately from spendable ones', async () => {
    const matureTxid = 'cc'.repeat(32)
    const immatureTxid = 'dd'.repeat(32)
    const unconfirmedTxid = 'ee'.repeat(32)
    const client = {
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid: immatureTxid,
          vout: 0,
          value: 25_000,
          status: { confirmed: true, block_height: 1501 },
        },
        {
          txid: matureTxid,
          vout: 1,
          value: 42_000,
          status: { confirmed: true, block_height: 1001 },
        },
        {
          txid: unconfirmedTxid,
          vout: 2,
          value: 10_000,
          status: { confirmed: false },
        },
      ]),
      getTipHeight: vi.fn().mockResolvedValue(2000),
      getTx: vi.fn(async (txid: string) => ({
        vin: [{ is_coinbase: txid !== unconfirmedTxid }],
        vout: [
          { scriptpubkey: `5220${'44'.repeat(32)}`, value: 25_000 },
          { scriptpubkey: `5220${'33'.repeat(32)}`, value: 42_000 },
          { scriptpubkey: scriptPubKey, value: 10_000 },
        ],
        txid,
      })),
    }

    const classified = await getQbitAddressUtxosClassified(client as any, address)
    expect(classified.spendable.map(utxo => utxo.txid)).toEqual([matureTxid, unconfirmedTxid])
    expect(classified.confirmedSpendable.map(utxo => utxo.txid)).toEqual([matureTxid])
    expect(classified.unconfirmedSpendable.map(utxo => utxo.txid)).toEqual([unconfirmedTxid])
    expect(classified.immature.map(utxo => utxo.txid)).toEqual([immatureTxid])
    expect(classified.immature[0]!.satoshis).toBe(25_000)
  })

  it('keeps immature and unconfirmed policy-spendable funds in disjoint buckets', async () => {
    const immatureTxid = '12'.repeat(32)
    const unconfirmedTxid = '34'.repeat(32)
    const client = {
      getAddressBalance: vi.fn().mockResolvedValue({
        address,
        confirmedSats: 25_000,
        mempoolSats: 10_000,
        totalSats: 35_000,
      }),
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid: immatureTxid,
          vout: 0,
          value: 25_000,
          status: { confirmed: true, block_height: 1501 },
        },
        {
          txid: unconfirmedTxid,
          vout: 0,
          value: 10_000,
          status: { confirmed: false },
        },
      ]),
      getTipHeight: vi.fn().mockResolvedValue(2000),
      getTx: vi.fn(async (txid: string) => ({
        vin: [{ is_coinbase: txid === immatureTxid }],
        vout: [{ scriptpubkey: scriptPubKey, value: txid === immatureTxid ? 25_000 : 10_000 }],
        txid,
      })),
    }

    await expect(getQbitSpendableBalanceV2(client as any, address, scriptPubKey)).resolves.toEqual({
      availableBalance: 0,
      unavailableBalance: 35_000,
      totalBalance: 35_000,
      immatureBalance: 25_000,
      pendingBalance: 10_000,
    })
    // Neither bucket is selectable: the unconfirmed output is not change of
    // this script's own transaction.
    await expect(getQbitAddressUtxos(client as any, address)).resolves.toEqual([])
  })

  it('reports pending current-script funds without requiring an immature balance', async () => {
    const unconfirmedTxid = '56'.repeat(32)
    const client = {
      getAddressBalance: vi.fn().mockResolvedValue({
        address,
        confirmedSats: 0,
        mempoolSats: 10_000,
        totalSats: 10_000,
      }),
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid: unconfirmedTxid,
          vout: 0,
          value: 10_000,
          status: { confirmed: false },
        },
      ]),
      getTx: vi.fn().mockResolvedValue({
        txid: unconfirmedTxid,
        vin: [{ is_coinbase: false }],
        vout: [{ scriptpubkey: scriptPubKey, value: 10_000 }],
      }),
    }

    await expect(getQbitSpendableBalanceV2(client as any, address, scriptPubKey)).resolves.toEqual({
      availableBalance: 0,
      unavailableBalance: 10_000,
      totalBalance: 10_000,
      immatureBalance: 0,
      pendingBalance: 10_000,
    })
  })

  it.each([0, -5_000])(
    'counts own change as available, not pending, at %i net mempool sats',
    async mempoolSats => {
      const client = {
        getAddressBalance: vi.fn().mockResolvedValue({
          address,
          confirmedSats: 10_000 - mempoolSats,
          mempoolSats,
          totalSats: 10_000,
        }),
        getAddressUtxos: vi.fn().mockResolvedValue([
          {
            txid: '78'.repeat(32),
            vout: 0,
            value: 10_000,
            status: { confirmed: false },
          },
        ]),
        getTx: vi.fn(async (txid: string) =>
          txid === confirmedOwnParentTxid
            ? confirmedOwnParent
            : {
                txid: '78'.repeat(32),
                vin: [ownInput(10_000 - mempoolSats)],
                vout: [{ scriptpubkey: scriptPubKey, value: 10_000 }],
                status: { confirmed: false },
              }
        ),
      }

      await expect(
        getQbitSpendableBalanceV2(client as any, address, scriptPubKey)
      ).resolves.toEqual({
        availableBalance: 10_000,
        unavailableBalance: 0,
        totalBalance: 10_000,
        immatureBalance: 0,
        pendingBalance: 0,
      })
    }
  )

  describe('unconfirmed outputs a send may select (#279)', () => {
    const foreignScript = `5220${'99'.repeat(32)}`
    const confirmedTxid = 'c1'.repeat(32)
    const ownChangeTxid = 'c2'.repeat(32)
    const foreignTxid = 'c3'.repeat(32)
    const mixedTxid = 'c4'.repeat(32)
    const noPrevoutTxid = 'c5'.repeat(32)
    const txs: Record<string, { vin: unknown[]; value: number; status?: unknown }> = {
      [confirmedOwnParentTxid]: { ...confirmedOwnParent, value: 100_000 },
      [confirmedTxid]: { vin: [foreignInput(60_000)], value: 50_000 },
      [ownChangeTxid]: { vin: [ownInput(30_000), ownInput(5_000)], value: 20_000 },
      [foreignTxid]: { vin: [foreignInput(40_000)], value: 15_000 },
      [mixedTxid]: { vin: [ownInput(10_000), foreignInput(10_000)], value: 7_000 },
      [noPrevoutTxid]: { vin: [{ is_coinbase: false, prevout: null }], value: 3_000 },
    }

    function foreignInput(value: number) {
      return {
        txid: 'fe'.repeat(32),
        vout: 0,
        is_coinbase: false,
        prevout: { scriptpubkey: foreignScript, value },
      }
    }

    function client(mempoolSats: number) {
      // Explorer order lists the unconfirmed outputs first.
      const order = [foreignTxid, ownChangeTxid, mixedTxid, noPrevoutTxid, confirmedTxid]
      const total = order.reduce((sum, txid) => sum + txs[txid]!.value, 0)
      return {
        getAddressBalance: vi.fn().mockResolvedValue({
          address,
          confirmedSats: total - mempoolSats,
          mempoolSats,
          totalSats: total,
        }),
        getAddressUtxos: vi.fn().mockResolvedValue(
          order.map(txid => ({
            txid,
            vout: 0,
            value: txs[txid]!.value,
            status:
              txid === confirmedTxid ? { confirmed: true, block_height: 10 } : { confirmed: false },
          }))
        ),
        getTx: vi.fn(async (txid: string) => ({
          txid,
          vin: txs[txid]!.vin,
          vout: [{ scriptpubkey: scriptPubKey, value: txs[txid]!.value }],
          status: txs[txid]!.status ?? { confirmed: txid === confirmedTxid },
        })),
      }
    }

    it('selects confirmed outputs first, then own change, and leaves out everyone else’s', async () => {
      await expect(getQbitAddressUtxos(client(0) as any, address)).resolves.toEqual([
        expect.objectContaining({ txid: confirmedTxid, satoshis: 50_000 }),
        expect.objectContaining({ txid: ownChangeTxid, satoshis: 20_000 }),
      ])

      const classified = await getQbitAddressUtxosClassified(client(0) as any, address)
      expect(classified.unconfirmedOwnChange.map(utxo => utxo.txid)).toEqual([ownChangeTxid])
      // The recovery sweep still sees every unconfirmed output.
      expect(classified.unconfirmedSpendable.map(utxo => utxo.txid)).toEqual([
        foreignTxid,
        ownChangeTxid,
        mixedTxid,
        noPrevoutTxid,
      ])
    })

    it('reports the selectable outputs as Available and the rest of the unconfirmed value as Pending', async () => {
      const balance = await getQbitSpendableBalanceV2(client(-25_000) as any, address, scriptPubKey)
      const selectable = await getQbitAddressUtxos(client(-25_000) as any, address)

      expect(balance).toEqual({
        availableBalance: 70_000,
        unavailableBalance: 25_000,
        totalBalance: 95_000,
        immatureBalance: 0,
        pendingBalance: 25_000,
      })
      expect(selectable.reduce((sum, utxo) => sum + utxo.satoshis, 0)).toBe(
        balance.availableBalance
      )
    })
  })

  describe('ancestry of own unconfirmed change (#279)', () => {
    const foreignScript = `5220${'98'.repeat(32)}`
    const txidAt = (index: number) => index.toString(16).padStart(2, '0').repeat(32)

    /** Unconfirmed `txids[i]` spends output 0 of `txids[i - 1]`; the first spends `root`. */
    function chainClient(length: number, root = confirmedOwnParentTxid) {
      const txids = Array.from({ length }, (_, index) => txidAt(index + 16))
      const byTxid = new Map<string, unknown>([[confirmedOwnParentTxid, confirmedOwnParent]])
      txids.forEach((txid, index) => {
        byTxid.set(txid, {
          txid,
          vin: [ownInput(10_000, index === 0 ? root : txids[index - 1])],
          vout: [{ scriptpubkey: scriptPubKey, value: 9_000 }],
          status: { confirmed: false },
        })
      })
      const tip = txids.at(-1)!
      return {
        tip,
        byTxid,
        client: {
          getAddressUtxos: vi
            .fn()
            .mockResolvedValue([
              { txid: tip, vout: 0, value: 9_000, status: { confirmed: false } },
            ]),
          getTx: vi.fn(async (txid: string) => {
            const tx = byTxid.get(txid)
            if (!tx) throw new QbitApiError('not_found', 'transaction not found', { status: 404 })
            return tx
          }),
        },
      }
    }

    it('leaves out change of a transaction that spent an unconfirmed payment from someone else', async () => {
      const { client, byTxid } = chainClient(1, 'fa'.repeat(32))
      // Someone else's unconfirmed payment to this script, which its payer can replace.
      byTxid.set('fa'.repeat(32), {
        txid: 'fa'.repeat(32),
        vin: [
          {
            txid: 'fb'.repeat(32),
            vout: 0,
            is_coinbase: false,
            prevout: { scriptpubkey: foreignScript, value: 20_000 },
          },
        ],
        vout: [{ scriptpubkey: scriptPubKey, value: 10_000 }],
        status: { confirmed: false },
      })

      await expect(getQbitAddressUtxos(client as any, address)).resolves.toEqual([])
    })

    it('selects change on a chain of own transactions only while a spend fits the ancestor limit', async () => {
      // 24 unconfirmed ancestors plus the new send is qbit Core's limit of 25.
      const fits = chainClient(24)
      await expect(getQbitAddressUtxos(fits.client as any, address)).resolves.toEqual([
        expect.objectContaining({ txid: fits.tip }),
      ])

      const tooLong = chainClient(25)
      await expect(getQbitAddressUtxos(tooLong.client as any, address)).resolves.toEqual([])
      // The walk stops at the limit instead of fetching the whole chain.
      expect(tooLong.client.getTx.mock.calls.length).toBeLessThanOrEqual(26)
    })

    it('leaves out change whose ancestor the explorer no longer has or describes malformed', async () => {
      const missing = chainClient(2)
      missing.byTxid.delete(txidAt(16))
      await expect(getQbitAddressUtxos(missing.client as any, address)).resolves.toEqual([])

      const malformed = chainClient(2)
      malformed.byTxid.set(txidAt(16), { txid: txidAt(16), vin: 'nope', status: {} })
      await expect(getQbitAddressUtxos(malformed.client as any, address)).resolves.toEqual([])
    })

    it('leaves out change whose ancestor the explorer cannot answer for, keeping the rest readable', async () => {
      const { client, byTxid, tip } = chainClient(2)
      byTxid.set('d9'.repeat(32), {
        txid: 'd9'.repeat(32),
        vin: [ownInput(60_000)],
        vout: [{ scriptpubkey: scriptPubKey, value: 50_000 }],
        status: { confirmed: true, block_height: 10 },
      })
      client.getAddressUtxos.mockResolvedValue([
        { txid: tip, vout: 0, value: 9_000, status: { confirmed: false } },
        {
          txid: 'd9'.repeat(32),
          vout: 0,
          value: 50_000,
          status: { confirmed: true, block_height: 10 },
        },
      ])
      const getTx = client.getTx.getMockImplementation()!
      client.getTx.mockImplementation(async (txid: string) => {
        if (txid === txidAt(16)) throw new QbitApiError('network', 'offline')
        return getTx(txid)
      })

      await expect(getQbitAddressUtxos(client as any, address)).resolves.toEqual([
        expect.objectContaining({ txid: 'd9'.repeat(32) }),
      ])
    })

    it('budgets the ancestors of all selectable change together, since a send may spend them all', async () => {
      // Two separate chains of 15 unconfirmed own transactions each: either
      // alone leaves room under the limit, both together would not.
      const chainOf = (first: number) =>
        Array.from({ length: 15 }, (_, index) => txidAt(first + index))
      const chains = [chainOf(48), chainOf(96)]
      const byTxid = new Map<string, unknown>([[confirmedOwnParentTxid, confirmedOwnParent]])
      for (const txids of chains) {
        txids.forEach((txid, index) => {
          byTxid.set(txid, {
            txid,
            vin: [ownInput(10_000, index === 0 ? confirmedOwnParentTxid : txids[index - 1])],
            vout: [{ scriptpubkey: scriptPubKey, value: 9_000 }],
            status: { confirmed: false },
          })
        })
      }
      const client = {
        getAddressUtxos: vi.fn().mockResolvedValue(
          chains.map(txids => ({
            txid: txids.at(-1)!,
            vout: 0,
            value: 9_000,
            status: { confirmed: false },
          }))
        ),
        getTx: vi.fn(async (txid: string) => byTxid.get(txid)),
      }

      await expect(getQbitAddressUtxos(client as any, address)).resolves.toEqual([
        expect.objectContaining({ txid: chains[0]!.at(-1) }),
      ])
    })
  })

  it('keeps confirmed other-script funds unavailable without labeling them pending', async () => {
    const matchingScript = `5220${'66'.repeat(32)}`
    const otherScript = `5220${'77'.repeat(32)}`
    const client = {
      getAddressBalance: vi.fn().mockResolvedValue({
        address,
        confirmedSats: 75_000,
        mempoolSats: 0,
        totalSats: 75_000,
      }),
      getAddressUtxos: vi.fn().mockResolvedValue([
        {
          txid: 'ee'.repeat(32),
          vout: 0,
          value: 25_000,
          status: { confirmed: true, block_height: 50 },
        },
        {
          txid: 'ff'.repeat(32),
          vout: 1,
          value: 50_000,
          status: { confirmed: true, block_height: 50 },
        },
      ]),
      getTx: vi.fn(async (txid: string) => ({
        vin: [{ is_coinbase: false }],
        vout: [
          { scriptpubkey: otherScript, value: 25_000 },
          { scriptpubkey: matchingScript, value: 50_000 },
        ],
        txid,
      })),
    }

    await expect(
      getQbitSpendableBalanceV2(client as any, address, matchingScript)
    ).resolves.toEqual({
      availableBalance: 50_000,
      unavailableBalance: 25_000,
      totalBalance: 75_000,
      immatureBalance: 0,
      pendingBalance: 0,
    })
  })

  it('maps qbit transactions into existing history shape', () => {
    const tx = {
      txid: 'bb'.repeat(32),
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: 'aa'.repeat(32),
          vout: 0,
          prevout: {
            scriptpubkey: '51',
            scriptpubkey_asm: '',
            scriptpubkey_type: 'v2_p2mr',
            scriptpubkey_address: address,
            value: 50_000,
          },
          scriptsig: '',
          scriptsig_asm: '',
          is_coinbase: false,
          sequence: 0xfffffffd,
        },
      ],
      vout: [
        {
          scriptpubkey: '51',
          scriptpubkey_asm: '',
          scriptpubkey_type: 'v2_p2mr',
          scriptpubkey_address: 'qbrt1zrecipient',
          value: 40_000,
        },
      ],
      size: 4000,
      weight: 4000,
      fee: 10_000,
      status: { confirmed: true, block_height: 7, block_time: 123 },
    }

    expect(qbitTxToHistoryItem(tx, address, 10)).toMatchObject({
      txid: 'bb'.repeat(32),
      confirmations: 4,
      height: 7,
      timestamp: 123,
      size: 4000,
      feeRate: 2.5,
      fee: 10_000,
      outputValue: 40_000,
      vin: [{ address, value: 50_000 }],
      vout: [{ address: 'qbrt1zrecipient', value: 40_000 }],
      // Confirmed txs are never replaceable, even with a BIP125 sequence.
      replaceable: false,
    })
  })

  it('derives BIP125 replaceability from vin sequences for unconfirmed txs', () => {
    const txWithSequences = (sequences: number[], confirmed: boolean) => ({
      txid: 'bb'.repeat(32),
      version: 2,
      locktime: 0,
      vin: sequences.map(sequence => ({
        txid: 'aa'.repeat(32),
        vout: 0,
        prevout: {
          scriptpubkey: '51',
          scriptpubkey_asm: 'OP_PUSHNUM_1',
          scriptpubkey_type: 'v2_p2mr',
          scriptpubkey_address: externalAddress,
          value: 1,
        },
        scriptsig: '',
        scriptsig_asm: '',
        is_coinbase: false,
        sequence,
      })),
      vout: [],
      size: 100,
      weight: 100,
      fee: 10,
      status: confirmed
        ? { confirmed: true, block_height: 7, block_time: 123 }
        : { confirmed: false },
    })

    // Unconfirmed with a signaling sequence (< 0xfffffffe) is replaceable.
    expect(qbitTxToHistoryItem(txWithSequences([0xfffffffd], false), address, 10).replaceable).toBe(
      true
    )
    // One signaling input among final inputs is enough.
    expect(
      qbitTxToHistoryItem(txWithSequences([0xffffffff, 0xfffffffd], false), address, 10).replaceable
    ).toBe(true)
    // 0xfffffffe and the max sequence do not signal.
    expect(qbitTxToHistoryItem(txWithSequences([0xfffffffe], false), address, 10).replaceable).toBe(
      false
    )
    expect(qbitTxToHistoryItem(txWithSequences([0xffffffff], false), address, 10).replaceable).toBe(
      false
    )
    // A confirmed tx is never replaceable regardless of its sequences.
    expect(qbitTxToHistoryItem(txWithSequences([0xfffffffd], true), address, 10).replaceable).toBe(
      false
    )
  })

  it('aggregates multiple account addresses, globally deduplicates txids and sorts newest first', async () => {
    const sharedTx = accountHistoryTx({
      txid: '22'.repeat(32),
      inputs: [{ address, value: 50_000 }],
      outputs: [
        { address: secondAddress, value: 40_000 },
        { address: externalAddress, value: 9_990 },
      ],
      blockHeight: 8,
    })
    const newerTx = accountHistoryTx({
      txid: '11'.repeat(32),
      inputs: [{ address: externalAddress, value: 20_010 }],
      outputs: [{ address: secondAddress, value: 20_000 }],
      blockHeight: 9,
    })
    const client = accountHistoryClient({
      [address]: { confirmed: [sharedTx], mempool: [] },
      [secondAddress]: { confirmed: [newerTx, sharedTx], mempool: [] },
    })

    await expect(
      getQbitAccountHistory(client as any, [address, secondAddress], {
        start: 0,
        limit: 20,
      })
    ).resolves.toMatchObject({
      total: 2,
      detail: [
        { txid: '11'.repeat(32), direction: 'receive', amount: 20_000 },
        { txid: '22'.repeat(32), direction: 'send', amount: 9_990 },
      ],
    })
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('bounds every per-address phase of a large full account history scan', async () => {
    const addresses = Array.from({ length: 17 }, (_, index) => `${address}-full-scan-${index}`)
    const parentTxid = '70'.repeat(32)
    const transaction = accountHistoryTx({
      txid: '71'.repeat(32),
      inputs: [{ txid: parentTxid, vout: 0, missingPrevout: true }],
      outputs: [{ address: addresses[0], value: 90 }],
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: [{ address: externalAddress, value: 100 }],
    })
    const histories: Record<string, { confirmed: any[]; mempool: any[] }> = Object.fromEntries(
      addresses.map(itemAddress => [
        itemAddress,
        {
          confirmed: itemAddress === addresses[0] ? [transaction] : [],
          mempool: [],
        },
      ])
    )
    type AddressRequest = 'stats' | 'history' | 'mempool' | 'recent'
    const activeRequests: Record<AddressRequest, number> = {
      stats: 0,
      history: 0,
      mempool: 0,
      recent: 0,
    }
    const maximumActiveRequests: Record<AddressRequest, number> = {
      stats: 0,
      history: 0,
      mempool: 0,
      recent: 0,
    }
    const tracked = async <T>(request: AddressRequest, value: T): Promise<T> => {
      activeRequests[request] += 1
      maximumActiveRequests[request] = Math.max(
        maximumActiveRequests[request],
        activeRequests[request]
      )
      await Promise.resolve()
      activeRequests[request] -= 1
      return value
    }
    const statsFor = (itemAddress: string) => {
      const history = histories[itemAddress]!
      return {
        address: itemAddress,
        chain_stats: {
          funded_txo_count: history.confirmed.length,
          funded_txo_sum: history.confirmed.length,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: history.confirmed.length,
        },
        mempool_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 0,
        },
      }
    }
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getTipHeight: vi.fn().mockResolvedValue(10),
      getAddressStats: vi.fn((itemAddress: string) => tracked('stats', statsFor(itemAddress))),
      getAddressHistory: vi.fn((itemAddress: string) => tracked('history', histories[itemAddress])),
      getAddressMempoolTxs: vi.fn(() => tracked('mempool', [])),
      getAddressTxs: vi.fn((itemAddress: string) =>
        tracked('recent', histories[itemAddress]?.confirmed ?? [])
      ),
      getTx: vi.fn().mockResolvedValue(parent),
    }

    await expect(
      getQbitAccountHistory(client as any, addresses, { start: 0, limit: 20 })
    ).resolves.toMatchObject({
      total: 1,
      detail: [{ txid: transaction.txid, direction: 'receive', amount: 90 }],
    })

    expect(maximumActiveRequests).toEqual({
      stats: 8,
      history: 8,
      mempool: 8,
      recent: 8,
    })
    expect(client.getAddressStats).toHaveBeenCalledTimes(addresses.length * 3)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(addresses.length)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledTimes(addresses.length * 2)
    expect(client.getAddressTxs).toHaveBeenCalledTimes(addresses.length)
    expect(client.getAddressStats.mock.calls.map(([itemAddress]) => itemAddress)).toEqual([
      ...addresses,
      ...addresses,
      ...addresses,
    ])
    expect(client.getAddressHistory.mock.calls.map(([itemAddress]) => itemAddress)).toEqual(
      addresses
    )
    expect(client.getAddressMempoolTxs.mock.calls.map(([itemAddress]) => itemAddress)).toEqual([
      ...addresses,
      ...addresses,
    ])
    expect(client.getAddressTxs.mock.calls.map(([itemAddress]) => itemAddress)).toEqual(addresses)
    expect(client.getTx).toHaveBeenCalledOnce()
  })

  it('returns a revision comparable to a later stable lightweight account probe', async () => {
    const firstTx = accountHistoryTx({
      txid: '71'.repeat(32),
      inputs: [{ address: externalAddress, value: 101 }],
      outputs: [{ address, value: 91 }],
      blockHeight: 8,
    })
    const secondTx = accountHistoryTx({
      txid: '72'.repeat(32),
      inputs: [{ address: externalAddress, value: 101 }],
      outputs: [{ address: secondAddress, value: 91 }],
      blockHeight: 7,
    })
    const client = accountHistoryClient({
      [address]: { confirmed: [firstTx], mempool: [] },
      [secondAddress]: { confirmed: [secondTx], mempool: [] },
    })

    const full = await getQbitAccountHistory(client as any, [address, secondAddress], {
      start: 0,
      limit: 20,
    })
    client.getTipHeight.mockResolvedValue(11)
    const probed = await probeQbitAccountHistoryRevision(client as any, [address, secondAddress])

    expect(probed).toEqual({
      activityFingerprint: full.revision.activityFingerprint,
      tipHeight: 11,
      tipHash,
      hasConfirmedHistory: true,
    })
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
    expect(client.getAddressTxs).toHaveBeenCalledTimes(6)
  })

  it('bounds lightweight revision request concurrency while checking every address twice', async () => {
    const addresses = Array.from({ length: 12 }, (_, index) => `${address}-${index}`)
    let activeRequests = 0
    let maximumActiveRequests = 0
    const tracked = async <T>(value: T): Promise<T> => {
      activeRequests += 1
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
      await Promise.resolve()
      activeRequests -= 1
      return value
    }
    const client = {
      getTipHash: vi.fn().mockResolvedValue(tipHash),
      getTipHeight: vi.fn().mockResolvedValue(10),
      getAddressStats: vi.fn((itemAddress: string) =>
        tracked({
          address: itemAddress,
          chain_stats: {
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 0,
          },
          mempool_stats: {
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 0,
          },
        })
      ),
      getAddressMempoolTxs: vi.fn(() => tracked([])),
      getAddressTxs: vi.fn(() => tracked([])),
    }

    await expect(probeQbitAccountHistoryRevision(client as any, addresses)).resolves.toMatchObject({
      tipHeight: 10,
    })

    expect(maximumActiveRequests).toBe(8)
    expect(client.getAddressStats).toHaveBeenCalledTimes(addresses.length * 2)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledTimes(addresses.length * 2)
    expect(client.getAddressTxs).toHaveBeenCalledTimes(addresses.length * 2)
    for (const itemAddress of addresses) {
      expect(client.getAddressStats).toHaveBeenCalledWith(itemAddress)
      expect(client.getAddressMempoolTxs).toHaveBeenCalledWith(itemAddress)
      expect(client.getAddressTxs).toHaveBeenCalledWith(itemAddress)
    }
  })

  it('rejects oversized lightweight revision probes before making network requests', async () => {
    const addresses = Array.from(
      { length: MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES + 1 },
      (_, index) => `${address}-${index}`
    )
    const client = {
      getTipHash: vi.fn(),
      getTipHeight: vi.fn(),
      getAddressStats: vi.fn(),
      getAddressMempoolTxs: vi.fn(),
      getAddressTxs: vi.fn(),
    }

    await expect(probeQbitAccountHistoryRevision(client as any, addresses)).rejects.toThrow(
      `exceeds the ${MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES}-address limit`
    )
    expect(client.getTipHash).not.toHaveBeenCalled()
    expect(client.getTipHeight).not.toHaveBeenCalled()
    expect(client.getAddressStats).not.toHaveBeenCalled()
    expect(client.getAddressMempoolTxs).not.toHaveBeenCalled()
    expect(client.getAddressTxs).not.toHaveBeenCalled()
  })

  it('changes the lightweight revision when a recent confirmed identity changes', async () => {
    const original = accountHistoryTx({
      txid: '73'.repeat(32),
      inputs: [{ address: externalAddress, value: 101 }],
      outputs: [{ address, value: 91 }],
      blockHeight: 8,
    })
    const replacement = {
      ...original,
      txid: '74'.repeat(32),
    }
    const client = accountHistoryClient({
      [address]: { confirmed: [original], mempool: [] },
    })
    const baseline = await probeQbitAccountHistoryRevision(client as any, [address])
    client.getAddressTxs.mockResolvedValue([replacement])

    const changed = await probeQbitAccountHistoryRevision(client as any, [address])

    expect(changed.activityFingerprint).not.toBe(baseline.activityFingerprint)
  })

  it('rejects oversized reported per-address histories before downloading them', async () => {
    const getAddressHistory = vi.fn()
    const client = accountHistoryClient(
      { [address]: { confirmed: [], mempool: [] } },
      {
        getAddressStats: vi.fn().mockResolvedValue(historyStats(2, 1)),
        getAddressHistory,
      }
    )

    await expect(
      getQbitAccountHistory(
        client as any,
        [address],
        { start: 0, limit: 20 },
        { maxTransactions: 2 }
      )
    ).rejects.toThrow(`qbit address history exceeds the 2-transaction limit for ${address}`)
    expect(getAddressHistory).not.toHaveBeenCalled()
  })

  it('rejects oversized aggregate reported histories before downloading them', async () => {
    const thirdAddress = `${address}-third`
    const getAddressHistory = vi.fn()
    const client = accountHistoryClient(
      {
        [address]: { confirmed: [], mempool: [] },
        [secondAddress]: { confirmed: [], mempool: [] },
        [thirdAddress]: { confirmed: [], mempool: [] },
      },
      {
        getAddressStats: vi.fn(async (itemAddress: string) => ({
          ...historyStats(2),
          address: itemAddress,
        })),
        getAddressHistory,
      }
    )

    await expect(
      getQbitAccountHistory(
        client as any,
        [address, secondAddress, thirdAddress],
        { start: 0, limit: 20 },
        { maxTransactions: 2 }
      )
    ).rejects.toThrow('qbit account history exceeds the aggregate 4-row limit')
    expect(getAddressHistory).not.toHaveBeenCalled()
  })

  it('rejects malformed or status-inconsistent recent revision payloads', async () => {
    const confirmed = accountHistoryTx({
      txid: '75'.repeat(32),
      inputs: [{ address: externalAddress, value: 101 }],
      outputs: [{ address, value: 91 }],
      blockHeight: 8,
    })
    const client = accountHistoryClient({
      [address]: { confirmed: [confirmed], mempool: [] },
    })
    client.getAddressTxs.mockResolvedValue([{ ...confirmed, status: { confirmed: false } }])

    await expect(probeQbitAccountHistoryRevision(client as any, [address])).rejects.toThrow(
      `unconfirmed transaction returned in recent qbit history for ${address}`
    )
  })

  it('rejects a shortened nonempty recent confirmed revision window', async () => {
    const confirmed = [
      accountHistoryTx({
        txid: '76'.repeat(32),
        inputs: [{ address: externalAddress, value: 101 }],
        outputs: [{ address, value: 91 }],
        blockHeight: 8,
      }),
      accountHistoryTx({
        txid: '77'.repeat(32),
        inputs: [{ address: externalAddress, value: 101 }],
        outputs: [{ address, value: 91 }],
        blockHeight: 7,
      }),
    ]
    const client = accountHistoryClient({
      [address]: { confirmed, mempool: [] },
    })
    client.getAddressTxs.mockResolvedValue([confirmed[0]])

    await expect(probeQbitAccountHistoryRevision(client as any, [address])).rejects.toThrow(
      `invalid recent qbit confirmed history window for ${address}`
    )
  })

  it('allows bounded duplicate overlap while counting normalized unique txids at the limit', async () => {
    const sharedTx = accountHistoryTx({
      txid: 'ab'.repeat(32),
      inputs: [{ address: externalAddress, value: 101 }],
      outputs: [
        { address, value: 45 },
        { address: secondAddress, value: 46 },
      ],
    })
    const addressTx = accountHistoryTx({
      txid: '31'.repeat(32),
      inputs: [{ address: externalAddress, value: 91 }],
      outputs: [{ address, value: 81 }],
    })
    const client = accountHistoryClient({
      [address]: { confirmed: [addressTx, sharedTx], mempool: [] },
      [secondAddress]: {
        confirmed: [{ ...sharedTx, txid: sharedTx.txid.toUpperCase() }],
        mempool: [],
      },
    })

    await expect(
      getQbitAccountHistory(
        client as any,
        [address, secondAddress],
        { start: 0, limit: 20 },
        { maxTransactions: 2 }
      )
    ).resolves.toMatchObject({
      total: 2,
      detail: [{ txid: addressTx.txid }, { txid: sharedTx.txid }],
    })
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('rejects account history when normalized unique txids exceed the limit', async () => {
    const sharedTx = accountHistoryTx({
      txid: 'ab'.repeat(32),
      inputs: [{ address: externalAddress, value: 101 }],
      outputs: [
        { address, value: 45 },
        { address: secondAddress, value: 46 },
      ],
    })
    const addressTx = accountHistoryTx({
      txid: '31'.repeat(32),
      inputs: [{ address: externalAddress, value: 91 }],
      outputs: [{ address, value: 81 }],
    })
    const secondAddressTx = accountHistoryTx({
      txid: '32'.repeat(32),
      inputs: [{ address: externalAddress, value: 71 }],
      outputs: [{ address: secondAddress, value: 61 }],
    })
    const client = accountHistoryClient({
      [address]: { confirmed: [addressTx, sharedTx], mempool: [] },
      [secondAddress]: {
        confirmed: [{ ...sharedTx, txid: sharedTx.txid.toUpperCase() }, secondAddressTx],
        mempool: [],
      },
    })

    await expect(
      getQbitAccountHistory(
        client as any,
        [address, secondAddress],
        { start: 0, limit: 20 },
        { maxTransactions: 2 }
      )
    ).rejects.toThrow('qbit account history exceeds the 2-transaction limit')
  })

  it('keeps globally unique totals and page boundaries when a duplicate crosses addresses', async () => {
    const txs = [5, 4, 3, 2, 1].map(height =>
      accountHistoryTx({
        txid: height.toString(16).repeat(64),
        inputs: [{ address: externalAddress, value: 101 }],
        outputs:
          height === 3
            ? [
                { address, value: 45 },
                { address: secondAddress, value: 46 },
              ]
            : [{ address, value: 91 }],
        blockHeight: height,
        blockTime: height,
      })
    )
    const duplicate = txs[2]!
    const histories = {
      [address]: { confirmed: [txs[0], txs[1], duplicate, txs[3], txs[4]], mempool: [] },
      [secondAddress]: { confirmed: [duplicate], mempool: [] },
    }
    const firstPage = await getQbitAccountHistory(
      accountHistoryClient(histories) as any,
      [address, secondAddress],
      { start: 0, limit: 3 }
    )
    const secondPage = await getQbitAccountHistory(
      accountHistoryClient(histories) as any,
      [address, secondAddress],
      { start: 3, limit: 3 }
    )

    expect(firstPage.total).toBe(5)
    expect(secondPage.total).toBe(5)
    expect([
      ...firstPage.detail.map(item => item.txid),
      ...secondPage.detail.map(item => item.txid),
    ]).toEqual(txs.map(tx => tx.txid))
  })

  it('classifies receipt to a non-active owned address against the whole account', async () => {
    const tx = accountHistoryTx({
      inputs: [{ address: externalAddress, value: 50_010 }],
      outputs: [{ address: secondAddress, value: 50_000 }],
    })

    expect(qbitTxToHistoryItem(tx, [address, secondAddress], 10)).toMatchObject({
      direction: 'receive',
      amount: 50_000,
      netAmount: 50_000,
      counterparties: [externalAddress],
      vout: [{ address: secondAddress, owned: true }],
    })
  })

  it('classifies net-positive mixed funding as a receipt without labeling it self', () => {
    const tx = accountHistoryTx({
      inputs: [
        { address, value: 40_000 },
        { address: externalAddress, value: 20_010 },
      ],
      outputs: [{ address: secondAddress, value: 60_000 }],
    })

    const item = qbitTxToHistoryItem(tx, [address, secondAddress], 10)
    expect(item).toMatchObject({
      direction: 'receive',
      amount: 20_000,
      netAmount: 20_000,
      ownedInputValue: 40_000,
      ownedOutputValue: 60_000,
      counterparties: [externalAddress],
      vin: [{ owned: true }, { owned: false }],
      vout: [{ owned: true }],
    })
    expect(item.vin.every(input => input.internal === undefined)).toBe(true)
    expect(item.vout.every(output => output.internal === undefined)).toBe(true)
    expect(item.vout.every(output => output.change === undefined)).toBe(true)
  })

  it('classifies net-negative mixed funding by account delta without inventing a recipient', () => {
    const tx = accountHistoryTx({
      inputs: [
        { address, value: 50_000 },
        { address: externalAddress, value: 5 },
      ],
      outputs: [{ address: secondAddress, value: 49_995 }],
    })

    const item = qbitTxToHistoryItem(tx, [address, secondAddress], 10)
    expect(item).toMatchObject({
      direction: 'send',
      amount: 5,
      netAmount: -5,
      ownedInputValue: 50_000,
      ownedOutputValue: 49_995,
      counterparties: [externalAddress],
      vin: [{ owned: true }, { owned: false }],
      vout: [{ owned: true }],
    })
    expect(item.vin.every(input => input.internal === undefined)).toBe(true)
    expect(item.vout.every(output => output.internal === undefined)).toBe(true)
    expect(item.vout.every(output => output.change === undefined)).toBe(true)
  })

  it('uses the non-debit direction for zero-net mixed funding and keeps all external participants', () => {
    const tx = accountHistoryTx({
      inputs: [
        { address, value: 50_000 },
        { address: externalAddress, value: 20_010 },
      ],
      outputs: [
        { address: secondAddress, value: 50_000 },
        { address: externalOutputAddress, value: 20_000 },
      ],
    })

    const item = qbitTxToHistoryItem(tx, [address, secondAddress], 10)
    expect(item).toMatchObject({
      direction: 'receive',
      amount: 0,
      netAmount: 0,
      ownedInputValue: 50_000,
      ownedOutputValue: 50_000,
      counterparties: [externalAddress, externalOutputAddress],
      vin: [{ owned: true }, { owned: false }],
      vout: [{ owned: true }, { owned: false }],
    })
    expect(item.vin.every(input => input.internal === undefined)).toBe(true)
    expect(item.vout.every(output => output.internal === undefined)).toBe(true)
    expect(item.vout.every(output => output.change === undefined)).toBe(true)
  })

  it('does not infer change for a mixed send to another owned derived address', () => {
    const tx = accountHistoryTx({
      inputs: [{ address, value: 100_000 }],
      outputs: [
        { address: externalAddress, value: 60_000 },
        { address: secondAddress, value: 39_990 },
      ],
    })

    const item = qbitTxToHistoryItem(tx, [address, secondAddress], 10)
    expect(item).toMatchObject({
      direction: 'send',
      amount: 60_000,
      netAmount: -60_010,
      counterparties: [externalAddress],
      vout: [
        { address: externalAddress, owned: false },
        { address: secondAddress, owned: true },
      ],
    })
    expect(item.vout[1]?.change).toBeUndefined()
  })

  it('classifies a cross-address self transfer without forcing send or receive', () => {
    const tx = accountHistoryTx({
      inputs: [
        { address, value: 40_000 },
        { address: secondAddress, value: 20_000 },
      ],
      outputs: [{ address: secondAddress, value: 59_990 }],
    })

    expect(qbitTxToHistoryItem(tx, [address, secondAddress], 10)).toMatchObject({
      direction: 'self',
      amount: 59_990,
      netAmount: -10,
      counterparties: [secondAddress],
      vin: [
        { owned: true, internal: true },
        { owned: true, internal: true },
      ],
      vout: [{ owned: true, internal: true }],
    })
  })

  it('classifies an owned spend with a zero-value OP_RETURN as an addressless send', () => {
    const tx = accountHistoryTx({
      inputs: [{ address, value: 100 }],
      outputs: [
        { address, value: 90 },
        { value: 0, scriptType: 'op_return' },
      ],
    })

    const item = qbitTxToHistoryItem(tx, address, 10)
    expect(item).toMatchObject({
      direction: 'send',
      amount: 0,
      netAmount: -10,
      counterparties: [],
      vout: [
        { address, value: 90, owned: true },
        { value: 0, scriptType: 'op_return', owned: false },
      ],
    })
    expect(item.vin.every(input => input.internal === undefined)).toBe(true)
    expect(item.vout.every(output => output.internal === undefined)).toBe(true)
    expect(item.vout[1]?.address).toBeUndefined()
  })

  it('resolves an owned missing prevout before classifying a send', async () => {
    const parentTxid = '91'.repeat(32)
    const tx = accountHistoryTx({
      txid: '92'.repeat(32),
      inputs: [{ txid: parentTxid, vout: 0, missingPrevout: true }],
      outputs: [
        { address: externalAddress, value: 60_000 },
        { address, value: 39_990 },
      ],
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: [{ address, value: 100_000 }],
    })
    const getTx = vi.fn().mockResolvedValue(parent)
    const client = accountHistoryClient(
      { [address]: { confirmed: [tx], mempool: [] } },
      { getTx }
    )

    const item = (
      await getQbitAccountHistory(client as any, [address], { start: 0, limit: 20 })
    ).detail[0]!

    expect(item).toMatchObject({
      direction: 'send',
      amount: 60_000,
      netAmount: -60_010,
      ownedInputValue: 100_000,
      ownedOutputValue: 39_990,
      counterparties: [externalAddress],
      vin: [
        {
          address,
          value: 100_000,
          owned: true,
          prevoutMissing: false,
        },
      ],
      vout: [
        { address: externalAddress, owned: false },
        { address, owned: true },
      ],
    })
    expect(item.vout[1]?.change).toBeUndefined()
    expect(getTx).toHaveBeenCalledTimes(1)
    expect(getTx).toHaveBeenCalledWith(parentTxid)
  })

  it('resolves an external missing prevout without blanket-classifying a batch receipt as send', async () => {
    const parentTxid = '93'.repeat(32)
    const tx = accountHistoryTx({
      txid: '94'.repeat(32),
      inputs: [{ txid: parentTxid, vout: 0, missingPrevout: true }],
      outputs: [
        { address, value: 50_000 },
        { address: secondAddress, value: 20_000 },
      ],
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: [{ address: externalAddress, value: 70_010 }],
    })
    const getTx = vi.fn().mockResolvedValue(parent)
    const client = accountHistoryClient(
      { [address]: { confirmed: [tx], mempool: [] } },
      { getTx }
    )

    await expect(
      getQbitAccountHistory(client as any, [address], { start: 0, limit: 20 })
    ).resolves.toMatchObject({
      detail: [
        {
          direction: 'receive',
          amount: 50_000,
          netAmount: 50_000,
          counterparties: [externalAddress],
          vin: [
            {
              address: externalAddress,
              value: 70_010,
              owned: false,
              prevoutMissing: false,
            },
          ],
        },
      ],
    })
  })

  it('retries and rejects a tip change during missing-prevout hydration', async () => {
    const parentTxid = 'a1'.repeat(32)
    const tx = accountHistoryTx({
      txid: 'a2'.repeat(32),
      inputs: [{ txid: parentTxid, missingPrevout: true }],
      outputs: [{ address, value: 50_000 }],
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: [{ address: externalAddress, value: 50_010 }],
    })
    const driftedTipHashes = ['bb'.repeat(32), 'cc'.repeat(32)]
    let currentTipHash = tipHash
    let hydrationCount = 0
    const getTx = vi.fn(async () => {
      currentTipHash = driftedTipHashes[hydrationCount++]!
      return parent
    })
    const client = accountHistoryClient(
      { [address]: { confirmed: [tx], mempool: [] } },
      {
        getTipHash: vi.fn(async () => currentTipHash),
        getTx,
      }
    )

    await expect(
      getQbitAccountHistory(
        client as any,
        [address],
        { start: 0, limit: 20 },
        { stabilityRetries: 1, retryBaseDelayMs: 0 }
      )
    ).rejects.toThrow('qbit account history changed while resolving prevouts')
    expect(getTx).toHaveBeenCalledTimes(2)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('rejects drift in any requested address stats during missing-prevout hydration', async () => {
    const parentTxid = 'a3'.repeat(32)
    const tx = accountHistoryTx({
      txid: 'a4'.repeat(32),
      inputs: [{ txid: parentTxid, missingPrevout: true }],
      outputs: [{ address, value: 50_000 }],
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: [{ address: externalAddress, value: 50_010 }],
    })
    let prevoutHydrated = false
    const getTx = vi.fn(async () => {
      prevoutHydrated = true
      return parent
    })
    const getAddressStats = vi.fn(async (itemAddress: string) => {
      const stats = {
        ...historyStats(itemAddress === address ? 1 : 0),
        address: itemAddress,
      }
      if (!prevoutHydrated || itemAddress !== secondAddress) return stats
      return {
        ...stats,
        mempool_stats: {
          ...stats.mempool_stats,
          funded_txo_count: 1,
          funded_txo_sum: 1,
          tx_count: 1,
        },
      }
    })
    const client = accountHistoryClient(
      {
        [address]: { confirmed: [tx], mempool: [] },
        [secondAddress]: { confirmed: [], mempool: [] },
      },
      { getAddressStats, getTx }
    )

    await expect(
      getQbitAccountHistory(client as any, [address, secondAddress], { start: 0, limit: 20 })
    ).rejects.toThrow(`qbit address history changed while resolving prevouts ${secondAddress}`)
    expect(getTx).toHaveBeenCalledTimes(1)
    expect(getAddressStats).toHaveBeenCalledTimes(6)
  })

  it('retries a full scan when a same-count RBF occurs during missing-prevout hydration', async () => {
    const parentTxid = 'a5'.repeat(32)
    const original = accountHistoryTx({
      txid: 'a6'.repeat(32),
      inputs: [{ txid: parentTxid, missingPrevout: true }],
      outputs: [{ address, value: 50_000 }],
      confirmed: false,
    })
    const replacement = accountHistoryTx({
      txid: 'a7'.repeat(32),
      inputs: [{ txid: parentTxid, missingPrevout: true }],
      outputs: [{ address, value: 49_999 }],
      confirmed: false,
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: [{ address: externalAddress, value: 50_010 }],
    })
    let currentMempoolTx = original
    let hydrationCount = 0
    const getTx = vi.fn(async () => {
      hydrationCount += 1
      if (hydrationCount === 1) currentMempoolTx = replacement
      return parent
    })
    const client = accountHistoryClient(
      { [address]: { confirmed: [], mempool: [original] } },
      {
        getAddressHistory: vi.fn(async () => ({
          confirmed: [],
          mempool: [currentMempoolTx],
        })),
        getAddressMempoolTxs: vi.fn(async () => [currentMempoolTx]),
        getTx,
      }
    )

    await expect(
      getQbitAccountHistory(
        client as any,
        [address],
        { start: 0, limit: 20 },
        { stabilityRetries: 1, retryBaseDelayMs: 0 }
      )
    ).resolves.toMatchObject({
      total: 1,
      detail: [{ txid: replacement.txid }],
    })
    expect(getTx).toHaveBeenCalledTimes(2)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledTimes(4)
  })

  it('rejects the account snapshot when a missing prevout lookup fails', async () => {
    const parentTxid = '95'.repeat(32)
    const tx = accountHistoryTx({
      txid: '96'.repeat(32),
      inputs: [{ txid: parentTxid, missingPrevout: true }],
      outputs: [{ address, value: 50_000 }],
    })
    const client = accountHistoryClient(
      { [address]: { confirmed: [tx], mempool: [] } },
      { getTx: vi.fn().mockRejectedValue(new Error('parent transaction unavailable')) }
    )

    await expect(
      getQbitAccountHistory(client as any, [address], { start: 0, limit: 20 })
    ).rejects.toThrow('parent transaction unavailable')
  })

  it('rejects invalid parent payloads, mismatched txids and missing referenced outputs', async () => {
    const parentTxid = '97'.repeat(32)
    const tx = accountHistoryTx({
      txid: '98'.repeat(32),
      inputs: [{ txid: parentTxid, vout: 1, missingPrevout: true }],
      outputs: [{ address, value: 50_000 }],
    })
    const loadWithParent = (parent: unknown) =>
      getQbitAccountHistory(
        accountHistoryClient(
          { [address]: { confirmed: [tx], mempool: [] } },
          { getTx: vi.fn().mockResolvedValue(parent) }
        ) as any,
        [address],
        { start: 0, limit: 20 }
      )

    await expect(loadWithParent({ txid: parentTxid })).rejects.toThrow(
      'invalid qbit history transaction'
    )
    await expect(
      loadWithParent(
        accountHistoryTx({
          txid: '99'.repeat(32),
          outputs: [{ address, value: 50_000 }],
        })
      )
    ).rejects.toThrow(`mismatched qbit prevout transaction ${parentTxid}`)
    await expect(
      loadWithParent(
        accountHistoryTx({
          txid: parentTxid,
          outputs: [{ address, value: 50_000 }],
        })
      )
    ).rejects.toThrow(`missing output 1 in qbit prevout transaction ${parentTxid}`)
  })

  it('deduplicates missing-prevout parent lookups by normalized txid', async () => {
    const parentTxid = '9a'.repeat(32)
    const tx = accountHistoryTx({
      txid: '9b'.repeat(32),
      inputs: [
        { txid: parentTxid, vout: 0, missingPrevout: true },
        { txid: parentTxid.toUpperCase(), vout: 1, missingPrevout: true },
      ],
      outputs: [
        { address: externalAddress, value: 80_000 },
        { address, value: 19_990 },
      ],
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: [
        { address, value: 70_000 },
        { address: externalAddress, value: 30_000 },
      ],
    })
    const getTx = vi.fn().mockResolvedValue(parent)
    const client = accountHistoryClient(
      { [address]: { confirmed: [tx], mempool: [] } },
      { getTx }
    )

    const result = await getQbitAccountHistory(client as any, [address], {
      start: 0,
      limit: 20,
    })

    expect(getTx).toHaveBeenCalledTimes(1)
    expect(getTx).toHaveBeenCalledWith(parentTxid)
    expect(result.detail[0]?.vin).toMatchObject([
      { value: 70_000, owned: true },
      { value: 30_000, owned: false },
    ])
  })

  it('limits missing-prevout parent lookup concurrency while preserving input order', async () => {
    const parentTxids = Array.from({ length: 12 }, (_, index) =>
      (0xb0 + index).toString(16).repeat(32)
    )
    const inputValues = parentTxids.map((_, index) => index + 1)
    const tx = accountHistoryTx({
      txid: 'bc'.repeat(32),
      inputs: parentTxids.map(txid => ({ txid, vout: 0, missingPrevout: true })),
      outputs: [{ address, value: 68 }],
    })
    const parents = new Map(
      parentTxids.map((txid, index) => [
        txid,
        accountHistoryTx({
          txid,
          outputs: [{ address: externalAddress, value: inputValues[index]! }],
        }),
      ])
    )
    let activeLookups = 0
    let maximumActiveLookups = 0
    let releaseLookups!: () => void
    const lookupGate = new Promise<void>(resolve => {
      releaseLookups = resolve
    })
    const getTx = vi.fn(async (txid: string) => {
      activeLookups += 1
      maximumActiveLookups = Math.max(maximumActiveLookups, activeLookups)
      await lookupGate
      activeLookups -= 1
      const parent = parents.get(txid)
      if (!parent) throw new Error(`unexpected parent transaction ${txid}`)
      return parent
    })
    const client = accountHistoryClient({ [address]: { confirmed: [tx], mempool: [] } }, { getTx })

    const resultPromise = getQbitAccountHistory(client as any, [address], {
      start: 0,
      limit: 20,
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getTx).toHaveBeenCalledTimes(8)
    expect(activeLookups).toBe(8)
    releaseLookups()
    const result = await resultPromise

    expect(maximumActiveLookups).toBe(8)
    expect(getTx.mock.calls.map(([txid]) => txid)).toEqual(parentTxids)
    expect(result.detail[0]?.vin.map(input => input.value)).toEqual(inputValues)
  })

  it('rejects excessive prevout references before loading a deduplicated parent', async () => {
    const parentTxid = 'be'.repeat(32)
    const tx = accountHistoryTx({
      txid: 'bd'.repeat(32),
      inputs: Array.from({ length: 1_025 }, (_, index) => ({
        txid: index % 2 === 0 ? parentTxid : parentTxid.toUpperCase(),
        missingPrevout: true,
      })),
      outputs: [{ address, value: 1 }],
    })
    const getTx = vi.fn()
    const client = accountHistoryClient({ [address]: { confirmed: [tx], mempool: [] } }, { getTx })

    await expect(
      getQbitAccountHistory(client as any, [address], { start: 0, limit: 20 })
    ).rejects.toThrow('qbit history exceeds the 1024-prevout hydration limit')
    expect(getTx).not.toHaveBeenCalled()
  })

  it('counts a shared transaction once at the prevout limit and validates every address', async () => {
    const parentTxid = 'bf'.repeat(32)
    const inputCount = 1_024
    const shared = accountHistoryTx({
      txid: 'c0'.repeat(32),
      inputs: Array.from({ length: inputCount }, (_, vout) => ({
        txid: parentTxid,
        vout,
        missingPrevout: true,
      })),
      outputs: [{ address: externalAddress, value: inputCount - 10 }],
    })
    const parent = accountHistoryTx({
      txid: parentTxid,
      outputs: Array.from({ length: inputCount }, (_, index) => ({
        address: index === 0 ? address : index === 1 ? secondAddress : externalAddress,
        value: 1,
      })),
    })
    const getTx = vi.fn().mockResolvedValue(parent)
    const client = accountHistoryClient(
      {
        [address]: { confirmed: [shared], mempool: [] },
        [secondAddress]: { confirmed: [shared], mempool: [] },
      },
      { getTx }
    )

    const result = await getQbitAccountHistory(client as any, [address, secondAddress], {
      start: 0,
      limit: 20,
    })

    expect(result.total).toBe(1)
    expect(result.detail[0]?.vin).toHaveLength(inputCount)
    expect(result.detail[0]?.vin.slice(0, 2)).toMatchObject([
      { address, owned: true },
      { address: secondAddress, owned: true },
    ])
    expect(getTx).toHaveBeenCalledTimes(1)
    expect(getTx).toHaveBeenCalledWith(parentTxid)
  })

  it('validates every address that reports a deduplicated hydrated transaction', async () => {
    const parentTxid = 'c1'.repeat(32)
    const shared = accountHistoryTx({
      txid: 'c2'.repeat(32),
      inputs: [{ txid: parentTxid, vout: 0, missingPrevout: true }],
      outputs: [{ address: externalAddress, value: 90 }],
    })
    const getTx = vi.fn().mockResolvedValue(
      accountHistoryTx({
        txid: parentTxid,
        outputs: [{ address, value: 100 }],
      })
    )
    const client = accountHistoryClient(
      {
        [address]: { confirmed: [shared], mempool: [] },
        [secondAddress]: { confirmed: [shared], mempool: [] },
      },
      { getTx }
    )

    await expect(
      getQbitAccountHistory(client as any, [address, secondAddress], {
        start: 0,
        limit: 20,
      })
    ).rejects.toThrow(`qbit history transaction ${shared.txid} does not touch ${secondAddress}`)
    expect(getTx).toHaveBeenCalledTimes(1)
  })

  it('rejects conflicting duplicate payloads across account addresses', async () => {
    const shared = accountHistoryTx({
      inputs: [{ address, value: 100 }],
      outputs: [{ address: secondAddress, value: 90 }],
    })
    const conflict = {
      ...shared,
      fee: 11,
    }
    const client = accountHistoryClient({
      [address]: { confirmed: [shared], mempool: [] },
      [secondAddress]: { confirmed: [conflict], mempool: [] },
    })

    await expect(
      getQbitAccountHistory(client as any, [address, secondAddress], {
        start: 0,
        limit: 20,
      })
    ).rejects.toThrow(`conflicting qbit history payloads for transaction ${shared.txid}`)
  })

  it('rejects the whole account refresh when any constituent address fails', async () => {
    const tx = accountHistoryTx({
      inputs: [{ address: externalAddress, value: 100 }],
      outputs: [{ address, value: 90 }],
    })
    const client = accountHistoryClient(
      {
        [address]: { confirmed: [tx], mempool: [] },
        [secondAddress]: { confirmed: [], mempool: [] },
      },
      {
        getAddressHistory: vi.fn(async (itemAddress: string) => {
          if (itemAddress === secondAddress) throw new Error('indexer unavailable')
          return { confirmed: [tx], mempool: [] }
        }),
      }
    )

    await expect(
      getQbitAccountHistory(client as any, [address, secondAddress], {
        start: 0,
        limit: 20,
      })
    ).rejects.toThrow('indexer unavailable')
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('retries and rejects per-address mempool identity drift with stable stats', async () => {
    const oldMempoolTx = accountHistoryTx({
      txid: 'b1'.repeat(32),
      inputs: [
        { address, value: 60 },
        { address: secondAddress, value: 40 },
      ],
      outputs: [{ address: externalAddress, value: 90 }],
      confirmed: false,
    })
    const replacementMempoolTx = accountHistoryTx({
      txid: 'b2'.repeat(32),
      inputs: [
        { address, value: 60 },
        { address: secondAddress, value: 40 },
      ],
      outputs: [{ address: externalAddress, value: 90 }],
      confirmed: false,
    })
    const client = accountHistoryClient(
      {
        [address]: { confirmed: [], mempool: [oldMempoolTx] },
        [secondAddress]: { confirmed: [], mempool: [replacementMempoolTx] },
      },
      {
        getAddressMempoolTxs: vi.fn().mockResolvedValue([replacementMempoolTx]),
      }
    )

    await expect(
      getQbitAccountHistory(
        client as any,
        [address, secondAddress],
        { start: 0, limit: 20 },
        { stabilityRetries: 1, retryBaseDelayMs: 0 }
      )
    ).rejects.toThrow(`qbit address history changed while scanning ${address}`)
    expect(client.getAddressHistory).toHaveBeenCalledTimes(4)
    expect(client.getAddressStats).toHaveBeenCalledTimes(8)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledTimes(4)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledWith(address)
    expect(client.getAddressMempoolTxs).toHaveBeenCalledWith(secondAddress)
  })

  it('retries a full scan when confirmed block hashes conflict below the highest height', async () => {
    const lowerBlockHash = '81'.repeat(32)
    const highest = {
      ...accountHistoryTx({
        txid: 'd1'.repeat(32),
        inputs: [{ address: externalAddress, value: 100 }],
        outputs: [{ address, value: 90 }],
        blockHeight: 9,
      }),
      status: { confirmed: true, block_height: 9, block_time: 123, block_hash: '91'.repeat(32) },
    }
    const lower = {
      ...accountHistoryTx({
        txid: 'd2'.repeat(32),
        inputs: [{ address: externalAddress, value: 80 }],
        outputs: [{ address, value: 70 }],
        blockHeight: 8,
      }),
      status: { confirmed: true, block_height: 8, block_time: 123, block_hash: lowerBlockHash },
    }
    const otherLower = accountHistoryTx({
      txid: 'd3'.repeat(32),
      inputs: [{ address: externalAddress, value: 60 }],
      outputs: [{ address: secondAddress, value: 50 }],
      blockHeight: 8,
    })
    const conflictingOtherLower = {
      ...otherLower,
      status: { ...otherLower.status, block_hash: '82'.repeat(32) },
    }
    const matchingOtherLower = {
      ...otherLower,
      status: { ...otherLower.status, block_hash: lowerBlockHash.toUpperCase() },
    }
    const stableHistories = {
      [address]: { confirmed: [highest, lower], mempool: [] },
      [secondAddress]: { confirmed: [matchingOtherLower], mempool: [] },
    }
    const historyCalls = new Map<string, number>()
    const recentCalls = new Map<string, number>()
    const historyForAttempt = (itemAddress: string, attempt: number) =>
      itemAddress === secondAddress && attempt === 0
        ? { confirmed: [conflictingOtherLower], mempool: [] }
        : stableHistories[itemAddress]!
    const nextAttempt = (calls: Map<string, number>, itemAddress: string) => {
      const attempt = calls.get(itemAddress) ?? 0
      calls.set(itemAddress, attempt + 1)
      return attempt
    }
    const getAddressHistory = vi.fn(async (itemAddress: string) =>
      historyForAttempt(itemAddress, nextAttempt(historyCalls, itemAddress))
    )
    const getAddressTxs = vi.fn(
      async (itemAddress: string) =>
        historyForAttempt(itemAddress, nextAttempt(recentCalls, itemAddress)).confirmed
    )
    const client = accountHistoryClient(stableHistories, {
      getAddressHistory,
      getAddressTxs,
    })

    await expect(
      getQbitAccountHistory(
        client as any,
        [address, secondAddress],
        { start: 0, limit: 20 },
        { stabilityRetries: 1, retryBaseDelayMs: 0 }
      )
    ).resolves.toMatchObject({
      total: 3,
      revision: {
        confirmedHistoryAnchor: {
          txid: highest.txid,
          blockHeight: 9,
          blockHash: highest.status.block_hash,
        },
      },
    })
    expect(getAddressHistory).toHaveBeenCalledTimes(4)
    expect(getAddressTxs).toHaveBeenCalledTimes(4)
  })

  it('retries a full scan when address stats briefly lag complete history', async () => {
    const tx = accountHistoryTx({
      inputs: [{ address: externalAddress, value: 100 }],
      outputs: [{ address, value: 90 }],
    })
    const history = { confirmed: [tx], mempool: [] }
    const staleStats = {
      ...historyStats(0),
      address,
    }
    const currentStats = {
      ...historyStats(1),
      address,
    }
    const getAddressStats = vi
      .fn()
      .mockResolvedValueOnce(staleStats)
      .mockResolvedValueOnce(staleStats)
      .mockResolvedValueOnce(currentStats)
      .mockResolvedValueOnce(currentStats)
    const client = accountHistoryClient({ [address]: history }, { getAddressStats })

    await expect(
      getQbitAccountHistory(
        client as any,
        [address],
        { start: 0, limit: 20 },
        { stabilityRetries: 1, retryBaseDelayMs: 0 }
      )
    ).resolves.toMatchObject({
      total: 1,
      detail: [{ txid: tx.txid }],
    })
    expect(client.getAddressHistory).toHaveBeenCalledTimes(2)
    expect(getAddressStats).toHaveBeenCalledTimes(4)
  })

  it('retries a full scan when Esplora pagination is transiently inconsistent', async () => {
    const tx = accountHistoryTx({
      inputs: [{ address: externalAddress, value: 100 }],
      outputs: [{ address, value: 90 }],
    })
    const history = { confirmed: [tx], mempool: [] }
    const getAddressHistory = vi
      .fn()
      .mockRejectedValueOnce(
        new QbitApiError(
          'invalid_cursor',
          `esplora address history repeated transaction ${tx.txid}: ${address}`
        )
      )
      .mockResolvedValue(history)
    const client = accountHistoryClient({ [address]: history }, { getAddressHistory })

    await expect(
      getQbitAccountHistory(
        client as any,
        [address],
        { start: 0, limit: 20 },
        { stabilityRetries: 1, retryBaseDelayMs: 0 }
      )
    ).resolves.toMatchObject({
      total: 1,
      detail: [{ txid: tx.txid }],
    })
    expect(getAddressHistory).toHaveBeenCalledTimes(2)
  })

  it('rejects direct history mapping when a non-coinbase prevout is unresolved', () => {
    const tx = accountHistoryTx({
      inputs: [{ missingPrevout: true }],
      outputs: [{ address, value: 100 }],
    })

    expect(() => qbitTxToHistoryItem(tx, address, 10)).toThrow(
      `missing prevout for input 0 of qbit transaction ${tx.txid}`
    )
  })

  it('accepts a coinbase null prevout without loading a parent transaction', async () => {
    const tx = accountHistoryTx({
      txid: '9c'.repeat(32),
      inputs: [{ coinbase: true }],
      outputs: [{ address, value: 50_000 }],
    })
    const getTx = vi.fn()
    const client = accountHistoryClient(
      { [address]: { confirmed: [tx], mempool: [] } },
      { getTx }
    )

    await expect(
      getQbitAccountHistory(client as any, [address], { start: 0, limit: 20 })
    ).resolves.toMatchObject({
      detail: [
        {
          direction: 'receive',
          amount: 50_000,
          vin: [{ coinbase: true, owned: false, prevoutMissing: false }],
        },
      ],
    })
    expect(getTx).not.toHaveBeenCalled()
  })

  it('keeps addressless outputs honest in history detail metadata', () => {
    const tx = accountHistoryTx({
      inputs: [{ address: externalAddress, value: 110 }],
      outputs: [
        { address, value: 100 },
        { value: 0, scriptType: 'op_return' },
      ],
    })

    const item = qbitTxToHistoryItem(tx, address, 10)
    expect(item).toMatchObject({
      direction: 'receive',
      vin: [
        {
          index: 0,
          address: externalAddress,
          value: 110,
          owned: false,
          prevoutMissing: false,
        },
      ],
      vout: [
        { index: 0, address, value: 100, owned: true },
        { index: 1, value: 0, scriptType: 'op_return', owned: false },
      ],
    })
    expect(item.vout[1]?.address).toBeUndefined()
  })

  it('loads and returns exact witness-bearing raw transaction hex', async () => {
    const client = { getTxHex: vi.fn().mockResolvedValue(witnessTransactionHex) }

    await expect(
      getQbitRawTransactionHex(client as any, witnessTransactionTxid.toUpperCase())
    ).resolves.toBe(witnessTransactionHex)
    expect(client.getTxHex).toHaveBeenCalledWith(witnessTransactionTxid)
  })

  it('rejects valid raw transaction hex that does not match the requested txid', async () => {
    const requestedTxid = 'aa'.repeat(32)
    const client = { getTxHex: vi.fn().mockResolvedValue(witnessTransactionHex) }

    await expect(getQbitRawTransactionHex(client as any, requestedTxid)).rejects.toThrow(
      `raw qbit transaction txid mismatch for ${requestedTxid}`
    )
  })

  it.each(['', '0', 'zz', '00\\n', '00'])('rejects malformed raw transaction hex %j', async hex => {
    const client = { getTxHex: vi.fn().mockResolvedValue(hex) }
    await expect(getQbitRawTransactionHex(client as any, 'aa'.repeat(32))).rejects.toThrow(
      'invalid raw qbit transaction hex'
    )
  })

  it('rejects raw transaction hex larger than qbit Core serialized blocks', async () => {
    const oversizedRawTransactionHex = '00'.repeat(2_000_001)
    const client = { getTxHex: vi.fn().mockResolvedValue(oversizedRawTransactionHex) }

    await expect(getQbitRawTransactionHex(client as any, 'aa'.repeat(32))).rejects.toThrow(
      'invalid raw qbit transaction hex'
    )
  })

  it('rejects malformed raw transaction txids before calling the API', async () => {
    const client = { getTxHex: vi.fn() }
    await expect(getQbitRawTransactionHex(client as any, 'not-a-txid')).rejects.toThrow(
      'invalid qbit transaction id'
    )
    expect(client.getTxHex).not.toHaveBeenCalled()
  })

  it('maps unsorted Esplora estimates to qbit 20/6/2-block targets', () => {
    expect(
      qbitFeeSummaryFromTiers(
        [
          { target: 20, feeRate: 2 },
          { target: 2, feeRate: 9 },
          { target: 6, feeRate: 4 },
        ],
        'esplora',
        { fetchedAt: 123 }
      )
    ).toEqual({
      list: [
        {
          title: 'Slow',
          desc: '~20 min (20 blocks)',
          feeRate: 2,
          targetBlocks: 20,
        },
        {
          title: 'Normal',
          desc: '~6 min (6 blocks)',
          feeRate: 4,
          targetBlocks: 6,
        },
        {
          title: 'Fast',
          desc: '~2 min (2 blocks)',
          feeRate: 9,
          targetBlocks: 2,
        },
      ],
      quote: {
        source: 'esplora',
        availability: 'available',
        freshness: 'live',
        fetchedAt: 123,
      },
    })
  })

  it('maps mempool-qbit projected blocks 1/2/3 into distinct qbit tiers', () => {
    expect(
      qbitFeeSummaryFromTiers(
        [
          { target: 3, feeRate: 1 },
          { target: 2, feeRate: 3 },
          { target: 1, feeRate: 9 },
        ],
        'mempool-qbit'
      )
    ).toEqual({
      list: [
        { title: 'Slow', desc: '~3 min (3 blocks)', feeRate: 1, targetBlocks: 3 },
        { title: 'Normal', desc: '~2 min (2 blocks)', feeRate: 3, targetBlocks: 2 },
        { title: 'Fast', desc: '~1 min (1 block)', feeRate: 9, targetBlocks: 1 },
      ],
      quote: {
        source: 'mempool-qbit',
        availability: 'available',
        freshness: 'live',
      },
    })
  })

  it('uses the closest available target no slower than each requested Esplora window', () => {
    expect(
      qbitFeeSummaryFromTiers([
        { target: 25, feeRate: 1 },
        { target: 10, feeRate: 2 },
        { target: 5, feeRate: 4 },
        { target: 1, feeRate: 9 },
      ]).list.map(tier => tier.feeRate)
    ).toEqual([2, 4, 9])
  })

  it('fails closed when a missing bucket has no estimate fast enough for its window', () => {
    expect(
      qbitFeeSummaryFromTiers([
        { target: 20, feeRate: 1 },
        { target: 3, feeRate: 2 },
      ])
    ).toMatchObject({
      list: [{ feeRate: 1 }, { feeRate: 1 }, { feeRate: 1 }],
      quote: {
        availability: 'unavailable',
        freshness: 'fallback',
        fallbackReason: 'invalid',
      },
    })
  })

  it('normalizes positive sub-floor provider rates to the shared relay floor', () => {
    const summary = qbitFeeSummaryFromTiers([
      { target: 20, feeRate: 0.1 },
      { target: 6, feeRate: 0.25 },
      { target: 2, feeRate: 0.5 },
    ])
    expect(summary.list.map(tier => tier.feeRate)).toEqual([1, 1, 1])
    expect(summary.quote?.availability).toBe('available')
  })

  it.each([
    ['zero target', [{ target: 0, feeRate: 1 }]],
    ['fractional target', [{ target: 1.5, feeRate: 1 }]],
    ['extreme target', [{ target: 1_009, feeRate: 1 }]],
    ['zero fee', [{ target: 1, feeRate: 0 }]],
    ['negative fee', [{ target: 1, feeRate: -1 }]],
    ['non-finite fee', [{ target: 1, feeRate: Number.POSITIVE_INFINITY }]],
    ['fee above the wallet policy ceiling', [{ target: 1, feeRate: 10_001 }]],
    [
      'duplicate target',
      [
        { target: 1, feeRate: 2 },
        { target: 1, feeRate: 3 },
      ],
    ],
    [
      'contradictory rates',
      [
        { target: 1, feeRate: 2 },
        { target: 2, feeRate: 3 },
      ],
    ],
  ])('falls back safely for malicious fee tiers with %s', (_name, tiers) => {
    expect(qbitFeeSummaryFromTiers(tiers)).toMatchObject({
      list: [{ feeRate: 1 }, { feeRate: 1 }, { feeRate: 1 }],
      quote: {
        availability: 'unavailable',
        freshness: 'fallback',
        fallbackReason: 'invalid',
      },
    })
  })

  it('distinguishes empty estimates from malformed provider data', () => {
    expect(qbitFeeSummaryFromTiers([]).quote).toMatchObject({
      availability: 'unavailable',
      fallbackReason: 'empty',
    })
    expect(qbitFeeSummaryFromTiers({ 1: 2 } as any).quote).toMatchObject({
      availability: 'unavailable',
      fallbackReason: 'invalid',
    })
  })
})

describe('discoverQbitActiveIndexes', () => {
  const addressForIndex = (index: number) => `qb1qrestore${index}`

  function discoveryClient(config: {
    balances?: Record<number, number>
    spentOnly?: number[]
  }) {
    const spentOnly = new Set(config.spentOnly ?? [])
    const balances = config.balances ?? {}
    const getAddressStats = vi.fn(async (queried: string) => {
      const match = /^qb1qrestore(\d+)$/.exec(queried)
      if (!match) throw new Error(`unexpected address ${queried}`)
      const index = Number(match[1])
      const balance = balances[index] ?? 0
      if (balance > 0) {
        return {
          address: queried,
          chain_stats: {
            funded_txo_count: 1,
            funded_txo_sum: balance,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 1,
          },
          mempool_stats: {
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 0,
          },
        }
      }
      if (spentOnly.has(index)) {
        return {
          address: queried,
          chain_stats: {
            funded_txo_count: 2,
            funded_txo_sum: 2,
            spent_txo_count: 2,
            spent_txo_sum: 2,
            tx_count: 2,
          },
          mempool_stats: {
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 0,
          },
        }
      }
      return {
        address: queried,
        chain_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 0,
        },
        mempool_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 0,
        },
      }
    })
    return { client: { getAddressStats } as any, getAddressStats }
  }

  const deriveAddresses = (count: number) =>
    Array.from({ length: count }, (_value, index) => addressForIndex(index))

  it('scans exactly one gap window for an unused seed', async () => {
    const { client, getAddressStats } = discoveryClient({})
    const deriveInBatches = vi.fn(deriveAddresses)
    const result = await discoverQbitActiveIndexes(client, deriveInBatches)
    expect(result).toEqual({
      activeIndexes: [],
      highestActiveIndex: -1,
      scannedCount: 20,
      truncated: false,
    })
    expect(deriveInBatches.mock.calls.map(([count]) => count)).toEqual([20])
    expect(getAddressStats).toHaveBeenCalledTimes(20)
  })

  it('extends past funded and spent-only indexes until a full trailing gap', async () => {
    // Index 25 is spent-only (zero balance, has history): still activity.
    const { client } = discoveryClient({ balances: { 0: 5_000, 15: 1_000 }, spentOnly: [25] })
    const result = await discoverQbitActiveIndexes(client, deriveAddresses)
    expect(result.activeIndexes).toEqual([0, 15, 25])
    expect(result.highestActiveIndex).toBe(25)
    expect(result.scannedCount).toBe(46) // 25 + 1 + gap of 20
    expect(result.truncated).toBe(false)
  })

  it('stops within the gap limit for activity separated by a full gap', async () => {
    // 24 unused indexes between 0 and 25 exceed the default gap of 20.
    const { client } = discoveryClient({ balances: { 0: 5_000, 25: 1_000 } })
    const result = await discoverQbitActiveIndexes(client, deriveAddresses)
    expect(result.activeIndexes).toEqual([0])
    expect(result.scannedCount).toBe(21)
  })

  it('reports truncation when the index cap cuts the scan short', async () => {
    const balances: Record<number, number> = {}
    for (let index = 0; index < 60; index += 1) balances[index] = 1_000
    const { client } = discoveryClient({ balances })
    const result = await discoverQbitActiveIndexes(client, deriveAddresses, { maxIndexes: 40 })
    expect(result.scannedCount).toBe(40)
    expect(result.highestActiveIndex).toBe(39)
    expect(result.truncated).toBe(true)
  })

  it('honors a custom gap limit', async () => {
    const { client } = discoveryClient({ balances: { 0: 1_000, 6: 1_000 } })
    const result = await discoverQbitActiveIndexes(client, deriveAddresses, { gapLimit: 5 })
    expect(result.activeIndexes).toEqual([0])
    expect(result.scannedCount).toBe(6)
  })

  it('rejects invalid bounds and short derivations', async () => {
    const { client } = discoveryClient({})
    await expect(discoverQbitActiveIndexes(client, deriveAddresses, { gapLimit: 0 })).rejects.toThrow(
      'gapLimit'
    )
    await expect(
      discoverQbitActiveIndexes(client, deriveAddresses, { maxIndexes: 5 })
    ).rejects.toThrow('maxIndexes')
    await expect(discoverQbitActiveIndexes(client, () => [])).rejects.toThrow(
      'fewer addresses than requested'
    )
  })
})

describe('classifyQbitProtectedAssetCoverage', () => {
  const fundingTxid = 'ab'.repeat(32)
  const otherTxid = 'cd'.repeat(32)

  function fundingTx(txid: string, vout: object[] = [{ scriptpubkey: scriptPubKey, value: 5_000 }]) {
    return { txid, vin: [{ is_coinbase: false }], vout }
  }

  it('returns empty coverage without touching the client for no outpoints', async () => {
    const getTx = vi.fn()
    const coverage = await classifyQbitProtectedAssetCoverage({ getTx }, [])
    expect(coverage.assetCount).toBe(0)
    expect(coverage.protectedOutpoints.size).toBe(0)
    expect(getTx).not.toHaveBeenCalled()
  })

  it('classifies verified plain P2MR outputs as asset-free, one lookup per transaction', async () => {
    const getTx = vi.fn(async (txid: string) =>
      fundingTx(txid, [
        { scriptpubkey: scriptPubKey, value: 5_000 },
        { scriptpubkey: `5220${'77'.repeat(32)}`, value: 7_000 },
      ])
    )
    const coverage = await classifyQbitProtectedAssetCoverage({ getTx }, [
      { txid: fundingTxid, vout: 0 },
      { txid: fundingTxid.toUpperCase(), vout: 1 },
      { txid: otherTxid, vout: 0 },
    ])
    expect(coverage.assetCount).toBe(0)
    expect(coverage.protectedOutpoints.size).toBe(0)
    expect(getTx).toHaveBeenCalledTimes(2)
    expect(getTx).toHaveBeenCalledWith(fundingTxid)
    expect(getTx).toHaveBeenCalledWith(otherTxid)
  })

  it('rejects duplicate requested outpoints before any lookup', async () => {
    const getTx = vi.fn()
    await expect(
      classifyQbitProtectedAssetCoverage({ getTx }, [
        { txid: fundingTxid, vout: 0 },
        { txid: fundingTxid.toUpperCase(), vout: 0 },
      ])
    ).rejects.toThrow('duplicate outpoints')
    expect(getTx).not.toHaveBeenCalled()
  })

  it('rejects malformed requested outpoints', async () => {
    const getTx = vi.fn()
    for (const outpoint of [
      { txid: 'not-hex', vout: 0 },
      { txid: fundingTxid.slice(2), vout: 0 },
      { txid: fundingTxid, vout: -1 },
      { txid: fundingTxid, vout: 1.5 },
      { txid: fundingTxid, vout: 0x1_0000_0000 },
    ]) {
      await expect(classifyQbitProtectedAssetCoverage({ getTx }, [outpoint])).rejects.toThrow(
        'invalid outpoint'
      )
    }
    expect(getTx).not.toHaveBeenCalled()
  })

  it('fails closed when the explorer is unavailable', async () => {
    const getTx = vi.fn().mockRejectedValue(new QbitApiError('network', 'explorer offline'))
    await expect(
      classifyQbitProtectedAssetCoverage({ getTx }, [{ txid: fundingTxid, vout: 0 }])
    ).rejects.toThrow('explorer offline')
  })

  it('fails closed on a mismatched or malformed funding transaction', async () => {
    for (const tx of [
      undefined,
      fundingTx(otherTxid),
      { txid: fundingTxid, vin: [], vout: 'not-an-array' },
    ]) {
      const getTx = vi.fn().mockResolvedValue(tx)
      await expect(
        classifyQbitProtectedAssetCoverage({ getTx }, [{ txid: fundingTxid, vout: 0 }])
      ).rejects.toThrow('invalid transaction')
    }
  })

  it('fails closed when a requested output index does not exist', async () => {
    const getTx = vi.fn(async (txid: string) => fundingTx(txid))
    await expect(
      classifyQbitProtectedAssetCoverage({ getTx }, [
        { txid: fundingTxid, vout: 0 },
        { txid: fundingTxid, vout: 1 },
      ])
    ).rejects.toThrow(`could not resolve outpoint ${fundingTxid}:1`)
  })

  it('fails closed on an invalid output value', async () => {
    for (const value of [-1, 1.5, Number.NaN, '5000', undefined]) {
      const getTx = vi.fn(async (txid: string) => fundingTx(txid, [{ scriptpubkey: scriptPubKey, value }]))
      await expect(
        classifyQbitProtectedAssetCoverage({ getTx }, [{ txid: fundingTxid, vout: 0 }])
      ).rejects.toThrow('invalid output value')
    }
  })

  it('refuses to classify any output that is not plain P2MR', async () => {
    const opReturn = '6a0454455354'
    const witnessV3 = `5320${'11'.repeat(32)}`
    const shortProgram = '5210' + '11'.repeat(16)
    for (const scriptpubkey of [opReturn, witnessV3, shortProgram, '', undefined]) {
      const getTx = vi.fn(async (txid: string) =>
        fundingTx(txid, [{ scriptpubkey, value: 5_000 }])
      )
      await expect(
        classifyQbitProtectedAssetCoverage({ getTx }, [{ txid: fundingTxid, vout: 0 }])
      ).rejects.toThrow('cannot classify the non-P2MR output')
    }
  })
})

describe('qbit transaction spenders (#274)', () => {
  const txid = 'd1'.repeat(32)
  const spender = 'E2'.repeat(32)

  it('maps each output to the transaction spending it', async () => {
    const client = {
      getTxOutspends: vi
        .fn()
        .mockResolvedValue([
          { spent: false },
          { spent: true, txid: spender, vin: 0, status: { confirmed: false } },
        ]),
    }

    await expect(getQbitTxSpenders(client, txid.toUpperCase(), 2)).resolves.toEqual([
      undefined,
      spender.toLowerCase(),
    ])
    expect(client.getTxOutspends).toHaveBeenCalledWith(txid)
  })

  it.each([
    ['a non-array answer', { spent: false }],
    ['an empty answer', []],
    ['one entry too few', [{ spent: false }]],
    ['one entry too many', [{ spent: false }, { spent: false }, { spent: false }]],
    ['an entry without a spent flag', [{ spent: false }, {}]],
    ['a null entry', [{ spent: false }, null]],
    ['a spent entry without a spender', [{ spent: false }, { spent: true }]],
    ['a spent entry with a malformed spender', [{ spent: false }, { spent: true, txid: 'zz' }]],
    ['a spent entry naming the transaction itself', [{ spent: false }, { spent: true, txid }]],
  ])('refuses %s instead of reading it as unspent', async (_name, answer) => {
    const client = { getTxOutspends: vi.fn().mockResolvedValue(answer) }

    await expect(getQbitTxSpenders(client, txid, 2)).rejects.toThrow(
      `invalid qbit outspends for ${txid}`
    )
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses an output count of %s', async outputCount => {
    const client = { getTxOutspends: vi.fn() }

    await expect(getQbitTxSpenders(client, txid, outputCount)).rejects.toThrow(
      'invalid qbit transaction output count'
    )
    expect(client.getTxOutspends).not.toHaveBeenCalled()
  })

  it('refuses a malformed txid before asking the explorer', async () => {
    const client = { getTxOutspends: vi.fn() }

    await expect(getQbitTxSpenders(client, 'not-a-txid', 1)).rejects.toThrow(
      'invalid qbit transaction id'
    )
    expect(client.getTxOutspends).not.toHaveBeenCalled()
  })

  it('passes explorer failures through', async () => {
    const error = new QbitApiError('http', 'unavailable', { status: 503 })
    const client = { getTxOutspends: vi.fn().mockRejectedValue(error) }

    await expect(getQbitTxSpenders(client, txid, 1)).rejects.toBe(error)
  })

  it.each([
    ['Esplora', QbitWalletEsploraClient, 'http://127.0.0.1:3002'],
    ['mempool-qbit', QbitWalletMempoolClient, 'https://mempool.qbit.org/api'],
  ])(
    'asks %s for /tx/:txid/outspends under the endpoint prefix',
    async (_name, Client, baseUrl) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify([{ spent: false }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
      const client = new Client({ baseUrl, fetchFn: fetchFn as any })

      await expect(client.getTxOutspends(txid)).resolves.toEqual([{ spent: false }])
      expect(fetchFn).toHaveBeenCalledWith(`${baseUrl}/tx/${txid}/outspends`, expect.anything())
    }
  )
})
