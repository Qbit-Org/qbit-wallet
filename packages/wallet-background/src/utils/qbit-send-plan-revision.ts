import {
  QBIT_MAX_FEE_RATE,
  QBIT_P2MR_DUST,
  estimateQbitP2mrTransaction,
  isQbitFeeRateWithinPolicy,
  isQbitStandardTxSize,
  qbitMaximumTotalFee,
  type QbitP2mrTransactionEstimate,
} from '@qbit/wallet-shared'

import { qbitReplacementFeeAllowed } from './qbit-replacement-fee'

/**
 * What every transaction of a send plan shares apart from its inputs, as the
 * planner reads it (`QbitSendPlanShape` in `@qbit/wallet-shared`): the
 * payment's recipient and memo output script lengths, the account's own
 * script length (every merge's output and the payment's change) and the
 * account's leaf script and control block lengths, which every input spends.
 */
export interface QbitSendPlanRevisionShape {
  paymentOutputScriptLengths: readonly number[]
  accountScriptLength: number
  leafScriptLength: number
  controlBlockLength: number
}

/** A merge as a revision prices it: same inputs, one output to the account. */
export interface QbitSendPlanMergePrice {
  vsize: number
  fee: number
  /** What its output pays back to the account: its inputs less its fee. */
  outputValue: number
}

/** The exact size and fee of a merge of `inputCount` inputs at `feeRate`. */
export function priceQbitSendPlanMerge(
  shape: QbitSendPlanRevisionShape,
  inputs: readonly { satoshis: number }[],
  feeRate: number
): QbitSendPlanMergePrice {
  const { vsize, fee } = estimateQbitP2mrTransaction({
    inputCount: inputs.length,
    outputScriptLengths: [shape.accountScriptLength],
    leafScriptLength: shape.leafScriptLength,
    controlBlockLength: shape.controlBlockLength,
    feeRate,
  })
  const total = inputs.reduce((sum, input) => sum + input.satoshis, 0)
  return { vsize, fee, outputValue: total - fee }
}

/** A payment over fixed inputs, priced as the planner prices one. */
export type QbitSendPlanPaymentPrice =
  | {
      ok: true
      amount: number
      fee: number
      change: number
      includeChange: boolean
      /** A remainder below dust paid as part of `fee`; 0 with change. */
      changeDroppedSats: number
      vsize: number
      maximumTotalFee: number
    }
  | {
      ok: false
      /** The largest amount these inputs pay at this rate; 0 when none. */
      maxSendable: number
    }

/**
 * The payment of a revised plan: `inputCount` inputs holding `inputTotal`
 * together (the merges' outputs and the outputs it spends directly), at
 * `feeRate`. As the planner prices a payment (`planQbitSend`): for an
 * amount, the amount never changes, change of at least dust is returned, a
 * smaller remainder is paid as fee within the payment's maximum total fee,
 * and inputs that cannot pay the amount and its fee refuse it; for
 * everything, the inputs less the fee of a payment without change. A
 * refusal carries the largest amount the inputs pay at this rate.
 */
