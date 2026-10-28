// Keyring types
export enum KeyringType {
  HdKeyring = 'HD Key Tree',
  QbitHdKeyring = 'Qbit HD Key Tree',
  SimpleKeyring = 'Simple Key Pair',
  ColdWalletKeyring = 'Cold Wallet',
  ReadonlyKeyring = 'Readonly',
  WatchAddressKeyring = 'Watch Address',
  Empty = 'Empty',
}

import { AddressType, ChainType, NetworkType } from '@qbit/wallet-types'

import { SupportedLocale } from '../types/i18n'

export enum WordsType {
  WORDS_12,
  WORDS_24,
}

export const ADDRESS_TYPES: {
  value: AddressType
  label: string
  name: string
  hdPath: string
  displayIndex: number
  usesBip44Path?: boolean
}[] = [
  {
    value: AddressType.P2PKH,
    label: 'P2PKH',
    name: 'P2PKH',
    hdPath: "m/44'/0'/0'/0",
    displayIndex: 3,
    usesBip44Path: false,
  },
  {
    value: AddressType.P2WPKH,
    label: 'P2WPKH',
    name: 'Native Segwit (P2WPKH)',
    hdPath: "m/84'/0'/0'/0",
    displayIndex: 0,
    usesBip44Path: false,
  },
  {
    value: AddressType.P2TR,
    label: 'P2TR',
    name: 'Taproot (P2TR)',
    hdPath: "m/86'/0'/0'/0",
    displayIndex: 2,
    usesBip44Path: false,
  },
  {
    value: AddressType.P2SH_P2WPKH,
    label: 'P2SH-P2WPKH',
    name: 'Nested Segwit (P2SH-P2WPKH)',
    hdPath: "m/49'/0'/0'/0",
    displayIndex: 1,
    usesBip44Path: false,
  },
  {
    value: AddressType.BIP44_P2WPKH,
    label: 'P2WPKH',
    name: 'Native SegWit (P2WPKH)',
    hdPath: "m/44'/0'/0'/0",
    displayIndex: 4,
    usesBip44Path: true,
  },
  {
    value: AddressType.BIP44_P2TR,
    label: 'P2TR',
    name: 'Taproot (P2TR)',
    hdPath: "m/44'/0'/0'/0",
    displayIndex: 5,
    usesBip44Path: true,
  },
  {
    value: AddressType.P2MR,
    label: 'P2MR',
    name: 'Post-Quantum P2MR',
    hdPath: "m/87'/0'/0'/0",
    displayIndex: 6,
    usesBip44Path: false,
  },
]

export const KEYRING_CLASS = {
  PRIVATE_KEY: 'Simple Key Pair',
  MNEMONIC: 'HD Key Tree',
}

export const KEYRING_TYPE_TEXT = {
  [KeyringType.HdKeyring]: 'Created by Mnemonic',
  [KeyringType.QbitHdKeyring]: 'Created by Mnemonic',
  [KeyringType.SimpleKeyring]: 'Imported by Private Key',
  [KeyringType.ColdWalletKeyring]: 'Cold Wallet',
  [KeyringType.WatchAddressKeyring]: 'Watch Address',
}
export const BRAND_ALIAN_TYPE_TEXT = {
  [KeyringType.HdKeyring]: 'Account',
  [KeyringType.QbitHdKeyring]: 'Account',
  [KeyringType.SimpleKeyring]: 'Private Key',
  [KeyringType.ColdWalletKeyring]: 'Account',
  [KeyringType.ReadonlyKeyring]: 'Readonly',
  [KeyringType.WatchAddressKeyring]: 'Watch',
}

export const MAX_ALIAS_NAME_LENGTH = 20

