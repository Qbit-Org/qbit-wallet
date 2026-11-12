import { useEffect, useRef, useState } from 'react'

import type { QbitSendPlanReview, QbitSignatureBudgetImpact } from '@qbit/wallet-shared'

import { useI18n } from '../context/I18nContext'
import { useNavigation } from '../context/NavigationContext'
import { useTools } from '../context/ToolsContext'
import { useWallet } from '../context/WalletContext'
import { useCurrentAccount } from '../hooks/accounts'
import { useChainType, useQbitUnit } from '../hooks/settings'
import {
  qbitSendPlanAmount,
  qbitSendPlanCountFormat,
  qbitSendPlanErrorMessage,
  qbitSendPlanStartedBy,
  qbitSendPlanStepsText,
  qbitSendPlanTimeText,
  readQbitSendPlanReview,
  readQbitSendPlanRevised,
  readQbitSendPlanView,
} from '../utils/qbit-send-plan'

// Timers wait at most this long, so a far-off expiry is checked again
// rather than overflowing the timer's range.
const MAX_EXPIRY_WAIT_MS = 60_000

type Translate = (key: string, substitutions?: string | string[]) => string

/** A route state that holds no whole review: the screen can only be left. */
export interface QbitSendPlanReviewUnavailable {
  ready: false
  t: Translate
  unavailableText: string
  onClickReject: () => void
}

export interface QbitSendPlanReviewReady {
  ready: true
  t: Translate
  review: QbitSendPlanReview
  title: string
  recipient: string
  /** Exactly what the recipient receives, with the unit. */
  receives: string
  /** "K to combine your funds, then the payment." */
  transactions: string
  totalFee: string
  /** What comes back to the account, with the unit; empty without change. */
  change: string
  /** The signatures it uses and about how long signing takes. */
  signing: string
  /** The signatures left before and after the plan. */
  budget: string
  note: string
  /** For a revision of a confirmed plan: what changes. */
  revision: { title: string; lines: string[] } | undefined
  restoredFloorRisk: QbitSignatureBudgetImpact['restoredFloorRisk']
  riskAccepted: boolean
  onRiskAcceptedChange: (accepted: boolean) => void
  /** Why the review can no longer be confirmed: it expired, or is for another account. */
  unusableText: string
  planOpenText: string
  error: string
  confirming: boolean
  canConfirm: boolean
  onClickReject: () => void
  onClickConfirm: () => Promise<void>
  onClickViewPlan: () => void
}

export type QbitSendPlanReviewScreenLogic = QbitSendPlanReviewUnavailable | QbitSendPlanReviewReady

/**
 * The one review of a send plan (#188) and its one confirmation. The review
 * comes from the screen's route state and is checked first: one that is
 * not whole, that names another account or network than the selected ones,
 * or whose time is up (`expiresAt`), can only be left.
 *
 * Confirm runs once: a second tap while it runs does nothing, and once the
 * plan has started the screen replaces itself with the progress screen, so
 * Back cannot confirm it again. With the restored-floor warning, the user's
 * acknowledgement is required and confirmed with the background before the
 * plan starts, as the single-send confirm screen does; that acknowledgement
 * covers the whole plan, so continuing it later asks for none. A start that
 * fails may still have started the plan, its answer lost on the way, so
 * the plan is read before Confirm is offered again, and the screen goes to
 * it only when it is the plan this review started
 * (`qbitSendPlanStartedBy`): never for an earlier plan left completed, nor
 * for the plan a revision revises as it was. Otherwise the failure's own
 * message shows, such as the coded refusal of an account whose
 * restored-floor confirmation is missing, and Confirm can be tried again: a
 * draft that did start answers a second start as expired, never with a
 * second plan. A failed restored-floor confirmation started nothing.
 */
