/**
 * Cross-platform preference service types
 */

import { EventEmitter } from 'eventemitter3'
import { ChainType } from '@qbit/wallet-types'
import { Account, QbitBalance, ThemeMode, TxHistoryItem } from '@qbit/wallet-shared'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'

// Base preference store structure
export interface BasePreferenceStore {
  // Account management
  currentKeyringIndex: number
  currentAccount: Account | undefined | null

  // User preferences
  locale: string
  externalLinkAck: boolean

  // Network configuration
  chainType: ChainType

  // Data maps
  balanceMap: {
    [address: string]: QbitBalance
  }
  historyMap: {
    [address: string]: TxHistoryItem[]
  }
  alianNames?: Record<string, string>
  keyringAlianNames: {
    [key: string]: string
  }
  /**
   * Wallet colors by keyring key, as palette keys (WALLET_COLOR_KEYS). A
   * stored value that is not a palette key reads as no color.
   */
  keyringColors: {
    [key: string]: string
  }
  accountAlianNames: {
    [key: string]: string
  }
  addressFlags: { [key: string]: number }

  // Version management
  initAlianNames: boolean
  firstOpen: boolean
  skippedVersion: string

  // Extension-specific fields (optional)
  autoLockTimeId?: number
  /** Lock the wallet when the computer locks (`chrome.idle` reports `locked`). */
  lockOnComputerLock?: boolean
  /** Lock the wallet when the last normal browser window closes. */
  lockOnWindowsClosed?: boolean
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
  /**
   * A wallet reset recorded this before it erased the wallets, and resetAllData
   * clears it with every other preference once the rest of the wallet data is
   * cleared. While nothing is booted, it means that clearing is still owed.
   * Only `true` counts.
   */
  walletResetPending?: boolean
  /**
   * The wallet removals whose send plans may not all be ended yet, one entry
   * each (QbitSendPlanRemovalRecord): a removal writes its entry before it
   * changes anything, and it is forgotten once nothing of its accounts' plans
   * is left, or once its wallet is found still there. Each entry carries its
   * version, and one this version cannot read is kept as it is stored
   * (getQbitSendPlanRemovals). Absent in a new store and in one saved before
   * it existed, which reads as none; resetAllData drops it with the wallets.
   */
  qbitSendPlanRemovals?: unknown
  /**
   * The identity of the wallet set up in this browser: an opaque random
   * value made the first time it is asked for (createWalletId), tied to
   * nothing else. resetAllData drops it with the wallets, and the next
   * wallet gets another. Absent in a new store and in one saved before it
   * existed.
   */
  walletId?: string

  enableRBF: boolean
}

/** An account whose send plans a wallet removal ends: a Qbit network and the address on it. */
export interface QbitSendPlanRemovalAccount {
  chain: ChainType
  address: string
}

/** A wallet removal's entry in `qbitSendPlanRemovals`, version 1. */
export interface QbitSendPlanRemovalRecord {
  version: 1
  /** 32 lower-case hex digits, random. */
  id: string
  /**
   * The wallet removed: its slot, which a removal leaves empty for good and
   * no wallet added later takes, and its keyring type.
   */
  wallet: { index: number; type: string }
  /** The accounts whose send plans the removal ends, as the plans name them. */
  accounts: QbitSendPlanRemovalAccount[]
}

/** The wallet removal records stored, as this version reads them (getQbitSendPlanRemovals). */
export interface QbitSendPlanRemovals {
  records: QbitSendPlanRemovalRecord[]
  /**
   * The entries this version cannot read, kept as they are stored: how many,
   * and every account they name in `accounts` in the form a record's has.
   */
  unreadable: { count: number; accounts: QbitSendPlanRemovalAccount[] }
}

// Extension-specific additions
export interface ExtensionPreferenceStore extends BasePreferenceStore {
  autoLockTimeId: number
  lockOnComputerLock: boolean
  lockOnWindowsClosed: boolean
  openInSidePanel: boolean
  developerMode: boolean
  themeMode: ThemeMode
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
