/**
 * Cross-platform preference management service
 */

import {
  Account,
  AddressFlagType,
  QbitBalance,
  DEFAULT_LOCKTIME_ID,
  DEFAULT_THEME_MODE,
  THEME_MODES,
  ThemeMode,
  TxHistoryItem,
  normalizeAvailableChainType,
} from '@qbit/wallet-shared'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'
import { ChainType } from '@qbit/wallet-types'
import { EventEmitter } from 'eventemitter3'
import cloneDeep from 'lodash/cloneDeep.js'
import { BasePreferenceStore, PreferenceServiceConfig, PreferenceServiceEvents } from './types'
const SUPPORTED_LOCALES = ['en', 'zh_TW', 'fr', 'es', 'ru', 'ja']

const defaultTemplate = {
  currentKeyringIndex: 0,
  currentAccount: undefined,
  editingKeyringIndex: 0,
  editingAccount: undefined,
  externalLinkAck: false,
  balanceMap: {},
  historyMap: {},
  locale: 'auto',
  watchAddressPreference: {},
  walletSavedList: [],
  alianNames: {},
  initAlianNames: false,
  currentVersion: '0',
  firstOpen: false,
  currency: 'USD',
  chainType: ChainType.QBIT_MAINNET as any,
  keyringAlianNames: {},
  accountAlianNames: {},
  uiCachedData: {},
  skippedVersion: '',
  showSafeNotice: true,
  addressFlags: {},
  enableSignData: false,
  autoLockTimeId: DEFAULT_LOCKTIME_ID,
  openInSidePanel: false,
  developerMode: false,
  themeMode: DEFAULT_THEME_MODE,
  rateUsStatus: {
    hasRated: false,
    ratePromptDismissedAt: 0,
    hasShownSecondPrompt: false,
  },

  acceptLowFeeMode: false,
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

  // State flags
  protected initialized = false
  public popupOpen = false
  public hasOtherProvider = false

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

  resetAllData = async () => {
    const finalTemplate = cloneDeep({
      ...this.template,
      ...this.platformDefaults,
      locale: this.defaultLang,
    }) as BasePreferenceStore

    this.store = await this.storage.createPersistentProxy(this.storageKey, finalTemplate, {
      reset: true,
    })

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
   * store was reset or the value changed some other way meanwhile, and rejects
   * so the caller can report it.
   */
  private setAndPersist<K extends keyof BasePreferenceStore>(
    key: K,
    value: BasePreferenceStore[K]
  ): Promise<void> {
    const run = this.pendingPersist.then(async () => {
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
          // Save the restored value now rather than after the debounce, in case
          // another write got the failed value to disk meanwhile.
          this.persist().catch(restoreError => {
            this.logger?.error?.(
              '[PreferenceService] Failed to save a restored preference',
              restoreError
            )
          })
        }
        throw error
      }
    })
    this.pendingPersist = run.catch(() => undefined)
    return run
  }

  /**
   * Validate and fix store data
   */
  private async validateAndFixStore(defaultLang: string): Promise<void> {
    // Ensure locale is supported
    if (!this.supportedLocales.includes(this.store.locale)) {
      this.store.locale = defaultLang
    }

    // Set default values for optional fields
    if (!this.store.currency) {
      this.store.currency = 'USD'
    }

    // normalizeAvailableChainType migrates unknown or build-disabled chains.
    // A persisted regtest selection is kept here: whether it may be used is an
    // asynchronous background capability (optional loopback permission +
    // acknowledgement + service identity) that the wallet controller checks
    // at startup before any endpoint is initialized, falling back to mainnet.
    this.store.chainType = normalizeAvailableChainType(this.store.chainType)

    if (typeof this.store.regtestAccessAck !== 'string') {
      delete this.store.regtestAccessAck
    }

    if (typeof this.store.externalLinkAck !== 'boolean') {
      this.store.externalLinkAck = false
    }

    if (typeof this.store.enableSignData !== 'boolean') {
      this.store.enableSignData = false
    }

    if (typeof this.store.showSafeNotice !== 'boolean') {
      this.store.showSafeNotice = true
    }

    if (!this.store.balanceMap) {
      this.store.balanceMap = {}
    }

    if (!this.store.historyMap) {
      this.store.historyMap = {}
    }

    if (!this.store.walletSavedList) {
      this.store.walletSavedList = []
    }

    if (!this.store.keyringAlianNames) {
      this.store.keyringAlianNames = {}
    }

    if (!this.store.accountAlianNames) {
      this.store.accountAlianNames = {}
    }

    if (!this.store.addressFlags) {
      this.store.addressFlags = {}
    }

    if (!this.store.uiCachedData) {
      this.store.uiCachedData = {}
    }

    // Validate current account
    if (this.store.currentAccount && !this.store.currentAccount.pubkey) {
      // Old version account format, reset
      this.store.currentAccount = undefined
    }

    if (!this.store.rateUsStatus) {
      this.store.rateUsStatus = {
        hasRated: false,
        ratePromptDismissedAt: null,
        hasShownSecondPrompt: false,
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
    const historyMap = this.store.historyMap || {}
    this.store.historyMap = {
      ...historyMap,
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
   * Currency management
   */
  getCurrency(): string {
    return this.store.currency
  }

  setCurrency(currency: string): void {
    this.store.currency = currency
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
   * Editing state
   */
  getEditingKeyringIndex(): number {
    return this.store.editingKeyringIndex
  }

  setEditingKeyringIndex(keyringIndex: number): void {
    this.store.editingKeyringIndex = keyringIndex
  }

  getEditingAccount(): Account | null {
    return cloneDeep(this.store.editingAccount) || null
  }

  setEditingAccount(account?: Account | null): void {
    this.store.editingAccount = account
  }

  /**
   * UI cached data management
   */
  getUICachedData(address: string): any {
    if (!this.store.uiCachedData[address]) {
      this.expireUICachedData(address)
    }
    return this.store.uiCachedData[address]
  }

  expireUICachedData(address: string): void {
    this.store.uiCachedData = { ...this.store.uiCachedData, [address]: {} }
  }

  /**
   * Safety and preferences
   */
  getShowSafeNotice(): boolean {
    return this.store.showSafeNotice
  }

  setShowSafeNotice(showSafeNotice: boolean): void {
    this.store.showSafeNotice = showSafeNotice
  }

  getEnableSignData(): boolean {
    return this.store.enableSignData
  }

  setEnableSignData(enableSignData: boolean): Promise<void> {
    return this.setAndPersist('enableSignData', enableSignData)
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
   * Get wallet saved list
   */
  getWalletSavedList(): any[] {
    return this.store.walletSavedList || []
  }

  updateWalletSavedList(list: any[]): void {
    this.store.walletSavedList = list
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
    return this.store.autoLockTimeId ?? DEFAULT_LOCKTIME_ID
  }

  setAutoLockTimeId(id: number): Promise<void> {
    return this.setAndPersist('autoLockTimeId', id)
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
   * Theme mode (Extension-specific)
   */
  getThemeMode(): ThemeMode {
    const themeMode = this.store.themeMode
    return themeMode && THEME_MODES.includes(themeMode) ? themeMode : DEFAULT_THEME_MODE
  }

  setThemeMode(themeMode: ThemeMode): void {
    this.store.themeMode = THEME_MODES.includes(themeMode) ? themeMode : DEFAULT_THEME_MODE
  }

  /**
   * Guide read status (Mobile-specific)
   */
  getGuideReaded(): boolean {
    return this.store.guideReaded || false
  }

  setGuideReaded(guideReaded: boolean): void {
    this.store.guideReaded = guideReaded
  }

  /**
   * Address summary management (Mobile-specific)
   */
  getAddressSummary(address: string): any {
    const summaryMap = this.store.addressSummary || {}
    return summaryMap[address] || null
  }

  setAddressSummary(address: string, summary: any): void {
    const summaryMap = this.store.addressSummary || {}
    this.store.addressSummary = {
      ...summaryMap,
      [address]: summary,
    }
  }

  // Rate Us Status
  getRateUsStatus = () => {
    return this.store.rateUsStatus
  }

  setHasRated = (hasRated: boolean) => {
    this.store.rateUsStatus = {
      ...this.store.rateUsStatus,
      hasRated,
    }
  }

  setRatePromptDismissedAt = (timestamp: number | null) => {
    this.store.rateUsStatus = {
      ...this.store.rateUsStatus,
      ratePromptDismissedAt: timestamp,
    }
  }

  setHasShownSecondPrompt = (hasShown: boolean) => {
    this.store.rateUsStatus = {
      ...this.store.rateUsStatus,
      hasShownSecondPrompt: hasShown,
    }
  }

  resetRateUsStatus = () => {
    this.store.rateUsStatus = {
      hasRated: false,
      ratePromptDismissedAt: null,
      hasShownSecondPrompt: false,
    }
  }

  getAcceptLowFeeMode = (): boolean => {
    return this.store.acceptLowFeeMode || false
  }

  setAcceptLowFeeMode = (accept: boolean): void => {
    this.store.acceptLowFeeMode = accept
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
