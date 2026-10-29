import { useEffect, useMemo, useRef, useState } from 'react'

import { numUtils } from '@qbit/base-utils'
import {
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  type QbitConsolidationStatus,
  type ToSignData,
} from '@qbit/wallet-shared'
import {
  useChainType,
  useCurrentAccount,
  useFeeRateBar,
  useI18n,
  useNavigation,
  useQbitUnit,
  useTools,
  useWallet,
} from '..'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Consolidation of an account holding more confirmed outputs than the
 * explorer lists: one batch at a time, each its largest outputs sent whole
 * to its own address, previewed here and then confirmed, signed and
 * broadcast on the ordinary confirm screen. A batch is never built from a
 * stale request: a result that lands after the account, network or fee rate
 * changed, or after a newer request started, is dropped.
 */
export function useQbitConsolidationScreenLogic() {
  const { t } = useI18n()
  const nav = useNavigation()
  const wallet = useWallet()
  const tools = useTools()
  const qbitUnit = useQbitUnit()
  const chainType = useChainType()
  const { address } = useCurrentAccount()
  const feeRate = useFeeRateBar().feeRate

  const [status, setStatus] = useState<QbitConsolidationStatus | undefined>(undefined)
  const [statusError, setStatusError] = useState('')
  const [batch, setBatch] = useState<ToSignData | undefined>(undefined)
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)

  // What each request was made for; a result is published only while it
  // still holds and no newer request of its kind has started.
  const accountScope = `${chainType}:${address}`
  const batchScope = `${accountScope}:${feeRate}`
  const accountScopeRef = useRef(accountScope)
  accountScopeRef.current = accountScope
  const batchScopeRef = useRef(batchScope)
  batchScopeRef.current = batchScope
  const statusRequestRef = useRef(0)
  const batchRequestRef = useRef(0)
  // Prepare requests still running: the loading overlay stays up until the last ends.
  const preparesInFlightRef = useRef(0)

  const loadStatus = (): void => {
    const request = ++statusRequestRef.current
    const scope = accountScopeRef.current
    const isCurrent = (): boolean =>
      statusRequestRef.current === request && accountScopeRef.current === scope
    wallet
      .getQbitConsolidationStatus()
      .then(next => {
        if (!isCurrent()) return
        setStatus(next)
        setStatusError('')
      })
      .catch(e => {
        if (isCurrent()) setStatusError(errorMessage(e))
      })
  }

  useEffect(() => {
    setStatus(undefined)
    setStatusError('')
    loadStatus()
  }, [wallet, accountScope])

  // A batch selected for another account or network, or priced at another
  // rate, is stale.
  useEffect(() => {
    batchRequestRef.current += 1
    setBatch(undefined)
    setError('')
    setPreparing(false)
  }, [batchScope])

  const feeRateValid =
    Number.isFinite(feeRate) && feeRate >= QBIT_MIN_RELAY_FEE_RATE && feeRate <= QBIT_MAX_FEE_RATE

  const onClickPrepare = (): void => {
    const request = ++batchRequestRef.current
    const scope = batchScopeRef.current
    const isCurrent = (): boolean =>
      batchRequestRef.current === request && batchScopeRef.current === scope
    setError('')
    setBatch(undefined)
    setPreparing(true)
    preparesInFlightRef.current += 1
    // The background gives a batch one deadline for all its explorer reads,
    // so the overlay comes down within it, on a slow link with an error.
    tools.showLoading(true)
    wallet
      .createQbitConsolidationPsbt({ feeRate, enableRBF: true })
      .then(toSignData => {
        if (!isCurrent()) return
        setBatch(toSignData)
        // The counts may have moved since the screen opened.
        loadStatus()
      })
      .catch(e => {
        if (isCurrent()) setError(errorMessage(e))
      })
      .finally(() => {
        preparesInFlightRef.current -= 1
        if (preparesInFlightRef.current === 0) tools.showLoading(false)
        if (isCurrent()) setPreparing(false)
      })
  }

  const onClickConfirm = (): void => {
    if (!batch) return
    nav.navigate('TxConfirmScreen', { toSignData: batch })
  }

  const outputLimit = status?.outputLimit ?? 0
  // Outputs pending batches spend leave the count once they confirm, and
  // their own outputs join it.
  const projectedOutputs = status
    ? Math.max(0, status.confirmedUnspent - status.pendingSpent + status.pendingFunded)
    : 0
  const batchesLeft =
    status && status.maxInputCount > 1
      ? Math.ceil(Math.max(0, projectedOutputs - outputLimit) / (status.maxInputCount - 1))
      : 0
  const overLimit = status ? status.confirmedUnspent > status.outputLimit : false

  const statusText = useMemo(() => {
    if (!status) return ''
    if (!overLimit) return t('consolidation_within_limit', [String(status.outputLimit)])
    if (batchesLeft === 0) {
      return t('consolidation_status_confirming', [
        String(status.confirmedUnspent),
        String(status.outputLimit),
      ])
    }
    return t('consolidation_status', [
      String(status.confirmedUnspent),
      String(status.outputLimit),
      String(batchesLeft),
    ])
  }, [status, overLimit, batchesLeft, t])

  const pendingText =
    status && status.pendingSpent > 0
      ? t('consolidation_pending', [String(status.pendingSpent)])
      : ''

  const batchSummary = batch?.qbitConsolidation
    ? t('consolidation_batch_summary', [
        String(batch.inputCount ?? 0),
        numUtils.satoshisToAmount(batch.qbitConsolidation.amount),
        qbitUnit,
        String(batch.estimatedFee ?? 0),
        ((batch.estimatedVsize ?? 0) / 1000).toFixed(1),
      ])
    : ''

  return {
    headerTitle: t('consolidate_outputs'),
    description: status ? t('consolidation_description', [String(status.maxInputCount)]) : '',
    status,
    statusText,
    pendingText,
    overLimit,
    batch,
    batchSummary,
    // A status read that failed does not stop a batch: the background checks
    // the counts again when it builds one.
    error: error || statusError,
    preparing,
    canPrepare: (status ? overLimit : statusError !== '') && feeRateValid && !preparing,
    onClickPrepare,
    onClickConfirm,
    t,
  }
}
