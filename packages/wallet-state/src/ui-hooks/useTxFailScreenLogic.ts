import { useEffect, useRef, useState } from 'react'

import type { QbitBroadcastFailure, QbitBroadcastFailureReason } from '@qbit/wallet-shared'
import { useI18n, useNavigation, useTools } from 'src/context'
import {
  useAbandonQbitBroadcastCallback,
  useCheckQbitBroadcastStatusCallback,
  usePushQbitTxCallback,
} from 'src/hooks'

export type TxFailScreenBusyAction = 'retry' | 'check'
export type TxFailScreenStatusNotice = 'gone' | 'unavailable'

const FALLBACK_FAILURE: QbitBroadcastFailure = {
  success: false,
  outcome: 'unknown',
  reason: 'unexpected',
}

/**
 * Fold a retry verdict into the current one. A retry that never left the
 * wallet (network switched, guard refused, payload unparsable) says nothing
 * about the original attempt, so it must not downgrade an `unknown` verdict
 * to "not sent"; it is surfaced as a notice instead.
 */
export function mergeQbitBroadcastRetry(
  current: QbitBroadcastFailure,
  next: QbitBroadcastFailure
): { result: QbitBroadcastFailure; retryBlocked: QbitBroadcastFailureReason | null } {
  const retryNeverDispatched = next.lookup === undefined
  if (current.outcome === 'unknown' && next.outcome === 'not_sent' && retryNeverDispatched) {
    return { result: current, retryBlocked: next.reason }
  }
  // A retry that could not even parse the payload has no txid of its own;
  // keep the one the first attempt computed so status checks stay possible.
  const result: QbitBroadcastFailure = { ...next }
  if (!result.txid && current.txid) result.txid = current.txid
  if (result.chain === undefined && current.chain !== undefined) result.chain = current.chain
  return { result, retryBlocked: null }
}

/**
 * Recovery screen for a broadcast that did not clearly succeed. The retained
 * signed payload lives only in route state; retry and status checks reuse it
 * verbatim and never re-enter signing. Every way off this screen replaces it
 * instead of pushing over it: both exits land on the wallet home and a proven
 * success lands on the success screen, so a browser back can never return to
 * the retained payload and rebroadcast a completed payment. Exits are ignored
 * while a retry or status check is still in flight so its verdict cannot
 * land on another screen. Leaving a proven `not_sent` verdict also releases
 * the send claim that reserved the transaction's inputs: the retained bytes
 * go with this screen, so nothing can retry them afterwards. That holds
 * however the screen is left, through an exit, another route replacing it,
 * or the page being hidden as the popup or tab closes, and it holds when
 * the screen is left while a retry or status check is still in flight: the
 * release then waits for that verdict and acts on it. Leaving an `unknown`
 * verdict hands the claim back to the background instead, which keeps the
 * inputs reserved as recently spent until a lifecycle probe finds the
 * transaction confirmed or gone, and lets a fee bump replace it meanwhile;
 * the claim no longer waits for the page to close. A proven acceptance that
 * arrives after the screen was left still counts as settled, but it no
 * longer navigates: the success screen would replace whatever route the
 * user is on by then, such as the unlock screen after the wallet locked.
 */
