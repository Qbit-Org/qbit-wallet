import type { ChainType } from '@qbit/wallet-types'

import type {
  QbitProviderApprovalContext,
  QbitProviderChain,
  QbitSignatureBatchEntry,
  QbitSignatureBudgetImpact,
} from './qbit-provider'
import type { QbitFeeBumpDetails } from './qbit-fee-bump'
import type { QbitRecoveryMigrationSigningData } from './qbit-recovery-lifecycle'

interface BaseUserToSignInput {
  index: number
  sighashTypes: number[] | undefined
  useTweakedSigner?: boolean
  disableTweakSigner?: boolean
  tapLeafHashToSign?: string
}

export interface AddressUserToSignInput extends BaseUserToSignInput {
  address: string
}

export interface PublicKeyUserToSignInput extends BaseUserToSignInput {
  publicKey: string
}

export interface AddressUserToSignInput extends BaseUserToSignInput {
  address: string
}

export interface PublicKeyUserToSignInput extends BaseUserToSignInput {
  publicKey: string
}

export type UserToSignInput = AddressUserToSignInput | PublicKeyUserToSignInput
export interface SignPsbtOptions {
  autoFinalized?: boolean
  toSignInputs?: UserToSignInput[]
}

export interface QbitProviderSignPsbtOptions {
  chain: QbitProviderChain
  autoFinalized?: boolean
}

export interface ToSignInput {
  index: number
  publicKey: string
  sighashTypes?: number[] | undefined
  tapLeafHashToSign?: Buffer | string

  // special
  useTweakedSigner?: boolean
  disableTweakSigner?: boolean
}

export interface QbitP2mrSigningKeyInput {
  inputIndex: number
  publicKey: string
  leafHash: string
  hashType?: number
}

export interface QbitSendBroadcastClaim {
  chain: QbitProviderChain
  address: string
  origin: string
  txid: string
  outpoints: { txid: string; vout: number }[]
  /**
   * Wallet-owned claims only: the txid of the transaction this fee bump
   * replaces, or null for a send that replaces nothing. The page keeps the
   * claim with the signed bytes, so a retry after the background restarts
   * still checks for payments the bump would evict. A wallet claim without
   * it predates the field and is never restored; a provider claim never
   * names one.
   */
  replaces?: string | null
  /**
   * With `replaces`: how many outputs the replaced transaction has, from the
   * raw bytes the fee bump's assessment verified. Its broadcast checks what
   * spends each of them; a fee bump's claim without it is invalid. Kept with
   * the claim in memory only, like `replaces`.
   */
  replacedOutputCount?: number
}

export type QbitExternalSigningLockPurpose = 'send' | 'sign'

export interface QbitExternalSigningLockEntry {
  txid: string
  outpoints: { txid: string; vout: number }[]
}

export interface QbitExternalSigningLock {
  id: string
  purpose: QbitExternalSigningLockPurpose
  chain: QbitProviderChain
  address: string
  origin: string
  entries: QbitExternalSigningLockEntry[]
}

export interface ToSignData {
  psbtHex: string
  toSignInputs: ToSignInput[]
  autoFinalized?: boolean
  qbitP2mrSigningKeys?: QbitP2mrSigningKeyInput[]
  providerContext?: QbitProviderApprovalContext
  qbitSendBroadcastClaim?: QbitSendBroadcastClaim
  qbitExternalSigningLock?: QbitExternalSigningLock
  signatureBudget?: QbitSignatureBudgetImpact
  // Set on every entry of a batch approved together, whose entries sign in
  // any order: an entry may find signatures the others reserved spent.
  qbitSignatureBatch?: QbitSignatureBatchEntry
  feeBump?: QbitFeeBumpDetails
  qbitRecoveryMigration?: QbitRecoveryMigrationSigningData
  // Network and expected txid fixed when the wallet built this P2MR
  // transaction, before it was shown for approval. Its inputs exist only on
  // that network, so signing validates the request against this value
  // instead of the network selected at signing time, and every signer hands
  // it back on the result for the broadcast that follows.
  qbitBroadcastIdentity?: QbitBroadcastIdentity

  // extra info for display
  estimatedFee?: number
  estimatedVsize?: number
  inputCount?: number
  changeDroppedSats?: number
  inputsDominateFee?: boolean
  maximumTotalFee?: number
  // Send-all only: outputs the standard transaction weight kept out of this
  // transaction (the smallest ones). They stay in the account.
  leftBehindInputCount?: number
  leftBehindSats?: number
  // A batch of an over-limit account's consolidation; see QbitConsolidationBatch.
  qbitConsolidation?: QbitConsolidationBatch
  action?: PsbtActionInfo
}

