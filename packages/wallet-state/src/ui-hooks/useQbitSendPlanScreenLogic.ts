import { useEffect, useRef, useState } from 'react'

import {
  FeeRateType,
  QBIT_SEND_PLAN_SECONDS_PER_TRANSACTION,
  estimateQbitSendPlanSigningSeconds,
  isQbitFeeRateWithinPolicy,
  isQbitSendPlanAmount,
  type QbitSendPlanAction,
  type QbitSendPlanPrepareParams,
  type QbitSendPlanRevision,
  type QbitSendPlanView,
} from '@qbit/wallet-shared'

import { useI18n } from '../context/I18nContext'
import { useNavigation } from '../context/NavigationContext'
import { useWallet } from '../context/WalletContext'
import { useQbitSendPlan } from '../hooks/sendPlan'
import { useQbitUnit } from '../hooks/settings'
import { useFeeRateBar, useUpdateFeeRateBar } from '../hooks/ui'
import { formatFeeRate } from '../utils/fee-rate-text'
import {
  isQbitSendPlanUnreadable,
  qbitSendPlanActionLayout,
  qbitSendPlanAmount,
  qbitSendPlanCountFormat,
  qbitSendPlanErrorMessage,
  qbitSendPlanFundsText,
  qbitSendPlanMayConfirmNext,
  qbitSendPlanMerges,
  qbitSendPlanPauseCopy,
  qbitSendPlanPaymentMayConfirm,
  qbitSendPlanRefusalText,
  qbitSendPlanSentAnything,
} from '../utils/qbit-send-plan'
import {
  feeRateBelowMinimumError,
  useFeeQuoteRead,
  useFeeRateSettled,
  type FeeQuoteState,
} from './useFeeRateBarLogic'

export type QbitSendPlanStageState = 'done' | 'active' | 'pending'

export interface QbitSendPlanStage {
  key: 'signing' | 'combining' | 'paying' | 'done'
  label: string
  state: QbitSendPlanStageState
  /** Counts for the stage, such as signatures done of the total. */
  detail?: string
}

export interface QbitSendPlanSigningView {
  /** Signatures done of the total, from 0 to 100. */
  percent: number
  count: string
  /** Which transaction of the plan is signing, when known. */
  transaction?: string
  timeLeft?: string
}

export interface QbitSendPlanButton {
  action: QbitSendPlanAction
  text: string
  primary: boolean
  onClick: () => void
}

type Translate = (key: string, substitutions?: string | string[]) => string

/** The fee-rate choice before a revision (a fee raise, or a new plan) is prepared for review. */
export interface QbitSendPlanRaiseDialog {
  title: string
  body: string
  feeQuote: FeeQuoteState
  /** Why the rate chosen is refused, when it is a Custom rate below the floor. */
  error: string
  canReview: boolean
  reviewText: string
  closeText: string
  onReview: () => void
  onClose: () => void
}

/** A card on where the plan stands: what happened, what the user can do now, and where the funds are. */
export interface QbitSendPlanNotice {
  title: string
  body: string
  /** What the user can do now, when `body` does not say it; empty otherwise. */
  next: string
  /** Where the funds are; empty when that is not known. */
  funds: string
}

/** What cancelling does, asked before the plan is cancelled. */
export interface QbitSendPlanCancelDialog {
  title: string
  body: string
  keepText: string
  confirmText: string
  onConfirm: () => void
  onClose: () => void
}

/** Until the plan is known: none read yet, or the read failed. */
export interface QbitSendPlanScreenWaiting {
  ready: false
  t: Translate
  loading: boolean
  readFailedText: string
  onClickBack: () => void
}

