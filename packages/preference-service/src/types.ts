/**
 * Cross-platform preference service types
 */

import { EventEmitter } from 'eventemitter3'
import { ChainType } from '@qbit/wallet-types'
import {
  Account,
  AddressSummary,
  QbitBalance,
  ThemeMode,
  TxHistoryItem,
} from '@qbit/wallet-shared'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'

// Base preference store structure
export interface BasePreferenceStore {
  // Account management
  currentKeyringIndex: number
  currentAccount: Account | undefined | null
  editingKeyringIndex: number
  editingAccount: Account | undefined | null

  // User preferences
  locale: string
  currency: string
  externalLinkAck: boolean
  enableSignData: boolean
  showSafeNotice: boolean

  // Network configuration
  chainType: ChainType

  // Data maps
  balanceMap: {
    [address: string]: QbitBalance
  }
  historyMap: {
    [address: string]: TxHistoryItem[]
  }
  watchAddressPreference: Record<string, number>
  walletSavedList: any[]
  alianNames?: Record<string, string>
  keyringAlianNames: {
    [key: string]: string
  }
  accountAlianNames: {
    [key: string]: string
  }
  addressFlags: { [key: string]: number }

  // UI and app data
  uiCachedData: {
    [address: string]: Record<string, never>
  }
  // Version management
  initAlianNames: boolean
  currentVersion: string
  firstOpen: boolean
  skippedVersion: string

  // Extension-specific fields (optional)
  autoLockTimeId?: number
  openInSidePanel?: boolean
  developerMode?: boolean
  themeMode?: ThemeMode
  /**
   * Version tag of the local-regtest explanation the user acknowledged before
   * the optional loopback permission was requested. Consent only; the
   * background still requires the live browser permission and a verified
   * service before regtest becomes selectable.
   */
  regtestAccessAck?: string

  // Mobile-specific fields (optional)
  guideReaded?: boolean
  addressSummary?: {
    [address: string]: AddressSummary
  }

  // Mobile-specific fields (optional)
  rateUsStatus: RateUsStatus

  acceptLowFeeMode: boolean
  enableRBF: boolean
}

export interface RateUsStatus {
  hasRated: boolean
  ratePromptDismissedAt: number | null
  hasShownSecondPrompt: boolean
}

// Extension-specific additions
export interface ExtensionPreferenceStore extends BasePreferenceStore {
  autoLockTimeId: number
  openInSidePanel: boolean
  developerMode: boolean
  themeMode: ThemeMode
}

// Mobile-specific additions
export interface MobilePreferenceStore extends BasePreferenceStore {
  guideReaded: boolean
  addressSummary: {
    [address: string]: AddressSummary
  }
}

// Service configuration
export interface PreferenceServiceConfig {
  storage: ProxyStorageAdapter
  logger?: any
  t?: any
  eventBus?: EventEmitter
  platformDefaults?: Partial<BasePreferenceStore>
  getBrowserLanguages?: () => Promise<string[]>
}

// Service events
export interface PreferenceServiceEvents {
  'account:changed': (account: Account | null) => void
  'locale:changed': (locale: string) => void
  'currency:changed': (currency: string) => void
  'chain:changed': (chainType: ChainType) => void
  'preference:updated': (key: string, value: any) => void
  'preference:error': (error: Error) => void
}

// Migration interface
export interface MigrationHandler {
  fromVersion: string
  toVersion: string
  migrate: (data: any) => any
}