export function useTxFailScreenLogic() {
  const nav = useNavigation()
  const { t } = useI18n()
  const tools = useTools()
  const routeState = nav.getRouteState<'TxFailScreen'>()
  const retained = routeState?.retained
  const pushQbitTx = usePushQbitTxCallback()
  const checkBroadcastStatus = useCheckQbitBroadcastStatusCallback()
  const abandonBroadcast = useAbandonQbitBroadcastCallback()

  const [result, setResult] = useState<QbitBroadcastFailure>(
    () => routeState?.result ?? FALLBACK_FAILURE
  )
  const [busy, setBusy] = useState<TxFailScreenBusyAction | null>(null)
  const [statusNotice, setStatusNotice] = useState<TxFailScreenStatusNotice | null>(null)
  const [retryBlocked, setRetryBlocked] = useState<QbitBroadcastFailureReason | null>(null)
  const busyRef = useRef(false)
  // Set once this screen has decided the claim's fate: an exit abandoned it,
  // or a proven acceptance consumed it. Whatever unmounts the screen after
  // that must not release it again.
  const claimSettledRef = useRef(false)
  // Set once the screen has been left (unmounted, or the page hidden) while
  // a retry or status check was still in flight. The retained bytes are
  // already unreachable by then, so the in-flight operation settles the
  // claim itself when its verdict arrives instead of leaving it reserved,
  // and a proven acceptance no longer navigates: the user is elsewhere.
  const leftWhileBusyRef = useRef(false)
  // Kept current by hand as well as by render: a verdict that arrives after
  // the screen unmounted never renders, but the deferred release reads it.
  const resultRef = useRef(result)
  resultRef.current = result
  const retainedRef = useRef(retained)
  retainedRef.current = retained
  const abandonRef = useRef(abandonBroadcast)
  abandonRef.current = abandonBroadcast

  const txid = result.txid ?? ''
  const canRetry = Boolean(retained?.psbtHex)
  const canCheckStatus =
    result.outcome === 'unknown' && txid.length > 0 && result.chain !== undefined

  /**
   * Abandon the retained bytes, at most once. The exits call this before
   * replacing the screen; unmounting any other way (another route replacing
   * this one, a native browser back, the wallet locking) and the page being
   * hidden (the popup or tab closing, where nothing unmounts) reach it too,
   * because the bytes exist only in this screen's memory and a claim that
   * outlived them would block every later send over those inputs until the
   * background restarts. Not while a retry or status check is in flight:
   * its verdict decides, so leaving then only marks the screen as left and
   * the operation calls back here once it has settled. Fire and forget: the
   * release must never delay leaving, and the callback itself releases only
   * a proven `not_sent` whose claim matches; any other verdict leaves the
   * background to keep the inputs reserved until it settles the transaction.
   */
  const abandonOnLeave = (): void => {
    if (claimSettledRef.current) return
    if (busyRef.current) {
      leftWhileBusyRef.current = true
      return
    }
    claimSettledRef.current = true
    void abandonRef.current(resultRef.current, retainedRef.current)
  }

  /** Called by a retry or status check as it settles, busy already cleared. */
  const settleAfterLeaving = (): void => {
    if (leftWhileBusyRef.current) abandonOnLeave()
  }

  // Registered once for the screen's lifetime; the refs above carry the
  // latest verdict, payload, and callback into it.
  useEffect((): (() => void) => {
    window.addEventListener('pagehide', abandonOnLeave)
    return (): void => {
      window.removeEventListener('pagehide', abandonOnLeave)
      abandonOnLeave()
    }
  }, [])

  const leaveSendFlow = () => {
    if (busyRef.current) return
    abandonOnLeave()
    nav.replace('MainScreen')
  }

  const leaveForSuccess = (acceptedTxid: string): void => {
    // The controller consumed or released the claim when it proved
    // acceptance; nothing is left for the unmount that follows to abandon.
    claimSettledRef.current = true
    // Left mid-flight (the wallet locked, a native back, another route
    // replacing this one): the verdict is settled above, but the success
    // screen must not replace whatever route the user is on now.
    if (leftWhileBusyRef.current) return
    nav.replace('TxSuccessScreen', { txid: acceptedTxid })
  }

  const onClickRetry = async () => {
    if (busyRef.current || !retained?.psbtHex) return
    busyRef.current = true
    setBusy('retry')
    setStatusNotice(null)
    setRetryBlocked(null)
    try {
      const next = await pushQbitTx(retained, result.chain)
      if (next.success === true) {
        leaveForSuccess(next.txid)
        return
      }
      const merged = mergeQbitBroadcastRetry(result, next)
      resultRef.current = merged.result
      setResult(merged.result)
      setRetryBlocked(merged.retryBlocked)
    } finally {
      busyRef.current = false
      setBusy(null)
      settleAfterLeaving()
    }
  }

  const onClickCheckStatus = async () => {
    if (busyRef.current || !txid || result.chain === undefined) return
    busyRef.current = true
    setBusy('check')
    setStatusNotice(null)
    setRetryBlocked(null)
    try {
      const status = await checkBroadcastStatus(
        txid,
        result.chain,
        retained?.qbitSendBroadcastClaim
      )
      if (status.found === true) {
        leaveForSuccess(status.txid)
        return
      }
      // Neither absence nor a failed lookup proves the payment was not sent.
      setStatusNotice(status.state)
    } finally {
      busyRef.current = false
      setBusy(null)
      settleAfterLeaving()
    }
  }

  const onClickCopyTxid = () => {
    if (txid) tools.copyToClipboard(txid)
  }

  return {
    // info
    outcome: result.outcome,
    reason: result.reason,
    txid,
    detail: result.detail ?? '',
    canRetry,
    canCheckStatus,
    busy,
    isRetrying: busy === 'retry',
    isChecking: busy === 'check',
    statusNotice,
    retryBlocked,

    // actions
    onClickBack: leaveSendFlow,
    onClickBackToWallet: leaveSendFlow,
    onClickRetry,
    onClickCheckStatus,
    onClickCopyTxid,

    // tools
    t,
  }
}
