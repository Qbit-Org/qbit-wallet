import { ChainType } from '@qbit/wallet-types'

export interface Chain {
  name: string
  logo: string
  enum: ChainType
  network: string
}

export type FeeQuoteSource = 'esplora' | 'mempool-qbit'
export type FeeQuoteAvailability = 'available' | 'unavailable'
export type FeeQuoteFreshness = 'live' | 'cached' | 'fallback'
export type FeeQuoteFallbackReason = 'empty' | 'invalid' | 'stale' | 'unavailable'

/**
 * Qbit fee-estimate provenance. It is optional so quote-less FeeSummary
 * values retain their existing contract.
 */
export interface FeeQuoteMetadata {
  source: FeeQuoteSource
  availability: FeeQuoteAvailability
  freshness: FeeQuoteFreshness
  /** Provider observation time in Unix milliseconds; absent for static fallback. */
  fetchedAt?: number
  fallbackReason?: FeeQuoteFallbackReason
}
export interface FeeSummary {
  list: {
    title: string
    desc: string
    feeRate: number
    /** Qbit confirmation target; one qbit block is expected every minute. */
    targetBlocks?: number
  }[]
  /** Present for qbit provider and relay-floor fallback quotes. */
  quote?: FeeQuoteMetadata
}

export interface WalletConfig {
  version: string
  moonPayEnabled: boolean
  statusMessage: string
  endpoint: string
  chainTip: string
  disableUtxoTools: boolean
}

export interface VersionDetail {
  version: string
  title: string
  changelogs: string[]
  notice: string
}

/**
 * Provider balance breakdown. Qbit uses disjoint availability buckets:
 * `availableBalance` is the value a send may select on the current P2MR
 * script (confirmed, mature value plus the unconfirmed change of the script's
 * own transactions) and `unavailableBalance` is the remainder of
 * `totalBalance`. The optional qbit detail fields remain absent for providers
 * that do not support this breakdown.
 */
export interface QbitBalanceSummary {
  availableBalance: number
  unavailableBalance: number
  totalBalance: number
  /** Qbit: current-script coinbase value below 1,000 confirmations (subset of unavailable). */
  immatureBalance?: number
  /** Qbit: unconfirmed current-script value sends wait for, such as payments from others (subset of unavailable). */
  pendingBalance?: number
  /**
   * Qbit: the explorer would not list this address's outputs because it holds
   * more than the explorer's UTXO limit. `totalBalance` then comes from the
   * address statistics and nothing is reported available, since the wallet
   * cannot select inputs it cannot see.
   */
  utxoLimitExceeded?: boolean
  chainType: ChainType
}
