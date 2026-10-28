export { WalletProvider, useWallet } from './WalletProvider'
export * from './types'

// Re-export core types from wallet-connect
export type {
  Account,
  ChainType,
  QbitBalance,
  WalletConfig,
  WalletNotifier,
  WalletTranslator,
  WalletType,
  P2mrMessageProof,
} from '@qbit/wallet-connect'

export {
  BaseWallet,
  QbitWallet,
  ChainType as ChainTypeEnum,
  WalletType as WalletTypeEnum,
  isP2MRAddress,
  isSupportedAddressType,
} from '@qbit/wallet-connect'
