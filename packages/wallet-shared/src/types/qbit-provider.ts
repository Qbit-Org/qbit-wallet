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

/**
 * An entry of a batch of PSBTs approved together (a website's signPsbts, or
 * a local batch), which the user signs one at a time, in any order. Signing
 * it accepts exactly the signatures the batch's other entries reserved since
 * the approval, and nothing else.
 */
export interface QbitSignatureBatchEntry {
  id: string
  index: number
  /**
   * The whole batch's impact: every distinct signature its entries need,
   * counted once, from the remaining signatures before the batch to those
   * after all its entries. Unlike an entry's own budget it does not depend
   * on the order the entries sign in.
   */
  budget: QbitSignatureBudgetImpact
}
