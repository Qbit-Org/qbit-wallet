import { useEffect, useRef } from 'react'

import { useI18n, useNavigation, useTools, useWallet } from 'src/context'
import { useTxExplorerUrl } from 'src/hooks/settings'
import { useQbitSendPlan } from '../hooks/sendPlan'
import { qbitConsolidationRouteContext } from './qbitConsolidationRouteContext'

export function useTxSuccessScreenLogic() {
  const nav = useNavigation()
  const routeState = nav.getRouteState<'TxSuccessScreen'>()
  const sendPlanId =
    typeof routeState?.sendPlanId === 'string' && routeState.sendPlanId
      ? routeState.sendPlanId
      : undefined
  // The result of a send plan follows that plan, which can still change
  // until the transaction it names has confirmed (#217): one no longer
  // completed (it reopened as paused) is shown on its own screen instead,
  // and a completed one that names another transaction, which replaced the
  // one shown, shows and links that one. Without the plan (gone, or not
  // read yet), the screen shows what it was opened with. Opened for no plan
  // (an ordinary send, a consolidation batch), it reads none.
  const { plan } = useQbitSendPlan({ enabled: sendPlanId !== undefined })
  const followed = sendPlanId !== undefined && plan?.id === sendPlanId ? plan : undefined
  const reopened = followed !== undefined && followed.phase !== 'completed'
  // Set once the screen gives way to the plan screen: leaving so is not the
  // user leaving, and dismisses nothing (see below).
  const gaveWayRef = useRef(false)
  useEffect(() => {
    if (reopened) {
      gaveWayRef.current = true
      nav.replace('QbitSendPlanScreen')
    }
  }, [nav, reopened])
  const txid =
    followed?.phase === 'completed' && followed.paymentTxid
      ? followed.paymentTxid
      : (routeState?.txid ?? '')
  // After a consolidation batch, the flag and the batch's size, checked as
  // the confirm and failure screens check what they hand on: route state may
  // come from an earlier version.
  const routeContext = qbitConsolidationRouteContext(routeState)
  const consolidation = routeContext.consolidation === true
  const consolidationMaxInputs = routeContext.consolidationMaxInputs
  const { t } = useI18n()
  const tools = useTools()
  const wallet = useWallet()
  const txExplorerUrl = useTxExplorerUrl(txid)

  // The payment of a completed send plan: once the user leaves this screen,
  // by Done or any other way, the plan leaves the home screen. A plan that
  // is not completed, or is gone, is the background's to refuse. A screen
  // that gave way to the plan screen by itself sends nothing: the plan was
  // not completed then, may be completed again by the time the screen goes,
  // and a dismiss would then end it without the user having left. Leaving is
  // a cleanup that no run of the same effect follows: one that does (a new
  // `wallet` object, or React running effects twice in development) runs
  // in the same pass, before the check a microtask later, and the screen
  // still shows the plan.
  const shownPlanRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (sendPlanId === undefined) return undefined
    shownPlanRef.current = sendPlanId
    return (): void => {
      if (shownPlanRef.current === sendPlanId) shownPlanRef.current = undefined
      void Promise.resolve()
        .then(() => {
          if (shownPlanRef.current === sendPlanId || gaveWayRef.current) return undefined
          return wallet.dismissQbitSendPlan(sendPlanId)
        })
        .catch(() => undefined)
    }
  }, [wallet, sendPlanId])

  const onClickExploreTx = () => {
    if (txExplorerUrl) {
      nav.navToUrl(txExplorerUrl)
    }
  }

  const onClickDone = () => {
    nav.navigate('MainScreen')
  }

  // Replace, not push: back from the next batch returns past this screen.
  // The next batch opens at this batch's size; the consolidation screen
  // checks it against the account's maximum before using it.
  const onClickContinueConsolidation = (): void => {
    if (consolidationMaxInputs !== undefined) {
      nav.replace('QbitConsolidationScreen', { maxInputs: consolidationMaxInputs })
    } else {
      nav.replace('QbitConsolidationScreen')
    }
  }

  const onClickCopy = () => {
    tools.copyToClipboard(txid)
  }

  const txAction = txExplorerUrl
    ? ({ type: 'explorer', onClick: onClickExploreTx } as const)
    : ({ type: 'copy', onClick: onClickCopy } as const)

  return {
    // data
    txid,
    txAction,
    consolidation,

    // actions
    onClickExploreTx,
    onClickDone,
    onClickContinueConsolidation,
    onClickCopy,

    // tools
    t,
  }
}
