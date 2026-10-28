export enum RiskType {
  SIGHASH_NONE,
  SCAMMER_ADDRESS,
  NETWORK_NOT_MATCHED,
  LOW_FEE_RATE,
  HIGH_FEE_RATE,
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
}