export function priceQbitSendPlanPayment(
  shape: QbitSendPlanRevisionShape,
  inputTotal: number,
  inputCount: number,
  target: { kind: 'amount'; amount: number } | { kind: 'everything' },
  feeRate: number
): QbitSendPlanPaymentPrice {
  const estimate = (withChange: boolean): QbitP2mrTransactionEstimate =>
    estimateQbitP2mrTransaction({
      inputCount,
      outputScriptLengths: withChange
        ? [...shape.paymentOutputScriptLengths, shape.accountScriptLength]
        : [...shape.paymentOutputScriptLengths],
      leafScriptLength: shape.leafScriptLength,
      controlBlockLength: shape.controlBlockLength,
      feeRate,
    })
  const withoutChange = estimate(false)
  const largest = inputTotal - withoutChange.fee
  const maxSendable = largest >= QBIT_P2MR_DUST ? largest : 0
  if (target.kind === 'everything') {
    if (largest < QBIT_P2MR_DUST || !isQbitStandardTxSize(withoutChange.vsize)) {
      return { ok: false, maxSendable }
    }
    return {
      ok: true,
      amount: largest,
      fee: withoutChange.fee,
      change: 0,
      includeChange: false,
      changeDroppedSats: 0,
      vsize: withoutChange.vsize,
      maximumTotalFee: qbitMaximumTotalFee(withoutChange.vsize),
    }
  }
  const { amount } = target
  const withChange = estimate(true)
  const change = inputTotal - amount - withChange.fee
  if (change >= QBIT_P2MR_DUST && isQbitStandardTxSize(withChange.vsize)) {
    return {
      ok: true,
      amount,
      fee: withChange.fee,
      change,
      includeChange: true,
      changeDroppedSats: 0,
      vsize: withChange.vsize,
      maximumTotalFee: qbitMaximumTotalFee(withChange.vsize),
    }
  }
  const remainder = inputTotal - amount - withoutChange.fee
  const fee = withoutChange.fee + remainder
  if (
    remainder < 0 ||
    change >= QBIT_P2MR_DUST ||
    fee > qbitMaximumTotalFee(withoutChange.vsize) ||
    !isQbitStandardTxSize(withoutChange.vsize)
  ) {
    return { ok: false, maxSendable }
  }
  return {
    ok: true,
    amount,
    fee,
    change: 0,
    includeChange: false,
    changeDroppedSats: remainder,
    vsize: withoutChange.vsize,
    maximumTotalFee: qbitMaximumTotalFee(withoutChange.vsize),
  }
}

/** A transaction of a send plan, as `qbitSendPlanFeeProblem` checks its fee. */
export interface QbitSendPlanPricedTransaction {
  kind: 'merge' | 'payment'
  /** How many inputs it spends, each an output of the account spent through its leaf. */
  inputCount: number
  /** The script length of each of its outputs, in output order. */
  outputScriptLengths: readonly number[]
  /** The rate it was priced at, in bits/vB. */
  feeRate: unknown
  /** What it pays as fee: its inputs less its outputs. */
  fee: number
  /** Its size as recorded, checked when given. */
  vsize?: number
  /** merge: what its single output pays back to the account. */
  outputValue?: number
  /**
   * payment: it pays an amount and returns no change, so its fee may hold a
   * remainder too small to return as change.
   */
  foldsRemainder?: boolean
}

/** The figure of a send plan's transaction that the wallet's pricing would not give it. */
export type QbitSendPlanFeeProblem = 'feeRate' | 'vsize' | 'fee' | 'outputValue'

/**
 * Which figure of `transaction` the wallet's own pricing of a send plan
 * (`planQbitSend`, and a revision's `priceQbitSendPlanMerge` and
 * `priceQbitSendPlanPayment`) would not give it, or nothing when it gives
 * every one. Its rate is within policy (`isQbitFeeRateWithinPolicy`); its
 * size, when given, is the exact size of a transaction of its inputs and
 * outputs spending the account's leaf (`estimateQbitP2mrTransaction`); a
 * merge pays exactly that estimate's fee at its rate, and its output at
 * least dust; a payment pays exactly that estimate's fee too, unless it pays
 * an amount without change, when its fee may also hold a remainder that a
 * change output could not return (less than dust once that output's own fee
 * is paid), as the planner folds one, and never more than
 * `qbitMaximumTotalFee` for its size. So no fee is higher than the planner
 * makes it for a transaction of this shape at this rate. `shape` gives the
 * account's script lengths. Never throws.
 */
