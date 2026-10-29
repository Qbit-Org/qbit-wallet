import type { FeeSummary } from '../types/common'
import type { QbitFeeAssessment, QbitFeeWarningReason } from '../types/decode-tx'
import {
  QBIT_MIN_RELAY_FEE_RATE,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  estimateQbitP2mrTransaction,
  isQbitFeeRateWithinPolicy,
} from './qbit-p2mr-fees'

/** A rate at least this many times the fastest live recommended rate is abnormal. */
export const QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE = 10

/**
 * A rate at least this many times the relay floor is abnormal whatever the
 * explorer recommends, so a glitched or hostile quote cannot hide it.
 */
export const QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE = 100

/**
 * A fee at least this percentage of the amount sent is abnormal when its rate
 * is also at least `QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE` times the
 * recommendation (or the relay floor when there is none), or, when the caller
 * asks for the check that needs no size, when the fee is at least that
 * multiple of what the smallest send costs at the recommendation.
 */
export const QBIT_FEE_WARNING_AMOUNT_PERCENT = 25

/**
 * Below this multiple of the recommended rate a fee that large is what a
 * small payment costs: sub-dust change folded into the fee lifts a
 * one-input send at the recommended rate to at most about 1.75 times it.
 */
export const QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE = 2

/**
 * Finalized size of the smallest send the wallet builds: one single-key P2MR
 * input (a 34-byte leaf script in a zero-depth control block) paying one
 * 34-byte P2MR output. A transaction the wallet funds is about this size or
 * larger, so a fee divided by this size is about the rate it pays or more.
 */
export const QBIT_FEE_WARNING_SMALLEST_SEND_VSIZE = estimateQbitP2mrTransaction({
  inputCount: 1,
  outputScriptLengths: [34],
  leafScriptLength: 34,
  controlBlockLength: QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
}).vsize

function assertSafeAmount(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a safe integer >= 0`)
  }
}

/**
 * The fastest rate a live quote recommends, or undefined when there is none
 * to compare with: the quote is the relay-floor fallback, or a tier is
 * missing or outside the wallet's fee policy.
 */
export function qbitRecommendedFeeRate(feeSummary: FeeSummary | undefined): number | undefined {
  if (!feeSummary || feeSummary.quote?.availability !== 'available') return undefined
  const rates = feeSummary.list.map(tier => tier?.feeRate)
  if (rates.length === 0 || !rates.every(isQbitFeeRateWithinPolicy)) return undefined
  return Math.max(...rates)
}

/**
 * Decide whether a fee is abnormal. `amount` is what the transaction pays to
 * others; 0 skips the share check (a transfer to the wallet itself). Without
 * `recommendedFeeRate` only the wallet-side bounds apply, and the caller must
 * say that no comparison with live rates was made.
 *
 * `checkFeeShareWithoutSize` is for a fee whose `feeRate` rests on a size the
 * wallet did not build: the share check then also applies when the fee is at
 * least `QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE` times what the smallest send
 * costs at the recommendation, whatever `feeRate` says. That recommendation
 * is capped at `QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE` times the relay floor,
 * above which every rate is flagged already, so a high quote cannot raise it.
 */
export function assessQbitFee({
  fee,
  feeRate,
  amount,
  recommendedFeeRate,
  checkFeeShareWithoutSize = false,
}: {
  fee: number
  feeRate: number
  amount: number
  recommendedFeeRate?: number | undefined
  checkFeeShareWithoutSize?: boolean
}): QbitFeeAssessment {
  assertSafeAmount('fee', fee)
  assertSafeAmount('amount', amount)
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate < 0) {
    throw new RangeError('feeRate must be a finite number >= 0')
  }
  if (recommendedFeeRate !== undefined && !isQbitFeeRateWithinPolicy(recommendedFeeRate)) {
    throw new RangeError('recommendedFeeRate must be within the wallet fee policy')
  }

  const reasons: QbitFeeWarningReason[] = []
  if (
    recommendedFeeRate !== undefined &&
    feeRate >= recommendedFeeRate * QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE
  ) {
    reasons.push('above_recommended_rate')
  }
  if (feeRate >= QBIT_MIN_RELAY_FEE_RATE * QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE) {
    reasons.push('above_relay_floor')
  }
  const shareRate = recommendedFeeRate ?? QBIT_MIN_RELAY_FEE_RATE
  const aboveShareRate =
    feeRate >= shareRate * QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE ||
    (checkFeeShareWithoutSize &&
      fee >=
        Math.min(shareRate, QBIT_MIN_RELAY_FEE_RATE * QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE) *
          QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE *
          QBIT_FEE_WARNING_SMALLEST_SEND_VSIZE)
  if (amount > 0 && aboveShareRate && fee * 100 >= amount * QBIT_FEE_WARNING_AMOUNT_PERCENT) {
    reasons.push('large_share_of_amount')
  }

  return {
    fee,
    feeRate,
    amount,
    ...(recommendedFeeRate !== undefined ? { recommendedFeeRate } : {}),
    reasons,
  }
}
