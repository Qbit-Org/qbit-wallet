import type { QbitProviderNetwork } from './qbit-provider'

export type QbitRecoveryLifecycleStatus = 'clean' | 'seed-only-restored' | 'migrating' | 'migrated'

export type QbitRecoveryAcknowledgement = 'required' | 'accepted'

export type QbitRecoveryMigrationPlanStatus = 'prepared' | 'signed' | 'broadcast' | 'confirmed'

export interface QbitRecoveryMigrationPlanSummary {
  id: string
  sourceAddress: string
  destinationAddress: string
  amount: number
  fee: number
  status: QbitRecoveryMigrationPlanStatus
  txid?: string
  /** Source account derivation index (per-account sweeps). */
  sourceIndex?: number
  /**
   * Destination account derivation index, allocated contiguously from 0 so a
   * fresh restore of the destination seed stays inside the gap limit; version-1
   * plans paid the anchor (index 0).
   */
  destinationIndex?: number
}

export interface QbitRecoveryMigrationSummary {
  destinationKeyringIndex: number
  /** Destination anchor address; each plan carries its own pay-to address. */
  destinationAddress: string
  network: QbitProviderNetwork
  plans: QbitRecoveryMigrationPlanSummary[]
}

/**
 * Recovery lifecycle as it applies to one network. The keyring vault tracks
 * every network separately; this projection carries the active network's
 * record plus cross-network hints the UI needs.
 */
export interface QbitRecoveryState {
  status: QbitRecoveryLifecycleStatus
  acknowledgement: QbitRecoveryAcknowledgement
  /**
   * The user permanently dismissed the home-screen recovery warning after
   * acknowledging continued use; the UI keeps the migration/archive cards.
   */
  warningDismissed?: boolean
  counterConfidence: 'local' | 'chain-floor-only'
  knownOnChainSignatures: number
  migration?: QbitRecoveryMigrationSummary
  /**
   * Another network's migration already recorded a destination wallet, so
   * this network's migration can sweep to it instead of minting a fresh seed.
   */
  migrationDestinationReusable?: boolean
  /** Other networks on this seed still await their own recovery migration. */
  otherNetworksPendingRecovery?: boolean
}

/**
 * A source account a migration pass could not plan, and why. Its funds keep
 * the migration open until a later pass plans them. A pass returns these to
 * the UI; they are not stored.
 */
export type QbitRecoveryDeferredSource =
  | {
      address: string
      /**
       * The explorer will not list its outputs, and its history is longer than
       * the wallet reads to find them (more than `maxTransactions`).
       * Consolidating it to within the listing limit lets a later pass list
       * them.
       */
      reason: 'history_too_large'
      maxTransactions: number
    }
  | {
      address: string
      /**
       * The explorer will not list its outputs, and its history, which the
       * wallet reads them from, could not be read in full: the explorer's
       * pages did not match the address statistics through every retry. A
       * later pass reads it again.
       */
      reason: 'history_incomplete'
    }

/**
 * One way removing a wallet would touch an active recovery migration.
 * `source` — the restored wallet whose vault holds the migration record;
 * `destination` — the fresh wallet the migration sweeps to; `unverified` — a
 * wallet that could not be checked against the recorded destination identity
 * and may be it. These feed the UI's risk-confirmation step; they never hard
 * block a removal.
 */
export interface QbitRecoveryRemovalReason {
  role: 'source' | 'destination' | 'unverified'
  network?: QbitProviderNetwork
  status?: 'migrating' | 'migrated'
  /** A sweep plan is signed or broadcast but not yet confirmed. */
  hasInflightPlans?: boolean
}

export interface QbitRemoveKeyringOptions {
  /**
   * The user saw this removal's QbitRecoveryRemovalReasons and confirmed
   * them. The retention check re-runs on the confirmed retry and re-prompts
   * (never hard blocks) only when it surfaces a risk line absent from the
   * acknowledged reasons — recovery state can change while the confirmation
   * is open.
   */
  acknowledgedQbitRecoveryRisks?: boolean
  /** The reason set the confirmed warning displayed. */
  acknowledgedQbitRecoveryReasons?: QbitRecoveryRemovalReason[]
}

/**
 * Internal binding carried by a migration PSBT. The wallet controller checks
 * every field against encrypted migration state before the counter-safe signer
 * is allowed to run.
 */
export interface QbitRecoveryMigrationSigningData {
  sourceKeyringIndex: number
  destinationKeyringIndex: number
  network: QbitProviderNetwork
  planId: string
  sourceAddress: string
  destinationAddress: string
  /** Destination derivation index for per-account plans. */
  destinationIndex?: number
}
