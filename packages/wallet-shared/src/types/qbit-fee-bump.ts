export type QbitFeeBumpUnavailableReason =
  | 'confirmed'
  | 'gone'
  | 'non_replaceable'
  | 'not_wallet_transaction'
  | 'no_change'
  | 'insufficient_change'
  /**
   * A later transaction spends one of its outputs: the replacement would
   * evict that payment, so the bump is refused.
   */
  | 'has_descendants'
  /**
   * A send plan holds one of its inputs: the plan tracks this transaction
   * until it confirms or the plan is removed from the home screen, and
   * nothing outside the plan replaces it.
   */
  | 'held_by_send_plan'
  /**
   * An input spends an output the wallet's signing refuses, read and checked
   * against its funding transaction as the wallet checks every input it
   * signs: an unconfirmed output whose transaction, or an unconfirmed one
   * before it, spends an output that is not the account's (someone else's
   * unconfirmed payment to the account, or change from an unconfirmed
   * transaction that also spent someone else's output). Only an original
   * signed without that check spends one: through a website's request, or
   * by other software holding the same key. Change with too many
   * unconfirmed transactions before it, and a coinbase's immature output,
   * are refused the same way, but an original the mempool accepted spends
   * one only while the explorer lags or after a reorganisation. The
   * replacement would be refused, so it is not offered.
   */
  | 'inputs_not_spendable'
  | 'unverifiable'

export interface QbitFeeBumpDetails {
  originalTxid: string
  /**
   * How many outputs the original has, counted from its raw bytes once
   * they were shown to hash to `originalTxid`. Its broadcast checks what
   * spends each of them without reading those bytes again.
   */
  originalOutputCount: number
  originalFee: number
  replacementFee: number
  feeDelta: number
  originalFeeRate: number
  replacementFeeRate: number
  replacementVsize: number
  changeBefore: number
  changeAfter: number
  changeDropped: boolean
}

export type QbitFeeBumpEligibility =
  | ({ eligible: true } & QbitFeeBumpDetails)
  | {
      eligible: false
      reason: QbitFeeBumpUnavailableReason
    }
