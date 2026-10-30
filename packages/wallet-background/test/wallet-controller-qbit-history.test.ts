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

function paymentTx(
  txid: string,
  height: number,
  from: string,
  outputs: { address: string; value: number }[]
) {
  const tx = historyTx(txid, height, [])
  return {
    ...tx,
    vin: [{ ...tx.vin[0]!, prevout: { ...tx.vin[0]!.prevout, scriptpubkey_address: from } }],
    vout: outputs.map(output => ({
      scriptpubkey: '51',
      scriptpubkey_asm: 'OP_PUSHNUM_1',
      scriptpubkey_type: 'v2_p2mr',
      scriptpubkey_address: output.address,
      value: output.value,
    })),
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

  it("pages one immutable snapshot of the selected account's own address", async () => {
    const newest = historyTx('33'.repeat(32), 9, [firstAddress])
    const shared = historyTx('22'.repeat(32), 8, [firstAddress, secondAddress])
    const oldest = historyTx('11'.repeat(32), 7, [firstAddress])
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 3 : 1)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address =>
      address === firstAddress
        ? { confirmed: [newest, shared, oldest], mempool: [] }
        : { confirmed: [shared], mempool: [] }
    )
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [newest, shared, oldest] : [shared]
    )

    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 2,
    })
    const secondPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 2,
      limit: 2,
      snapshotId: firstPage.snapshotId,
    })

    expect(firstPage.scopeKey).toBe(`qbit-account:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`)
    expect(firstPage.total).toBe(3)
    expect(firstPage.detail.map(item => item.txid)).toEqual(['33'.repeat(32), '22'.repeat(32)])
    expect(secondPage).toMatchObject({
      total: 3,
      snapshotId: firstPage.snapshotId,
      detail: [{ txid: '11'.repeat(32) }],
    })
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(1)
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledWith(firstAddress, expect.anything())
    expect(preferenceService.updateAddressHistory).toHaveBeenCalledWith(
      firstPage.scopeKey,
      [
        expect.objectContaining({ txid: '33'.repeat(32) }),
        expect.objectContaining({ txid: '22'.repeat(32) }),
        expect.objectContaining({ txid: '11'.repeat(32) }),
      ]
    )
  })

  it("leaves another account's transactions out of the selected account's history", async () => {
    const firstOnly = historyTx('61'.repeat(32), 9, [firstAddress])
    const secondOnly = historyTx('62'.repeat(32), 8, [secondAddress])
    const histories: Record<string, unknown[]> = {
      [firstAddress]: [firstOnly],
      [secondAddress]: [secondOnly],
    }
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, histories[address]?.length ?? 0)
    )
    apiMocks.client.getAddressHistory.mockImplementation(async address => ({
      confirmed: histories[address] ?? [],
      mempool: [],
    }))
    apiMocks.client.getAddressTxs.mockImplementation(async address => histories[address] ?? [])

    selectedAccount = keyring.accounts[1]!
    const page = await controller.getAddressHistory({ address: secondAddress, start: 0, limit: 20 })

    expect(page.total).toBe(1)
    expect(page.detail.map(item => item.txid)).toEqual([secondOnly.txid])
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(1)
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledWith(secondAddress, expect.anything())
  })

  it('shows a payment between two accounts as a send in one and a receive in the other', async () => {
    const payment = paymentTx('63'.repeat(32), 9, firstAddress, [
      { address: secondAddress, value: 60 },
      { address: firstAddress, value: 31 },
    ])
    apiMocks.client.getAddressStats.mockImplementation(async address => stats(address, 1))
    apiMocks.client.getAddressHistory.mockResolvedValue({ confirmed: [payment], mempool: [] })
    apiMocks.client.getAddressTxs.mockResolvedValue([payment])

    const sent = await controller.getAddressHistory({ address: firstAddress, start: 0, limit: 20 })
    selectedAccount = keyring.accounts[1]!
    const received = await controller.getAddressHistory({
      address: secondAddress,
      start: 0,
      limit: 20,
    })

    expect(sent.detail).toMatchObject([
      {
        txid: payment.txid,
        direction: 'send',
        amount: 60,
        netAmount: -70,
        counterparties: [secondAddress],
        vin: [{ address: firstAddress, owned: true }],
        vout: [
          { address: secondAddress, owned: false },
          { address: firstAddress, owned: true },
        ],
      },
    ])
    expect(received.detail).toMatchObject([
      {
        txid: payment.txid,
        direction: 'receive',
        amount: 60,
        netAmount: 60,
        counterparties: [firstAddress],
        vin: [{ address: firstAddress, owned: false }],
        vout: [
          { address: secondAddress, owned: true },
          { address: firstAddress, owned: false },
        ],
      },
    ])
  })

  it("keys each account's history apart and refuses one account's snapshot for another", async () => {
    const tx = historyTx('64'.repeat(32), 9, [firstAddress, secondAddress])
    apiMocks.client.getAddressStats.mockImplementation(async address => stats(address, 1))
    apiMocks.client.getAddressHistory.mockResolvedValue({ confirmed: [tx], mempool: [] })
    apiMocks.client.getAddressTxs.mockResolvedValue([tx])

    const first = await controller.getAddressHistory({ address: firstAddress, start: 0, limit: 20 })
    selectedAccount = keyring.accounts[1]!
    const second = await controller.getAddressHistory({
      address: secondAddress,
      start: 0,
      limit: 20,
    })

    expect(first.scopeKey).toBe(`qbit-account:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`)
    expect(second.scopeKey).toBe(`qbit-account:${ChainType.QBIT_TESTNET4}:${'22'.repeat(32)}`)
    await expect(
      controller.getAddressHistory({
        address: secondAddress,
        start: 0,
        limit: 20,
        snapshotId: first.snapshotId,
      })
    ).rejects.toThrow('stale or belongs to another account')
    selectedAccount = keyring.accounts[0]!
    await expect(
      controller.getAddressHistory({
        address: firstAddress,
        start: 0,
        limit: 20,
        snapshotId: second.snapshotId,
      })
    ).rejects.toThrow('stale or belongs to another account')

    // A refresh never reuses the other account's snapshot: it scans afresh.
    selectedAccount = keyring.accounts[1]!
    apiMocks.client.getAddressHistory.mockClear()
    const refreshed = await controller.getAddressHistory({
      address: secondAddress,
      start: 0,
      limit: 20,
      refreshSnapshotId: first.snapshotId,
    })
    expect(refreshed.scopeKey).toBe(second.scopeKey)
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledOnce()
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledWith(secondAddress, expect.anything())
  })

  it('refuses a read for an account that is not selected before reading the explorer', async () => {
    await expect(
      controller.getAddressHistory({ address: secondAddress, start: 0, limit: 20 })
    ).rejects.toThrow('Requested Qbit history address is not the selected account')
    await expect(controller.getAddressCacheHistory(secondAddress)).rejects.toThrow(
      'Requested Qbit history address is not the selected account'
    )

    expect(apiMocks.client.getTipHash).not.toHaveBeenCalled()
    expect(apiMocks.client.getAddressStats).not.toHaveBeenCalled()
    expect(apiMocks.client.getAddressHistory).not.toHaveBeenCalled()
    expect(preferenceService.getAddressHistory).not.toHaveBeenCalled()
  })

  it('ends a refresh whose account changes during the revision probe without a full scan', async () => {
    const tx = historyTx('68'.repeat(32), 7, [firstAddress])
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 1 : 0)
    )
    apiMocks.client.getAddressHistory.mockResolvedValue({ confirmed: [tx], mempool: [] })
    apiMocks.client.getAddressTxs.mockResolvedValue([tx])
    const firstPage = await controller.getAddressHistory({
      address: firstAddress,
      start: 0,
      limit: 20,
    })
    apiMocks.client.getAddressHistory.mockClear()
    vi.mocked(preferenceService.updateAddressHistory).mockClear()
    apiMocks.client.getAddressTxs.mockImplementation(async () => {
      selectedAccount = keyring.accounts[1]!
      return [tx]
    })

    await expect(
      controller.getAddressHistory({
        address: firstAddress,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })
    ).rejects.toThrow('Qbit history account or network changed while loading')
    expect(apiMocks.client.getAddressHistory).not.toHaveBeenCalled()
    expect(preferenceService.updateAddressHistory).not.toHaveBeenCalled()
  })

  it('drops a read that finishes after the selected account changes', async () => {
    const tx = historyTx('65'.repeat(32), 9, [firstAddress])
    const pendingScans: (() => void)[] = []
    const finishScan = () => pendingScans.forEach(finish => finish())
    const scanStarted = new Promise<void>(resolve => {
      apiMocks.client.getAddressHistory.mockImplementation(
        address =>
          new Promise(done => {
            pendingScans.push(() =>
              done({ confirmed: address === firstAddress ? [tx] : [], mempool: [] })
            )
            resolve()
          })
      )
    })
    apiMocks.client.getAddressStats.mockImplementation(async address =>
      stats(address, address === firstAddress ? 1 : 0)
    )
    apiMocks.client.getAddressTxs.mockImplementation(async address =>
      address === firstAddress ? [tx] : []
    )

    const read = controller.getAddressHistory({ address: firstAddress, start: 0, limit: 20 })
    const settled = read.catch(error => error)
    await scanStarted
    selectedAccount = keyring.accounts[1]!
    finishScan()

    await expect(settled).resolves.toMatchObject({
      message: 'Qbit history account or network changed while loading',
    })
    expect(preferenceService.updateAddressHistory).not.toHaveBeenCalled()
  })

  it('never reads history cached under the earlier wallet-wide key as an account history', async () => {
    const combinedRows = [
      { txid: '66'.repeat(32), direction: 'self' },
      { txid: '67'.repeat(32), direction: 'self' },
    ] as any
    const persisted = new Map<string, ReturnType<typeof preferenceService.getAddressHistory>>([
      [`qbit:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`, combinedRows],
    ])
    vi.mocked(preferenceService.getAddressHistory).mockImplementation(
      key => persisted.get(key) ?? []
    )

    await expect(controller.getAddressCacheHistory(firstAddress)).resolves.toEqual([])
    selectedAccount = keyring.accounts[1]!
    await expect(controller.getAddressCacheHistory(secondAddress)).resolves.toEqual([])
    expect(preferenceService.getAddressHistory).toHaveBeenCalledWith(
      `qbit-account:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`
    )
    expect(preferenceService.getAddressHistory).toHaveBeenCalledWith(
      `qbit-account:${ChainType.QBIT_TESTNET4}:${'22'.repeat(32)}`
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
    vi.mocked(preferenceService.updateAddressHistory).mockImplementation((key, history) => {
      persistedHistory.set(key, history)
    })
    vi.mocked(preferenceService.getAddressHistory).mockImplementation(
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
    const cachedHistory = await controller.getAddressCacheHistory(firstAddress)
    selectedAccount = keyring.accounts[1]!
    const otherAccountHistory = await controller.getAddressCacheHistory(secondAddress)

    expect(preferenceService.updateAddressHistory).toHaveBeenCalledWith(page.scopeKey, page.detail)
    expect(preferenceService.getAddressHistory).toHaveBeenCalledWith(page.scopeKey)
    expect(cachedHistory).toEqual(page.detail)
    expect(otherAccountHistory).toEqual([])
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

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(1)
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

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(2)
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

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(2)
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

    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(2)
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

      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(2)
      expect(apiMocks.client.getAddressTxs).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('full-scans a refresh when the tip drops below a cached confirmed height', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const confirmedTx = historyTx('59'.repeat(32), 7, [firstAddress])
      apiMocks.client.getAddressStats.mockImplementation(async address =>
        stats(address, address === firstAddress ? 1 : 0)
      )
      apiMocks.client.getAddressHistory.mockImplementation(async address => ({
        confirmed: address === firstAddress ? [confirmedTx] : [],
        mempool: [],
      }))
      apiMocks.client.getAddressTxs.mockImplementation(async address =>
        address === firstAddress ? [confirmedTx] : []
      )

      const firstPage = await controller.getAddressHistory({
        address: firstAddress,
        start: 0,
        limit: 20,
      })
      expect(firstPage.detail).toMatchObject([{ txid: confirmedTx.txid, confirmations: 4 }])

      // The explorer still lists the transaction while the tip has dropped
      // below its block: the activity matches, but reusing the cached list
      // would clamp the reverted transaction to one confirmation.
      apiMocks.client.getAddressHistory.mockClear()
      apiMocks.client.getTipHeight.mockReset().mockResolvedValue(6)

      now.mockReturnValue(61_000)
      const refreshed = await controller.getAddressHistory({
        address: firstAddress,
        start: 0,
        limit: 20,
        refreshSnapshotId: firstPage.snapshotId,
      })

      expect(apiMocks.client.getAddressHistory).toHaveBeenCalledOnce()
      expect(refreshed.snapshotId).not.toBe(firstPage.snapshotId)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps plain snapshots scoped and full-scans a refresh after the wallet changes', async () => {
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
    expect(apiMocks.client.getAddressHistory).toHaveBeenCalledTimes(2)
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
