import { numUtils } from '@qbit/base-utils'
import {
  qbitBroadcastErrorMessage,
  type QbitSendPlanAction,
  type QbitSendPlanPauseReason,
  type QbitSendPlanPhase,
  type QbitSendPlanPrepareRefusal,
  type QbitSendPlanReview,
  type QbitSendPlanStepStatus,
  type QbitSendPlanStepView,
  type QbitSendPlanView,
  type QbitSignatureBudgetImpact,
} from '@qbit/wallet-shared'

type Translate = (key: string, substitutions?: string | string[]) => string

const PHASES: readonly QbitSendPlanPhase[] = [
  'signing',
  'waiting',
  'sending',
  'completed',
  'paused',
  'cancelling',
]
const STEP_STATUSES: readonly QbitSendPlanStepStatus[] = [
  'planned',
  'signed',
  'unknown',
  'broadcast',
  'confirmed',
]

/**
 * Every action a plan can offer, in the order the progress screen shows
 * them: carrying on first, cancelling last. An action the background names
 * that is not here is never offered.
 */
export const QBIT_SEND_PLAN_ACTION_ORDER: readonly QbitSendPlanAction[] = [
  'continue',
  'replan',
  'raise_payment_fee',
  'raise_merge_fee',
  'dismiss',
  'cancel',
]

const PAUSE_REASONS: readonly QbitSendPlanPauseReason[] = [
  'locked',
  'interrupted',
  'merge_refused',
  'outputs_spent',
  'payment_fee_too_low',
  'payment_refused',
  'unreadable',
]

const REVISION_KINDS = ['replan', 'raise_merge_fee', 'raise_payment_fee'] as const

/** The action each pause's copy tells the user to take (`send_plan_paused_*_body`). */
const RECOMMENDED_ACTIONS: Partial<Record<QbitSendPlanPauseReason, QbitSendPlanAction>> = {
  locked: 'continue',
  interrupted: 'continue',
  merge_refused: 'replan',
  outputs_spent: 'replan',
  payment_fee_too_low: 'raise_payment_fee',
  payment_refused: 'replan',
}

