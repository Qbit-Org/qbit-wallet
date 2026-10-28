import type { ChainType } from '@qbit/wallet-types'

export type QbitProviderNetwork = 'mainnet' | 'testnet4' | 'regtest'
export type QbitProviderChain =
  | ChainType.QBIT_MAINNET
  | ChainType.QBIT_TESTNET4
  | ChainType.QBIT_REGTEST

export interface QbitProviderApprovalContext {
  origin: string
  account: string
  chain: QbitProviderChain
  network: QbitProviderNetwork
}

export interface QbitSignatureBudgetImpact {
  required: number
  cached: number
  remainingBefore: number
  remainingAfter: number
  limit: number
  restoredFloorRisk?: {
    recoveryStatus: 'seed-only-restored'
    counterConfidence: 'chain-floor-only'
    knownOnChainSignatures: number
    challengeId: string
  }
}