export function useQbitSendPlanReviewScreenLogic(): QbitSendPlanReviewScreenLogic {
  const { t, locale } = useI18n()
  const nav = useNavigation()
  const wallet = useWallet()
  const tools = useTools()
  const qbitUnit = useQbitUnit()
  const chainType = useChainType()
  const currentAccount = useCurrentAccount()
  const routeState = nav.getRouteState<'QbitSendPlanReviewScreen'>()
  const review = readQbitSendPlanReview(routeState?.review)
  const revised = review?.revises ? readQbitSendPlanRevised(routeState?.revised) : undefined

  const [now, setNow] = useState(() => Date.now())
  const expiresAt = review?.expiresAt
  useEffect(() => {
    if (expiresAt === undefined) return undefined
    const wait = expiresAt - Date.now()
    if (wait <= 0) {
      setNow(Date.now())
      return undefined
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait, MAX_EXPIRY_WAIT_MS))
    return () => clearTimeout(timer)
  }, [expiresAt, now])

  const forThisAccount =
    review !== undefined && review.chain === chainType && review.address === currentAccount.address
  const expired = review !== undefined && now >= review.expiresAt
  const usable = forThisAccount && !expired

  const risk = review?.signatureBudget.restoredFloorRisk
  const [riskAccepted, setRiskAccepted] = useState(false)
  useEffect(() => {
    setRiskAccepted(false)
  }, [risk?.challengeId])

  const [confirming, setConfirming] = useState(false)
  const confirmingRef = useRef(false)
  const [error, setError] = useState('')
  const [planOpen, setPlanOpen] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    return (): void => {
      mountedRef.current = false
    }
  }, [])

  const onClickReject = (): void => {
    if (confirmingRef.current) return
    nav.goBack()
  }

  const onClickViewPlan = (): void => {
    nav.replace('QbitSendPlanScreen')
  }

  const onClickConfirm = async (): Promise<void> => {
    if (!review || !usable || planOpen || confirmingRef.current) return
    if (risk && !riskAccepted) return
    confirmingRef.current = true
    setConfirming(true)
    setError('')
    tools.showLoading(true)
    let started = false
    let startAsked = false
    try {
      if (risk) await wallet.confirmQbitRestoredFloorSigning(risk.challengeId)
      startAsked = true
      const result = await wallet.startQbitSendPlan(review.draftId)
      if (!mountedRef.current) return
      // `in` narrows the result here, where this package compiles without strict null checks.
      if (!('reason' in result)) {
        started = true
        nav.replace('QbitSendPlanScreen')
        return
      }
      switch (result.reason) {
        case 'draft_expired':
          tools.toastError(t('send_plan_review_expired'))
          nav.goBack()
          return
        case 'outputs_changed':
          tools.toastError(t('send_plan_outputs_changed'))
          nav.goBack()
          return
        case 'locked':
          nav.navToLock({ autoUnlockByFace: false })
          return
        case 'plan_open':
          setPlanOpen(true)
          return
        default:
          setError(t('unknown_error'))
      }
    } catch (failure) {
      // The start may have gone through before its answer was lost.
      if (startAsked) {
        const answer: unknown = await wallet.getQbitSendPlan().catch(() => undefined)
        if (!mountedRef.current) return
        if (qbitSendPlanStartedBy(readQbitSendPlanView(answer), review, revised)) {
          started = true
          nav.replace('QbitSendPlanScreen')
          return
        }
      }
      if (!mountedRef.current) return
      setError(qbitSendPlanErrorMessage(failure, t('unknown_error')))
    } finally {
      tools.showLoading(false)
      // A plan that started keeps Confirm locked until the screen is gone.
      if (!started) confirmingRef.current = false
      if (mountedRef.current && !started) setConfirming(false)
    }
  }

  if (!review) {
    return {
      ready: false,
      t,
      unavailableText: t('send_plan_review_unavailable'),
      onClickReject,
    }
  }

  const formatCount = qbitSendPlanCountFormat(locale)
  const amountText = (satoshis: number): string => `${qbitSendPlanAmount(satoshis)} ${qbitUnit}`
  const budget = review.signatureBudget

  // A revision says what it changes against the plan it revises: the
  // amount (for the whole balance), the total fee. One that changes neither,
  // such as a replan that rebuilt the same transactions, is a new plan for
  // the same payment. Without the revised plan's figures (route state from
  // an earlier version) the total fee is not compared.
  let revision: { title: string; lines: string[] } | undefined
  if (review.revises) {
    const previous = review.previousAmount
    const amountChanged = previous !== undefined && previous !== review.amount
    const feeChanged = revised !== undefined && revised.totalFee !== review.totalFee
    const same = revised !== undefined && !amountChanged && !feeChanged
    const lines: string[] = []
    if (same) {
      lines.push(t('send_plan_revision_same'))
    } else if (amountChanged) {
      lines.push(t('send_plan_revision_recipient_unchanged'))
      lines.push(
        t('send_plan_revision_amount', [
          qbitSendPlanAmount(review.amount),
          qbitUnit,
          qbitSendPlanAmount(previous),
          qbitUnit,
        ])
      )
    } else if (review.target === 'amount') {
      lines.push(t('send_plan_revision_unchanged'))
    } else {
      lines.push(t('send_plan_revision_recipient_unchanged'))
    }
    if (feeChanged) {
      lines.push(
        t('send_plan_revision_total_fee', [
          qbitSendPlanAmount(review.totalFee),
          qbitUnit,
          qbitSendPlanAmount(revised.totalFee),
          qbitUnit,
        ])
      )
    }
    if (review.paidFee > 0) {
      lines.push(t('send_plan_revision_paid', [qbitSendPlanAmount(review.paidFee), qbitUnit]))
    }
    revision = {
      title: same ? t('send_plan_revision_same_title') : t('send_plan_revision_title'),
      lines,
    }
  }

  const unusableText = !forThisAccount
    ? t('send_plan_review_unavailable')
    : expired
      ? t('send_plan_review_expired')
      : ''

  return {
    ready: true,
    t,
    review,
    title: t('send_plan_review_title'),
    recipient: review.recipient,
    receives: amountText(review.amount),
    transactions: qbitSendPlanStepsText(review.merges.length, t),
    totalFee: amountText(review.totalFee),
    change: review.change > 0 ? amountText(review.change) : '',
    signing: `${t('send_plan_signatures', [formatCount(review.signatureCount)])} · ${qbitSendPlanTimeText(
      review.estimatedSigningSeconds,
      t
    )}`,
    budget: t('send_plan_review_budget', [
      formatCount(budget.remainingBefore),
      formatCount(budget.remainingAfter),
    ]),
    note: t('send_plan_review_note'),
    revision,
    restoredFloorRisk: risk,
    riskAccepted,
    onRiskAcceptedChange: setRiskAccepted,
    unusableText,
    planOpenText: planOpen ? t('send_plan_already_open') : '',
    error,
    confirming,
    canConfirm: usable && !planOpen && !confirming && (!risk || riskAccepted),
    onClickReject,
    onClickConfirm,
    onClickViewPlan,
  }
}