export const KEYRING_TYPES: {
  [key: string]: {
    name: string
    tag: string
    alianName: string
  }
} = {
  'HD Key Tree': {
    name: 'HD Key Tree',
    tag: 'HD',
    alianName: 'HD Wallet',
  },
  'Qbit HD Key Tree': {
    name: 'Qbit HD Key Tree',
    tag: 'P2MR',
    alianName: 'Qbit HD Wallet',
  },
  'Simple Key Pair': {
    name: 'Simple Key Pair',
    tag: 'IMPORT',
    alianName: 'Single Wallet',
  },
  'Cold Wallet': {
    name: 'Cold Wallet',
    tag: 'COLD',
    alianName: 'Cold Wallet',
  },
  Readonly: {
    name: 'Readonly',
    tag: 'READONLY',
    alianName: 'Readonly',
  },
  'Watch Address': {
    name: 'Watch Address',
    tag: 'WATCH',
    alianName: 'Watch Wallet',
  },
}

export const IS_CHROME =
  // @ts-ignore
  typeof navigator !== 'undefined' ? /Chrome\//i.test(navigator.userAgent) : false

export const IS_FIREFOX =
  // @ts-ignore
  typeof navigator !== 'undefined' ? /Firefox\//i.test(navigator.userAgent) : false

export const IS_LINUX =
  // @ts-ignore
  typeof navigator !== 'undefined' ? /linux/i.test(navigator.userAgent) : false

let chromeVersion: number | null = null

if (IS_CHROME) {
  // @ts-ignore
  const matches = navigator.userAgent.match(/Chrome\/(\d+[^.\s])/)
  if (matches && matches.length >= 2) {
    chromeVersion = Number(matches[1])
  }
}

export const IS_AFTER_CHROME91 = IS_CHROME ? chromeVersion && chromeVersion >= 91 : false

export const GAS_LEVEL_TEXT = {
  slow: 'Standard',
  normal: 'Fast',
  fast: 'Instant',
  custom: 'Custom',
}

export const IS_WINDOWS =
  // @ts-ignore
  typeof navigator !== 'undefined' ? /windows/i.test(navigator.userAgent) : false

export const LANGS = [
  {
    value: 'en',
    label: 'English',
  },
  {
    value: 'zh_CN',
    label: 'Chinese',
  },
  {
    value: 'ja',
    label: 'Japanese',
  },
  {
    value: 'es',
    label: 'Spanish',
  },
]

export function getQbitHdPathForChainType(chainType: ChainType, change = 0): string {
  const coinType = chainType === ChainType.QBIT_MAINNET ? 0 : 1
  return `m/87'/${coinType}'/0'/${change}`
}

export const NETWORK_TYPES = [
  {
    value: NetworkType.MAINNET,
    label: 'LIVENET',
    name: 'livenet',
    validNames: [0, 'livenet', 'mainnet'],
  },
  {
    value: NetworkType.TESTNET,
    label: 'TESTNET4',
    name: 'testnet4',
    validNames: ['testnet4', 'testnet'],
  },
  { value: NetworkType.REGTEST, label: 'REGTEST', name: 'regtest', validNames: ['regtest'] },
]

export type TypeChain = {
  enum: ChainType
  label: string
  iconLabel: string
  icon: string
  unit: string
  networkType: NetworkType
  endpoints: string[]
  qbitApiSurface?: 'esplora' | 'mempool-qbit'
  mempoolSpaceUrl: string
  websiteUrl: string
  contentUrl: string
  isViewTxHistoryInternally?: boolean
  disable?: boolean
  svg?: string
  iconBaseUrl?: string
  enableLowFeeMode?: boolean
  mainnetReady?: boolean
}

