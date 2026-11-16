import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddressFlagType, DEFAULT_LOCKTIME_ID, ErrorCodes } from '@qbit/wallet-shared'
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
    expect(service.getShowSafeNotice()).toBe(true)
    expect(rawStore.lockOnComputerLock).toBe(true)
    expect(rawStore.lockOnWindowsClosed).toBe(true)
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

  it('drops history cached under the earlier wallet-wide Qbit key on init', async () => {
    const walletWideKey = `qbit:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`
    const accountKey = `qbit-account:${ChainType.QBIT_TESTNET4}:${'11'.repeat(32)}`
    const rawStore: any = {
      locale: 'en',
      historyMap: {
        [walletWideKey]: [{ txid: 'tx-first' }, { txid: 'tx-second' }],
        [accountKey]: [{ txid: 'tx-first' }],
        qb1z1: [{ txid: 'tx-address' }],
      },
    }
    storage.createPersistentProxy.mockResolvedValue(rawStore)

    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })

    expect(service.getAddressHistory(walletWideKey)).toEqual([])
    expect(service.getAddressHistory(accountKey)).toEqual([{ txid: 'tx-first' }])
    expect(service.getAddressHistory('qb1z1')).toEqual([{ txid: 'tx-address' }])
    expect(Object.keys(rawStore.historyMap).sort()).toEqual([accountKey, 'qb1z1'].sort())
  })

  it('keeps only the most recently written history entries', async () => {
    storage.createPersistentProxy.mockResolvedValue({ locale: 'en', historyMap: {} })
    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })
    const key = (index: number) => `qbit-account:${ChainType.QBIT_TESTNET4}:${index}`

    for (let index = 0; index < 16; index += 1) {
      service.updateAddressHistory(key(index), [{ txid: `tx-${index}` } as any])
    }
    // Writing an entry again makes it the newest.
    service.updateAddressHistory(key(0), [{ txid: 'tx-0-again' } as any])
    service.updateAddressHistory(key(16), [{ txid: 'tx-16' } as any])

    expect(service.getAddressHistory(key(1))).toEqual([])
    expect(service.getAddressHistory(key(0))).toEqual([{ txid: 'tx-0-again' }])
    expect(service.getAddressHistory(key(2))).toEqual([{ txid: 'tx-2' }])
    expect(service.getAddressHistory(key(16))).toEqual([{ txid: 'tx-16' }])
  })

  it('supports address flag bit operations', async () => {
    storage.createPersistentProxy.mockResolvedValue({
      locale: 'en',
      currency: 'USD',
      externalLinkAck: false,
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
      expect.objectContaining({ enableRBF: true, currentAccount: undefined }),
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
    expect(service.getEnableRBF()).toBe(true)

    await service.setAutoLockTimeId(1)
    await service.setEnableRBF(false)
    await service.setLockOnComputerLock(false)
    await service.setLockOnWindowsClosed(false)

    vi.advanceTimersByTime(500)
    const reloaded = await load()
    expect(reloaded.getAutoLockTimeId()).toBe(1)
    expect(reloaded.getEnableRBF()).toBe(false)
    expect(reloaded.getLockOnComputerLock()).toBe(false)
    expect(reloaded.getLockOnWindowsClosed()).toBe(false)
  })

  it('turns both lock settings on for a new wallet', async () => {
    const service = await load()
    expect(service.getLockOnComputerLock()).toBe(true)
    expect(service.getLockOnWindowsClosed()).toBe(true)
  })

  it('loads preferences stored before the lock settings existed with both on', async () => {
    // What 1.0.7 stored: no lock settings at all, and a user's own choices.
    adapter.disk.set(
      'preference',
      JSON.stringify({ autoLockTimeId: 7, enableSignData: true, locale: 'fr', currentVersion: '0' })
    )
    const service = await load()
    expect(service.getLockOnComputerLock()).toBe(true)
    expect(service.getLockOnWindowsClosed()).toBe(true)
    expect(service.getAutoLockTimeId()).toBe(7)
    expect(service.getLocale()).toBe('fr')

    // Turning one off is kept, and the other stays on.
    await service.setLockOnWindowsClosed(false)
    await vi.advanceTimersByTimeAsync(1000)
    const reloaded = await load()
    expect(reloaded.getLockOnComputerLock()).toBe(true)
    expect(reloaded.getLockOnWindowsClosed()).toBe(false)
  })

  it('reads a malformed stored lock setting as on', async () => {
    adapter.disk.set(
      'preference',
      JSON.stringify({ lockOnComputerLock: null, lockOnWindowsClosed: 'false' })
    )
    const service = await load()
    expect(service.getLockOnComputerLock()).toBe(true)
    expect(service.getLockOnWindowsClosed()).toBe(true)
  })

  it('rejects a lock setting whose write fails and keeps it on', async () => {
    const service = await load()
    const writeError = new Error('QUOTA_BYTES quota exceeded')
    adapter.writeErrors.push(writeError)

    await expect(service.setLockOnComputerLock(false)).rejects.toBe(writeError)
    expect(service.getLockOnComputerLock()).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    expect((await load()).getLockOnComputerLock()).toBe(true)
  })

  it('rejects a security setting whose write fails and restores the previous value', async () => {
    const service = await load()
    const writeError = new Error('QUOTA_BYTES quota exceeded')
    adapter.writeErrors.push(writeError)

    await expect(service.setEnableRBF(false)).rejects.toBe(writeError)
    expect(service.getEnableRBF()).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    expect((await load()).getEnableRBF()).toBe(true)
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

    const setting = service.setEnableRBF(false)
    const settingResult = expect(setting).rejects.toBe(writeError)
    await vi.waitFor(() => expect(adapter.writes).toBeGreaterThan(0))
    const otherWrite = service.persist()
    openGate()
    await settingResult
    await otherWrite
    adapter.writeGate = undefined
    await vi.advanceTimersByTimeAsync(0)

    expect(service.getEnableRBF()).toBe(true)
    expect(JSON.parse(adapter.disk.get('preference')!).enableRBF).toBe(true)
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

    const { setting } = await failWhileAnotherWriteSaves(service, () => service.setEnableRBF(false))
    // Well before the store's own debounced save, which would also fix the disk.
    await vi.advanceTimersByTimeAsync(500)

    await expect(setting).rejects.toBe(writeError)
    expect(service.getEnableRBF()).toBe(true)
    expect(JSON.parse(adapter.disk.get('preference')!).enableRBF).toBe(true)
    expect((await load()).getEnableRBF()).toBe(true)
  })

  it('reports a distinct failure when the restored value cannot be saved', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writeError = new Error('write failed')
    const restoreError = new Error('restore failed')
    adapter.writeErrors.push(writeError, undefined, ...Array(20).fill(restoreError))

    const { setting } = await failWhileAnotherWriteSaves(service, () => service.setEnableRBF(false))
    let settled = false
    setting.catch(() => undefined).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(500)

    // The retry gives up rather than holding the next change back for long.
    expect(settled).toBe(true)
    const failure = await setting.catch(error => error)
    expect(failure).not.toBe(writeError)
    expect(failure).toMatchObject({ code: ErrorCodes.PREFERENCE_NOT_RESTORED, cause: restoreError })
    expect(service.getEnableRBF()).toBe(true)
    expect(JSON.parse(adapter.disk.get('preference')!).enableRBF).toBe(false)
  })

  it('stops retrying the restored value once a newer change of the setting is made, and says it was not saved', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writeError = new Error('write failed')
    adapter.writeErrors.push(writeError, undefined, new Error('restore failed'))

    const writesAtStart = adapter.writes
    const { setting } = await failWhileAnotherWriteSaves(service, () => service.setEnableRBF(false))
    // The setting's write, the other write and the first save of the restored value.
    await vi.waitFor(() => expect(adapter.writes).toBe(writesAtStart + 3))
    const writesBefore = adapter.writes
    const newer = service.setEnableRBF(false)
    await vi.advanceTimersByTimeAsync(500)

    // A save of the restored value failed, so until the newer change was saved
    // the disk could hold the rejected value.
    await expect(setting).rejects.toMatchObject({ code: ErrorCodes.PREFERENCE_NOT_RESTORED })
    await newer
    expect(adapter.written.slice(writesBefore).map(value => value.enableRBF)).toEqual([false])
    expect(service.getEnableRBF()).toBe(false)
    expect(JSON.parse(adapter.disk.get('preference')!).enableRBF).toBe(false)
    expect((await load()).getEnableRBF()).toBe(false)
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

    await service.setEnableRBF(false)
    await vi.advanceTimersByTimeAsync(1000)

    expect(adapter.writes - writesBefore).toBe(1)
  })

  it('keeps a repeated change that saved after an identical one failed', async () => {
    const service = await load()
    const writeError = new Error('write failed')
    adapter.writeErrors.push(writeError)

    const failed = service.setEnableRBF(false)
    const retried = service.setEnableRBF(false)

    await expect(failed).rejects.toBe(writeError)
    await retried
    expect(service.getEnableRBF()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await load()).getEnableRBF()).toBe(false)
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
    const setting = service.setEnableRBF(false)
    const settingResult = expect(setting).rejects.toThrow('A newer store replaced preference')
    openGate()
    await reset
    await settingResult
    adapter.writeGate = undefined

    await vi.advanceTimersByTimeAsync(1000)
    const reloaded = await load()
    expect(reloaded.getCurrentAccount()).toBeNull()
    expect(reloaded.getEnableRBF()).toBe(true)
  })

  it('treats a setting that fails while resetAllData is saving as replaced, without retrying', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)

    let openGate!: () => void
    adapter.writeGate = new Promise(resolve => {
      openGate = resolve
    })
    const reset = service.resetAllData()
    const setting = service.setEnableRBF(false)
    let settled = false
    setting.catch(() => undefined).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)

    // The reset's own write is still pending; the setting does not wait for it.
    expect(settled).toBe(true)
    await expect(setting).rejects.toThrow('A newer store replaced preference')
    openGate()
    await reset
    adapter.writeGate = undefined

    expect(service.getEnableRBF()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await load()).getEnableRBF()).toBe(true)
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
    await service.setEnableRBF(false)

    await service.resetAllData()
    await vi.advanceTimersByTimeAsync(1000)

    const reloaded = await load()
    expect(reloaded.getCurrentAccount()).toBeNull()
    expect(reloaded.getEnableRBF()).toBe(true)
  })

  it('keeps the preferences resetAllData is asked to keep in its one write, and resets the rest', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    await service.setLocale('fr')
    service.setThemeMode('dark')
    service.setKeyringAlianName('keyring_0', 'Savings')
    service.setKeyringColor('keyring_0', 'violet')
    service.setAccountAlianName('keyring_0#0', 'Spending')
    service.setCurrentKeyringIndex(1)
    service.setCurrentAccount({ pubkey: 'pubkey-x', address: 'qb1zx' } as any)
    service.setDeveloperMode(true)
    service.setOpenInSidePanel(true)
    service.setChainType(ChainType.QBIT_TESTNET4)
    await service.setAutoLockTimeId(1)
    await service.setWalletResetPending()
    const writesBefore = adapter.writes

    await service.resetAllData({ keep: ['locale', 'themeMode'] })

    // One write took the store from the old values to the new ones.
    expect(adapter.writes - writesBefore).toBe(1)
    const written = adapter.written.at(-1)
    expect(written).toMatchObject({
      locale: 'fr',
      themeMode: 'dark',
      keyringAlianNames: {},
      keyringColors: {},
      accountAlianNames: {},
      currentKeyringIndex: 0,
      developerMode: false,
      openInSidePanel: false,
      chainType: ChainType.QBIT_MAINNET,
    })
    expect(written).not.toHaveProperty('currentAccount')
    expect(written).not.toHaveProperty('walletResetPending')

    await vi.advanceTimersByTimeAsync(1000)
    const reloaded = await load()
    expect(reloaded.getLocale()).toBe('fr')
    expect(reloaded.getThemeMode()).toBe('dark')
    expect(reloaded.getWalletResetPending()).toBe(false)
    expect(reloaded.getKeyringAlianName('keyring_0')).toBe('')
    expect(reloaded.getKeyringColor('keyring_0')).toBeUndefined()
    expect(reloaded.getCurrentAccount()).toBeNull()
    expect(reloaded.getAutoLockTimeId()).toBe(DEFAULT_LOCKTIME_ID)
    expect(reloaded.getDeveloperMode()).toBe(false)
  })

  it('puts the language and the theme back to their defaults when resetAllData keeps nothing', async () => {
    const service = await load()
    await service.setLocale('fr')
    service.setThemeMode('dark')

    await service.resetAllData()

    expect(service.getLocale()).toBe('en')
    expect(service.getThemeMode()).toBe('system')
  })

  it('records a pending wallet reset on disk before it resolves', async () => {
    const service = await load()
    expect(service.getWalletResetPending()).toBe(false)

    await service.setWalletResetPending()

    expect(service.getWalletResetPending()).toBe(true)
    // No debounced save has run: the record is on disk already.
    expect((await load()).getWalletResetPending()).toBe(true)
  })

  it('forgets a pending wallet reset on disk before it resolves', async () => {
    const service = await load()
    await service.setWalletResetPending()

    await service.clearWalletResetPending()

    expect(service.getWalletResetPending()).toBe(false)
    // No debounced save has run: the disk holds no mark already.
    expect(JSON.parse(adapter.disk.get('preference')!)).not.toHaveProperty('walletResetPending')
    expect((await load()).getWalletResetPending()).toBe(false)
  })

  it('keeps a pending wallet reset it cannot forget', async () => {
    const service = await load()
    await service.setWalletResetPending()
    await vi.advanceTimersByTimeAsync(1000)
    adapter.writeErrors = [new Error('disk full')]

    await expect(service.clearWalletResetPending()).rejects.toThrow('disk full')

    expect(service.getWalletResetPending()).toBe(true)
    expect((await load()).getWalletResetPending()).toBe(true)
  })

  it('tells whether init has loaded the preferences', async () => {
    expect(new PreferenceService().isInitialized()).toBe(false)
    expect((await load()).isInitialized()).toBe(true)
  })

  it('has no wallet id in a new store, nor in one saved before it existed', async () => {
    expect((await load()).getWalletId()).toBeUndefined()
    adapter.disk.set('preference', JSON.stringify({ locale: 'en', walletResetPending: true }))
    expect((await load()).getWalletId()).toBeUndefined()
  })

  it('makes a random wallet id once, on disk before it resolves, and keeps it', async () => {
    const service = await load()

    const [first, second] = await Promise.all([service.createWalletId(), service.createWalletId()])

    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toBe(first)
    expect(service.getWalletId()).toBe(first)
    // No debounced save has run: the disk holds it already.
    expect(JSON.parse(adapter.disk.get('preference')!).walletId).toBe(first)
    expect((await load()).getWalletId()).toBe(first)
    await expect(service.createWalletId()).resolves.toBe(first)
  })

  it('reads a wallet id being saved only once it is on disk, and fails with its save', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    adapter.writeErrors = [new Error('disk full')]

    const creating = service.createWalletId()
    const reading = service.readWalletId()

    await expect(creating).rejects.toThrow('disk full')
    await expect(reading).rejects.toThrow('disk full')
    await expect(service.readWalletId()).resolves.toBeUndefined()
    const made = await service.createWalletId()
    await expect(service.readWalletId()).resolves.toBe(made)
  })

  it('counts a wallet id as saved only once it is on disk', async () => {
    const service = await load()
    let release!: () => void
    adapter.writeGate = new Promise(resolve => {
      release = resolve
    })
    const writesBefore = adapter.writes

    const creating = service.createWalletId()
    await vi.waitFor(() => expect(adapter.writes).toBeGreaterThan(writesBefore))
    // In memory, being saved: not saved yet.
    expect(service.getWalletId()).toMatch(/^[0-9a-f]{32}$/)
    expect(service.getSavedWalletId()).toBeUndefined()
    adapter.writeGate = undefined
    release()

    const made = await creating
    expect(service.getSavedWalletId()).toBe(made)
  })

  it('makes a different wallet id for another store', async () => {
    const first = await (await load()).createWalletId()
    adapter = new DiskAdapter()
    expect(await (await load()).createWalletId()).not.toBe(first)
  })

  it('makes and saves no wallet id when it is no longer wanted by its turn', async () => {
    const service = await load()

    await expect(service.createWalletId(() => false)).resolves.toBeUndefined()

    expect(service.getWalletId()).toBeUndefined()
    expect(adapter.disk.get('preference') ?? '{}').not.toContain('walletId')
  })

  it('leaves no wallet id it cannot save', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    adapter.writeErrors = [new Error('disk full')]

    await expect(service.createWalletId()).rejects.toThrow('disk full')

    expect(service.getWalletId()).toBeUndefined()
    expect((await load()).getWalletId()).toBeUndefined()
  })

  it('drops the wallet id with every other preference on a reset that keeps the language', async () => {
    const service = await load()
    await service.createWalletId()

    await service.resetAllData({ keep: ['locale', 'themeMode'] })

    expect(service.getWalletId()).toBeUndefined()
    expect(JSON.parse(adapter.disk.get('preference')!)).not.toHaveProperty('walletId')
  })

  it('reads a malformed stored wallet id as none', async () => {
    adapter.disk.set('preference', JSON.stringify({ locale: 'en', walletId: 'not an id' }))
    expect((await load()).getWalletId()).toBeUndefined()
  })

  it('does not count a wallet reset as pending when it cannot be recorded', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    adapter.writeErrors = [new Error('disk full')]

    await expect(service.setWalletResetPending()).rejects.toThrow('disk full')

    expect(service.getWalletResetPending()).toBe(false)
    expect((await load()).getWalletResetPending()).toBe(false)
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

  it('drops the signData setting an earlier build stored and never saves it again', async () => {
    adapter.disk.set(
      'preference',
      JSON.stringify({ locale: 'fr', currency: 'EUR', enableSignData: true, enableRBF: false })
    )

    const service = await load()
    expect(service.getLocale()).toBe('fr')
    expect(service.getEnableRBF()).toBe(false)
    // The debounced save of the repaired store, then a setting's own write.
    await vi.advanceTimersByTimeAsync(1000)
    await service.setAutoLockTimeId(1)

    expect(adapter.written).toHaveLength(2)
    expect(adapter.written.filter(value => 'enableSignData' in value)).toEqual([])
    expect(JSON.parse(adapter.disk.get('preference')!)).toMatchObject({
      locale: 'fr',
      currency: 'EUR',
      enableRBF: false,
      autoLockTimeId: 1,
    })
  })
})

