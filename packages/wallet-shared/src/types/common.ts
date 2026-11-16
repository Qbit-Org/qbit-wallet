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
  /** Present for qbit provider quotes and for the fallback quote offered without estimates. */
  quote?: FeeQuoteMetadata
}

export interface WalletConfig {
  version: string
  statusMessage: string
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
 * that do not support this breakdown. `null` marks a value that could not be
 * measured, which is never the same as 0.
 */
export interface QbitBalanceSummary {
  /** `null` when unknown: past the explorer's limit while no output read from the address's history applies (see `utxoLimitExceeded`), when the wallet could not finish reading the outputs the explorer lists (see `utxoReadIncomplete`), or when the balance read stopped waiting for the send guard. */
  availableBalance: number | null
  unavailableBalance: number
  totalBalance: number
  /** Qbit: current-script coinbase value below 1,000 confirmations (subset of unavailable); `null` when unknown. */
  immatureBalance?: number | null
  /** Qbit: unconfirmed current-script value sends wait for, such as payments from others (subset of unavailable); `null` when unknown. */
  pendingBalance?: number | null
  /**
   * Qbit: the explorer would not list this address's outputs because it holds
   * more than the explorer's UTXO limit. `totalBalance` then comes from the
   * address statistics, and `immatureBalance` and `pendingBalance` are
   * `null`. The split comes from the outputs the wallet last read from the
   * address's history, while the statistics still read as they did for that
   * read: `availableBalance` is what a send may select from them, less the
   * outputs a send holds, never more than the total, and
   * `unavailableBalance` is the rest. Without such a read, or while the send
   * guard does not answer, `availableBalance` is `null` and
   * `unavailableBalance` stays `totalBalance`.
   */
  utxoLimitExceeded?: boolean
  /**
   * Qbit: the address statistics were read, but the wallet could not finish
   * reading the address's outputs: the listing or a transaction lookup
   * failed, or the read ran out of time (an account with thousands of
   * outputs takes several reads to work through). `totalBalance` comes from
   * the address statistics. The split is unknown, never 0: `availableBalance`,
   * `immatureBalance` and `pendingBalance` are `null` and
   * `unavailableBalance` stays `totalBalance`. Never set together with
   * `utxoLimitExceeded`, which is the explorer refusing to list the outputs
   * at all. The next read tries again.
   */
  utxoReadIncomplete?: boolean
  /**
   * Qbit, only together with `utxoReadIncomplete`: the read of the outputs
   * got no further. It stopped on a failure (the listing or a transaction
   * lookup failed, or the explorer answered something the wallet could not
   * use), or it ran out of time without reading anything the next read can
   * build on. Both show the same as any incomplete read; a poll treats this
   * one as a failed read and backs off, while a read that ran out of time
   * part of the way through the outputs is read again at the normal pace.
   */
  utxoReadFailed?: boolean
  chainType: ChainType
}
