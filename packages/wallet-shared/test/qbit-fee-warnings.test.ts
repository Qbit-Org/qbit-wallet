import { describe, expect, it } from 'vitest'

import type { FeeSummary } from '../src/types/common'
import {
  QBIT_FEE_WARNING_AMOUNT_PERCENT,
  QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE,
  QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE,
  QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE,
  assessQbitFee,
  qbitRecommendedFeeRate,
} from '../src/utils/qbit-fee-warnings'

function liveSummary(rates: number[]): FeeSummary {
  return {
    list: rates.map((feeRate, index) => ({ title: `tier-${index}`, desc: '', feeRate })),
    quote: { source: 'mempool-qbit', availability: 'available', freshness: 'live' },
  }
}

describe('qbit fee warnings', () => {
  it('names the fastest live tier as the recommendation and none for a fallback or invalid quote', () => {
    expect(qbitRecommendedFeeRate(liveSummary([1, 2, 5]))).toBe(5)
    expect(qbitRecommendedFeeRate(undefined)).toBeUndefined()
    expect(
      qbitRecommendedFeeRate({
        ...liveSummary([1, 1, 1]),
        quote: {
          source: 'mempool-qbit',
          availability: 'unavailable',
          freshness: 'fallback',
          fallbackReason: 'unavailable',
        },
      })
    ).toBeUndefined()
    // A quote without provenance is not a live recommendation.
    expect(qbitRecommendedFeeRate({ list: liveSummary([1, 1, 1]).list })).toBeUndefined()
    expect(qbitRecommendedFeeRate(liveSummary([]))).toBeUndefined()
    expect(qbitRecommendedFeeRate(liveSummary([1, Number.NaN, 1]))).toBeUndefined()
    expect(qbitRecommendedFeeRate(liveSummary([1, 10_001, 1]))).toBeUndefined()
  })

  it('flags a rate at the recommended multiple and not one just below it', () => {
    const recommendedFeeRate = 2
    const atMultiple = recommendedFeeRate * QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE
    expect(
      assessQbitFee({ fee: 77_200, feeRate: atMultiple, amount: 10_000_000, recommendedFeeRate })
        .reasons
    ).toEqual(['above_recommended_rate'])
    expect(
      assessQbitFee({
        fee: 76_000,
        feeRate: atMultiple - 0.01,
        amount: 10_000_000,
        recommendedFeeRate,
      }).reasons
    ).toEqual([])
  })

  it('flags a rate far above the relay floor whatever the explorer recommends', () => {
    // A glitched quote that recommends 10,000 bits/vB cannot hide a 400x fee.
    const assessment = assessQbitFee({
      fee: 1_544_000,
      feeRate: 400,
      amount: 25_000_000,
      recommendedFeeRate: 10_000,
    })
    expect(assessment.reasons).toEqual(['above_relay_floor'])
    expect(assessment.recommendedFeeRate).toBe(10_000)
    expect(
      assessQbitFee({
        fee: 3_860 * QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE,
        feeRate: QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE,
        amount: 1_000_000_000,
      }).reasons
    ).toEqual(['above_relay_floor'])
    expect(assessQbitFee({ fee: 382_140, feeRate: 99, amount: 1_000_000_000 }).reasons).toEqual([])
  })

  it('flags a fee that is a large share of the amount only above twice the recommendation', () => {
    const fee = 7_720
    const amount = (fee * 100) / QBIT_FEE_WARNING_AMOUNT_PERCENT
    const feeRate = QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE
    expect(assessQbitFee({ fee, feeRate, amount, recommendedFeeRate: 1 }).reasons).toEqual([
      'large_share_of_amount',
    ])
    // One bit more and the fee is below the share.
    expect(
      assessQbitFee({ fee, feeRate, amount: amount + 1, recommendedFeeRate: 1 }).reasons
    ).toEqual([])
    // Sub-dust change folded into the fee of a small send at the recommended
    // rate lifts its rate, but not to twice the recommendation.
    expect(
      assessQbitFee({ fee: 6_714, feeRate: 1.74, amount: 3_000, recommendedFeeRate: 1 }).reasons
    ).toEqual([])
    // Without a recommendation the relay floor stands in for it.
    expect(assessQbitFee({ fee, feeRate, amount }).reasons).toEqual(['large_share_of_amount'])
    // A transfer to the wallet itself has no amount to compare with.
    expect(assessQbitFee({ fee, feeRate, amount: 0 }).reasons).toEqual([])
  })

  it('reports every reason that applies and keeps the inputs it judged', () => {
    expect(
      assessQbitFee({ fee: 1_544_000, feeRate: 400, amount: 100_000, recommendedFeeRate: 1 })
    ).toEqual({
      fee: 1_544_000,
      feeRate: 400,
      amount: 100_000,
      recommendedFeeRate: 1,
      reasons: ['above_recommended_rate', 'above_relay_floor', 'large_share_of_amount'],
    })
    expect(assessQbitFee({ fee: 3_860, feeRate: 1, amount: 100_000 })).toEqual({
      fee: 3_860,
      feeRate: 1,
      amount: 100_000,
      reasons: [],
    })
  })

  it('refuses amounts and rates that are not bounded numbers', () => {
    const valid = { fee: 3_860, feeRate: 1, amount: 100_000 }
    for (const fee of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '3860' as never]) {
      expect(() => assessQbitFee({ ...valid, fee })).toThrow(RangeError)
    }
    for (const amount of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => assessQbitFee({ ...valid, amount })).toThrow(RangeError)
    }
    for (const feeRate of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assessQbitFee({ ...valid, feeRate })).toThrow(RangeError)
    }
    for (const recommendedFeeRate of [0, 0.5, 10_001, Number.NaN]) {
      expect(() => assessQbitFee({ ...valid, recommendedFeeRate })).toThrow(RangeError)
    }
  })
})
