import type { ChainType } from '@qbit/wallet-types'

export enum RiskType {
  SIGHASH_NONE,
  SCAMMER_ADDRESS,
  NETWORK_NOT_MATCHED,
  LOW_FEE_RATE,
  HIGH_FEE_RATE,
  UNRECOGNISED_OUTPUT,
}

export interface Risk {
  type: RiskType
  level: 'danger' | 'warning' | 'critical'
  title: string
  desc: string
}

export interface DecodedPsbtInput {
  txid: string
  vout: number
  sequence?: number
  address: string
  value: number
  witnessUtxoScriptHex?: string
  sighashType: number
}

interface DecodedPsbtOutputBase {
  address: string
  value: number
  scriptPubKeyHex?: string
}

export interface DecodedOpReturnChunk {
  /** Exact push opcode and length bytes as they appear in scriptPubKey. */
  pushHeaderHex: string
  /** Exact pushed bytes. */
  dataHex: string
  dataByteLength: number
  /** Zero-based, half-open data byte range within scriptPubKey. */
  dataStartByte: number
  dataEndByte: number
  /** Supplemental preview, only present for conservatively safe UTF-8 text. */
  utf8Preview?: string
}

export type DecodedOpReturnWarning = 'malformed-pushdata' | 'non-pushdata-opcode'

export interface DecodedOpReturn {
  /** Canonical source of truth: the exact output script bytes from the reviewed PSBT. */
  scriptPubKeyHex: string
  /** Exact chunks recovered from the original script without normalizing push encodings. */
  chunks: DecodedOpReturnChunk[]
  /** Present when the entire script cannot be represented as OP_RETURN followed by data pushes. */
  decodeWarning?: DecodedOpReturnWarning
}

export interface DecodedPsbtAddressOutput extends DecodedPsbtOutputBase {
  type?: 'address'
  opReturn?: never
}

export interface DecodedPsbtOpReturnOutput extends DecodedPsbtOutputBase {
  type: 'op_return'
  /** OP_RETURN has no payment address; raw script metadata is carried separately. */
  address: ''
  opReturn: DecodedOpReturn
}

export type DecodedPsbtOutput = DecodedPsbtAddressOutput | DecodedPsbtOpReturnOutput

/** Why the wallet flagged a fee as abnormal; see `assessQbitFee`. */
export type QbitFeeWarningReason =
  /** The rate is at least `QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE` times the fastest live recommended rate. */
  | 'above_recommended_rate'
  /** The rate is at least `QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE` times the relay floor, whatever the explorer recommends. */
  | 'above_relay_floor'
  /**
   * The fee is at least `QBIT_FEE_WARNING_AMOUNT_PERCENT` of the amount sent, at a rate at least
   * `QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE` times the recommendation. For a website's PSBT it is
   * also flagged, whatever its rate, when the fee is at least that multiple of what the smallest
   * send costs at the recommendation (`checkFeeShareWithoutSize`).
   */
  | 'large_share_of_amount'

export interface QbitFeeAssessment {
  /** Exact fee in bits (satoshis). */
  fee: number
  /** Fee rate in bits/vB. */
  feeRate: number
  /**
   * The amount the fee is compared with: what the transaction pays to others. When other parties
   * fund some of its inputs, a website's PSBT compares the fee with what leaves the wallet (its
   * inputs less the outputs paying it), and the wallet's own screens with nothing. 0 when there is
   * nothing to compare with: nothing but the fee leaves the wallet.
   */
  amount: number
  /** The fastest live recommended rate. Absent when the explorer's rates are unavailable, so no comparison was made. */
  recommendedFeeRate?: number
  /** Empty when the fee is normal. */
  reasons: QbitFeeWarningReason[]
  /**
   * Set when only the share check that needs no size flagged the fee (`checkFeeShareWithoutSize`):
   * the fee is a large share of the amount, but its rate meets no rate condition, so the fee and
   * not its rate is what is high.
   */
  highFeeAtNormalRate?: true
}

/** What an output of a reviewed PSBT pays, from the wallet's point of view. */
export type PsbtOutputRole =
  /** One of this wallet's own addresses: change, or another of its accounts. */
  | 'wallet'
  /** The recipient the request named. */
  | 'recipient'
  /** An OP_RETURN data output. */
  | 'data'
  /** Neither the wallet's nor the named recipient, including a script with no address. */
  | 'unrecognised'

/**
 * Which of the wallet's accounts an output pays, from the scripts and addresses
 * the wallet derives for them, never from records the PSBT carries about it.
 */
export type PsbtOutputOwner =
  /**
   * Change to the account signing the PSBT: the wallet funds every input, and
   * the request does not name the output's address as its recipient.
   */
  | 'change'
  /** The account signing the PSBT, as a payment it may be receiving rather than change. */
  | 'this_account'
  /** Another of the wallet's accounts. */
  | 'other_account'
  /** None of the wallet's accounts, including an OP_RETURN data output. */
  | 'none'

