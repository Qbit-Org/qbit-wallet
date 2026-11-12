import type { ChainType } from '@qbit/wallet-types'

import type { QbitSignatureBudgetImpact } from './qbit-provider'

/**
 * A send plan pays an amount that needs more of the account's outputs than
 * one transaction can carry. It combines the account's own outputs with
 * transactions that pay the account's own address (merges), then pays the
 * recipient with one transaction that spends the merges' outputs once they
 * have confirmed. The user confirms the whole plan once; the background
 * signs, broadcasts and watches every transaction.
 *
 * The recipient is paid by exactly one transaction for exactly the confirmed
 * amount, or not at all. Until then every transaction of the plan only moves
 * the user's funds to their own address.
 */

/** Where one transaction of a plan stands. */
export type QbitSendPlanStepStatus =
  /** Not signed yet. */
  | 'planned'
  /** Signed and held by the wallet, not yet accepted by the network. */
  | 'signed'
  /** A broadcast ended without a verdict: the network may hold it. */
  | 'unknown'
  /** Accepted by the network, not yet in a block. */
  | 'broadcast'
  | 'confirmed'

export type QbitSendPlanPhase =
  /** Signing the plan's transactions; merges are broadcast as they are signed. */
  | 'signing'
  /** Everything is signed; the payment waits for the merges to confirm. */
  | 'waiting'
  /** The merges have confirmed and the payment is being broadcast. */
  | 'sending'
  /** The network accepted the payment. */
  | 'completed'
  /** Stopped until the user acts; see `QbitSendPlanPause`. */
  | 'paused'
  /** Cancelled; a transaction whose outcome is unknown is still being settled. */
  | 'cancelling'

/**
 * Why a plan stopped. In every case the recipient has received nothing and
 * the user's funds are in their own wallet, partly merged.
 */
export type QbitSendPlanPauseReason =
  /** The wallet locked before signing finished. Signing continues after an unlock. */
  | 'locked'
  /** Signing was cut short by a restart of the browser or the extension, or failed. */
  | 'interrupted'
  /** A merge cannot be sent as planned. The plan needs to be reviewed again. */
  | 'merge_refused'
  /** Something outside the plan spent one of its outputs. */
  | 'outputs_spent'
  /** The network refuses the payment's fee at the current rate. */
  | 'payment_fee_too_low'
  /** The network refused the payment for another reason, and it is proven not sent. */
  | 'payment_refused'
  /** The stored plan cannot be read by this version of the wallet. */
  | 'unreadable'

export interface QbitSendPlanPause {
  reason: QbitSendPlanPauseReason
  /** Sanitized technical detail for a collapsed disclosure; never a URL or payload. */
  detail?: string
}

/** What the user may do with a plan right now; the background decides, the UI offers. */
export type QbitSendPlanAction =
  /** Carry on with the plan as confirmed: sign what is left, or send again. */
  | 'continue'
  /** Review a new plan for the same recipient and amount from the account's current outputs. */
  | 'replan'
  /** Replace a merge that has stayed unconfirmed with one that pays a higher fee. */
  | 'raise_merge_fee'
  /** Build the payment again at a higher fee. */
  | 'raise_payment_fee'
  | 'cancel'
  /** Remove a finished plan from the home screen. */
  | 'dismiss'

export interface QbitSendPlanStepView {
  kind: 'merge' | 'payment'
  txid: string
  inputCount: number
  fee: number
  status: QbitSendPlanStepStatus
}