export interface QbitSendPlanScreenReady {
  ready: true
  t: Translate
  plan: QbitSendPlanView
  readFailedText: string
  title: string
  /**
   * Exactly what the recipient receives, with the unit; empty, as are
   * `recipient` and `fee`, for a stored plan the background cannot read.
   */
  amount: string
  recipient: string
  /**
   * The plan's total fee with the unit, and its rate. With `recipient` and
   * `amount` these are the terms the user confirmed; all three show in
   * every state of a readable plan, so they are in view before Continue or
   * any other action that leads to a signature. After a restart signing
   * waits for Continue, and that is where a stored plan that is not what
   * the user confirmed can be noticed.
   */
  fee: string
  /** None for a stored plan the background cannot read. */
  stages: QbitSendPlanStage[]
  /** While signing: how far it has got. */
  signing: QbitSendPlanSigningView | undefined
  /** What the user may do now: close the window, or wait. */
  note: string
  slowMerge: string
  /**
   * While the plan is paused: why, and what to do. While a version of its
   * payment may still go through (`qbitSendPlanPaymentMayConfirm`), that,
   * whatever it paused for.
   */
  pause: (QbitSendPlanNotice & { detail: string }) | undefined
  /**
   * While the plan is not paused and a version of its payment may still go
   * through: the notice a paused plan shows in `pause`.
   */
  mayConfirm: QbitSendPlanNotice | undefined
  /** While cancelling; `funds` is empty while `mayConfirm` says where they are. */
  cancelling: { title: string; body: string; funds: string } | undefined
  /** Exactly the actions the plan offers, the primary one first (`qbitSendPlanActionLayout`). */
  buttons: QbitSendPlanButton[]
  /** The action running, if one is. */
  busy: QbitSendPlanAction | null
  actionError: string
  raiseDialog: QbitSendPlanRaiseDialog | undefined
  /** The rate of a new plan for the same payment, any within the policy, before it is prepared. */
  replanDialog: QbitSendPlanRaiseDialog | undefined
  cancelDialog: QbitSendPlanCancelDialog | undefined
  onClickBack: () => void
}

export type QbitSendPlanScreenLogic = QbitSendPlanScreenWaiting | QbitSendPlanScreenReady

type RaiseKind = 'raise_merge_fee' | 'raise_payment_fee'

type Dialog = { kind: 'cancel' | 'replan' | RaiseKind; planId: string }

// Signatures timed before the measured pace replaces the estimate.
const MIN_TIMED_SIGNATURES = 3

const ACTION_TEXT: Record<QbitSendPlanAction, string> = {
  continue: 'continue',
  replan: 'send_plan_action_replan',
  raise_merge_fee: 'send_plan_action_raise_merge_fee',
  raise_payment_fee: 'send_plan_action_raise_payment_fee',
  cancel: 'send_plan_action_cancel',
  dismiss: 'send_plan_action_dismiss',
}

/** Transactions of the plan not signed yet: what the time left still has to sign. */
function unsignedTransactions(plan: QbitSendPlanView): number {
  return plan.steps.filter(step => step.status === 'planned').length
}

/**
 * The signer's pace as this page measured it, by its own clock: the plan's
 * `updatedAt` moves only when the record is written, not as it signs.
 */
interface SigningPace {
  planId: string
  /** The count last seen and the transaction signing then, when known. */
  signed: number
  step: number | undefined
  /** When this page saw that count or that transaction start; unknown for the count first seen. */
  at: number | undefined
  /** Signatures seen made within one transaction, and the time they took. */
  timedSignatures: number
  timedMs: number
}

/**
 * The pace once this page saw `signed` signatures done at `now`, with
 * transaction `step` signing. Only the time between two counts of the same
 * transaction is timed: the time between two transactions (finalizing and
 * sending one, starting the next) is not signing, and the time left counts
 * it per transaction instead. Counts that go back, another plan, or a clock
 * that goes back start the measure again.
 */
function nextSigningPace(
  current: SigningPace | undefined,
  planId: string,
  signed: number,
  step: number | undefined,
  now: number
): SigningPace {
  if (
    !current ||
    current.planId !== planId ||
    signed < current.signed ||
    (current.at !== undefined && now < current.at)
  ) {
    return { planId, signed, step, at: undefined, timedSignatures: 0, timedMs: 0 }
  }
  if (signed === current.signed) {
    return current.step === step ? current : { ...current, step, at: now }
  }
  const timed = current.at !== undefined && current.step === step
  return {
    planId,
    signed,
    step,
    at: now,
    timedSignatures: current.timedSignatures + (timed ? signed - current.signed : 0),
    timedMs: current.timedMs + (timed && current.at !== undefined ? now - current.at : 0),
  }
}