/** A value read as `T` before its fields are checked: every field may be anything. */
type Unchecked<T> = { [K in keyof T]?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function readStep(value: unknown): QbitSendPlanStepView | undefined {
  if (!isRecord(value)) return undefined
  const { kind, txid, inputCount, fee, status } = value as Unchecked<QbitSendPlanStepView>
  if (kind !== 'merge' && kind !== 'payment') return undefined
  if (typeof txid !== 'string' || !isCount(inputCount) || !isCount(fee)) return undefined
  if (!STEP_STATUSES.includes(status as QbitSendPlanStepStatus)) return undefined
  return { kind, txid, inputCount, fee, status: status as QbitSendPlanStepStatus }
}

/**
 * Whether `plan` is paused `unreadable`: a stored plan the background
 * cannot read (a corrupt record, or one another version wrote), or one
 * whose stored step failed the background's check before a signature
 * (`QbitSendPlanEngine.signStep`). Read as `readQbitSendPlanView` reads it,
 * it has no recipient, amount, rate or step to show, and cancel is its only
 * action.
 */
export function isQbitSendPlanUnreadable(plan: Pick<QbitSendPlanView, 'phase' | 'pause'>): boolean {
  return plan.phase === 'paused' && plan.pause?.reason === 'unreadable'
}

/**
 * The fields of the stand-in for an unreadable stored plan, exactly as the
 * background fills them (`QbitSendPlanEngine.unreadableView`): what this
 * version could not read is empty, never a figure. A plan paused
 * `unreadable` is shown with these fields whichever view the background
 * sent for it (`withoutFigures`).
 */
function isUnreadableStandIn(v: Unchecked<QbitSendPlanView>): boolean {
  return (
    v.recipient === '' &&
    v.feeRate === 0 &&
    v.amount === 0 &&
    v.change === 0 &&
    v.totalFee === 0 &&
    Array.isArray(v.steps) &&
    v.steps.length === 0 &&
    v.sent === false &&
    v.signaturesDone === 0 &&
    v.signaturesTotal === 0 &&
    v.paymentTxid === ''
  )
}

/**
 * `plan`, paused `unreadable`, as every screen shows it: its id, account,
 * network, times and revision (which order its views), its pause, and
 * whether anything of it was sent (`sent`, the background's to say). Every
 * figure is the stand-in's empty one (`isUnreadableStandIn`), so a figure
 * of a plan that failed the background's check is never shown as if it
 * were confirmed; without them, nothing but cancel can act on it.
 */
function withoutFigures(plan: QbitSendPlanView): QbitSendPlanView {
  return {
    id: plan.id,
    chain: plan.chain,
    address: plan.address,
    recipient: '',
    target: 'amount',
    amount: 0,
    change: 0,
    feeRate: 0,
    totalFee: 0,
    steps: [],
    sent: plan.sent,
    phase: plan.phase,
    ...(plan.pause ? { pause: plan.pause } : {}),
    actions: plan.actions.filter(action => action === 'cancel'),
    signaturesDone: 0,
    signaturesTotal: 0,
    paymentTxid: '',
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    revision: plan.revision,
  }
}

/**
 * A plan as the background reported it, checked before anything is shown
 * from it: null for no plan, undefined for an answer that is not a plan.
 * Actions this version does not know are left out, so no button is ever
 * offered for one; an unknown pause reason is kept, and shown as a pause.
 * A plan has a recipient and a fee rate, except the stand-in for a stored
 * plan the background cannot read, which is read only exactly as the
 * background sends it.
 *
 * The background sends one of two views for a plan paused `unreadable`:
 * that stand-in, or a stored plan whose step failed its check before a
 * signature, with every figure its record states. The second is checked as
 * any plan is. Both are read the same way (`withoutFigures`): the pause and
 * cancel, none of the figures.
 *
 * `paymentMayConfirm` is read only as `true` or absent. The background never
 * says it of a plan paused `unreadable`, which states nothing of its
 * payment: such a view saying it is not read.
 */
export function readQbitSendPlanView(value: unknown): QbitSendPlanView | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const v = value as Unchecked<QbitSendPlanView>
  const unreadable = v.phase === 'paused' && isRecord(v.pause) && v.pause['reason'] === 'unreadable'
  const standIn = unreadable && isUnreadableStandIn(v)
  if (!isText(v.id) || !isText(v.chain) || !isText(v.address)) return undefined
  if (!standIn && !isText(v.recipient)) return undefined
  if (v.target !== 'amount' && v.target !== 'everything') return undefined
  if (!isCount(v.amount) || !isCount(v.change) || !isCount(v.totalFee)) return undefined
  if (!standIn && !isRate(v.feeRate)) return undefined
  if (!PHASES.includes(v.phase as QbitSendPlanPhase)) return undefined
  if (!Array.isArray(v.steps) || !Array.isArray(v.actions)) return undefined
  const steps: QbitSendPlanStepView[] = []
  for (const entry of v.steps as unknown[]) {
    const step = readStep(entry)
    if (!step) return undefined
    steps.push(step)
  }
  // Whether cancelling leaves anything in the network is the background's
  // to say: never guessed from steps, and never read as false when missing.
  if (typeof v.sent !== 'boolean') return undefined
  // Whether a version of the payment may still confirm, as the background
  // says it: once said, the screens never say that nothing was sent.
  if (v.paymentMayConfirm !== undefined && (v.paymentMayConfirm !== true || unreadable)) {
    return undefined
  }
  if (!isCount(v.signaturesDone) || !isCount(v.signaturesTotal)) return undefined
  if (typeof v.paymentTxid !== 'string' || !isCount(v.revision)) return undefined
  if (!isTime(v.createdAt) || !isTime(v.updatedAt)) return undefined
  const offered = v.actions as unknown[]
  const known = QBIT_SEND_PLAN_ACTION_ORDER.filter(action => offered.includes(action))
  const view: QbitSendPlanView = {
    id: v.id,
    chain: v.chain as QbitSendPlanView['chain'],
    address: v.address,
    recipient: v.recipient as string,
    target: v.target,
    amount: v.amount,
    change: v.change,
    feeRate: v.feeRate as number,
    totalFee: v.totalFee,
    steps,
    sent: v.sent,
    phase: v.phase as QbitSendPlanPhase,
    actions: known,
    signaturesDone: v.signaturesDone,
    signaturesTotal: v.signaturesTotal,
    paymentTxid: v.paymentTxid,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    revision: v.revision,
  }
  if (isRecord(v.pause)) {
    const { reason, detail } = v.pause as Unchecked<NonNullable<QbitSendPlanView['pause']>>
    if (typeof reason === 'string') {
      view.pause = {
        reason: reason as QbitSendPlanPauseReason,
        ...(typeof detail === 'string' && detail ? { detail } : {}),
      }
    }
  }
  if (isRecord(v.signing)) {
    const { step, signed, total } = v.signing as Unchecked<NonNullable<QbitSendPlanView['signing']>>
    if (isCount(step) && isCount(signed) && isCount(total)) view.signing = { step, signed, total }
  }
  if (v.slowMerge === true) view.slowMerge = true
  if (v.paymentMayConfirm === true) view.paymentMayConfirm = true
  return unreadable ? withoutFigures(view) : view
}

