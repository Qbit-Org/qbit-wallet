import { useEffect, useRef } from 'react'

import { QbitRetainedBroadcast, SignPsbtParams, SignPsbtResult } from '@qbit/wallet-shared'
import { useI18n, useNavigation } from 'src/context'
import { useAbandonQbitBroadcastCallback, usePushQbitTxCallback } from 'src/hooks'

/**
 * Confirmation screen for a send: signs, then broadcasts the signed payload
 * and replaces itself with the success or recovery screen. The broadcast
 * keeps running when this screen unmounts underneath it (the wallet locking
 * redirects to the unlock screen, a native browser back, another route
 * replacing this one), and its verdict then settles without navigating: the
 * next screen would replace whatever route the user is on by then. A proven
 * acceptance is already recorded by the broadcast callback. A proven
 * `not_sent` releases the send claim that reserved the transaction's inputs,
 * exactly as leaving the recovery screen on that verdict would, since the
 * retained bytes go with this screen and nothing can retry them afterwards.
 * An `unknown` verdict keeps the inputs reserved: the background holds them
 * as recently spent until it settles the transaction.
 */
export function useTxConfirmScreenLogic() {
  const { t } = useI18n()
  const nav = useNavigation()
  const { toSignData } = nav.getRouteState<'TxConfirmScreen'>()
  const pushQbitTx = usePushQbitTxCallback()
  const abandonBroadcast = useAbandonQbitBroadcastCallback()
  // Set once the screen has been left (unmounted) so a verdict that arrives
  // afterwards settles in place instead of navigating.
  const leftRef = useRef(false)

  useEffect((): (() => void) => {
    leftRef.current = false
    return (): void => {
      leftRef.current = true
    }
  }, [])

  const signPsbtParams: SignPsbtParams = {
    data: {
      toSignDatas: [toSignData],
    },
  }

  const onClickBack = () => {
    nav.goBack()
  }

  const onClickCancel = () => {
    nav.goBack()
  }

  const onClickConfirm = async (signedDatas: SignPsbtResult) => {
    // Signing is finished at this point and may already have consumed a
    // one-time P2MR signature. Keep the exact finalized payload, the network
    // and expected txid fixed when the wallet built the transaction (every
    // signer, local or not, hands them back on its result), and the
    // broadcast claim that authorizes it (minted by the wallet when it signs
    // its own send locally, or by the provider approval for a dapp send), so
    // the first broadcast and any retry stay bound to that network and
    // rebroadcast these bytes instead of coming back through the signer, and
    // the inputs stay reserved from every other send flow until the broadcast
    // is proven accepted or the user abandons a proven not_sent verdict.
    const signed = signedDatas[0]
    const retained: QbitRetainedBroadcast = {
      psbtHex: signed?.psbtHex ?? signed?.rawtx ?? '',
    }
    if (signed?.qbitBroadcastIdentity) {
      retained.qbitBroadcastIdentity = signed.qbitBroadcastIdentity
    }
    if (signed?.qbitSendBroadcastClaim) {
      retained.qbitSendBroadcastClaim = signed.qbitSendBroadcastClaim
    }

    const result = await pushQbitTx(retained)
    // Left mid-broadcast: the user is on another screen, and the retained
    // bytes are unreachable there. Settle the verdict as the recovery screen
    // would on unmount, and never navigate. Fire and forget: the callback
    // releases only a proven not_sent whose claim matches, hands any other
    // claim back to the background, and never throws.
    if (leftRef.current) {
      if (result.success === false) void abandonBroadcast(result, retained)
      return
    }
    // Replace, not push, on both verdicts: the signer must not stay one
    // history step behind the next screen, or a browser back would re-enter
    // it with the same unsigned request and sign (and pay) a second time.
    if (result.success === true) {
      nav.replace(
        'TxSuccessScreen',
        toSignData.qbitConsolidation
          ? { txid: result.txid, consolidation: true }
          : { txid: result.txid }
      )
    } else {
      nav.replace('TxFailScreen', { result, retained })
    }
  }

  return {
    // data
    signPsbtParams,

    // actions
    onClickBack,
    onClickCancel,
    onClickConfirm,
  }
}
