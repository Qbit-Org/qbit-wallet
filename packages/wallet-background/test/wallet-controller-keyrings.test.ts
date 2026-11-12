import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { BUS_EVENTS, BUS_METHODS, ErrorCodes, SESSION_EVENTS } from '@qbit/wallet-shared'
import type { Account } from '@qbit/wallet-shared'
import { AddressType, ChainType, NetworkType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController, canDeriveAddressFromPublicKey } from '../src/controllers/wallet'
import {
  keyringService,
  permissionService,
  preferenceService,
  sessionService,
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
    // Unlocked, as the keyring service reads once submitPassword succeeds.
    memStore: { getState: () => ({ isUnlocked: true }) },
    keyrings: [],
  },
  preferenceService: {
    getCurrentKeyringIndex: vi.fn(),
    getChainType: vi.fn(() => ChainType.QBIT_MAINNET),
    setCurrentKeyringIndex: vi.fn(),
    setCurrentAccount: vi.fn(),
    getCurrentAccount: vi.fn(),
    getKeyringAlianName: vi.fn((_: string, defaultName?: string) => defaultName ?? ''),
    setKeyringAlianName: vi.fn(),
    removeKeyringAlianName: vi.fn(),
    getKeyringColor: vi.fn(() => undefined),
    setKeyringColor: vi.fn(),
    removeKeyringColor: vi.fn(),
    getAccountAlianName: vi.fn((_: string, defaultName: string) => defaultName),
    getAddressFlag: vi.fn(() => 0),
    getAutoLockTimeId: vi.fn(() => 0),
    getInitAlianNameStatus: vi.fn(() => true),
    setChainType: vi.fn(),
    persist: vi.fn(),
    setShowSafeNotice: vi.fn(),
  },
  sessionService: {
    broadcastEvent: vi.fn(),
    broadcastChainChange: vi.fn(),
  },
  contactBookService: {
    listAlias: vi.fn(() => []),
  },
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
// More points on the curve, for wallets and accounts with distinct keys.
const secondPubkey = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const thirdPubkey = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const fourthPubkey = '02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13'
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

