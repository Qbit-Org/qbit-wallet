import type { ChainType } from '@qbit/wallet-types'

import type { QbitBroadcastIdentity, QbitSendBroadcastClaim } from './sign-tx'

/**
 * Conservative verdict on a Qbit broadcast that did not clearly succeed.
 *
 * - `not_sent`: non-submission is proven. Either the wallet never dispatched
 *   the request (payload, guard, or network-switch failure observed before
 *   the bytes left the wallet) or the node definitively rejected the
 *   transaction and repeated follow-up lookups all found it absent.
 * - `unknown`: anything inconclusive. The node may have accepted the
 *   transaction even though the wallet saw an error, so the UI must never
 *   claim the payment did not go out.
 */
export type QbitBroadcastOutcome = 'not_sent' | 'unknown'

/**
 * Stable, user-safe reason keys. The UI maps them to localized copy; they
 * never carry endpoint URLs, response bodies, or exception text.
 */
export type QbitBroadcastFailureReason =
  | 'invalid_transaction'
  | 'guard_blocked'
  | 'chain_changed'
  | 'rejected'
  | 'network'
  | 'timeout'
  | 'server'
  | 'invalid_response'
  | 'unexpected'

/** What the post-failure lifecycle lookups reported for the expected txid. */
export type QbitBroadcastLookup = 'gone' | 'unavailable'

export interface QbitBroadcastSuccess {
  success: true
  /** Network the transaction was accepted on. */
  chain: ChainType
  txid: string
  /** Whether the broadcast response itself or a follow-up lookup proved acceptance. */
  via: 'broadcast' | 'lookup'
}

export interface QbitBroadcastFailure {
  success: false
  /** Network captured before dispatch; retries and status checks must target it. */
  chain?: ChainType
  /**
   * Expected txid computed before dispatch. Absent only when the signed
   * payload could not be parsed at all.
   */
  txid?: string
  outcome: QbitBroadcastOutcome
  reason: QbitBroadcastFailureReason
  /**
   * Present only for failures raised after the network request was
   * dispatched; its absence marks a failure that never left the wallet.
   */
  lookup?: QbitBroadcastLookup
  /**
   * Sanitized technical detail for a collapsed support disclosure. Never
   * contains URLs, raw response bodies, or transaction payloads.
   */
  detail?: string
}

export type QbitBroadcastResult = QbitBroadcastSuccess | QbitBroadcastFailure

export type QbitBroadcastStatusCheck =
  | { found: true; txid: string; state: 'pending' | 'confirmed' }
  | { found: false; txid: string; state: 'gone' | 'unavailable'; detail?: string }

/**
 * The exact signed payload the send flow retains in memory so a failed
 * broadcast can be retried byte-for-byte without signing again. It must never
 * be persisted, logged, or placed in Redux state.
 */
export interface QbitRetainedBroadcast {
  psbtHex: string
  /**
   * Network and expected txid the signer fixed before any broadcast. Every
   * broadcast of this payload is bound to that network, and a failure that
   * loses the controller's answer still reports both so status checks and
   * retries stay tied to the original transaction.
   */
  qbitBroadcastIdentity?: QbitBroadcastIdentity
  qbitSendBroadcastClaim?: QbitSendBroadcastClaim
}
