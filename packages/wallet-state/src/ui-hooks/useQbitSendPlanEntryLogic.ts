import { useNavigation } from '../context/NavigationContext'
import { useI18n } from '../context/I18nContext'
import { useQbitSendPlan } from '../hooks/sendPlan'
import { useQbitUnit } from '../hooks/settings'
import {
  isQbitSendPlanUnreadable,
  qbitSendPlanAmount,
  qbitSendPlanCountFormat,
  qbitSendPlanPauseText,
  qbitSendPlanStatusLine,
} from '../utils/qbit-send-plan'

export type QbitSendPlanEntryTone = 'progress' | 'paused' | 'sent'

export interface QbitSendPlanEntry {
  title: string
  status: string
  tone: QbitSendPlanEntryTone
  buttonText: string
  onClickOpen: () => void
}

/**
 * The home screen's card for the selected account's open send plan (#188):
 * a title by phase, one status line, and one button that opens the
 * progress screen, or the success screen once the payment went out. While a
 * version of the payment may still go through, the status line says so in
 * every phase (`qbitSendPlanStatusLine`).
 * Undefined while the account has no plan, or none is known yet. A stored
 * plan the background cannot read has no amount to name: the card says so
 * in the pause's own words, and leads to the progress screen, where it can
 * be cancelled.
 */
export function useQbitSendPlanEntryLogic(): QbitSendPlanEntry | undefined {
  const { t, locale } = useI18n()
  const nav = useNavigation()
  const qbitUnit = useQbitUnit()
  const { plan } = useQbitSendPlan()
  if (!plan) return undefined

  if (isQbitSendPlanUnreadable(plan)) {
    const pause = qbitSendPlanPauseText(plan.pause?.reason, t)
    return {
      title: pause.title,
      status: pause.body,
      tone: 'paused',
      buttonText: t('view'),
      onClickOpen: (): void => nav.navigate('QbitSendPlanScreen'),
    }
  }

  const amount = qbitSendPlanAmount(plan.amount)
  const status = qbitSendPlanStatusLine(plan, t, qbitSendPlanCountFormat(locale))
  let title: string
  let tone: QbitSendPlanEntryTone
  switch (plan.phase) {
    case 'completed':
      title = t('send_plan_home_sent', [amount, qbitUnit])
      tone = 'sent'
      break
    case 'paused':
      title = t('send_plan_home_paused', [amount, qbitUnit])
      tone = 'paused'
      break
    case 'cancelling':
      title = t('send_plan_home_cancelling', [amount, qbitUnit])
      tone = 'progress'
      break
    default:
      title = t('send_plan_home_sending', [amount, qbitUnit])
      tone = 'progress'
  }

  const planId = plan.id
  const paymentTxid = plan.paymentTxid
  const completed = plan.phase === 'completed'
  return {
    title,
    status,
    tone,
    buttonText: t('view'),
    onClickOpen: (): void => {
      // The success screen removes the plan from the home screen once the user leaves it.
      if (completed) nav.navigate('TxSuccessScreen', { txid: paymentTxid, sendPlanId: planId })
      else nav.navigate('QbitSendPlanScreen')
    },
  }
}
