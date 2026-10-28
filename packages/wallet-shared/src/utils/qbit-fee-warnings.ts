import type { FeeSummary } from '../types/common'
import type { QbitFeeAssessment, QbitFeeWarningReason } from '../types/decode-tx'
import { QBIT_MIN_RELAY_FEE_RATE, isQbitFeeRateWithinPolicy } from './qbit-p2mr-fees'

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
 * recommendation (or the relay floor when there is none).
 */
export const QBIT_FEE_WARNING_AMOUNT_PERCENT = 25

/**
 * Below this multiple of the recommended rate a fee that large is what a
 * small payment costs: sub-dust change folded into the fee lifts a
 * one-input send at the recommended rate to at most about 1.75 times it.
 */
export const QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE = 2

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
 */
export function assessQbitFee({
  fee,
  feeRate,
  amount,
  recommendedFeeRate,
}: {
  fee: number
  feeRate: number
  amount: number
  recommendedFeeRate?: number | undefined
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
  if (
    amount > 0 &&
    feeRate >=
      (recommendedFeeRate ?? QBIT_MIN_RELAY_FEE_RATE) * QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE &&
    fee * 100 >= amount * QBIT_FEE_WARNING_AMOUNT_PERCENT
  ) {
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
