import type { ChainType } from '@qbit/wallet-types'

import type {
  QbitProviderApprovalContext,
  QbitProviderChain,
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
  // Marks an entry that duplicates an earlier PSBT in the same approved
  // signPsbts batch: the earlier entry may sign and cache this entry's
  // approved signatures first, which signing must tolerate.
  qbitApprovedBatchDuplicate?: boolean
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
