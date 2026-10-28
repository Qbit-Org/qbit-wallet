import { useI18n, useNavigation, useTools } from 'src/context'
import { useTxExplorerUrl } from 'src/hooks/settings'

export function useTxSuccessScreenLogic() {
  const nav = useNavigation()
  const routeState = nav.getRouteState<'TxSuccessScreen'>()
  const txid = routeState?.txid ?? ''
  const consolidation = routeState?.consolidation === true
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
  const onClickContinueConsolidation = (): void => {
    nav.replace('QbitConsolidationScreen')
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
