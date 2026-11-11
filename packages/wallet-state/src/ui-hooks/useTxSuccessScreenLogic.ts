import { useI18n, useNavigation, useTools } from 'src/context'
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
  const txExplorerUrl = useTxExplorerUrl(txid)

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
