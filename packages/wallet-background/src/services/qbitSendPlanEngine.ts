import {
  bytesToHex,
  type P2mrSigningKey,
  type P2mrTransactionOutput,
  type Psbt,
} from '@qbit-oss/protocol'
import {
  AccountSignMethod,
  ErrorCodes,
  QBIT_P2MR_DUST,
  assertQbitFeeRateWithinPolicy,
  estimateQbitSendPlanSigningSeconds,
  getAccountCapabilities,
  isQbitSendPlanAmount,
  planQbitSend,
  sanitizeQbitBroadcastDetail,
  selectQbitP2mrSendCoins,
  type Account,
  type QbitBroadcastResult,
  type QbitSendPlan,
  type QbitSendPlanAction,
  type QbitSendPlanPauseReason,
  type QbitSendPlanPrepareParams,
  type QbitSendPlanPrepareResult,
  type QbitSendPlanReview,
  type QbitSendPlanRevision,
  type QbitSendPlanStartResult,
  type QbitSendPlanStepView,
  type QbitSendPlanTarget,
  type QbitSendPlanView,
  type QbitSelectableCoin,
  type QbitSignatureBudgetImpact,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS,
  QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED_CODE,
  QBIT_SIGNING_ABORTED_CODE,
} from '@qbit/keyring-service'

import {
  QBIT_SEND_PLAN_FINAL_SEQUENCE,
  QBIT_SEND_PLAN_RBF_SEQUENCE,
  buildQbitSendPlanSteps,
  checkQbitSendPlanStepPsbt,
  qbitSendPlanAccountKeys,
  qbitSendPlanAddressScript,
  qbitSendPlanPaymentTerms,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
  qbitSendPlanSignedTransaction,
  qbitSendPlanSigningKeys,
  qbitSendPlanStepExpectation,
  qbitSendPlanStoredPayment,
  sameQbitSendPlanOutputs,
  type QbitSendPlanAccountKeys,
} from '../utils/qbit-send-plan-psbt'
import {
  lowestQbitSendPlanRaiseRate,
  priceQbitSendPlanMerge,
  priceQbitSendPlanPayment,
  qbitSendPlanMergeReplaceable,
  type QbitSendPlanRevisionShape,
} from '../utils/qbit-send-plan-revision'
import {
  QBIT_RECENT_SPEND_GONE_GRACE_MS,
  QBIT_RECENT_SPEND_TTL_MS,
  QbitSendPlanHeldError,
  QbitSendPlanHoldConflictError,
  type QbitOutpoint,
  type QbitSendGuardService,
  type QbitSendPlanHold,
  type QbitSendPlanHoldRestoration,
  type QbitSendPlanOutpoints,
  type QbitSendPlanReplacement,
} from './qbitSendGuards'
import {
  QBIT_SEND_PLAN_MAX_CARRIED,
  QBIT_SEND_PLAN_MAX_EARLIER_PAYMENTS,
  QbitSendPlanStoreError,
  qbitSendPlanOutpoints,
  type QbitSendPlanCarriedStep,
  type QbitSendPlanPaidBy,
  type QbitSendPlanPaymentVersion,
  type QbitSendPlanRecord,
  type QbitSendPlanRecordInput,
  type QbitSendPlanStepRecord,
  type QbitSendPlanStore,
  type QbitSendPlanUnreadable,
} from './qbitSendPlanStore'

/**
 * How often the timer advances a plan that is signing, waiting, sending or
 * cancelling, and the least time between two explorer reads of the same
 * transaction, whatever advances the plan (see `QbitSendPlanEngine.lookup`).
 */
export const QBIT_SEND_PLAN_TICK_MS = 15_000

/**
 * How long a reviewed plan can be started at most; the review states the
 * end, which is earlier when the restored-floor challenge it carries
 * expires first (see `QbitSendPlanEngine.reviewExpiry`).
 */
export const QBIT_SEND_PLAN_DRAFT_TTL_MS = 10 * 60_000

/** A merge accepted this long ago and still unconfirmed is slow (`QbitSendPlanView.slowMerge`). */
export const QBIT_SEND_PLAN_SLOW_MERGE_MS = 30 * 60_000

/**
 * How many times one merge is sent while each attempt is proven not sent:
 * the first send and two more, a tick apart. The plan pauses after that.
 */
export const QBIT_SEND_PLAN_MERGE_SEND_ATTEMPTS = 3

/**
 * `QbitSendPlanView.revision` is the stored record's revision times this,
 * plus the changes the view showed since that revision was written (signing
 * progress, and anything derived from the clock or the lock). A write always
 * comes before this many such changes (see `QbitSendPlanEngine.viewOf`).
 */
export const QBIT_SEND_PLAN_VIEW_REVISION_STRIDE = 1_000_000

/**
 * A cancelled plan that cannot settle a merge whose outcome is unknown (its
 * lookups never answer) lets go of that merge's inputs after this long,
 * as the send guard lets go of a recent spend it never sees settled.
 */
export const QBIT_SEND_PLAN_CANCEL_BACKSTOP_MS = QBIT_RECENT_SPEND_TTL_MS

/** The id an unreadable stored plan without a readable id is shown under. */
export const QBIT_SEND_PLAN_UNREADABLE_ID = 'unreadable'

/** At most this many outspends reads per advance of a waiting plan. */
const QBIT_SEND_PLAN_OUTSPENDS_PER_ADVANCE = 8

/** At most this many lookups of already confirmed merges per advance of a waiting plan. */
const QBIT_SEND_PLAN_CONFIRMED_LOOKUPS_PER_ADVANCE = 8

/** One advance runs at most this many iterations before it lets the timer come back. */
const QBIT_SEND_PLAN_MAX_ITERATIONS = 1_000

/** A read-modify-write that keeps meeting newer revisions gives up after this many tries. */
const QBIT_SEND_PLAN_MUTATE_ATTEMPTS = 16
/** Why a plan cannot be prepared for the selected account, or no longer can be. */
const QBIT_SEND_PLAN_ACCOUNT_REQUIRED = 'Qbit send plans need an account this wallet signs for'

const PLAN_ID = /^[0-9a-f]{32}$/
const QBIT_CHAINS = new Set<unknown>([
  ChainType.QBIT_MAINNET,
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
])
const PAUSE_REASONS = new Set<string>([
  'locked',
  'interrupted',
  'merge_refused',
  'outputs_spent',
  'payment_fee_too_low',
  'payment_refused',
  'unreadable',
])
const REPLANNABLE = new Set<string>(['merge_refused', 'outputs_spent', 'payment_refused'])
const CONTINUABLE = new Set<string>([
  'locked',
  'interrupted',
  'payment_refused',
  'payment_fee_too_low',
])

/** The node's reasons for refusing a transaction whose inputs are spent or missing. */
const INPUTS_GONE_REASON =
  /bad-txns-inputs-missingorspent|missing-inputs|missing inputs|txn-mempool-conflict|bad-txns-inputs-spent/i
/** The node's reasons for refusing a transaction for its fee. */
const FEE_REASON =
  /mempool min fee not met|min relay fee not met|insufficient fee|min-fee-not-met|mempool full/i
/** The node's reason for refusing a child of too many or too large unconfirmed ancestors. */
const ANCESTOR_REASON = /too-long-mempool-chain/i

/** A refusal's detail that names an RPC code and nothing more (see `refusalHasReason`). */
const CODE_ONLY_DETAIL = /^(?:HTTP \d+:\s*)?(?:RPC error -?\d+)?$/i

/**
 * Whether a broadcast proven not sent says why: the node's reject reason,
 * which the explorer relays in some deployments. The production explorer
 * relays a refusal as its RPC code alone (`{"code":-26}`), and the broadcast
 * path's detail then names the code only; a plan then decides from what the
 * explorer can still tell, never from text that is not there.
 */
function refusalHasReason(result: QbitBroadcastResult): boolean {
  if (result.success) return false
  return !CODE_ONLY_DETAIL.test((result.detail ?? '').trim())
}

/** An output of the account, as a send reads it. */
export interface QbitSendPlanCoin extends QbitSelectableCoin {
  scriptPk?: string
}

/** The keyring operations the engine signs with; see `KeyringService`. */
export interface QbitSendPlanKeyring {
  preflightP2mrPsbtSigning(
    address: string,
    input: { psbt: Psbt; keys: readonly P2mrSigningKey[] }
  ): Promise<QbitSignatureBudgetImpact>
  openP2mrPsbtSigningBatch(
    address: string,
    inputs: readonly {
      psbt: Psbt
      keys: readonly P2mrSigningKey[]
      approvedBudget: QbitSignatureBudgetImpact
    }[]
  ): Promise<{ id: string; budget: QbitSignatureBudgetImpact }>
  releaseP2mrPsbtSigningBatches(batchIds: readonly string[]): void
  signP2mrPsbtWithCounter(
    address: string,
    input: { psbt: Psbt; keys: readonly P2mrSigningKey[] },
    expectedBudget: QbitSignatureBudgetImpact,
    signatureBatch: { id: string; index: number },
    options: {
      onProgress?: (signed: number, total: number, cached: number) => void
      signal?: AbortSignal
    }
  ): Promise<{ psbt: Psbt; counterResults: readonly { cached: boolean }[] }>
  confirmQbitRestoredFloorSigning(challengeId: string): Promise<void>
  releaseQbitRestoredFloorSigningChallenges(challengeIds: readonly string[]): void
}

/** What the engine needs from the wallet controller. */
export interface QbitSendPlanEngineHost {
  /** The wallet's active network. */
  activeChain(): ChainType
  /** The selected account. */
  currentAccount(): Account | null | undefined
  isUnlocked(): boolean
  /** How many locks were asked for so far: one during a signing means the wallet locked. */
  lockCount(): number
  /**
   * The script paying `to` when it is a P2MR address of `chain`, exactly as
   * the ordinary send accepts it; throws otherwise.
   */
  recipientScript(chain: ChainType, to: string): Uint8Array
  /** The memo outputs the ordinary send builds; throws for memos it refuses. */
  memoOutputs(memo: string | undefined, memos: string[] | undefined): P2mrTransactionOutput[]
  /**
   * `account`'s outputs on `chain` as the ordinary send reads them, less
   * every one a plan's hold would be refused on
   * (`QbitSendGuardService.getPlanUnavailableOutpointKeys`), the holds of
   * plan `exceptPlanId` left out of that. Throws when they cannot be read.
   */
  spendableOutputs(
    chain: ChainType,
    account: Account,
    exceptPlanId?: string
  ): Promise<QbitSendPlanCoin[]>
  /** The id of `psbt`'s transaction on `chain` (`qbitBroadcastIdentityOf`). */
  txidOf(psbt: Psbt, chain: ChainType): string
  /** Where `txid` stands on `chain`; throws when the explorer gives no answer. */
  lifecycle(chain: ChainType, txid: string): Promise<'confirmed' | 'pending' | 'gone'>
  /** What spends each output of `txid` on `chain`, in output order; throws without an answer. */
  spenders(chain: ChainType, txid: string): Promise<(string | undefined)[]>
  /**
   * The outputs of transaction `txid` on `chain`, in output order, each
   * script as lower-case hex, and its fee, as the explorer reports them;
   * throws without an answer.
   */
  transaction(
    chain: ChainType,
    txid: string
  ): Promise<{ outputs: { script: string; value: number }[]; fee: number }>
  /**
   * The wallet's broadcast of raw transaction `rawtx`, `txid` on `chain`,
   * under `hold` when the plan holds every input it spends, and, with
   * `replaces`, as the replacement of an earlier version of the step that
   * may still be in the network (see `QbitSendPlanReplacement`).
   */
  broadcast(params: {
    chain: ChainType
    rawtx: string
    txid: string
    hold: QbitSendPlanHold | undefined
    replaces?: QbitSendPlanReplacement
  }): Promise<QbitBroadcastResult>
  /**
   * Hold an auto-lock that falls due while the plan signs, as a page's
   * signing does, for at most a ceiling derived from `estimatedSigningMs`,
   * the time the plan's remaining signatures are expected to take. Returns
   * the function that ends the hold.
   */
  holdAutoLock(estimatedSigningMs: number): () => void
  /** Tell every wallet page that plan `planId` changed (`BUS_METHODS.QBIT_SEND_PLAN_CHANGED`). */
  announce(planId: string, revision: number): void
  /** After a signing: refresh the account's signature counter on display. */
  afterSigning(address: string): Promise<void>
}

export interface QbitSendPlanTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface QbitSendPlanEngineOptions {
  host: QbitSendPlanEngineHost
  /** Read when used, so a module that has not loaded a service yet is not asked for it. */
  store: () => QbitSendPlanStore
  guard: () => QbitSendGuardService
  keyring: () => QbitSendPlanKeyring
  now?: () => number
  timers?: QbitSendPlanTimers
  /** Logs a failure the engine recovers from; never given plan contents. */
  log?: (message: string, error?: unknown) => void
}

/** A validated `QbitSendPlanPrepareParams`. */
export interface QbitSendPlanRequest {
  to: string
  target: QbitSendPlanTarget
  feeRate: number
  /** Absent when the request names none: true for a new plan, the open plan's for a revision. */
  enableRBF?: boolean
  memo?: string
  memos?: string[]
  revise?: QbitSendPlanRevision
}

/**
 * The boundary check of a plan's request, shared by prepare and by start,
 * which checks the request a draft was made from again. Throws for a
 * request the UI port should never carry: not an object; `to` not a
 * string (whether it pays a P2MR address of the active network is checked
 * against that network, as the ordinary send does); a target other than
 * an amount that `isQbitSendPlanAmount` accepts or everything; a fee rate
 * outside `assertQbitFeeRateWithinPolicy` (`null`, which is how NaN and
 * ±Infinity cross the port, included: it is never read as "the default");
 * `enableRBF` that is not a boolean; a memo that is not a string, or memos
 * that are not strings; and a revision that is not of a plan id and a
 * known kind.
 */
export function readQbitSendPlanRequest(params: unknown): QbitSendPlanRequest {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Qbit send plan request must be an object')
  }
  const { to, target, feeRate, enableRBF, memo, memos, revise } = params as Partial<
    Record<keyof QbitSendPlanPrepareParams, unknown>
  >
  if (typeof to !== 'string' || to.length === 0) throw new Error('Invalid address.')
  const { kind, amount } = (target ?? {}) as { kind?: unknown; amount?: unknown }
  let readTarget: QbitSendPlanTarget
  if (kind === 'everything') {
    readTarget = { kind: 'everything' }
  } else if (kind === 'amount') {
    if (!isQbitSendPlanAmount(amount)) {
      throw new RangeError(`amount must be a safe integer >= ${QBIT_P2MR_DUST}`)
    }
    readTarget = { kind: 'amount', amount }
  } else {
    throw new RangeError("target must be { kind: 'amount', amount } or { kind: 'everything' }")
  }
  assertQbitFeeRateWithinPolicy(feeRate)
  if (enableRBF !== undefined && typeof enableRBF !== 'boolean') {
    throw new TypeError('enableRBF must be a boolean')
  }
  if (memo !== undefined && typeof memo !== 'string') throw new TypeError('memo must be a string')
  if (
    memos !== undefined &&
    (!Array.isArray(memos) || memos.some((item: unknown) => typeof item !== 'string'))
  ) {
    throw new TypeError('memos must be a list of strings')
  }
  let readRevise: QbitSendPlanRevision | undefined
  if (revise !== undefined) {
    const { planId, kind: reviseKind } = (revise ?? {}) as { planId?: unknown; kind?: unknown }
    if (typeof planId !== 'string' || !PLAN_ID.test(planId)) {
      throw new TypeError('revise.planId must be a plan id')
    }
    if (
      reviseKind !== 'replan' &&
      reviseKind !== 'raise_merge_fee' &&
      reviseKind !== 'raise_payment_fee'
    ) {
      throw new TypeError('revise.kind is not a known revision')
    }
    readRevise = { planId, kind: reviseKind }
  }
  return {
    to,
    target: readTarget,
    feeRate,
    ...(enableRBF !== undefined ? { enableRBF } : {}),
    ...(memo !== undefined ? { memo } : {}),
    ...(memos !== undefined ? { memos: [...(memos as string[])] } : {}),
    ...(readRevise ? { revise: readRevise } : {}),
  }
}

/** A signature batch open for the steps left to sign. */
interface PlanBatch {
  id: string
  /** By step txid: its entry and the figures it was approved with. */
  entries: Map<string, { index: number; budget: QbitSignatureBudgetImpact }>
}

/**
 * The signature figures the user approved in this session, by a start (its
 * review's) or a continue (`QbitSendPlanEngine.readApproval`), and what the
 * plan's own signings took since, which every batch opened later in the
 * session (after a lock closed the last one, or for a continue's signing)
 * must account for exactly (see `assertContinues`).
 */
interface PlanApproval {
  /** The key's signatures left when the figures were approved. */
  remainingBefore: number
  limit: number
  /** By step txid: the signatures it needed and those cached, when approved. */
  entries: Map<string, { required: number; cached: number }>
  /**
   * Counter units the plan's own signings took since the approval, as the
   * keyring reported them: every input signed anew (not served from the
   * signature cache), by the steps signed to the end and by the signings
   * cut short alike.
   */
  spent: number
  /**
   * Signings cut short with an input in flight since `spent` was last read
   * against the counter: each may have taken one unit more than it
   * reported, since the keyring takes an input's unit before it makes that
   * input's signature. A signing the keyring stopped before an input (its
   * abort) took none.
   */
  unreported: number
}

/** A challenge the page confirmed for one step, to sign it under. */
interface PageChallenge {
  stepTxid: string
  risk: NonNullable<QbitSignatureBudgetImpact['restoredFloorRisk']>
}

/** What the engine keeps of a plan in this service-worker session. */
interface PlanSession {
  hold: QbitSendPlanHold | undefined
  /** Signing is authorised in this session: by start or continue, never by a restart. */
  authorised: boolean
  batch: PlanBatch | undefined
  /**
   * The figures the user approved; without them no batch opens and the plan
   * signs nothing (see `QbitSendPlanEngine.reopenBatch`).
   */
  approval: PlanApproval | undefined
  /**
   * A continue authorised signing and its figures are still to be read: at
   * the plan's next advance with the wallet unlocked, before anything else
   * is done for it (see `QbitSendPlanEngine.readApproval`).
   */
  approvalDue: boolean
  pageChallenge: PageChallenge | undefined
  /** Whether the account's key signs under restored-floor confirmations. */
  restoredFloor: boolean
  /** Raw signed merges by txid, for re-sends: memory only, never stored. */
  signedMerges: Map<string, string>
  signing: { step: number; signed: number; total: number } | undefined
  /**
   * By step txid: the most inputs a signing of it reached in this session,
   * all of them once it signed, so the view's count never goes back when a
   * lock cuts a signing short and the transaction is signed again.
   */
  reached: Map<string, number>
  stop: AbortController | undefined
  releaseAutoLock: (() => void) | undefined
  running: Promise<void> | undefined
  rerun: boolean
  /** View changes shown since record revision `tickRevision`. */
  ticks: number
  tickRevision: number
  lastViewKey: string | undefined
  /** Written once in this session before anything else (see `adopt`). */
  adopted: boolean
  restoreConflict: boolean
  /**
   * By txid: when it was last dispatched or found in the network. A lookup
   * that began before then and missed it says nothing of it (see `noteMiss`).
   */
  seen: Map<string, number>
  /**
   * By txid: the run of lookups that have missed it since it was last
   * dispatched or found, as when the first and the latest of them were
   * read (see `provenAbsent`).
   */
  missed: Map<string, { since: number; last: number }>
  /**
   * By txid: the last lifecycle read of it, and when it was made, `state`
   * undefined when it had no answer. A read within `QBIT_SEND_PLAN_TICK_MS`
   * of it is answered from here (see `lookup`).
   */
  lookups: Map<string, { at: number; state: 'confirmed' | 'pending' | 'gone' | undefined }>
  /** By txid: the last outspends read of it, as `lookups` keeps lifecycle reads. */
  outspends: Map<string, { at: number; spenders: (string | undefined)[] | undefined }>
  /** By merge txid: sends proven not sent so far, and when the next may go. */
  notSent: Map<string, { attempts: number; nextAt: number }>
  /** Round-robin positions of the throttled reads of a waiting plan. */
  outspendsCursor: number
  confirmedCursor: number
  /** Round-robin position of a paused plan's reads of what spends its payment's inputs. */
  paymentInputsCursor: number
  /**
   * When a round of afresh reads of the merges the payment spends, made
   * immediately before a dispatch of the payment (see `stepSending`), last
   * went without an answer: the next round waits a tick, so a plan that
   * cannot read them keeps no read loop going.
   */
  mergesUnreadAt: number | undefined
  /**
   * Settled when the first signing of a start passed its checks (true),
   * the advance ended before that (false), or the keyring refused the
   * page's confirmation (rejected); see `start`.
   */
  firstSigning: { resolve: (passed: boolean) => void; reject: (error: unknown) => void } | undefined
  /**
   * The challenge the page confirmed for the plan's first signature was let
   * go of before that signature checked it: a lock cleared it, or a signing
   * stopped short released it (see `begin`).
   */
  pageChallengeGone: boolean
  /**
   * The start is being undone, or is about to be (its first signing ended
   * with the page's challenge gone): nothing more is done or written for
   * the plan, so the record stays the one the start wrote.
   */
  undoing: boolean
  /**
   * The plan's start was undone with nothing of it signed or sent: the
   * revision that start wrote, whose record goes, then its holds; every
   * advance tries again until both have, as long as the stored record is
   * still that revision (see `removeUndone`).
   */
  removing: number | undefined
  /**
   * A start is writing the plan and has not authorised its signing yet:
   * nothing adopts or advances the plan until `begin` hands it over, so a
   * page's read in between cannot take the new plan for one a restart
   * left (see `adopt`).
   */
  starting: boolean
  /**
   * How many continues are writing the resumed plan and have not authorised
   * its signing yet: nothing advances the plan until none is, so no advance
   * finds it signing unauthorised and pauses it again (see `continue`). A
   * count, since pages can continue at once, and one that finds nothing to
   * continue ends while another still writes.
   */
  continuing: number
  /**
   * How many cancels of the plan are under way: counted before a cancel
   * awaits anything, until it has written the plan or found nothing to
   * cancel. Meanwhile no merge leaves (see `dispatch`): one being written
   * ahead as the cancel starts would otherwise go once its write is
   * through, the cancel's own write still in flight. A count, since pages
   * can cancel at once.
   */
  cancels: number
}

/** The session's state a revision's start replaced, which undoing it puts back. */
type PlanSessionState = Pick<
  PlanSession,
  | 'authorised'
  | 'approval'
  | 'approvalDue'
  | 'pageChallenge'
  | 'restoredFloor'
  | 'signedMerges'
  | 'reached'
  | 'notSent'
  | 'adopted'
  | 'restoreConflict'
>

/** A revision's start in flight: the plan it replaces, and everything held across the swap. */
interface PlanRevisionStart {
  /** The stored record the revision replaced, as it was. */
  replaced: QbitSendPlanRecord
  before: PlanSessionState
  /** What the plan holds until the start settles: the old plan's holds and every outpoint of the new one. */
  held: QbitOutpoint[]
}

/**
 * What a prepare, a start or a continue of an account began under: the
 * engine's generation, which every reset moves on, and how many times the
 * account's plans had been ended (`QbitSendPlanEngine.endPlansOf`). Once
 * either has moved on, or while an ending of the account's plans is under
 * way, the work has lost (`QbitSendPlanEngine.lost`): it keeps, writes,
 * holds and authorises nothing more.
 */
interface WorkTicket {
  generation: number
  /** The account, as `accountKeyOf` names it. */
  account: string
  endings: number
}

/** A reviewed plan waiting for start; memory only. */
interface PlanDraft {
  draftId: string
  /** What the prepare that made it began under; its start goes on under the same. */
  ticket: WorkTicket
  /** Which prepare made it, in the order prepares began: an account's newest wins (see `keepNewDraft`). */
  sequence: number
  planId: string
  chain: ChainType
  account: { address: string; pubkey: string }
  request: QbitSendPlanRequest
  target: 'amount' | 'everything'
  amount: number
  change: number
  feeRate: number
  steps: QbitSendPlanStepRecord[]
  carried: QbitSendPlanCarriedStep[]
  paidFee: number
  /** The earlier versions of the payment a raise of its fee keeps; none for a new plan or a replan. */
  earlierPayments: QbitSendPlanPaymentVersion[]
  /** The engine's bookkeeping a fee raise keeps for the steps it keeps; none for a new plan or a replan. */
  extra?: Record<string, unknown>
  revise: { planId: string; revision: number } | undefined
  batch: PlanBatch
  approval: PlanApproval
  pageChallenge: PageChallenge | undefined
  restoredFloor: boolean
  expiresAt: number
  timer: unknown
  review: QbitSendPlanReview
}

/** The outcome of one unit of an advance: more to do now, or nothing until something changes. */
type StepOutcome = 'again' | 'idle'

/**
 * The key a plan of `account` signs with, lower-case: its P2MR key, or the
 * account's own when that is empty, as the ordinary send reads it. Prepare
 * builds the plan with it and start checks the draft against it.
 */
function planPubkeyOf(account: Account): string {
  const p2mrPubkey = account.p2mr?.pubkey ?? ''
  return (p2mrPubkey.length > 0 ? p2mrPubkey : account.pubkey).toLowerCase()
}

/**
 * The key of `address` on `chain` that drafts and starts are kept under:
 * one of each per account and network.
 */
function accountKeyOf(chain: ChainType, address: string): string {
  return `${chain}:${address}`
}

/** The network of an account named by `accountKeyOf`. */
function chainOfAccountKey(account: string): ChainType {
  return account.slice(0, account.indexOf(':')) as ChainType
}

/** `items[index]`, which the caller knows is there; a broken invariant throws. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error('Qbit send plan step is missing')
  return item
}

function outpointKey(outpoint: QbitOutpoint): string {
  return `${outpoint.txid}:${outpoint.vout}`
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(values)
  return [...values].map(value => value.toString(16).padStart(2, '0')).join('')
}

function figuresOf(budget: QbitSignatureBudgetImpact): QbitSignatureBudgetImpact {
  return {
    required: budget.required,
    cached: budget.cached,
    remainingBefore: budget.remainingBefore,
    remainingAfter: budget.remainingAfter,
    limit: budget.limit,
  }
}

function paymentOf(record: QbitSendPlanRecord): QbitSendPlanStepRecord {
  return at(record.steps, record.steps.length - 1)
}

function mergesOf(record: QbitSendPlanRecord): QbitSendPlanStepRecord[] {
  return record.steps.slice(0, -1)
}

/** `record` with step `txid` changed by `change`, as a new record to put. */
function withStep(
  record: QbitSendPlanRecordInput,
  txid: string,
  change: (step: QbitSendPlanStepRecord) => QbitSendPlanStepRecord
): QbitSendPlanRecordInput {
  return { ...record, steps: record.steps.map(step => (step.txid === txid ? change(step) : step)) }
}

/** A step moved to `status`, keeping the signed PSBT only a payment needs from 'signed' on. */
function stepWithStatus(
  step: QbitSendPlanStepRecord,
  status: QbitSendPlanStepRecord['status'],
  signedPsbtHex?: string
): QbitSendPlanStepRecord {
  const next: QbitSendPlanStepRecord = { ...step, status }
  delete next.signedPsbtHex
  const bytes = signedPsbtHex ?? step.signedPsbtHex
  if (step.kind === 'payment' && status !== 'planned' && bytes !== undefined) {
    next.signedPsbtHex = bytes
  }
  return next
}

/** A merge's inputs, which it spends, and its output 0, which the payment spends. */
function mergeOutput(step: QbitSendPlanStepRecord): QbitOutpoint {
  return { txid: step.txid, vout: 0 }
}

/**
 * Whether `merge` is a replacement whose earlier version confirmed instead:
 * it can never be in the network, so it is never signed or sent, and the
 * payment built on it is void.
 */
function isVoid(merge: QbitSendPlanStepRecord): boolean {
  return merge.replaces?.confirmed === true
}

/** The earlier version `merge` replaces while either may still confirm. */
function pendingReplaced(
  merge: QbitSendPlanStepRecord
): NonNullable<QbitSendPlanStepRecord['replaces']> | undefined {
  return merge.replaces && !merge.replaces.confirmed ? merge.replaces : undefined
}

/** The plan's replacement that `merge` is, as the send guard admits one (see `QbitSendPlanReplacement`). */
function replacementOf(merge: QbitSendPlanStepRecord): QbitSendPlanReplacement | undefined {
  const replaced = pendingReplaced(merge)
  return replaced ? { replaces: replaced.txid, outputCount: 1 } : undefined
}