function readBudget(value: unknown): QbitSignatureBudgetImpact | undefined {
  if (!isRecord(value)) return undefined
  const { required, cached, remainingBefore, remainingAfter, limit, restoredFloorRisk } =
    value as Unchecked<QbitSignatureBudgetImpact>
  if (
    !isCount(required) ||
    !isCount(cached) ||
    !isCount(remainingBefore) ||
    !isCount(remainingAfter) ||
    !isCount(limit)
  ) {
    return undefined
  }
  const budget: QbitSignatureBudgetImpact = {
    required,
    cached,
    remainingBefore,
    remainingAfter,
    limit,
  }
  if (restoredFloorRisk !== undefined) {
    if (!isRecord(restoredFloorRisk)) return undefined
    const { challengeId, knownOnChainSignatures } = restoredFloorRisk as Unchecked<
      NonNullable<QbitSignatureBudgetImpact['restoredFloorRisk']>
    >
    if (!isText(challengeId) || !isCount(knownOnChainSignatures)) return undefined
    budget.restoredFloorRisk = {
      recoveryStatus: 'seed-only-restored',
      counterConfidence: 'chain-floor-only',
      knownOnChainSignatures,
      challengeId,
    }
  }
  return budget
}

/**
 * The review in a review screen's route state, checked before it is shown
 * or confirmed: route state outlives the draft it names and can come from
 * an earlier version. Undefined when it is not a whole review.
 */
export function readQbitSendPlanReview(value: unknown): QbitSendPlanReview | undefined {
  if (!isRecord(value)) return undefined
  const v = value as Unchecked<QbitSendPlanReview>
  if (!isText(v.draftId) || !isText(v.chain) || !isText(v.address) || !isText(v.recipient)) {
    return undefined
  }
  if (v.target !== 'amount' && v.target !== 'everything') return undefined
  if (!isCount(v.amount, 1) || !isCount(v.change) || !isRate(v.feeRate)) return undefined
  if (!isCount(v.totalFee) || !isCount(v.paidFee) || !isCount(v.leftBehindSatoshis)) {
    return undefined
  }
  if (!isCount(v.signatureCount) || !isTime(v.expiresAt)) return undefined
  if (
    typeof v.estimatedSigningSeconds !== 'number' ||
    !Number.isFinite(v.estimatedSigningSeconds) ||
    v.estimatedSigningSeconds < 0
  ) {
    return undefined
  }
  // A revision lists only the merges still to send, which can be none.
  if (!Array.isArray(v.merges)) return undefined
  const merges: QbitSendPlanReview['merges'] = []
  for (const entry of v.merges as unknown[]) {
    if (!isRecord(entry)) return undefined
    const merge = entry as Unchecked<QbitSendPlanReview['merges'][number]>
    if (!isCount(merge.inputCount, 1) || !isCount(merge.fee)) return undefined
    merges.push({ inputCount: merge.inputCount, fee: merge.fee })
  }
  if (!isRecord(v.payment)) return undefined
  const payment = v.payment as Unchecked<QbitSendPlanReview['payment']>
  if (!isCount(payment.inputCount, 1) || !isCount(payment.fee)) return undefined
  if (typeof payment.txid !== 'string') return undefined
  const signatureBudget = readBudget(v.signatureBudget)
  if (!signatureBudget) return undefined
  const review: QbitSendPlanReview = {
    draftId: v.draftId,
    chain: v.chain as QbitSendPlanReview['chain'],
    address: v.address,
    recipient: v.recipient,
    target: v.target,
    amount: v.amount,
    change: v.change,
    feeRate: v.feeRate,
    totalFee: v.totalFee,
    paidFee: v.paidFee,
    merges,
    payment: { inputCount: payment.inputCount, fee: payment.fee, txid: payment.txid },
    signatureCount: v.signatureCount,
    signatureBudget,
    estimatedSigningSeconds: v.estimatedSigningSeconds,
    leftBehindSatoshis: v.leftBehindSatoshis,
    expiresAt: v.expiresAt,
  }
  if (v.revises !== undefined) {
    if (!isRecord(v.revises)) return undefined
    const revises = v.revises as Unchecked<NonNullable<QbitSendPlanReview['revises']>>
    if (!isText(revises.planId)) return undefined
    if (!REVISION_KINDS.includes(revises.kind as (typeof REVISION_KINDS)[number])) return undefined
    review.revises = {
      planId: revises.planId,
      kind: revises.kind as (typeof REVISION_KINDS)[number],
    }
    if (v.previousAmount !== undefined) {
      if (!isCount(v.previousAmount)) return undefined
      review.previousAmount = v.previousAmount
    }
  }
  return review
}

