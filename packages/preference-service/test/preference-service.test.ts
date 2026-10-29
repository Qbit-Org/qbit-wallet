import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddressFlagType, ErrorCodes } from '@qbit/wallet-shared'
import { BaseProxyStorageAdapter } from '@qbit/wallet-storage'
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

    expect(storage.createPersistentProxy).toHaveBeenCalledTimes(2)
    expect(storage.createPersistentProxy).toHaveBeenLastCalledWith(
      'preference',
      expect.objectContaining({ enableSignData: false, currentAccount: undefined }),
      { reset: true }
    )
  })
})

// Keeps what was written as JSON, like chrome.storage.local, so a new service
// reading it back sees only what reached disk.
class DiskAdapter extends BaseProxyStorageAdapter {
  disk = new Map<string, string>()
  readError: Error | undefined
  // One entry per write, in call order; undefined lets that write succeed.
  writeErrors: (Error | undefined)[] = []
  writeGate: Promise<void> | undefined
  writes = 0
  written: any[] = []

  async get(key: string): Promise<any> {
    if (this.readError) throw this.readError
    const raw = this.disk.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: any): Promise<void> {
    const raw = JSON.stringify(value)
    const writeError = this.writeErrors.shift()
    this.writes++
    this.written.push(JSON.parse(raw))
    await this.writeGate
    if (writeError) throw writeError
    this.disk.set(key, raw)
  }
}