/** What `createQbitConsolidationPsbt` takes to prepare the next batch. */
export interface QbitConsolidationRequest {
  /** Bits per vB; omitted means the normal rate, or the relay floor without a quote. */
  feeRate?: number
  /** Whether the batch signals replaceability; omitted means it does. */
  enableRBF?: boolean
  /**
   * Inputs the batch may carry: a whole number from 2
   * (`QBIT_CONSOLIDATION_MIN_INPUTS`) to the account's `maxInputCount`, as
   * `isQbitConsolidationBatchSize` checks. Omitted means the maximum.
   */
  maxInputs?: number
}

/**
 * The transaction shape of an account's consolidation batch, apart from its
 * inputs and fee rate. With an input count it is what
 * `estimateQbitP2mrTransaction` prices, and it is the shape
 * `qbitP2mrMaxStandardInputCount` sizes.
 */
export interface QbitConsolidationBatchShape {
  /** Output script lengths, in output order: the one output to the account's own script. */
  outputScriptLengths: number[]
  leafScriptLength: number
  controlBlockLength: number
}

/**
 * One batch of a consolidation (`createQbitConsolidationPsbt`): outputs of
 * an account the explorer will not list, sent whole to its own address.
 */
export interface QbitConsolidationBatch {
  /** Confirmed unspent outputs the explorer counted for the account before this batch. */
  confirmedOutputCount: number
  /** The explorer listing limit the wallet assumes (electrs `--utxos-limit`). */
  outputLimit: number
  /** What the batch's one output returns to the account: its inputs less the fee. */
  amount: number
  /**
   * For each input, in order, how many outputs its funding transaction has.
   * Signing re-reads each input's `/tx/:txid/outspends` with it, and an
   * answer of any other length refuses the batch.
   */
  fundingOutputCounts: number[]
  /**
   * The batch size this batch was prepared with: the request's `maxInputs`,
   * or the account's `maxInputCount` when none was given. The batch may
   * carry fewer inputs. The next batch is requested with it, so it keeps
   * the size.
   */
  maxInputs: number
}

/** Where an account stands against the explorer's listing limit (`getQbitConsolidationStatus`). */
export interface QbitConsolidationStatus {
  chain: ChainType
  address: string
  /** Confirmed outputs not spent in a block: what the explorer counts against its limit. */
  confirmedUnspent: number
  /** Outputs mempool transactions spend; they leave the count once those confirm. */
  pendingSpent: number
  /** Outputs mempool transactions create; they join the count once those confirm. */
  pendingFunded: number
  /** The explorer listing limit the wallet assumes (electrs `--utxos-limit`). */
  outputLimit: number
  /** Most inputs one consolidation batch carries within the standard size. */
  maxInputCount: number
  /**
   * The shape of this account's batch transaction, so the screen can price a
   * batch of a chosen size before one is prepared.
   */
  batchShape: QbitConsolidationBatchShape
}

/**
 * Network and expected txid of a Qbit P2MR transaction, fixed when the
 * wallet builds it and validated again at signing, before any broadcast.
 * The txid depends only on the inputs and outputs, so it is known before the
 * signature exists and stays valid for a byte-identical retry. The send flow
 * keeps both so a broadcast whose answer is lost can still be probed and
 * retried on the network the inputs live on.
 */
export interface QbitBroadcastIdentity {
  chain: ChainType
  txid: string
}

export interface SignedData {
  psbtHex?: string
  rawtx?: string
  signature?: string
  qbitBroadcastIdentity?: QbitBroadcastIdentity
  qbitSendBroadcastClaim?: QbitSendBroadcastClaim
}

export interface SignPsbtParams {
  data: {
    toSignDatas: ToSignData[]
  }
}

export type SignPsbtResult = SignedData[]

export enum SignState {
  PENDING,
  SUCCESS,
  FAILED,
}

export enum PsbtActionType {
  DEFAULT = 'DEFAULT',
  CUSTOM = 'CUSTOM',
}

export enum PsbtActionDetailType {
  TEXT = 'TEXT',
  ADDRESS = 'ADDRESS',
  AMOUNT = 'AMOUNT',
  SATOSHIS = 'SATOSHIS',
}

export interface PsbtActionDetail {
  label: string // label, e.g., "Lockup Period", "Fee Rate"
  value: any // value, e.g., "10 days", "0.5%"
  type?: PsbtActionDetailType
  highlight?: boolean // whether to highlight
  warning?: boolean // whether to show warning style
}

export interface PsbtActionInfo {
  name: string
  description: string
  details?: PsbtActionDetail[]
  icon?: string
  warning?: string
  type?: PsbtActionType
  extraProps?: any
}

export interface ApprovalSession {
  origin: string
  icon: string
  name: string
}