describe('PreferenceService stored chain', () => {
  // Stored preferences are JSON that anything with storage access can rewrite.
  // A chain value that only converts to a chain name, or that names a property
  // every object inherits, loads as Mainnet and is saved back as Mainnet.
  it.each<[string, unknown]>([
    ["['QBIT_REGTEST']", ['QBIT_REGTEST']],
    ["['QBIT_MAINNET']", ['QBIT_MAINNET']],
    ["'constructor'", 'constructor'],
  ])('loads the stored chain %s as Qbit Mainnet', async (_label, chainType) => {
    const adapter = new DiskAdapter()
    adapter.disk.set('preference', JSON.stringify({ locale: 'en', chainType }))
    const service = new PreferenceService()
    await service.init({ storage: adapter, logger: { debug: vi.fn(), error: vi.fn() } })

    expect(service.getChainType()).toBe(ChainType.QBIT_MAINNET)
    await service.persist()
    expect(JSON.parse(adapter.disk.get('preference')!).chainType).toBe(ChainType.QBIT_MAINNET)
  })
})

describe('PreferenceService wallet colors', () => {
  let adapter: DiskAdapter

  const load = async () => {
    const service = new PreferenceService()
    await service.init({ storage: adapter, logger: { debug: vi.fn(), error: vi.fn() } })
    return service
  }
  const saved = () => JSON.parse(adapter.disk.get('preference')!)

  beforeEach(() => {
    vi.useFakeTimers()
    adapter = new DiskAdapter()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a new store with no wallet colors', async () => {
    const service = await load()

    expect(service.getKeyringColor('keyring_0')).toBeUndefined()
    expect(saved().keyringColors).toEqual({})
  })

  it('loads a store saved before wallets had colors with its names and no color', async () => {
    const keyringAlianNames = { keyring_0: 'Qbit HD Wallet #1', keyring_1: 'Readonly #2' }
    adapter.disk.set('preference', JSON.stringify({ locale: 'fr', keyringAlianNames }))

    const service = await load()
    expect(service.getKeyringAlianName('keyring_0')).toBe('Qbit HD Wallet #1')
    expect(service.getKeyringAlianName('keyring_1')).toBe('Readonly #2')
    expect(service.getKeyringColor('keyring_0')).toBeUndefined()
    expect(service.getKeyringColor('keyring_1')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1000)
    expect(saved()).toMatchObject({ locale: 'fr', keyringAlianNames, keyringColors: {} })
  })

  it('gives a store whose color map is missing an empty one, as it does for names', async () => {
    const storage = createStorage()
    const rawStore: any = { locale: 'en', keyringAlianNames: null, keyringColors: null }
    storage.createPersistentProxy.mockResolvedValue(rawStore)
    const service = new PreferenceService()

    await service.init({ storage: storage as any, logger: { debug: vi.fn(), error: vi.fn() } })

    expect(rawStore.keyringAlianNames).toEqual({})
    expect(rawStore.keyringColors).toEqual({})
    expect(service.getKeyringColor('keyring_0')).toBeUndefined()
  })

  it('keeps a color per keyring across a reload', async () => {
    const service = await load()

    service.setKeyringColor('keyring_0', 'teal')
    service.setKeyringColor('keyring_2', 'gold')
    service.setKeyringColor('keyring_0', 'pink')

    expect(service.getKeyringColor('keyring_0')).toBe('pink')
    expect(service.getKeyringColor('keyring_1')).toBeUndefined()
    expect(service.getKeyringColor('keyring_2')).toBe('gold')
    await vi.advanceTimersByTimeAsync(1000)
    const reloaded = await load()
    expect(reloaded.getKeyringColor('keyring_0')).toBe('pink')
    expect(reloaded.getKeyringColor('keyring_2')).toBe('gold')
    expect(saved().keyringColors).toEqual({ keyring_0: 'pink', keyring_2: 'gold' })
  })

  it('reads a stored value that is not a palette key as no color, and keeps it stored', async () => {
    const keyringColors = {
      keyring_0: 'crimson',
      keyring_1: 42,
      keyring_2: null,
      keyring_3: 'pink',
      keyring_4: '#1ab453',
      keyring_5: 'Blue',
    }
    adapter.disk.set('preference', JSON.stringify({ locale: 'en', keyringColors }))

    const service = await load()

    expect(service.getKeyringColor('keyring_0')).toBeUndefined()
    expect(service.getKeyringColor('keyring_1')).toBeUndefined()
    expect(service.getKeyringColor('keyring_2')).toBeUndefined()
    expect(service.getKeyringColor('keyring_3')).toBe('pink')
    expect(service.getKeyringColor('keyring_4')).toBeUndefined()
    expect(service.getKeyringColor('keyring_5')).toBeUndefined()
    expect(service.getKeyringColor('constructor')).toBeUndefined()
    expect(service.getKeyringColor('__proto__')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    expect(saved().keyringColors).toEqual(keyringColors)
  })

  it('writes nothing when a color is read', async () => {
    const service = await load()
    await vi.advanceTimersByTimeAsync(1000)
    const writes = adapter.writes

    expect(service.getKeyringColor('keyring_0')).toBeUndefined()
    expect(service.getKeyringColor('keyring_9')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1000)
    expect(adapter.writes).toBe(writes)
  })

  it("forgets a removed wallet's name and color, and nothing else", async () => {
    const service = await load()
    service.setKeyringAlianName('keyring_0', 'Wallet 1')
    service.setKeyringAlianName('keyring_1', 'Wallet 2')
    service.setKeyringColor('keyring_0', 'green')
    service.setKeyringColor('keyring_1', 'blue')
    service.setAccountAlianName('keyring_1#0', 'Account 1')

    service.removeKeyringAlianName('keyring_1')
    service.removeKeyringColor('keyring_1')

    expect(service.getKeyringAlianName('keyring_0')).toBe('Wallet 1')
    expect(service.getKeyringAlianName('keyring_1')).toBe('')
    expect(service.getKeyringColor('keyring_0')).toBe('green')
    expect(service.getKeyringColor('keyring_1')).toBeUndefined()
    expect(service.getAccountAlianName('keyring_1#0')).toBe('Account 1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(saved().keyringAlianNames).toEqual({ keyring_0: 'Wallet 1' })
    expect(saved().keyringColors).toEqual({ keyring_0: 'green' })

    const writes = adapter.writes
    service.removeKeyringAlianName('keyring_1')
    service.removeKeyringColor('keyring_7')
    await vi.advanceTimersByTimeAsync(1000)
    expect(adapter.writes).toBe(writes)
  })
})