/**
 * The plan a revision's review revises, as the progress screen showed it
 * when it asked for the revision: what the review is compared with.
 */
export interface QbitSendPlanRevised {
  paymentTxid: string
  feeRate: number
  /** Every fee of the plan, those an earlier version paid included, as `QbitSendPlanView.totalFee`. */
  totalFee: number
}

/**
 * The revised plan in a review screen's route state, checked as the review
 * is: undefined when it is missing or not whole.
 */
export function readQbitSendPlanRevised(value: unknown): QbitSendPlanRevised | undefined {
  if (!isRecord(value)) return undefined
  const { paymentTxid, feeRate, totalFee } = value as Unchecked<QbitSendPlanRevised>
  if (!isText(paymentTxid) || !isRate(feeRate) || !isCount(totalFee)) return undefined
  return { paymentTxid, feeRate, totalFee }
}

/**
 * Whether `plan`, read after a start that failed, is the plan starting
 * `review` made: only then did the start go through, its answer lost on the
 * way. Any other plan of the account says nothing about it: an earlier plan
 * sent and not dismissed yet, or the very plan a revision revises.
 *
 * A new plan is the one paying with the review's payment. A revision keeps
 * the plan's id and took effect once the plan carries the review's payment
 * at the review's rate. A fee raise always changes the rate, which must be
 * above the plan's; a replan can rebuild the very payment at the very rate
 * of the plan it revises (the same outputs at the same rate), and then
 * nothing read tells the plan revised from the plan started: it counts as
 * not started, as it does when the revised plan is not known.
 */
export function qbitSendPlanStartedBy(
  plan: QbitSendPlanView | null | undefined,
  review: QbitSendPlanReview,
  revised: QbitSendPlanRevised | undefined
): boolean {
  if (!plan || plan.chain !== review.chain || plan.address !== review.address) return false
  if (!isText(review.payment.txid) || plan.paymentTxid !== review.payment.txid) return false
  const revises = review.revises
  if (!revises) return true
  if (plan.id !== revises.planId || plan.feeRate !== review.feeRate) return false
  if (revises.kind !== 'replan') return true
  return (
    revised !== undefined &&
    (revised.paymentTxid !== review.payment.txid || revised.feeRate !== review.feeRate)
  )
}

/**
 * The text of a failed wallet call. The popup's wallet proxy rejects with
 * the background's error as a plain `{ message, stack }` object, so the
 * message is read from any object that has one; without one the call reads
 * as an unknown error.
 */
export function qbitSendPlanErrorMessage(error: unknown, unknownError: string): string {
  const message = qbitBroadcastErrorMessage(error)
  return message?.trim() ? message : unknownError
}

/** An amount in bits as the wallet shows amounts: the coin with eight decimals. */
export function qbitSendPlanAmount(satoshis: number): string {
  return numUtils.satoshisToAmount(satoshis)
}

/** Whole numbers grouped as the locale groups them; the app's zh_TW is Intl's zh-TW. */
export function qbitSendPlanCountFormat(locale: string): (count: number) => string {
  let format: Intl.NumberFormat
  try {
    format = new Intl.NumberFormat(locale.replace('_', '-'), { maximumFractionDigits: 0 })
  } catch {
    format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  }
  return count => format.format(count)
}

/** About how long signing takes, from an estimate in seconds. */
export function qbitSendPlanTimeText(seconds: number, t: Translate): string {
  if (!Number.isFinite(seconds) || seconds < 60) return t('send_plan_time_under_a_minute')
  return t('send_plan_time_minutes', [String(Math.round(seconds / 60))])
}

/**
 * "K to combine your funds, then the payment", with K the merges still to
 * send; a revision whose merges are all sent has only the payment left.
 */
export function qbitSendPlanStepsText(mergeCount: number, t: Translate): string {
  if (mergeCount === 0) return t('send_plan_steps_none')
  return mergeCount === 1
    ? t('send_plan_steps_one')
    : t('send_plan_steps_many', [String(mergeCount)])
}