// The chain API base every explorer read and broadcast uses. It follows the
// selected chain, which preferenceService.getChainType reports here.
const apiEndpoint = (wallet: WalletController): string =>
  (wallet as any).getQbitApiEndpoint().endpoint

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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

    await expect(wallet.setChainType(ChainType.QBIT_MAINNET)).resolves.toBeUndefined()

    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/0'/0'/0")
    expect(preferenceService.setChainType).toHaveBeenCalledWith(ChainType.QBIT_MAINNET)
    expect(apiEndpoint(wallet)).toBe('https://mempool.qbit.org/api')
    expect(selectKeyring).toHaveBeenCalledWith(currentKeyring, currentAccount.index, {
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
    vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
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
    expect(apiEndpoint(wallet)).toBe('http://127.0.0.1:3002')
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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

    await expect(wallet.setChainType(ChainType.QBIT_MAINNET)).resolves.toBeUndefined()

    expect(selectKeyring).toHaveBeenCalledWith(currentKeyring, 0, {
      persistPreference: true,
      broadcastAccountChange: false,
    })
    // The selection never consults getCurrentAccount; only the announcement
    // afterwards reads what getAccounts() will return.
    expect(
      getCurrentAccount.mock.invocationCallOrder.every(
        order => order > selectKeyring.mock.invocationCallOrder[0]!
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
    // The current wallet, as the keyring service lists and holds it.
    const currentKeyring = { index: 0, type: KeyringType.QbitHdKeyring, accounts: [targetAccount] }
    ;(keyringService.keyrings as any[]).push({ type: KeyringType.QbitHdKeyring })
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([currentKeyring] as any)
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
    ;(keyringService.keyrings as any[]).push(restoredKeyring, { type: KeyringType.QbitHdKeyring })
    vi.mocked(keyringService.syncQbitHdPath).mockImplementation(async () => {
      restoredKeyring.pqcFloorsPending = true
      return true
    })
    const floorScan = vi
      .spyOn(wallet as any, 'performQbitRestoreFloorScan')
      .mockResolvedValue(undefined as any)
    // The current wallet, as the keyring service lists and holds it.
    const currentKeyring = { index: 1, type: KeyringType.QbitHdKeyring, accounts: [targetAccount] }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([currentKeyring] as any)
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
    expect(apiEndpoint(wallet)).toBe('https://mempool-testnet.qbit.org/api')
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
    const selectKeyring = vi
      .spyOn(wallet as any, 'selectKeyring')
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
    expect(apiEndpoint(wallet)).toBe('https://mempool.qbit.org/api')
    expect(selectKeyring).toHaveBeenCalledTimes(1)

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
    expect(apiEndpoint(wallet)).toBe('http://127.0.0.1:3002')
    expect(selectKeyring).toHaveBeenCalledTimes(2)
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
    vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)
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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockImplementation(async () => {
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
    expect(apiEndpoint(wallet)).toBe('https://mempool.qbit.org/api')
    expect(selectKeyring).toHaveBeenCalledTimes(2)
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
    vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

    await expect(wallet.setChainType(ChainType.QBIT_MAINNET)).resolves.toBeUndefined()

    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/0'/0'/0")
    expect(selectKeyring).toHaveBeenCalledWith(currentKeyring, 0, { persistPreference: true })
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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockImplementation(async () => {
      order.push('account-refreshed')
    })

    await wallet.unlock('password')

    expect(keyringService.submitPassword).toHaveBeenCalledWith('password', {
      beforeUnlock: expect.any(Function),
    })
    expect(keyringService.syncQbitHdPath).toHaveBeenCalledWith("m/87'/0'/0'/0")
    expect(selectKeyring).toHaveBeenCalledWith(currentKeyring, 2, {
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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

    await wallet.unlock('password')

    expect(selectKeyring).toHaveBeenCalledWith(currentKeyring, 2, {
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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

    await wallet.unlock('password')

    expect(selectKeyring).toHaveBeenCalledWith(currentKeyring, 1, {
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
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

    await wallet.unlock('password')

    expect(selectKeyring).not.toHaveBeenCalled()
    clearTimeout(wallet.timer)
  })

  it('finishes unlocking when no usable keyring is available to refresh', async () => {
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ index: 0 } as any)
    const wallet = new WalletController()
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(null)
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockResolvedValue(undefined)

    await expect(wallet.unlock('password')).resolves.toBeUndefined()

    expect(selectKeyring).not.toHaveBeenCalled()
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
    vi.spyOn(wallet as any, 'selectKeyring').mockRejectedValue(failure)

    await expect(wallet.unlock('password')).rejects.toBe(failure)

    expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
  })

  it('announces at the next unlock an account change that an unlock made before a lock ended it', async () => {
    const stale = { index: 0, pubkey: 'stale-pubkey', address: 'stale-address' }
    const fresh = { index: 0, pubkey: 'fresh-pubkey', address: 'fresh-address' }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stale as any)
    const wallet = new WalletController()
    const currentKeyring = { type: KeyringType.QbitHdKeyring, accounts: [fresh] }
    vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(currentKeyring as any)
    // Switching the account saves it at once; it is announced separately.
    const selectKeyring = vi.spyOn(wallet as any, 'selectKeyring').mockImplementation(async () => {
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(fresh as any)
    })
    ;(keyringService as any).setLocked = vi.fn()
    // The computer locks once the account is switched, during the last step.
    vi.mocked(keyringService.submitPassword).mockImplementationOnce(async (_password, options) => {
      await options?.beforeUnlock?.()
      await wallet.lockWallet()
      return {} as any
    })
    const accountsChanged = () =>
      vi
        .mocked(sessionService.broadcastEvent)
        .mock.calls.filter(([event]) => event === SESSION_EVENTS.accountsChanged)

    await expect(wallet.unlock('password')).rejects.toMatchObject({
      code: ErrorCodes.WALLET_LOCKED_DURING_UNLOCK,
    })
    expect(selectKeyring).toHaveBeenCalledTimes(1)
    expect(accountsChanged()).toEqual([])

    // The next unlock finds the account already switched, and announces it.
    await wallet.unlock('password')
    expect(selectKeyring).toHaveBeenCalledTimes(1)
    expect(accountsChanged()).toEqual([
      [SESSION_EVENTS.accountsChanged, ['fresh-address'], undefined, ChainType.QBIT_MAINNET],
    ])

    // Once only.
    await wallet.unlock('password')
    expect(accountsChanged()).toHaveLength(1)
    clearTimeout(wallet.timer)
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
    ;(keyringService.keyrings as any)[0] = {
      type: KeyringType.QbitHdKeyring,
      exportP2mrDescriptors,
    }
    // The wallet as the page listed it, which the background still lists.
    const listed = {
      key: 'keyring_0',
      index: 0,
      type: KeyringType.QbitHdKeyring,
      addressType: AddressType.P2MR,
      accounts: [
        {
          type: KeyringType.QbitHdKeyring,
          pubkey: '11'.repeat(32),
          address: 'qb1zexample',
          key: 'keyring_0#0',
          index: 0,
        },
      ],
    }
    vi.spyOn(wallet, 'getKeyrings').mockResolvedValue([listed] as any)
    vi.mocked(keyringService.verifyPassword).mockResolvedValue(true)

    const result = await wallet.exportP2mrDescriptors('password', listed as any, 'regtest')

    expect(result).toBe(descriptorExport)
    expect(keyringService.verifyPassword).toHaveBeenCalledWith('password')
    expect(exportP2mrDescriptors).toHaveBeenCalledWith('regtest')

    vi.mocked(keyringService.verifyPassword).mockResolvedValue(false)
    await expect(
      wallet.exportP2mrDescriptors('bad-password', listed as any, 'regtest')
    ).rejects.toThrow()
    expect(exportP2mrDescriptors).toHaveBeenCalledTimes(1)
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

  it('lists a keyring of an unregistered type as an Unsupported Wallet nothing can select', async () => {
    const wallet = new WalletController()
    ;(keyringService.keyrings as any[]).push(
      { type: 'Other Key Type' },
      { type: KeyringType.ReadonlyKeyring }
    )
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(0)
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockResolvedValue([
      {
        type: 'Other Key Type',
        accounts: [],
        keyring: {},
        addressType: AddressType.P2WPKH,
        index: 0,
      },
      createDisplayedKeyring({ index: 1, pubkey: validCompressedPubkey }),
    ] as any)

    const keyrings = await wallet.getKeyrings()

    expect(keyrings).toHaveLength(2)
    expect(keyrings[0]).toMatchObject({
      index: 0,
      type: 'Other Key Type',
      alianName: 'Unsupported Wallet #1',
      color: 'green',
      isCorrupted: true,
      corruptedReason: 'No account',
      accounts: [],
    })
    await expect(wallet.changeKeyring(keyrings[0]!)).rejects.toThrow('Keyring is corrupted')

    const currentKeyring = await wallet.getCurrentKeyring()
    expect(currentKeyring?.index).toBe(1)
    expect(preferenceService.setCurrentKeyringIndex).toHaveBeenCalledWith(1)
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
    ;(keyringService.keyrings as any[]).push(
      { type: KeyringType.ReadonlyKeyring },
      { type: KeyringType.ReadonlyKeyring },
      { type: KeyringType.ReadonlyKeyring }
    )
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockResolvedValue([
      createDisplayedKeyring({ index: 0, pubkey: secondPubkey }),
      createDisplayedKeyring({ index: 1, pubkey: thirdPubkey }),
      createDisplayedKeyring({ index: 2, pubkey: validCompressedPubkey }),
    ] as any)
    const keyring = (await wallet.getKeyrings())[2]!
    const account = keyring.accounts[0]!
    const emit = vi.spyOn(bgEventBus, 'emit')

    await wallet.changeKeyring(keyring)

    expect(preferenceService.setCurrentKeyringIndex).toHaveBeenCalledWith(2)
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

describe('WalletController changeKeyring', () => {
  // A wallet as the keyring service displays it: HD, one P2WPKH account per key.
  const hdWallet = (index: number, pubkeys: string[]) => ({
    type: KeyringType.HdKeyring,
    accounts: pubkeys.map(pubkey => ({ pubkey, brandName: KeyringType.HdKeyring })),
    keyring: {},
    addressType: AddressType.P2WPKH,
    index,
  })
  // The slot a removed wallet leaves: it stays, empty, for good.
  const emptySlot = (index: number) => ({
    type: KeyringType.Empty,
    accounts: [],
    keyring: {},
    addressType: AddressType.P2WPKH,
    index,
  })

  // The keyring service holds these slots and displays them.
  const holdSlots = (slots: Array<{ type: string }>) => {
    const keyrings = keyringService.keyrings as any[]
    keyrings.length = 0
    keyrings.push(...slots.map(slot => ({ type: slot.type })))
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockResolvedValue(slots as any)
  }

  // What the background has selected, kept the way preferenceService keeps it.
  let selection: { index?: number; account?: Account | null }

  // Two wallets, the first one's account selected: the wallets as a page lists them.
  const listTwoWallets = async (wallet: WalletController) => {
    holdSlots([hdWallet(0, [validCompressedPubkey]), hdWallet(1, [secondPubkey, thirdPubkey])])
    const listed = await wallet.getKeyrings()
    selection = { index: 0, account: listed[0]!.accounts[0] }
    return listed
  }

  const expectNothingSelectedOrAnnounced = (emit: { mock: { calls: unknown[] } }) => {
    expect(preferenceService.setCurrentKeyringIndex).not.toHaveBeenCalled()
    expect(preferenceService.setCurrentAccount).not.toHaveBeenCalled()
    expect(preferenceService.persist).not.toHaveBeenCalled()
    expect(sessionService.broadcastEvent).not.toHaveBeenCalled()
    expect(emit.mock.calls).toEqual([])
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    selection = {}
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockImplementation(
      () => selection.index as number
    )
    vi.mocked(preferenceService.setCurrentKeyringIndex).mockImplementation(index => {
      selection.index = index
    })
    vi.mocked(preferenceService.getCurrentAccount).mockImplementation(
      () => selection.account as Account
    )
    vi.mocked(preferenceService.setCurrentAccount).mockImplementation(account => {
      selection.account = account
    })
  })

  afterEach(() => {
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReset()
    vi.mocked(preferenceService.setCurrentKeyringIndex).mockReset()
    vi.mocked(preferenceService.getCurrentAccount).mockReset()
    vi.mocked(preferenceService.setCurrentAccount).mockReset()
  })

  it('refuses a wallet removed since the page listed it, and selects and announces nothing', async () => {
    const wallet = new WalletController()
    const listed = await listTwoWallets(wallet)
    // Another window removes the second wallet.
    holdSlots([hdWallet(0, [validCompressedPubkey]), emptySlot(1)])
    const emit = vi.spyOn(bgEventBus, 'emit')

    await expect(wallet.changeKeyring(listed[1]!, 1)).rejects.toThrow(
      'The selected wallet is no longer available'
    )

    expectNothingSelectedOrAnnounced(emit)
    // The wallet and the account that were current stay current.
    expect((await wallet.getCurrentKeyring())?.index).toBe(0)
    expect((await wallet.getCurrentAccount())?.pubkey).toBe(validCompressedPubkey)
    emit.mockRestore()
  })

  it('refuses a wallet argument that is no wallet, and selects and announces nothing', async () => {
    const wallet = new WalletController()
    const listed = await listTwoWallets(wallet)
    const emit = vi.spyOn(bgEventBus, 'emit')

    // Over the UI port a missing wallet arrives as null.
    for (const keyring of [
      null,
      undefined,
      'keyring_1',
      { ...listed[1]!, accounts: undefined },
      { ...listed[1]!, accounts: {} },
    ]) {
      await expect(wallet.changeKeyring(keyring as any, 0), String(keyring)).rejects.toThrow(
        'Unknown wallet'
      )
    }

    expectNothingSelectedOrAnnounced(emit)
    emit.mockRestore()
  })

  it('refuses a wallet whose slot empties while the wallets are read', async () => {
    const wallet = new WalletController()
    const listed = await listTwoWallets(wallet)
    const displayed = await keyringService.getAllDisplayedKeyrings()
    // The read waits on a derivation and a removal completes meanwhile, so the
    // read still returns the wallets as they were.
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockImplementationOnce(async () => {
      ;(keyringService.keyrings as any[])[1] = { type: KeyringType.Empty }
      return displayed
    })
    const emit = vi.spyOn(bgEventBus, 'emit')

    await expect(wallet.changeKeyring(listed[1]!, 1)).rejects.toThrow(
      'The selected wallet is no longer available'
    )

    expectNothingSelectedOrAnnounced(emit)
    emit.mockRestore()
  })

  it('refuses an account its wallet does not hold at that place', async () => {
    const wallet = new WalletController()
    const listed = await listTwoWallets(wallet)
    const emit = vi.spyOn(bgEventBus, 'emit')
    const pastTheEnd = {
      ...listed[1]!,
      accounts: [
        ...listed[1]!.accounts,
        { ...listed[1]!.accounts[1]!, key: 'keyring_1#2', index: 2, pubkey: fourthPubkey },
      ],
    }

    await expect(wallet.changeKeyring(pastTheEnd, 2)).rejects.toThrow(
      'The selected account is no longer available'
    )
    // The wallet now holds another account where the page listed this one.
    holdSlots([hdWallet(0, [validCompressedPubkey]), hdWallet(1, [secondPubkey, fourthPubkey])])
    await expect(wallet.changeKeyring(listed[1]!, 1)).rejects.toThrow(
      'The selected account is no longer available'
    )

    expectNothingSelectedOrAnnounced(emit)
    emit.mockRestore()
  })

  it.each([null, Number.NaN, -1, 0.5, '1'])(
    'refuses %s as the account index, which no account has',
    async accountIndex => {
      const wallet = new WalletController()
      const listed = await listTwoWallets(wallet)
      const emit = vi.spyOn(bgEventBus, 'emit')

      // From a page, an index the port cannot carry arrives as null.
      await expect(
        wallet.changeKeyring(listed[1]!, accountIndex as unknown as number)
      ).rejects.toThrow('Invalid account index')

      expectNothingSelectedOrAnnounced(emit)
      emit.mockRestore()
    }
  )

  it('selects and announces the account as its wallet holds it now', async () => {
    const wallet = new WalletController()
    const listed = await listTwoWallets(wallet)
    const current = listed[1]!.accounts[1]!
    // The page's copy is outdated: another name, another address.
    const outdated = {
      ...listed[1]!,
      accounts: listed[1]!.accounts.map(account => ({
        ...account,
        alianName: 'Old name',
        address: 'outdated-address',
      })),
    }
    const emit = vi.spyOn(bgEventBus, 'emit')

    await wallet.changeKeyring(outdated, 1, { persistPreference: true })

    expect(selection.index).toBe(1)
    expect(selection.account).toEqual(current)
    expect(preferenceService.persist).toHaveBeenCalledTimes(1)
    expect(sessionService.broadcastEvent).toHaveBeenCalledWith(
      SESSION_EVENTS.accountsChanged,
      [current.address],
      undefined,
      ChainType.QBIT_MAINNET
    )
    expect(emit).toHaveBeenCalledWith(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.ACCOUNTS_CHANGED,
      params: current,
    })
    expect((await wallet.getCurrentKeyring())?.index).toBe(1)
    expect((await wallet.getCurrentAccount())?.pubkey).toBe(thirdPubkey)
    emit.mockRestore()
  })

  it('selects a wallet it has just added, from the wallet built before any read listed it', async () => {
    const wallet = new WalletController()
    holdSlots([hdWallet(0, [validCompressedPubkey])])
    selection = { index: 0 }
    const added = createDisplayedKeyring({ index: 1, pubkey: fourthPubkey })
    const raw = { type: KeyringType.ReadonlyKeyring }
    vi.mocked(keyringService.importPublicKeyOnly).mockImplementation(async () => {
      ;(keyringService.keyrings as any[]).push(raw)
      vi.mocked(keyringService.getAllDisplayedKeyrings).mockResolvedValue([
        hdWallet(0, [validCompressedPubkey]),
        added,
      ] as any)
      return raw as any
    })
    vi.mocked(keyringService.displayForKeyring).mockResolvedValue(added as any)

    await wallet.createKeyringWithPublicKey(fourthPubkey, AddressType.P2WPKH)

    expect(selection.index).toBe(1)
    expect(selection.account?.pubkey).toBe(fourthPubkey)
    expect(sessionService.broadcastEvent).toHaveBeenCalledWith(
      SESSION_EVENTS.accountsChanged,
      [selection.account!.address],
      undefined,
      ChainType.QBIT_MAINNET
    )
  })
})
