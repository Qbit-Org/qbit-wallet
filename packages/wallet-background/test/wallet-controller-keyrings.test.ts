import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { BUS_EVENTS, BUS_METHODS, SESSION_EVENTS } from '@qbit/wallet-shared'
import { AddressType, ChainType, NetworkType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController, canDeriveAddressFromPublicKey } from '../src/controllers/wallet'
import {
  keyringService,
  permissionService,
  preferenceService,
  sessionService,
  walletApiService,
} from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'

vi.mock('../src/services', () => ({
  keyringService: {
    getAllDisplayedKeyrings: vi.fn(),
    createTmpKeyring: vi.fn(),
    displayForKeyring: vi.fn(),
    importPublicKeyOnly: vi.fn(),
    submitPassword: vi.fn(
      async (_password: string, options?: { beforeUnlock?: () => void | Promise<void> }) => {
        await options?.beforeUnlock?.()
      }
    ),
    syncQbitHdPath: vi.fn(),
    rearmQbitRestoreFloors: vi.fn(),
    verifyPassword: vi.fn(),
    keyrings: [],
  },
  preferenceService: {
    getCurrentKeyringIndex: vi.fn(),
    getChainType: vi.fn(() => ChainType.QBIT_MAINNET),
    setCurrentKeyringIndex: vi.fn(),
    setCurrentAccount: vi.fn(),
    getCurrentAccount: vi.fn(),
    getKeyringAlianName: vi.fn((_: string, defaultName: string) => defaultName),
    getAccountAlianName: vi.fn((_: string, defaultName: string) => defaultName),
    getAddressFlag: vi.fn(() => 0),
    getAutoLockTimeId: vi.fn(() => 0),
    getInitAlianNameStatus: vi.fn(() => true),
    setChainType: vi.fn(),
    persist: vi.fn(),
    setShowSafeNotice: vi.fn(),
  },
  walletApiService: {
    setEndpoint: vi.fn(),
    utility: {
      getAppList: vi.fn().mockResolvedValue([]),
      getAppExtra: vi.fn().mockResolvedValue({}),
      getBannerList: vi.fn().mockResolvedValue([]),
      getAppSummary: vi.fn().mockResolvedValue({ apps: [] }),
    },
  },
  sessionService: {
    broadcastEvent: vi.fn(),
    broadcastChainChange: vi.fn(),
  },
  contactBookService: {
    listAlias: vi.fn(() => []),
  },
  notificationService: {},
  permissionService: {
    removeConnectedSite: vi.fn(),
    hasPermission: vi.fn(() => false),
    updateConnectSite: vi.fn(),
  },
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

const validCompressedPubkey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const invalidPubkey = 'aa'.repeat(32)

function createDisplayedKeyring({
  index,
  pubkey,
  type = KeyringType.ReadonlyKeyring,
}: {
  index: number
  pubkey: string
  type?: string
}) {
  return {
    type,
    accounts: [{ pubkey, brandName: type }],
    keyring: {},
    addressType: AddressType.P2WPKH,
    index,
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const flushAsyncWork = () => new Promise(resolve => setTimeout(resolve, 0))

describe('WalletController keyring recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    vi.mocked(preferenceService.getCurrentAccount).mockReset()
    vi.mocked(preferenceService.setChainType).mockReset()
    vi.mocked(preferenceService.persist).mockReset().mockResolvedValue(undefined)
    vi.mocked(keyringService.submitPassword)
      .mockReset()
      .mockImplementation(async (_password, options) => {
        await options?.beforeUnlock?.()
        return {} as any
      })
    vi.mocked(keyringService.syncQbitHdPath).mockReset().mockResolvedValue(false)
    vi.mocked(keyringService.rearmQbitRestoreFloors).mockReset().mockResolvedValue(false)
    vi.mocked(permissionService.removeConnectedSite).mockReset().mockResolvedValue(undefined)
    ;(keyringService.keyrings as any).length = 0
    vi.spyOn(log, 'warn').mockImplementation(() => {})
  })

  it('detects public keys that cannot derive an address', () => {
    expect(
      canDeriveAddressFromPublicKey(validCompressedPubkey, AddressType.P2WPKH, NetworkType.MAINNET)
    ).toBe(true)
    expect(
      canDeriveAddressFromPublicKey(invalidPubkey, AddressType.P2WPKH, NetworkType.MAINNET)
    ).toBe(false)
    expect(
      canDeriveAddressFromPublicKey(invalidPubkey, AddressType.P2MR, NetworkType.MAINNET)
    ).toBe(true)
    expect(
      canDeriveAddressFromPublicKey(validCompressedPubkey, AddressType.P2MR, NetworkType.MAINNET)
    ).toBe(false)
  })

  it('switches to qbit mainnet, updates the endpoint, and preserves change events', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    const wallet = new WalletController()
    const currentAccount = { index: 0 }
    const currentKeyring = { index: 0, accounts: [{ address: 'mainnet-address' }] }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(currentAccount as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    await expect(wallet.setChainType(ChainType.QBIT_MAINNET)).resolves.toBeUndefined()

    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/0'/0'/0")
    expect(preferenceService.setChainType).toHaveBeenCalledWith(ChainType.QBIT_MAINNET)
    expect(walletApiService.setEndpoint).toHaveBeenCalledWith(
      'https://mempool.qbit.org/api'
    )
    expect(changeKeyring).toHaveBeenCalledWith(currentKeyring, currentAccount.index, {
      persistPreference: true,
      broadcastAccountChange: false,
    })
    // Scoped per origin by the session service; nothing is broadcast to all.
    expect(sessionService.broadcastChainChange).toHaveBeenCalledExactlyOnceWith({
      previousChain: ChainType.QBIT_TESTNET4,
      chain: ChainType.QBIT_MAINNET,
      network: 'mainnet',
      accounts: ['mainnet-address'],
    })
    expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
  })

  it('re-arms restored floors before switching between Qbit networks with the same HD path', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    const restoredKeyring = {
      type: KeyringType.QbitHdKeyring,
      pqcFloorsPending: false,
    }
    ;(keyringService.keyrings as any[]).push(restoredKeyring)
    vi.mocked(keyringService.rearmQbitRestoreFloors).mockImplementation(async () => {
      restoredKeyring.pqcFloorsPending = true
      return true
    })
    const wallet = new WalletController()
    const currentAccount = { index: 0 }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(currentAccount as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      index: 0,
      accounts: [currentAccount],
    } as any)
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    const floorScan = vi
      .spyOn(wallet as any, 'performQbitRestoreFloorScan')
      .mockImplementation(async () => {
        expect(preferenceService.getChainType()).toBe(ChainType.QBIT_REGTEST)
        expect(restoredKeyring.pqcFloorsPending).toBe(true)
        restoredKeyring.pqcFloorsPending = false
        return { possibleConcurrentInstance: false }
      })

    await wallet.setChainType(ChainType.QBIT_REGTEST)
    await (wallet as any).chainStateChangeTail

    expect(keyringService.rearmQbitRestoreFloors).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(keyringService.rearmQbitRestoreFloors).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(keyringService.syncQbitHdPath).mock.invocationCallOrder[0]!)
    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/1'/0'/0")
    expect(walletApiService.setEndpoint).toHaveBeenCalledWith('http://127.0.0.1:3002')
    expect(floorScan).toHaveBeenCalledTimes(1)
    expect(restoredKeyring.pqcFloorsPending).toBe(false)
  })

  it('falls back to account zero when the persisted switch index is out of range', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ index: 2 } as any)
    const wallet = new WalletController()
    const getCurrentAccount = vi.spyOn(wallet, 'getCurrentAccount')
    const currentKeyring = { index: 0, accounts: [{ index: 0 }] }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    await expect(wallet.setChainType(ChainType.QBIT_MAINNET)).resolves.toBeUndefined()

    expect(changeKeyring).toHaveBeenCalledWith(currentKeyring, 0, {
      persistPreference: true,
      broadcastAccountChange: false,
    })
    // The selection never consults getCurrentAccount; only the announcement
    // afterwards reads what getAccounts() will return.
    expect(
      getCurrentAccount.mock.invocationCallOrder.every(
        order => order > changeKeyring.mock.invocationCallOrder[0]!
      )
    ).toBe(true)
  })

  it('persists the chain and account selection before publishing switch events', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(0)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({
      index: 0,
      pubkey: 'testnet-pubkey',
      address: 'testnet-address',
    } as any)
    const wallet = new WalletController()
    const targetAccount = {
      index: 0,
      pubkey: 'mainnet-pubkey',
      address: 'mainnet-address',
    }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      index: 0,
      accounts: [targetAccount],
    } as any)
    const persistStarted = deferred()
    const releasePersist = deferred()
    vi.mocked(preferenceService.persist).mockImplementationOnce(async () => {
      persistStarted.resolve()
      await releasePersist.promise
    })
    let switchSettled = false

    const chainSwitch = wallet.setChainType(ChainType.QBIT_MAINNET).finally(() => {
      switchSettled = true
    })
    await persistStarted.promise
    await flushAsyncWork()

    expect(switchSettled).toBe(false)
    expect(preferenceService.setCurrentAccount).toHaveBeenCalledWith(targetAccount)
    expect(sessionService.broadcastChainChange).not.toHaveBeenCalled()
    releasePersist.resolve()
    await chainSwitch

    expect(sessionService.broadcastChainChange).toHaveBeenCalledWith(
      expect.objectContaining({
        previousChain: ChainType.QBIT_TESTNET4,
        chain: ChainType.QBIT_MAINNET,
        accounts: ['mainnet-address'],
      })
    )
  })

  it('rolls back the chain selection when preference persistence fails', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    const previousAccount = {
      index: 0,
      pubkey: 'testnet-pubkey',
      address: 'testnet-address',
    }
    const targetAccount = {
      index: 0,
      pubkey: 'mainnet-pubkey',
      address: 'mainnet-address',
    }
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(3)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(previousAccount as any)
    const wallet = new WalletController()
    const restoredKeyring = {
      type: KeyringType.QbitHdKeyring,
      pqcFloorsPending: false,
    }
    ;(keyringService.keyrings as any[]).push(restoredKeyring)
    vi.mocked(keyringService.syncQbitHdPath).mockImplementation(async () => {
      restoredKeyring.pqcFloorsPending = true
      return true
    })
    const floorScan = vi
      .spyOn(wallet as any, 'performQbitRestoreFloorScan')
      .mockResolvedValue(undefined as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      index: 1,
      accounts: [targetAccount],
    } as any)
    const failure = new Error('preference persistence failed')
    vi.mocked(preferenceService.persist)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)

    await expect(wallet.setChainType(ChainType.QBIT_MAINNET)).rejects.toBe(failure)
    await (wallet as any).chainStateChangeTail

    expect(vi.mocked(keyringService.syncQbitHdPath).mock.calls.map(([path]) => path)).toEqual([
      "m/87'/0'/0'/0",
      "m/87'/1'/0'/0",
    ])
    expect(vi.mocked(preferenceService.setChainType).mock.calls.map(([type]) => type)).toEqual([
      ChainType.QBIT_MAINNET,
      ChainType.QBIT_TESTNET4,
    ])
    expect(preferenceService.setCurrentKeyringIndex).toHaveBeenLastCalledWith(3)
    expect(preferenceService.setCurrentAccount).toHaveBeenLastCalledWith(previousAccount)
    expect(preferenceService.persist).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(walletApiService.setEndpoint).mock.calls.map(([endpoint]) => endpoint)
    ).toEqual([
      'https://mempool.qbit.org/api',
      'https://mempool-testnet.qbit.org/api',
    ])
    expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
    expect(sessionService.broadcastChainChange).not.toHaveBeenCalled()
    expect(floorScan).toHaveBeenCalledTimes(1)
  })

  it('serializes the complete chain switch before starting the next one', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    const wallet = new WalletController()
    const currentAccount = { index: 0 }
    const currentKeyring = { index: 0, accounts: [{}] }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(currentAccount as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const firstRefreshStarted = deferred()
    const releaseFirstRefresh = deferred()
    const changeKeyring = vi
      .spyOn(wallet, 'changeKeyring')
      .mockImplementationOnce(async () => {
        firstRefreshStarted.resolve()
        await releaseFirstRefresh.promise
      })
      .mockResolvedValue(undefined)

    const mainnetSwitch = wallet.setChainType(ChainType.QBIT_MAINNET)
    await firstRefreshStarted.promise
    const regtestSwitch = wallet.setChainType(ChainType.QBIT_REGTEST)
    await flushAsyncWork()

    expect(keyringService.syncQbitHdPath).toHaveBeenCalledTimes(1)
    expect(preferenceService.setChainType).toHaveBeenCalledTimes(1)
    expect(walletApiService.setEndpoint).toHaveBeenCalledTimes(1)
    expect(changeKeyring).toHaveBeenCalledTimes(1)

    releaseFirstRefresh.resolve()
    await Promise.all([mainnetSwitch, regtestSwitch])

    expect(vi.mocked(keyringService.syncQbitHdPath).mock.calls.map(([path]) => path)).toEqual([
      "m/87'/0'/0'/0",
      "m/87'/1'/0'/0",
    ])
    expect(vi.mocked(preferenceService.setChainType).mock.calls.map(([type]) => type)).toEqual([
      ChainType.QBIT_MAINNET,
      ChainType.QBIT_REGTEST,
    ])
    expect(walletApiService.setEndpoint).toHaveBeenCalledTimes(2)
    expect(changeKeyring).toHaveBeenCalledTimes(2)
  })

  it('serializes unlock recovery with a queued chain switch', async () => {
    let currentChainType = ChainType.QBIT_MAINNET
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    const currentAccount = {
      index: 0,
      pubkey: 'current-pubkey',
      address: 'current-address',
    }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(currentAccount as any)
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      index: 0,
      type: KeyringType.QbitHdKeyring,
      accounts: [currentAccount],
    } as any)
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)
    const unlockSyncStarted = deferred()
    const releaseUnlockSync = deferred()
    vi.mocked(keyringService.syncQbitHdPath)
      .mockImplementationOnce(async () => {
        unlockSyncStarted.resolve()
        await releaseUnlockSync.promise
        return false
      })
      .mockResolvedValueOnce(false)

    const unlock = wallet.unlock('password')
    await unlockSyncStarted.promise
    const chainSwitch = wallet.setChainType(ChainType.QBIT_REGTEST)
    await flushAsyncWork()

    expect(keyringService.syncQbitHdPath).toHaveBeenCalledTimes(1)

    releaseUnlockSync.resolve()
    await Promise.all([unlock, chainSwitch])

    expect(vi.mocked(keyringService.syncQbitHdPath).mock.calls.map(([path]) => path)).toEqual([
      "m/87'/0'/0'/0",
      "m/87'/1'/0'/0",
    ])
    clearTimeout(wallet.timer)
  })

  it('reconciles a queued same-chain request after the active switch finishes', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue({ index: 0 } as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({ index: 0, accounts: [{}] } as any)
    const firstRefreshStarted = deferred()
    const releaseFirstRefresh = deferred()
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockImplementation(async () => {
      firstRefreshStarted.resolve()
      await releaseFirstRefresh.promise
    })

    const firstSwitch = wallet.setChainType(ChainType.QBIT_MAINNET)
    await firstRefreshStarted.promise
    const duplicateSwitch = wallet.setChainType(ChainType.QBIT_MAINNET)
    await flushAsyncWork()
    releaseFirstRefresh.resolve()
    await Promise.all([firstSwitch, duplicateSwitch])

    expect(keyringService.syncQbitHdPath).toHaveBeenCalledTimes(2)
    expect(preferenceService.setChainType).toHaveBeenCalledTimes(1)
    expect(walletApiService.setEndpoint).toHaveBeenCalledTimes(2)
    expect(changeKeyring).toHaveBeenCalledTimes(2)
    expect(sessionService.broadcastChainChange).toHaveBeenCalledTimes(1)
  })

  it('continues queued chain switches after an earlier switch fails', async () => {
    let currentChainType = ChainType.QBIT_TESTNET4
    vi.mocked(preferenceService.getChainType).mockImplementation(() => currentChainType)
    vi.mocked(preferenceService.setChainType).mockImplementation(chainType => {
      currentChainType = chainType
    })
    vi.mocked(keyringService.syncQbitHdPath)
      .mockRejectedValueOnce(new Error('path persistence failed'))
      .mockResolvedValueOnce(false)
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentAccount').mockResolvedValue({ index: 0 } as any)
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({ index: 0, accounts: [{}] } as any)
    vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    const failedSwitch = wallet.setChainType(ChainType.QBIT_MAINNET)
    const queuedSwitch = wallet.setChainType(ChainType.QBIT_REGTEST)

    await expect(failedSwitch).rejects.toThrow('path persistence failed')
    await expect(queuedSwitch).resolves.toBeUndefined()
    expect(preferenceService.setChainType).toHaveBeenCalledTimes(1)
    expect(preferenceService.setChainType).toHaveBeenCalledWith(ChainType.QBIT_REGTEST)
  })

  it('maps the mainnet network enum to Qbit mainnet', async () => {
    const wallet = new WalletController()
    const setChainType = vi.spyOn(wallet, 'setChainType').mockResolvedValue(undefined)

    await expect(wallet.setNetworkType(NetworkType.MAINNET)).resolves.toBeUndefined()

    expect(setChainType).toHaveBeenCalledWith(ChainType.QBIT_MAINNET)
  })

  it('reconciles a selected mainnet chain without rebroadcasting a chain change', async () => {
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ index: 0 } as any)
    const wallet = new WalletController()
    const currentKeyring = { index: 0, accounts: [{ index: 0 }] }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    await expect(wallet.setChainType(ChainType.QBIT_MAINNET)).resolves.toBeUndefined()

    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/0'/0'/0")
    expect(walletApiService.setEndpoint).toHaveBeenCalledWith(
      'https://mempool.qbit.org/api'
    )
    expect(changeKeyring).toHaveBeenCalledWith(currentKeyring, 0, { persistPreference: true })
    expect(preferenceService.setChainType).not.toHaveBeenCalled()
    expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
    expect(sessionService.broadcastChainChange).not.toHaveBeenCalled()
  })

  it('restores the persisted mainnet HD path when the wallet unlocks', async () => {
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ index: 2 } as any)
    const order: string[] = []
    vi.mocked(keyringService.submitPassword).mockImplementation(async (_password, options) => {
      order.push('password-submitted')
      await options?.beforeUnlock?.()
      order.push('unlocked')
      return {} as any
    })
    vi.mocked(keyringService.syncQbitHdPath).mockImplementation(async () => {
      order.push('path-synchronized')
      return true
    })
    vi.mocked(sessionService.broadcastEvent).mockImplementation(event => {
      if (event === SESSION_EVENTS.unlock) {
        order.push('unlock-published')
      }
      if (event === SESSION_EVENTS.accountsChanged) {
        order.push('account-published')
      }
    })
    const wallet = new WalletController()
    const currentKeyring = {
      index: 0,
      type: KeyringType.QbitHdKeyring,
      accounts: [{}, {}, { pubkey: 'mainnet-pubkey', address: 'mainnet-address' }],
    }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockImplementation(async () => {
      order.push('account-refreshed')
    })

    await wallet.unlock('password')

    expect(keyringService.submitPassword).toHaveBeenCalledWith('password', {
      beforeUnlock: expect.any(Function),
    })
    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/0'/0'/0")
    expect(changeKeyring).toHaveBeenCalledWith(currentKeyring, 2, {
      broadcastAccountChange: false,
    })
    expect(order).toEqual([
      'password-submitted',
      'path-synchronized',
      'account-refreshed',
      'unlocked',
      'unlock-published',
      'account-published',
    ])
    clearTimeout(wallet.timer)
  })

  it('refreshes a stale qbit account by its persisted index when the HD path is unchanged', async () => {
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({
      index: 2,
      pubkey: 'stale-pubkey',
      address: 'stale-address',
    } as any)
    const wallet = new WalletController()
    const currentKeyring = {
      type: KeyringType.QbitHdKeyring,
      accounts: [
        { pubkey: 'first-pubkey', address: 'first-address' },
        { pubkey: 'second-pubkey', address: 'second-address' },
        { pubkey: 'fresh-pubkey', address: 'fresh-address' },
      ],
    }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    await wallet.unlock('password')

    expect(changeKeyring).toHaveBeenCalledWith(currentKeyring, 2, {
      broadcastAccountChange: false,
    })
    clearTimeout(wallet.timer)
  })

  it('refreshes a qbit account when only its persisted address is stale', async () => {
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({
      index: 1,
      pubkey: 'shared-pubkey',
      address: 'testnet-address',
    } as any)
    const wallet = new WalletController()
    const currentKeyring = {
      type: KeyringType.QbitHdKeyring,
      accounts: [
        { pubkey: 'first-pubkey', address: 'first-address' },
        { pubkey: 'shared-pubkey', address: 'regtest-address' },
      ],
    }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    await wallet.unlock('password')

    expect(changeKeyring).toHaveBeenCalledWith(currentKeyring, 1, {
      broadcastAccountChange: false,
    })
    clearTimeout(wallet.timer)
  })

  it('does not rebroadcast an unchanged qbit account on unlock', async () => {
    const currentAccount = {
      index: 1,
      pubkey: 'current-pubkey',
      address: 'current-address',
    }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(currentAccount as any)
    const wallet = new WalletController()
    const currentKeyring = {
      type: KeyringType.QbitHdKeyring,
      accounts: [{ pubkey: 'first-pubkey', address: 'first-address' }, currentAccount],
    }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    await wallet.unlock('password')

    expect(changeKeyring).not.toHaveBeenCalled()
    clearTimeout(wallet.timer)
  })

  it('finishes unlocking when no usable keyring is available to refresh', async () => {
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ index: 0 } as any)
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(null)
    const changeKeyring = vi.spyOn(wallet, 'changeKeyring').mockResolvedValue(undefined)

    await expect(wallet.unlock('password')).resolves.toBeUndefined()

    expect(changeKeyring).not.toHaveBeenCalled()
    clearTimeout(wallet.timer)
  })

  it('does not publish a deferred account change when unlock reconciliation fails', async () => {
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({
      index: 0,
      pubkey: 'stale-pubkey',
      address: 'stale-address',
    } as any)
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue({
      type: KeyringType.QbitHdKeyring,
      accounts: [{ pubkey: 'fresh-pubkey', address: 'fresh-address' }],
    } as any)
    const failure = new Error('account reconciliation failed')
    vi.spyOn(wallet, 'changeKeyring').mockRejectedValue(failure)

    await expect(wallet.unlock('password')).rejects.toBe(failure)

    expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
  })

  it('converts qbit HD keyring accounts with P2MR metadata', () => {
    const wallet = new WalletController()
    const pubkey = '11'.repeat(32)
    const displayed = {
      type: KeyringType.QbitHdKeyring,
      accounts: [
        {
          pubkey,
          brandName: KeyringType.QbitHdKeyring,
          keyring: {
            pubkey,
            path: "m/87'/0'/0'/0/0",
            scriptPubKey: `5220${'22'.repeat(32)}`,
            leafScript: `20${pubkey}b3`,
            addresses: {
              mainnet: 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw',
              testnet4: 'tq1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0szskx4y',
              signet: 'tq1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0szskx4y',
              regtest: 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny',
            },
            hkdf: { account: 0, change: 0, index: 0 },
            signatureCounter: {
              count: 0,
              limit: 1073741824,
              remaining: 1073741824,
              state: 'normal',
            },
          },
        },
      ],
      keyring: { hdPath: "m/87'/0'/0'/0" },
      addressType: AddressType.P2MR,
      index: 0,
    }

    const keyring = wallet.displayedKeyringToWalletKeyring(displayed as any, 0)

    expect(keyring.type).toBe(KeyringType.QbitHdKeyring)
    expect(keyring.addressType).toBe(AddressType.P2MR)
    expect(keyring.accounts[0]!.pubkey).toBe(pubkey)
    expect(keyring.accounts[0]!.address).toBe(
      'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'
    )
    expect(keyring.accounts[0]!.p2mr?.hkdf).toEqual({ account: 0, change: 0, index: 0 })
    expect(keyring.accounts[0]!.p2mr?.signatureCounter.count).toBe(0)
  })

  it('exports P2MR descriptors only after password verification', async () => {
    const wallet = new WalletController()
    const descriptorExport = {
      network: 'regtest',
      coinType: 1,
      external: {
        descriptorNoChecksum: 'mr(pk(pqc(qrpvExample/87h/1h/0h/0/*)))',
        descriptor: 'mr(pk(pqc(qrpvExample/87h/1h/0h/0/*)))#00000000',
      },
      internal: {
        descriptorNoChecksum: 'mr(pk(pqc(qrpvExample/87h/1h/0h/1/*)))',
        descriptor: 'mr(pk(pqc(qrpvExample/87h/1h/0h/1/*)))#00000000',
      },
      hkdf: { account: 0, change: 0 },
    }
    const exportP2mrDescriptors = vi.fn().mockResolvedValue(descriptorExport)
    ;(keyringService.keyrings as any)[0] = { exportP2mrDescriptors }
    vi.mocked(keyringService.verifyPassword).mockResolvedValue(true)

    const result = await wallet.exportP2mrDescriptors(
      'password',
      {
        type: KeyringType.QbitHdKeyring,
        addressType: AddressType.P2MR,
        index: 0,
      } as any,
      'regtest'
    )

    expect(result).toBe(descriptorExport)
    expect(keyringService.verifyPassword).toHaveBeenCalledWith('password')
    expect(exportP2mrDescriptors).toHaveBeenCalledWith('regtest')

    vi.mocked(keyringService.verifyPassword).mockResolvedValue(false)
    await expect(
      wallet.exportP2mrDescriptors(
        'bad-password',
        {
          type: KeyringType.QbitHdKeyring,
          addressType: AddressType.P2MR,
          index: 0,
        } as any,
        'regtest'
      )
    ).rejects.toThrow()
  })

  it('returns invalid readonly keyrings as corrupted when listing keyrings', async () => {
    const wallet = new WalletController()
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockResolvedValue([
      createDisplayedKeyring({ index: 0, pubkey: invalidPubkey }),
      createDisplayedKeyring({ index: 1, pubkey: validCompressedPubkey }),
    ] as any)

    const keyrings = await wallet.getKeyrings()

    expect(keyrings).toHaveLength(2)
    expect(keyrings[0]).toMatchObject({
      index: 0,
      isCorrupted: true,
      corruptedReason: 'Invalid Public Key',
    })
    expect(keyrings[0]!.accounts).toEqual([])
    expect(keyrings[1]!.index).toBe(1)
    expect(keyrings[1]!.accounts[0]!.pubkey).toBe(validCompressedPubkey)
  })

  it('falls back to the first valid keyring when the current keyring is invalid', async () => {
    const wallet = new WalletController()
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(0)
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockResolvedValue([
      createDisplayedKeyring({ index: 0, pubkey: invalidPubkey }),
      createDisplayedKeyring({ index: 1, pubkey: validCompressedPubkey }),
    ] as any)

    const currentKeyring = await wallet.getCurrentKeyring()

    expect(currentKeyring?.index).toBe(1)
    expect(preferenceService.setCurrentKeyringIndex).toHaveBeenCalledWith(1)
    expect(preferenceService.setCurrentAccount).toHaveBeenCalledWith(currentKeyring!.accounts[0])
  })

  it('rejects invalid public keys before creating a readonly keyring', async () => {
    const wallet = new WalletController()

    await expect(
      wallet.createKeyringWithPublicKey(invalidPubkey, AddressType.P2WPKH)
    ).rejects.toThrow('Invalid Public Key')

    expect(keyringService.importPublicKeyOnly).not.toHaveBeenCalled()
  })

  it('prevents switching to corrupted keyrings', async () => {
    const wallet = new WalletController()
    const corruptedKeyring = {
      key: 'keyring_0',
      index: 0,
      type: KeyringType.ReadonlyKeyring,
      addressType: AddressType.P2WPKH,
      accounts: [],
      alianName: 'Readonly #1',
      hdPath: '',
      isCorrupted: true,
      corruptedReason: 'Invalid Public Key',
    }

    await expect(wallet.changeKeyring(corruptedKeyring as any)).rejects.toThrow(
      'Keyring is corrupted'
    )

    expect(preferenceService.setCurrentKeyringIndex).not.toHaveBeenCalled()
    expect(preferenceService.setCurrentAccount).not.toHaveBeenCalled()
  })

  it('publishes account changes by default when switching keyrings', async () => {
    const wallet = new WalletController()
    const account = { address: 'account-address', pubkey: 'account-pubkey' }
    const emit = vi.spyOn(bgEventBus, 'emit')

    await wallet.changeKeyring({ index: 2, accounts: [account] } as any)

    expect(sessionService.broadcastEvent).toHaveBeenCalledWith(
      SESSION_EVENTS.accountsChanged,
      [account.address],
      undefined,
      ChainType.QBIT_MAINNET
    )
    expect(emit).toHaveBeenCalledWith(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.ACCOUNTS_CHANGED,
      params: account,
    })
    emit.mockRestore()
  })

  it('persists an origin revocation before publishing disconnect events', async () => {
    const wallet = new WalletController()
    const origin = 'https://revoked.example'

    await wallet.removeConnectedSite(origin)

    expect(permissionService.removeConnectedSite).toHaveBeenCalledWith(origin)
    expect(sessionService.broadcastEvent).toHaveBeenNthCalledWith(
      1,
      SESSION_EVENTS.accountsChanged,
      [],
      origin,
      undefined,
      true
    )
    expect(sessionService.broadcastEvent).toHaveBeenNthCalledWith(
      2,
      SESSION_EVENTS.disconnect,
      { code: 4900, message: 'The origin was disconnected from Qbit Wallet.' },
      origin,
      undefined,
      true
    )
    expect(
      vi.mocked(permissionService.removeConnectedSite).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(sessionService.broadcastEvent).mock.invocationCallOrder[0]!)
  })
})
