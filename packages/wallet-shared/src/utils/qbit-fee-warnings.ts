import type { FeeSummary } from '../types/common'
import type { QbitFeeAssessment, QbitFeeWarningReason } from '../types/decode-tx'
import {
  QBIT_FALLBACK_FEE_RATE,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  estimateQbitP2mrTransaction,
  isQbitFeeRateWithinPolicy,
} from './qbit-p2mr-fees'

/** A rate at least this many times the fastest live recommended rate is abnormal. */
export const QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE = 10

/**
 * A rate of at least this many bits/vB is abnormal whatever the explorer
 * recommends, so a glitched or hostile quote cannot hide it. The bound is
 * its own and does not move with the relay floor; the reason it gives is
 * still named `above_relay_floor`.
 */
export const QBIT_FEE_WARNING_RATE_BOUND = 100

/**
 * A fee at least this percentage of the amount sent is abnormal when its rate
 * is also at least `QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE` times the
 * recommendation (or `QBIT_FALLBACK_FEE_RATE` when there is none or it is
 * lower), or, when the caller asks for the check that needs no size, when the
 * fee is at least that multiple of what the smallest send costs at that rate.
 */
export const QBIT_FEE_WARNING_AMOUNT_PERCENT = 25

/**
 * Below this multiple of the recommended rate a fee that large is what a
 * small payment costs: sub-dust change folded into the fee lifts a
 * one-input send at the recommended rate to at most about 1.75 times it.
 * That change is a fixed amount, at most 2,854 bits, not a rate: it adds up
 * to about 0.75 bits/vB to a one-input send at any rate, which is 1.75 times
 * the rate only from 1 bit/vB up (about 4 times at 0.25 bits/vB). So the
 * share check never measures against less than `QBIT_FALLBACK_FEE_RATE`.
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
 * to compare with: the quote is the fallback offered without estimates, or a
 * tier is missing or outside the wallet's fee policy. A live rate may be
 * anywhere within that policy, below 1 bit/vB too.
 */
export function qbitRecommendedFeeRate(feeSummary: FeeSummary | undefined): number | undefined {
  if (!feeSummary || feeSummary.quote?.availability !== 'available') return undefined
  const rates = feeSummary.list.map(tier => tier?.feeRate)
  if (rates.length === 0 || !rates.every(isQbitFeeRateWithinPolicy)) return undefined
  return Math.max(...rates)
}

/**
 * Decide whether a fee is abnormal. `amount` is what the fee is compared with,
 * what the transaction pays to others; 0 skips the share check (a transfer to
 * the wallet itself). Without `recommendedFeeRate` only the wallet-side bounds
 * apply, and the caller must say that no comparison with live rates was made.
 *
 * The share check measures against the recommendation, but never against
 * less than `QBIT_FALLBACK_FEE_RATE`, which also stands in for a missing
 * recommendation: it is the rate the wallet sends at without one. Below
 * 1 bit/vB, sub-dust change folded into a small send's fee would lift the
 * send's rate past twice the recommendation by itself, since that change is
 * a fixed amount (see `QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE`). The
 * `above_recommended_rate` check compares with the recommendation as it is.
 *
 * `checkFeeShareWithoutSize` is for a fee whose `feeRate` rests on a size the
 * wallet did not build: the share check then also applies when the fee is at
 * least `QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE` times what the smallest send
 * costs at the rate the share check measures against, whatever `feeRate`
 * says. That rate is capped at `QBIT_FEE_WARNING_RATE_BOUND`, above which
 * every rate is flagged already, so a high quote cannot raise it. Without a
 * live recommendation a small payment funded by two or more inputs can need
 * the confirmation at a rate near the fallback rate. A fee only this flags
 * is marked `highFeeAtNormalRate`.
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
  if (feeRate >= QBIT_FEE_WARNING_RATE_BOUND) {
    reasons.push('above_relay_floor')
  }
  // Never below the fallback rate, as QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE says.
  const shareRate = Math.max(recommendedFeeRate ?? QBIT_FALLBACK_FEE_RATE, QBIT_FALLBACK_FEE_RATE)
  const aboveShareRate = feeRate >= shareRate * QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE
  const aboveSmallestSendFee =
    checkFeeShareWithoutSize &&
    fee >=
      Math.min(shareRate, QBIT_FEE_WARNING_RATE_BOUND) *
        QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE *
        QBIT_FEE_WARNING_SMALLEST_SEND_VSIZE
  if (
    amount > 0 &&
    (aboveShareRate || aboveSmallestSendFee) &&
    fee * 100 >= amount * QBIT_FEE_WARNING_AMOUNT_PERCENT
  ) {
    reasons.push('large_share_of_amount')
  }
  // The share check that needs no size flagged it alone: no rate condition holds.
  const highFeeAtNormalRate =
    reasons.length === 1 && reasons[0] === 'large_share_of_amount' && !aboveShareRate

  return {
    fee,
    feeRate,
    amount,
    ...(recommendedFeeRate !== undefined ? { recommendedFeeRate } : {}),
    reasons,
    ...(highFeeAtNormalRate ? { highFeeAtNormalRate: true as const } : {}),
  }
}
