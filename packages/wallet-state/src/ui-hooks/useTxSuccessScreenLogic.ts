import { useEffect, useRef } from 'react'

import { useI18n, useNavigation, useTools, useWallet } from 'src/context'
import { useTxExplorerUrl } from 'src/hooks/settings'
import { qbitConsolidationRouteContext } from './qbitConsolidationRouteContext'

export function useTxSuccessScreenLogic() {
  const nav = useNavigation()
  const routeState = nav.getRouteState<'TxSuccessScreen'>()
  const txid = routeState?.txid ?? ''
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
  // is not completed, or is gone, is the background's to refuse. Leaving is
  // a cleanup that no run of the same effect follows: one that does (a new
  // `wallet` object, or React running effects twice in development) runs
  // in the same pass, before the check a microtask later, and the screen
  // still shows the plan.
  const sendPlanId =
    typeof routeState?.sendPlanId === 'string' && routeState.sendPlanId
      ? routeState.sendPlanId
      : undefined
  const shownPlanRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (sendPlanId === undefined) return undefined
    shownPlanRef.current = sendPlanId
    return (): void => {
      if (shownPlanRef.current === sendPlanId) shownPlanRef.current = undefined
      void Promise.resolve()
        .then(() => {
          if (shownPlanRef.current === sendPlanId) return undefined
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
