import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddressFlagType } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { PreferenceService } from '../src/preference-service'

const createStorage = () => ({
  createPersistentProxy: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
})

describe('PreferenceService', () => {
  let storage: ReturnType<typeof createStorage>
  let service: PreferenceService

  beforeEach(() => {
    vi.clearAllMocks()
    storage = createStorage()
    service = new PreferenceService()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes store and repairs invalid/missing defaults', async () => {
    const rawStore: any = {
      locale: 'unknown-locale',
      currency: '',
      externalLinkAck: 'x',
      enableSignData: undefined,
      showSafeNotice: undefined,
      balanceMap: null,
      historyMap: null,
      walletSavedList: null,
      keyringAlianNames: null,
      accountAlianNames: null,
      addressFlags: null,
      uiCachedData: null,
      currentAccount: { address: 'bc1qabc' },
      rateUsStatus: null,
    }

    storage.createPersistentProxy.mockResolvedValue(rawStore)

    await service.init({
      storage: storage as any,
      logger: { debug: vi.fn(), error: vi.fn() },
    })

    expect(storage.createPersistentProxy).toHaveBeenCalledWith(
      'preference',
      expect.objectContaining({
        locale: 'en',
        chainType: ChainType.QBIT_MAINNET,
      })
    )

    expect(service.getChainType()).toBe(ChainType.QBIT_MAINNET)

    expect(service.getLocale()).toBe('en')
    expect(service.getCurrency()).toBe('USD')
    expect(service.getExternalLinkAck()).toBe(false)
    expect(service.getEnableSignData()).toBe(false)
    expect(service.getShowSafeNotice()).toBe(true)
    expect(service.getCurrentAccount()).toBeNull()

    expect(service.getWalletSavedList()).toEqual([])
    expect(service.getAddressBalance('bc1qnone')).toBeNull()
    expect(service.getAddressHistory('bc1qnone')).toEqual([])
    expect(service.getRateUsStatus()).toEqual({
      hasRated: false,
      ratePromptDismissedAt: null,
      hasShownSecondPrompt: false,
    })
  })

  it('keeps a persisted regtest selection in every channel (the background gates its use)', async () => {
    const { PlatformEnv } = await import('@qbit/wallet-shared')
    const originalChannel = PlatformEnv.CHANNEL
    try {
      for (const channel of ['store', 'e2e', 'github']) {
        PlatformEnv.CHANNEL = channel
        const rawStore: any = { locale: 'en', chainType: ChainType.QBIT_REGTEST }
        storage.createPersistentProxy.mockResolvedValue(rawStore)
        service = new PreferenceService()

        await service.init({
          storage: storage as any,
          logger: { debug: vi.fn(), error: vi.fn() },
        })

        expect(rawStore.chainType).toBe(ChainType.QBIT_REGTEST)
        expect(service.getChainType()).toBe(ChainType.QBIT_REGTEST)

        service.setChainType(ChainType.QBIT_MAINNET)
        expect(rawStore.chainType).toBe(ChainType.QBIT_MAINNET)
        service.setChainType(ChainType.QBIT_REGTEST)
        expect(rawStore.chainType).toBe(ChainType.QBIT_REGTEST)
      }
    } finally {
      PlatformEnv.CHANNEL = originalChannel
    }
  })

  it('stores the regtest acknowledgement version and drops malformed values', async () => {
    const rawStore: any = { locale: 'en', regtestAccessAck: 42 }
    storage.createPersistentProxy.mockResolvedValue(rawStore)

    await service.init({
      storage: storage as any,
      logger: { debug: vi.fn(), error: vi.fn() },
    })

    expect(service.getRegtestAccessAck()).toBeUndefined()
    expect('regtestAccessAck' in rawStore).toBe(false)

    service.setRegtestAccessAck('regtest_access_ack_v1')
    expect(rawStore.regtestAccessAck).toBe('regtest_access_ack_v1')
    expect(service.getRegtestAccessAck()).toBe('regtest_access_ack_v1')

    service.setRegtestAccessAck(undefined)
    expect(service.getRegtestAccessAck()).toBeUndefined()
    expect('regtestAccessAck' in rawStore).toBe(false)

    service.setRegtestAccessAck('')
    expect(service.getRegtestAccessAck()).toBeUndefined()
  })

  it('persists a cloned snapshot of the current selection and propagates failures', async () => {
    storage.createPersistentProxy.mockResolvedValue({
      locale: 'en',
      currency: 'USD',
      chainType: ChainType.QBIT_TESTNET4,
      currentKeyringIndex: 0,
      currentAccount: null,
    })
    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })
    expect(service.getChainType()).toBe(ChainType.QBIT_TESTNET4)

    const account = {
      index: 2,
      pubkey: 'mainnet-pubkey',
      address: 'mainnet-address',
    }
    service.setChainType(ChainType.QBIT_MAINNET)
    service.setCurrentKeyringIndex(4)
    service.setCurrentAccount(account as any)

    await service.persist()

    const persistedSnapshot = storage.set.mock.calls[0]![1]
    expect(storage.set).toHaveBeenCalledWith(
      'preference',
      expect.objectContaining({
        chainType: ChainType.QBIT_MAINNET,
        currentKeyringIndex: 4,
        currentAccount: account,
      })
    )
    service.setChainType(ChainType.QBIT_REGTEST)
    expect(persistedSnapshot.chainType).toBe(ChainType.QBIT_MAINNET)

    const failure = new Error('storage unavailable')
    storage.set.mockRejectedValueOnce(failure)
    await expect(service.persist()).rejects.toBe(failure)
  })

  it('updates and removes address balance/history maps', async () => {
    storage.createPersistentProxy.mockResolvedValue({
      locale: 'en',
      currency: 'USD',
      externalLinkAck: false,
      enableSignData: false,
      showSafeNotice: true,
      currentAccount: null,
      currentKeyringIndex: 0,
      editingKeyringIndex: 0,
      editingAccount: null,
      balanceMap: {},
      historyMap: {},
      watchAddressPreference: {},
      walletSavedList: [],
      alianNames: {},
      initAlianNames: false,
      currentVersion: '0',
      firstOpen: false,
      chainType: ChainType.QBIT_MAINNET,
      keyringAlianNames: {},
      accountAlianNames: {},
      uiCachedData: {},
      skippedVersion: '',
      addressFlags: {},
      autoLockTimeId: 2,
      openInSidePanel: false,
      developerMode: false,
      rateUsStatus: { hasRated: false, ratePromptDismissedAt: 0, hasShownSecondPrompt: false },
      acceptLowFeeMode: false,
    })

    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })

    expect(service.getChainType()).toBe(ChainType.QBIT_MAINNET)

    const balance = {
      confirm_amount: '1',
      pending_amount: '0',
      amount: '1',
    }

    service.updateAddressBalance('qb1z1', balance)
    expect(service.getAddressBalance('qb1z1')).toEqual(balance)

    service.removeAddressBalance('qb1z1')
    expect(service.getAddressBalance('qb1z1')).toBeNull()

    service.updateAddressHistory('qb1z1', [{ txid: 'tx1' } as any])
    expect(service.getAddressHistory('qb1z1')).toEqual([{ txid: 'tx1' }])

    service.removeAddressHistory('qb1z1')
    expect(service.getAddressHistory('bc1q1')).toEqual([])
  })

  it('supports address flag bit operations', async () => {
    storage.createPersistentProxy.mockResolvedValue({
      locale: 'en',
      currency: 'USD',
      externalLinkAck: false,
      enableSignData: false,
      showSafeNotice: true,
      currentAccount: null,
      currentKeyringIndex: 0,
      editingKeyringIndex: 0,
      editingAccount: null,
      balanceMap: {},
      historyMap: {},
      watchAddressPreference: {},
      walletSavedList: [],
      alianNames: {},
      initAlianNames: false,
      currentVersion: '0',
      firstOpen: false,
      chainType: ChainType.QBIT_MAINNET,
      keyringAlianNames: {},
      accountAlianNames: {},
      uiCachedData: {},
      skippedVersion: '',
      addressFlags: {},
      autoLockTimeId: 2,
      openInSidePanel: false,
      developerMode: false,
      rateUsStatus: { hasRated: false, ratePromptDismissedAt: 0, hasShownSecondPrompt: false },
      acceptLowFeeMode: false,
    })

    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })

    expect(service.getAddressFlag('bc1q1')).toBe(0)

    const add1 = service.addAddressFlag('bc1q1', AddressFlagType.CONFIRMED_UTXO_MODE)
    expect(add1).toBe(AddressFlagType.CONFIRMED_UTXO_MODE)

    const removed = service.removeAddressFlag('bc1q1', AddressFlagType.CONFIRMED_UTXO_MODE)
    expect(removed).toBe(0)
    expect(service.getAddressFlag('bc1q1')).toBe(0)
  })

  it('updates and resets rate-us status fields', async () => {
    storage.createPersistentProxy.mockResolvedValue({
      locale: 'en',
      currency: 'USD',
      externalLinkAck: false,
      enableSignData: false,
      showSafeNotice: true,
      currentAccount: null,
      currentKeyringIndex: 0,
      editingKeyringIndex: 0,
      editingAccount: null,
      balanceMap: {},
      historyMap: {},
      watchAddressPreference: {},
      walletSavedList: [],
      alianNames: {},
      initAlianNames: false,
      currentVersion: '0',
      firstOpen: false,
      chainType: ChainType.QBIT_MAINNET,
      keyringAlianNames: {},
      accountAlianNames: {},
      uiCachedData: {},
      skippedVersion: '',
      addressFlags: {},
      autoLockTimeId: 2,
      openInSidePanel: false,
      developerMode: false,
      rateUsStatus: { hasRated: false, ratePromptDismissedAt: 0, hasShownSecondPrompt: false },
      acceptLowFeeMode: false,
    })

    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })

    service.setHasRated(true)
    service.setRatePromptDismissedAt(123)
    service.setHasShownSecondPrompt(true)

    expect(service.getRateUsStatus()).toEqual({
      hasRated: true,
      ratePromptDismissedAt: 123,
      hasShownSecondPrompt: true,
    })

    service.resetRateUsStatus()
    expect(service.getRateUsStatus()).toEqual({
      hasRated: false,
      ratePromptDismissedAt: null,
      hasShownSecondPrompt: false,
    })
  })

  it('defaults themeMode to system and rejects invalid values', async () => {
    const rawStore: any = { locale: 'en', chainType: ChainType.QBIT_MAINNET }
    storage.createPersistentProxy.mockResolvedValue(rawStore)

    await service.init({
      storage: storage as any,
      logger: { debug: vi.fn(), error: vi.fn() },
    })

    expect(storage.createPersistentProxy).toHaveBeenCalledWith(
      'preference',
      expect.objectContaining({ themeMode: 'system' })
    )
    expect(service.getThemeMode()).toBe('system')

    service.setThemeMode('dark')
    expect(service.getThemeMode()).toBe('dark')
    expect(rawStore.themeMode).toBe('dark')

    service.setThemeMode('light')
    expect(service.getThemeMode()).toBe('light')

    service.setThemeMode('neon' as any)
    expect(service.getThemeMode()).toBe('system')

    rawStore.themeMode = 'garbage'
    expect(service.getThemeMode()).toBe('system')
  })

  it('resetAllData clears storage and recreates store', async () => {
    const firstStore = {
      locale: 'en',
      currency: 'USD',
      externalLinkAck: false,
      enableSignData: false,
      showSafeNotice: true,
      currentAccount: null,
      currentKeyringIndex: 0,
      editingKeyringIndex: 0,
      editingAccount: null,
      balanceMap: {},
      historyMap: {},
      watchAddressPreference: {},
      walletSavedList: [],
      alianNames: {},
      initAlianNames: false,
      currentVersion: '0',
      firstOpen: false,
      chainType: ChainType.QBIT_MAINNET,
      keyringAlianNames: {},
      accountAlianNames: {},
      uiCachedData: {},
      skippedVersion: '',
      addressFlags: {},
      autoLockTimeId: 2,
      openInSidePanel: false,
      developerMode: false,
      rateUsStatus: { hasRated: false, ratePromptDismissedAt: 0, hasShownSecondPrompt: false },
      acceptLowFeeMode: false,
    }

    const secondStore = { ...firstStore }

    storage.createPersistentProxy
      .mockResolvedValueOnce(firstStore as any)
      .mockResolvedValueOnce(secondStore as any)
    storage.set.mockResolvedValue(undefined)

    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })
    await service.resetAllData()

    expect(storage.set).toHaveBeenCalledWith('preference', null)
    expect(storage.createPersistentProxy).toHaveBeenCalledTimes(2)
  })
})
