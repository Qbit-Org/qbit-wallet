import { useEffect, useMemo, useRef, useState } from 'react'

import { numUtils } from '@qbit/base-utils'
import {
  QBIT_CONSOLIDATION_MIN_INPUTS,
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  estimateQbitP2mrTransaction,
  isQbitConsolidationBatchSize,
  qbitBroadcastErrorMessage,
  type QbitConsolidationBatchShape,
  type QbitConsolidationRequest,
  type QbitConsolidationStatus,
  type QbitP2mrTransactionEstimate,
  type ToSignData,
} from '@qbit/wallet-shared'
import type { ChainType } from '@qbit/wallet-types'
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
import { useFeeQuoteRead, useFeeRateSettled } from './useFeeRateBarLogic'

/**
 * The text of a failed wallet call. The popup's wallet proxy rejects with the
 * background's error as a plain `{ message, stack }` object, not an `Error`,
 * so the message is read from any object that has one. Without one, or with
 * an empty one, the call reads as an unknown error, never as "[object
 * Object]" or as nothing: an empty status error would also hold Prepare back.
 */
function errorMessage(error: unknown, unknownError: string): string {
  const message = qbitBroadcastErrorMessage(error)
  return message?.trim() ? message : unknownError
}

/** A batch size as typed: digits only, so no sign, decimal point, exponent or whitespace. */
const BATCH_SIZE_TEXT = /^\d+$/

/**
 * The batch size `text` names, when a consolidation of an account whose
 * batches carry at most `maxInputCount` inputs accepts it, by the check the
 * background applies to the request (`isQbitConsolidationBatchSize`).
 */
function parseBatchSize(text: string, maxInputCount: number): number | undefined {
  if (!BATCH_SIZE_TEXT.test(text)) return undefined
  const size = Number(text)
  return isQbitConsolidationBatchSize(size, maxInputCount) ? size : undefined
}

/**
 * The batch size the screen's route state `route` names for the account at
 * `address` on `chain`, while it could be one: a whole number of at least
 * `QBIT_CONSOLIDATION_MIN_INPUTS` (`isQbitConsolidationBatchSize`), which
 * the screen checks against the account's maximum once that is known. Route
 * state can outlive the batch it came from and an update, so it is read as
 * untrusted. A size kept for another account or network names nothing; one
 * that names no account (the success screen's, or an earlier version's) was
 * chosen for the account the screen opened for, `openedForAccount` telling
 * whether that is this one.
 */
function routeBatchSize(
  route: unknown,
  chain: ChainType,
  address: string,
  openedForAccount: boolean
): number | undefined {
  if (typeof route !== 'object' || route === null) return undefined
  const { maxInputs, chain: routeChain, address: routeAddress } = route as Record<string, unknown>
  const forAccount =
    routeChain === undefined && routeAddress === undefined
      ? openedForAccount
      : routeChain === chain && routeAddress === address
  return forAccount && isQbitConsolidationBatchSize(maxInputs, Number.MAX_SAFE_INTEGER)
    ? maxInputs
    : undefined
}

/** A full batch of `inputCount` inputs in this shape, or undefined when the shape cannot be priced. */
function estimateBatch(
  shape: QbitConsolidationBatchShape,
  inputCount: number,
  feeRate: number
): QbitP2mrTransactionEstimate | undefined {
  try {
    return estimateQbitP2mrTransaction({
      inputCount,
      outputScriptLengths: shape.outputScriptLengths,
      leafScriptLength: shape.leafScriptLength,
      controlBlockLength: shape.controlBlockLength,
      feeRate,
    })
  } catch {
    return undefined
  }
}