const PROD_CHAINS_MAP: { [key: string]: TypeChain } = {
  [ChainType.QBIT_TESTNET4]: {
    enum: ChainType.QBIT_TESTNET4,
    label: 'Qbit Testnet4',
    iconLabel: 'Testnet4',
    icon: 'qbitTestnet',
    unit: 'QBT',
    networkType: NetworkType.TESTNET,
    endpoints: ['https://mempool-testnet.qbit.org/api'],
    mempoolSpaceUrl: 'https://mempool-testnet.qbit.org',
    qbitApiSurface: 'mempool-qbit',
    websiteUrl: 'https://qbit.org',
    contentUrl: 'https://static.qbit.org/content',
    iconBaseUrl: 'https://static.qbit.org/icon',
    svg: 'qbit-testnet',
  },
  [ChainType.QBIT_REGTEST]: {
    enum: ChainType.QBIT_REGTEST,
    label: 'Qbit Regtest',
    iconLabel: 'Regtest',
    icon: 'qbitRegtest',
    unit: 'QBT',
    networkType: NetworkType.REGTEST,
    // The loopback endpoint is reachable only after the background regtest
    // capability (optional host permission + acknowledgement + service
    // identity) reports it available; that asynchronous gate lives in the
    // wallet controller, not in this static table. Keep the literal in sync
    // with QBIT_REGTEST_ORIGIN (constants/qbit-regtest.ts).
    endpoints: ['http://127.0.0.1:3002'],
    mempoolSpaceUrl: '',
    websiteUrl: 'http://127.0.0.1:3002',
    contentUrl: '',
    iconBaseUrl: '',
    svg: 'qbit-signet',
  },
  [ChainType.QBIT_MAINNET]: {
    enum: ChainType.QBIT_MAINNET,
    label: 'Qbit Mainnet',
    iconLabel: 'Mainnet',
    icon: 'qbitMainnet',
    unit: 'QBT',
    networkType: NetworkType.MAINNET,
    endpoints: ['https://mempool.qbit.org/api'],
    mempoolSpaceUrl: 'https://mempool.qbit.org',
    qbitApiSurface: 'mempool-qbit',
    websiteUrl: 'https://qbit.org',
    contentUrl: 'https://static.qbit.org/content',
    iconBaseUrl: 'https://static.qbit.org/icon',
    enableLowFeeMode: true,
    svg: 'qbit-mainnet',
    mainnetReady: true,
  },
}

const DEV_CHAINS_MAP: { [key: string]: TypeChain } = {}

export const CHAINS_MAP = PROD_CHAINS_MAP

export const normalizeChainType = (chainType?: ChainType | string): ChainType => {
  if (chainType && CHAINS_MAP[chainType]) {
    return chainType as ChainType
  }
  return ChainType.QBIT_MAINNET
}

// Persistence-layer variant: also migrates chains that exist but are not
// selectable in this build (disabled or not mainnet-ready) so restored state
// can't pin the wallet to an unreachable network. Regtest is not handled here:
// its availability is an asynchronous background capability (browser
// permission, acknowledgement, service identity) that the wallet controller
// checks at startup before any endpoint is used. Selection flows keep using
// normalizeChainType so a disabled pick still surfaces "not available" instead
// of silently rewriting.
export const normalizeAvailableChainType = (chainType?: ChainType | string): ChainType => {
  const normalized = normalizeChainType(chainType)
  const chain = CHAINS_MAP[normalized]
  if (!chain || chain.disable || chain.mainnetReady === false) {
    return ChainType.QBIT_MAINNET
  }
  return normalized
}

export const CHAINS = [
  CHAINS_MAP[ChainType.QBIT_MAINNET]!,
  CHAINS_MAP[ChainType.QBIT_TESTNET4]!,
  CHAINS_MAP[ChainType.QBIT_REGTEST]!,
]

export type TypeChainGroup = {
  type: 'single' | 'list'
  chain?: TypeChain
  label?: string
  icon?: string
  items?: TypeChain[]
}

export const PROD_CHAIN_GROUPS: TypeChainGroup[] = [
  {
    type: 'single',
    chain: PROD_CHAINS_MAP[ChainType.QBIT_MAINNET]!,
  },
  {
    type: 'single',
    chain: PROD_CHAINS_MAP[ChainType.QBIT_TESTNET4]!,
  },
  {
    type: 'single',
    chain: PROD_CHAINS_MAP[ChainType.QBIT_REGTEST]!,
  },
]

