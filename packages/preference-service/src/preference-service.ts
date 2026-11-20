/**
 * Cross-platform preference management service
 */

import {
  Account,
  AddressFlagType,
  QbitBalance,
  DEFAULT_LOCKTIME_ID,
  DEFAULT_THEME_MODE,
  ErrorCodes,
  THEME_MODES,
  ThemeMode,
  TxHistoryItem,
  WalletColorKey,
  WalletError,
  isWalletColorKey,
  normalizeAvailableChainType,
  repairStoredAutoLockTimeId,
  resolveAutoLockTimeId,
} from '@qbit/wallet-shared'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'
import { ChainType } from '@qbit/wallet-types'
import { EventEmitter } from 'eventemitter3'
import cloneDeep from 'lodash/cloneDeep.js'
import {
  BasePreferenceStore,
  PreferenceServiceConfig,
  PreferenceServiceEvents,
  QbitSendPlanRemovalAccount,
  QbitSendPlanRemovalRecord,
  QbitSendPlanRemovals,
} from './types'

/** Whether `value` is a wallet identity as createWalletId makes one. */
function isWalletId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

/** The version of the wallet removal records this version writes and reads. */
const QBIT_SEND_PLAN_REMOVAL_VERSION = 1

/**
 * The networks a send plan can be on, as a removal record may name them:
 * the same as the wallet controller derives a removed wallet's accounts on
 * and the send plan engine plans on, which a test pins.
 */