/**
 * The buttons of the progress screen, in the order it shows them, and the
 * one that is primary: the action the plan's state tells the user to take
 * comes first and is primary (a pause's, as its copy names it; otherwise
 * the first action offered in `QBIT_SEND_PLAN_ACTION_ORDER`, such as raising
 * a slow merge's fee), then the others in that order. Cancelling and
 * dismissing are never primary. Only actions the plan offers are listed.
 */
export function qbitSendPlanActionLayout(
  plan: Pick<QbitSendPlanView, 'phase' | 'pause' | 'actions'>
): {
  actions: QbitSendPlanAction[]
  primary: QbitSendPlanAction | undefined
} {
  const offered = QBIT_SEND_PLAN_ACTION_ORDER.filter(action => plan.actions.includes(action))
  const recommended =
    plan.phase !== 'paused' || !plan.pause
      ? undefined
      : isUnexplainedPaymentRefusal(plan)
        ? 'raise_payment_fee'
        : RECOMMENDED_ACTIONS[plan.pause.reason]
  const primary =
    recommended !== undefined && offered.includes(recommended)
      ? recommended
      : offered.find(action => action !== 'cancel' && action !== 'dismiss')
  return {
    actions: primary ? [primary, ...offered.filter(action => action !== primary)] : offered,
    primary,
  }
}

/** The merges of a plan: transactions that pay the account's own address. */
export function qbitSendPlanMerges(plan: Pick<QbitSendPlanView, 'steps'>): QbitSendPlanStepView[] {
  return plan.steps.filter(step => step.kind === 'merge')
}

/**
 * Whether anything of `plan` may have reached the network, as the
 * background says (`QbitSendPlanView.sent`): a transaction of the plan, or
 * one a fee raise replaced that may still confirm, was sent or may have
 * been. Never inferred from the steps the view lists: a raised merge's
 * replacement is listed as not signed while the merge it replaces is in
 * the network.
 */
export function qbitSendPlanSentAnything(plan: Pick<QbitSendPlanView, 'sent'>): boolean {
  return plan.sent
}

/**
 * Whether the screens say that a version of `plan`'s payment, which left the
 * wallet without an answer, may still go through: the background says so
 * (`QbitSendPlanView.paymentMayConfirm`) of a readable plan that has not
 * completed. While it may, no copy says that nothing was sent, that the
 * payment was not sent, or that it can be cancelled or reviewed again.
 */
export function qbitSendPlanPaymentMayConfirm(
  plan: Pick<QbitSendPlanView, 'paymentMayConfirm' | 'phase' | 'pause'>
): boolean {
  return (
    plan.paymentMayConfirm === true && plan.phase !== 'completed' && !isQbitSendPlanUnreadable(plan)
  )
}

/**
 * Where a paused or cancelled plan leaves the user's funds. Nothing reaches
 * the recipient before the payment, so every case says so, except while a
 * version of the payment may still go through (`qbitSendPlanPaymentMayConfirm`):
 * then the funds it uses are held for it. Funds the plan has sent anything
 * of (`qbitSendPlanSentAnything`) are not as they were, even when the plan
 * lists no merge of its own now.
 */
export function qbitSendPlanFundsText(
  plan: Pick<QbitSendPlanView, 'steps' | 'sent' | 'paymentMayConfirm' | 'phase' | 'pause'>,
  t: Translate
): string {
  const merges = qbitSendPlanMerges(plan)
  const combined = merges.length > 0 && merges.every(step => step.status === 'confirmed')
  if (qbitSendPlanPaymentMayConfirm(plan)) {
    if (merges.length === 0) return t('send_plan_may_confirm_funds_held')
    return combined
      ? t('send_plan_may_confirm_funds_combined')
      : t('send_plan_may_confirm_funds_partly_combined')
  }
  if (!qbitSendPlanSentAnything(plan)) return t('send_plan_funds_untouched')
  if (combined) return t('send_plan_funds_combined')
  return t('send_plan_funds_partly_combined')
}

/**
 * While a version of `plan`'s payment may still go through
 * (`qbitSendPlanPaymentMayConfirm`): what the user can do about it, naming
 * only the actions the plan offers (raising the payment's fee, which comes
 * first as the primary button, and sending the same payment again), neither
 * of which can pay the recipient twice. Empty when the plan offers neither,
 * or when no version may go through.
 */