export const DEV_CHAIN_GROUPS: TypeChainGroup[] = [
  {
    type: 'list',
    label: 'Qbit Networks',
    icon: 'testnet-all',
    items: [
      PROD_CHAINS_MAP[ChainType.QBIT_MAINNET]!,
      PROD_CHAINS_MAP[ChainType.QBIT_TESTNET4]!,
      PROD_CHAINS_MAP[ChainType.QBIT_REGTEST]!,
    ],
  },
]

export const CHAIN_GROUPS = PROD_CHAIN_GROUPS

export const MINIMUM_GAS_LIMIT = 21000

export enum WATCH_ADDRESS_CONNECT_TYPE {
  WalletConnect = 'WalletConnect',
}

export const WALLETCONNECT_STATUS_MAP = {
  PENDING: 1,
  CONNECTED: 2,
  WAITING: 3,
  SIBMITTED: 4,
  REJECTED: 5,
  FAILD: 6,
}

export const INTERNAL_REQUEST_ORIGIN = 'https://qbit.org'

export const INTERNAL_REQUEST_SESSION = {
  name: 'Qbit Wallet',
  origin: INTERNAL_REQUEST_ORIGIN,
  icon: './images/logo/logo@128x.png',
}

export const BUS_EVENTS = {
  broadcastToUI: 'broadcastToUI',
  broadcastToBG: 'broadcastToBG',
}

export const BUS_METHODS = {
  CHAIN_CHANGED: 'chainChanged',
  ACCOUNTS_CHANGED: 'accountsChanged',
  LOCKED: 'walletLocked',
  UNLOCKED: 'walletUnlocked',
  AUTO_LOCKED: 'walletAutoLocked',
  SIGN_FINISHED: 'signFinished',
  LOCALE_CHANGED: 'localeChanged',
  REGTEST_ACCESS_CHANGED: 'regtestAccessChanged',

  USER_UI_INTERACT: 'USER_UI_INTERACT', // used to notify background script that user has interacted with the UI
}

/**
┌─────────────────────────────────────────────────────────────┐
│ UI (ui-messaging.ts)                                        │
│   ✅ UI_CONTROLLER / UI_OPENAPI / UI_BROADCAST              │
└─────────────────────────────────────────────────────────────┘
                            ↕️
┌─────────────────────────────────────────────────────────────┐
│ Background (messaging.ts)                                   │
│   ✅ receive: UI_CONTROLLER / UI_OPENAPI / UI_BROADCAST        │
│   ✅ send: BG_BROADCAST                                     │
│   ✅ push: BG_TO_CONTENT                                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
        📡 Chrome Extension Port API
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ PortMessage (portMessage.ts)                                │
│   ✅ receive: QBIT_WALLET_BG_TO_CONTENT                        │
│   ✅ emit: PM_BG_TO_CONTENT                                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Content Script (scriptInjector.ts)                          │
│   ✅ pm.on: PM_BG_TO_CONTENT                                   │
│   ✅ bcm.send: BCM_CONTENT_TO_CHANNEL                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
        📻 BroadcastChannel API
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ BroadcastChannelMessage (broadcastChannelMessage.ts)        │
│   ✅ receive: BCM_CONTENT_TO_CHANNEL                               │
│   ✅ emit: BCM_CHANNEL_TO_PAGE                                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ PageProvider (providerCore.ts)                              │
│   ✅ _bcm.on: BCM_CHANNEL_TO_PAGE                               │
│   ✅ provider.emit: 'accountsChanged', 'networkChanged'...  │
└─────────────────────────────────────────────────────────────┘

 */
export const MESSAGE_TYPE = {
  // UI ↔ Background Communication
  UI_CONTROLLER: 'ui_controller', // from ui to bg controller
  UI_OPENAPI: 'ui_openapi', // from ui to bg openapi
  UI_REQUEST_METHOD: 'ui_request_method', // from ui to bg request method
  UI_BROADCAST: 'ui_broadcast', // from ui to bg broadcast
  BG_BROADCAST: 'bg_broadcast', // from bg to ui broadcast

  // Background → Content Script (via Port)
  PM_BG_TO_CONTENT: 'pm_bg_to_content',

  // Content Script → BroadcastChannel (via postMessage)
  BCM_CONTENT_TO_CHANNEL: 'bcm_content_to_channel', // content script to channel

  // BroadcastChannel → PageProvider (via emit)
  BCM_CHANNEL_TO_PAGE: 'bcm_channel_to_page', // channel to page provider

  REQUEST: 'request',
  RESPONSE: 'response',
}