export function qbitSendPlanFeeProblem(
  transaction: QbitSendPlanPricedTransaction,
  shape: Pick<
    QbitSendPlanRevisionShape,
    'accountScriptLength' | 'leafScriptLength' | 'controlBlockLength'
  >
): QbitSendPlanFeeProblem | undefined {
  const { feeRate } = transaction
  if (!isQbitFeeRateWithinPolicy(feeRate)) return 'feeRate'
  const estimate = (outputScriptLengths: readonly number[]): QbitP2mrTransactionEstimate =>
    estimateQbitP2mrTransaction({
      inputCount: transaction.inputCount,
      outputScriptLengths,
      leafScriptLength: shape.leafScriptLength,
      controlBlockLength: shape.controlBlockLength,
      feeRate,
    })
  let priced: QbitP2mrTransactionEstimate
  let withChange: QbitP2mrTransactionEstimate | undefined
  try {
    priced = estimate(transaction.outputScriptLengths)
    if (transaction.kind === 'payment' && transaction.foldsRemainder) {
      withChange = estimate([...transaction.outputScriptLengths, shape.accountScriptLength])
    }
  } catch {
    return 'vsize'
  }
  if (transaction.vsize !== undefined && transaction.vsize !== priced.vsize) return 'vsize'
  const { fee } = transaction
  if (transaction.kind === 'merge') {
    if (fee !== priced.fee) return 'fee'
    const { outputValue } = transaction
    return outputValue !== undefined && outputValue >= QBIT_P2MR_DUST ? undefined : 'outputValue'
  }
  // The planner folds a remainder into the fee only while a change output
  // would return less than dust (`planQbitSend`), so the fee stays below
  // what the payment would pay with that output, plus dust.
  const highest = withChange
    ? Math.min(withChange.fee + QBIT_P2MR_DUST - 1, qbitMaximumTotalFee(priced.vsize))
    : priced.fee
  return Number.isSafeInteger(fee) && fee >= priced.fee && fee <= highest ? undefined : 'fee'
}

/** A merge in the network, as a replacement of it is checked against. */
export interface QbitSendPlanSentMerge {
  inputs: readonly { satoshis: number }[]
  fee: number
  vsize: number
}

/**
 * Whether a merge priced again at `feeRate` replaces `sent` by the rule the
 * wallet's fee bump applies (`qbitReplacementFeeAllowed`).
 */
export function qbitSendPlanMergeReplaceable(
  shape: QbitSendPlanRevisionShape,
  sent: QbitSendPlanSentMerge,
  feeRate: number
): boolean {
  const replacement = priceQbitSendPlanMerge(shape, sent.inputs, feeRate)
  return qbitReplacementFeeAllowed(
    { fee: sent.fee, vsize: sent.vsize },
    { fee: replacement.fee, vsize: replacement.vsize }
  )
}

/**
 * The lowest fee rate, in hundredths of a bit/vB, above `planRate` at which
 * a merge priced again replaces every one of `sent`: what a revision that
 * raises the merges' fee asks at least. A merge no rate within the wallet's
 * policy can replace makes it the rate the rule would need, past
 * `QBIT_MAX_FEE_RATE`.
 */
export function lowestQbitSendPlanRaiseRate(
  shape: QbitSendPlanRevisionShape,
  sent: readonly QbitSendPlanSentMerge[],
  planRate: number
): number {
  // In whole hundredths, so no rate is read back rounded.
  const ceiling = QBIT_MAX_FEE_RATE * 100
  let lowest = Math.floor(planRate * 100 + 1e-6) + 1
  for (const merge of sent) {
    // The replacement's fee must reach the merge's fee plus a bit a byte; at
    // c hundredths of a bit/vB a merge of the same size pays
    // ceil(vsize * c / 100), so c is at least the first past
    // 100 * (fee + vsize - 1) / vsize. The rule itself decides from just
    // below that.
    const needed = Math.floor((100 * (merge.fee + merge.vsize - 1)) / merge.vsize) + 1
    if (needed > ceiling) {
      lowest = Math.max(lowest, needed)
      continue
    }
    let hundredths = Math.max(lowest, needed - 2)
    while (hundredths <= ceiling && !qbitSendPlanMergeReplaceable(shape, merge, hundredths / 100)) {
      hundredths += 1
    }
    lowest = Math.max(lowest, hundredths)
  }
  return lowest / 100
}