/**
 * Consolidation of an account holding more confirmed outputs than the
 * explorer lists: one batch at a time, each its largest outputs sent whole
 * to its own address, previewed here and then confirmed, signed and
 * broadcast on the ordinary confirm screen. A batch is never built from a
 * stale request: a result that lands after the account, network, fee rate
 * or batch size changed, or after a newer request started, is dropped.
 *
 * The user chooses the batch size, from `QBIT_CONSOLIDATION_MIN_INPUTS` to
 * the account's maximum (`QbitConsolidationStatus.maxInputCount`), for an
 * account over the explorer's limit; one within it has nothing to merge, so
 * no size is offered. The screen opens at the size its route names, when
 * that is still within the range, and at the maximum otherwise: the size of
 * the batch that just went out, from the success screen, or the size the
 * user chose here before going on to the confirm screen, which the screen
 * keeps in its own route state for the account and network it was chosen
 * on, so Back from the confirm screen returns to it. A size the user types
 * applies only to the account and network it was typed for. The screen
 * holds one typed size, not one per account: another account or network
 * opens at its own opening size, and a size typed there replaces the first,
 * so switching back then opens the first at its opening size. Until the
 * status has loaded the maximum is unknown, so no size can be checked and
 * the field is not offered. A batch prepared after a failed status read
 * carries the size the route names, which the background checks against its
 * maximum, or none, and the background uses its maximum. A prepare still
 * current when it ends reads the status again: after a batch, whose counts
 * may have moved, and after an error only while the maximum is unknown, so
 * a status that loads then gives the screen its maximum, and a route's size
 * past that maximum gives way to it.
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
  // The quote the fee bar offers its rates from, and the rate the batch's
  // check below last ran at. Until the bar has chosen the selected tier's
  // rate from the quote, the rate is the bar's default or one from an
  // earlier quote, possibly another network's, and no batch is prepared.
  const feeQuote = useFeeQuoteRead()
  const [checkedFeeRate, setCheckedFeeRate] = useState<number | undefined>(undefined)
  const feeRateSettled = useFeeRateSettled(feeQuote, checkedFeeRate)

  const [status, setStatus] = useState<QbitConsolidationStatus | undefined>(undefined)
  const [statusError, setStatusError] = useState('')
  // The prepared batch with the scope (below) it was requested for, and the
  // batch size its request carried: none when it carried none, for the
  // background's maximum.
  const [prepared, setPrepared] = useState<
    { scope: string; size: number | undefined; batch: ToSignData } | undefined
  >(undefined)
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  // The one batch size the user typed, with the account and network it was
  // typed for, where alone it applies; a size typed for another replaces
  // it. Undefined until they edit it or choose Max.
  const [batchSizeEdit, setBatchSizeEdit] = useState<{ account: string; text: string } | undefined>(
    undefined
  )

  const accountScope = `${chainType}:${address}`
  // The account the screen opened for, which route state naming no account
  // was written for.
  const openedAccountScope = useRef(accountScope).current

  // The most inputs one batch of this account carries, once the status has
  // loaded one that is itself a valid batch size: a whole number of at least
  // QBIT_CONSOLIDATION_MIN_INPUTS.
  const maxInputCount =
    status && isQbitConsolidationBatchSize(status.maxInputCount, status.maxInputCount)
      ? status.maxInputCount
      : undefined
  // The size the route names is checked like a typed one once the maximum
  // is known, and the screen opens at the maximum when the route names none
  // or one out of range.
  const routeSize = routeBatchSize(
    nav.getRouteState<'QbitConsolidationScreen'>(),
    chainType,
    address,
    accountScope === openedAccountScope
  )
  const initialBatchSize =
    maxInputCount === undefined
      ? undefined
      : routeSize !== undefined && isQbitConsolidationBatchSize(routeSize, maxInputCount)
        ? routeSize
        : maxInputCount
  // A size typed for another account or network does not apply here: this
  // one shows its opening size until a size is typed for it.
  const editedText = batchSizeEdit?.account === accountScope ? batchSizeEdit.text : undefined
  const batchSizeText =
    editedText ?? (initialBatchSize === undefined ? '' : String(initialBatchSize))
  const batchSize =
    maxInputCount === undefined ? undefined : parseBatchSize(batchSizeText, maxInputCount)
  const batchSizeInvalid = maxInputCount !== undefined && batchSize === undefined
  // The size a batch is requested at now: the chosen one once the maximum
  // is known. Until then, the size the route names, which the background
  // checks against its maximum as it checks a chosen one, or none, and the
  // background uses its maximum.
  const requestSize = maxInputCount === undefined ? routeSize : batchSize

  // What each request was made for: the account, the network, the rate, and
  // the size chosen; a result is published only while they still hold and
  // no newer request has started. The size choice reads the same until the
  // user moves the size off the one the screen opened at, so the status
  // loading, which sets that size, drops no batch. Whether a batch is of the
  // size chosen is checked as it is offered (`sizeHolds`).
  const batchScope = `${accountScope}:${feeRate}`
  const batchSizeChoice =
    maxInputCount === undefined || batchSize === initialBatchSize
      ? 'opening'
      : batchSize === undefined
        ? 'invalid'
        : String(batchSize)
  const accountScopeRef = useRef(accountScope)
  accountScopeRef.current = accountScope
  const batchScopeRef = useRef(batchScope)
  batchScopeRef.current = batchScope
  const batchSizeChoiceRef = useRef(batchSizeChoice)
  batchSizeChoiceRef.current = batchSizeChoice
  // The maximum as the latest render knows it, for a prepare that ends after
  // the render it started in.
  const maxInputCountRef = useRef(maxInputCount)
  maxInputCountRef.current = maxInputCount
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
        if (isCurrent()) setStatusError(errorMessage(e, t('unknown_error')))
      })
  }

  useEffect(() => {
    setStatus(undefined)
    setStatusError('')
    loadStatus()
  }, [wallet, accountScope])

  // A batch selected for another account or network, priced at another
  // rate, or prepared at another size, is stale.
  useEffect(() => {
    setCheckedFeeRate(feeRate)
    batchRequestRef.current += 1
    setPrepared(undefined)
    setError('')
    setPreparing(false)
  }, [batchScope, feeRate, batchSizeChoice])

  // Whether a batch requested at `size` is of the size chosen now. A request
  // that carried no size took the background's maximum, which the status
  // reports once it loads.
  const sizeHolds = (size: number | undefined): boolean =>
    !batchSizeInvalid &&
    (size === requestSize ||
      (size === undefined && maxInputCount !== undefined && requestSize === maxInputCount))

  // From the render the rate or size changes in, before the check above
  // drops it, a batch is priced at an earlier rate or prepared at an earlier
  // size; nor is one offered at a rate not settled.
  const rateChecked = feeRateSettled && checkedFeeRate === feeRate
  const currentBatch =
    rateChecked && prepared?.scope === batchScope && sizeHolds(prepared.size)
      ? prepared.batch
      : undefined

  const feeRateValid =
    Number.isFinite(feeRate) && feeRate >= QBIT_MIN_RELAY_FEE_RATE && feeRate <= QBIT_MAX_FEE_RATE

  const onClickPrepare = (): void => {
    // A size the range refuses is never sent; Prepare is disabled for it.
    if (batchSizeInvalid) return
    const request = ++batchRequestRef.current
    const scope = batchScopeRef.current
    const sizeChoice = batchSizeChoiceRef.current
    const size = requestSize
    const isCurrent = (): boolean =>
      batchRequestRef.current === request &&
      batchScopeRef.current === scope &&
      batchSizeChoiceRef.current === sizeChoice
    // The size goes with the request, the maximum included; without one the
    // background uses its maximum.
    const consolidationRequest: QbitConsolidationRequest =
      size === undefined
        ? { feeRate, enableRBF: true }
        : { feeRate, enableRBF: true, maxInputs: size }
    setError('')
    setPrepared(undefined)
    setPreparing(true)
    preparesInFlightRef.current += 1
    // The background gives a batch one deadline for all its explorer reads,
    // so the overlay comes down within it, on a slow link with an error.
    tools.showLoading(true)
    wallet
      .createQbitConsolidationPsbt(consolidationRequest)
      .then(toSignData => {
        if (!isCurrent()) return
        setPrepared({ scope, size, batch: toSignData })
        // The counts may have moved since the screen opened.
        loadStatus()
      })
      .catch(e => {
        if (!isCurrent()) return
        setError(errorMessage(e, t('unknown_error')))
        // Only while the account's maximum is unknown as the prepare ends,
        // not as it began: the status read failed, so the size the route
        // names went out unchecked, and the background may have refused it
        // as past its maximum. A route names such a size when the maximum is
        // lower for the account or version the screen opens on than for the
        // batch the size came from. A status that loads now gives the screen
        // its maximum, which replaces that size; every later prepare would
        // otherwise send it again. Once the maximum is known, the screen
        // checks every size against it, and another read would only add a
        // request to an explorer that may be failing, one that could fail
        // and leave a status error behind the loaded status.
        if (maxInputCountRef.current === undefined) loadStatus()
      })
      .finally(() => {
        preparesInFlightRef.current -= 1
        if (preparesInFlightRef.current === 0) tools.showLoading(false)
        if (isCurrent()) setPreparing(false)
      })
  }

  const onClickConfirm = (): void => {
    if (!currentBatch) return
    // Back from the confirm screen opens this screen again with its route
    // state, so the size this batch was prepared at goes there first, for
    // this account and network only. A request that carried no size took
    // the maximum, which the batch records.
    const keptSize: unknown = prepared?.size ?? currentBatch.qbitConsolidation?.maxInputs
    if (isQbitConsolidationBatchSize(keptSize, Number.MAX_SAFE_INTEGER)) {
      nav.replace('QbitConsolidationScreen', { maxInputs: keptSize, chain: chainType, address })
    }
    nav.navigate('TxConfirmScreen', { toSignData: currentBatch })
  }

  const onBatchSizeChange = (text: string): void => {
    setBatchSizeEdit({ account: accountScope, text })
  }

  const onClickBatchSizeMax = (): void => {
    if (maxInputCount !== undefined) {
      setBatchSizeEdit({ account: accountScope, text: String(maxInputCount) })
    }
  }

  const outputLimit = status?.outputLimit ?? 0
  // Outputs pending batches spend leave the count once they confirm, and
  // their own outputs join it.
  const projectedOutputs = status
    ? Math.max(0, status.confirmedUnspent - status.pendingSpent + status.pendingFunded)
    : 0
  // A batch of n inputs leaves one output behind, so it removes n - 1. No
  // count follows from a size the range refuses.
  const batchesLeft =
    status && batchSize !== undefined
      ? Math.ceil(Math.max(0, projectedOutputs - outputLimit) / (batchSize - 1))
      : undefined
  const overLimit = status ? status.confirmedUnspent > status.outputLimit : false
  // The batch size, its range, the fee of a full batch and the cost note:
  // only for an account over the limit, whose maximum is known. Without the
  // status there is no maximum to check a size against; a batch may still
  // be prepared then (`canPrepare`), at the size the route names or the
  // background's maximum. Within the limit there is nothing to prepare.
  const showBatchSize = maxInputCount !== undefined && overLimit

  const statusText = useMemo(() => {
    if (!status) return ''
    if (!overLimit) return t('consolidation_within_limit', [String(status.outputLimit)])
    const counts = [String(status.confirmedUnspent), String(status.outputLimit)]
    // The pending batches suffice, whatever the size of the next.
    if (projectedOutputs <= outputLimit) return t('consolidation_status_confirming', counts)
    if (batchesLeft === undefined || batchSize === undefined) {
      return t('consolidation_status_counts', counts)
    }
    return t('consolidation_status', [...counts, String(batchesLeft), String(batchSize)])
  }, [status, overLimit, projectedOutputs, outputLimit, batchesLeft, batchSize, t])

  const pendingText =
    status && status.pendingSpent > 0
      ? t('consolidation_pending', [String(status.pendingSpent)])
      : ''

  const batchSummary = currentBatch?.qbitConsolidation
    ? t('consolidation_batch_summary', [
        String(currentBatch.inputCount ?? 0),
        numUtils.satoshisToAmount(currentBatch.qbitConsolidation.amount),
        qbitUnit,
        String(currentBatch.estimatedFee ?? 0),
        ((currentBatch.estimatedVsize ?? 0) / 1000).toFixed(1),
      ])
    : ''

  // What a full batch of the chosen size costs at the selected rate, before
  // one is prepared; only at a rate the batch itself could be priced at.
  const batchShape = status?.batchShape
  const fullBatchEstimate = useMemo(
    () =>
      batchShape && batchSize !== undefined && feeRateValid && rateChecked
        ? estimateBatch(batchShape, batchSize, feeRate)
        : undefined,
    [batchShape, batchSize, feeRateValid, rateChecked, feeRate]
  )
  const feePreview =
    showBatchSize && fullBatchEstimate && batchSize !== undefined
      ? t('consolidation_fee_preview', [
          String(batchSize),
          String(fullBatchEstimate.fee),
          (fullBatchEstimate.vsize / 1000).toFixed(1),
        ])
      : ''

  // How much more in fees the whole consolidation takes at the chosen size
  // than at the maximum, in percent. A batch of n inputs removes n - 1
  // outputs, so it pays its fee for n - 1: fee(n) / (n - 1) per output
  // removed, against fee(max) / (max - 1). Fees are the size times the rate,
  // so the sizes give the same figure at every rate.
  const extraCostPercent = useMemo(() => {
    if (!batchShape || batchSize === undefined || maxInputCount === undefined) return undefined
    if (batchSize >= maxInputCount) return undefined
    const chosen = estimateBatch(batchShape, batchSize, QBIT_MIN_RELAY_FEE_RATE)
    const largest = estimateBatch(batchShape, maxInputCount, QBIT_MIN_RELAY_FEE_RATE)
    if (!chosen || !largest) return undefined
    const chosenPerOutput = chosen.vsize / (batchSize - 1)
    const largestPerOutput = largest.vsize / (maxInputCount - 1)
    return (chosenPerOutput / largestPerOutput - 1) * 100
  }, [batchShape, batchSize, maxInputCount])
  // A whole percent, and never 0%: below one it reads "less than 1%".
  const extraCostRounded = extraCostPercent === undefined ? undefined : Math.round(extraCostPercent)
  const costNote =
    !showBatchSize ||
    extraCostRounded === undefined ||
    batchSize === undefined ||
    maxInputCount === undefined
      ? ''
      : extraCostRounded >= 1
        ? t('consolidation_cost_note', [
            String(batchSize),
            String(extraCostRounded),
            String(maxInputCount),
          ])
        : t('consolidation_cost_note_small', [String(batchSize), String(maxInputCount)])

  return {
    headerTitle: t('consolidate_outputs'),
    description: status ? t('consolidation_description') : '',
    status,
    statusText,
    pendingText,
    overLimit,
    batch: currentBatch,
    batchSummary,
    // The batch size: offered for an account over the limit, once its
    // maximum is known.
    showBatchSize,
    batchSizeLabel: t('consolidation_batch_size_label'),
    batchSizeText,
    // The size a batch is prepared at; undefined while the text is not a
    // size within the range, or the maximum is unknown.
    batchSize,
    maxBatchSize: maxInputCount,
    batchSizeRange:
      !showBatchSize || maxInputCount === undefined
        ? ''
        : t('consolidation_batch_size_range', [
            String(QBIT_CONSOLIDATION_MIN_INPUTS),
            String(maxInputCount),
          ]),
    batchSizeError:
      showBatchSize && batchSizeInvalid && maxInputCount !== undefined
        ? t('consolidation_batch_size_invalid', [
            String(QBIT_CONSOLIDATION_MIN_INPUTS),
            String(maxInputCount),
          ])
        : '',
    feePreview,
    costNote,
    // A status read that failed does not stop a batch: the background checks
    // the counts again when it builds one.
    error: error || statusError,
    preparing,
    canPrepare:
      (status ? overLimit : statusError !== '') &&
      !batchSizeInvalid &&
      feeRateValid &&
      feeRateSettled &&
      !preparing,
    // For the fee bar: the quote the batch's rate is chosen from.
    feeQuote,
    onBatchSizeChange,
    onClickBatchSizeMax,
    onClickPrepare,
    onClickConfirm,
    t,
  }
}