/** An open plan as the UI shows it. Carries no transaction bytes. */
export interface QbitSendPlanView {
  id: string
  chain: ChainType
  /** The paying account's address. */
  address: string
  recipient: string
  target: 'amount' | 'everything'
  /** Exactly what the recipient receives, in bits. */
  amount: number
  change: number
  feeRate: number
  /** Every merge's fee plus the payment's fee. */
  totalFee: number
  /** The merges in order, then the payment. */
  steps: QbitSendPlanStepView[]
  /**
   * A transaction of this plan, or one that a fee raise replaced and that
   * may still confirm, has been sent or may be in the network: cancelling
   * leaves it there, and its fee is paid.
   */
  sent: boolean
  /**
   * A version of the payment left the wallet without a verdict and may
   * still confirm: the plan cannot be cancelled or reviewed again until that
   * is settled, and the recipient may still be paid by it.
   */
  paymentMayConfirm?: true
  phase: QbitSendPlanPhase
  /** Present while `phase` is `paused`. */
  pause?: QbitSendPlanPause
  actions: QbitSendPlanAction[]
  /** The transaction being signed now and how far it is. */
  signing?: { step: number; signed: number; total: number }
  signaturesDone: number
  signaturesTotal: number
  /** A merge has stayed unconfirmed for a long time; `raise_merge_fee` is offered. */
  slowMerge?: boolean
  /** The payment's transaction id, fixed when the plan was confirmed. */
  paymentTxid: string
  createdAt: number
  updatedAt: number
  /** Grows with every change; a view with a lower number than one already shown is stale. */
  revision: number
}

/** A change to an open plan, reviewed and confirmed like a new plan. */
export interface QbitSendPlanRevision {
  planId: string
  kind: 'replan' | 'raise_merge_fee' | 'raise_payment_fee'
}

export interface QbitSendPlanPrepareParams {
  to: string
  target: { kind: 'amount'; amount: number } | { kind: 'everything' }
  /** Bits/vB for every transaction of the plan. */
  feeRate: number
  enableRBF?: boolean
  memo?: string
  memos?: string[]
  /** Revise this open plan instead of starting a new one; `to` and `target` must match it. */
  revise?: QbitSendPlanRevision
}

/** The whole plan, priced before anything is signed. */
export interface QbitSendPlanReview {
  /** Names this review to `startQbitSendPlan`; valid until `expiresAt`. */
  draftId: string
  chain: ChainType
  address: string
  recipient: string
  target: 'amount' | 'everything'
  /** Exactly what the recipient will receive, in bits. */
  amount: number
  change: number
  feeRate: number
  /** Fees of every transaction the plan still has to send, plus `paidFee`. */
  totalFee: number
  /** Fees of merges an earlier version of this plan already sent; 0 for a new plan. */
  paidFee: number
  merges: { inputCount: number; fee: number }[]
  payment: { inputCount: number; fee: number; txid: string }
  /** Signatures the plan still needs. */
  signatureCount: number
  signatureBudget: QbitSignatureBudgetImpact
  estimatedSigningSeconds: number
  /** Confirmed funds the plan leaves in the account. */
  leftBehindSatoshis: number
  revises?: QbitSendPlanRevision
  /** With `revises`: the amount the plan being revised was confirmed for. */
  previousAmount?: number
  expiresAt: number
}

export type QbitSendPlanPrepareRefusal =
  /** The confirmed balance cannot cover the amount plus every fee. */
  | 'insufficient_balance'
  /** More merges than one payment can spend would be needed. */
  | 'exceeds_plan_size'
  | 'exceeds_maximum_total_fee'
  | 'nothing_to_send'
  /** The payment fits one transaction: use the ordinary send. */
  | 'not_needed'
  /** The account already has an open plan. */
  | 'plan_open'
  /** The account's outputs could not be read. */
  | 'outputs_unavailable'
  /** A revision's fee rate is not high enough to replace what is already in the network. */
  | 'fee_rate_too_low'

export type QbitSendPlanPrepareResult =
  | { ok: true; review: QbitSendPlanReview }
  | {
      ok: false
      reason: QbitSendPlanPrepareRefusal
      /** The largest amount a plan can send to this recipient now; 0 when none. */
      maxSendable: number
      /** Funds that are still unconfirmed and that a plan cannot spend yet. */
      unconfirmedSatoshis: number
      /** With `fee_rate_too_low`: the lowest rate that works, rounded up to hundredths. */
      minimumFeeRate?: number
    }

export type QbitSendPlanStartResult =
  | { ok: true; plan: QbitSendPlanView }
  | {
      ok: false
      reason:
        | 'draft_expired'
        /** An output the draft would spend is no longer free. */
        | 'outputs_changed'
        | 'plan_open'
        | 'locked'
    }