export const QBIT_SEND_PLAN_CHAINS: ReadonlySet<unknown> = new Set([
  ChainType.QBIT_MAINNET,
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `value` as an account a removal record names, or nothing when it is not one. */
function readQbitSendPlanRemovalAccount(value: unknown): QbitSendPlanRemovalAccount | undefined {
  if (!isPlainRecord(value)) return undefined
  const { chain, address } = value
  if (!QBIT_SEND_PLAN_CHAINS.has(chain) || typeof address !== 'string' || address.length === 0) {
    return undefined
  }
  return { chain: chain as ChainType, address }
}

/**
 * `value` as a version-1 removal record, copied, or nothing when it is not
 * one: of another version, or with an id, a wallet or an account this
 * version would not write. Fields it does not know are left out of the copy.
 */
function readQbitSendPlanRemoval(value: unknown): QbitSendPlanRemovalRecord | undefined {
  if (!isPlainRecord(value) || value['version'] !== QBIT_SEND_PLAN_REMOVAL_VERSION) return undefined
  const { id, wallet, accounts } = value
  if (!isWalletId(id) || !isPlainRecord(wallet) || !Array.isArray(accounts)) return undefined
  const { index, type } = wallet
  if (!Number.isSafeInteger(index) || (index as number) < 0) return undefined
  if (typeof type !== 'string' || type.length === 0) return undefined
  const read = accounts.map(readQbitSendPlanRemovalAccount)
  if (read.some(account => account === undefined)) return undefined
  return {
    version: QBIT_SEND_PLAN_REMOVAL_VERSION,
    id,
    wallet: { index: index as number, type },
    accounts: read as QbitSendPlanRemovalAccount[],
  }
}

/**
 * The entries of a stored `qbitSendPlanRemovals`: none when it is absent,
 * and a value that is not a list, which no version writes, as the one entry
 * it is, so that it is kept as it is.
 */
function qbitSendPlanRemovalEntries(value: unknown): readonly unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** The accounts an entry this version cannot read names in `accounts`, those that read as accounts. */
function accountsNamedBy(entry: unknown): QbitSendPlanRemovalAccount[] {
  const accounts = isPlainRecord(entry) ? entry['accounts'] : undefined
  if (!Array.isArray(accounts)) return []
  return accounts
    .map(readQbitSendPlanRemovalAccount)
    .filter((account): account is QbitSendPlanRemovalAccount => account !== undefined)
}

/** A new wallet identity: 16 bytes from the platform's random source, in hex. */
function newWalletId(): string {
  const webCrypto = (
    globalThis as unknown as {
      crypto?: { getRandomValues<T extends Uint8Array>(values: T): T }
    }
  ).crypto
  if (!webCrypto) {
    throw new Error('Secure random values are unavailable')
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

const SUPPORTED_LOCALES = ['en', 'zh_TW', 'fr', 'es', 'ru', 'ja']
const RESTORE_SAVE_ATTEMPTS = 3
const RESTORE_SAVE_RETRY_DELAY_MS = 100
// History is cached per account, and Receive selects a new account for each
// new address, so only the most recently written entries are kept.
const HISTORY_CACHE_ENTRY_LIMIT = 16

/**
 * Settings earlier releases stored that this build no longer has: the
 * signData switch, and settings of the wallet this one was forked from that
 * nothing here reads (fiat currency, safety notice, low-fee mode, onboarding
 * guide, rate-us prompt, highlighted wallets, the wallet and account being
 * edited, the UI cache, address summaries, watched-address preferences and
 * the template version).
 */
const DROPPED_KEYS: readonly string[] = [
  'enableSignData',
  'currency',
  'showSafeNotice',
  'acceptLowFeeMode',
  'guideReaded',
  'rateUsStatus',
  'walletSavedList',
  'editingKeyringIndex',
  'editingAccount',
  'uiCachedData',
  'addressSummary',
  'watchAddressPreference',
  'currentVersion',
]

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const defaultTemplate = {
  currentKeyringIndex: 0,
  currentAccount: undefined,
  externalLinkAck: false,
  balanceMap: {},
  historyMap: {},
  locale: 'auto',
  alianNames: {},
  initAlianNames: false,
  firstOpen: false,
  chainType: ChainType.QBIT_MAINNET as any,
  keyringAlianNames: {},
  keyringColors: {},
  accountAlianNames: {},
  skippedVersion: '',
  addressFlags: {},
  autoLockTimeId: DEFAULT_LOCKTIME_ID,
  lockOnComputerLock: true,
  lockOnWindowsClosed: true,
  openInSidePanel: false,
  developerMode: false,
  themeMode: DEFAULT_THEME_MODE,
  enableRBF: true,
} as unknown as BasePreferenceStore

export class PreferenceService extends EventEmitter<PreferenceServiceEvents> {
  protected store!: BasePreferenceStore
  protected storage: ProxyStorageAdapter = undefined as any
  protected logger: any
  protected t: any
  protected eventBus: EventEmitter | undefined
  protected template: BasePreferenceStore = defaultTemplate
  protected supportedLocales: string[] = SUPPORTED_LOCALES
  protected platformDefaults: Partial<BasePreferenceStore> = {}
  protected defaultLang: string = 'en'
  private storageKey: string = 'preference'
  private pendingPersist: Promise<void> = Promise.resolve()
  // The latest change requested of each setting saved through setAndPersist.
  private persistRequests = new Map<keyof BasePreferenceStore, number>()
  // resetAllData calls whose new store is not in place yet. The storage refuses
  // to save the store they replace meanwhile.
  private pendingResets = 0

  // State flags
  protected initialized = false
  public popupOpen = false

  constructor() {
    super()
  }

  /**
   * Initialize the preference service
   */
  async init(config: PreferenceServiceConfig): Promise<void> {
    if (config.storage) {
      this.storage = config.storage
    }

    if (config.logger) {
      this.logger = config.logger
    }

    if (config.t) {
      this.t = config.t
    }

    if (config.eventBus) {
      this.eventBus = config.eventBus
    }

    if (!this.storage) {
      throw new Error('PreferenceService: Storage adapter is required')
    }

    try {
      // Merge template with platform defaults
      const finalTemplate = {
        ...this.template,
        ...this.platformDefaults,
        locale: this.defaultLang,
      } as BasePreferenceStore

      // Create persistent store
      this.store = await this.storage.createPersistentProxy(this.storageKey, finalTemplate)

      // Validate and fix store data
      await this.validateAndFixStore(this.defaultLang)

      this.initialized = true
      this.logger.debug('[PreferenceService] Initialized successfully')
    } catch (error) {
      this.logger.error('[PreferenceService] Initialization failed:', error)
      throw error
    }
  }

  /**
   * Replace every preference with its default, saved before this resolves.
   * Rejects, keeping the current preferences, when that write fails. The
   * preferences `keep` names keep their current values instead, in the same
   * write, so no moment on disk has them at their defaults (a wallet reset
   * keeps the language and the theme).
   */
  resetAllData = async (options: { keep?: readonly (keyof BasePreferenceStore)[] } = {}) => {
    const kept: Partial<Record<keyof BasePreferenceStore, unknown>> = {}
    for (const key of options.keep ?? []) {
      if (this.store && key in this.store) {
        kept[key] = this.store[key]
      }
    }
    const finalTemplate = cloneDeep({
      ...this.template,
      ...this.platformDefaults,
      locale: this.defaultLang,
      ...kept,
    }) as BasePreferenceStore

    this.pendingResets++
    try {
      this.store = await this.storage.createPersistentProxy(this.storageKey, finalTemplate, {
        reset: true,
      })
    } finally {
      this.pendingResets--
    }

    await this.validateAndFixStore(this.defaultLang)

    this.logger.debug('[PreferenceService] Data reset')
  }

  persist = async (): Promise<void> => {
    if (this.storage.flushPersistentProxy) {
      await this.storage.flushPersistentProxy(this.store)
    } else {
      await this.storage.set(this.storageKey, cloneDeep(this.store))
    }
  }

  /**
   * Set a security-relevant preference and resolve once it is on disk rather
   * than after the store's debounced save, so a browser quit or extension
   * reload straight after the change cannot bring the old value back. Changes
   * run one at a time. A failed write restores the previous value, unless the
   * store was reset or the value changed some other way meanwhile, saves it
   * again and rejects so the caller can report it. When the restored value
   * was not saved, it rejects with a PREFERENCE_NOT_RESTORED WalletError
   * instead: the stored setting may then hold the rejected value.
   */
  private setAndPersist<K extends keyof BasePreferenceStore>(
    key: K,
    value: BasePreferenceStore[K]
  ): Promise<void> {
    const request = this.nextPersistRequest(key)
    return this.inPersistOrder(() => this.applyAndPersist(key, value, request))
  }

  /** The number of a change of `key` asked for now; see saveRestoredValue. */
  private nextPersistRequest(key: keyof BasePreferenceStore): number {
    const request = (this.persistRequests.get(key) ?? 0) + 1
    this.persistRequests.set(key, request)
    return request
  }

  /** Run `change` once every change asked for before it has ended. */
  private inPersistOrder<T>(change: () => Promise<T>): Promise<T> {
    const run = this.pendingPersist.then(change)
    this.pendingPersist = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * setAndPersist's change, run in its turn (inPersistOrder). With
   * `saveRestored` false, a failed write puts the previous value back in
   * memory and does not save it again (see forgetQbitSendPlanRemoval).
   */
  private async applyAndPersist<K extends keyof BasePreferenceStore>(
    key: K,
    value: BasePreferenceStore[K],
    request: number,
    saveRestored = true
  ): Promise<void> {
    const store = this.store
    const hadValue = key in store
    const previous = store[key]
    store[key] = value
    const applied = store[key]
    try {
      await this.persist()
    } catch (error) {
      if (this.store === store && store[key] === applied) {
        if (hadValue) {
          store[key] = previous
        } else {
          delete store[key]
        }
        const restore = saveRestored ? await this.saveRestoredValue(store, key, request) : undefined
        if (restore) {
          const failure = new WalletError(
            ErrorCodes.PREFERENCE_NOT_RESTORED,
            `Failed to save ${String(key)}, and its previous value could not be saved again`
          )
          ;(failure as { cause?: unknown }).cause = restore.error
          throw failure
        }
      }
      throw error
    }
  }

  /**
   * Save the value setAndPersist put back after a failed write, in case
   * another write got the failed value to disk meanwhile, retrying a few
   * times. A save that the storage has started already lands before this one,
   * as the storage writes in call order. Stops at once when resetAllData is
   * replacing the store, which then decides what is stored. Also stops when
   * the setting changes some other way or a newer change of it is waiting to
   * run; if a save of the restored value had failed by then, the disk may hold
   * the rejected value until that change is saved, so it still counts as not
   * saved. Resolves with the last error if the value was not saved.
   */
  private async saveRestoredValue<K extends keyof BasePreferenceStore>(
    store: BasePreferenceStore,
    key: K,
    request: number
  ): Promise<{ error: unknown } | undefined> {
    const restored = store[key]
    const replaced = () => this.store !== store || this.pendingResets > 0
    let failure: { error: unknown } | undefined
    for (let attempt = 1; attempt <= RESTORE_SAVE_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await delay(RESTORE_SAVE_RETRY_DELAY_MS * (attempt - 1))
      }
      if (replaced()) {
        return undefined
      }
      if (store[key] !== restored || this.persistRequests.get(key) !== request) {
        return failure
      }
      try {
        await this.persist()
        return undefined
      } catch (error) {
        failure = { error }
        this.logger?.error?.('[PreferenceService] Failed to save a restored preference', error)
      }
    }
    return replaced() ? undefined : failure
  }

  /**
   * Validate and fix store data
   */
  private async validateAndFixStore(defaultLang: string): Promise<void> {
    // Ensure locale is supported
    if (!this.supportedLocales.includes(this.store.locale)) {
      this.store.locale = defaultLang
    }

    // normalizeAvailableChainType migrates unknown or build-disabled chains.
    // A persisted regtest selection is kept here: whether it may be used is an
    // asynchronous background capability (optional loopback permission +
    // acknowledgement + service identity) that the wallet controller checks
    // at startup before the wallet uses the chain, falling back to mainnet.
    this.store.chainType = normalizeAvailableChainType(this.store.chainType)

    if (typeof this.store.regtestAccessAck !== 'string') {
      delete this.store.regtestAccessAck
    }
    if ('walletId' in this.store && !isWalletId(this.store.walletId)) {
      delete this.store.walletId
    }

    if (typeof this.store.externalLinkAck !== 'boolean') {
      this.store.externalLinkAck = false
    }

    // Earlier builds stored settings this build no longer has (DROPPED_KEYS).
    // The store loads every stored key, so drop them here rather than save
    // them again with each change.
    for (const key of DROPPED_KEYS) {
      Reflect.deleteProperty(this.store, key)
    }

    // Preferences stored before these settings existed have neither, and they
    // are on unless the user turned them off.
    if (typeof this.store.lockOnComputerLock !== 'boolean') {
      this.store.lockOnComputerLock = true
    }

    if (typeof this.store.lockOnWindowsClosed !== 'boolean') {
      this.store.lockOnWindowsClosed = true
    }

    // The auto-lock times changed in 1.0.10: store the id of the time each
    // retired one became, and the shortest time for a value that is no id at
    // all. An id this build does not know, which a later build may have
    // stored, stays on disk (repairStoredAutoLockTimeId). This is saved at
    // once rather than after the store's debounce; getAutoLockTimeId reads
    // every value with resolveAutoLockTimeId, so the old one read again after
    // a quit before the save means the same time.
    const storedAutoLockTimeId = this.store.autoLockTimeId
    const repairedAutoLockTimeId = repairStoredAutoLockTimeId(storedAutoLockTimeId)
    const autoLockTimeIdChanged =
      repairedAutoLockTimeId !== undefined && repairedAutoLockTimeId !== storedAutoLockTimeId
    if (autoLockTimeIdChanged) {
      this.store.autoLockTimeId = repairedAutoLockTimeId
    }

    if (!this.store.balanceMap) {
      this.store.balanceMap = {}
    }

    if (!this.store.historyMap) {
      this.store.historyMap = {}
    }

    // Earlier builds kept one Qbit history for every account of a wallet
    // under `qbit:<chain>:<first account's pubkey>`. History is now kept per
    // account under `qbit-account:` keys and those entries are never read, so
    // drop them instead of keeping them unread.
    const walletWideHistoryKeys = Object.keys(this.store.historyMap).filter(key =>
      key.startsWith('qbit:')
    )
    if (walletWideHistoryKeys.length > 0) {
      const historyMap = { ...this.store.historyMap }
      for (const key of walletWideHistoryKeys) {
        delete historyMap[key]
      }
      this.store.historyMap = historyMap
    }

    if (!this.store.keyringAlianNames) {
      this.store.keyringAlianNames = {}
    }

    // Stores saved before wallets had colors have none; each of their
    // wallets shows the color of its slot until the user picks one.
    if (!this.store.keyringColors) {
      this.store.keyringColors = {}
    }

    if (!this.store.accountAlianNames) {
      this.store.accountAlianNames = {}
    }

    if (!this.store.addressFlags) {
      this.store.addressFlags = {}
    }

    // Validate current account
    if (this.store.currentAccount && !this.store.currentAccount.pubkey) {
      // Old version account format, reset
      this.store.currentAccount = undefined
    }

    if (autoLockTimeIdChanged) {
      try {
        await this.persist()
      } catch (error) {
        // The store's debounced save is still queued with the change.
        this.logger?.error?.('[PreferenceService] Failed to save the auto-lock time', error)
      }
    }
  }

  /**
   * Get current account
   */
  getCurrentAccount(): Account | null {
    return cloneDeep(this.store.currentAccount) || null
  }

  /**
   * Set current account
   */
  setCurrentAccount(account?: Account | null): void {
    this.store.currentAccount = account
  }

  /**
   * Popup state management
   */
  setPopupOpen(isOpen: boolean): void {
    this.popupOpen = isOpen
  }

  getPopupOpen(): boolean {
    return this.popupOpen
  }

  /**
   * Address balance management
   */
  updateAddressBalance(address: string, data: QbitBalance): void {
    const balanceMap = this.store.balanceMap || {}
    this.store.balanceMap = {
      ...balanceMap,
      [address]: data,
    }
  }

  removeAddressBalance(address: string): void {
    if (address in this.store.balanceMap) {
      const map = { ...this.store.balanceMap }
      delete map[address]
      this.store.balanceMap = map
    }
  }

  getAddressBalance(address: string): QbitBalance | null {
    const balanceMap = this.store.balanceMap || {}
    return balanceMap[address] || null
  }

  /**
   * Address history management
   */
  updateAddressHistory(address: string, data: TxHistoryItem[]): void {
    const { [address]: _replaced, ...others } = this.store.historyMap || {}
    const kept = Object.entries(others).slice(-(HISTORY_CACHE_ENTRY_LIMIT - 1))
    this.store.historyMap = {
      ...Object.fromEntries(kept),
      [address]: data,
    }
  }

  removeAddressHistory(address: string): void {
    if (address in this.store.historyMap) {
      const map = { ...this.store.historyMap }
      delete map[address]
      this.store.historyMap = map
    }
  }

  getAddressHistory(address: string): TxHistoryItem[] {
    const historyMap = this.store.historyMap || {}
    return historyMap[address] || []
  }

  /**
   * External link acknowledgment
   */
  getExternalLinkAck(): boolean {
    return this.store.externalLinkAck
  }

  setExternalLinkAck(ack = false): void {
    this.store.externalLinkAck = ack
  }

  /**
   * Locale management
   */
  getLocale(): string {
    return this.store.locale
  }

  async setLocale(locale: string): Promise<void> {
    this.store.locale = locale
  }

  /**
   * Chain type management
   */
  getChainType(): ChainType {
    return normalizeAvailableChainType(this.store.chainType)
  }

  setChainType(chainType: ChainType): void {
    this.store.chainType = normalizeAvailableChainType(chainType)
  }

  /**
   * Current keyring index
   */
  getCurrentKeyringIndex(): number {
    return this.store.currentKeyringIndex
  }

  setCurrentKeyringIndex(keyringIndex: number): void {
    this.store.currentKeyringIndex = keyringIndex
  }

  /**
   * Keyring alias names
   */
  setKeyringAlianName(keyringKey: string, name: string): void {
    this.store.keyringAlianNames = Object.assign({}, this.store.keyringAlianNames, {
      [keyringKey]: name,
    })
  }

  getKeyringAlianName(keyringKey: string, defaultName?: string): string {
    const name = this.store.keyringAlianNames[keyringKey]
    if (!name && defaultName) {
      this.setKeyringAlianName(keyringKey, defaultName)
    }
    return this.store.keyringAlianNames[keyringKey] || ''
  }

  /** Forget a keyring's name, for a wallet that was removed. */
  removeKeyringAlianName(keyringKey: string): void {
    if (Object.prototype.hasOwnProperty.call(this.store.keyringAlianNames, keyringKey)) {
      const names = { ...this.store.keyringAlianNames }
      delete names[keyringKey]
      this.store.keyringAlianNames = names
    }
  }

  /**
   * Keyring colors: a palette key (WALLET_COLOR_KEYS) by keyring key. A
   * keyring without one shows the color of its slot, which the wallet
   * controller resolves; nothing here writes a color on read.
   */
  setKeyringColor(keyringKey: string, color: WalletColorKey): void {
    this.store.keyringColors = Object.assign({}, this.store.keyringColors, {
      [keyringKey]: color,
    })
  }

  /** The stored palette key, or undefined when none or an unknown key is stored. */
  getKeyringColor(keyringKey: string): WalletColorKey | undefined {
    const color: unknown = this.store.keyringColors[keyringKey]
    return isWalletColorKey(color) ? color : undefined
  }

  /** Forget a keyring's color, for a wallet that was removed. */
  removeKeyringColor(keyringKey: string): void {
    if (Object.prototype.hasOwnProperty.call(this.store.keyringColors, keyringKey)) {
      const colors = { ...this.store.keyringColors }
      delete colors[keyringKey]
      this.store.keyringColors = colors
    }
  }

  /**
   * Account alias names
   */
  setAccountAlianName(accountKey: string, name: string): void {
    this.store.accountAlianNames = Object.assign({}, this.store.accountAlianNames, {
      [accountKey]: name,
    })
  }

  getAccountAlianName(accountKey: string, defaultName?: string): string {
    const name = this.store.accountAlianNames[accountKey]
    if (!name && defaultName) {
      this.setAccountAlianName(accountKey, defaultName)
    }
    return this.store.accountAlianNames[accountKey] || ''
  }

  /**
   * Address flags management
   */
  getAddressFlag(address: string): number {
    return this.store.addressFlags[address] || 0
  }

  setAddressFlag(address: string, flag: number): void {
    this.store.addressFlags = Object.assign({}, this.store.addressFlags, { [address]: flag })
  }

  addAddressFlag(address: string, flag: AddressFlagType): number {
    const finalFlag = (this.store.addressFlags[address] || 0) | flag
    this.store.addressFlags = Object.assign({}, this.store.addressFlags, { [address]: finalFlag })
    return finalFlag
  }

  removeAddressFlag(address: string, flag: AddressFlagType): number {
    const finalFlag = (this.store.addressFlags[address] || 0) & ~flag
    this.store.addressFlags = Object.assign({}, this.store.addressFlags, { [address]: finalFlag })
    return finalFlag
  }

  /**
   * Version management
   */
  getSkippedVersion(): string {
    return this.store.skippedVersion
  }

  setSkippedVersion(version: string): void {
    this.store.skippedVersion = version
  }

  /**
   * Init alian names status
   */
  getInitAlianNameStatus(): boolean {
    return this.store.initAlianNames
  }

  changeInitAlianNameStatus(): void {
    this.store.initAlianNames = true
  }

  /**
   * First open management
   */
  getIsFirstOpen(): boolean {
    // Note: This method would need version comparison logic
    // For now, just return the stored value
    return this.store.firstOpen
  }

  updateIsFirstOpen(): void {
    this.store.firstOpen = false
  }

  /**
   * Auto lock time management (Extension-specific)
   */
  getAutoLockTimeId(): number {
    return resolveAutoLockTimeId(this.store.autoLockTimeId)
  }

  setAutoLockTimeId(id: number): Promise<void> {
    return this.setAndPersist('autoLockTimeId', id)
  }

  /**
   * Lock when the computer locks, and when the last normal browser window
   * closes (Extension-specific). Both are on unless the user turned them off.
   */
  getLockOnComputerLock(): boolean {
    return this.store.lockOnComputerLock !== false
  }

  setLockOnComputerLock(enabled: boolean): Promise<void> {
    return this.setAndPersist('lockOnComputerLock', enabled)
  }

  getLockOnWindowsClosed(): boolean {
    return this.store.lockOnWindowsClosed !== false
  }

  setLockOnWindowsClosed(enabled: boolean): Promise<void> {
    return this.setAndPersist('lockOnWindowsClosed', enabled)
  }

  /**
   * Side panel preference (Extension-specific)
   */
  getOpenInSidePanel(): boolean {
    return this.store.openInSidePanel || false
  }

  setOpenInSidePanel(openInSidePanel: boolean): void {
    this.store.openInSidePanel = openInSidePanel
  }

  /**
   * Developer mode (Extension-specific)
   */
  getDeveloperMode(): boolean {
    return this.store.developerMode || false
  }

  setDeveloperMode(developerMode: boolean): void {
    this.store.developerMode = developerMode
  }

  /**
   * Local regtest acknowledgement (version tag of the accepted explanation).
   * This is consent bookkeeping only and never authorizes loopback access by
   * itself.
   */
  getRegtestAccessAck(): string | undefined {
    const ack = this.store.regtestAccessAck
    return typeof ack === 'string' && ack.length > 0 ? ack : undefined
  }

  setRegtestAccessAck(ack: string | undefined): void {
    if (typeof ack === 'string' && ack.length > 0) {
      this.store.regtestAccessAck = ack
    } else {
      delete this.store.regtestAccessAck
    }
  }

  /**
   * Whether a wallet reset still owes the clearing of the wallet data (see
   * `walletResetPending`). Throws while the preferences are not loaded, as
   * whether one is pending is unknown then.
   */
  getWalletResetPending(): boolean {
    return this.store.walletResetPending === true
  }

  /**
   * Record that a wallet reset is pending, resolving once that is on disk.
   * Rejects when it cannot be saved, and then reads as not pending, though
   * the disk may keep it when the old value cannot be saved again either
   * (see setAndPersist). resetAllData clears it.
   */
  setWalletResetPending(): Promise<void> {
    return this.setAndPersist('walletResetPending', true)
  }

  /**
   * Forget a pending wallet reset recorded by setWalletResetPending, for a
   * reset that then erased nothing, resolving once that is on disk. Rejects
   * when it cannot be saved; the mark then stays, which counts only once
   * nothing is booted.
   */
  clearWalletResetPending(): Promise<void> {
    return this.setAndPersist('walletResetPending', undefined)
  }

  /**
   * The wallet removal records (`qbitSendPlanRemovals`), as this version
   * reads them; a store saved before them reads as none. An entry that does
   * not read as a version-1 record, being of another version or damaged, and
   * an entry under an id read already, is counted in `unreadable` with every
   * account it names that reads as one, and stays as it is stored: no change
   * made here writes over it or drops it. Throws only while the preferences
   * are not loaded.
   */
  getQbitSendPlanRemovals(): QbitSendPlanRemovals {
    const records: QbitSendPlanRemovalRecord[] = []
    const unreadable: QbitSendPlanRemovals['unreadable'] = { count: 0, accounts: [] }
    const ids = new Set<string>()
    for (const entry of qbitSendPlanRemovalEntries(this.store.qbitSendPlanRemovals)) {
      const record = readQbitSendPlanRemoval(entry)
      if (record && !ids.has(record.id)) {
        ids.add(record.id)
        records.push(record)
        continue
      }
      unreadable.count += 1
      unreadable.accounts.push(...accountsNamedBy(entry))
    }
    return { records, unreadable }
  }

  /**
   * Record, before anything of it is changed, that the wallet in slot
   * `wallet.index`, of keyring type `wallet.type`, is being removed, and that
   * its removal ends the send plans of `accounts`; resolves with the record,
   * under a new random id, once it is on disk. Rejects when it cannot be
   * saved, or names no slot, type or Qbit account; the record is then not
   * stored, unless the disk keeps it when the list before cannot be saved
   * again either (see setAndPersist), and every entry stored before stays.
   * The list is read when this change's turn comes among the saved changes,
   * so changes asked for at once each keep the others' (changeAndPersist).
   */
  addQbitSendPlanRemoval(
    wallet: { index: number; type: string },
    accounts: readonly QbitSendPlanRemovalAccount[]
  ): Promise<QbitSendPlanRemovalRecord> {
    // The same 16 random bytes in hex a wallet identity is made of.
    const record = readQbitSendPlanRemoval({
      version: QBIT_SEND_PLAN_REMOVAL_VERSION,
      id: newWalletId(),
      wallet: { index: wallet.index, type: wallet.type },
      accounts: accounts.map(account => ({ chain: account.chain, address: account.address })),
    })
    if (!record) {
      return Promise.reject(
        new Error('A wallet removal record names a wallet slot, its type and Qbit accounts')
      )
    }
    return this.changeAndPersist('qbitSendPlanRemovals', current => [
      ...qbitSendPlanRemovalEntries(current),
      record,
    ]).then(() => cloneDeep(record))
  }

  /**
   * Forget the wallet removal record `id`, resolving once that is on disk,
   * at once when none is stored under it. Rejects when it cannot be saved;
   * the record then stays in memory, and the list is not saved again: the
   * disk holds it still, or, a write that reported a failure having landed,
   * holds it no more, either of which is safe for a record that was to go.
   * So a refused forget makes one write of its own and logs nothing itself.
   * As after any change to the preferences, the storage adapter then saves
   * the whole store on its own, about a second later (its deferred save,
   * which the refused write and the record put back in memory queue
   * again), and logs an error when that write fails too. A caller trying
   * again spaces its tries. Entries this version cannot read stay as they
   * are, and the setting goes once it holds nothing.
   */
  forgetQbitSendPlanRemoval(id: string): Promise<void> {
    return this.changeAndPersist(
      'qbitSendPlanRemovals',
      current => {
        const entries = qbitSendPlanRemovalEntries(current)
        const index = entries.findIndex(entry => readQbitSendPlanRemoval(entry)?.id === id)
        if (index === -1) return current
        const left = entries.filter((_, other) => other !== index)
        return left.length > 0 ? left : undefined
      },
      { saveRestored: false }
    )
  }

  /**
   * Change setting `key` to what `change` makes of its value when this
   * change's turn comes among the saved changes (inPersistOrder), and save it
   * as setAndPersist saves a value; with `saveRestored` false, a write that
   * fails puts the value back in memory only (applyAndPersist). Changes
   * asked for at once so each apply to the value the one before left.
   * Nothing is written when `change` returns the value it was given.
   */
  private changeAndPersist<K extends keyof BasePreferenceStore>(
    key: K,
    change: (current: BasePreferenceStore[K]) => BasePreferenceStore[K],
    { saveRestored = true }: { saveRestored?: boolean } = {}
  ): Promise<void> {
    const request = this.nextPersistRequest(key)
    return this.inPersistOrder(async () => {
      const current = this.store[key]
      const next = change(current)
      if (next === current) return
      await this.applyAndPersist(key, next, request, saveRestored)
    })
  }

  /** Whether init has loaded the preferences: until then none can be read or written. */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * The identity of the wallet set up in this browser (`walletId`), if one
   * was made, as memory holds it: while createWalletId saves a new one, that
   * is the value being saved. What a caller hands out goes through
   * readWalletId instead.
   */
  getWalletId(): string | undefined {
    const id = this.store.walletId
    return isWalletId(id) ? id : undefined
  }

  /** The creation of a walletId under way (createWalletId), which readWalletId waits for. */
  private walletIdCreation: Promise<string | undefined> | undefined

  /** The walletId createWalletId is saving now, in memory before it is on disk. */
  private walletIdUnsaved: string | undefined

  /**
   * The walletId as it is on disk, read at once: none while the first one is
   * still being saved, as no caller has been handed it yet (readWalletId).
   */
  getSavedWalletId(): string | undefined {
    const id = this.getWalletId()
    return id !== undefined && id === this.walletIdUnsaved ? undefined : id
  }

  /**
   * The walletId as it is on disk. While one is being made and saved, the
   * read waits for that save and answers what it saved, or fails with it:
   * an id whose save fails is put back to none, and must never have been
   * handed out.
   */
  readWalletId(): Promise<string | undefined> {
    const creation = this.walletIdCreation
    if (!creation) return Promise.resolve(this.getWalletId())
    return creation.then(() => this.getWalletId())
  }

  /**
   * The wallet's identity (`walletId`), made the first time and saved before
   * this resolves: 16 bytes from the platform's random source, in hex, tied
   * to nothing else. It runs in turn with the other saved changes, so calls
   * at once make one id and all resolve with it. `wanted` is asked right
   * before an id is made: when it answers false, none is made or saved and
   * this resolves undefined. Rejects when it cannot be saved, and the id then
   * reads as absent, as setAndPersist leaves a value it could not save.
   */
  createWalletId(wanted: () => boolean = (): boolean => true): Promise<string | undefined> {
    const request = this.nextPersistRequest('walletId')
    const creation = this.inPersistOrder(async () => {
      const existing = this.getWalletId()
      if (existing !== undefined) return existing
      if (!wanted()) return undefined
      const id = newWalletId()
      this.walletIdUnsaved = id
      try {
        await this.applyAndPersist('walletId', id, request)
      } finally {
        this.walletIdUnsaved = undefined
      }
      return id
    })
    this.walletIdCreation = creation
    const settled = (): void => {
      if (this.walletIdCreation === creation) this.walletIdCreation = undefined
    }
    creation.then(settled, settled)
    return creation
  }

  /**
   * Theme mode (Extension-specific)
   */
  getThemeMode(): ThemeMode {
    const themeMode = this.store.themeMode
    return themeMode && THEME_MODES.includes(themeMode) ? themeMode : DEFAULT_THEME_MODE
  }

  setThemeMode(themeMode: ThemeMode): void {
    this.store.themeMode = THEME_MODES.includes(themeMode) ? themeMode : DEFAULT_THEME_MODE
  }

  getEnableRBF = (): boolean => {
    if (typeof this.store.enableRBF !== 'boolean') {
      return true
    }
    return this.store.enableRBF
  }

  setEnableRBF = (enableRBF: boolean): Promise<void> => {
    return this.setAndPersist('enableRBF', enableRBF)
  }

  /**
   * Get raw store for advanced usage
   */
  protected getStore(): BasePreferenceStore {
    return this.store
  }
}