/**
 * The progress of the selected account's send plan (#188), which the
 * background runs whether or not this screen is open: leaving it stops
 * nothing. A plan that completed hands over to the success screen for the
 * payment's transaction id; without a plan the screen goes home.
 *
 * The buttons are exactly the actions the plan offers. Every action runs
 * once at a time, and only while the plan shown still offers it: a dialog
 * opened for a plan that has moved on since, to another plan or to a state
 * without that action, closes without acting. A call that fails, whatever
 * it may have done, is followed by a read of the plan, which shows where it
 * stands.
 */
export function useQbitSendPlanScreenLogic(): QbitSendPlanScreenLogic {
  const { t, locale } = useI18n()
  const nav = useNavigation()
  const wallet = useWallet()
  const qbitUnit = useQbitUnit()
  const { plan, readFailed, refresh, apply } = useQbitSendPlan()
  const formatCount = qbitSendPlanCountFormat(locale)

  const planRef = useRef(plan)
  planRef.current = plan
  const mountedRef = useRef(true)
  useEffect(() => {
    return (): void => {
      mountedRef.current = false
    }
  }, [])

  // Once: the screen hands over for a plan that completed, and goes home
  // when there is none.
  const leftRef = useRef(false)
  const noPlan = plan === null
  const completedTxid = plan?.phase === 'completed' ? plan.paymentTxid : undefined
  const completedPlanId = plan?.phase === 'completed' ? plan.id : undefined
  useEffect(() => {
    if (leftRef.current) return
    if (noPlan) {
      leftRef.current = true
      nav.replace('MainScreen')
    } else if (completedPlanId !== undefined && completedTxid !== undefined) {
      leftRef.current = true
      nav.replace('TxSuccessScreen', { txid: completedTxid, sendPlanId: completedPlanId })
    }
  }, [nav, noPlan, completedPlanId, completedTxid])

  // The signer's pace, from the counts this page sees change while the plan
  // signs, timed when it sees them.
  const [pace, setPace] = useState<SigningPace>()
  const signingPlanId = plan?.phase === 'signing' ? plan.id : undefined
  const signaturesDone = plan?.signaturesDone
  const signingStep = plan?.signing?.step
  useEffect(() => {
    if (signingPlanId === undefined || signaturesDone === undefined) {
      setPace(undefined)
      return
    }
    const now = Date.now()
    setPace(current => nextSigningPace(current, signingPlanId, signaturesDone, signingStep, now))
  }, [signingPlanId, signaturesDone, signingStep])

  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState<QbitSendPlanAction | null>(null)
  const busyRef = useRef(false)
  const [actionError, setActionError] = useState('')

  // The rate a raise-fee or replan dialog chooses, from the fee bar it
  // shows. Its quote is read only while such a dialog is open.
  const raising = dialog?.kind === 'raise_merge_fee' || dialog?.kind === 'raise_payment_fee'
  const choosingRate = raising || dialog?.kind === 'replan'
  const feeQuote = useFeeQuoteRead(choosingRate)
  const feeRateBar = useFeeRateBar()
  const updateFeeRateBar = useUpdateFeeRateBar()
  const raiseRate = feeRateBar.feeRate
  const [checkedRaiseRate, setCheckedRaiseRate] = useState<number | undefined>(undefined)
  useEffect(() => {
    setCheckedRaiseRate(raiseRate)
  }, [raiseRate])
  const raiseRateSettled = useFeeRateSettled(feeQuote, checkedRaiseRate)
  const raiseRateError = choosingRate ? feeRateBelowMinimumError(feeRateBar, t) : ''

  const offers = (planId: string, action: QbitSendPlanAction): boolean => {
    const current = planRef.current
    return Boolean(current && current.id === planId && current.actions.includes(action))
  }

  /** Run `work` for `action` once at a time, while the plan shown still offers it. */
  const run = async (
    action: QbitSendPlanAction,
    planId: string,
    work: () => Promise<void>
  ): Promise<void> => {
    if (busyRef.current) return
    if (!offers(planId, action)) {
      setDialog(null)
      return
    }
    busyRef.current = true
    setBusy(action)
    setActionError('')
    try {
      await work()
    } catch (error) {
      if (mountedRef.current) setActionError(qbitSendPlanErrorMessage(error, t('unknown_error')))
      // The call may have changed the plan before it failed.
      refresh()
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(null)
    }
  }

  /**
   * Prepare a revision of the plan for review: the same recipient and
   * target, at `feeRate`. The review opens only while the plan shown is the
   * one the revision was asked for.
   */
  const prepareRevision = async (revise: QbitSendPlanRevision, feeRate: number): Promise<void> => {
    const current = planRef.current
    if (!current || current.id !== revise.planId) return
    // Checked as the background checks them: the arguments cross a JSON port.
    if (
      !isQbitFeeRateWithinPolicy(feeRate) ||
      (current.target === 'amount' && !isQbitSendPlanAmount(current.amount))
    ) {
      setActionError(t('send_plan_revise_refused'))
      return
    }
    const params: QbitSendPlanPrepareParams = {
      to: current.recipient,
      target:
        current.target === 'everything'
          ? { kind: 'everything' }
          : { kind: 'amount', amount: current.amount },
      feeRate,
      revise,
    }
    const result = await wallet.prepareQbitSendPlan(params)
    const shown = planRef.current
    if (!mountedRef.current || !shown || shown.id !== revise.planId) return
    // `in` narrows the result here, where this package compiles without strict null checks.
    if ('review' in result) {
      setDialog(null)
      // The review is compared with the plan it revises, as shown now.
      nav.navigate('QbitSendPlanReviewScreen', {
        review: result.review,
        revised: {
          paymentTxid: shown.paymentTxid,
          feeRate: shown.feeRate,
          totalFee: shown.totalFee,
        },
      })
      return
    }
    // The rate cannot replace what the network already holds: name the lowest that can.
    const { minimumFeeRate } = result
    if (result.reason === 'fee_rate_too_low' && isQbitFeeRateWithinPolicy(minimumFeeRate)) {
      setActionError(t('send_plan_fee_rate_too_low', [String(minimumFeeRate)]))
      return
    }
    setActionError(qbitSendPlanRefusalText(result.reason, t) || t('send_plan_revise_refused'))
  }

  const onClickAction = (action: QbitSendPlanAction): void => {
    const current = planRef.current
    if (!current || busyRef.current || !current.actions.includes(action)) return
    const planId = current.id
    switch (action) {
      case 'continue':
        void run(action, planId, async () => {
          await apply(
            () => wallet.continueQbitSendPlan(planId),
            view => view
          )
        })
        return
      case 'replan':
        // The same outputs at the same rate make the same transactions, which
        // may meet the same refusal: the rate is chosen first, starting from
        // the plan's own, as a rate of the user's own.
        setActionError('')
        updateFeeRateBar({
          feeOptionIndex: FeeRateType.CUSTOM,
          feeRateInputVal: String(current.feeRate),
          feeRate: current.feeRate,
          showCustomInput: true,
        })
        setDialog({ kind: action, planId })
        return
      case 'dismiss':
        void run(action, planId, async () => {
          await wallet.dismissQbitSendPlan(planId)
          if (mountedRef.current && !leftRef.current) {
            leftRef.current = true
            nav.replace('MainScreen')
          }
        })
        return
      case 'cancel':
      case 'raise_merge_fee':
      case 'raise_payment_fee':
        setActionError('')
        setDialog({ kind: action, planId })
        return
      default:
        return
    }
  }

  const onConfirmCancel = (): void => {
    if (dialog?.kind !== 'cancel') return
    const { planId } = dialog
    void run('cancel', planId, async () => {
      await apply(
        () => wallet.cancelQbitSendPlan(planId),
        view => view
      )
      if (mountedRef.current) setDialog(null)
    })
  }

  const raiseRateAccepted =
    plan !== undefined &&
    plan !== null &&
    raiseRateSettled &&
    raiseRateError === '' &&
    isQbitFeeRateWithinPolicy(raiseRate) &&
    raiseRate > plan.feeRate

  const onConfirmRaise = (): void => {
    if (dialog?.kind !== 'raise_merge_fee' && dialog?.kind !== 'raise_payment_fee') return
    if (!raiseRateAccepted) return
    const { kind, planId } = dialog
    const feeRate = raiseRate
    void run(kind, planId, () => prepareRevision({ planId, kind }, feeRate))
  }

  // A new plan may take any rate within the policy, the plan's own or a lower one included.
  const replanRateAccepted =
    raiseRateSettled && raiseRateError === '' && isQbitFeeRateWithinPolicy(raiseRate)

  const onConfirmReplan = (): void => {
    if (dialog?.kind !== 'replan' || !replanRateAccepted) return
    const { planId } = dialog
    const feeRate = raiseRate
    void run('replan', planId, () => prepareRevision({ planId, kind: 'replan' }, feeRate))
  }

  const onCloseDialog = (): void => {
    if (!busyRef.current) setDialog(null)
  }

  // A dialog for a plan that moved on closes by itself.
  useEffect(() => {
    if (dialog && !busyRef.current && !offers(dialog.planId, dialog.kind)) setDialog(null)
  }, [dialog, plan])

  const onClickBack = (): void => {
    nav.navigate('MainScreen')
  }

  if (!plan) {
    return {
      ready: false,
      t,
      loading: !readFailed,
      readFailedText: readFailed ? t('send_plan_read_failed') : '',
      onClickBack,
    }
  }

  // A stored plan the background cannot read has no figures: none is shown
  // as if it were the plan's.
  const unreadable = isQbitSendPlanUnreadable(plan)
  const merges = qbitSendPlanMerges(plan)
  const mergesConfirmed = merges.filter(step => step.status === 'confirmed').length
  const signingDone =
    plan.phase === 'waiting' ||
    plan.phase === 'sending' ||
    plan.phase === 'completed' ||
    (plan.signaturesTotal > 0 && plan.signaturesDone >= plan.signaturesTotal)
  const combiningDone = merges.length > 0 && mergesConfirmed === merges.length

  const stageState = (done: boolean, active: boolean): QbitSendPlanStageState =>
    done ? 'done' : active ? 'active' : 'pending'
  const stages: QbitSendPlanStage[] = [
    {
      key: 'signing',
      label: t('send_plan_stage_signing'),
      state: stageState(signingDone, plan.phase === 'signing'),
      detail: t('send_plan_signatures_progress', [
        formatCount(plan.signaturesDone),
        formatCount(plan.signaturesTotal),
      ]),
    },
  ]
  if (merges.length > 0) {
    stages.push({
      key: 'combining',
      label: t('send_plan_stage_combining'),
      state: stageState(
        combiningDone,
        plan.phase === 'waiting' ||
          merges.some(step => step.status === 'broadcast' || step.status === 'unknown')
      ),
      detail: t('send_plan_combine_progress', [String(mergesConfirmed), String(merges.length)]),
    })
  }
  stages.push(
    {
      key: 'paying',
      label: t('send_plan_stage_paying'),
      state: stageState(plan.phase === 'completed', plan.phase === 'sending'),
    },
    { key: 'done', label: t('send_plan_stage_done'), state: stageState(false, false) }
  )

  let signing: QbitSendPlanSigningView | undefined
  if (plan.phase === 'signing') {
    const total = plan.signaturesTotal
    const done = Math.min(plan.signaturesDone, total)
    const unsigned = unsignedTransactions(plan)
    // The signatures left at the pace measured, and the time each
    // transaction left adds on top of its signatures; until the pace is
    // measured, the estimate the review gave for what is left.
    const measured =
      pace?.planId === plan.id && pace.timedSignatures >= MIN_TIMED_SIGNATURES && pace.timedMs > 0
        ? (pace.timedMs / pace.timedSignatures) * (total - done) +
          unsigned * QBIT_SEND_PLAN_SECONDS_PER_TRANSACTION * 1000
        : undefined
    const remainingMs =
      measured ?? estimateQbitSendPlanSigningSeconds(total - done, unsigned) * 1000
    const step = plan.signing?.step
    signing = {
      percent: total > 0 ? (done / total) * 100 : 0,
      count: t('send_plan_signatures_progress', [formatCount(done), formatCount(total)]),
      ...(step !== undefined && plan.steps.length > 1
        ? {
            transaction: t('signing_progress_transaction', [
              String(Math.min(step + 1, plan.steps.length)),
              String(plan.steps.length),
            ]),
          }
        : {}),
      timeLeft:
        remainingMs < 60_000
          ? t('signing_progress_under_a_minute')
          : t('signing_progress_minutes_left', String(Math.round(remainingMs / 60_000))),
    }
  }

  // While a version of the payment may still go through, every state says
  // so, in place of anything that says nothing was sent.
  const mayConfirm = qbitSendPlanPaymentMayConfirm(plan)
  const next = qbitSendPlanMayConfirmNext(plan, t)

  // Where the funds of a plan that cannot be read are is not known either.
  const pause =
    plan.phase === 'paused'
      ? {
          ...qbitSendPlanPauseCopy(plan, t),
          next,
          funds: unreadable ? '' : qbitSendPlanFundsText(plan, t),
          detail: plan.pause?.detail ?? '',
        }
      : undefined

  const mayConfirmNotice: QbitSendPlanNotice | undefined =
    mayConfirm && plan.phase !== 'paused'
      ? {
          title: t('send_plan_may_confirm_title'),
          body: t('send_plan_may_confirm_body'),
          next,
          funds: qbitSendPlanFundsText(plan, t),
        }
      : undefined

  const cancelling =
    plan.phase === 'cancelling'
      ? {
          title: t('send_plan_cancelling_title'),
          body: t('send_plan_cancelling_body'),
          funds: mayConfirmNotice ? '' : qbitSendPlanFundsText(plan, t),
        }
      : undefined

  const note =
    plan.phase === 'signing'
      ? t('send_plan_signing_close_note')
      : plan.phase === 'waiting'
        ? t('send_plan_waiting_note')
        : ''

  const layout = qbitSendPlanActionLayout(plan)
  const buttons: QbitSendPlanButton[] = layout.actions.map(action => ({
    action,
    text: t(ACTION_TEXT[action]),
    primary: action === layout.primary,
    onClick: () => onClickAction(action),
  }))

  const raiseDialog: QbitSendPlanRaiseDialog | undefined =
    dialog && (dialog.kind === 'raise_merge_fee' || dialog.kind === 'raise_payment_fee')
      ? {
          title: t('send_plan_raise_title'),
          body: t('send_plan_raise_body', [formatFeeRate(plan.feeRate)]),
          feeQuote,
          error: raiseRateError,
          canReview: raiseRateAccepted && busy === null,
          reviewText: t('next'),
          closeText: t('back'),
          onReview: onConfirmRaise,
          onClose: onCloseDialog,
        }
      : undefined

  const replanDialog: QbitSendPlanRaiseDialog | undefined =
    dialog?.kind === 'replan'
      ? {
          title: t('send_plan_replan_title'),
          body: t('send_plan_replan_body', [formatFeeRate(plan.feeRate)]),
          feeQuote,
          error: raiseRateError,
          canReview: replanRateAccepted && busy === null,
          reviewText: t('next'),
          closeText: t('back'),
          onReview: onConfirmReplan,
          onClose: onCloseDialog,
        }
      : undefined

  const cancelDialog: QbitSendPlanCancelDialog | undefined =
    dialog?.kind === 'cancel'
      ? {
          title: t('send_plan_cancel_title'),
          // What cancelling does depends on what was sent; of a plan that
          // cannot be read nothing is known, and only the general words hold.
          body:
            unreadable || qbitSendPlanSentAnything(plan)
              ? t('send_plan_cancel_body')
              : t('send_plan_cancel_body_untouched'),
          keepText: t('send_plan_cancel_keep'),
          confirmText: t('send_plan_action_cancel'),
          onConfirm: onConfirmCancel,
          onClose: onCloseDialog,
        }
      : undefined

  return {
    ready: true,
    t,
    plan,
    readFailedText: readFailed ? t('send_plan_read_failed') : '',
    title: t('send_plan_header'),
    amount: unreadable ? '' : `${qbitSendPlanAmount(plan.amount)} ${qbitUnit}`,
    recipient: unreadable ? '' : plan.recipient,
    fee: unreadable
      ? ''
      : t('send_plan_fee_summary', [
          qbitSendPlanAmount(plan.totalFee),
          qbitUnit,
          formatFeeRate(plan.feeRate),
        ]),
    stages: unreadable ? [] : stages,
    signing,
    note,
    slowMerge: plan.slowMerge === true ? t('send_plan_slow_merge') : '',
    pause,
    mayConfirm: mayConfirmNotice,
    cancelling,
    buttons,
    busy,
    actionError,
    raiseDialog,
    replanDialog,
    cancelDialog,
    onClickBack,
  }
}