/**
 * What `record` needs held now. While the plan is open: the inputs of every
 * merge that has not confirmed (a confirmed spend needs no reservation, and
 * the guard's recent spends are bounded), output 0 of every merge and, while
 * a raised merge or the version it replaced may still confirm, of that
 * version too, the outputs the payment spends directly, and the inputs of
 * every carried merge; for a void replacement, only the output of the
 * version that confirmed instead. Once completed: the payment's inputs
 * until the payment is seen confirmed, or the plan is dismissed. While
 * cancelling: only the inputs of merges whose outcome is unknown.
 */
function desiredHolds(record: QbitSendPlanRecord): Set<string> {
  const held = new Set<string>()
  const addInputs = (inputs: readonly { txid: string; vout: number }[]): void => {
    for (const input of inputs) held.add(outpointKey(input))
  }
  if (record.phase === 'completed') {
    const payment = paymentOf(record)
    if (payment.status !== 'confirmed') addInputs(payment.inputs)
    return held
  }
  if (record.phase === 'cancelling') {
    for (const merge of mergesOf(record)) {
      if (merge.status === 'unknown') addInputs(merge.inputs)
    }
    for (const item of record.carried ?? []) {
      if (item.status === 'unknown') addInputs(item.inputs)
    }
    return held
  }
  const confirmedOnce = mergeConfirmedTimes(record)
  for (const merge of mergesOf(record)) {
    if (isVoid(merge)) {
      // Its earlier version confirmed and spent the inputs for good: that
      // version's output is the plan's funds now, for the replan to spend.
      held.add(`${merge.replaces?.txid ?? ''}:0`)
      continue
    }
    if (merge.status !== 'confirmed' && confirmedOnce[merge.txid] === undefined) {
      addInputs(merge.inputs)
    }
    held.add(outpointKey(mergeOutput(merge)))
    // Until the replacement or the version it replaces has confirmed,
    // either may: both outputs stay held.
    const replaced = pendingReplaced(merge)
    if (replaced) held.add(`${replaced.txid}:0`)
  }
  // A void merge's output can never exist: the payment built on it is void.
  const voidOutputs = new Set(
    mergesOf(record)
      .filter(isVoid)
      .map(merge => `${merge.txid}:0`)
  )
  addInputs(paymentOf(record).inputs.filter(input => !voidOutputs.has(outpointKey(input))))
  for (const item of record.carried ?? []) addInputs(item.inputs)
  return held
}

/**
 * Whether `record` failed the checks of what its transactions are (see
 * `signStep` and `stepSending`): paused `unreadable`, or cancelling after
 * such a pause, which keeps it. Such a plan stays so until its deletion
 * ends it: no write takes it out of that state (see
 * `QbitSendPlanEngine.mutate`), so nothing of it is signed, sent or sent
 * again, it shows nothing of what it states (`QbitSendPlanEngine.viewOf`),
 * and its cancel is the one thing it offers (`actionsOf`).
 */
function failedItsChecks(record: Pick<QbitSendPlanRecordInput, 'phase' | 'pause'>): boolean {
  return (
    (record.phase === 'paused' || record.phase === 'cancelling') &&
    record.pause?.reason === 'unreadable'
  )
}

/** The pause reason of a stored record as the shared type names it; unknown text reads as interrupted. */
function pauseReasonOf(record: QbitSendPlanRecord): QbitSendPlanPauseReason | undefined {
  if (record.phase !== 'paused' || !record.pause) return undefined
  return (
    PAUSE_REASONS.has(record.pause.reason) ? record.pause.reason : 'interrupted'
  ) as QbitSendPlanPauseReason
}

/**
 * Whether a transaction of `record`, or one that a fee raise replaced and
 * that may still confirm, has been sent or may be in the network
 * (`QbitSendPlanView.sent`): a step that is unknown, in the network or
 * confirmed; a merge that replaces an earlier version, which was in the
 * network when it was replaced (until that version is proven absent, when
 * the step forgets it); a carried merge; fees an earlier version of the
 * plan paid for merges it sent that are, or may still be, in the network or
 * confirmed (`paidFee`, which a carried merge proven absent leaves); or a
 * version of the payment that may still confirm (`paymentVersionMayConfirm`).
 * A step proven not sent is `planned` or `signed` again, and counts for
 * nothing.
 */
function sentAnything(record: QbitSendPlanRecord): boolean {
  return (
    record.steps.some(
      step =>
        step.status === 'unknown' ||
        step.status === 'broadcast' ||
        step.status === 'confirmed' ||
        step.replaces !== undefined
    ) ||
    (record.carried ?? []).length > 0 ||
    (record.paidFee ?? 0) > 0 ||
    paymentVersionMayConfirm(record)
  )
}

/** Whether the payment may be in the network, after which nothing of the plan can be cancelled. */
function paymentMayBeSent(record: QbitSendPlanRecord): boolean {
  const status = paymentOf(record).status
  return status === 'unknown' || status === 'broadcast' || status === 'confirmed'
}

/**
 * Whether a cancel ends `record`: an open plan whose payment cannot be in
 * the network yet and no version of whose payment may still confirm
 * (`paymentVersionMayConfirm`), or one that failed the checks of what its
 * transactions are, whatever its payment's state, since nothing else ends
 * that one (see `failedItsChecks`).
 */
function cancellable(record: QbitSendPlanRecord): boolean {
  return (
    record.phase !== 'completed' &&
    (failedItsChecks(record) || (!paymentMayBeSent(record) && !paymentVersionMayConfirm(record)))
  )
}

/**
 * Whether a version of `record`'s payment whose bytes left the wallet may
 * still confirm though the plan does not count it as sent: the payment's own
 * or an earlier version's, one of whose broadcasts ended without a verdict
 * (`QbitSendPlanDispatch` `unknown`). Proven absent, such a version allows
 * the same inputs to be sent again, which cannot pay twice, never a replan
 * from other outputs, and the plan is never cancelled into nothing: a cancel
 * would stop tracking a version that may still pay the recipient, and free
 * its inputs for a second payment. While one may still confirm, neither is
 * offered; the plan offers Continue, which sends the same payment again,
 * whatever it paused for (see `actionsOf`), keeps every hold, and completes
 * once any version is found. A version stops counting once an input of the
 * payment is found spent by a transaction that is no version of it, or a
 * merge it spends is found unable to confirm (see `settlePaymentInputSpender`
 * and `sendMerge`); then no version can confirm. Removing the wallet or
 * resetting it ends such a plan all the same (see `endPlansOf`). Until the
 * plan completes, its view says so (`QbitSendPlanView.paymentMayConfirm`).
 */
function paymentVersionMayConfirm(record: QbitSendPlanRecord): boolean {
  return (
    paymentOf(record).dispatch === 'unknown' ||
    (record.earlierPayments ?? []).some(version => version.dispatch === 'unknown')
  )
}

/** Whether the bytes of a version of `record`'s payment ever left the wallet. */
function paymentDispatched(record: QbitSendPlanRecord): boolean {
  return paymentOf(record).dispatch !== undefined || (record.earlierPayments ?? []).length > 0
}

/** `record`'s payment as an earlier version of it, once a raise builds it again. */
function paymentVersionOf(record: QbitSendPlanRecord): QbitSendPlanPaymentVersion | undefined {
  const payment = paymentOf(record)
  if (payment.dispatch === undefined) return undefined
  return {
    txid: payment.txid,
    unsignedPsbtHex: payment.unsignedPsbtHex,
    vsize: payment.vsize,
    fee: payment.fee,
    feeRate: payment.feeRate,
    amount: record.amount,
    change: record.change,
    dispatch: payment.dispatch,
  }
}

/** The phase a plan resumes in once nothing stops it: what its steps still need. */
function resumedPhase(record: QbitSendPlanRecord): 'signing' | 'waiting' | 'sending' {
  const payment = paymentOf(record)
  if (
    mergesOf(record).some(merge => merge.status === 'planned' && !isVoid(merge)) ||
    payment.status === 'planned'
  ) {
    return 'signing'
  }
  return mergesOf(record).every(merge => merge.status === 'confirmed') ? 'sending' : 'waiting'
}

/**
 * What the user may do with `record` now; see `QbitSendPlanAction`. `slow`
 * is whether a merge has stayed unconfirmed for long (`slowMergeOf`): only
 * then may a merge's fee be raised, and only while the plan writes nothing
 * by itself, so that a raise the view offers can be started on the plan
 * it was reviewed on.
 */
function actionsOf(
  record: QbitSendPlanRecord,
  unlocked: boolean,
  slow = false
): QbitSendPlanAction[] {
  const actions: QbitSendPlanAction[] = []
  if (record.phase === 'completed') return ['dismiss']
  // A plan that failed the checks of what its transactions are stores what
  // this wallet did not make (see `signStep`): nothing but its cancel ends
  // it, so that is offered while it is paused, whatever its payment's
  // state, and nothing else ever is.
  if (failedItsChecks(record)) return record.phase === 'paused' ? ['cancel'] : []
  const reason = pauseReasonOf(record)
  // Nothing revises a plan whose payment may be in the network: a revision
  // would stop tracking a payment the network may hold.
  const revisable = !paymentMayBeSent(record) && record.phase !== 'cancelling'
  // A version of the payment that may still confirm is tracked until it
  // confirms or can no longer confirm: no replan, no cancel.
  const versionMayConfirm = paymentVersionMayConfirm(record)
  // A payment refused without a readable reason may have been refused for
  // its fee: a raise is offered as for one refused for its fee.
  if (
    revisable &&
    (reason === 'payment_fee_too_low' ||
      (reason === 'payment_refused' && record.pause?.unexplained === true))
  ) {
    actions.push('raise_payment_fee')
  }
  // While a version of the payment may still confirm, whatever the plan
  // paused for, Continue is the way on that cannot pay twice: the same
  // merges and the same payment, sent again. Continue authorises signing,
  // which only the user at an unlocked wallet gives: never while it is
  // locked, whatever the plan paused for (see `QbitSendPlanEngine.continue`).
  if (
    unlocked &&
    reason !== undefined &&
    (CONTINUABLE.has(reason) || (revisable && versionMayConfirm))
  ) {
    actions.push('continue')
  }
  // Never a replan while a version of the payment may still confirm: a
  // replan pays from other outputs, and both could confirm.
  if (revisable && reason !== undefined && REPLANNABLE.has(reason) && !versionMayConfirm) {
    actions.push('replan')
  }
  // A merge's fee is raised while the plan waits for its merges, or is
  // paused for anything but a lock (a plan paused by a lock signs on by
  // itself after the unlock). A signing writes the plan with every merge it
  // sends, and a raise starts only on the revision its review read; and a
  // signing looks up no merge it has sent, so one it shows as slow may have
  // confirmed long since.
  const settled = record.phase === 'waiting' || (record.phase === 'paused' && reason !== 'locked')
  // Once the payment's bytes left the wallet its inputs never change, so
  // every version of it spends the same ones and at most one confirms: a
  // merge's fee is no longer raised, which would build the payment on the
  // replacement's output.
  if (revisable && slow && settled && mergeFeeRaisable(record) && !paymentDispatched(record)) {
    actions.push('raise_merge_fee')
  }
  // A cancel would stop tracking a version of the payment that may still
  // confirm, and free its inputs for a second payment (see `cancellable`).
  if (revisable && !versionMayConfirm) actions.push('cancel')
  return actions
}

/**
 * Whether a merge of `record` is in the network unconfirmed, so a revision
 * can replace it with one paying a higher fee, and nothing of the plan
 * stands against one: no merge is void.
 */
function mergeFeeRaisable(record: QbitSendPlanRecord): boolean {
  const merges = mergesOf(record)
  return merges.some(merge => merge.status === 'broadcast') && !merges.some(isVoid)
}

/**
 * Whether a merge of `record` has stayed unconfirmed for long: accepted by
 * the network more than `QBIT_SEND_PLAN_SLOW_MERGE_MS` ago and not
 * confirmed since, as the record last saw it. The view says so
 * (`QbitSendPlanView.slowMerge`) when it offers the raise (see `actionsOf`).
 */
function slowMergeOf(record: QbitSendPlanRecord, now: number): boolean {
  const times = mergeBroadcastTimes(record)
  return mergesOf(record).some(merge => {
    const broadcastAt = times[merge.txid]
    return (
      merge.status === 'broadcast' &&
      broadcastAt !== undefined &&
      now - broadcastAt > QBIT_SEND_PLAN_SLOW_MERGE_MS
    )
  })
}

/**
 * A time by merge txid that the engine keeps in `extra` under `key`, as
 * stored: anything but a non-negative safe integer is left out.
 */
function mergeTimes(
  record: Pick<QbitSendPlanRecord, 'extra'>,
  key: 'mergeBroadcastAt' | 'mergeConfirmedAt'
): Record<string, number> {
  const value = record.extra?.[key]
  const times: Record<string, number> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return times
  for (const [txid, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isSafeInteger(at) && at >= 0) times[txid] = at
  }
  return times
}

/** When each merge was first seen accepted. */
function mergeBroadcastTimes(record: QbitSendPlanRecord): Record<string, number> {
  return mergeTimes(record, 'mergeBroadcastAt')
}

/**
 * When each merge was first seen confirmed. Its inputs were let go of then,
 * and are never held again: a reorganisation that takes it out again
 * leaves them spent by it, and its bytes go out again without the plan's
 * hold.
 */
function mergeConfirmedTimes(record: QbitSendPlanRecord): Record<string, number> {
  return mergeTimes(record, 'mergeConfirmedAt')
}

/** When the plan was cancelled, as engine bookkeeping in `extra`. */
function cancelledAt(record: QbitSendPlanRecord): number | undefined {
  const value = record.extra?.['cancelledAt']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function withExtra(
  record: QbitSendPlanRecordInput,
  changes: Record<string, unknown>
): QbitSendPlanRecordInput {
  return { ...record, extra: { ...(record.extra ?? {}), ...changes } }
}

/**
 * `record` without carried merge `txid`, which is proven absent: the fee it
 * would have paid comes off `paidFee`, which counts only the fees of merges
 * an earlier version of the plan sent that are, or may still be, in the
 * network or confirmed.
 */
function withoutAbsentCarried(record: QbitSendPlanRecord, txid: string): QbitSendPlanRecordInput {
  const item = (record.carried ?? []).find(candidate => candidate.txid === txid)
  const next: QbitSendPlanRecordInput = {
    ...record,
    carried: (record.carried ?? []).filter(candidate => candidate.txid !== txid),
  }
  if (item) {
    const paidFee = Math.max(0, (record.paidFee ?? 0) - item.fee)
    if (paidFee > 0) next.paidFee = paidFee
    else delete next.paidFee
  }
  return next
}

/** The figures of a failed broadcast a pause may show: never a URL or a payload. */
function refusalDetail(result: QbitBroadcastResult): string | undefined {
  if (result.success) return undefined
  return sanitizeQbitBroadcastDetail(result.detail ?? result.reason)
}

function errorDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message ? sanitizeQbitBroadcastDetail(message) : undefined
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined
}

function isStoreConflict(error: unknown): boolean {
  return (
    error instanceof QbitSendPlanStoreError &&
    (error.code === 'stale_revision' || error.code === 'not_found')
  )
}

/** Thrown when a budget no longer continues the approval it was opened under. */
class QbitSendPlanBudgetChangedError extends Error {
  constructor() {
    super('The signature budget changed since the plan was approved')
    this.name = 'QbitSendPlanBudgetChangedError'
  }
}

/** Thrown when a batch would open in a session that holds no approval to continue. */
class QbitSendPlanNotApprovedError extends Error {
  constructor() {
    super('The signatures this plan still needs are not approved in this session')
    this.name = 'QbitSendPlanNotApprovedError'
  }
}

/**
 * The approval of `steps` at the fresh figures `inputs` hold for them, in
 * the same order: what the user approves when they start or continue the
 * plan, nothing taken since.
 */
function approvalOf(
  steps: readonly QbitSendPlanStepRecord[],
  inputs: readonly { approvedBudget: QbitSignatureBudgetImpact }[]
): PlanApproval {
  const first = at(inputs, 0).approvedBudget
  return {
    remainingBefore: first.remainingBefore,
    limit: first.limit,
    entries: new Map(
      steps.map((step, index) => {
        const budget = at(inputs, index).approvedBudget
        return [step.txid, { required: budget.required, cached: budget.cached }]
      })
    ),
    spent: 0,
    unreported: 0,
  }
}

function newSession(): PlanSession {
  return {
    hold: undefined,
    authorised: false,
    batch: undefined,
    approval: undefined,
    approvalDue: false,
    pageChallenge: undefined,
    restoredFloor: false,
    signedMerges: new Map(),
    signing: undefined,
    reached: new Map(),
    stop: undefined,
    releaseAutoLock: undefined,
    running: undefined,
    rerun: false,
    ticks: 0,
    tickRevision: 0,
    lastViewKey: undefined,
    adopted: false,
    restoreConflict: false,
    seen: new Map(),
    missed: new Map(),
    lookups: new Map(),
    outspends: new Map(),
    notSent: new Map(),
    outspendsCursor: 0,
    confirmedCursor: 0,
    paymentInputsCursor: 0,
    mergesUnreadAt: undefined,
    firstSigning: undefined,
    pageChallengeGone: false,
    undoing: false,
    removing: undefined,
    continuing: 0,
    cancels: 0,
    starting: false,
  }
}

/**
 * The engine of send plans (issue #188): it prepares and prices a plan,
 * reserves its outputs, signs every transaction, broadcasts the merges,
 * waits for them to confirm, broadcasts the payment, and carries the plan
 * through a closed popup, a lock, a restart and an update.
 *
 * The plan lives in the plan store, the one source of truth: every unit of
 * work re-reads its record and writes through the store's revision check, so
 * a stale unit of work never overwrites newer state, and one `advance` runs
 * per plan at a time (a call while one runs coalesces into one more). What
 * the store does not keep is this session's: the guard's hold (restored from
 * the store at start-up), signed merges (signed again if lost: same inputs
 * and outputs, so the same id), the authorisation to sign (given by start
 * and continue, never by a restart) and the signing's progress.
 *
 * Every broadcast is written ahead: the step is stored `unknown` before its
 * bytes leave, and goes back to `planned` (merge) or `signed` (payment) only
 * when the broadcast path proves it was not sent. A step whose stored status
 * does not prove it absent is looked up before it is signed or sent again.
 */
export class QbitSendPlanEngine {
  private readonly host: QbitSendPlanEngineHost
  private readonly storeOf: () => QbitSendPlanStore
  private readonly guardOf: () => QbitSendGuardService
  private readonly keyringOf: () => QbitSendPlanKeyring
  private readonly now: () => number
  private readonly timers: QbitSendPlanTimers
  private readonly log: (message: string, error?: unknown) => void
  private readonly sessions = new Map<string, PlanSession>()
  private readonly drafts = new Map<string, PlanDraft>()
  /** How many prepares began, for `PlanDraft.sequence`. */
  private prepares = 0
  /** The start under way for an account, by `chain:address`: one at a time (see `start`). */
  private readonly starts = new Map<
    string,
    { draftId: string; result: Promise<QbitSendPlanStartResult> }
  >()
  /** The continues under way for an account, by `chain:address` (see `continue`). */
  private readonly continues = new Map<string, Set<Promise<unknown>>>()
  /**
   * By `chain:address`: how many times the account's plans were ended
   * (`endPlansOf`), and how many endings of them are under way.
   */
  private readonly endings = new Map<string, { count: number; underWay: number }>()
  /** By network: how many wallet removals hold it (see `holdNetworksIfIdle`). */
  private readonly networkHolds = new Map<ChainType, number>()
  private timer: unknown = undefined
  private started = false
  /** Whether `restore` has run: what `resume` runs again. */
  private restored = false
  /** How many resets are under way (`halt` to `resume`): while any is, nothing of a plan runs. */
  private halts = 0
  /** Plans a discard made readable, being held again (`takeUpMadeReadable`): a reset waits for them. */
  private readonly takingUp = new Set<Promise<void>>()
  /** Moves on with every reset: a loop of an earlier generation stops at its next step. */
  private generation = 0