export function qbitSendPlanMayConfirmNext(
  plan: Pick<QbitSendPlanView, 'paymentMayConfirm' | 'phase' | 'pause' | 'actions'>,
  t: Translate
): string {
  if (!qbitSendPlanPaymentMayConfirm(plan)) return ''
  const resend = plan.actions.includes('continue')
  const raise = plan.actions.includes('raise_payment_fee')
  if (resend && raise) return t('send_plan_may_confirm_raise_or_continue')
  if (resend) return t('send_plan_may_confirm_continue')
  if (raise) return t('send_plan_may_confirm_raise')
  return ''
}

/**
 * Whether `plan` paused on a payment the network refused without saying
 * why: the explorer relays a node refusal as an RPC code only, so the
 * background cannot tell a fee refusal apart and offers the fee raise.
 */
function isUnexplainedPaymentRefusal(plan: Pick<QbitSendPlanView, 'pause' | 'actions'>): boolean {
  return plan.pause?.reason === 'payment_refused' && plan.actions.includes('raise_payment_fee')
}

/**
 * The title and the explanation of `plan`'s pause (`qbitSendPlanPauseText`).
 * A payment refused without a reason says that a fee too low is the usual
 * cause, and that raising the fee sends it. Whatever the plan paused for,
 * while a version of its payment may still go through
 * (`qbitSendPlanPaymentMayConfirm`) it says that instead: a pause's own copy
 * may say that the payment was not sent, or offer a review again or a
 * cancel, which the plan does not offer then.
 */
export function qbitSendPlanPauseCopy(
  plan: Pick<QbitSendPlanView, 'pause' | 'actions' | 'paymentMayConfirm' | 'phase'>,
  t: Translate
): { title: string; body: string } {
  if (qbitSendPlanPaymentMayConfirm(plan)) {
    return { title: t('send_plan_may_confirm_title'), body: t('send_plan_may_confirm_body') }
  }
  if (isUnexplainedPaymentRefusal(plan)) {
    return {
      title: t('send_plan_paused_payment_refused_unexplained'),
      body: t('send_plan_paused_payment_refused_unexplained_body'),
    }
  }
  return qbitSendPlanPauseText(plan.pause?.reason, t)
}

/** The title and the explanation of a pause; an unknown reason reads as a plain pause. */
export function qbitSendPlanPauseText(
  reason: string | undefined,
  t: Translate
): { title: string; body: string } {
  if (PAUSE_REASONS.includes(reason as QbitSendPlanPauseReason)) {
    return {
      title: t(`send_plan_paused_${reason}`),
      body: t(`send_plan_paused_${reason}_body`),
    }
  }
  return { title: t('send_plan_paused_other'), body: '' }
}

/**
 * One line on where an open plan stands, for the home screen's card; in
 * every phase while a version of its payment may still go through
 * (`qbitSendPlanPaymentMayConfirm`), that it may, and that the recipient is
 * not to be paid another way.
 */
export function qbitSendPlanStatusLine(
  plan: QbitSendPlanView,
  t: Translate,
  formatCount: (count: number) => string
): string {
  if (qbitSendPlanPaymentMayConfirm(plan)) return t('send_plan_status_may_confirm')
  const merges = qbitSendPlanMerges(plan)
  switch (plan.phase) {
    case 'signing':
      return t('send_plan_status_signing', [
        formatCount(plan.signaturesDone),
        formatCount(plan.signaturesTotal),
      ])
    case 'waiting':
      return t('send_plan_status_waiting', [
        String(merges.filter(step => step.status === 'confirmed').length),
        String(merges.length),
      ])
    case 'sending':
      return t('send_plan_status_sending')
    case 'completed':
      return t('send_plan_status_sent')
    case 'cancelling':
      return t('send_plan_cancelling_body')
    default:
      return qbitSendPlanPauseCopy(plan, t).title
  }
}

/**
 * Why a plan could not be prepared, in words for the user; empty for a
 * refusal that has no text of its own (`not_needed`).
 */
export function qbitSendPlanRefusalText(reason: QbitSendPlanPrepareRefusal, t: Translate): string {
  switch (reason) {
    case 'insufficient_balance':
      return t('send_plan_short_of_fees')
    case 'exceeds_plan_size':
      return t('send_plan_exceeds_plan_size')
    case 'exceeds_maximum_total_fee':
      return t('send_plan_exceeds_maximum_fee')
    case 'nothing_to_send':
      return t('send_plan_nothing_to_send')
    case 'plan_open':
      return t('send_plan_already_open')
    case 'outputs_unavailable':
      return t('send_plan_outputs_unavailable')
    default:
      return ''
  }
}
