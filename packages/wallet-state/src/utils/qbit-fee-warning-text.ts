import { numUtils } from '@qbit/base-utils'
import { QBIT_MIN_RELAY_FEE_RATE, type QbitFeeAssessment } from '@qbit/wallet-shared'

type Translate = (key: string, substitutions?: string | string[]) => string

export interface QbitFeeWarningText {
  /** Headline; absent when the fee is normal. */
  title?: string
  /** One sentence for each reason the fee was flagged. */
  lines: string[]
  /** Present when no live recommendation was available to compare the fee with. */
  recommendationUnavailable?: string
}

function formatRate(rate: number): string {
  return String(Number(rate.toFixed(2)))
}

/** The whole multiple a rate is of another; rounding error never shows 9x for a rate flagged at 10x. */
function formatMultiple(rate: number, of: number): string {
  return String(Math.floor(rate / of + 1e-9))
}

/** The sentences that explain a fee assessment to the user. */
export function qbitFeeWarningText(
  assessment: QbitFeeAssessment | undefined,
  t: Translate,
  qbitUnit: string
): QbitFeeWarningText {
  if (!assessment) return { lines: [] }
  const { fee, feeRate, amount, recommendedFeeRate, reasons } = assessment
  const lines = reasons.map(reason => {
    switch (reason) {
      case 'above_recommended_rate':
        return t('fee_warning_above_recommended', [
          formatRate(feeRate),
          formatMultiple(feeRate, recommendedFeeRate),
          formatRate(recommendedFeeRate),
        ])
      case 'above_relay_floor':
        return t('fee_warning_above_relay_floor', [
          formatRate(feeRate),
          formatMultiple(feeRate, QBIT_MIN_RELAY_FEE_RATE),
          String(QBIT_MIN_RELAY_FEE_RATE),
        ])
      case 'large_share_of_amount':
        return t('fee_warning_amount_share', [
          String(Math.floor((fee * 100) / amount)),
          numUtils.satoshisToAmount(amount),
          qbitUnit,
        ])
    }
  })

  let title: string | undefined
  if (reasons.includes('above_recommended_rate')) {
    title = t('the_fee_rate_is_much_higher_than_recommended_fee_rate')
  } else if (reasons.length > 0) {
    title = t('high_fee_rate_risk_title')
  }
  return {
    ...(title !== undefined ? { title } : {}),
    lines,
    ...(recommendedFeeRate === undefined
      ? { recommendationUnavailable: t('fee_warning_recommendation_unavailable') }
      : {}),
  }
}