  constructor(options: QbitSendPlanEngineOptions) {
    this.host = options.host
    this.storeOf = options.store
    this.guardOf = options.guard
    this.keyringOf = options.keyring
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? {
      setTimeout: (callback, ms): unknown => setTimeout(callback, ms),
      clearTimeout: (handle): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.log = options.log ?? ((): void => undefined)
  }

  private get store(): QbitSendPlanStore {
    return this.storeOf()
  }

  private get guard(): QbitSendGuardService {
    return this.guardOf()
  }

  private get keyring(): QbitSendPlanKeyring {
    return this.keyringOf()
  }

  /**
   * Hold again what every stored plan held before the service worker
   * started, before anything can spend: run once the store has loaded, and
   * again after a reset that failed. A plan whose outputs something else
   * holds too is held in full all the same, and pauses `outputs_spent` the
   * first time it is advanced. A spend the guard recorded for one of the
   * plan's own transactions is no such thing: after a failed reset the
   * guard still has what the plan's own broadcasts recorded (the inputs of
   * a merge that confirmed, which its hold had let go of), while a spend
   * recorded for any other transaction still pauses it.
   */
  async restore(): Promise<void> {
    const restoration = await this.guard.restorePlanHolds(this.store.planHolds())
    this.restored = true
    this.keepRestoration(restoration)
    const unreadable = this.store.unreadable()
    if (unreadable.document !== undefined || unreadable.plans.length > 0) {
      this.log(
        `Qbit send plans unreadable by this version: ${
          unreadable.document ? 'the whole document' : `${unreadable.plans.length} plan(s)`
        }`
      )
    }
  }

  /**
   * Keep what a restore of plans' holds gave (`restorePlanHolds`): each
   * plan's hold, and, for a plan whose outputs something else holds too or
   * spent, a conflict it pauses `outputs_spent` for at its next advance,
   * unless every such conflict is a spend recorded for one of its own
   * transactions (see `restore`).
   */
  private keepRestoration(restoration: QbitSendPlanHoldRestoration): void {
    for (const [planId, hold] of restoration.holds) this.session(planId).hold = hold
    for (const { planId, conflicts } of restoration.conflicts) {
      const own = this.ownTxidsOf(planId)
      const foreign = conflicts.some(
        conflict =>
          conflict.kind !== 'recent_spend' ||
          conflict.spender === undefined ||
          !own.has(conflict.spender)
      )
      if (foreign) this.session(planId).restoreConflict = true
    }
  }

  /** Start advancing the stored plans: once the background has started. */
  startAdvancing(): void {
    this.started = true
    this.kickAll()
  }

  /** The wallet locked: drafts go, and signing stops before its next signature. */
  onLock(): void {
    for (const draft of [...this.drafts.values()]) this.dropDraft(draft)
    for (const [planId, session] of this.sessions) {
      session.stop?.abort()
      // A lock closed every signature batch and every challenge.
      session.batch = undefined
      if (session.pageChallenge) session.pageChallengeGone = true
      session.pageChallenge = undefined
      this.endAutoLockHold(session)
      if (this.started) this.refreshView(planId)
    }
  }

  /**
   * The wallet unlocked: a plan paused by a lock in this session goes on by
   * itself, and the figures of a continue that a lock kept from being read
   * are read before it does anything else (`readApproval`). A plan of
   * another network is not advanced now, and the key may sign there before
   * it is: such a continue of it approves no figures, and its next
   * signature waits for another continue.
   */
  onUnlock(): void {
    if (!this.started) return
    const chain = this.host.activeChain()
    for (const [planId, session] of this.sessions) {
      if (session.approvalDue && this.storedChainOf(planId) !== chain) session.approvalDue = false
      this.refreshView(planId)
    }
    this.kickAll()
  }

  /**
   * Every transaction stored plan `planId` sent or may send: each version of
   * each merge (the earlier one a raise replaced included), each merge an
   * earlier version of the plan carried, and each version of the payment.
   * None when the plan cannot be read.
   */
  private ownTxidsOf(planId: string): Set<string> {
    let record: QbitSendPlanRecord | undefined
    try {
      record = this.store.get(planId)
    } catch {
      return new Set()
    }
    if (!record) return new Set()
    return new Set([
      ...record.steps.flatMap(step => [step.txid, ...(step.replaces ? [step.replaces.txid] : [])]),
      ...(record.carried ?? []).map(item => item.txid),
      ...(record.earlierPayments ?? []).map(version => version.txid),
    ])
  }

  /** The network stored plan `planId` is on, or nothing when it cannot be read. */
  private storedChainOf(planId: string): ChainType | undefined {
    try {
      return this.store.get(planId)?.chain
    } catch {
      return undefined
    }
  }

  /**
   * Forget everything in memory: drafts go, signing stops, and sessions and
   * the timer go; an advance of an earlier generation stops at its next
   * step. `halt` starts with this when the wallet is reset.
   */
  reset(): void {
    this.generation += 1
    for (const draft of [...this.drafts.values()]) this.dropDraft(draft)
    for (const session of this.sessions.values()) {
      session.stop?.abort()
      this.endAutoLockHold(session)
      if (session.batch) this.keyring.releaseP2mrPsbtSigningBatches([session.batch.id])
      this.firstSigningFailed(session, undefined)
    }
    this.sessions.clear()
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * The wallet is about to be reset: stop every plan before anything else
   * is, and resolve once nothing of a plan is under way. From here until
   * `resume`, nothing of a plan is signed, broadcast, written or held:
   * drafts go and signing stops (`reset`); no advance, read, prepare,
   * start, continue or cancel of a plan begins; and an advance, start or
   * continue under way loses at its next step (an advance broadcasts
   * nothing more, see `mayBroadcast`), and has ended when this resolves, as
   * has the holding again of plans a discard made readable, which lets go
   * of what it held (`takeUpMadeReadable`). So nothing a plan did before
   * the reset outlives it: the store and the guard are reset after this.
   */
  async halt(): Promise<void> {
    this.halts += 1
    const underWay = [
      ...[...this.sessions.values()].map(session => session.running),
      ...[...this.starts.values()].map(start => start.result),
      ...[...this.continues.values()].flatMap(continues => [...continues]),
      ...this.takingUp,
    ].filter((work): work is Promise<unknown> => work !== undefined)
    this.reset()
    await Promise.allSettled(underWay)
  }

  /**
   * The reset `halt` stopped the plans for is over, or failed: once no
   * other reset is under way, the engine goes on from what is stored, as
   * at start-up (`restore`, then advancing, if it had): nothing after a
   * reset, and the plans as they are after one that failed, whose signing
   * waits for the user's continue.
   */
  async resume(): Promise<void> {
    this.halts = Math.max(0, this.halts - 1)
    if (this.halted()) return
    // What work under way made of the sessions while halted is forgotten,
    // with whatever they took.
    for (const planId of [...this.sessions.keys()]) this.dropSession(planId)
    if (this.restored) {
      try {
        await this.restore()
      } catch (error) {
        this.log('Qbit send plans could not be held again after a reset', error)
      }
    }
    if (this.started) this.kickAll()
  }

  private halted(): boolean {
    return this.halts > 0
  }

  /** Resolves once no advance runs, for a caller that must see the engine settle. */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.sessions.values()]
        .map(session => session.running)
        .filter((promise): promise is Promise<void> => promise !== undefined)
      if (running.length === 0) return
      await Promise.allSettled(running)
    }
  }

  /**
   * For a wallet removal that could not derive its accounts on `chains`:
   * whether anything of a plan is on them, under any account (a stored plan,
   * an entry the store cannot read, a draft, a start or a continue under
   * way), and, when nothing is, a hold on them until the function returned
   * releases it: no plan work begins on them meanwhile (`ticketFor`), and
   * work begun before, a prepare, keeps nothing (`lost`). The check and the
   * hold are one step, nothing awaited between them, so no plan can appear
   * on them from the check until the release. Nothing, and nothing held,
   * when something is on them: what the removal cannot name, it does not end.
   */
  holdNetworksIfIdle(chains: readonly ChainType[]): (() => void) | undefined {
    const held = [...new Set(chains)]
    if (this.anythingOn(new Set(held))) return undefined
    for (const chain of held) this.networkHolds.set(chain, (this.networkHolds.get(chain) ?? 0) + 1)
    let released = false
    return (): void => {
      if (released) return
      released = true
      for (const chain of held) {
        const count = (this.networkHolds.get(chain) ?? 1) - 1
        if (count > 0) this.networkHolds.set(chain, count)
        else this.networkHolds.delete(chain)
      }
    }
  }

  /** Whether anything of a plan is on `chains` now, under any account (see `holdNetworksIfIdle`). */
  private anythingOn(chains: ReadonlySet<ChainType>): boolean {
    try {
      if (this.store.list().some(record => chains.has(record.chain))) return true
      const unreadable = this.store.unreadable()
      // A document that cannot be read may hold a plan on any network.
      if (unreadable.document !== undefined) return true
      if (unreadable.plans.some(plan => plan.chain === undefined || chains.has(plan.chain))) {
        return true
      }
    } catch (error) {
      // A store that never loaded holds no plan; one that cannot be read may hold any.
      if (!(error instanceof QbitSendPlanStoreError && error.code === 'not_initialized'))
        return true
    }
    if ([...this.drafts.values()].some(draft => chains.has(draft.chain))) return true
    const underWay = [...this.starts.keys(), ...this.continues.keys()]
    return underWay.some(account => chains.has(chainOfAccountKey(account)))
  }

  /**
   * A ticket for work on the account of `address` on `chain` beginning now,
   * or nothing while its plans are being ended (`endPlansOf`): no work
   * begins for an account whose wallet is being removed.
   */
  private ticketFor(chain: ChainType, address: string): WorkTicket | undefined {
    if (this.halted() || this.networkHolds.has(chain)) return undefined
    const account = accountKeyOf(chain, address)
    const ending = this.endings.get(account)
    if (ending && ending.underWay > 0) return undefined
    return { generation: this.generation, account, endings: ending?.count ?? 0 }
  }

  /**
   * Whether work begun under `ticket` has lost: the engine was reset since,
   * or the account's plans were ended since or are being ended now.
   */
  private lost(ticket: WorkTicket): boolean {
    if (ticket.generation !== this.generation || this.halted()) return true
    if (this.networkHolds.has(chainOfAccountKey(ticket.account))) return true
    const ending = this.endings.get(ticket.account)
    return ending !== undefined && (ending.underWay > 0 || ending.count !== ticket.endings)
  }

  /** Count `work`, a continue of `account`'s plan, as under way until it settles. */
  private trackContinue(account: string, work: Promise<unknown>): void {
    let running = this.continues.get(account)
    if (!running) {
      running = new Set()
      this.continues.set(account, running)
    }
    running.add(work)
    const settled = (): void => {
      const current = this.continues.get(account)
      current?.delete(work)
      if (current?.size === 0) this.continues.delete(account)
    }
    work.then(settled, settled)
  }

  // -- prepare ------------------------------------------------------------

  /**
   * Price a plan for the selected account on the active network and keep it
   * as a draft, which reserves nothing; see `QbitSendPlanPrepareResult`.
   */
  async prepare(params: unknown): Promise<QbitSendPlanPrepareResult> {
    const request = readQbitSendPlanRequest(params)
    const chain = this.host.activeChain()
    if (!QBIT_CHAINS.has(chain)) throw new Error('Qbit send plans need a Qbit network')
    const account = this.planAccount()
    const keys = this.accountKeys(account)
    const recipientScript = this.host.recipientScript(chain, request.to)
    const askedMemoOutputs =
      request.memo !== undefined || request.memos !== undefined || !request.revise
        ? this.host.memoOutputs(request.memo, request.memos)
        : undefined
    const address = account.address
    const draftKey = accountKeyOf(chain, address)
    const refusal = (
      reason: Extract<QbitSendPlanPrepareResult, { ok: false }>['reason'],
      maxSendable = 0,
      unconfirmedSatoshis = 0
    ): QbitSendPlanPrepareResult => ({ ok: false, reason, maxSendable, unconfirmedSatoshis })

    // No plan is prepared for an account whose plans are being ended: its
    // wallet is being removed.
    const ticket = this.ticketFor(chain, address)
    if (!ticket) throw new Error(QBIT_SEND_PLAN_ACCOUNT_REQUIRED)
    // A plan is being started for the account: the draft being started
    // stays, and this prepare is refused.
    if (this.starts.has(draftKey)) return refusal('plan_open')
    // The account's newest prepare wins: the draft an earlier one left goes.
    const sequence = ++this.prepares
    const previousDraft = this.drafts.get(draftKey)
    if (previousDraft) this.dropDraft(previousDraft)

    if (this.unreadableFor(chain, address)) return refusal('plan_open')
    const existing = this.store.findOpen(chain, address)
    let revised: QbitSendPlanRecord | undefined
    if (request.revise) {
      revised = existing
      if (!revised || revised.id !== request.revise.planId) {
        throw new Error('The Qbit send plan to revise is not open')
      }
      if (paymentMayBeSent(revised)) {
        throw new Error('A Qbit send plan whose payment may be in the network cannot be revised')
      }
      this.assertOffered(revised, request.revise.kind)
      if (
        revised.recipient !== request.to ||
        revised.target !== request.target.kind ||
        (request.target.kind === 'amount' && revised.amount !== request.target.amount)
      ) {
        throw new Error('A revision pays the same recipient the same target')
      }
      revised = await this.settleBeforeRevision(revised)
      // What the lookups found may take the revision off the plan's actions.
      this.assertOffered(revised, request.revise.kind)
      // Never rebuilt while either version of a raised merge may be in the
      // network: a replan can carry one of them, not both.
      if (
        request.revise.kind === 'replan' &&
        mergesOf(revised).some(
          merge =>
            pendingReplaced(merge) !== undefined &&
            (merge.status === 'unknown' || merge.status === 'broadcast')
        )
      ) {
        return refusal('outputs_unavailable')
      }
    } else if (existing && existing.phase !== 'completed') {
      return refusal('plan_open')
    }
    // A revised plan keeps the open plan's memos and replaceability; a
    // request naming others is refused.
    let memoOutputs: P2mrTransactionOutput[]
    let enableRBF: boolean
    if (revised) {
      const kept = qbitSendPlanPaymentTerms(paymentOf(revised).unsignedPsbtHex, revised.change)
      if (askedMemoOutputs && !sameQbitSendPlanOutputs(askedMemoOutputs, kept.memoOutputs)) {
        throw new Error('A revision keeps the memo of the plan it revises')
      }
      if (request.enableRBF !== undefined && request.enableRBF !== kept.enableRBF) {
        throw new Error('A revision keeps the replaceability of the plan it revises')
      }
      memoOutputs = kept.memoOutputs
      enableRBF = kept.enableRBF
    } else {
      memoOutputs = askedMemoOutputs ?? []
      enableRBF = request.enableRBF ?? true
    }
    if (revised && request.revise && request.revise.kind !== 'replan') {
      return this.prepareFeeRaise({
        ticket,
        sequence,
        request,
        kind: request.revise.kind,
        chain,
        account,
        keys,
        recipientScript,
        memoOutputs,
        enableRBF,
        revised,
        refusal,
      })
    }

    let coins: QbitSendPlanCoin[]
    try {
      coins = await this.host.spendableOutputs(chain, account, revised?.id)
    } catch (error) {
      this.log('Qbit send plan could not read the account outputs', error)
      return refusal('outputs_unavailable')
    }
    if (revised) {
      // What the plan holds that it cannot spend again yet: the inputs of
      // merges that were sent, or may have been, and have not confirmed,
      // and of the merges it carries. Their outputs, while unconfirmed, are
      // what the planner reports as funds to wait for; so is an output of a
      // merge the record has not seen confirmed, whatever the listing says,
      // since the revision carries that merge and never spends its output.
      const busy = new Set<string>()
      const unsettled = new Set<string>()
      for (const merge of mergesOf(revised)) {
        if (merge.status !== 'confirmed') unsettled.add(merge.txid)
        const replaced = pendingReplaced(merge)
        if (replaced) unsettled.add(replaced.txid)
        if (merge.status === 'unknown' || merge.status === 'broadcast' || replaced) {
          for (const input of merge.inputs) busy.add(outpointKey(input))
        }
      }
      for (const item of revised.carried ?? []) {
        unsettled.add(item.txid)
        for (const input of item.inputs) busy.add(outpointKey(input))
      }
      coins = coins
        .filter(coin => !busy.has(`${coin.txid.toLowerCase()}:${coin.vout}`))
        .map(coin =>
          unsettled.has(coin.txid.toLowerCase()) && !coin.unconfirmed
            ? { ...coin, unconfirmed: true }
            : coin
        )
    }

    const shape = {
      paymentOutputScriptLengths: [
        recipientScript.length,
        ...memoOutputs.map(output => output.scriptPubKey.length),
      ],
      accountScriptLength: keys.scriptPubKey.length,
      leafScriptLength: keys.leafScript.length,
      controlBlockLength: keys.controlBlock.length,
      feeRate: request.feeRate,
    }
    const everything = (): number => {
      const best = planQbitSend({ ...shape, utxos: coins, target: { kind: 'everything' } })
      return best.ok ? best.payment.amount : best.maxSendable
    }
    if (!revised && request.target.kind === 'amount') {
      const ordinary = selectQbitP2mrSendCoins({
        utxos: coins,
        amount: request.target.amount,
        outputScriptLengths: shape.paymentOutputScriptLengths,
        changeScriptLength: keys.scriptPubKey.length,
        leafScriptLength: keys.leafScript.length,
        controlBlockLength: keys.controlBlock.length,
        feeRate: request.feeRate,
      })
      if (ordinary.ok) {
        const unconfirmed = coins.reduce(
          (total, coin) => total + (coin.unconfirmed ? coin.satoshis : 0),
          0
        )
        return refusal('not_needed', everything(), unconfirmed)
      }
    }
    const plan = planQbitSend({ ...shape, utxos: coins, target: request.target })
    if (!plan.ok) return refusal(plan.reason, plan.maxSendable, plan.unconfirmedSatoshis)
    if (!revised && plan.merges.length === 0) {
      return refusal('not_needed', everything(), plan.unconfirmedSatoshis)
    }

    const built = buildQbitSendPlanSteps({
      plan,
      keys,
      recipientScript,
      memoOutputs,
      paymentSequence: enableRBF ? QBIT_SEND_PLAN_RBF_SEQUENCE : QBIT_SEND_PLAN_FINAL_SEQUENCE,
      feeRate: request.feeRate,
      txidOf: psbt => this.host.txidOf(psbt, chain),
    })
    const steps: QbitSendPlanStepRecord[] = built.map(step => ({
      kind: step.kind,
      txid: step.txid,
      unsignedPsbtHex: step.psbtHex,
      inputs: step.inputs,
      vsize: step.vsize,
      fee: step.fee,
      feeRate: step.feeRate,
      ...(step.outputValue !== undefined ? { outputValue: step.outputValue } : {}),
      status: 'planned' as const,
    }))

    let carried: QbitSendPlanCarriedStep[] = []
    let paidFee = 0
    if (revised) {
      carried = [...(revised.carried ?? [])]
      paidFee = revised.paidFee ?? 0
      for (const merge of mergesOf(revised)) {
        if (merge.status === 'planned') {
          // A replacement not in the network: the version it replaced
          // confirmed (its output is the account's to spend now), or may
          // still confirm, and is carried.
          const replaced = merge.replaces
          if (replaced) paidFee += replaced.fee
          if (replaced && !replaced.confirmed) {
            carried.push({
              txid: replaced.txid,
              inputs: merge.inputs.map(input => ({ ...input })),
              fee: replaced.fee,
              status: 'broadcast',
            })
          }
          continue
        }
        paidFee += merge.fee
        if (merge.status === 'unknown' || merge.status === 'broadcast') {
          carried.push({
            txid: merge.txid,
            inputs: merge.inputs.map(input => ({ ...input })),
            fee: merge.fee,
            status: merge.status,
          })
        }
      }
      if (carried.length > QBIT_SEND_PLAN_MAX_CARRIED) {
        throw new Error('Too many merges of earlier versions of this plan are still unconfirmed')
      }
    }

    const opened = await this.openBatch(account.address, keys, steps, {
      keepFirstChallenge: true,
    })
    const totalFee = steps.reduce((total, step) => total + step.fee, 0)
    const payment = at(steps, steps.length - 1)
    const now = this.now()
    const draftId = randomHex(16)
    const pageChallenge = opened.firstChallenge
      ? { stepTxid: at(steps, 0).txid, risk: opened.firstChallenge }
      : undefined
    const review: QbitSendPlanReview = {
      draftId,
      chain,
      address,
      recipient: request.to,
      target: request.target.kind,
      amount: plan.payment.amount,
      change: plan.payment.change,
      feeRate: request.feeRate,
      totalFee: totalFee + paidFee,
      paidFee,
      merges: plan.merges.map(merge => ({ inputCount: merge.inputs.length, fee: merge.fee })),
      payment: { inputCount: plan.payment.inputCount, fee: plan.payment.fee, txid: payment.txid },
      signatureCount: plan.signatureCount,
      signatureBudget: {
        ...opened.batchBudget,
        ...(opened.firstChallenge ? { restoredFloorRisk: opened.firstChallenge } : {}),
      },
      estimatedSigningSeconds: estimateQbitSendPlanSigningSeconds(
        plan.signatureCount,
        steps.length
      ),
      leftBehindSatoshis: plan.leftBehindSatoshis,
      ...(request.revise ? { revises: request.revise } : {}),
      ...(revised && request.target.kind === 'everything'
        ? { previousAmount: revised.amount }
        : {}),
      expiresAt: this.reviewExpiry(now, opened.firstChallengeAskedAt),
    }
    const draft: PlanDraft = {
      draftId,
      ticket,
      sequence,
      planId: revised?.id ?? randomHex(16),
      chain,
      account: { address, pubkey: keys.pubkey },
      request,
      target: request.target.kind,
      amount: plan.payment.amount,
      change: plan.payment.change,
      feeRate: request.feeRate,
      steps,
      carried,
      paidFee,
      earlierPayments: [],
      revise: revised ? { planId: revised.id, revision: revised.revision } : undefined,
      batch: opened.batch,
      approval: opened.approval,
      pageChallenge,
      restoredFloor: opened.restoredFloor,
      expiresAt: review.expiresAt,
      timer: undefined,
      review,
    }
    if (!this.keepNewDraft(draft)) return refusal('plan_open')
    return { ok: true, review }
  }

  /**
   * The background decides what may be done with a plan, and a page only
   * offers that (`QbitSendPlanView.actions`): a revision the plan does not
   * offer now is a request no page should make, and throws.
   */
  private assertOffered(record: QbitSendPlanRecord, kind: QbitSendPlanRevision['kind']): void {
    const offered = actionsOf(record, this.host.isUnlocked(), slowMergeOf(record, this.now()))
    if (!offered.includes(kind)) {
      throw new Error('The Qbit send plan does not offer this revision now')
    }
  }

  /**
   * Keep a draft prepare made, for start, until it expires; returns false,
   * dropping it, when a plan is being started for the account meanwhile
   * (the draft being started stays). Prepares of one account can overlap,
   * and the newest wins: a draft an earlier prepare left is dropped with its
   * batch and challenge, and when a later prepare's draft is kept already,
   * this one is dropped instead (its review's start finds it expired). A
   * prepare that lost to a reset or to an ending of the account's plans (its
   * wallet was removed meanwhile) keeps nothing, and throws.
   */
  private keepNewDraft(draft: PlanDraft): boolean {
    if (this.lost(draft.ticket)) {
      this.dropDraft(draft)
      throw new Error(QBIT_SEND_PLAN_ACCOUNT_REQUIRED)
    }
    const draftKey = accountKeyOf(draft.chain, draft.account.address)
    if (this.starts.has(draftKey)) {
      this.dropDraft(draft)
      return false
    }
    const kept = this.drafts.get(draftKey)
    if (kept && kept !== draft) {
      if (kept.sequence > draft.sequence) {
        this.dropDraft(draft)
        return true
      }
      this.dropDraft(kept)
    }
    // Dropped when its review expires, with its batch and its challenge.
    draft.timer = this.timers.setTimeout(
      () => {
        if (this.drafts.get(draftKey) === draft) this.dropDraft(draft)
      },
      Math.max(0, draft.expiresAt - this.now())
    )
    this.drafts.set(draftKey, draft)
    return true
  }

  /**
   * When a review made at `now` expires: `QBIT_SEND_PLAN_DRAFT_TTL_MS` on,
   * or, for a review carrying a restored-floor challenge asked for at
   * `challengeAskedAt`, when that challenge expires
   * (`QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS`, the keyring's own lifetime of
   * one), whichever is first. A review never outlives what it depends on:
   * past the challenge's expiry the page's confirmation of it is refused, so
   * the review, and its draft, end then, and the page reviews again.
   */
  private reviewExpiry(now: number, challengeAskedAt: number | undefined): number {
    const draftEnd = now + QBIT_SEND_PLAN_DRAFT_TTL_MS
    return challengeAskedAt === undefined
      ? draftEnd
      : Math.min(draftEnd, challengeAskedAt + QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS)
  }

  /**
   * Price a revision that raises an open plan's fee to `request.feeRate`,
   * and keep it as a draft, which reserves nothing; see
   * `QbitSendPlanPrepareResult`. The recipient's outputs stay as they are,
   * and for an amount the amount: the extra fees come out of the change, as
   * the planner prices a payment (`priceQbitSendPlanPayment`), and a change
   * that cannot absorb them refuses the revision (`insufficient_balance`,
   * with the largest amount the revised plan pays). For everything the
   * amount is recomputed, and the review states the one it replaces.
   *
   * `raise_merge_fee` prices every step that has not confirmed again at the
   * new rate, the payment included: each merge in the network is replaced
   * by one spending the same inputs (a new id, so the payment is built again
   * on it), each merge not sent yet is built again, and a merge that
   * confirmed is kept. It is refused while a merge's outcome is unknown, or
   * a merge raised before has not settled with the version it replaced
   * (`outputs_unavailable`: wait), and the rate must be above the plan's
   * and replace every merge in the network by the rule the fee bump applies
   * (`fee_rate_too_low`, with the lowest rate that does).
   * `raise_payment_fee` builds the payment again over the same inputs at
   * the new rate, which must be above the plan's, and keeps every merge.
   * Either is refused, as an error, for a plan a replan alone can carry on:
   * one whose raised merge's earlier version confirmed instead.
   */
  private async prepareFeeRaise(context: {
    ticket: WorkTicket
    sequence: number
    request: QbitSendPlanRequest
    kind: 'raise_merge_fee' | 'raise_payment_fee'
    chain: ChainType
    account: Account
    keys: QbitSendPlanAccountKeys
    recipientScript: Uint8Array
    memoOutputs: P2mrTransactionOutput[]
    enableRBF: boolean
    revised: QbitSendPlanRecord
    refusal: (
      reason: Extract<QbitSendPlanPrepareResult, { ok: false }>['reason'],
      maxSendable?: number,
      unconfirmedSatoshis?: number
    ) => QbitSendPlanPrepareResult
  }): Promise<QbitSendPlanPrepareResult> {
    const { request, kind, chain, account, keys, recipientScript, memoOutputs, revised, refusal } =
      context
    const merges = mergesOf(revised)
    if (merges.some(isVoid)) {
      throw new Error('The Qbit send plan needs a replan: a merge it replaced confirmed instead')
    }
    const feeRate = request.feeRate
    const shape: QbitSendPlanRevisionShape = {
      paymentOutputScriptLengths: [
        recipientScript.length,
        ...memoOutputs.map(output => output.scriptPubKey.length),
      ],
      accountScriptLength: keys.scriptPubKey.length,
      leafScriptLength: keys.leafScript.length,
      controlBlockLength: keys.controlBlock.length,
    }
    const raisesMerges = kind === 'raise_merge_fee'
    const sent = raisesMerges ? merges.filter(merge => merge.status === 'broadcast') : []
    if (raisesMerges) {
      if (merges.some(merge => merge.status === 'unknown' || pendingReplaced(merge))) {
        return refusal('outputs_unavailable')
      }
      if (sent.length === 0) {
        throw new Error('The Qbit send plan has no merge waiting for confirmation')
      }
    }
    if (
      !(feeRate > revised.feeRate) ||
      sent.some(merge => !qbitSendPlanMergeReplaceable(shape, merge, feeRate))
    ) {
      return {
        ok: false,
        reason: 'fee_rate_too_low',
        maxSendable: 0,
        unconfirmedSatoshis: 0,
        minimumFeeRate: lowestQbitSendPlanRaiseRate(shape, sent, revised.feeRate),
      }
    }

    let coins: QbitSendPlanCoin[]
    try {
      coins = await this.host.spendableOutputs(chain, account, revised.id)
    } catch (error) {
      this.log('Qbit send plan could not read the account outputs', error)
      return refusal('outputs_unavailable')
    }

    // The merges priced again, in plan order, and those kept as they are.
    const rebuilt = raisesMerges ? merges.filter(merge => merge.status !== 'confirmed') : []
    const rebuiltTxids = new Set(rebuilt.map(merge => merge.txid))
    const kept = merges.filter(merge => !rebuiltTxids.has(merge.txid))
    const prices = rebuilt.map(merge => priceQbitSendPlanMerge(shape, merge.inputs, feeRate))
    if (prices.some(price => price.outputValue < QBIT_P2MR_DUST)) {
      return refusal('insufficient_balance')
    }
    const payment = paymentOf(revised)
    const mergeTxids = new Set(merges.map(merge => merge.txid))
    const keptOutputs = kept.map(merge => ({
      txid: merge.txid,
      vout: 0,
      satoshis: merge.outputValue ?? 0,
    }))
    const direct = payment.inputs.filter(input => !mergeTxids.has(input.txid))
    // A raise of the payment's fee builds a version of the payment: over the
    // inputs of the one it replaces, in the same order, so every version
    // spends the same inputs input by input (`earlierPayments`, which the
    // store checks so, and which a version found completes the plan with).
    // A raise of a merge's fee builds a payment on the replacements, whose
    // outputs come first, as the outputs of the merges a plan builds do.
    const paymentCoins = (raisesMerges ? [...keptOutputs, ...direct] : payment.inputs).map(
      input => ({ txid: input.txid, vout: input.vout, satoshis: input.satoshis })
    )
    const inputTotal =
      prices.reduce((total, price) => total + price.outputValue, 0) +
      paymentCoins.reduce((total, coin) => total + coin.satoshis, 0)
    const inputCount = rebuilt.length + paymentCoins.length
    const priced = priceQbitSendPlanPayment(shape, inputTotal, inputCount, request.target, feeRate)
    if (!priced.ok) {
      return refusal(
        request.target.kind === 'everything' ? 'nothing_to_send' : 'insufficient_balance',
        priced.maxSendable
      )
    }

    const plan: QbitSendPlan<QbitSelectableCoin> = {
      ok: true,
      target: request.target.kind,
      merges: rebuilt.map((merge, index) => {
        const price = at(prices, index)
        return {
          inputs: merge.inputs.map(input => ({ ...input })),
          totalInput: merge.inputs.reduce((total, input) => total + input.satoshis, 0),
          vsize: price.vsize,
          fee: price.fee,
          outputValue: price.outputValue,
        }
      }),
      payment: {
        coins: paymentCoins,
        inputCount,
        amount: priced.amount,
        vsize: priced.vsize,
        fee: priced.fee,
        change: priced.change,
        includeChange: priced.includeChange,
        changeDroppedSats: priced.changeDroppedSats,
        maximumTotalFee: priced.maximumTotalFee,
      },
      totalInput: inputTotal,
      totalFee: priced.fee + prices.reduce((total, price) => total + price.fee, 0),
      signatureCount: 0,
      leftBehind: [],
      leftBehindSatoshis: 0,
      unconfirmedSatoshis: 0,
    }
    const built = buildQbitSendPlanSteps({
      plan,
      keys,
      recipientScript,
      memoOutputs,
      paymentSequence: context.enableRBF
        ? QBIT_SEND_PLAN_RBF_SEQUENCE
        : QBIT_SEND_PLAN_FINAL_SEQUENCE,
      feeRate,
      txidOf: psbt => this.host.txidOf(psbt, chain),
    })
    // The steps built again record the raised rate; a merge kept as it is
    // keeps the rate it was built at.
    const stepOf = (step: (typeof built)[number]): QbitSendPlanStepRecord => ({
      kind: step.kind,
      txid: step.txid,
      unsignedPsbtHex: step.psbtHex,
      inputs: step.inputs,
      vsize: step.vsize,
      fee: step.fee,
      feeRate: step.feeRate,
      ...(step.outputValue !== undefined ? { outputValue: step.outputValue } : {}),
      status: 'planned' as const,
    })
    const replacing = new Map<string, QbitSendPlanStepRecord>()
    rebuilt.forEach((merge, index) => {
      const step = stepOf(at(built, index))
      // A merge in the network is replaced: the step keeps the version it
      // replaces until one of the two confirms.
      replacing.set(
        merge.txid,
        merge.status === 'broadcast'
          ? { ...step, replaces: { txid: merge.txid, fee: merge.fee } }
          : step
      )
    })
    const newPayment = stepOf(at(built, built.length - 1))
    const steps: QbitSendPlanStepRecord[] = [
      ...merges.map(merge => replacing.get(merge.txid) ?? merge),
      newPayment,
    ]
    // What the revised plan signs, in the order it signs: the merges not
    // sent yet, then the payment.
    const toSign = steps.filter(step => step.status === 'planned')
    const signatureCount = toSign.reduce((total, step) => total + step.inputs.length, 0)

    const spent = new Set(
      steps.flatMap(step => step.inputs.map(input => `${input.txid}:${input.vout}`))
    )
    const leftBehindSatoshis = coins.reduce(
      (total, coin) =>
        coin.unconfirmed === true || spent.has(`${coin.txid.toLowerCase()}:${coin.vout}`)
          ? total
          : total + coin.satoshis,
      0
    )
    const paidFee =
      (revised.paidFee ?? 0) +
      merges.reduce((total, merge) => total + (merge.status === 'confirmed' ? merge.fee : 0), 0)
    // Every version of the payment whose bytes left the wallet is kept: the
    // new one spends the same inputs, so whichever confirms is the payment.
    const replacedPayment = paymentVersionOf(revised)
    const earlierPayments = [
      ...(revised.earlierPayments ?? []),
      ...(replacedPayment ? [replacedPayment] : []),
    ]
    if (earlierPayments.length > QBIT_SEND_PLAN_MAX_EARLIER_PAYMENTS) {
      throw new Error('Too many earlier versions of this Qbit send plan’s payment')
    }

    const opened = await this.openBatch(account.address, keys, toSign, {
      keepFirstChallenge: true,
    })
    const now = this.now()
    const draftId = randomHex(16)
    const review: QbitSendPlanReview = {
      draftId,
      chain,
      address: account.address,
      recipient: request.to,
      target: request.target.kind,
      amount: priced.amount,
      change: priced.change,
      feeRate,
      totalFee: steps.reduce((total, step) => total + step.fee, 0) + (revised.paidFee ?? 0),
      paidFee,
      merges: [...replacing.values()].map(step => ({
        inputCount: step.inputs.length,
        fee: step.fee,
      })),
      payment: { inputCount, fee: priced.fee, txid: newPayment.txid },
      signatureCount,
      signatureBudget: {
        ...opened.batchBudget,
        ...(opened.firstChallenge ? { restoredFloorRisk: opened.firstChallenge } : {}),
      },
      estimatedSigningSeconds: estimateQbitSendPlanSigningSeconds(signatureCount, toSign.length),
      leftBehindSatoshis,
      revises: { planId: revised.id, kind },
      ...(request.target.kind === 'everything' ? { previousAmount: revised.amount } : {}),
      expiresAt: this.reviewExpiry(now, opened.firstChallengeAskedAt),
    }
    // The bookkeeping of the steps the revision keeps goes with them.
    const listed = new Set(steps.map(step => step.txid))
    const keptTimes = (times: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.entries(times).filter(([txid]) => listed.has(txid)))
    const draft: PlanDraft = {
      draftId,
      ticket: context.ticket,
      sequence: context.sequence,
      planId: revised.id,
      chain,
      account: { address: account.address, pubkey: keys.pubkey },
      request,
      target: request.target.kind,
      amount: priced.amount,
      change: priced.change,
      feeRate,
      steps,
      carried: [...(revised.carried ?? [])],
      paidFee: revised.paidFee ?? 0,
      earlierPayments,
      extra: {
        mergeBroadcastAt: keptTimes(mergeBroadcastTimes(revised)),
        mergeConfirmedAt: keptTimes(mergeConfirmedTimes(revised)),
      },
      revise: { planId: revised.id, revision: revised.revision },
      batch: opened.batch,
      approval: opened.approval,
      pageChallenge: opened.firstChallenge
        ? { stepTxid: at(toSign, 0).txid, risk: opened.firstChallenge }
        : undefined,
      restoredFloor: opened.restoredFloor,
      expiresAt: review.expiresAt,
      timer: undefined,
      review,
    }
    if (!this.keepNewDraft(draft)) return refusal('plan_open')
    return { ok: true, review }
  }

  /**
   * Before a revision is planned, every merge of `record` that was sent, or
   * may have been, and has not confirmed, and every merge it carries, is
   * looked up, and what is found is stored: a merge that confirmed since
   * the plan last advanced is the account's output to spend, not a merge
   * to carry. So is the earlier version of a raised merge: found
   * confirmed, it won (see `supersede`). Each is asked afresh, whenever it
   * was last read. Resolves to the record as it is then. A lookup without
   * an answer, or one that misses, leaves the merge as it was.
   *
   * Then what spends the payment's inputs is identified, afresh: a version
   * of the payment found in the network, or a transaction paying the
   * recipient the amount, completes the plan, and the revision is refused;
   * a spend elsewhere means no version of the payment can confirm any more,
   * and the plan pauses `outputs_spent` (see `settlePaymentInputSpender`).
   */
  private async settleBeforeRevision(record: QbitSendPlanRecord): Promise<QbitSendPlanRecord> {
    const session = this.session(record.id)
    const sent = [
      ...mergesOf(record).filter(
        merge => merge.status === 'unknown' || merge.status === 'broadcast'
      ),
      ...(record.carried ?? []),
    ]
    for (const { txid, status } of sent) {
      const state = await this.lookup(record, session, txid, { fresh: true })
      if (state === undefined || state === 'gone') continue
      if (state === 'pending' && status === 'broadcast') continue
      await this.recordFound(record.id, txid, state)
    }
    for (const merge of mergesOf(this.store.get(record.id) ?? record)) {
      const replaced = pendingReplaced(merge)
      if (!replaced || merge.status === 'confirmed') continue
      const state = await this.lookup(record, session, replaced.txid, { fresh: true })
      if (state === 'confirmed') await this.supersede(record.id, merge.txid)
    }
    const settled = this.store.get(record.id) ?? record
    if (settled.phase === 'completed' || settled.phase === 'cancelling') return settled
    if (await this.reconcilePaymentVersions(settled, session, { fresh: true })) {
      return this.store.get(record.id) ?? settled
    }
    const spender = await this.inputsSpentElsewhere(settled, session, paymentOf(settled))
    if (
      spender !== undefined &&
      (await this.settlePaymentInputSpender(settled, session, spender)) === 'elsewhere'
    ) {
      await this.pause(record.id, 'outputs_spent')
    }
    return this.store.get(record.id) ?? settled
  }

  /** The selected account, when it can carry a send plan: a P2MR account the wallet signs for itself. */
  private planAccount(): Account {
    const account = this.host.currentAccount()
    if (!account?.p2mr || getAccountCapabilities(account).signMethod !== AccountSignMethod.Local) {
      throw new Error(QBIT_SEND_PLAN_ACCOUNT_REQUIRED)
    }
    return account
  }

  /** The account's single-key spend, checked against what the account records. */
  private accountKeys(account: Account): QbitSendPlanAccountKeys {
    const p2mr = account.p2mr
    if (!p2mr) throw new Error('Qbit send plans need a single-key P2MR account')
    const keys = qbitSendPlanAccountKeys(planPubkeyOf(account))
    const hex = (bytes: Uint8Array): string =>
      [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
    if (
      hex(keys.scriptPubKey) !== p2mr.scriptPubKey.toLowerCase() ||
      hex(keys.leafScript) !== p2mr.leafScript.toLowerCase()
    ) {
      throw new Error('Qbit send plans need a single-key P2MR account')
    }
    return keys
  }

  /**
   * Prepare the budgets of `steps` and open one signature batch over them:
   * the model of a batch approved together (#152), whose one budget the
   * review states. A restored-floor key gets a challenge with every budget
   * prepared; all are released at once but, with `keepFirstChallenge`, the
   * first step's, which the page confirms before start (see `start`). With
   * `continues`, the fresh figures must differ from that approval only by
   * what the plan's own signings took (`assertContinues`), or nothing opens
   * (`QbitSendPlanBudgetChangedError`); once the batch is open, the approval
   * counts what they took as read from the counter.
   */
  private async openBatch(
    address: string,
    keys: QbitSendPlanAccountKeys,
    steps: readonly QbitSendPlanStepRecord[],
    options: { keepFirstChallenge?: boolean; continues?: PlanApproval } = {}
  ): Promise<{
    batch: PlanBatch
    batchBudget: QbitSignatureBudgetImpact
    approval: PlanApproval
    firstChallenge: QbitSignatureBudgetImpact['restoredFloorRisk']
    /** When the first challenge was asked for: the keyring dates its expiry from then on. */
    firstChallengeAskedAt: number | undefined
    restoredFloor: boolean
  }> {
    const challenges: string[] = []
    let firstChallenge: QbitSignatureBudgetImpact['restoredFloorRisk']
    try {
      const prepared = await this.prepareBudgets(
        address,
        keys,
        steps,
        challenges,
        options.keepFirstChallenge === true
      )
      firstChallenge = prepared.firstChallenge
      const { inputs } = prepared
      const taken = options.continues
        ? this.assertContinues(options.continues, steps, inputs)
        : undefined
      const opened = await this.keyring.openP2mrPsbtSigningBatch(address, inputs)
      const entries = new Map<string, { index: number; budget: QbitSignatureBudgetImpact }>()
      steps.forEach((step, index) => {
        entries.set(step.txid, { index, budget: at(inputs, index).approvedBudget })
      })
      let approval: PlanApproval
      if (options.continues && taken !== undefined) {
        // What the plan's signings took is now read from the counter.
        approval = options.continues
        approval.spent = taken
        approval.unreported = 0
      } else {
        approval = approvalOf(steps, inputs)
      }
      return {
        batch: { id: opened.id, entries },
        batchBudget: figuresOf(opened.budget),
        approval,
        firstChallenge,
        firstChallengeAskedAt: prepared.firstChallengeAskedAt,
        restoredFloor: prepared.restoredFloor,
      }
    } catch (error) {
      if (firstChallenge) challenges.push(firstChallenge.challengeId)
      throw error
    } finally {
      if (challenges.length > 0) this.keyring.releaseQbitRestoredFloorSigningChallenges(challenges)
    }
  }

  /**
   * Fresh budgets of `steps`, in order, read from the keyring now: the
   * figures a batch opens under, or that a continue approves. A
   * restored-floor key gets a challenge with each budget; its id goes onto
   * `challenges` for the caller to release, but, with `keepFirstChallenge`,
   * the first step's, which comes back instead (and goes onto `challenges`
   * too when this throws).
   */
  private async prepareBudgets(
    address: string,
    keys: QbitSendPlanAccountKeys,
    steps: readonly QbitSendPlanStepRecord[],
    challenges: string[],
    keepFirstChallenge: boolean
  ): Promise<{
    inputs: { psbt: Psbt; keys: P2mrSigningKey[]; approvedBudget: QbitSignatureBudgetImpact }[]
    firstChallenge: QbitSignatureBudgetImpact['restoredFloorRisk']
    firstChallengeAskedAt: number | undefined
    restoredFloor: boolean
  }> {
    const inputs: {
      psbt: Psbt
      keys: P2mrSigningKey[]
      approvedBudget: QbitSignatureBudgetImpact
    }[] = []
    let firstChallenge: QbitSignatureBudgetImpact['restoredFloorRisk']
    let firstChallengeAskedAt: number | undefined
    let restoredFloor = false
    try {
      for (const [index, step] of steps.entries()) {
        const psbt = qbitSendPlanPsbtFromHex(step.unsignedPsbtHex)
        const signingKeys = qbitSendPlanSigningKeys(psbt, keys)
        const askedAt = this.now()
        const budget = await this.keyring.preflightP2mrPsbtSigning(address, {
          psbt,
          keys: signingKeys,
        })
        const risk = budget.restoredFloorRisk
        if (risk) {
          restoredFloor = true
          if (index === 0 && keepFirstChallenge) {
            firstChallenge = risk
            firstChallengeAskedAt = askedAt
          } else challenges.push(risk.challengeId)
        }
        inputs.push({ psbt, keys: signingKeys, approvedBudget: figuresOf(budget) })
      }
    } catch (error) {
      if (firstChallenge) challenges.push(firstChallenge.challengeId)
      throw error
    }
    return { inputs, firstChallenge, firstChallengeAskedAt, restoredFloor }
  }

  /**
   * Whether fresh budgets of `steps` continue `approval`, so that the plan
   * carries on signing without the user approving again; returns the
   * counter units the plan's own signings took since the approval, as the
   * counter shows them. The rule, exactly:
   *
   * - What was approved: every step left signs the inputs it was approved
   *   for (`required + cached` as approved), under the same limit.
   * - What the plan took since: the key's counter moved by the plan's own
   *   signings and by nothing else, that is by `spent`, the units they
   *   reported taking, plus at most one unit for each signing cut short
   *   with an input in flight (`unreported`), whose unit may have been
   *   taken with no signature made. A signing the keyring stopped before
   *   its next input adds nothing, so a single signature of another
   *   request after it is found. Every fresh budget reads that same
   *   counter.
   * - What it still needs: each step's fresh `required`. The key's
   *   signature cache keeps its 16 most recent signatures, and signing a
   *   transaction again from its first input evicts them before it reaches
   *   them, so a transaction whose signing was cut short after more than
   *   16 inputs needs all its signatures again. Only the plan's own
   *   signatures change what the cache serves without moving the counter
   *   past that bound.
   *
   * Anything else (a signature of another request, another limit, other
   * inputs, a step the approval does not list) throws
   * `QbitSendPlanBudgetChangedError`: the plan pauses, and the user's
   * continue approves the figures it reads then (`readApproval`).
   */
  private assertContinues(
    approval: PlanApproval,
    steps: readonly QbitSendPlanStepRecord[],
    inputs: readonly { approvedBudget: QbitSignatureBudgetImpact }[]
  ): number {
    const counter = at(inputs, 0).approvedBudget.remainingBefore
    steps.forEach((step, index) => {
      const approved = approval.entries.get(step.txid)
      const fresh = at(inputs, index).approvedBudget
      if (
        !approved ||
        fresh.limit !== approval.limit ||
        fresh.required + fresh.cached !== approved.required + approved.cached ||
        fresh.remainingBefore !== counter ||
        fresh.remainingAfter !== fresh.remainingBefore - fresh.required
      ) {
        throw new QbitSendPlanBudgetChangedError()
      }
    })
    const taken = approval.remainingBefore - counter
    if (taken < approval.spent || taken > approval.spent + approval.unreported) {
      throw new QbitSendPlanBudgetChangedError()
    }
    return taken
  }

  private dropDraft(draft: PlanDraft): void {
    const key = accountKeyOf(draft.chain, draft.account.address)
    if (this.drafts.get(key) === draft) this.drafts.delete(key)
    this.timers.clearTimeout(draft.timer)
    this.keyring.releaseP2mrPsbtSigningBatches([draft.batch.id])
    if (draft.pageChallenge) {
      this.keyring.releaseQbitRestoredFloorSigningChallenges([draft.pageChallenge.risk.challengeId])
    }
  }

  private findDraft(draftId: unknown): PlanDraft | undefined {
    if (typeof draftId !== 'string') return undefined
    return [...this.drafts.values()].find(draft => draft.draftId === draftId)
  }

  // -- start --------------------------------------------------------------

  /**
   * Start the reviewed plan `draftId`; see `QbitSendPlanStartResult`. Its
   * holds and its record are one coupled change: a hold refused writes
   * nothing (`outputs_changed`), and a write that fails releases the holds;
   * a replan swaps the holds and the record (see `startRevision`). A plan
   * whose review carried a restored-floor risk starts only once the page
   * confirmed that challenge: its first signature is made under it, and
   * start waits for that signing's checks, undoing the start and throwing
   * the keyring's coded error (`QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED`)
   * when they refuse it. It waits no longer than the plan's first advance:
   * a plan that stops before that signature with the challenge still held
   * (it pauses, the plan is cancelled, or the wallet is on another network)
   * is started all the same, and resolves as it is then, its holds those of
   * the stored record; one whose challenge went before that signature could
   * check it (a lock, the draft's expiry) is undone (`draft_expired`, see
   * `begin`). An advance that only made way for a continue writing the plan
   * (another page's, which then finds nothing to continue) is not that
   * advance: the continue's end advances the plan again. A plan of an
   * ordinary key starts whatever happens to its draft meanwhile.
   *
   * One start runs at a time for an account (a double click, two wallet
   * pages): a second start of the same draft while the first runs gets the
   * first's outcome, and a start of another draft is refused (`plan_open`).
   * Neither touches anything of the start under way.
   */
  start(draftId: unknown): Promise<QbitSendPlanStartResult> {
    // A start of this draft under way answers for it, whatever became of
    // the draft since (begin takes it out of the drafts kept, and a lock or
    // its expiry may drop it).
    for (const running of this.starts.values()) {
      if (running.draftId === draftId) return running.result
    }
    const draft = this.findDraft(draftId)
    if (!draft) return this.startDraft(undefined)
    const key = accountKeyOf(draft.chain, draft.account.address)
    // Another draft's start runs for the account.
    if (this.starts.has(key)) return Promise.resolve({ ok: false, reason: 'plan_open' })
    const result = this.startDraft(draft)
    const entry = { draftId: draft.draftId, result }
    this.starts.set(key, entry)
    const settled = (): void => {
      if (this.starts.get(key) === entry) this.starts.delete(key)
    }
    result.then(settled, settled)
    return result
  }

  private async startDraft(draft: PlanDraft | undefined): Promise<QbitSendPlanStartResult> {
    if (!draft || this.now() > draft.expiresAt || this.lost(draft.ticket)) {
      if (draft) this.dropDraft(draft)
      return { ok: false, reason: 'draft_expired' }
    }
    if (!this.host.isUnlocked()) return { ok: false, reason: 'locked' }
    const account = this.host.currentAccount()
    if (
      this.host.activeChain() !== draft.chain ||
      account?.address !== draft.account.address ||
      planPubkeyOf(account) !== draft.account.pubkey
    ) {
      this.dropDraft(draft)
      return { ok: false, reason: 'draft_expired' }
    }
    // The request the draft was made from, checked again on this network.
    readQbitSendPlanRequest(draft.request)
    this.host.recipientScript(draft.chain, draft.request.to)
    if (this.unreadableFor(draft.chain, draft.account.address)) {
      return { ok: false, reason: 'plan_open' }
    }
    const existing = this.store.findOpen(draft.chain, draft.account.address)
    if (draft.revise) {
      if (!existing || existing.id !== draft.revise.planId) {
        this.dropDraft(draft)
        return { ok: false, reason: 'draft_expired' }
      }
      if (existing.revision !== draft.revise.revision || paymentMayBeSent(existing)) {
        this.dropDraft(draft)
        return { ok: false, reason: 'draft_expired' }
      }
      try {
        this.assertOffered(existing, draft.request.revise?.kind ?? 'replan')
      } catch (error) {
        this.dropDraft(draft)
        throw error
      }
      return this.startRevision(draft, existing)
    }
    if (existing && existing.phase !== 'completed') return { ok: false, reason: 'plan_open' }

    const record = this.draftRecord(draft)
    const outpoints = qbitSendPlanOutpoints(record)
    let hold: QbitSendPlanHold
    try {
      hold = await this.guard.holdOutpointsForPlan({
        planId: draft.planId,
        chain: draft.chain,
        address: draft.account.address,
        outpoints,
      })
    } catch (error) {
      if (error instanceof QbitSendPlanHoldConflictError) {
        this.dropDraft(draft)
        return { ok: false, reason: 'outputs_changed' }
      }
      throw error
    }
    if (this.lost(draft.ticket)) {
      // A reset, or an ending of the account's plans, came while the hold
      // was taken: nothing is written, and the hold goes.
      this.dropDraft(draft)
      if (!this.store.get(draft.planId)) await this.guard.releasePlanOutpoints(draft.planId)
      return { ok: false, reason: 'draft_expired' }
    }
    let written: QbitSendPlanRecord | undefined
    const session = this.session(draft.planId)
    session.starting = true
    try {
      if (!existing || (await this.removeCompleted(existing.id))) {
        written = await this.store.put(record, null)
      }
    } catch (error) {
      session.starting = false
      // What this start took for a plan it could not store; never what a
      // stored plan holds.
      if (!this.store.get(draft.planId)) await this.guard.releasePlanOutpoints(draft.planId)
      if (error instanceof QbitSendPlanStoreError) {
        if (error.code === 'account_has_open_plan' || error.code === 'unreadable_document') {
          return { ok: false, reason: 'plan_open' }
        }
      }
      throw error
    }
    if (!written) {
      // The plan under `existing`'s id is open: never the case for a plan
      // that completed, which stays completed until it goes.
      session.starting = false
      await this.guard.releasePlanOutpoints(draft.planId)
      return { ok: false, reason: 'plan_open' }
    }
    return this.begin(draft, written, hold)
  }

  /** The record a draft starts as. */
  private draftRecord(draft: PlanDraft): QbitSendPlanRecordInput {
    return {
      id: draft.planId,
      chain: draft.chain,
      account: { ...draft.account },
      recipient: draft.request.to,
      target: draft.target,
      amount: draft.amount,
      change: draft.change,
      feeRate: draft.feeRate,
      totalFee: draft.steps.reduce((total, step) => total + step.fee, 0),
      steps: draft.steps,
      ...(draft.carried.length > 0 ? { carried: draft.carried } : {}),
      ...(draft.paidFee > 0 ? { paidFee: draft.paidFee } : {}),
      ...(draft.earlierPayments.length > 0 ? { earlierPayments: draft.earlierPayments } : {}),
      ...(draft.extra ? { extra: draft.extra } : {}),
      phase: 'signing',
    }
  }

  /**
   * Remove completed plan `planId`, which a new plan of its account
   * replaces, and what it still holds, at the revision stored when it is
   * removed: a page's read or the timer may have written it since the start
   * read it (its payment found confirmed), and a removal decided on that
   * read would meet a newer revision. Resolves to whether nothing is stored
   * under `planId` any more: false only for a plan that is not completed.
   */
  private async removeCompleted(planId: string): Promise<boolean> {
    let open = false
    await this.mutate(planId, current => {
      open = current.phase !== 'completed'
      return open ? undefined : 'delete'
    })
    return !open
  }

  /**
   * Swap a revised plan in: the holds first grow to the old and the new
   * outpoints together (a conflict refuses the start with nothing changed),
   * then the record is written under the revision the review read (a
   * refusal takes the holds back to what the plan stored then needs, and
   * the plan carries on at once). The holds narrow to the new plan's once
   * its first signing has passed its checks, or at once when the review
   * carried no restored-floor challenge. A start whose first signature is
   * refused for that challenge writes the old plan back instead (see
   * `undoRevision`). So whatever fails, the stored record is the old plan or
   * the new one, held in full, and a restart in between restores the holds
   * from whichever is stored. A start that loses to a change of the plan
   * since the review (another page's cancel, or the plan's own advance)
   * answers `draft_expired` and leaves the plan holding what its stored
   * record needs: a cancelled plan's, or nothing once the cancel removed it
   * (see `begin` for a cancel that lands after the write).
   */
  private async startRevision(
    draft: PlanDraft,
    existing: QbitSendPlanRecord
  ): Promise<QbitSendPlanStartResult> {
    const session = this.session(existing.id)
    const record = this.draftRecord(draft)
    const oldHolds = desiredHolds(existing)
    // What the new plan needs held: a fee raise keeps merges that confirmed,
    // whose inputs the plan let go of then and never holds again.
    const newHolds = desiredHolds(record as QbitSendPlanRecord)
    const newOutpoints = qbitSendPlanOutpoints(record).filter(outpoint =>
      newHolds.has(outpointKey(outpoint))
    )
    const union = new Map<string, QbitOutpoint>()
    for (const outpoint of qbitSendPlanOutpoints(existing)) {
      if (oldHolds.has(outpointKey(outpoint))) union.set(outpointKey(outpoint), outpoint)
    }
    for (const outpoint of newOutpoints) union.set(outpointKey(outpoint), outpoint)
    const entry = (outpoints: Iterable<QbitOutpoint>): QbitSendPlanOutpoints => ({
      planId: existing.id,
      chain: existing.chain,
      address: existing.account.address,
      outpoints: [...outpoints],
    })
    // Whether the stored plan is still the one the review read: a change in
    // between (another page's cancel, or the plan's own advance) wins over
    // this start.
    const unchanged = (): boolean => this.store.get(existing.id)?.revision === existing.revision
    let hold: QbitSendPlanHold
    try {
      try {
        hold = await this.guard.replacePlanOutpoints(entry(union.values()))
      } catch (error) {
        // A plan holding nothing any more takes its hold afresh, unless it
        // changed meanwhile: a cancel may have let go of it for good, and a
        // reset or an ending of the account's plans takes it.
        if (!(error instanceof QbitSendPlanHeldError) || error.reason !== 'inactive') throw error
        if (!unchanged() || this.lost(draft.ticket)) throw error
        hold = await this.guard.holdOutpointsForPlan(entry(union.values()))
      }
    } catch (error) {
      // The guard changed nothing: a refused hold keeps what the plan held.
      if (!unchanged() || this.lost(draft.ticket)) {
        this.dropDraft(draft)
        return { ok: false, reason: 'draft_expired' }
      }
      if (error instanceof QbitSendPlanHoldConflictError) {
        this.dropDraft(draft)
        return { ok: false, reason: 'outputs_changed' }
      }
      throw error
    }
    if (this.lost(draft.ticket)) {
      // A reset, or an ending of the account's plans, came while the holds
      // grew: nothing is written, and the plan holds what its stored record
      // needs, for that ending to end it.
      this.dropDraft(draft)
      await this.holdOnlyWhatIsStored(existing.id)
      return { ok: false, reason: 'draft_expired' }
    }
    const before: PlanSessionState = {
      authorised: session.authorised,
      approval: session.approval,
      approvalDue: session.approvalDue,
      pageChallenge: session.pageChallenge,
      restoredFloor: session.restoredFloor,
      signedMerges: session.signedMerges,
      reached: session.reached,
      notSent: session.notSent,
      adopted: session.adopted,
      restoreConflict: session.restoreConflict,
    }
    session.hold = hold
    this.stopSigning(session)
    session.starting = true
    let written: QbitSendPlanRecord
    try {
      written = await this.store.put(record, existing.revision)
    } catch (error) {
      session.starting = false
      // The holds go back to what the plan stored now needs: a cancel or the
      // plan's own advance may have written it since the review read it, and
      // a cancel may have removed it, which leaves nothing to hold.
      await this.holdOnlyWhatIsStored(existing.id)
      // The plan the revision would have replaced carries on as it is: a
      // signing the swap stopped opens a batch again, under its approval.
      if (this.store.get(existing.id)) {
        void this.advance(existing.id)
        this.ensureTimer()
      }
      if (isStoreConflict(error)) {
        this.dropDraft(draft)
        return { ok: false, reason: 'draft_expired' }
      }
      throw error
    }
    // The revised plan signs every step it lists from its first input, a
    // merge the replaced plan signed under the same id included: its bytes
    // and the progress shown for it go with that plan.
    session.signedMerges = new Map()
    session.reached = new Map()
    session.notSent = new Map()
    const revision: PlanRevisionStart = { replaced: existing, before, held: [...union.values()] }
    if (!draft.pageChallenge) await this.narrowRevisionHolds(written.id, revision)
    return this.begin(draft, written, hold, revision)
  }

  /**
   * A revision's start has settled on the new plan: let go of what the old
   * plan held that the stored record no longer lists. Releasing only, so
   * nothing is taken again that the plan has let go of since.
   */
  private async narrowRevisionHolds(planId: string, revision: PlanRevisionStart): Promise<void> {
    const current = this.store.get(planId)
    if (!current) return
    const listed = new Set(qbitSendPlanOutpoints(current).map(outpointKey))
    const release = revision.held.filter(outpoint => !listed.has(outpointKey(outpoint)))
    if (release.length === 0) return
    try {
      await this.guard.releasePlanOutpoints(planId, release)
    } catch (error) {
      // The holds stay a superset of what the stored record needs.
      this.log('Qbit send plan could not narrow its holds after a revision', error)
    }
  }

  /**
   * Make plan `planId`'s holds exactly what its stored record needs now
   * (`desiredHolds`), or nothing once no record is stored: after a start
   * that took holds for itself and then lost to a change of the plan.
   * Never throws: a failure is logged, and the holds stay a superset of what
   * the stored record needs.
   */
  private async holdOnlyWhatIsStored(planId: string): Promise<void> {
    try {
      const current = this.store.get(planId)
      const desired = current ? desiredHolds(current) : new Set<string>()
      if (!current || desired.size === 0) {
        await this.guard.releasePlanOutpoints(planId)
        const session = this.sessions.get(planId)
        if (session) session.hold = undefined
        return
      }
      await this.guard.replacePlanOutpoints({
        planId,
        chain: current.chain,
        address: current.account.address,
        outpoints: qbitSendPlanOutpoints(current).filter(outpoint =>
          desired.has(outpointKey(outpoint))
        ),
      })
    } catch (error) {
      this.log('Qbit send plan could not hold only what the stored plan needs', error)
    }
  }

  /**
   * The draft's plan is stored and held: authorise its signing in this
   * session and set it going. A draft let go of while the start wrote the
   * plan (a lock, or its expiry) released its batch: an ordinary key's plan
   * opens a batch of its own for its first signature, under the same
   * approval.
   *
   * A review that carried a restored-floor challenge starts only once the
   * page's confirmation of it has been checked: by the keyring, as the
   * plan's first signature is made under it. When that challenge is gone
   * before the check (the draft was let go of while the start wrote the
   * plan, or the first advance ended after a lock cleared it or a signing
   * stopped short released it), nothing can check it any more: the start is
   * undone, nothing of it signed or sent, and answers `draft_expired`; the
   * page reviews again and confirms the new review's challenge. A first
   * advance that ends with the challenge still held (another network, a
   * pause) leaves the plan started, its first signature still to be made
   * under that challenge. An undo writes back, or removes, only the very
   * record the start wrote: when anything else changed the plan since
   * (another page's cancel, during the first signature), that stands,
   * nothing of the session is restored, and the start answers
   * `draft_expired` (see `undoRevision` and `undoStart`).
   *
   * Known and left so: once a start has returned with the challenge still
   * held and a later lock clears it before the first signature, or the
   * service worker restarts between the start's write and that signature,
   * the engine confirms the first signature's challenge itself once the
   * plan goes on (after the unlock, or the user's Continue). The decision
   * recorded on #188 is that the risk is acknowledged once, at the review,
   * and that the engine confirms later challenges itself in a session the
   * user started or continued; the wallet's own review confirms the
   * challenge before it starts, and Continue shows the recipient and the
   * amount again. A page that started without confirming is the wallet's
   * own page, inside the UI port's trust boundary, so a stored flag for
   * these cases would guard only against that page, at the cost of another
   * stored state and a pause that offers only cancel.
   */
  private async begin(
    draft: PlanDraft,
    written: QbitSendPlanRecord,
    hold: QbitSendPlanHold,
    revision?: PlanRevisionStart
  ): Promise<QbitSendPlanStartResult> {
    if (this.lost(draft.ticket)) {
      return this.loseStart(draft, written.id, revision, written.revision)
    }
    const key = accountKeyOf(draft.chain, draft.account.address)
    const kept = this.drafts.get(key) === draft
    if (kept) this.drafts.delete(key)
    this.timers.clearTimeout(draft.timer)
    const stored = this.store.get(written.id)
    if (!stored || stored.phase === 'cancelling') {
      // Another page's cancel landed after the start wrote the plan and
      // before it was handed over: the cancel stands. Nothing of the start
      // was signed; its draft goes with its batch and challenge, and the
      // plan holds what the cancelled plan needs, or nothing once it is gone.
      const stale = this.sessions.get(written.id)
      if (stale) stale.starting = false
      this.dropDraft(draft)
      await this.holdOnlyWhatIsStored(written.id)
      if (stored) {
        void this.advance(written.id)
        this.ensureTimer()
      }
      return { ok: false, reason: 'draft_expired' }
    }
    const session = this.session(written.id)
    session.hold = hold
    session.adopted = true
    session.restoreConflict = false
    if (draft.pageChallenge && !kept) {
      session.starting = false
      await this.undoUncheckedStart(draft, written.id, revision, written.revision)
      return { ok: false, reason: 'draft_expired' }
    }
    session.authorised = true
    if (session.batch && session.batch.id !== draft.batch.id) {
      this.keyring.releaseP2mrPsbtSigningBatches([session.batch.id])
    }
    session.batch = kept ? draft.batch : undefined
    session.approval = draft.approval
    session.approvalDue = false
    session.pageChallenge = kept ? draft.pageChallenge : undefined
    session.pageChallengeGone = false
    session.restoredFloor = draft.restoredFloor
    session.starting = false
    this.changed(written)
    let firstChecks: Promise<boolean> | undefined
    if (session.pageChallenge) {
      firstChecks = new Promise<boolean>((resolve, reject) => {
        session.firstSigning = { resolve, reject }
      })
    }
    void this.advance(written.id)
    this.ensureTimer()
    if (firstChecks) {
      let passed: boolean
      try {
        passed = await firstChecks
      } catch (error) {
        const ours = revision
          ? await this.undoRevision(draft, written.id, revision, written.revision)
          : await this.undoStart(draft, written.id, written.revision)
        // Something else changed the plan since this start wrote it (a
        // cancel): that stands, and the start answers as one that lost.
        if (!ours || this.lost(draft.ticket)) return { ok: false, reason: 'draft_expired' }
        throw error
      }
      // A reset, or an ending of the account's plans (its wallet was
      // removed), came while the first signature was awaited: that ending
      // stopped the signing and ends the plan with the account's others,
      // and nothing waits for an undo of this start.
      if (this.lost(draft.ticket)) {
        session.undoing = false
        return { ok: false, reason: 'draft_expired' }
      }
      if (!passed && session.pageChallengeGone && this.store.get(written.id)) {
        await this.undoUncheckedStart(draft, written.id, revision, written.revision)
        return { ok: false, reason: 'draft_expired' }
      }
      if (revision) await this.narrowRevisionHolds(written.id, revision)
    }
    const current = this.store.get(written.id) ?? written
    return { ok: true, plan: this.viewOf(current) }
  }

  /**
   * A start that lost to a reset or to an ending of the account's plans (a
   * wallet removal) after it wrote the plan, before handing it over: nothing
   * of it is authorised or signed, and its draft goes. A new plan is
   * removed as an undone start's is (`removeUndone`); a revision stays as
   * written, unauthorised and holding what that record needs, for the
   * ending to end it with the account's other plans (see `endPlansOf`).
   */
  private async loseStart(
    draft: PlanDraft,
    planId: string,
    revision: PlanRevisionStart | undefined,
    wrote: number
  ): Promise<QbitSendPlanStartResult> {
    const session = this.session(planId)
    session.starting = false
    session.authorised = false
    this.dropDraft(draft)
    if (revision) {
      await this.holdOnlyWhatIsStored(planId)
    } else {
      session.removing = wrote
      await this.removeUndone(planId)
    }
    return { ok: false, reason: 'draft_expired' }
  }

  /**
   * Undo a start whose page confirmation can no longer be checked (see
   * `begin`): as `undoStart` or `undoRevision` do for a refused one, but the
   * draft goes too, its batch and challenge released, since its challenge
   * is gone. `wrote` is the revision the start wrote.
   */
  private async undoUncheckedStart(
    draft: PlanDraft,
    planId: string,
    revision: PlanRevisionStart | undefined,
    wrote: number
  ): Promise<void> {
    if (revision) await this.undoRevision(draft, planId, revision, wrote, { keepDraft: false })
    else await this.undoStart(draft, planId, wrote, { keepDraft: false })
  }

  /**
   * The page had not confirmed the restored-floor challenge its review
   * carried: nothing was signed or sent, so the start of a new plan is
   * undone and the draft kept, for the page to confirm and start again.
   * The next start writes the plan under an id of its own: pages heard of
   * this one's revisions, which a plan written afresh under the same id
   * would start again below. With `keepDraft` false the draft goes as well,
   * and its batch with it. Never throws, so the start reports the keyring's
   * refusal: a record that cannot be deleted now is deleted by a later
   * advance (`removeUndone`), and until then the account's plan is open,
   * unauthorised, and holds what it held.
   *
   * Only the very record the start wrote goes: revision `wrote`, which
   * nothing but the start has written, the plan doing nothing more while
   * its start undoes itself (`PlanSession.undoing`). When anything else
   * changed the plan since (a cancel), that stands: nothing is removed, the
   * draft goes, the plan holds what is stored, and this resolves to false;
   * otherwise to true.
   */
  private async undoStart(
    draft: PlanDraft,
    planId: string,
    wrote: number,
    { keepDraft = true }: { keepDraft?: boolean } = {}
  ): Promise<boolean> {
    const session = this.session(planId)
    // The draft's batch stays the draft's while the draft is kept, for the
    // next start; any other batch of the plan goes.
    if (keepDraft && session.batch?.id === draft.batch.id) session.batch = undefined
    this.stopSigning(session)
    session.authorised = false
    session.firstSigning = undefined
    if (this.store.get(planId)?.revision !== wrote) {
      this.dropDraft(draft)
      await this.letChangedPlanStand(planId, session)
      return false
    }
    session.removing = wrote
    if (keepDraft) {
      draft.planId = randomHex(16)
      this.keepDraft(draft)
    } else {
      this.dropDraft(draft)
    }
    return this.removeUndone(planId)
  }

  /**
   * An undo of plan `planId`'s start found the plan changed since the start
   * wrote it, by something other than the start (a cancel, an ending of the
   * account's plans): that stands. The undo is given up, the plan holds
   * what its stored record needs, or nothing once none is stored, and goes
   * on from there.
   */
  private async letChangedPlanStand(planId: string, session: PlanSession): Promise<void> {
    session.removing = undefined
    session.undoing = false
    await this.holdOnlyWhatIsStored(planId)
    if (this.store.get(planId)) {
      void this.advance(planId)
      this.ensureTimer()
    }
  }

  /**
   * Delete plan `planId`, whose start was undone, at the revision that start
   * wrote (`PlanSession.removing`), then let go of what it holds: never the
   * other way round, so a stored plan keeps its holds. Only that very record
   * goes: one anything else changed since (a cancel, an ending of the
   * account's plans) stands, and the removal is given up
   * (`letChangedPlanStand`), resolving to false. A delete that fails
   * otherwise leaves both for the next advance, which tries again, and
   * resolves to true, as does a removal done. Never throws.
   */
  private async removeUndone(planId: string): Promise<boolean> {
    const session = this.session(planId)
    const wrote = session.removing
    try {
      const record = this.store.get(planId)
      if (record) {
        if (record.revision !== wrote) {
          await this.letChangedPlanStand(planId, session)
          return false
        }
        try {
          await this.store.delete(planId, record.revision)
        } catch (error) {
          if (!isStoreConflict(error)) throw error
          // Written meanwhile, or deleted: what is stored now decides.
          if (this.store.get(planId)) {
            await this.letChangedPlanStand(planId, session)
            return false
          }
        }
        this.forget(planId, record.revision)
      }
      await this.guard.releasePlanOutpoints(planId)
      this.dropSession(planId)
      return true
    } catch (error) {
      this.log('Qbit send plan could not remove a plan whose start was undone', error)
      return true
    }
  }

  /**
   * The page had not confirmed the restored-floor challenge a revision's
   * review carried: nothing of the revision was signed or sent, so the plan
   * it replaced is written back as it was (a new revision of the same
   * content), its holds narrow back to what that plan needs, the session
   * is as it was before the swap, and the draft is kept, under the revision
   * written back, for the page to confirm and start again; with `keepDraft`
   * false the draft goes instead, and its batch with it. When the old plan
   * cannot be written back the new one stays stored and unauthorised, its
   * holds narrowed to what it needs: it pauses `interrupted` until the user
   * continues.
   *
   * The old plan is written back only over the very record the start wrote:
   * revision `wrote`, which nothing but the start has written, the plan
   * doing nothing more while its start undoes itself (`PlanSession.undoing`),
   * and the write itself is refused over any newer one. When anything else
   * changed the plan since (a cancel, an ending of the account's plans),
   * that stands: nothing is written back and nothing of the session is
   * restored, its signing still unauthorised; the draft goes, the plan holds
   * what is stored and goes on from there, and this resolves to false;
   * otherwise to true.
   */
  private async undoRevision(
    draft: PlanDraft,
    planId: string,
    revision: PlanRevisionStart,
    wrote: number,
    { keepDraft = true }: { keepDraft?: boolean } = {}
  ): Promise<boolean> {
    const session = this.session(planId)
    session.undoing = true
    // The draft's batch stays the draft's while the draft is kept, for the
    // next start; any other batch of the plan goes.
    if (keepDraft && session.batch?.id === draft.batch.id) session.batch = undefined
    this.stopSigning(session)
    session.authorised = false
    session.firstSigning = undefined
    let restored: QbitSendPlanRecord | undefined
    let replacement: QbitSendPlanRecord | undefined
    const current = this.store.get(planId)
    if (current?.revision !== wrote) {
      this.dropDraft(draft)
      await this.letChangedPlanStand(planId, session)
      return false
    }
    try {
      restored = await this.store.put(revision.replaced, wrote)
      replacement = current
    } catch (error) {
      if (isStoreConflict(error)) {
        this.dropDraft(draft)
        await this.letChangedPlanStand(planId, session)
        return false
      }
      this.log('Qbit send plan could not write back the plan a revision replaced', error)
    }
    if (restored) {
      Object.assign(session, revision.before)
      try {
        await this.syncHolds(restored, replacement)
      } catch (error) {
        this.log('Qbit send plan could not narrow its holds after undoing a revision', error)
      }
      this.changed(restored)
      if (keepDraft) {
        draft.revise = { planId, revision: restored.revision }
        this.keepDraft(draft)
      } else {
        this.dropDraft(draft)
      }
    } else {
      this.dropDraft(draft)
      // No undo is possible any more: the stored plan holds what it needs.
      await this.narrowRevisionHolds(planId, revision)
    }
    session.undoing = false
    void this.advance(planId)
    this.ensureTimer()
    return true
  }

  /**
   * Keep `draft` after a start that was undone: the page confirms the same
   * challenge and starts the same draft again, until the draft expires. A
   * draft whose start lost to a reset or to an ending of the account's
   * plans goes instead.
   */
  private keepDraft(draft: PlanDraft): void {
    if (this.lost(draft.ticket)) {
      this.dropDraft(draft)
      return
    }
    const key = accountKeyOf(draft.chain, draft.account.address)
    this.drafts.set(key, draft)
    draft.timer = this.timers.setTimeout(
      () => {
        if (this.drafts.get(key) === draft) this.dropDraft(draft)
      },
      Math.max(0, draft.expiresAt - this.now())
    )
  }

  // -- page actions ---------------------------------------------------------

  /**
   * The selected account's plan on the active network, or what cannot be
   * read of it; nudges the engine. Nothing while the wallet is being reset
   * (`halt`).
   */
  async view(): Promise<QbitSendPlanView | null> {
    if (this.halted()) return null
    const chain = this.host.activeChain()
    const account = this.host.currentAccount()
    if (!account) return null
    const unreadable = this.unreadableFor(chain, account.address)
    if (unreadable) return this.unreadableView(unreadable, chain, account.address)
    const record = this.store.findOpen(chain, account.address)
    if (!record) return null
    const session = this.session(record.id)
    if (!session.adopted) await this.adopt(record.id)
    void this.advance(record.id)
    const current = this.store.get(record.id)
    return current ? this.viewOf(current) : null
  }

  /**
   * Re-authorise signing for this session and carry on with the plan as
   * confirmed. The plan is advanced by nothing while the resumed record is
   * written (`PlanSession.continuing`), and its signing is authorised
   * before anything advances it again, so no advance in between (a page's
   * read, the timer, a rerun) finds it signing unauthorised and pauses it.
   *
   * The continue approves the signatures the plan may still need as they
   * stand: their figures are read at its next advance, before anything else
   * (`readApproval`), whatever it resumes into, signing or waiting for its
   * merges or sending its payment. Every signing later in the session
   * continues them, as after a start, so a signature another request makes
   * with the key after them waits for the user's next continue.
   *
   * A continue that loses to a reset or to an ending of the account's plans
   * (a wallet removal) authorises nothing, and throws: what it wrote is that
   * ending's to end, which waits for it (see `endPlansOf`).
   *
   * Only the user at the unlocked wallet authorises signing. The UI port
   * carries no proof of the password, so a page left open on a locked
   * wallet, or any other caller, could otherwise approve a plan whose record
   * changed on disk, for the owner's next unlock to sign it unseen: a
   * continue while the wallet is locked is refused before anything is read
   * or written, whatever the plan paused for, and none is offered then
   * (`actionsOf`). A continue made while unlocked whose figures a lock kept
   * from being read has them read after the unlock (`readApproval`).
   */
  async continue(planId: unknown): Promise<QbitSendPlanView> {
    const record = this.ownPlan(planId)
    if (!this.host.isUnlocked()) {
      throw new Error('The Qbit send plan cannot continue while the wallet is locked')
    }
    const ticket = this.ticketFor(record.chain, record.account.address)
    if (!ticket) throw new Error('The Qbit send plan is not open')
    const work = this.continuePlan(record, ticket)
    this.trackContinue(ticket.account, work)
    return work
  }

  private async continuePlan(
    record: QbitSendPlanRecord,
    ticket: WorkTicket
  ): Promise<QbitSendPlanView> {
    const session = this.session(record.id)
    if (!session.adopted) await this.adopt(record.id)
    if (this.lost(ticket)) throw new Error('The Qbit send plan is not open')
    let resumed = false
    let lost = false
    let outcome: Awaited<ReturnType<QbitSendPlanEngine['mutate']>>
    session.continuing += 1
    try {
      outcome = await this.mutate(record.id, current => {
        resumed = false
        // Offered only while the wallet is unlocked: a lock since the call
        // refuses it, as a continue while locked is.
        if (!actionsOf(current, this.host.isUnlocked()).includes('continue')) return undefined
        resumed = true
        const reason = pauseReasonOf(current)
        const next: QbitSendPlanRecordInput = { ...current, phase: resumedPhase(current) }
        delete next.pause
        if (reason === 'payment_refused' || reason === 'payment_fee_too_low') {
          next.phase = 'sending'
        }
        return next
      })
      // Resumed only when the resumed record was written, and for an
      // account whose plans stand.
      if (outcome.record === undefined) resumed = false
      if (this.lost(ticket)) {
        lost = true
        resumed = false
      }
      if (resumed) {
        session.authorised = true
        // The user's continue approves the signatures left to make, as they
        // stand: the figures are read before the plan does anything else,
        // and a batch opens for them when a signature is due.
        if (session.batch) this.keyring.releaseP2mrPsbtSigningBatches([session.batch.id])
        session.batch = undefined
        session.approval = undefined
        session.approvalDue = true
        session.notSent.clear()
      }
    } finally {
      session.continuing -= 1
      // Whatever became of this continue, the plan is advanced once none is
      // writing it: an advance that made way for continues (see `run`) may
      // owe a start its first signing.
      if (session.continuing === 0) void this.advance(record.id)
    }
    if (lost) throw new Error('The Qbit send plan is not open')
    if (!resumed) throw new Error('The Qbit send plan cannot continue now')
    this.ensureTimer()
    const current = outcome.record ?? this.store.get(record.id)
    if (!current) throw new Error('The Qbit send plan is not open')
    return this.viewOf(current)
  }

  /**
   * Cancel the plan before its payment may be in the network: signing
   * stops, the stored signed payment goes, and everything settled is let go
   * of (the inputs of merges never sent; inputs and outputs of merges sent,
   * which simply stay in the account as fewer, larger outputs). A merge
   * whose outcome is unknown keeps its inputs held, and the plan stays
   * `cancelling`, until a lookup finds it or proves it absent, or the
   * backstop (`QBIT_SEND_PLAN_CANCEL_BACKSTOP_MS`) passes; then the record
   * goes. Resolves to the plan as it is now, or null once nothing is left
   * of it. A plan whose payment may be in the network, or a version of whose
   * payment may still confirm (`paymentVersionMayConfirm`), is not
   * cancelled: it comes back as it was, nothing of it changed, its holds
   * included; but one that failed the checks of what its transactions are
   * is, whatever its payment's state, under the same rules, since nothing
   * else ends it (`cancellable`). An unreadable stored
   * plan is dropped from storage, the one entry its account was shown (a
   * document of another version, shown to every account, goes whole): what
   * it held cannot be read, so it held nothing. An entry that only the one
   * dropped made unreadable reads as its plan again, and is taken up as a
   * restart takes up a stored plan (`takeUpMadeReadable`).
   */
  async cancel(planId: unknown): Promise<QbitSendPlanView | null> {
    if (this.halted()) throw new Error('The Qbit send plan is not open')
    const chain = this.host.activeChain()
    const account = this.host.currentAccount()
    const unreadable = account ? this.unreadableFor(chain, account.address) : undefined
    if (unreadable && account) {
      const view = this.unreadableView(unreadable, chain, account.address)
      if (planId === view.id) {
        // The entry shown to this account and nothing else; a document of
        // another version is shown to every account, and goes whole.
        await this.discardUnreadable(
          'key' in unreadable ? { key: unreadable.key } : { document: true }
        )
        this.host.announce(view.id, view.revision + 1)
        return null
      }
    }
    const record = this.ownPlan(planId)
    const session = this.session(record.id)
    // Counted before anything is awaited: from here no merge leaves until
    // this cancel has written the plan (see `PlanSession.cancels`).
    session.cancels += 1
    try {
      if (!session.adopted) await this.adopt(record.id)
      if (!cancellable(record)) return this.viewOf(record)
      this.stopSigning(session)
      session.authorised = false
      const outcome = await this.mutate(record.id, current => {
        if (!cancellable(current) || current.phase === 'cancelling') return undefined
        const unknown =
          mergesOf(current).some(merge => merge.status === 'unknown') ||
          (current.carried ?? []).some(item => item.status === 'unknown')
        if (!unknown) return 'delete'
        const payment = paymentOf(current)
        const next = withStep(current, payment.txid, step => stepWithStatus(step, 'planned'))
        next.phase = 'cancelling'
        // A plan that failed its checks keeps saying so while it cancels.
        if (!failedItsChecks(current)) delete next.pause
        return withExtra(next, { cancelledAt: this.now() })
      })
      session.authorised = false
      if (outcome.deleted) return null
      this.ensureTimer()
      void this.advance(record.id)
      const current = outcome.record ?? outcome.unchanged ?? this.store.get(record.id)
      return current ? this.viewOf(current) : null
    } finally {
      session.cancels -= 1
    }
  }

  /**
   * A wallet was removed: end every plan of the accounts that belonged to
   * it alone (those it signed for and no wallet that stays signs for),
   * `accounts` naming each by network and address, as a cancel ends one,
   * whether or not it is the selected account's. Its drafts go; signing
   * stops and is no longer authorised; and nothing more is signed or
   * broadcast for it. A plan before its payment may be in the network is
   * cancelled: its record goes with its stored signed payment and its holds,
   * unless a merge's outcome is unknown, when it cancels (`cancelling`)
   * until that merge is found or proven absent, holding only that merge's
   * inputs, and nothing of it is signed or sent meanwhile. A plan whose
   * payment may already be in the network, a version of whose payment may
   * still confirm (`paymentVersionMayConfirm`), or that completed, cannot be
   * un-sent: its record and its holds go all the same, there being no
   * wallet left to follow it for, and it is named in `mayHaveBeenSent`. An
   * entry the store cannot read, filed under one of the accounts, goes too
   * (a document of another version, which may hold any account's plan,
   * stays); an entry that only such an entry made unreadable reads as its
   * plan again, and is ended here when it is one of the accounts', and goes
   * on, held again, when it is not (`takeUpMadeReadable`). Never throws: a
   * plan that cannot be ended now is logged and left as it was.
   *
   * Work under way for the accounts settles first, and none begins until
   * this resolves (see `lost`): a prepare keeps no draft; a start answers
   * `draft_expired`, its hold let go of, and a new plan it wrote removed
   * (`loseStart`); a continue authorises nothing and throws. A revision or
   * a continue that wrote the plan leaves it to be ended here with the
   * others, and an advance broadcasts nothing more for them (`mayBroadcast`).
   * So when this resolves, no plan of the accounts is stored, held,
   * authorised or about to be written, beyond what a cancel keeps: the
   * inputs of a merge of unknown outcome, until it is found or proven absent.
   */
  async endPlansOf(
    accounts: readonly { chain: ChainType; address: string }[]
  ): Promise<{ ended: string[]; mayHaveBeenSent: string[] }> {
    const owned = new Set(accounts.map(item => accountKeyOf(item.chain, item.address)))
    for (const account of owned) {
      const ending = this.endings.get(account) ?? { count: 0, underWay: 0 }
      ending.count += 1
      ending.underWay += 1
      this.endings.set(account, ending)
    }
    try {
      for (const draft of [...this.drafts.values()]) {
        if (owned.has(accountKeyOf(draft.chain, draft.account.address))) this.dropDraft(draft)
      }
      // Nothing of the accounts signs any more, whatever it awaits now.
      this.stopSigningOf(owned)
      await this.settleWorkOf(owned)
      return await this.endStoredPlansOf(owned)
    } finally {
      for (const account of owned) {
        const ending = this.endings.get(account)
        if (ending) ending.underWay -= 1
      }
    }
  }

  /** Stop the signing of every stored plan of the `owned` accounts, and authorise none. */
  private stopSigningOf(owned: ReadonlySet<string>): void {
    let records: QbitSendPlanRecord[]
    try {
      records = this.store.list()
    } catch {
      return
    }
    for (const record of records) {
      if (!owned.has(accountKeyOf(record.chain, record.account.address))) continue
      const session = this.sessions.get(record.id)
      if (!session) continue
      this.stopSigning(session)
      session.authorised = false
    }
  }

  /**
   * Resolves once no start and no continue of the `owned` accounts is under
   * way: none begins while their plans are being ended (`ticketFor`).
   */
  private async settleWorkOf(owned: ReadonlySet<string>): Promise<void> {
    for (;;) {
      const work: Promise<unknown>[] = []
      for (const [account, start] of this.starts) {
        if (owned.has(account)) work.push(start.result)
      }
      for (const [account, continues] of this.continues) {
        if (owned.has(account)) work.push(...continues)
      }
      if (work.length === 0) return
      await Promise.allSettled(work)
    }
  }

  /**
   * End every stored plan of the `owned` accounts, as `endPlansOf` says.
   * The entries the store cannot read go first, the store read again after
   * each: dropping one can make another readable, and one of the accounts
   * made readable so is among the plans read once none of their entries is
   * left unreadable, and is ended with them.
   */
  private async endStoredPlansOf(
    owned: ReadonlySet<string>
  ): Promise<{ ended: string[]; mayHaveBeenSent: string[] }> {
    const ended: string[] = []
    const mayHaveBeenSent: string[] = []
    let records: QbitSendPlanRecord[]
    try {
      const discarded = new Set<string>()
      for (;;) {
        const entry = this.store
          .unreadable()
          .plans.find(
            item =>
              item.chain !== undefined &&
              item.address !== undefined &&
              owned.has(accountKeyOf(item.chain, item.address)) &&
              !discarded.has(item.key)
          )
        if (!entry) break
        discarded.add(entry.key)
        await this.discardUnreadable({ key: entry.key })
        this.host.announce(
          entry.id ?? QBIT_SEND_PLAN_UNREADABLE_ID,
          QBIT_SEND_PLAN_VIEW_REVISION_STRIDE
        )
      }
      records = this.store.list()
    } catch (error) {
      this.log('Qbit send plans of a removed wallet could not be read', error)
      return { ended, mayHaveBeenSent }
    }
    for (const record of records) {
      if (!owned.has(accountKeyOf(record.chain, record.account.address))) continue
      try {
        const session = this.session(record.id)
        this.stopSigning(session)
        session.authorised = false
        let sent = false
        const outcome = await this.mutate(record.id, current => {
          sent =
            current.phase === 'completed' ||
            paymentMayBeSent(current) ||
            paymentVersionMayConfirm(current)
          if (sent) return 'delete'
          if (current.phase === 'cancelling') return undefined
          const unknown =
            mergesOf(current).some(merge => merge.status === 'unknown') ||
            (current.carried ?? []).some(item => item.status === 'unknown')
          if (!unknown) return 'delete'
          const next = withStep(current, paymentOf(current).txid, step =>
            stepWithStatus(step, 'planned')
          )
          next.phase = 'cancelling'
          if (!failedItsChecks(current)) delete next.pause
          return withExtra(next, { cancelledAt: this.now() })
        })
        // Whatever the mutation found, no signing resumes for the plan.
        const left = this.sessions.get(record.id)
        if (left) left.authorised = false
        ended.push(record.id)
        if (sent) mayHaveBeenSent.push(record.id)
        if (!outcome.deleted) {
          void this.advance(record.id)
          this.ensureTimer()
        }
      } catch (error) {
        this.log('A Qbit send plan of a removed wallet could not be ended', error)
      }
    }
    return { ended, mayHaveBeenSent }
  }

  /** Remove a completed plan. */
  async dismiss(planId: unknown): Promise<void> {
    if (this.halted()) throw new Error('The Qbit send plan is not open')
    const record = this.ownPlan(planId)
    let refused = false
    await this.mutate(record.id, current => {
      refused = false
      if (current.phase !== 'completed') {
        refused = true
        return undefined
      }
      return 'delete'
    })
    if (refused) throw new Error('Only a completed Qbit send plan can be dismissed')
  }

  /** The stored plan `planId`, when it is the selected account's on the active network; throws otherwise. */
  private ownPlan(planId: unknown): QbitSendPlanRecord {
    const record = typeof planId === 'string' ? this.store.get(planId) : undefined
    const account = this.host.currentAccount()
    if (
      !record ||
      !account ||
      record.chain !== this.host.activeChain() ||
      record.account.address !== account.address
    ) {
      throw new Error('The Qbit send plan is not open')
    }
    return record
  }

  // -- unreadable plans -----------------------------------------------------

  /**
   * Drop what the store cannot read (`QbitSendPlanStore.discardUnreadable`),
   * and take up every plan that dropping it made readable
   * (`takeUpMadeReadable`). Every discard of the engine goes through here.
   * Resolves to how many entries went.
   */
  private async discardUnreadable(target: { key: string } | { document: true }): Promise<number> {
    const { dropped, madeReadable } = await this.store.discardUnreadable(target)
    if (madeReadable.length > 0) {
      await this.takeUpMadeReadable(madeReadable.map(record => record.id))
    }
    return dropped
  }

  /**
   * Take up plans `planIds`, which a discard made readable, as a restart
   * takes up the stored plans, and no further. Each held nothing while it
   * could not be read: before anything else its outputs are held again
   * through the guard's restore, under `restore`'s conflict rule
   * (`keepRestoration`), so it pauses `outputs_spent` when something else
   * holds them or spent them. Its session authorises no signing: nothing of
   * it is signed until a continue made while unlocked, its first advance or
   * read adopts it (`adopt`), and a payment it stored signed goes out by the
   * rules every plan's does. Every page hears of it, at a revision above
   * any view of it shown before: the stand-in it was shown as, or a view
   * from before a restart, its record's revision being stored. And it
   * advances as a plan found at start-up does, unless its account's plans
   * are being ended, whose ending ends it (`endStoredPlansOf`).
   *
   * Nothing is held or advanced while the wallet is being reset: `resume`
   * holds again what is stored once the reset is over. A reset that begins
   * while this holds waits for it (`halt`), and it lets go of what it held.
   * A failure is logged, the discard standing: such a plan takes its hold
   * at its first advance (`ensureHold`).
   */
  private takeUpMadeReadable(planIds: readonly string[]): Promise<void> {
    const work = this.holdMadeReadable(planIds).catch((error: unknown) => {
      this.log('Qbit send plans made readable could not be held again', error)
    })
    this.takingUp.add(work)
    void work.then(() => this.takingUp.delete(work))
    return work
  }

  /** The work of `takeUpMadeReadable`. */
  private async holdMadeReadable(planIds: readonly string[]): Promise<void> {
    if (this.halted()) return
    const generation = this.generation
    const ids = new Set(planIds)
    // Read and handed to the guard in one step, as `restore` does: a write
    // of these plans that lands later lets go of holds after these are taken.
    const holds = this.store.planHolds().filter(entry => ids.has(entry.planId))
    if (holds.length === 0) return
    const restoration = await this.guard.restorePlanHolds(holds)
    if (this.halted()) {
      for (const entry of holds) {
        await this.guard.releasePlanOutpoints(entry.planId, entry.outpoints)
      }
      return
    }
    if (generation !== this.generation) return
    // A plan deleted meanwhile let go of its hold after this took it.
    const stored = (planId: string): boolean => this.store.get(planId) !== undefined
    this.keepRestoration({
      ...restoration,
      holds: new Map([...restoration.holds].filter(([planId]) => stored(planId))),
      conflicts: restoration.conflicts.filter(({ planId }) => stored(planId)),
    })
    const chain = this.host.activeChain()
    for (const { planId } of holds) {
      const record = this.store.get(planId)
      if (!record) continue
      this.host.announce(planId, (record.revision + 1) * QBIT_SEND_PLAN_VIEW_REVISION_STRIDE)
      const ending = this.endings.get(accountKeyOf(record.chain, record.account.address))
      if (this.started && record.chain === chain && !(ending && ending.underWay > 0)) {
        void this.advance(planId)
      }
    }
    this.ensureTimer()
  }

  /**
   * What the store cannot read for `address` on `chain`: an entry filed
   * under that account, or the whole document (another version), which
   * every account is shown, since it may hold any account's plan.
   */
  private unreadableFor(
    chain: ChainType,
    address: string
  ): QbitSendPlanUnreadable | { document: true } | undefined {
    const unreadable = this.store.unreadable()
    if (unreadable.document) return { document: true }
    return unreadable.plans.find(plan => plan.chain === chain && plan.address === address)
  }

  /**
   * A stored plan this version cannot read, as its account is shown it:
   * paused `unreadable`, with only `cancel`, which drops it from storage.
   * Its outputs are not held, since what it would hold cannot be read.
   */
  private unreadableView(
    unreadable: QbitSendPlanUnreadable | { document: true },
    chain: ChainType,
    address: string
  ): QbitSendPlanView {
    const id = 'id' in unreadable && unreadable.id ? unreadable.id : QBIT_SEND_PLAN_UNREADABLE_ID
    return {
      id,
      chain,
      address,
      recipient: '',
      target: 'amount',
      amount: 0,
      change: 0,
      feeRate: 0,
      totalFee: 0,
      steps: [],
      sent: false,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
      signaturesDone: 0,
      signaturesTotal: 0,
      paymentTxid: '',
      createdAt: 0,
      updatedAt: 0,
      revision: 1,
    }
  }

  // -- the loop -------------------------------------------------------------

  /**
   * Advance plan `planId` as far as it can go now. One runs per plan at a
   * time; a call while one runs makes it run once more when it ends. None
   * runs while the wallet is being reset (`halt`).
   */
  advance(planId: string): Promise<void> {
    if (this.halted()) return Promise.resolve()
    const session = this.session(planId)
    if (session.running) {
      session.rerun = true
      return session.running
    }
    const running = (async (): Promise<void> => {
      let madeWay = false
      try {
        do {
          session.rerun = false
          madeWay = await this.run(planId)
        } while (session.rerun)
      } finally {
        session.running = undefined
        // A start waiting on this plan's first signing waits no longer: the
        // advance that would have made it is over. One that only made way
        // for a continue writing the plan is not that advance: the
        // continue's end advances the plan again (see `continue`).
        if (!madeWay) this.firstSigningFailed(session, undefined)
        this.settleSession(planId)
        this.ensureTimer()
      }
    })()
    session.running = running
    return running
  }

  private kickAll(): void {
    if (this.halted()) return
    let plans: QbitSendPlanRecord[]
    try {
      plans = this.store.list()
    } catch {
      return
    }
    const chain = this.host.activeChain()
    for (const record of plans) {
      if (record.chain === chain) void this.advance(record.id)
    }
    this.ensureTimer()
  }

  /**
   * Keep the timer running while a plan is signing, waiting, sending or
   * cancelling, or is paused while its payment may be in the network (see
   * `reconcilePayment`) or a version of it that left the wallet without a
   * verdict may still confirm (`paymentVersionMayConfirm`, see
   * `stepPaused`), and stop it once none is. A tick advances such a plan as
   * a page's read does, so with every page closed it completes once a
   * version is found, or forgets the versions once none can confirm. A plan
   * that failed the checks of what its transactions are keeps no timer for
   * its versions: nothing completes it from its record.
   */
  private ensureTimer(): void {
    if (!this.started || this.halted()) return
    let active: boolean
    try {
      active = this.store
        .list()
        .some(
          record =>
            ['signing', 'waiting', 'sending', 'cancelling'].includes(record.phase) ||
            (record.phase === 'paused' &&
              (paymentMayBeSent(record) ||
                (paymentVersionMayConfirm(record) && !failedItsChecks(record))))
        )
    } catch {
      return
    }
    if (!active) {
      if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
      this.timer = undefined
      return
    }
    if (this.timer !== undefined) return
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      this.kickAll()
    }, QBIT_SEND_PLAN_TICK_MS)
  }

  /**
   * One pass of `advance`. Resolves to whether it stopped only to make way
   * for a continue that is writing the plan (`PlanSession.continuing`).
   */
  private async run(planId: string): Promise<boolean> {
    const generation = this.generation
    for (let iteration = 0; iteration < QBIT_SEND_PLAN_MAX_ITERATIONS; iteration++) {
      if (this.generation !== generation) return false
      const record = this.store.get(planId)
      if (!record) return false
      if (record.chain !== this.host.activeChain()) {
        // A continue's figures are read on the plan's network only: the key
        // may sign on another before the plan is back (see `onUnlock`).
        const left = this.sessions.get(planId)
        if (left) left.approvalDue = false
        return false
      }
      const session = this.session(planId)
      if (session.removing !== undefined) {
        await this.removeUndone(planId)
        return false
      }
      if (session.undoing || session.starting) return false
      if (session.continuing > 0) return true
      let outcome: StepOutcome
      try {
        if (session.ticks >= QBIT_SEND_PLAN_VIEW_REVISION_STRIDE / 2) {
          // Never reached in practice, since writes come far more often;
          // a write keeps the view's revision within its stride.
          await this.mutate(planId, current => ({ ...current }))
          continue
        }
        if (!session.adopted) {
          await this.adopt(planId)
          continue
        }
        if (session.restoreConflict) {
          await this.pause(planId, 'outputs_spent')
          session.restoreConflict = false
          continue
        }
        // What a continue approved is read before the plan does anything
        // else, and so before it can sign.
        if (session.approvalDue && session.authorised && this.host.isUnlocked()) {
          await this.readApproval(record, session)
          continue
        }
        await this.ensureHold(record, session)
        outcome = await this.step(record, session)
      } catch (error) {
        if (isStoreConflict(error)) continue
        this.log('Qbit send plan advance failed', error)
        return false
      }
      if (outcome === 'idle') return false
    }
    return false
  }

  private async step(record: QbitSendPlanRecord, session: PlanSession): Promise<StepOutcome> {
    // A payment that may be in the network is looked up whatever the plan
    // is doing: sending looks it up itself, and a completed plan's is the
    // completion's to follow.
    if (
      paymentMayBeSent(record) &&
      record.phase !== 'sending' &&
      record.phase !== 'completed' &&
      (await this.reconcilePayment(record, session))
    ) {
      return 'again'
    }
    switch (record.phase) {
      case 'signing':
        return this.stepSigning(record, session)
      case 'waiting':
        return this.stepWaiting(record, session)
      case 'sending':
        return this.stepSending(record, session)
      case 'paused':
        return this.stepPaused(record, session)
      case 'cancelling':
        return this.stepCancelling(record, session)
      case 'completed':
        return this.stepCompleted(record, session)
    }
  }

  /**
   * The plan's hold, which a restart restores and every spend presents. A
   * plan without one (never restored) takes it again, and pauses
   * `outputs_spent` when something else holds its outputs now.
   */
  private async ensureHold(record: QbitSendPlanRecord, session: PlanSession): Promise<void> {
    if (session.hold !== undefined || record.phase === 'completed') return
    const desired = desiredHolds(record)
    if (desired.size === 0) return
    const outpoints = qbitSendPlanOutpoints(record).filter(outpoint =>
      desired.has(outpointKey(outpoint))
    )
    const unique = [
      ...new Map(outpoints.map(outpoint => [outpointKey(outpoint), outpoint])).values(),
    ]
    try {
      session.hold = await this.guard.holdOutpointsForPlan({
        planId: record.id,
        chain: record.chain,
        address: record.account.address,
        outpoints: unique,
      })
    } catch (error) {
      if (!(error instanceof QbitSendPlanHoldConflictError)) throw error
      session.restoreConflict = true
      throw error
    }
  }

  /**
   * The first time this session touches a stored plan: write it once, so
   * its view's revision passes any shown before a restart, and decide what
   * a restart left: a plan that needs a signature waits for continue
   * (paused `interrupted`), and the holds narrow to what it needs now.
   */
  private async adopt(planId: string): Promise<void> {
    const session = this.session(planId)
    // A plan a start is writing is the start's to hand over (see `begin`).
    if (session.adopted || session.starting) return
    const outcome = await this.mutate(planId, record => {
      const next: QbitSendPlanRecordInput = { ...record }
      // A restart lost every signed merge, so a merge or payment not signed
      // into the record needs a signature; one whose outcome is unknown is
      // looked up first and signed again only once proven absent.
      const signingWanted =
        record.phase === 'signing' ||
        (record.phase === 'paused' && record.pause?.reason === 'locked') ||
        ((record.phase === 'waiting' || record.phase === 'sending') &&
          (paymentOf(record).status === 'planned' ||
            mergesOf(record).some(merge => merge.status === 'planned')))
      if (!session.authorised && signingWanted) {
        next.phase = 'paused'
        next.pause = { reason: 'interrupted', at: this.now() }
      }
      return next
    })
    session.adopted = outcome.record !== undefined || outcome.deleted === true
  }

  // -- signing ------------------------------------------------------------

  /**
   * Whether a signature may be made now: the wallet is unlocked and this
   * session is authorised to sign. Otherwise the plan pauses, `locked` or
   * `interrupted`, and the auto-lock is held while it may.
   */
  private async maySign(record: QbitSendPlanRecord, session: PlanSession): Promise<boolean> {
    // A run that a reset, a removal or a deletion left behind, resumed from
    // an await, signs nothing, writes nothing and holds nothing: the session
    // that authorised it is no longer the plan's.
    if (!this.sessionStands(record.id, session)) return false
    if (this.undoAwaited(session)) return false
    if (!this.host.isUnlocked()) {
      await this.pause(record.id, 'locked')
      return false
    }
    if (!session.authorised) {
      await this.pause(record.id, 'interrupted')
      return false
    }
    this.beginAutoLockHold(record, session)
    return true
  }

  private async stepSigning(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<StepOutcome> {
    // Only merges proven absent (`planned`) are signed or sent here. One
    // whose broadcast had no verdict does not hold up the others: it is
    // looked up while the plan waits, and is never sent blindly again. A
    // merge signed already goes out again without a key.
    const now = this.now()
    if (!paymentMayBeSent(record) && mergesOf(record).some(isVoid)) {
      await this.pause(record.id, 'merge_refused')
      return 'again'
    }
    let waitingForResend = false
    for (const [index, merge] of mergesOf(record).entries()) {
      if (merge.status !== 'planned') continue
      const notSent = session.notSent.get(merge.txid)
      if (notSent && notSent.nextAt > now) {
        waitingForResend = true
        continue
      }
      let rawtx = session.signedMerges.get(merge.txid)
      if (rawtx === undefined) {
        // A replacement is signed only while the version it replaces has
        // not confirmed instead: those signatures would be void.
        if (await this.reconcileReplaced(record, session, merge)) return 'again'
        if (!(await this.maySign(record, session))) return 'again'
        rawtx = await this.signMerge(record, session, index)
        if (rawtx === undefined) return 'again'
      }
      await this.sendMerge(record.id, session, merge.txid, rawtx)
      return 'again'
    }
    if (waitingForResend) return 'idle'
    const payment = paymentOf(record)
    if (payment.status === 'planned') {
      if (!(await this.maySign(record, session))) return 'again'
      const signed = await this.signPayment(record, session)
      if (signed === undefined) return 'again'
      await this.mutate(record.id, current => {
        if (current.phase !== 'signing' || paymentOf(current).status !== 'planned') return undefined
        const next = withStep(current, payment.txid, step => stepWithStatus(step, 'signed', signed))
        next.phase = 'waiting'
        return next
      })
      this.endSigningSegment(session)
      return 'again'
    }
    await this.mutate(record.id, current =>
      current.phase === 'signing' ? { ...current, phase: resumedPhase(current) } : undefined
    )
    this.endSigningSegment(session)
    return 'again'
  }

  /** Sign merge `index`; its raw bytes, or nothing when the plan paused or moved on. */
  private async signMerge(
    record: QbitSendPlanRecord,
    session: PlanSession,
    index: number
  ): Promise<string | undefined> {
    const signed = await this.signStep(record, session, index)
    if (!signed) return undefined
    session.signedMerges.set(at(record.steps, index).txid, signed.rawtx)
    return signed.rawtx
  }

  /** Sign the payment; its finalized PSBT, or nothing when the plan paused or moved on. */
  private async signPayment(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<string | undefined> {
    const signed = await this.signStep(record, session, record.steps.length - 1)
    return signed?.finalizedHex
  }

  /**
   * Sign step `index` of `record` through the keyring, under the plan's
   * signature batch, after checking its stored PSBT is the step's
   * transaction, priced as the wallet prices one (`checkQbitSendPlanStepPsbt`),
   * and that the plan's hold admits its inputs. Resolves to the finalized
   * PSBT and raw bytes, or to nothing when it did not sign: the plan then
   * paused (`unreadable` when the stored step fails that check, which leaves
   * only a cancel; `locked` on a lock; `interrupted` for anything else), was
   * cancelled, or, for a start whose restored-floor confirmation is
   * missing, is undone by `start`. Whatever it awaits before the
   * signature (the overlap check, a batch reopened, a challenge) is
   * followed by `assertSigningStands`, so a cancel, a lock, a revision's
   * swap, a reset or another network in between stops it before the
   * keyring takes a unit.
   *
   * Restored-floor keys. The page confirms one challenge, for the plan's
   * first signature, before start: that is the user's acknowledgement of
   * the risk, made once for the whole plan they reviewed, as the recovery
   * migration's review is acknowledged once and its screen then confirms
   * each plan's challenge in turn. The engine confirms the challenge of
   * each later signature itself, and only then: for a transaction that is a
   * step of the stored plan the user confirmed, in a session authorised by
   * start or continue (never after a restart without continue, never while
   * locked), one challenge at a time, issued immediately before its
   * signature and released when that signing fails or stops. Signing still
   * goes through the batch's approved figures: a budget that no longer
   * matches pauses the plan, and nothing re-approves different figures.
   */
  private async signStep(
    record: QbitSendPlanRecord,
    session: PlanSession,
    index: number
  ): Promise<{ finalizedHex: string; rawtx: string } | undefined> {
    const step = at(record.steps, index)
    const address = record.account.address
    const keys = qbitSendPlanAccountKeys(record.account.pubkey)
    const txidOf = (psbt: Psbt): string => this.host.txidOf(psbt, record.chain)
    let psbt: Psbt
    try {
      psbt = qbitSendPlanPsbtFromHex(step.unsignedPsbtHex)
      checkQbitSendPlanStepPsbt(psbt, qbitSendPlanStepExpectation(record, step), keys, txidOf)
    } catch (error) {
      // The stored step is not the transaction its record states, or not
      // priced as the wallet prices one: the record is no plan this wallet
      // made, so nothing of it is signed, and it waits for its cancel.
      this.firstSigningFailed(session, undefined)
      await this.pause(record.id, 'unreadable', errorDetail(error))
      return undefined
    }
    // Registered before anything is awaited: from here on a cancel, a lock,
    // a revision's swap or a reset stops this signing wherever it waits.
    const locksBefore = this.host.lockCount()
    const stop = new AbortController()
    session.stop = stop
    let challenge: PageChallenge['risk'] | undefined
    let ownChallenge: string | undefined
    // Whether `challenge` is the one the page confirmed.
    let fromPage = false
    // The approval this signing counts against, even when a revision has
    // replaced the session's by the time it ends.
    let approval: PlanApproval | undefined
    // The keyring's last report of this signing: what it took so far.
    let progress: { signed: number; cached: number } | undefined
    try {
      const held = desiredHolds(record)
      const presented = step.inputs.every(input => held.has(outpointKey(input)))
        ? session.hold
        : undefined
      await this.guard.assertNoOverlap(
        record.chain,
        step.inputs.map(input => ({ txid: input.txid, vout: input.vout })),
        step.txid,
        presented,
        presented ? replacementOf(step) : undefined
      )
      this.assertSigningStands(record, session, step, stop, locksBefore)
      if (!session.batch?.entries.has(step.txid)) {
        await this.reopenBatch(record, session, stop.signal)
        this.assertSigningStands(record, session, step, stop, locksBefore)
      }
      const batch = session.batch
      const entry = batch?.entries.get(step.txid)
      if (!batch || !entry) throw new Error('The signature batch lost this transaction')
      approval = session.approval
      const signingKeys = qbitSendPlanSigningKeys(psbt, keys)
      if (session.pageChallenge && session.pageChallenge.stepTxid === step.txid) {
        challenge = session.pageChallenge.risk
        fromPage = true
        session.pageChallenge = undefined
      } else if (session.restoredFloor) {
        const fresh = await this.keyring.preflightP2mrPsbtSigning(address, {
          psbt,
          keys: signingKeys,
        })
        if (fresh.restoredFloorRisk) {
          ownChallenge = fresh.restoredFloorRisk.challengeId
          this.assertSigningStands(record, session, step, stop, locksBefore)
          await this.keyring.confirmQbitRestoredFloorSigning(ownChallenge)
          challenge = fresh.restoredFloorRisk
        }
      }
      this.assertSigningStands(record, session, step, stop, locksBefore)
      const result = await this.keyring.signP2mrPsbtWithCounter(
        address,
        { psbt, keys: signingKeys },
        { ...entry.budget, ...(challenge ? { restoredFloorRisk: challenge } : {}) },
        { id: batch.id, index: entry.index },
        {
          onProgress: (signed, total, cached) => {
            progress = { signed, cached }
            // The wallet left the plan's network: the signing stops before
            // its next signature, and goes on when the network is back.
            if (this.host.activeChain() !== record.chain) stop.abort()
            if (signed === 0) this.firstSigningPassed(session)
            session.signing = { step: index, signed, total }
            session.reached.set(step.txid, Math.max(session.reached.get(step.txid) ?? 0, signed))
            this.refreshView(record.id)
          },
          signal: stop.signal,
        }
      )
      ownChallenge = undefined
      // Every input this signing signed anew took a unit.
      progress = undefined
      if (approval) approval.spent += result.counterResults.filter(item => !item.cached).length
      session.reached.set(step.txid, step.inputs.length)
      session.signing = undefined
      await this.host.afterSigning(address).catch(() => undefined)
      const { finalized, rawtx } = qbitSendPlanSignedTransaction(result.psbt)
      if (txidOf(finalized) !== step.txid) throw new Error('Signed transaction is another one')
      this.firstSigningPassed(session)
      return { finalizedHex: qbitSendPlanPsbtHex(finalized), rawtx }
    } catch (error) {
      session.signing = undefined
      if (progress && approval) {
        // Cut short: the inputs it reported signing anew took their units.
        // The input in flight may have taken one more, unless the keyring
        // stopped the signing before that input (its abort, checked before
        // an input's unit is taken).
        approval.spent += progress.signed - progress.cached
        if (errorCode(error) !== QBIT_SIGNING_ABORTED_CODE) approval.unreported += 1
      }
      if (ownChallenge) this.keyring.releaseQbitRestoredFloorSigningChallenges([ownChallenge])
      const locked = this.host.lockCount() !== locksBefore || !this.host.isUnlocked()
      if (
        session.firstSigning &&
        errorCode(error) === QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED_CODE &&
        challenge !== undefined &&
        ownChallenge === undefined
      ) {
        // The page did not confirm the plan's challenge: nothing is signed
        // under any other, and `start` undoes itself.
        session.authorised = false
        session.undoing = true
        this.firstSigningFailed(session, error)
        return undefined
      }
      // The page's challenge, unspent, is let go of as well: one is live at
      // a time, and a later signature gets a fresh one.
      if (challenge && !ownChallenge) {
        this.keyring.releaseQbitRestoredFloorSigningChallenges([challenge.challengeId])
        if (fromPage) session.pageChallengeGone = true
      }
      // The start waiting on this first signing undoes itself: nothing is
      // written for it here, a pause included.
      if (this.undoAwaited(session)) return undefined
      this.firstSigningFailed(session, undefined)
      if (stop.signal.aborted && !locked) {
        // Stopped by a cancel or a revision's swap, which decided what
        // becomes of the plan; on another network, where the plan waits
        // (see `settleSession`); or found with nothing more to sign here
        // (`assertSigningStands`), which the next advance reads again.
        return undefined
      }
      if (locked || errorCode(error) === ErrorCodes.WALLET_LOCKED_DURING_SIGNING) {
        await this.pause(record.id, 'locked')
      } else {
        await this.pause(record.id, 'interrupted', errorDetail(error))
      }
      return undefined
    } finally {
      if (session.stop === stop) session.stop = undefined
      this.refreshView(record.id)
    }
  }

  /**
   * Throws, stopping the signing of `step` (`stop`), unless it may still
   * sign: nothing stopped it (a cancel, a lock, a revision's swap and a
   * reset each abort `stop`), no lock came since it began (`locksBefore`)
   * and the wallet is unlocked, this session still carries the plan and is
   * authorised to sign it, the wallet is on the plan's network, and the
   * stored plan is signing and still has `step` to sign.
   */
  private assertSigningStands(
    record: QbitSendPlanRecord,
    session: PlanSession,
    step: QbitSendPlanStepRecord,
    stop: AbortController,
    locksBefore: number
  ): void {
    const stored = this.store.get(record.id)
    const current = stored?.steps.find(item => item.txid === step.txid)
    if (
      stop.signal.aborted ||
      this.host.lockCount() !== locksBefore ||
      !this.host.isUnlocked() ||
      !session.authorised ||
      this.sessions.get(record.id) !== session ||
      this.host.activeChain() !== record.chain ||
      stored?.phase !== 'signing' ||
      current?.status !== 'planned' ||
      isVoid(current)
    ) {
      stop.abort()
      throw new Error('Signing stopped')
    }
  }

  /**
   * Open a batch for the steps left to sign, after a lock closed the last
   * one, or for the signing a continue authorised. It opens only to
   * continue the figures the user approved in this session, by a start or
   * a continue (read first when a continue's are due, see `readApproval`):
   * the fresh figures must continue them exactly (`assertContinues`). The
   * engine never approves figures by itself: in a session that holds none
   * nothing opens (`QbitSendPlanNotApprovedError`), and the plan pauses for
   * the user's continue, whether or not a lock came in between. A signing
   * stopped (`signal`) while the batch opened leaves the session alone and
   * closes the batch again.
   */
  private async reopenBatch(
    record: QbitSendPlanRecord,
    session: PlanSession,
    signal: AbortSignal
  ): Promise<void> {
    if (session.batch) this.keyring.releaseP2mrPsbtSigningBatches([session.batch.id])
    session.batch = undefined
    const keys = qbitSendPlanAccountKeys(record.account.pubkey)
    const steps = record.steps.filter(step =>
      step.kind === 'payment'
        ? step.status === 'planned'
        : (step.status === 'planned' || step.status === 'unknown') &&
          !isVoid(step) &&
          !session.signedMerges.has(step.txid)
    )
    if (steps.length === 0) return
    if (session.approvalDue) await this.readApproval(record, session)
    const approval = session.approval
    if (!approval) throw new QbitSendPlanNotApprovedError()
    const opened = await this.openBatch(record.account.address, keys, steps, {
      continues: approval,
    })
    // The signing stopped while the batch opened: the batch goes, and the
    // session stays as whatever stopped it left it (a revision's start may
    // have given it a batch of its own meanwhile).
    if (signal.aborted) {
      this.keyring.releaseP2mrPsbtSigningBatches([opened.batch.id])
      throw new Error('Signing stopped')
    }
    session.batch = opened.batch
    session.approval = opened.approval
    session.restoredFloor = session.restoredFloor || opened.restoredFloor
  }

  /**
   * Read the figures a continue approved (`PlanSession.approvalDue`): fresh
   * budgets of every transaction of `record` that may still need a
   * signature, each merge that has not confirmed (and is not void) and the
   * payment while it is unsigned, whatever the plan resumed into. They are
   * the session's approval as a start's review is: every batch opened later
   * in the session continues them exactly (`assertContinues`), so once they
   * are read, a signature another request makes with the key, a lock or
   * not, waits for the user's next continue. A merge that had confirmed when
   * they were read is no part of them: should a reorganisation take it out
   * for good, signing it again waits for a continue, as for a merge a fee
   * raise kept. With nothing left that may need a signature the session
   * holds no approval, and a signature needed later waits for a continue
   * too.
   *
   * Read only while the wallet is unlocked, at the plan's first advance
   * after the continue or, when a lock came first, after the unlock: before
   * the plan does anything else, and so before it signs. A lock
   * while they are read leaves them due for the unlock; any other refusal
   * leaves the session without an approval (logged), and the plan pauses
   * at its next signature. A start or a continue that came while they were
   * read wins over them.
   */
  private async readApproval(record: QbitSendPlanRecord, session: PlanSession): Promise<void> {
    const steps = record.steps.filter(step =>
      step.kind === 'payment'
        ? step.status === 'planned'
        : step.status !== 'confirmed' && !isVoid(step)
    )
    if (steps.length === 0) {
      session.approval = undefined
      session.approvalDue = false
      return
    }
    const locksBefore = this.host.lockCount()
    const keys = qbitSendPlanAccountKeys(record.account.pubkey)
    const challenges: string[] = []
    // Whether this read still answers for the session: no start, continue
    // or reset since, and no lock in between.
    const current = (): boolean =>
      session.approvalDue &&
      this.sessions.get(record.id) === session &&
      this.host.lockCount() === locksBefore &&
      this.host.isUnlocked()
    try {
      const prepared = await this.prepareBudgets(
        record.account.address,
        keys,
        steps,
        challenges,
        false
      )
      if (!current()) return
      session.approval = approvalOf(steps, prepared.inputs)
      session.restoredFloor = session.restoredFloor || prepared.restoredFloor
      session.approvalDue = false
    } catch (error) {
      if (!current()) return
      session.approval = undefined
      session.approvalDue = false
      this.log('Qbit send plan could not read the signature figures a continue approved', error)
    } finally {
      if (challenges.length > 0) this.keyring.releaseQbitRestoredFloorSigningChallenges(challenges)
    }
  }

  private firstSigningPassed(session: PlanSession): void {
    const first = session.firstSigning
    session.firstSigning = undefined
    first?.resolve(true)
  }

  /** The start waiting on its first signing learns how it ended: refused with `error`, or let go. */
  private firstSigningFailed(session: PlanSession, error: unknown): void {
    const first = session.firstSigning
    session.firstSigning = undefined
    if (!first) return
    if (error === undefined) first.resolve(false)
    else first.reject(error)
  }

  /**
   * Whether a start waits on this plan's first signing while the page's
   * challenge for it is gone (`PlanSession.pageChallengeGone`): nothing can
   * check that challenge any more, so the start undoes itself (see
   * `begin`). Its first signing then ends here, its authorisation withdrawn,
   * and nothing more is done or written for the plan (`PlanSession.undoing`)
   * until the undo has decided: the undo writes back, or removes, only the
   * very record the start wrote.
   */
  private undoAwaited(session: PlanSession): boolean {
    if (!session.firstSigning || !session.pageChallengeGone) return false
    session.authorised = false
    session.undoing = true
    this.firstSigningFailed(session, undefined)
    return true
  }

  private beginAutoLockHold(record: QbitSendPlanRecord, session: PlanSession): void {
    if (session.releaseAutoLock) return
    // Nothing would release a hold taken for a session dropped already.
    if (!this.sessionStands(record.id, session)) return
    const merges = mergesOf(record).filter(
      merge => merge.status === 'planned' && !isVoid(merge) && !session.signedMerges.has(merge.txid)
    )
    const payment = paymentOf(record)
    const transactions = merges.length + (payment.status === 'planned' ? 1 : 0)
    const signatures =
      merges.reduce((total, merge) => total + merge.inputs.length, 0) +
      (payment.status === 'planned' ? payment.inputs.length : 0)
    session.releaseAutoLock = this.host.holdAutoLock(
      estimateQbitSendPlanSigningSeconds(signatures, transactions) * 1000
    )
  }

  private endAutoLockHold(session: PlanSession): void {
    const release = session.releaseAutoLock
    session.releaseAutoLock = undefined
    release?.()
  }

  /** Whether `session` is still plan `planId`'s, and no reset is under way. */
  private sessionStands(planId: string, session: PlanSession): boolean {
    return !this.halted() && this.sessions.get(planId) === session
  }

  /**
   * Let go of plan `planId`'s session, if it has one: its signing stops and
   * its batch and its hold on the auto-lock go with it, so that nothing a
   * dropped session took is left without anything to release it.
   */
  private dropSession(planId: string): void {
    const session = this.sessions.get(planId)
    if (session) {
      session.stop?.abort()
      this.endSigningSegment(session)
    }
    this.sessions.delete(planId)
  }

  /** The plan's signing is over for now: its batch and its hold on the auto-lock go. */
  private endSigningSegment(session: PlanSession): void {
    this.endAutoLockHold(session)
    if (session.batch) this.keyring.releaseP2mrPsbtSigningBatches([session.batch.id])
    session.batch = undefined
  }

  private stopSigning(session: PlanSession): void {
    session.stop?.abort()
    this.endSigningSegment(session)
  }

  // -- broadcasts -----------------------------------------------------------

  /**
   * Send merge `txid` under the write-ahead rule, and apply the verdict. A
   * merge proven not sent is sent again, the same bytes, a tick later, up to
   * `QBIT_SEND_PLAN_MERGE_SEND_ATTEMPTS` times; then the plan pauses,
   * `outputs_spent` when the refusal says its inputs are gone or taken and
   * `merge_refused` otherwise.
   */
  private async sendMerge(
    planId: string,
    session: PlanSession,
    txid: string,
    rawtx: string
  ): Promise<void> {
    const result = await this.dispatch(planId, session, txid, rawtx)
    if (result === undefined) return
    if (result.success) {
      session.notSent.delete(txid)
      return
    }
    if (result.outcome !== 'not_sent' || result.reason === 'chain_changed') return
    // A replacement the network refuses may be refused because the version
    // it replaces confirmed: that is looked up afresh, and the plan then
    // stops at once (see `supersede`).
    const record = this.store.get(planId)
    const step = record?.steps.find(item => item.txid === txid)
    const replacing = step !== undefined && pendingReplaced(step) !== undefined
    if (record && step && replacing) {
      if (await this.reconcileReplaced(record, session, step, { fresh: true })) return
    }
    const attempts = (session.notSent.get(txid)?.attempts ?? 0) + 1
    if (attempts < QBIT_SEND_PLAN_MERGE_SEND_ATTEMPTS) {
      session.notSent.set(txid, { attempts, nextAt: this.now() + QBIT_SEND_PLAN_TICK_MS })
      return
    }
    session.notSent.delete(txid)
    const detail = refusalDetail(result)
    // A replacement whose earlier version is still in the network is the
    // plan's own conflict, not a spend from outside: the plan needs a
    // replan, which carries that version. Refused without a reason, what
    // spends the merge's inputs on the explorer tells a spend from outside.
    let reason: QbitSendPlanPauseReason = 'merge_refused'
    if (!replacing) {
      if (refusalHasReason(result)) {
        if (INPUTS_GONE_REASON.test(result.detail ?? '')) {
          reason = 'outputs_spent'
          // The node's reason proves no spend elsewhere: a version of the
          // payment that may still confirm is let go of only once the
          // explorer shows an input of the merge spent by another
          // transaction, so the merge, and every version spending its
          // output, can never confirm.
          if (
            record &&
            step &&
            paymentVersionMayConfirm(record) &&
            (await this.inputsSpentElsewhere(record, session, step))
          ) {
            await this.forgetPaymentVersions(planId)
          }
        }
      } else if (record && step && (await this.inputsSpentElsewhere(record, session, step))) {
        reason = 'outputs_spent'
        // The merge can never confirm, so no version of the payment, each
        // spending its output, can either.
        await this.forgetPaymentVersions(planId)
      }
    }
    await this.pause(planId, reason, detail)
  }

  /**
   * The write-ahead broadcast of step `txid`: stored `unknown` first, then
   * dispatched through the wallet's broadcast path under the plan's hold,
   * then the verdict stored. Accepted (by the response or a lookup) is
   * `broadcast`; proven not sent goes back to `planned` (merge) or `signed`
   * (payment); anything else stays `unknown`. Resolves to the verdict, or to
   * nothing when the step is no longer one to send.
   *
   * The payment records what became of its bytes (`QbitSendPlanDispatch`):
   * `unknown` from the write ahead on, until this broadcast's verdict proves
   * it not sent; then `refused`, unless an earlier broadcast of it ended
   * without a verdict, which a later refusal does not undo.
   */
  private async dispatch(
    planId: string,
    session: PlanSession,
    txid: string,
    rawtx: string
  ): Promise<QbitBroadcastResult | undefined> {
    const hold = session.hold
    if (!hold) return undefined
    let sendable = false
    // What the payment's earlier broadcasts left, before this one.
    let before: QbitSendPlanStepRecord['dispatch']
    const ahead = await this.mutate(planId, record => {
      sendable = false
      const step = record.steps.find(item => item.txid === txid)
      if (!step || !this.mayBroadcast(planId, session, record, step)) return undefined
      if (step.status === 'confirmed' || step.status === 'broadcast') return undefined
      if (record.phase !== 'signing' && record.phase !== 'waiting' && record.phase !== 'sending') {
        return undefined
      }
      sendable = true
      // A step found `unknown` had a broadcast that ended without a verdict.
      before = step.status === 'unknown' ? 'unknown' : step.dispatch
      const marked = step.kind !== 'payment' || step.dispatch === 'unknown'
      if (step.status === 'unknown' && marked) return undefined
      return withStep(record, txid, item => {
        const next = stepWithStatus(item, 'unknown')
        if (item.kind === 'payment') next.dispatch = 'unknown'
        return next
      })
    })
    const record = ahead.record ?? ahead.unchanged
    if (!sendable || !record) return undefined
    const step = record.steps.find(item => item.txid === txid)
    if (!step) return undefined
    // Checked again as the bytes are about to leave, against the plan as
    // stored now and the cancels begun since: what stopped the plan while
    // its step was written ahead leaves the step `unknown`, which whatever
    // ends the plan treats as possibly sent and settles by lookup. A cancel
    // counts from before it awaits anything (`PlanSession.cancels`), since
    // its own write may still be in flight here.
    let stored: QbitSendPlanRecord | undefined
    try {
      stored = this.store.get(planId)
    } catch {
      stored = undefined
    }
    if (!stored || stored.phase === 'cancelling') return undefined
    if (!this.mayBroadcast(planId, session, stored, step)) return undefined
    const held = desiredHolds(record)
    const presented = step.inputs.every(input => held.has(outpointKey(input))) ? hold : undefined
    this.noteSeen(session, txid)
    let result: QbitBroadcastResult
    try {
      const replacement = presented ? replacementOf(step) : undefined
      result = await this.host.broadcast({
        chain: record.chain,
        rawtx,
        txid,
        hold: presented,
        ...(replacement ? { replaces: replacement } : {}),
      })
    } catch (error) {
      // The broadcast path reports every outcome as a verdict; a throw may
      // come after the bytes left, so it is unknown.
      this.log('Qbit send plan broadcast failed unexpectedly', error)
      return { success: false, outcome: 'unknown', reason: 'unexpected' }
    }
    if (result.success) {
      await this.recordFound(planId, txid, 'pending')
    } else if (result.outcome === 'not_sent') {
      await this.mutate(planId, current => {
        const step = current.steps.find(item => item.txid === txid)
        if (!step || step.status !== 'unknown') return undefined
        return withStep(current, txid, item => {
          const next = stepWithStatus(item, item.kind === 'merge' ? 'planned' : 'signed')
          if (item.kind === 'payment') next.dispatch = before === 'unknown' ? 'unknown' : 'refused'
          return next
        })
      })
    }
    return result
  }

  /**
   * Whether an advance of plan `planId` under `session` may still broadcast
   * `step` of `record`: no reset is under way (`halt`), the session is still
   * the plan's (a delete, an undone start and a reset each let go of it), no
   * ending of the account's plans is under way (`endPlansOf`), and, for a
   * merge, no cancel of the plan (`PlanSession.cancels`). A payment needs no
   * such check: a cancel is not made once the payment is written ahead
   * (`cancellable`), and the payment is not written ahead once a cancel has
   * written the plan, `cancelling` or gone.
   */
  private mayBroadcast(
    planId: string,
    session: PlanSession,
    record: QbitSendPlanRecord,
    step: QbitSendPlanStepRecord
  ): boolean {
    if (this.halted() || this.sessions.get(planId) !== session) return false
    if (step.kind === 'merge' && session.cancels > 0) return false
    const ending = this.endings.get(accountKeyOf(record.chain, record.account.address))
    return ending === undefined || ending.underWay === 0
  }

  /**
   * Store what a lookup or an accepted broadcast found of step or carried
   * merge `txid`. A payment found is the plan completed: its signed bytes go.
   */
  private async recordFound(
    planId: string,
    txid: string,
    state: 'pending' | 'confirmed'
  ): Promise<void> {
    const session = this.session(planId)
    this.noteSeen(session, txid)
    await this.mutate(planId, record => {
      const carried = (record.carried ?? []).find(item => item.txid === txid)
      if (carried) {
        if (state === 'confirmed') {
          return { ...record, carried: (record.carried ?? []).filter(item => item.txid !== txid) }
        }
        if (carried.status === 'broadcast') return undefined
        return {
          ...record,
          carried: (record.carried ?? []).map(item =>
            item.txid === txid ? { ...item, status: 'broadcast' as const } : item
          ),
        }
      }
      const step = record.steps.find(item => item.txid === txid)
      if (!step || isVoid(step)) return undefined
      const status = state === 'confirmed' ? 'confirmed' : 'broadcast'
      if (step.kind === 'payment') {
        if (step.status === status && record.phase === 'completed') return undefined
        if (record.phase === 'cancelling') return undefined
        const next: QbitSendPlanRecordInput = withStep(record, txid, item => {
          const sent: QbitSendPlanStepRecord = { ...item, status }
          delete sent.signedPsbtHex
          return sent
        })
        next.phase = 'completed'
        delete next.pause
        return next
      }
      if (step.status === status) return undefined
      let next = withStep(record, txid, item => {
        const found = stepWithStatus(item, status)
        // Confirmed, the replacement won: the version it replaced can never
        // confirm now.
        if (status === 'confirmed') delete found.replaces
        return found
      })
      const times = mergeBroadcastTimes(record)
      if (times[txid] === undefined) {
        next = withExtra(next, { mergeBroadcastAt: { ...times, [txid]: this.now() } })
      }
      const confirmedOnce = mergeConfirmedTimes(record)
      if (status === 'confirmed' && confirmedOnce[txid] === undefined) {
        next = withExtra(next, { mergeConfirmedAt: { ...confirmedOnce, [txid]: this.now() } })
      }
      return next
    })
  }

  /**
   * Look step `merge` up and store what is found; resolves to whether that
   * changed anything. Found pending or confirmed, it is recorded so. Missed,
   * it counts as absent only once a run of misses has lasted
   * `QBIT_RECENT_SPEND_GONE_GRACE_MS` (`provenAbsent`): then it is sent
   * again from the bytes in memory, or, without them, signed again when this
   * session may sign; otherwise the plan pauses, `locked` in a session
   * authorised to sign (the unlock signs on, as after any lock) and
   * `interrupted` in one that is not (continue signs on).
   */
  private async reconcileStep(
    record: QbitSendPlanRecord,
    session: PlanSession,
    step: QbitSendPlanStepRecord
  ): Promise<boolean> {
    const state = await this.lookup(record, session, step.txid)
    if (state === undefined) return false
    if (state !== 'gone') {
      const wanted = state === 'confirmed' ? 'confirmed' : 'broadcast'
      if (step.status === wanted) return false
      await this.recordFound(record.id, step.txid, state)
      return true
    }
    if (!this.provenAbsent(session, step.txid)) return false
    // Proven absent: the merge is `planned` again. It goes out again from
    // the bytes in memory, or, without them, is signed again (the same
    // inputs and outputs, so the same id) when this session may sign; the
    // plan pauses otherwise.
    const rawtx = record.phase === 'cancelling' ? undefined : session.signedMerges.get(step.txid)
    await this.mutate(record.id, current => {
      const item = current.steps.find(candidate => candidate.txid === step.txid)
      if (!item || item.status === 'planned') return undefined
      const next = withStep(current, step.txid, candidate => stepWithStatus(candidate, 'planned'))
      if (rawtx === undefined && (current.phase === 'waiting' || current.phase === 'sending')) {
        if (session.authorised && this.host.isUnlocked()) {
          next.phase = 'signing'
        } else {
          // Locked in a session authorised to sign, it goes on after the
          // unlock (see `stepPaused`); otherwise it waits for continue.
          next.phase = 'paused'
          next.pause = { reason: session.authorised ? 'locked' : 'interrupted', at: this.now() }
        }
      }
      return next
    })
    if (rawtx !== undefined) await this.sendMerge(record.id, session, step.txid, rawtx)
    return true
  }

  /**
   * Where `txid` stands on `record`'s network, or nothing without an
   * answer. A transaction found is seen now, which ends any run of misses;
   * a miss starts one or extends it (see `provenAbsent`).
   *
   * The explorer is asked about `txid` at most once every
   * `QBIT_SEND_PLAN_TICK_MS`, whatever advances the plan (the timer, a
   * page's read, an unlock): a read within that time of the last one is
   * answered with what that one found, which the plan has already acted
   * on. Pages read every few seconds, and every page reads, so this is what
   * bounds the explorer's load. A lifecycle read takes at most two requests
   * and an outspends read one (see `spendersOf`). Of a plan of n merges, r
   * of them replacing an earlier version, c carried merges and e earlier
   * versions of its payment, each of the n + r + 1 + c + e transactions is
   * read at most once and each merge's outspends at most once. Besides, a
   * replacement the network refuses has the version it replaces read once
   * more (`fresh`), and a step refused without a reason (or a merge refused
   * for spent inputs while a version of the payment may still confirm), one
   * such step a tick before the plan pauses or waits again, has at most 8
   * merges read once more (`missingInputsReason`) and the outspends of each
   * transaction whose outputs it spends read once more, afresh, at most
   * 106; and a
   * transaction found spending an input of the payment that the plan does
   * not list is read once and looked up once afresh (`identifySpender`).
   * Paused while a version of its payment may still confirm, a plan reads
   * the outspends of the payment's other parents too, each at most once
   * (`paymentInputSpender`), at most 106 - n; and immediately before each
   * dispatch of the payment every merge is read afresh once more
   * (`stepSending`), a round that went without an answer waiting a tick. So
   * a plan makes at most 2(n + r + 1 + c + e) + 2n + 2r + 16 + 212 + 3
   * requests in any 15 s however often it is read, one dispatch of the
   * payment included: 249 for four merges, and 1,537 (about 102 a second)
   * for the largest plan, 106 merges replacing 106, carrying 212 and keeping
   * 16 earlier versions of its payment. A
   * revision's prepare asks afresh too, for the merges it settles, the
   * versions of the payment and what spends the payment's inputs: the
   * user's request, once per review.
   */
  private async lookup(
    record: QbitSendPlanRecord,
    session: PlanSession,
    txid: string,
    { fresh = false }: { fresh?: boolean } = {}
  ): Promise<'confirmed' | 'pending' | 'gone' | undefined> {
    const known = session.lookups.get(txid)
    if (!fresh && known && this.now() - known.at < QBIT_SEND_PLAN_TICK_MS) return known.state
    let state: 'confirmed' | 'pending' | 'gone' | undefined
    const at = this.now()
    try {
      state = await this.host.lifecycle(record.chain, txid)
    } catch {
      state = undefined
    }
    session.lookups.set(txid, { at, state })
    if (state === 'gone') this.noteMiss(session, txid, at)
    else if (state !== undefined) this.noteSeen(session, txid)
    return state
  }

  /** `txid` was dispatched or found in the network now: any run of misses is over. */
  private noteSeen(session: PlanSession, txid: string): void {
    session.seen.set(txid, this.now())
    session.missed.delete(txid)
  }

  /**
   * A lookup of `txid` read at `at` missed it: the first miss of a run, or
   * the latest. A read that began no later than the transaction was last
   * dispatched or found may predate it, and joins no run.
   */
  private noteMiss(session: PlanSession, txid: string, at: number): void {
    const seenAt = session.seen.get(txid)
    if (seenAt !== undefined && at <= seenAt) return
    const run = session.missed.get(txid)
    if (run) run.last = Math.max(run.last, at)
    else session.missed.set(txid, { since: at, last: at })
  }

  /**
   * What spends each output of `txid`, or nothing without an answer: an
   * outspends read, at most once every `QBIT_SEND_PLAN_TICK_MS` as for
   * `lookup`.
   */
  private async spendersOf(
    record: QbitSendPlanRecord,
    session: PlanSession,
    txid: string,
    { fresh = false }: { fresh?: boolean } = {}
  ): Promise<(string | undefined)[] | undefined> {
    const known = session.outspends.get(txid)
    if (!fresh && known && this.now() - known.at < QBIT_SEND_PLAN_TICK_MS) return known.spenders
    let spenders: (string | undefined)[] | undefined
    const at = this.now()
    try {
      spenders = await this.host.spenders(record.chain, txid)
    } catch {
      spenders = undefined
    }
    session.outspends.set(txid, { at, spenders })
    return spenders
  }

  /**
   * Whether `txid`, which a lookup just reported gone, is proven absent.
   * The rule, exactly: since `txid` was last dispatched or found in the
   * network, the lookups that answered have all missed it (a run of
   * misses: a lookup without an answer neither ends the run nor extends
   * it, and an answer given again within `QBIT_SEND_PLAN_TICK_MS`, see
   * `lookup`, is no new miss), and the latest miss was read at least
   * `QBIT_RECENT_SPEND_GONE_GRACE_MS` after the first. So the grace counts
   * from the first miss of the run, never from when `txid` was last seen,
   * and a single miss proves nothing however long ago that was: a paused
   * plan looks up no merge that has confirmed, so its last sighting can be
   * old when a transient miss comes. The grace is the send guard's for a
   * recent spend reported gone: the explorer's index can lag the node, and
   * one miss can be a transient one. Runs are this session's: a restart
   * starts each again.
   */
  private provenAbsent(session: PlanSession, txid: string): boolean {
    const run = session.missed.get(txid)
    return run !== undefined && run.last - run.since >= QBIT_RECENT_SPEND_GONE_GRACE_MS
  }

  // -- waiting --------------------------------------------------------------

  private async stepWaiting(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<StepOutcome> {
    this.endAutoLockHold(session)
    const merges = mergesOf(record)
    // Every merge that has not confirmed, and, a few at a time, those that
    // have (a reorganisation can take one out again).
    const confirmed = merges.filter(merge => merge.status === 'confirmed')
    const recheck = new Set<string>()
    for (
      let count = 0;
      count < Math.min(QBIT_SEND_PLAN_CONFIRMED_LOOKUPS_PER_ADVANCE, confirmed.length);
      count++
    ) {
      recheck.add(at(confirmed, (session.confirmedCursor + count) % confirmed.length).txid)
    }
    session.confirmedCursor += recheck.size
    // One pass settles every merge; each change is written against the
    // newest record, so the pass reads the plan again only once it ends.
    let changed = false
    if (!paymentMayBeSent(record) && merges.some(isVoid)) {
      await this.pause(record.id, 'merge_refused')
      return 'again'
    }
    for (const merge of merges) {
      if (merge.status === 'confirmed' && !recheck.has(merge.txid)) continue
      if (merge.status === 'planned') {
        // Proven absent and waiting for its bytes again.
        const rawtx = session.signedMerges.get(merge.txid)
        if (rawtx !== undefined) {
          const notSent = session.notSent.get(merge.txid)
          if (notSent && notSent.nextAt > this.now()) continue
          await this.sendMerge(record.id, session, merge.txid, rawtx)
          changed = true
          continue
        }
        if (session.authorised && this.host.isUnlocked()) {
          await this.mutate(record.id, current =>
            current.phase === 'waiting' ? { ...current, phase: 'signing' } : undefined
          )
        } else {
          // Locked in a session authorised to sign: the unlock signs on.
          await this.pause(record.id, session.authorised ? 'locked' : 'interrupted')
        }
        return 'again'
      }
      if (await this.reconcileStep(record, session, merge)) changed = true
      else if (await this.reconcileReplaced(record, session, merge)) changed = true
    }
    if (await this.reconcileCarried(record, session)) changed = true
    if (changed) return 'again'
    const spender = await this.outputsSpentElsewhere(record, session)
    if (spender !== undefined) {
      // A merge's output is an input of the payment: what spends it is
      // identified before the plan pauses (`settlePaymentInputSpender`).
      const settled = await this.settlePaymentInputSpender(record, session, spender)
      if (settled === undefined) return 'idle'
      if (settled === 'elsewhere') await this.pause(record.id, 'outputs_spent')
      return 'again'
    }
    const current = this.store.get(record.id)
    if (current && current.revision === record.revision) this.refreshView(record.id)
    const paymentNotSent = session.notSent.get(paymentOf(record).txid)
    if (paymentNotSent && paymentNotSent.nextAt > this.now()) return 'idle'
    if (merges.every(merge => merge.status === 'confirmed')) {
      await this.mutate(record.id, latest =>
        latest.phase === 'waiting' && mergesOf(latest).every(merge => merge.status === 'confirmed')
          ? { ...latest, phase: 'sending' }
          : undefined
      )
      return 'again'
    }
    return 'idle'
  }

  /**
   * Settle carried merges: confirmed or proven absent, they go, and their
   * inputs with them; one proven absent takes its fee off `paidFee`
   * (`withoutAbsentCarried`). Resolves to whether anything changed.
   */
  private async reconcileCarried(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<boolean> {
    let changed = false
    for (const item of record.carried ?? []) {
      const state = await this.lookup(record, session, item.txid)
      if (state === undefined) continue
      if (state !== 'gone') {
        if (state === 'confirmed' || item.status !== 'broadcast') {
          await this.recordFound(record.id, item.txid, state)
          changed = true
        }
        continue
      }
      if (!this.provenAbsent(session, item.txid)) continue
      await this.mutate(record.id, current =>
        (current.carried ?? []).some(candidate => candidate.txid === item.txid)
          ? withoutAbsentCarried(current, item.txid)
          : undefined
      )
      changed = true
    }
    return changed
  }

  /**
   * What the explorer shows spending an input of `record`'s payment, when it
   * is not the payment itself, read as a waiting plan reads its merges'
   * outspends: at most `QBIT_SEND_PLAN_OUTSPENDS_PER_ADVANCE` of the
   * transactions whose outputs the payment spends per advance, in turn, each
   * at most once a tick (`spendersOf`). Every version of the payment spends
   * the same inputs, so a spender that is an earlier version comes back too,
   * for `settlePaymentInputSpender` to complete the plan with.
   */
  private async paymentInputSpender(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<string | undefined> {
    const payment = paymentOf(record)
    const vouts = new Map<string, number[]>()
    for (const input of payment.inputs) {
      vouts.set(input.txid, [...(vouts.get(input.txid) ?? []), input.vout])
    }
    const parents = [...vouts.keys()]
    const count = Math.min(QBIT_SEND_PLAN_OUTSPENDS_PER_ADVANCE, parents.length)
    for (let index = 0; index < count; index++) {
      const parent = at(parents, (session.paymentInputsCursor + index) % parents.length)
      const spenders = await this.spendersOf(record, session, parent)
      if (spenders === undefined) continue
      for (const vout of vouts.get(parent) ?? []) {
        const spender = spenders[vout]
        if (spender !== undefined && spender !== payment.txid) return spender
      }
    }
    session.paymentInputsCursor += count
    return undefined
  }

  /** What the explorer shows spending an output of a merge, when it is not the plan's payment. */
  private async outputsSpentElsewhere(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<string | undefined> {
    const sent = mergesOf(record).filter(
      merge => merge.status === 'broadcast' || merge.status === 'confirmed'
    )
    const payment = paymentOf(record).txid
    const count = Math.min(QBIT_SEND_PLAN_OUTSPENDS_PER_ADVANCE, sent.length)
    for (let index = 0; index < count; index++) {
      const merge = at(sent, (session.outspendsCursor + index) % sent.length)
      const spender = (await this.spendersOf(record, session, merge.txid))?.[0]
      if (spender !== undefined && spender !== payment) return spender
    }
    session.outspendsCursor += count
    return undefined
  }

  // -- sending --------------------------------------------------------------

  private async stepSending(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<StepOutcome> {
    this.endAutoLockHold(session)
    const payment = paymentOf(record)
    if (!paymentMayBeSent(record) && mergesOf(record).some(isVoid)) {
      await this.pause(record.id, 'merge_refused')
      return 'again'
    }
    if (payment.status === 'planned' || payment.signedPsbtHex === undefined) {
      await this.pause(record.id, 'interrupted')
      return 'again'
    }
    if (payment.status === 'unknown') {
      // A lost answer is looked up, never rebuilt; the same bytes go again
      // only once the payment is proven absent.
      const state = await this.lookup(record, session, payment.txid)
      if (state === undefined) return 'idle'
      if (state !== 'gone') {
        await this.recordFound(record.id, payment.txid, state)
        return 'again'
      }
      if (!this.provenAbsent(session, payment.txid)) return 'idle'
    }
    // Every merge the payment spends has confirmed, read from the explorer
    // afresh immediately before the payment goes, once for each dispatch:
    // nothing goes to the recipient before that, and a read of this tick may
    // predate a reorganisation. A round without an answer waits a tick
    // before the next (`PlanSession.mergesUnreadAt`).
    const unread = session.mergesUnreadAt
    if (unread !== undefined && this.now() - unread < QBIT_SEND_PLAN_TICK_MS) return 'idle'
    session.mergesUnreadAt = undefined
    for (const merge of mergesOf(record)) {
      const state = await this.lookup(record, session, merge.txid, { fresh: true })
      if (state === undefined) {
        session.mergesUnreadAt = this.now()
        return 'idle'
      }
      if (state === 'confirmed') continue
      await this.mutate(record.id, current => {
        if (current.phase !== 'sending') return undefined
        const next = withStep(current, merge.txid, item =>
          stepWithStatus(item, state === 'pending' ? 'broadcast' : 'unknown')
        )
        next.phase = 'waiting'
        return next
      })
      return 'again'
    }
    // A version of the payment that may be in the network (its broadcast had
    // no verdict) is looked up before another goes: found, it is the payment.
    if (await this.reconcilePaymentVersions(record, session)) return 'again'
    // Checked again immediately before it goes, as the store checks every
    // record it reads or writes: the stored payment pays exactly what the
    // record shows (the recipient on the plan's network, the amount, the
    // change to the account, nothing else of value), and its signed bytes
    // are that very transaction. One that is not is no plan this wallet
    // made: nothing of it goes, and it waits for its cancel.
    let rawtx: string
    try {
      rawtx = qbitSendPlanStoredPayment(record).rawtx
    } catch (error) {
      await this.pause(record.id, 'unreadable', errorDetail(error))
      return 'again'
    }
    const result = await this.dispatch(record.id, session, payment.txid, rawtx)
    if (result === undefined || result.success || result.outcome !== 'not_sent') return 'again'
    if (result.reason === 'chain_changed') return 'idle'
    const detail = result.detail ?? ''
    let reason: QbitSendPlanPauseReason | 'waiting' | 'completed' = 'payment_refused'
    let unexplained = false
    if (!refusalHasReason(result)) {
      // Refused without a reason: a merge it spends that is no longer
      // confirmed, or an input something else spends, is what the explorer
      // can still show; anything else may be a fee refusal as well.
      reason = await this.missingInputsReason(record, session)
      unexplained = reason === 'payment_refused'
    } else if (ANCESTOR_REASON.test(detail)) {
      reason = 'waiting'
    } else if (FEE_REASON.test(detail)) {
      reason = 'payment_fee_too_low'
    } else if (INPUTS_GONE_REASON.test(detail)) {
      reason = await this.missingInputsReason(record, session)
    }
    if (reason === 'completed') return 'again'
    if (reason === 'waiting') {
      session.notSent.set(payment.txid, {
        attempts: (session.notSent.get(payment.txid)?.attempts ?? 0) + 1,
        nextAt: this.now() + QBIT_SEND_PLAN_TICK_MS,
      })
      await this.mutate(record.id, current =>
        current.phase === 'sending' ? { ...current, phase: 'waiting' } : undefined
      )
    } else {
      await this.pause(record.id, reason, refusalDetail(result), { unexplained })
    }
    return 'again'
  }

  /**
   * The payment was refused for missing inputs, or without a reason: back
   * to waiting when a merge it spends is no longer confirmed, `outputs_spent`
   * when something else spends one of its inputs, and `payment_refused`
   * otherwise, stopping at the first answer that decides. The refusal is
   * news the send's own reads, at most a tick old, cannot speak for, but
   * only for the merges a reorganisation can have taken out since: those
   * in the newest blocks. So the merges seen confirmed last are read
   * afresh, at most `QBIT_SEND_PLAN_CONFIRMED_LOOKUPS_PER_ADVANCE`, and the
   * rest reuse the reads this send made before it went (a deeper
   * reorganisation shows on the next send, which reads every merge first).
   * Then each transaction whose outputs the payment spends has its outspends
   * read once, afresh (`inputsSpentElsewhere`), and what spends an input is
   * identified (`settlePaymentInputSpender`): `completed` when it is the
   * plan's payment going through.
   */
  private async missingInputsReason(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<QbitSendPlanPauseReason | 'waiting' | 'completed'> {
    const merges = mergesOf(record)
    const confirmedAt = mergeConfirmedTimes(record)
    const seenAt = (merge: QbitSendPlanStepRecord): number =>
      confirmedAt[merge.txid] ?? Number.MAX_SAFE_INTEGER
    const newest = [...merges]
      .sort((a, b) => seenAt(b) - seenAt(a))
      .slice(0, QBIT_SEND_PLAN_CONFIRMED_LOOKUPS_PER_ADVANCE)
    const afresh = new Set(newest.map(merge => merge.txid))
    for (const merge of [...newest, ...merges.filter(merge => !afresh.has(merge.txid))]) {
      const state = await this.lookup(record, session, merge.txid, {
        fresh: afresh.has(merge.txid),
      })
      if (state !== 'confirmed') return 'waiting'
    }
    // What spends an input is identified: the payment going through by any
    // version of it completes the plan, and a spend the explorer cannot
    // tell yet is decided on a later send.
    const spender = await this.inputsSpentElsewhere(record, session, paymentOf(record))
    if (spender === undefined) return 'payment_refused'
    const settled = await this.settlePaymentInputSpender(record, session, spender)
    if (settled === 'completed') return 'completed'
    return settled === 'elsewhere' ? 'outputs_spent' : 'waiting'
  }

  /**
   * What the explorer shows spending an input of `step` other than the step
   * itself (or, for a raised merge, the version it replaces), or nothing when
   * no input is spent so: the outspends of each transaction whose outputs it
   * spends, read once, stopping at the first input spent elsewhere. Each
   * read is made afresh, after the refusal it explains: one made before (the
   * waiting plan reads its merges' outspends) cannot show a spend since.
   */
  private async inputsSpentElsewhere(
    record: QbitSendPlanRecord,
    session: PlanSession,
    step: QbitSendPlanStepRecord
  ): Promise<string | undefined> {
    const own = new Set([step.txid, ...(step.replaces ? [step.replaces.txid] : [])])
    const vouts = new Map<string, number[]>()
    for (const input of step.inputs) {
      vouts.set(input.txid, [...(vouts.get(input.txid) ?? []), input.vout])
    }
    for (const [txid, spent] of vouts) {
      const spenders = await this.spendersOf(record, session, txid, { fresh: true })
      if (spenders === undefined) continue
      for (const vout of spent) {
        const spender = spenders[vout]
        if (spender !== undefined && !own.has(spender)) return spender
      }
    }
    return undefined
  }

  /**
   * What `spender`, a transaction spending an input of `record`'s payment,
   * is to the plan: a version of its payment (the payment itself, or an
   * earlier version), a transaction paying the recipient the amount of the
   * payment or of an earlier version (the payment sent by other means), or
   * a spend elsewhere. Nothing when the explorer cannot tell.
   */
  private async identifySpender(
    record: QbitSendPlanRecord,
    spender: string
  ): Promise<
    | { kind: 'payment' }
    | { kind: 'version'; version: QbitSendPlanPaymentVersion }
    | { kind: 'recipient'; paidBy: QbitSendPlanPaidBy }
    | { kind: 'elsewhere' }
    | undefined
  > {
    if (spender === paymentOf(record).txid) return { kind: 'payment' }
    const version = (record.earlierPayments ?? []).find(item => item.txid === spender)
    if (version) return { kind: 'version', version }
    let read: Awaited<ReturnType<QbitSendPlanEngineHost['transaction']>>
    try {
      read = await this.host.transaction(record.chain, spender)
    } catch {
      return undefined
    }
    const recipient = bytesToHex(qbitSendPlanAddressScript(record.chain, record.recipient))
    const amounts = new Set([
      record.amount,
      ...(record.earlierPayments ?? []).map(item => item.amount),
    ])
    const paid = read.outputs.find(
      output => output.script.toLowerCase() === recipient && amounts.has(output.value)
    )
    if (paid)
      return { kind: 'recipient', paidBy: { txid: spender, amount: paid.value, fee: read.fee } }
    return { kind: 'elsewhere' }
  }

  /**
   * Settle a spend of an input of `record`'s payment by `spender`, which the
   * explorer shows: identified before the plan pauses `outputs_spent`, and
   * before a revision is planned. A version of the payment, or a transaction
   * paying the recipient the amount, is the plan's payment having gone
   * through: once the explorer finds it, the plan completes with it, and
   * nothing is revised. Anything else spends an input every version of the
   * payment spends, so none of them can confirm any more: the plan forgets
   * them (`forgetPaymentVersions`), and a replan may be offered. Resolves to
   * `completed`, `elsewhere`, or nothing when the explorer cannot tell yet.
   */
  private async settlePaymentInputSpender(
    record: QbitSendPlanRecord,
    session: PlanSession,
    spender: string
  ): Promise<'completed' | 'elsewhere' | undefined> {
    const identity = await this.identifySpender(record, spender)
    if (!identity) return undefined
    if (identity.kind === 'elsewhere') {
      await this.forgetPaymentVersions(record.id)
      return 'elsewhere'
    }
    const state = await this.lookup(record, session, spender, { fresh: true })
    if (state !== 'pending' && state !== 'confirmed') return undefined
    if (identity.kind === 'payment') await this.recordFound(record.id, spender, state)
    else if (identity.kind === 'version') {
      await this.completeWithVersion(record.id, identity.version, state)
    } else await this.completeWithPaidBy(record.id, identity.paidBy, state)
    return 'completed'
  }

  /**
   * Look up the versions of `record`'s payment that may be in the network
   * though the plan does not count them as sent (`paymentVersionMayConfirm`):
   * found, the plan completes with the one found. Resolves to whether that
   * changed the plan: a plan that failed its checks is not completed (see
   * `mutate`), and its advance does not go round again on it.
   */
  private async reconcilePaymentVersions(
    record: QbitSendPlanRecord,
    session: PlanSession,
    { fresh = false }: { fresh?: boolean } = {}
  ): Promise<boolean> {
    const payment = paymentOf(record)
    const candidates: { txid: string; version?: QbitSendPlanPaymentVersion }[] = []
    if (payment.dispatch === 'unknown' && !paymentMayBeSent(record)) {
      candidates.push({ txid: payment.txid })
    }
    for (const version of record.earlierPayments ?? []) {
      if (version.dispatch === 'unknown') candidates.push({ txid: version.txid, version })
    }
    for (const candidate of candidates) {
      const state = await this.lookup(record, session, candidate.txid, { fresh })
      if (state !== 'pending' && state !== 'confirmed') continue
      const before = this.store.get(record.id)?.revision
      if (candidate.version) await this.completeWithVersion(record.id, candidate.version, state)
      else await this.recordFound(record.id, candidate.txid, state)
      return this.store.get(record.id)?.revision !== before
    }
    return false
  }

  /**
   * Version `version` of the payment was found in the network: the plan is
   * complete with it. The record becomes that version's (its id, PSBT, fee,
   * rate, amount and change), and every other version whose bytes left the
   * wallet is kept, the replaced payment included, until the one found has
   * confirmed: they spend the same inputs, and one of them may confirm
   * instead (see `stepCompleted`).
   */
  private async completeWithVersion(
    planId: string,
    version: QbitSendPlanPaymentVersion,
    state: 'pending' | 'confirmed'
  ): Promise<void> {
    await this.mutate(planId, current => {
      const listed = (current.earlierPayments ?? []).some(item => item.txid === version.txid)
      if (!listed) return undefined
      const replaced = paymentVersionOf(current)
      const others = [
        ...(current.earlierPayments ?? []).filter(item => item.txid !== version.txid),
        ...(replaced ? [replaced] : []),
      ]
      const merges = mergesOf(current)
      const paid: QbitSendPlanStepRecord = {
        kind: 'payment',
        txid: version.txid,
        unsignedPsbtHex: version.unsignedPsbtHex,
        inputs: paymentOf(current).inputs,
        vsize: version.vsize,
        fee: version.fee,
        feeRate: version.feeRate,
        status: state === 'confirmed' ? 'confirmed' : 'broadcast',
        dispatch: version.dispatch,
      }
      const next: QbitSendPlanRecordInput = {
        ...current,
        amount: version.amount,
        change: version.change,
        feeRate: version.feeRate,
        totalFee: merges.reduce((total, merge) => total + merge.fee, 0) + version.fee,
        steps: [...merges, paid],
        phase: 'completed',
      }
      if (state === 'confirmed' || others.length === 0) delete next.earlierPayments
      else next.earlierPayments = others
      delete next.pause
      delete next.paidBy
      return next
    })
  }

  /**
   * A transaction that is no version of the payment spends its inputs and
   * pays the recipient the amount (`paidBy`): the plan is complete with it,
   * nothing more is sent, and the stored signed payment goes.
   */
  private async completeWithPaidBy(
    planId: string,
    paidBy: QbitSendPlanPaidBy,
    state: 'pending' | 'confirmed'
  ): Promise<void> {
    await this.mutate(planId, current => {
      if (current.phase === 'cancelling') return undefined
      if (current.phase === 'completed' && current.paidBy?.txid === paidBy.txid) return undefined
      const next = withStep(current, paymentOf(current).txid, item => {
        const sent: QbitSendPlanStepRecord = {
          ...item,
          status: state === 'confirmed' ? 'confirmed' : 'broadcast',
        }
        delete sent.signedPsbtHex
        return sent
      })
      next.phase = 'completed'
      next.paidBy = { ...paidBy }
      if (state === 'confirmed') delete next.earlierPayments
      delete next.pause
      return next
    })
  }

  /**
   * An input every version of the payment spends is spent elsewhere, so
   * none of them can confirm: the plan stops counting them.
   */
  private async forgetPaymentVersions(planId: string): Promise<void> {
    await this.mutate(planId, current => {
      if (!paymentDispatched(current) || current.phase === 'completed') return undefined
      const next = withStep(current, paymentOf(current).txid, item => {
        const forgotten = { ...item }
        delete forgotten.dispatch
        return forgotten
      })
      delete next.earlierPayments
      return next
    })
  }

  /**
   * Look the payment of `record` up, which may be in the network, and store
   * what is found; resolves to whether that changed the plan. Found pending
   * or confirmed, the plan is complete, whatever it was doing or paused
   * for. A paused plan offers nothing while its payment may be in the
   * network (see `actionsOf`), so once a run of misses of the payment has
   * lasted the grace period (`provenAbsent`) it is not sent: it is `signed`
   * again, and the pause offers what it offers for a payment never sent. A
   * plan signing or waiting leaves a missed payment to `stepSending`, which
   * sends the same bytes again once every merge has confirmed.
   */
  private async reconcilePayment(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<boolean> {
    const payment = paymentOf(record)
    const state = await this.lookup(record, session, payment.txid)
    if (state === undefined) return false
    if (state !== 'gone') {
      const before = this.store.get(record.id)?.revision
      await this.recordFound(record.id, payment.txid, state)
      return this.store.get(record.id)?.revision !== before
    }
    if (record.phase !== 'paused' || payment.status !== 'unknown') return false
    if (!this.provenAbsent(session, payment.txid)) return false
    const outcome = await this.mutate(record.id, current => {
      const item = paymentOf(current)
      if (current.phase !== 'paused' || item.txid !== payment.txid || item.status !== 'unknown') {
        return undefined
      }
      return withStep(current, payment.txid, step => stepWithStatus(step, 'signed'))
    })
    return outcome.record !== undefined
  }

  // -- paused, cancelling, completed -----------------------------------------

  private async stepPaused(record: QbitSendPlanRecord, session: PlanSession): Promise<StepOutcome> {
    this.endAutoLockHold(session)
    const reason = pauseReasonOf(record)
    if (reason === 'locked' && session.authorised && this.host.isUnlocked()) {
      await this.mutate(record.id, current => {
        if (pauseReasonOf(current) !== 'locked') return undefined
        const next: QbitSendPlanRecordInput = { ...current, phase: resumedPhase(current) }
        delete next.pause
        return next
      })
      return 'again'
    }
    // A version of the payment that may be in the network, though the plan
    // does not count it as sent, completes the plan once it is found.
    if (await this.reconcilePaymentVersions(record, session)) return 'again'
    // While one may still confirm, what spends an input of the payment is
    // identified, as for a waiting plan's merges: a version, or a
    // transaction paying the recipient the amount, completes the plan;
    // anything else means no version can confirm any more, and the plan
    // forgets them and pauses `outputs_spent`, offering a replan and a
    // cancel again (`settlePaymentInputSpender`).
    if (paymentVersionMayConfirm(record) && !paymentMayBeSent(record) && !failedItsChecks(record)) {
      const spender = await this.paymentInputSpender(record, session)
      if (spender !== undefined) {
        const settled = await this.settlePaymentInputSpender(record, session, spender)
        if (settled === 'elsewhere') await this.pause(record.id, 'outputs_spent')
        if (settled !== undefined) return 'again'
      }
    }
    // The steps keep their state current while the plan waits for the user,
    // a raised merge's earlier version included.
    for (const merge of mergesOf(record)) {
      if (merge.status === 'unknown' || merge.status === 'broadcast') {
        const state = await this.lookup(record, session, merge.txid)
        if (state !== undefined && state !== 'gone') {
          const wanted = state === 'confirmed' ? 'confirmed' : 'broadcast'
          if (merge.status !== wanted) {
            await this.recordFound(record.id, merge.txid, state)
            continue
          }
        }
      }
      await this.reconcileReplaced(record, session, merge)
    }
    await this.reconcileCarried(record, session)
    return 'idle'
  }

  /**
   * Settle the earlier version `merge` replaces, while either may confirm.
   * Found confirmed, it won, and the replacement is void (see `supersede`);
   * proven absent (a run of misses lasted the grace period), the
   * replacement is the only version left: the step forgets the one it
   * replaced, and the guard what that one's broadcast recorded, so the
   * replacement goes out as the merge itself. Found pending, or without an
   * answer, nothing changes. Resolves to whether the plan changed.
   */
  private async reconcileReplaced(
    record: QbitSendPlanRecord,
    session: PlanSession,
    merge: QbitSendPlanStepRecord,
    options: { fresh?: boolean } = {}
  ): Promise<boolean> {
    const replaced = pendingReplaced(merge)
    if (!replaced || merge.status === 'confirmed') return false
    const state = await this.lookup(record, session, replaced.txid, options)
    if (state === undefined || state === 'pending') return false
    if (state === 'confirmed') return this.supersede(record.id, merge.txid)
    if (!this.provenAbsent(session, replaced.txid)) return false
    const outcome = await this.mutate(record.id, current => {
      const step = current.steps.find(item => item.txid === merge.txid)
      if (!step || pendingReplaced(step)?.txid !== replaced.txid) return undefined
      return withStep(current, merge.txid, item => {
        const next = { ...item }
        delete next.replaces
        return next
      })
    })
    if (!outcome.record) return false
    await this.guard.forgetProvenAbsentBroadcast(record.chain, replaced.txid).catch(() => false)
    return true
  }

  /**
   * The earlier version a replacement replaces confirmed instead. The
   * replacement can never be in the network now: it becomes void (`planned`,
   * never signed or sent), the payment signed against it is void too and
   * its bytes go, and the plan pauses `merge_refused`, offering a replan,
   * which spends that version's output; the plan holds it until then. A
   * cancelling plan only stops waiting on the replacement. Resolves to
   * whether the plan changed.
   */
  private async supersede(planId: string, stepTxid: string): Promise<boolean> {
    const session = this.session(planId)
    const outcome = await this.mutate(planId, current => {
      const step = current.steps.find(item => item.txid === stepTxid)
      const replaced = step ? pendingReplaced(step) : undefined
      if (!step || !replaced || step.status === 'confirmed' || current.phase === 'completed') {
        return undefined
      }
      let next: QbitSendPlanRecordInput = withStep(current, stepTxid, item => ({
        ...stepWithStatus(item, 'planned'),
        replaces: { txid: replaced.txid, fee: replaced.fee, confirmed: true },
      }))
      if (current.phase === 'cancelling' || paymentMayBeSent(current)) return next
      next = withStep(next, paymentOf(current).txid, item => stepWithStatus(item, 'planned'))
      next.phase = 'paused'
      next.pause = {
        reason: 'merge_refused',
        at: this.now(),
        detail: 'An earlier version of a merge confirmed instead of its replacement',
      }
      return next
    })
    session.signedMerges.delete(stepTxid)
    this.stopSigning(session)
    // A challenge the page confirmed for the replacement can never be used.
    if (session.pageChallenge?.stepTxid === stepTxid) {
      this.keyring.releaseQbitRestoredFloorSigningChallenges([
        session.pageChallenge.risk.challengeId,
      ])
      session.pageChallenge = undefined
    }
    return outcome.record !== undefined
  }

  private async stepCancelling(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<StepOutcome> {
    this.endAutoLockHold(session)
    const unknown = [
      ...mergesOf(record).filter(merge => merge.status === 'unknown'),
      ...(record.carried ?? []).filter(item => item.status === 'unknown'),
    ]
    const since = cancelledAt(record) ?? record.updatedAt
    if (unknown.length === 0 || this.now() - since >= QBIT_SEND_PLAN_CANCEL_BACKSTOP_MS) {
      await this.mutate(record.id, current =>
        current.phase === 'cancelling' ? 'delete' : undefined
      )
      return 'again'
    }
    let changed = false
    for (const item of unknown) {
      const state = await this.lookup(record, session, item.txid)
      if (state === undefined) continue
      if (state !== 'gone') {
        await this.recordFound(record.id, item.txid, state)
        changed = true
        continue
      }
      if (!this.provenAbsent(session, item.txid)) continue
      await this.mutate(record.id, current => {
        if ((current.carried ?? []).some(candidate => candidate.txid === item.txid)) {
          return withoutAbsentCarried(current, item.txid)
        }
        const step = current.steps.find(candidate => candidate.txid === item.txid)
        if (!step || step.status !== 'unknown') return undefined
        return withStep(current, item.txid, candidate => stepWithStatus(candidate, 'planned'))
      })
      changed = true
    }
    return changed ? 'again' : 'idle'
  }

  private async stepCompleted(
    record: QbitSendPlanRecord,
    session: PlanSession
  ): Promise<StepOutcome> {
    this.endSigningSegment(session)
    session.authorised = false
    const payment = paymentOf(record)
    if (payment.status !== 'broadcast') return 'idle'
    const paying = record.paidBy?.txid ?? payment.txid
    if ((await this.lookup(record, session, paying)) === 'confirmed') {
      await this.mutate(record.id, current => {
        if (current.phase !== 'completed' || paymentOf(current).status !== 'broadcast') {
          return undefined
        }
        if ((current.paidBy?.txid ?? paymentOf(current).txid) !== paying) return undefined
        const next = withStep(current, payment.txid, item => ({ ...item, status: 'confirmed' }))
        // Confirmed, it is the payment for good: no other version can be.
        delete next.earlierPayments
        return next
      })
      return 'again'
    }
    // Every version spends the same inputs: one that confirms instead of the
    // one the plan completed with is the payment.
    for (const version of record.earlierPayments ?? []) {
      if ((await this.lookup(record, session, version.txid)) === 'confirmed') {
        await this.completeWithVersion(record.id, version, 'confirmed')
        return 'again'
      }
    }
    return 'idle'
  }

  // -- state ----------------------------------------------------------------

  private detailOf(detail: string | undefined): { detail?: string } {
    return detail ? { detail: detail.slice(0, 1000) } : {}
  }

  /** Pause plan `planId` for `reason`, unless it is past pausing; signing stops. */
  private async pause(
    planId: string,
    reason: QbitSendPlanPauseReason,
    detail?: string,
    { unexplained = false }: { unexplained?: boolean } = {}
  ): Promise<void> {
    const session = this.session(planId)
    await this.mutate(planId, record => {
      if (record.phase === 'completed' || record.phase === 'cancelling') return undefined
      if (record.phase === 'paused' && record.pause?.reason === reason) return undefined
      return {
        ...record,
        phase: 'paused',
        pause: {
          reason,
          at: this.now(),
          ...this.detailOf(detail),
          ...(unexplained ? { unexplained: true as const } : {}),
        },
      }
    })
    // A lock closes every signature batch too; the approval the next batch
    // must continue stays.
    this.endSigningSegment(session)
  }

  /**
   * Read plan `planId`, decide its next state with `change`, and write it
   * under the revision read: a write that finds a newer revision reads
   * again and decides again, so what `change` decided is never applied over
   * a state it did not see. `change` returns the next record, 'delete', or
   * nothing to leave the plan as it is. The holds follow every write.
   *
   * A plan that failed the checks of what its transactions are stays so
   * until its deletion (see `failedItsChecks`): a write that would take it
   * out of that state is not made, and the plan is left as it is, whatever
   * asked for it (a pause for another reason, a replaced merge found
   * confirmed, its payment found, a resume). Every write of a started plan
   * passes here but a revision's swap and its undoing, which need a
   * revision the plan offers, and such a plan offers none (`actionsOf`); so
   * no path shows it with its figures or moves it to a phase that signs or
   * sends, and its cancel keeps the pause while it cancels.
   */
  private async mutate(
    planId: string,
    change: (record: QbitSendPlanRecord) => QbitSendPlanRecordInput | 'delete' | undefined
  ): Promise<{ record?: QbitSendPlanRecord; deleted?: boolean; unchanged?: QbitSendPlanRecord }> {
    for (let attempt = 0; attempt < QBIT_SEND_PLAN_MUTATE_ATTEMPTS; attempt++) {
      const record = this.store.get(planId)
      if (!record) return {}
      const next = change(record)
      if (next === undefined) return { unchanged: record }
      if (next !== 'delete' && failedItsChecks(record) && !failedItsChecks(next)) {
        return { unchanged: record }
      }
      try {
        if (next === 'delete') {
          await this.store.delete(planId, record.revision)
          await this.guard.releasePlanOutpoints(planId)
          this.forget(planId, record.revision)
          return { deleted: true }
        }
        const written = await this.store.put(next, record.revision)
        await this.syncHolds(written, record)
        this.changed(written)
        return { record: written }
      } catch (error) {
        if (error instanceof QbitSendPlanStoreError && error.code === 'stale_revision') continue
        if (error instanceof QbitSendPlanStoreError && error.code === 'not_found') return {}
        throw error
      }
    }
    throw new QbitSendPlanStoreError('stale_revision')
  }

  /**
   * Let go of whatever `record` held, or `previous` (the record it was
   * written over) did, that `record` no longer needs. Releasing is all the
   * holds ever do after a start: nothing is added to them but by a start or
   * a replan, under their own conflict checks.
   */
  private async syncHolds(
    record: QbitSendPlanRecord,
    previous?: QbitSendPlanRecord
  ): Promise<void> {
    const desired = desiredHolds(record)
    const candidates = [
      ...qbitSendPlanOutpoints(record),
      ...(previous ? qbitSendPlanOutpoints(previous) : []),
    ]
    const release = [
      ...new Map(
        candidates
          .filter(outpoint => !desired.has(outpointKey(outpoint)))
          .map(outpoint => [outpointKey(outpoint), outpoint])
      ).values(),
    ]
    if (release.length > 0) await this.guard.releasePlanOutpoints(record.id, release)
    if (desired.size === 0) this.session(record.id).hold = undefined
  }

  /** A plan deleted at `revision`: its session goes, and every page hears of it. */
  private forget(planId: string, revision: number): void {
    const session = this.sessions.get(planId)
    if (session) this.firstSigningFailed(session, undefined)
    this.dropSession(planId)
    this.host.announce(planId, (revision + 1) * QBIT_SEND_PLAN_VIEW_REVISION_STRIDE)
  }

  /** After a write: the view changed, so every page hears of it. */
  private changed(record: QbitSendPlanRecord): void {
    const view = this.viewOf(record)
    this.host.announce(record.id, view.revision)
  }

  /** Recompute plan `planId`'s view, and tell the pages when it changed without a write. */
  private refreshView(planId: string): void {
    let record: QbitSendPlanRecord | undefined
    try {
      record = this.store.get(planId)
    } catch {
      return
    }
    if (!record) return
    const session = this.session(planId)
    const before = session.ticks
    const beforeRevision = session.tickRevision
    const view = this.viewOf(record)
    if (session.ticks !== before || session.tickRevision !== beforeRevision) {
      this.host.announce(planId, view.revision)
    }
  }

  /**
   * An advance ended: a plan that is not signing holds the auto-lock no
   * longer, and neither does one on a network the wallet has left, whose
   * signing stopped before its next signature. That one's batch closes as
   * well, so when the wallet is back on its network (the timer advances it
   * within a tick, a page's read at once) it opens one for what is left,
   * under its approval (see `assertContinues`), and signs on.
   */
  private settleSession(planId: string): void {
    const session = this.sessions.get(planId)
    if (!session) return
    let record: QbitSendPlanRecord | undefined
    try {
      record = this.store.get(planId)
    } catch {
      return
    }
    if (!record) {
      this.dropSession(planId)
      return
    }
    if (record.chain !== this.host.activeChain()) this.endSigningSegment(session)
    else if (record.phase !== 'signing') this.endAutoLockHold(session)
    this.refreshView(planId)
  }

  private session(planId: string): PlanSession {
    let session = this.sessions.get(planId)
    if (!session) {
      session = newSession()
      this.sessions.set(planId, session)
    }
    return session
  }

  /**
   * What a plan that failed the checks of what its transactions are shows
   * (see `failedItsChecks`): the stand-in of a plan the store cannot read
   * (`unreadableView`), under the plan's own id, with cancel, when `actions`
   * offers it, while it is paused, and nothing while it cancels.
   */
  private standInOf(
    record: QbitSendPlanRecord,
    actions: readonly QbitSendPlanAction[]
  ): Omit<QbitSendPlanView, 'revision'> {
    const { revision: _revision, ...standIn } = this.unreadableView(
      { id: record.id } as QbitSendPlanUnreadable,
      record.chain,
      record.account.address
    )
    return {
      ...standIn,
      actions: record.phase === 'paused' ? actions.filter(item => item === 'cancel') : [],
    }
  }

  /**
   * The plan as the UI shows it. Its `revision` is the record's revision
   * times `QBIT_SEND_PLAN_VIEW_REVISION_STRIDE` plus the changes shown
   * since that revision was written, so it grows with every visible change,
   * signing progress included, and never goes down: each write passes every
   * view shown before it, and a restart, which forgets the changes shown,
   * writes every plan once before showing it (see `adopt`).
   */
  viewOf(record: QbitSendPlanRecord): QbitSendPlanView {
    const session = this.session(record.id)
    if (session.tickRevision !== record.revision) {
      session.tickRevision = record.revision
      session.ticks = 0
      session.lastViewKey = undefined
    }
    const now = this.now()
    // A void replacement is shown as the earlier version that confirmed
    // instead: that is the transaction in the chain.
    // A plan completed by a transaction that is no version of its payment
    // shows that transaction as its payment, and what it paid.
    const paidBy = record.phase === 'completed' ? record.paidBy : undefined
    const payment = paymentOf(record)
    const steps: QbitSendPlanStepView[] = record.steps.map(step =>
      isVoid(step) && step.replaces
        ? {
            kind: step.kind,
            txid: step.replaces.txid,
            inputCount: step.inputs.length,
            fee: step.replaces.fee,
            status: 'confirmed',
          }
        : {
            kind: step.kind,
            txid: step === payment && paidBy ? paidBy.txid : step.txid,
            inputCount: step.inputs.length,
            fee: step === payment && paidBy ? paidBy.fee : step.fee,
            status: step.status,
          }
    )
    const signaturesTotal = record.steps.reduce((total, step) => total + step.inputs.length, 0)
    const signing =
      session.signing && record.phase === 'signing' ? { ...session.signing } : undefined
    // Each input once: every input of a transaction signed, sent, or shown
    // as the version that confirmed instead, and of one not signed yet, the
    // furthest a signing of it reached in this session. A transaction signed
    // again after a lock cut its signing short adds nothing until the new
    // signing passes where the last one stopped, so the count never goes
    // back while the session lasts.
    const signaturesDone = record.steps.reduce(
      (total, step) =>
        step.status !== 'planned' || session.signedMerges.has(step.txid) || isVoid(step)
          ? total + step.inputs.length
          : total + Math.min(step.inputs.length, session.reached.get(step.txid) ?? 0),
      0
    )
    const actions = actionsOf(record, this.host.isUnlocked(), slowMergeOf(record, now))
    // Said only with the raise it invites (`QbitSendPlanView.slowMerge`).
    const slowMerge = actions.includes('raise_merge_fee')
    const reason = pauseReasonOf(record)
    const detail = record.pause?.detail
    // Said while a version of the payment may still confirm, which is why
    // neither a cancel nor a replan is offered (`actionsOf`); a completed
    // plan has been paid, whatever version that was.
    const paymentMayConfirm = record.phase !== 'completed' && paymentVersionMayConfirm(record)
    const body: Omit<QbitSendPlanView, 'revision'> = {
      id: record.id,
      chain: record.chain,
      address: record.account.address,
      recipient: record.recipient,
      target: record.target,
      amount: paidBy ? paidBy.amount : record.amount,
      change: record.change,
      feeRate: record.feeRate,
      totalFee: record.totalFee + (record.paidFee ?? 0) + (paidBy ? paidBy.fee - payment.fee : 0),
      steps,
      sent: sentAnything(record),
      ...(paymentMayConfirm ? { paymentMayConfirm: true } : {}),
      phase: record.phase,
      ...(reason ? { pause: { reason, ...(detail ? { detail } : {}) } } : {}),
      actions,
      ...(signing ? { signing } : {}),
      signaturesDone,
      signaturesTotal,
      ...(slowMerge ? { slowMerge: true } : {}),
      paymentTxid: paidBy ? paidBy.txid : payment.txid,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
    // A plan that failed the checks of what its transactions are shows none
    // of what it states, while it is paused and while it cancels: it is shown
    // as a plan the store cannot read is (`unreadableView`), cancel the only
    // thing offered before it cancels, and nothing while it does.
    const shown = failedItsChecks(record) ? this.standInOf(record, actions) : body
    const key = JSON.stringify(shown)
    if (session.lastViewKey !== undefined && session.lastViewKey !== key) session.ticks += 1
    session.lastViewKey = key
    return {
      ...shown,
      revision: record.revision * QBIT_SEND_PLAN_VIEW_REVISION_STRIDE + session.ticks,
    }
  }
}
