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
