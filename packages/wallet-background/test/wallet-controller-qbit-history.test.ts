import { beforeEach, describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import { KeyringType } from '@qbit/keyring-service/types'
import type { Account, WalletKeyring } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { preferenceService } from '../src/services'

const apiMocks = vi.hoisted(() => {
  const client = {
    getAddressHistory: vi.fn(),
    getAddressMempoolTxs: vi.fn(),
    getAddressStats: vi.fn(),
    getAddressTxs: vi.fn(),
    getTipHash: vi.fn(),
    getTipHeight: vi.fn(),
    getTxStatus: vi.fn(),
    getTxHex: vi.fn(),
  }
  return {
    client,
    EsploraClient: vi.fn(() => client),
    MempoolQbitClient: vi.fn(() => client),
  }
})

vi.mock('@qbit-oss/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@qbit-oss/api')>()
  return {
    ...actual,
    EsploraClient: apiMocks.EsploraClient,
    MempoolQbitClient: apiMocks.MempoolQbitClient,
  }
})

vi.mock('../src/services', () => ({
  keyringService: { keyrings: [] },
  preferenceService: {
    getChainType: vi.fn(() => ChainType.QBIT_TESTNET4),
    getCurrentAccount: vi.fn(),
    getAddressHistory: vi.fn(),
    updateAddressHistory: vi.fn(),
  },
  walletApiService: { setClientAddress: vi.fn() },
  sessionService: {},
  contactBookService: {},
  notificationService: {},
  permissionService: {},
  phishingDetectService: {},
  qbitSendGuardService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

const firstAddress = 'tq1zhistoryfirst'
const secondAddress = 'tq1zhistorysecond'
const externalAddress = 'tq1zhistoryexternal'
const tipHash = 'ff'.repeat(32)

function account(index: number, pubkey: string, address: string): Account {
  return {
    type: KeyringType.QbitHdKeyring,
    pubkey,
    address,
    index,
    key: `keyring_0#${index}`,
    flag: 0,
    p2mr: {
      pubkey,
      path: `m/87'/1'/0'/0/${index}`,
      scriptPubKey: `5220${pubkey}`,
      leafScript: '20',
      addresses: {
        mainnet: `qb-${index}`,
        testnet4: address,
        signet: `tqs-${index}`,
        regtest: `qbrt-${index}`,
      },
      hkdf: { account: 0, change: 0, index },
      signatureCounter: {
        count: 0,
        limit: 1 << 30,
        remaining: 1 << 30,
        state: 'normal',
        provenance: 'local',
      },
    },
  }
}

function historyTx(txid: string, height: number, ownedAddresses: string[]) {
  return {
    txid,
    version: 2,
    locktime: 0,
    vin: [
      {
        txid: 'aa'.repeat(32),
        vout: 0,
        prevout: {
          scriptpubkey: '51',
          scriptpubkey_asm: 'OP_PUSHNUM_1',
          scriptpubkey_type: 'v2_p2mr',
          scriptpubkey_address: externalAddress,
          value: 101,
        },
        scriptsig: '',
        scriptsig_asm: '',
        is_coinbase: false,
        sequence: 0xfffffffd,
      },
    ],
    vout: ownedAddresses.map((address, index) => ({
      scriptpubkey: '51',
      scriptpubkey_asm: 'OP_PUSHNUM_1',
      scriptpubkey_type: 'v2_p2mr',
      scriptpubkey_address: address,
      value: index === 0 ? 45 : 46,
    })),
    size: 100,
    weight: 100,
    fee: 10,
    status: {
      confirmed: true,
      block_height: height,
      block_hash: height.toString(16).padStart(64, '0'),
      block_time: height,
    },
  }
}

function stats(address: string, confirmed: number, mempool = 0) {
  return {
    address,
    chain_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: confirmed,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: mempool,
    },
  }
}

describe('WalletController Qbit account history snapshots', () => {
  let controller: WalletController
  let selectedAccount: Account
  let keyring: WalletKeyring

  beforeEach(() => {
    vi.clearAllMocks()
    const first = account(0, '11'.repeat(32), firstAddress)
    const second = account(1, '22'.repeat(32), secondAddress)
    selectedAccount = first
    keyring = {
      key: 'keyring_0',
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: 9,
      accounts: [first, second],
      alianName: 'Qbit Wallet',
      hdPath: "m/87'/1'/0'/0",
    }
    controller = new WalletController()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(preferenceService.getCurrentAccount).mockImplementation(() => selectedAccount as any)
    vi.spyOn(controller, 'getCurrentKeyring').mockImplementation(async () => keyring)
    apiMocks.client.getTipHash.mockResolvedValue(tipHash)
    apiMocks.client.getTipHeight.mockResolvedValue(10)
    apiMocks.client.getAddressMempoolTxs.mockResolvedValue([])
    apiMocks.client.getAddressTxs.mockResolvedValue([])
  })

  it('paginates one immutable globally deduplicated snapshot across receive-address rotation', async () => {
    const newest = historyTx('33'.repeat(32), 9, [firstAddress])
    const shared = historyTx('22'.repeat(32), 8, [firstAddress, secondAddress])
    const oldest = historyTx('11'.repeat(32), 7, [secondAddress])
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 2 : 2)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address =>
      address === firstAddress
        ? { confirmed: [newest, shared], mempool: [] }
        : { confirmed: [shared, oldest], mempool: [] }
    )
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [newest, shared] : [shared, oldest]
    )

    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 2,
    })
    selectedAccount = keyring.accounts[1]!
    const secondPage = await controller.getAddressHistory({
      address: secondAddress,
      start: 2,
      limit: 2,
      snapshotId: firstPage.snapshotId,
    })

    expect(firstPage.scopeKey).toBe(`qbit:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`)
    expect(firstPage.total).toBe(3)
    expect(firstPage.detail.map(item => item.txid)).toEqual(['33'.repeat(32), '22'.repeat(32)])
    expect(secondPage).toMatchObject({
      total: 3,
      snapshotId: firstPage.snapshotId,
      detail: [{ txid: '11'.repeat(32) }],
    })
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(2)
    expect(preferenceService.updateAddressHistory).toHaveBeenCalledWith(
      firstPage.scopeKey,
      expect.arrayContaining([
        expect.objectContaining({ txid: '33'.repeat(32) }),
        expect.objectContaining({ txid: '22'.repeat(32) }),
        expect.objectContaining({ txid: '11'.repeat(32) }),
      ])
    )
  })

  it('rejects later pages without a pinned snapshot instead of rescanning the account', async () => {
    await expect(
      controller.getAddressHistory({
        address: firstAddress,
        start: 20,
        limit: 20,
      })
    ).rejects.toThrow('Qbit history pages beyond the first require a pinned snapshot')
    expect(apiMocks.client.getAddressHistory).not.toHaveBeenCalled()
    expect(apiMocks.client.getAddressStats).not.toHaveBeenCalled()
  })

  it('persists only a fixed first-page cache while retaining the complete snapshot', async () => {
    const transactions = Array.from({ length: 21 }, (_, index) =>
      historyTx((index + 1).toString(16).padStart(64, '0'), 30 - index, [firstAddress])
    )
    apiMocks.client.getTipHeight.mockResolvedValue(30)
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? transactions.length : 0)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: address === firstAddress ? transactions : [],
      mempool: [],
    }))
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? transactions.slice(0, 25) : []
    )

    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 1,
    })
    const lastPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 20,
      limit: 1,
      snapshotId: firstPage.snapshotId,
    })

    expect(firstPage).toMatchObject({
      total: 21,
      detail: [{ txid: transactions[0]!.txid }],
    })
    expect(lastPage).toMatchObject({
      total: 21,
      detail: [{ txid: transactions[20]!.txid }],
    })
    expect(preferenceService.updateAddressHistory).toHaveBeenCalledTimes(1)
    const [persistedScopeKey, persistedHistory] = vi.mocked(
      preferenceService.updateAddressHistory
    ).mock.calls[0]!
    expect(persistedScopeKey).toBe(firstPage.scopeKey)
    expect(persistedHistory.map(item => item.txid)).toEqual(
      transactions.slice(0, 20).map(transaction => transaction.txid)
    )
  })

  it('reads persisted Qbit history with the same account scope key used for writes', async () => {
    const tx = historyTx('41'.repeat(32), 9, [firstAddress])
    const persistedHistory = new Map<
      string,
      ReturnType<typeof preferenceService.getAddressHistory>
    >()
    vi.mocked(preferenceService.updateAddressHistory).mockImplementationOnce((key, history) => {
      persistedHistory.set(key, history)
    })
    vi.mocked(preferenceService.getAddressHistory).mockImplementationOnce(
      key => persistedHistory.get(key) ?? []
    )
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 1 : 0)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: address === firstAddress ? [tx] : [],
      mempool: [],
    }))
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [tx] : []
    )

    const page = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
    })
    const cachedHistory = await controller.getAddressCacheHistory(secondAddress)

    expect(preferenceService.updateAddressHistory).toHaveBeenCalledWith(page.scopeKey, page.detail)
    expect(preferenceService.getAddressHistory).toHaveBeenCalledWith(page.scopeKey)
    expect(cachedHistory).toEqual(page.detail)
  })

  it('keeps non-Qbit cache reads address-keyed and skips storage for an empty address', async () => {
    const cachedAddress = 'address-keyed-entry'
    const cachedHistory = [{ txid: 'cached' }] as any
    vi.mocked(preferenceService.getChainType).mockReturnValue('UNKNOWN_CHAIN' as ChainType)
    vi.mocked(preferenceService.getAddressHistory).mockReturnValueOnce(cachedHistory)

    await expect(controller.getAddressCacheHistory(cachedAddress)).resolves.toBe(cachedHistory)
    expect(preferenceService.getAddressHistory).toHaveBeenCalledWith(cachedAddress)

    await expect(controller.getAddressCacheHistory(undefined)).resolves.toEqual([])
    expect(preferenceService.getAddressHistory).toHaveBeenCalledTimes(1)
  })

  it('reuses an unchanged recent revision under a new immutable snapshot identity', async () => {
    const tx = historyTx('51'.repeat(32), 7, [firstAddress])
    const older = historyTx('50'.repeat(32), 6, [firstAddress])
    apiMocks.client.getTipHeight.mockResolvedValueOnce(10).mockResolvedValue(11)
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 2 : 0)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: address === firstAddress ? [tx, older] : [],
      mempool: [],
    }))
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [tx, older] : []
    )

    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
    })
    const refreshed = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
      refreshSnapshotId: firstPage.snapshotId,
    })
    const originalPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
      snapshotId: firstPage.snapshotId,
    })

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(2)
    expect(refreshed).toMatchObject({
      total: firstPage.total,
      detail: [
        { txid: tx.txid, confirmations: 5 },
        { txid: older.txid, confirmations: 6 },
      ],
    })
    expect(refreshed.detail.map(item => item.txid)).toEqual(firstPage.detail.map(item => item.txid))
    expect(refreshed.snapshotId).not.toBe(firstPage.snapshotId)
    expect(originalPage).toMatchObject({
      snapshotId: firstPage.snapshotId,
      detail: [
        { txid: tx.txid, confirmations: 4 },
        { txid: older.txid, confirmations: 5 },
      ],
    })
    expect(vi.mocked(preferenceService.updateAddressHistory)).toHaveBeenLastCalledWith(
      firstPage.scopeKey,
      [
        expect.objectContaining({ txid: tx.txid, confirmations: 5 }),
        expect.objectContaining({ txid: older.txid, confirmations: 6 }),
      ]
    )
  })

  it('falls back to a full scan when public address stats change', async () => {
    const tx = historyTx('52'.repeat(32), 7, [firstAddress])
    let funded = false
    apiMocks.client.getAddressStats.mockImplementation(async address => {
      const value = stats(address, address === firstAddress ? 1 : 0)
      return address === firstAddress && funded
        ? {
            ...value,
            chain_stats: {
              ...value.chain_stats,
              funded_txo_count: 1,
              funded_txo_sum: 1,
            },
          }
        : value
    })
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: address === firstAddress ? [tx] : [],
      mempool: [],
    }))
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [tx] : []
    )
    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
    })

    funded = true
    await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
      refreshSnapshotId: firstPage.snapshotId,
    })

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(4)
  })

  it('falls back to a full scan when a same-size mempool identity changes', async () => {
    const original = {
      ...historyTx('53'.repeat(32), 0, [firstAddress]),
      status: { confirmed: false },
    }
    const replacement = {
      ...original,
      txid: '54'.repeat(32),
    }
    let current = original
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, 0, address === firstAddress ? 1 : 0)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: [],
      mempool: address === firstAddress ? [current] : [],
    }))
    apiMocks.client.getAddressMempoolTxs.mockImplementation(async address =>
      address === firstAddress ? [current] : []
    )
    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
    })

    current = replacement
    const refreshed = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
      refreshSnapshotId: firstPage.snapshotId,
    })

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(4)
    expect(refreshed.detail).toMatchObject([{ txid: replacement.txid }])
  })

  it('falls back to a full scan when recent confirmed status changes', async () => {
    let current = historyTx('55'.repeat(32), 7, [firstAddress])
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 1 : 0)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: address === firstAddress ? [current] : [],
      mempool: [],
    }))
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [current] : []
    )
    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
    })

    current = {
      ...current,
      status: {
        ...current.status,
        block_height: 6,
        block_hash: 'ab'.repeat(32),
      },
    }
    await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
      refreshSnapshotId: firstPage.snapshotId,
    })

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(4)
  })

  it('forces a full scan when the original full-scan revision reaches its age bound', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const tx = historyTx('56'.repeat(32), 7, [firstAddress])
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(address, address === firstAddress ? 1 : 0)
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: address === firstAddress ? [tx] : [],
        mempool: [],
      }))
      apiMocks.client.getAddressTxs.mockImplementation(async address =>
        address === firstAddress ? [tx] : []
      )
      const firstPage = await controller.getAddressHistory({
        address: firstAddress,
        start: 0,
        limit: 20,
      })

      now.mockReturnValue(301_001)
      await controller.getAddressHistory({
        address: firstAddress,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(4)
      expect(apiMocks.client.getAddressTxs).toHaveBeenCalledTimes(4)
    } finally {
      now.mockRestore()
    }
  })

  it('probes every large-account mempool address while reusing confirmed ancestry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const largeAccounts = Array.from({ length: 33 }, (_, index) =>
        account(index, (index + 1).toString(16).padStart(64, '0'), `tq1zhistorylarge-${index}`)
      )
      keyring = {
        ...keyring,
        accounts: largeAccounts,
      }
      selectedAccount = largeAccounts[0]!
      const firstTx = historyTx('57'.repeat(32), 7, [largeAccounts[0]!.address])
      const laterTx = historyTx('58'.repeat(32), 10, [largeAccounts[32]!.address])
      const confirmedByAddress = new Map(
        largeAccounts.map(item => [
          item.address,
          item.address === largeAccounts[0]!.address ? [firstTx] : [],
        ])
      )
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(address, confirmedByAddress.get(address)?.length ?? 0)
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: confirmedByAddress.get(address) ?? [],
        mempool: [],
      }))
      apiMocks.client.getAddressTxs.mockImplementation(async address =>
        (confirmedByAddress.get(address) ?? []).slice(0, 25)
      )

      const firstPage = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
      })
      apiMocks.client.getAddressHistory.mockClear()
      apiMocks.client.getAddressMempoolTxs.mockClear()
      apiMocks.client.getAddressStats.mockClear()
      apiMocks.client.getAddressTxs.mockClear()
      apiMocks.client.getTipHash.mockClear()
      apiMocks.client.getTipHeight.mockClear()

      now.mockReturnValue(61_000)
      const unchangedTipRefresh = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(unchangedTipRefresh).toMatchObject({
        total: 1,
        detail: [{ txid: firstTx.txid, confirmations: 4 }],
      })
      expect(apiMocks.client.getTipHeight).toHaveBeenCalledTimes(1)
      expect(apiMocks.client.getTipHash).toHaveBeenCalledTimes(2)
      expect(apiMocks.client.getTxStatus).not.toHaveBeenCalled()
      expect(apiMocks.client.getAddressMempoolTxs).toHaveBeenCalledTimes(
        largeAccounts.length * 2
      )
      for (const item of largeAccounts) {
        expect(
          apiMocks.client.getAddressMempoolTxs.mock.calls.filter(
            ([calledAddress]) => calledAddress === item.address
          )
        ).toHaveLength(2)
      }
      expect(apiMocks.client.getAddressHistory).not.toHaveBeenCalled()

      confirmedByAddress.set(largeAccounts[32]!.address, [laterTx])
      apiMocks.client.getTipHash.mockClear()
      apiMocks.client.getTipHeight.mockClear()
      apiMocks.client.getTxStatus.mockClear()
      apiMocks.client.getAddressMempoolTxs.mockClear()
      apiMocks.client.getTipHash.mockResolvedValue('ee'.repeat(32))
      apiMocks.client.getTipHeight.mockResolvedValueOnce(11)
      apiMocks.client.getTxStatus.mockResolvedValue(firstTx.status)

      now.mockReturnValue(121_000)
      const refreshed = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: unchangedTipRefresh.snapshotId,
      })

      expect(refreshed).toMatchObject({
        total: 1,
        detail: [{ txid: firstTx.txid, confirmations: 5 }],
      })
      expect(refreshed.snapshotId).not.toBe(firstPage.snapshotId)
      expect(apiMocks.client.getTipHeight).toHaveBeenCalledTimes(1)
      expect(apiMocks.client.getTipHash).toHaveBeenCalledTimes(2)
      expect(apiMocks.client.getTxStatus).toHaveBeenCalledOnce()
      expect(apiMocks.client.getTxStatus).toHaveBeenCalledWith(firstTx.txid)
      expect(apiMocks.client.getAddressStats).not.toHaveBeenCalled()
      expect(apiMocks.client.getAddressMempoolTxs).toHaveBeenCalledTimes(
        largeAccounts.length * 2
      )
      expect(apiMocks.client.getAddressTxs).not.toHaveBeenCalled()
      expect(apiMocks.client.getAddressHistory).not.toHaveBeenCalled()

      apiMocks.client.getTipHeight.mockClear()
      apiMocks.client.getTipHeight.mockRejectedValueOnce(new Error('tip unavailable'))
      now.mockReturnValue(181_000)
      await expect(
        controller.getAddressHistory({
          address: largeAccounts[0]!.address,
          start: 0,
          limit: 20,
          refreshSnapshotId: refreshed.snapshotId,
        })
      ).rejects.toThrow('tip unavailable')
      expect(apiMocks.client.getAddressHistory).not.toHaveBeenCalled()

      apiMocks.client.getTipHeight.mockReset().mockResolvedValueOnce(-1)
      now.mockReturnValue(241_000)
      await expect(
        controller.getAddressHistory({
          address: largeAccounts[0]!.address,
          start: 0,
          limit: 20,
          refreshSnapshotId: refreshed.snapshotId,
        })
      ).rejects.toThrow('invalid qbit tip height')
      expect(apiMocks.client.getAddressHistory).not.toHaveBeenCalled()

      apiMocks.client.getTipHeight.mockReset().mockResolvedValue(12)
      now.mockReturnValue(301_001)
      const fullRefresh = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: refreshed.snapshotId,
      })

      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(largeAccounts.length)
      expect(fullRefresh.total).toBe(2)
      expect(fullRefresh.detail.map(item => item.txid)).toEqual([laterTx.txid, firstTx.txid])
    } finally {
      now.mockRestore()
    }
  })

  it('full-scans a large confirmed account when pending membership changes at the same tip', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const largeAccounts = Array.from({ length: 33 }, (_, index) =>
        account(index, (index + 1).toString(16).padStart(64, '0'), `tq1zhistorylarge-${index}`)
      )
      keyring = {
        ...keyring,
        accounts: largeAccounts,
      }
      selectedAccount = largeAccounts[0]!
      const confirmedTx = historyTx('5e'.repeat(32), 7, [largeAccounts[0]!.address])
      const pendingTx = {
        ...historyTx('5f'.repeat(32), 0, [largeAccounts[32]!.address]),
        status: { confirmed: false },
      }
      let hasPending = false
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(
          address,
          address === largeAccounts[0]!.address ? 1 : 0,
          hasPending && address === largeAccounts[32]!.address ? 1 : 0
        )
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: address === largeAccounts[0]!.address ? [confirmedTx] : [],
        mempool: hasPending && address === largeAccounts[32]!.address ? [pendingTx] : [],
      }))
      apiMocks.client.getAddressMempoolTxs.mockImplementation(async address =>
        hasPending && address === largeAccounts[32]!.address ? [pendingTx] : []
      )
      apiMocks.client.getAddressTxs.mockImplementation(async address =>
        address === largeAccounts[0]!.address ? [confirmedTx] : []
      )

      const firstPage = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
      })
      expect(firstPage.detail).toMatchObject([{ txid: confirmedTx.txid, confirmations: 4 }])

      hasPending = true
      apiMocks.client.getAddressHistory.mockClear()
      now.mockReturnValue(61_000)
      const refreshed = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(apiMocks.client.getTxStatus).not.toHaveBeenCalled()
      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(largeAccounts.length)
      expect(refreshed.detail.map(item => item.txid)).toEqual([pendingTx.txid, confirmedTx.txid])
    } finally {
      now.mockRestore()
    }
  })

  it('full-scans a large pending-only account refresh when the tip changes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const largeAccounts = Array.from({ length: 33 }, (_, index) =>
        account(index, (index + 1).toString(16).padStart(64, '0'), `tq1zhistorylarge-${index}`)
      )
      keyring = {
        ...keyring,
        accounts: largeAccounts,
      }
      selectedAccount = largeAccounts[0]!
      const original = {
        ...historyTx('5c'.repeat(32), 0, [largeAccounts[0]!.address]),
        status: { confirmed: false },
      }
      const replacement = {
        ...original,
        txid: '5d'.repeat(32),
      }
      let pendingTx = original
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(address, 0, address === largeAccounts[0]!.address ? 1 : 0)
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: [],
        mempool: address === largeAccounts[0]!.address ? [pendingTx] : [],
      }))
      apiMocks.client.getAddressMempoolTxs.mockImplementation(async address =>
        address === largeAccounts[0]!.address ? [pendingTx] : []
      )

      const firstPage = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
      })
      expect(firstPage.detail).toMatchObject([{ txid: original.txid, confirmations: 0 }])

      pendingTx = replacement
      apiMocks.client.getAddressHistory.mockClear()
      apiMocks.client.getTipHash.mockReset().mockResolvedValue('ee'.repeat(32))
      apiMocks.client.getTipHeight.mockReset().mockResolvedValue(11)

      now.mockReturnValue(61_000)
      const refreshed = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(apiMocks.client.getTxStatus).not.toHaveBeenCalled()
      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(largeAccounts.length)
      expect(refreshed.detail).toMatchObject([{ txid: replacement.txid, confirmations: 0 }])
    } finally {
      now.mockRestore()
    }
  })

  it('full-scans a large-account refresh when a same-height reorg removes cached history', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const largeAccounts = Array.from({ length: 33 }, (_, index) =>
        account(index, (index + 1).toString(16).padStart(64, '0'), `tq1zhistorylarge-${index}`)
      )
      keyring = {
        ...keyring,
        accounts: largeAccounts,
      }
      selectedAccount = largeAccounts[0]!
      const confirmedTx = historyTx('5a'.repeat(32), 7, [largeAccounts[0]!.address])
      const confirmedByAddress = new Map(
        largeAccounts.map(item => [
          item.address,
          item.address === largeAccounts[0]!.address ? [confirmedTx] : [],
        ])
      )
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(address, confirmedByAddress.get(address)?.length ?? 0)
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: confirmedByAddress.get(address) ?? [],
        mempool: [],
      }))
      apiMocks.client.getAddressTxs.mockImplementation(async address =>
        (confirmedByAddress.get(address) ?? []).slice(0, 25)
      )

      const firstPage = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
      })
      expect(firstPage.detail).toMatchObject([{ txid: confirmedTx.txid, confirmations: 4 }])

      confirmedByAddress.set(largeAccounts[0]!.address, [])
      apiMocks.client.getAddressHistory.mockClear()
      apiMocks.client.getTipHash.mockReset().mockResolvedValue('dd'.repeat(32))
      apiMocks.client.getTipHeight.mockReset().mockResolvedValue(10)

      now.mockReturnValue(61_000)
      const refreshed = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(apiMocks.client.getTxStatus).not.toHaveBeenCalled()
      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(largeAccounts.length)
      expect(refreshed.total).toBe(0)
      expect(refreshed.detail).toEqual([])
      expect(refreshed.snapshotId).not.toBe(firstPage.snapshotId)
    } finally {
      now.mockRestore()
    }
  })

  it('full-scans a large-account refresh when an advancing tip no longer has its anchor', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const largeAccounts = Array.from({ length: 33 }, (_, index) =>
        account(index, (index + 1).toString(16).padStart(64, '0'), `tq1zhistorylarge-${index}`)
      )
      keyring = {
        ...keyring,
        accounts: largeAccounts,
      }
      selectedAccount = largeAccounts[0]!
      const confirmedTx = historyTx('5b'.repeat(32), 7, [largeAccounts[0]!.address])
      const confirmedByAddress = new Map(
        largeAccounts.map(item => [
          item.address,
          item.address === largeAccounts[0]!.address ? [confirmedTx] : [],
        ])
      )
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(address, confirmedByAddress.get(address)?.length ?? 0)
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: confirmedByAddress.get(address) ?? [],
        mempool: [],
      }))
      apiMocks.client.getAddressTxs.mockImplementation(async address =>
        (confirmedByAddress.get(address) ?? []).slice(0, 25)
      )

      const firstPage = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
      })

      confirmedByAddress.set(largeAccounts[0]!.address, [])
      apiMocks.client.getAddressHistory.mockClear()
      apiMocks.client.getTipHash.mockReset().mockResolvedValue('cc'.repeat(32))
      apiMocks.client.getTipHeight.mockReset().mockResolvedValue(11)
      apiMocks.client.getTxStatus.mockRejectedValue(
        new QbitApiError('not_found', 'transaction not found')
      )

      now.mockReturnValue(61_000)
      const refreshed = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(apiMocks.client.getTxStatus).toHaveBeenCalledWith(confirmedTx.txid)
      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(largeAccounts.length)
      expect(refreshed.detail).toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('full-scans a large-account refresh when the tip drops below a cached confirmed height', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const largeAccounts = Array.from({ length: 33 }, (_, index) =>
        account(index, (index + 1).toString(16).padStart(64, '0'), `tq1zhistorylarge-${index}`)
      )
      keyring = {
        ...keyring,
        accounts: largeAccounts,
      }
      selectedAccount = largeAccounts[0]!
      const confirmedTx = historyTx('59'.repeat(32), 7, [largeAccounts[0]!.address])
      const confirmedByAddress = new Map(
        largeAccounts.map(item => [
          item.address,
          item.address === largeAccounts[0]!.address ? [confirmedTx] : [],
        ])
      )
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(address, confirmedByAddress.get(address)?.length ?? 0)
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: confirmedByAddress.get(address) ?? [],
        mempool: [],
      }))
      apiMocks.client.getAddressTxs.mockImplementation(async address =>
        (confirmedByAddress.get(address) ?? []).slice(0, 25)
      )

      const firstPage = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
      })
      expect(firstPage.detail).toMatchObject([{ txid: confirmedTx.txid, confirmations: 4 }])

      // A reorg reverts the cached transaction and lowers the tip below its
      // block height; the deferred-probe reuse path must not report it as
      // still confirmed.
      confirmedByAddress.set(largeAccounts[0]!.address, [])
      apiMocks.client.getAddressHistory.mockClear()
      apiMocks.client.getTipHeight.mockReset().mockResolvedValue(6)

      now.mockReturnValue(61_000)
      const refreshed = await controller.getAddressHistory({
        address: largeAccounts[0]!.address,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(largeAccounts.length)
      expect(refreshed.total).toBe(0)
      expect(refreshed.detail).toEqual([])
      expect(refreshed.snapshotId).not.toBe(firstPage.snapshotId)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps plain snapshots scoped and full-scans a refresh after the logical account changes', async () => {
    const tx = historyTx('11'.repeat(32), 7, [firstAddress])
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 1 : 0)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: address === firstAddress ? [tx] : [],
      mempool: [],
    }))
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [tx] : []
    )
    const page = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
    })

    const unrelated = account(0, '44'.repeat(32), 'tq1zunrelated')
    keyring = {
      ...keyring,
      key: 'keyring_1',
      index: 1,
      accounts: [unrelated],
    }
    selectedAccount = unrelated

    await expect(
      controller.getAddressHistory({
        address: unrelated.address,
        start: 0,
        limit: 20,
        snapshotId: page.snapshotId,
      })
    ).rejects.toThrow('stale or belongs to another account')

    const refreshed = await controller.getAddressHistory({
      address: unrelated.address,
      start: 0,
      limit: 20,
      refreshSnapshotId: page.snapshotId,
    })
    expect(refreshed.snapshotId).not.toBe(page.snapshotId)
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(3)
  })

  it('validates raw hex at the background boundary and returns exact bytes', async () => {
    const raw =
      '0200000000010111111111111111111111111111111111111111111111111111111111111111110100000000fdffffff01d20400000000000022522022222222222222222222222222222222222222222222222222222222222222220204aabbccdd015100000000'
    const txid = 'af3874efbf6ee007cf7450b79b7d2dcc18bb9efc6a908bbeaa44fd22eb447c12'
    apiMocks.client.getTxHex.mockResolvedValue(raw)

    await expect(controller.getQbitRawTransactionHex(txid.toUpperCase())).resolves.toBe(raw)
    expect(apiMocks.client.getTxHex).toHaveBeenCalledWith(txid)
  })
})
