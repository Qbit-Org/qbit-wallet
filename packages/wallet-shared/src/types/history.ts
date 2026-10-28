export interface TxHistoryInOutItem {
  /** Zero-based index in the transaction's vin or vout array. */
  index: number
  /** Absent when the chain payload has no address (for example OP_RETURN). */
  address?: string
  /** Absent when an input's previous output is unavailable. */
  value?: number
  /** Public locking script metadata. Never contains wallet signing material. */
  scriptPubKey?: string
  scriptType?: string
  /** True only when the address belongs to the complete logical account. */
  owned: boolean
  /** Owned output returning value while paying an external recipient. */
  change?: boolean
  /** Owned input/output participating in a cross-address self transfer. */
  internal?: boolean
  /** Input-only metadata. */
  coinbase?: boolean
  prevTxid?: string
  prevVout?: number
  prevoutMissing?: boolean
}

export type TxHistoryDirection = 'receive' | 'send' | 'self'

export interface TxHistoryItem {
  txid: string
  confirmations: number
  height: number
  timestamp: number
  size: number
  feeRate: number
  fee: number
  outputValue: number
  vin: TxHistoryInOutItem[]
  vout: TxHistoryInOutItem[]
  types: string[]
  methods: string[]
  /**
   * Account-aware semantics:
   * - receive (without mixed funding): no owned inputs; amount is the owned output total.
   * - send (without mixed funding): owned inputs fund non-owned outputs; amount is the external
   *   output total, excluding fee.
   * - self: all relevant non-coinbase inputs and all outputs are owned; amount is the owned value
   *   moved internally.
   * - mixed funding: transactions with both owned and external inputs use receive for a non-negative
   *   account delta and send for a negative delta; amount is the absolute account delta.
   *
   * Optional: address-keyed cache reads can return entries persisted without direction analysis.
   */
  direction?: TxHistoryDirection
  amount?: number
  /** Signed account balance delta before lifecycle interpretation: owned outputs - owned inputs. */
  netAmount?: number
  ownedInputValue?: number
  ownedOutputValue?: number
  /**
   * Direction-appropriate, unique public-chain addresses. Mixed-funded transactions include
   * external participant addresses from both inputs and outputs. May be empty when unavailable.
   */
  counterparties?: string[]
  /** BIP125: unconfirmed and at least one input signals replaceability. Confirmed txs are never replaceable. */
  replaceable?: boolean
  /** Session-level flag: a previously pending tx that vanished from fresh history without confirming. */
  replaced?: boolean
}