describe('PreferenceService persistence', () => {
  let adapter: DiskAdapter

  const load = async () => {
    const service = new PreferenceService()
    await service.init({ storage: adapter, logger: { debug: vi.fn(), error: vi.fn() } })
    return service
  }

  beforeEach(() => {
    vi.useFakeTimers()
    adapter = new DiskAdapter()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps security settings changed less than a second before a reload', async () => {
    const service = await load()
    expect(service.getEnableSignData()).toBe(false)
    expect(service.getEnableRBF()).toBe(true)

    await service.setEnableSignData(true)
    await service.setAutoLockTimeId(1)
    await service.setEnableRBF(false)

    vi.advanceTimersByTime(500)
    const reloaded = await load()
    expect(reloaded.getEnableSignData()).toBe(true)
    expect(reloaded.getAutoLockTimeId()).toBe(1)
    expect(reloaded.getEnableRBF()).toBe(false)
  })

  it('rejects a security setting whose write fails and restores the previous value', async () => {
    const service = await load()
    const writeError = new Error('QUOTA_BYTES quota exceeded')
    adapter.writeErrors.push(writeError)

    await expect(service.setEnableSignData(true)).rejects.toBe(writeError)
    expect(service.getEnableSignData()).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)
    expect((await load()).getEnableSignData()).toBe(false)
  })

  it('saves the restored value at once when another write saved the failed one', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writeError = new Error('write failed')
    adapter.writeErrors.push(writeError)
    let openGate!: () => void
    adapter.writeGate = new Promise(resolve => {
      openGate = resolve
    })

    const setting = service.setEnableSignData(true)
    const settingResult = expect(setting).rejects.toBe(writeError)
    await vi.waitFor(() => expect(adapter.writes).toBeGreaterThan(0))
    const otherWrite = service.persist()
    openGate()
    await settingResult
    await otherWrite
    adapter.writeGate = undefined
    await vi.advanceTimersByTimeAsync(0)

    expect(service.getEnableSignData()).toBe(false)
    expect(JSON.parse(adapter.disk.get('preference')!).enableSignData).toBe(false)
  })

  // The setting's write fails while another save of the whole store gets the
  // new value to disk.
  const failWhileAnotherWriteSaves = async (
    service: PreferenceService,
    change: () => Promise<void>
  ) => {
    let openGate!: () => void
    adapter.writeGate = new Promise(resolve => {
      openGate = resolve
    })
    const writesBefore = adapter.writes
    const setting = change()
    setting.catch(() => undefined)
    await vi.waitFor(() => expect(adapter.writes).toBe(writesBefore + 1))
    const otherWrite = service.persist()
    openGate()
    await otherWrite
    adapter.writeGate = undefined
    return { setting }
  }

  it('retries the restored value when its first save fails after another write saved the failed one', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writeError = new Error('write failed')
    adapter.writeErrors.push(writeError, undefined, new Error('restore failed'))

    const { setting } = await failWhileAnotherWriteSaves(service, () =>
      service.setEnableSignData(true)
    )
    // Well before the store's own debounced save, which would also fix the disk.
    await vi.advanceTimersByTimeAsync(500)

    await expect(setting).rejects.toBe(writeError)
    expect(service.getEnableSignData()).toBe(false)
    expect(JSON.parse(adapter.disk.get('preference')!).enableSignData).toBe(false)
    expect((await load()).getEnableSignData()).toBe(false)
  })

  it('reports a distinct failure when the restored value cannot be saved', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writeError = new Error('write failed')
    const restoreError = new Error('restore failed')
    adapter.writeErrors.push(writeError, undefined, ...Array(20).fill(restoreError))

    const { setting } = await failWhileAnotherWriteSaves(service, () =>
      service.setEnableSignData(true)
    )
    let settled = false
    setting.catch(() => undefined).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(500)

    // The retry gives up rather than holding the next change back for long.
    expect(settled).toBe(true)
    const failure = await setting.catch(error => error)
    expect(failure).not.toBe(writeError)
    expect(failure).toMatchObject({ code: ErrorCodes.PREFERENCE_NOT_RESTORED, cause: restoreError })
    expect(service.getEnableSignData()).toBe(false)
    expect(JSON.parse(adapter.disk.get('preference')!).enableSignData).toBe(true)
  })

  it('stops retrying the restored value once a newer change of the setting is made, and says it was not saved', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writeError = new Error('write failed')
    adapter.writeErrors.push(writeError, undefined, new Error('restore failed'))

    const writesAtStart = adapter.writes
    const { setting } = await failWhileAnotherWriteSaves(service, () =>
      service.setEnableSignData(true)
    )
    // The setting's write, the other write and the first save of the restored value.
    await vi.waitFor(() => expect(adapter.writes).toBe(writesAtStart + 3))
    const writesBefore = adapter.writes
    const newer = service.setEnableSignData(true)
    await vi.advanceTimersByTimeAsync(500)

    // A save of the restored value failed, so until the newer change was saved
    // the disk could hold the rejected value.
    await expect(setting).rejects.toMatchObject({ code: ErrorCodes.PREFERENCE_NOT_RESTORED })
    await newer
    expect(adapter.written.slice(writesBefore).map(value => value.enableSignData)).toEqual([true])
    expect(service.getEnableSignData()).toBe(true)
    expect(JSON.parse(adapter.disk.get('preference')!).enableSignData).toBe(true)
    expect((await load()).getEnableSignData()).toBe(true)
  })

  it('does not restore a value that a later change replaced while the failed write was pending', async () => {
    const service = await load()
    const writeError = new Error('write failed')
    adapter.writeErrors.push(writeError)

    const failed = service.setAutoLockTimeId(1)
    const succeeded = service.setAutoLockTimeId(3)

    await expect(failed).rejects.toBe(writeError)
    await succeeded
    expect(service.getAutoLockTimeId()).toBe(3)
    expect((await load()).getAutoLockTimeId()).toBe(3)
  })

  it('saves a security setting with one write', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writesBefore = adapter.writes

    await service.setEnableSignData(true)
    await vi.advanceTimersByTimeAsync(1000)

    expect(adapter.writes - writesBefore).toBe(1)
  })

  it('keeps a repeated change that saved after an identical one failed', async () => {
    const service = await load()
    const writeError = new Error('write failed')
    adapter.writeErrors.push(writeError)

    const failed = service.setEnableSignData(true)
    const retried = service.setEnableSignData(true)

    await expect(failed).rejects.toBe(writeError)
    await retried
    expect(service.getEnableSignData()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await load()).getEnableSignData()).toBe(true)
  })

  it('does not let a security setting save the old store while resetAllData runs', async () => {
    const service = await load()
    service.setCurrentAccount({ pubkey: 'pubkey-x', address: 'qb1zx' } as any)
    await service.persist()

    let openGate!: () => void
    adapter.writeGate = new Promise(resolve => {
      openGate = resolve
    })
    const reset = service.resetAllData()
    const setting = service.setEnableSignData(true)
    const settingResult = expect(setting).rejects.toThrow('A newer store replaced preference')
    openGate()
    await reset
    await settingResult
    adapter.writeGate = undefined

    await vi.advanceTimersByTimeAsync(1000)
    const reloaded = await load()
    expect(reloaded.getCurrentAccount()).toBeNull()
    expect(reloaded.getEnableSignData()).toBe(false)
  })

  it('treats a setting that fails while resetAllData is saving as replaced, without retrying', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)

    let openGate!: () => void
    adapter.writeGate = new Promise(resolve => {
      openGate = resolve
    })
    const reset = service.resetAllData()
    const setting = service.setEnableSignData(true)
    let settled = false
    setting.catch(() => undefined).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)

    // The reset's own write is still pending; the setting does not wait for it.
    expect(settled).toBe(true)
    await expect(setting).rejects.toThrow('A newer store replaced preference')
    openGate()
    await reset
    adapter.writeGate = undefined

    expect(service.getEnableSignData()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await load()).getEnableSignData()).toBe(false)
  })

  it('saves default names and UI cache entries created on read', async () => {
    const service = await load()
    // Let the save scheduled by startup repairs finish, so it cannot carry the
    // writes below to disk.
    await vi.advanceTimersByTimeAsync(1000)

    expect(service.getKeyringAlianName('keyring_7', 'HD Wallet #8')).toBe('HD Wallet #8')
    expect(service.getAccountAlianName('keyring_7#0', 'Account 1')).toBe('Account 1')
    expect(service.getUICachedData('qb1zaddress')).toEqual({})

    await vi.advanceTimersByTimeAsync(1000)
    const reloaded = await load()
    expect(reloaded.getKeyringAlianName('keyring_7')).toBe('HD Wallet #8')
    expect(reloaded.getAccountAlianName('keyring_7#0')).toBe('Account 1')
    expect(JSON.parse(adapter.disk.get('preference')!).uiCachedData).toEqual({ qb1zaddress: {} })
  })

  it('resetAllData is not undone by a save the previous store still had pending', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    service.setCurrentAccount({ pubkey: 'pubkey-x', address: 'qb1zx' } as any)
    await service.setEnableSignData(true)

    await service.resetAllData()
    await vi.advanceTimersByTimeAsync(1000)

    const reloaded = await load()
    expect(reloaded.getCurrentAccount()).toBeNull()
    expect(reloaded.getEnableSignData()).toBe(false)
  })

  it('fails to start instead of replacing stored preferences when they cannot be read', async () => {
    const service = await load()
    service.setCurrentAccount({ pubkey: 'pubkey-x', address: 'qb1zx' } as any)
    service.setChainType(ChainType.QBIT_TESTNET4)
    await service.persist()
    const stored = adapter.disk.get('preference')

    adapter.readError = new Error('storage read failed')
    const starting = load()
    const assertion = expect(starting).rejects.toThrow('Failed to load stored data for preference')
    await vi.runAllTimersAsync()
    await assertion

    expect(adapter.disk.get('preference')).toBe(stored)
    adapter.readError = undefined
    const reloaded = await load()
    expect(reloaded.getCurrentAccount()).toMatchObject({ pubkey: 'pubkey-x' })
    expect(reloaded.getChainType()).toBe(ChainType.QBIT_TESTNET4)
  })
})