/**
 * A BIP68 relative lock on one input of a transaction with version 2 or more:
 * the transaction can be mined only once the coin the input spends has been
 * mined for that many blocks, or that much of the network's median time.
 */
export interface PsbtRelativeLock {
  /** The input's index; its nSequence, in `inputInfos`, sets the lock. */
  input: number
  /** Counted in blocks, or in seconds of the network's median time. */
  type: 'blocks' | 'time'
  /** Blocks, or seconds, a multiple of 512. Never 0, which holds nothing back. */
  value: number
}

/**
 * What a PSBT does to the wallet, computed by the background from the exact
 * bytes it decoded. It is only valid for those bytes and for `account`.
 */
export interface PsbtSpendSummary {
  /** The current account when the summary was computed. */
  account: string
  /** Value of the inputs spent from the wallet's own addresses. */
  walletInputValue: number
  /** Value of the outputs paid back to the wallet's own addresses. */
  walletOutputValue: number
  /**
   * What leaves the wallet, fee included: `walletInputValue - walletOutputValue`.
   * Negative when the wallet gains. Absent when an input's spent output is
   * missing, so its owner and value are unknown.
   */
  netSpend?: number
  /** Value of every output that does not pay the wallet. */
  externalOutputValue: number
  /** One role for each output, in output order. */
  outputRoles: PsbtOutputRole[]
  unrecognisedOutputCount: number
  unrecognisedOutputValue: number
  /** Unrecognised outputs whose script has no address the wallet can show. */
  undecodableOutputCount: number
  /**
   * Absent when there is no fee to judge: an input's spent output is missing, or the outputs
   * exceed the inputs (a partial PSBT others will add inputs to).
   */
  feeAssessment?: QbitFeeAssessment
}

export interface DecodePsbtOptions {
  /** Addresses the request itself names as recipients; their outputs are not unrecognised. */
  statedRecipients?: string[]
  /**
   * A website supplied the PSBT's bytes (signPsbt, signPsbts; see `isWebsiteSuppliedPsbt`), so its
   * size rests on records the website wrote and its fee is also judged without that size. Omitted,
   * the PSBT is judged as one the wallet built, as a website's sendQbit is.
   */
  suppliedByWebsite?: boolean
}

export interface DecodedPsbt {
  inputInfos: DecodedPsbtInput[]
  outputInfos: DecodedPsbtOutput[]
  feeRate: number
  fee: number
  features: {
    rbf: boolean
  }
  risks: Risk[]
  isScammer: boolean
  recommendedFeeRate: number
  shouldWarnFeeRate: boolean
  isCompleted: boolean
  spendSummary: PsbtSpendSummary
  /** One owner for each output, in output order, for the account `spendSummary` is relative to. */
  outputOwners?: PsbtOutputOwner[]
  /** The transaction's version. */
  version?: number
  /**
   * The transaction's nLockTime: 0 for none, a block height below 500,000,000,
   * and a Unix time from it. Not enforced when every input's sequence is final.
   */
  locktime?: number
  /**
   * The inputs' relative locks, in input order: empty when the version is
   * below 2 or no input's sequence sets one. For display only.
   */
  relativeLocks?: PsbtRelativeLock[]
}

export interface PsbtLocalInfo {
  inputCount: number
  outputCount: number
  /** Formatted fee rate string, e.g. "12.5" or "≈12.5", "-" if unknown */
  feeRate: string
  /** Miner fee in satoshis; 0 if PSBT is not completed */
  fee: number
  /** Total value of all inputs in satoshis; 0 if PSBT is not completed */
  totalInput: number
  isCompleted: boolean
  hasSighashNone: boolean
  parseError: boolean
  /**
   * The risks a review of this PSBT on its own would gate signing on (an
   * abnormal fee, an unrecognised output), from the same bytes. Empty when it
   * failed to parse.
   */
  risks: Risk[]
  /** What the PSBT does to the wallet, for `LocalPsbtSummary.account`. Absent when it failed to parse. */
  spendSummary?: PsbtSpendSummary
}

export interface LocalPsbtSummary {
  /** Sum of miner fees across all completed PSBTs */
  totalFee: number
  /** Sum of all input values across all completed PSBTs. */
  totalInput: number
  completedCount: number
  hasSighashNone: boolean
  parseErrorCount: number
  /** Per-PSBT decoded info for display in the multi-sign list */
  items: PsbtLocalInfo[]
  /** The current account the batch was analyzed for. */
  account: string
  /** The network the batch was analyzed on. */
  chain: ChainType
}

/**
 * What the user reviewed before quick-signing one PSBT of a local batch
 * (`signLocalBatchPsbt`): the account and network the batch was analyzed
 * for, and the risks of this PSBT the user explicitly confirmed.
 */
export interface LocalPsbtBatchReview {
  account: string
  chain: ChainType
  confirmedRisks: RiskType[]
}
