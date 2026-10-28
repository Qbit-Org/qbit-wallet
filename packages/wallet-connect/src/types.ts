/**
 * Supported chain types for wallet connections
 */
export enum ChainType {
  QBIT_TESTNET4 = 'QBIT_TESTNET4',
  QBIT_REGTEST = 'QBIT_REGTEST',
  QBIT_MAINNET = 'QBIT_MAINNET',
}

export const ALL_CHAIN_TYPES = [
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
  ChainType.QBIT_MAINNET,
] as const

/**
 * Wallet type identifiers
 */
export enum WalletType {
  Qbit = 'qbit',
}

/**
 * Basic account information from wallet
 */
export interface Account {
  address: string
  pubKey: string
  paymentAccount?: {
    address: string
    pubKey: string
  }
}

/**
 * Qbit balance information
 */
export interface QbitBalance {
  confirmed: number
  unconfirmed: number
  total: number
}

export type QbitNetwork = 'mainnet' | 'testnet4' | 'regtest'

export interface QbitSignPsbtOptions {
  chain: ChainType
  autoFinalized?: boolean
}

export interface QbitSendOptions {
  feeRate?: number
  memo?: string
  memos?: string[]
}

/**
 * Wallet configuration
 */
export interface WalletConfig {
  name: string
  icon: string
  type: WalletType
  supportChain: ChainType[]
  logoPadding?: number
  downloadUrl?: string
}

/**
 * Translator function type for i18n support
 */
export type WalletTranslator = (key: string, values?: Record<string, unknown>) => string

/**
 * Notifier interface for wallet notifications
 * Implement this interface to provide custom notification UI
 */
export interface WalletNotifier {
  warning(options: {
    message: string
    description?: string
    key?: string
    onClick?: () => void
  }): void
  destroy(key: string): void
}

/**
 * Wallet listener callbacks
 */
export interface WalletListenerParams {
  onAccountChange: (accounts: string[]) => void
  onNetworkChange: (network: QbitNetwork) => void
  onChainChange?: (chain: ChainType) => void
  onDisconnect?: (reason: unknown) => void
}

/**
 * PSBT signing parameters
 */
export interface SignPsbtParams {
  psbt: string
}

/**
 * Wallet connection options
 */
export interface WalletConnectOptions {
  /** Current chain type to connect */
  chainType: ChainType
  /** Optional translator for i18n */
  translator?: WalletTranslator
  /** Optional notifier for UI feedback */
  notifier?: WalletNotifier
}

/**
 * Chain detection flags based on chain type
 */
export interface ChainFlags {
  isQbitMainnet: boolean
  isQbitTestnet4: boolean
  isQbitRegtest: boolean
}

/**
 * Get chain flags from chain type
 */
export function getChainFlags(chainType: ChainType): ChainFlags {
  return {
    isQbitMainnet: chainType === ChainType.QBIT_MAINNET,
    isQbitTestnet4: chainType === ChainType.QBIT_TESTNET4,
    isQbitRegtest: chainType === ChainType.QBIT_REGTEST,
  }
}