export const PORT_CHANNELS = {
  POPUP: 'popup',
  QBIT_PROVIDER: 'qbit-provider',
}

export const SESSION_EVENTS = {
  chainChanged: 'chainChanged',
  networkChanged: 'networkChanged',
  accountsChanged: 'accountsChanged',
  disconnect: 'disconnect',
  lock: 'lock',
  unlock: 'unlock',
}

export const COIN_NAME = 'QBT'
export const COIN_SYMBOL = 'QBT'

export const COIN_DUST = 1000
export const QBIT_P2MR_DUST = 2855

export const TO_LOCALE_STRING_CONFIG = {
  minimumFractionDigits: 8,
}

export const SAFE_DOMAIN_CONFIRMATION = 3

export const DISCORD_URL = 'https://discord.gg/xqC7MAk95Q'
export const TWITTER_URL = 'https://x.com/QbitDotOrg'
export const WEBSITE_URL = 'https://qbit.org'
export const FEEDBACK_URL = 'https://qbit.org'
export const EMAIL_URL = 'contact@qbit.org'
export const DOCS_URL = 'https://qbit.org'
export const UPDATE_URL = 'https://qbit.org'
export const TERMS_OF_SERVICE_URL = 'https://qbit.org'
export const PRIVACY_POLICY_URL = 'https://qbit.org'
export const UNCONFIRMED_HEIGHT = 4194303

// Labels use $1-substitution keys so each locale controls the spacing
// between the number and the unit (e.g. "30 Seconds" vs "30秒").
export const getAutoLockTimes = (t: any) => [
  { id: 0, time: 30000, label: t('n_seconds', '30') },
  { id: 1, time: 60000, label: t('n_minute', '1') },
  { id: 2, time: 180000, label: t('n_minutes', '3') },
  { id: 3, time: 300000, label: t('n_minutes', '5') },
  { id: 4, time: 600000, label: t('n_minutes', '10') },
  { id: 5, time: 1800000, label: t('n_minutes', '30') },
  { id: 6, time: 3600000, label: t('n_hour', '1') },
  { id: 7, time: 14400000, label: t('n_hours', '4') },
]

export const getLockTimeInfo = (id: number, t?: any) => {
  const AUTO_LOCK_TIMES = getAutoLockTimes(t || ((s: string) => s))
  const item = AUTO_LOCK_TIMES.find(v => v.id === id)
  if (item) {
    return item
  }
  return AUTO_LOCK_TIMES.find(v => v.id === DEFAULT_LOCKTIME_ID)!
}

export const DEFAULT_LOCKTIME_ID = 2

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']

export const DEFAULT_THEME_MODE: ThemeMode = 'system'

// localStorage cache read by build/_raw/theme-init.js before first paint.
export const THEME_MODE_STORAGE_KEY = 'themeMode'

export const FALLBACK_LOCALE = 'en'

export const BROWSER_TO_APP_LOCALE_MAP: Record<string, string> = {
  'zh-CN': 'zh_TW',
  'zh-TW': 'zh_TW',
  'zh-Hans': 'zh_TW',
  'zh-Hant': 'zh_TW',
}

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'fr', 'es', 'ru', 'ja', 'zh_TW']

export const LOCALE_NAMES = {
  en: 'English',
  zh_TW: '中文(繁體)',
  fr: 'Français',
  es: 'Español',
  ru: 'Русский',
  ja: '日本語',
}

export const DEFAULT_I18N_CONFIG = {
  fallbackLocale: FALLBACK_LOCALE,
  supportedLocales: SUPPORTED_LOCALES,
  debug: false,
}

export enum FeeRateType {
  SLOW,
  AVG,
  FAST,
  CUSTOM,
}
