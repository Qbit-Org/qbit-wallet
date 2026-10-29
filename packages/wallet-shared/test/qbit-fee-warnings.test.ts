import { describe, expect, it } from 'vitest'

import { QBIT_P2MR_DUST } from '../src/constants/common'
import type { FeeSummary } from '../src/types/common'
import {
  QBIT_FEE_WARNING_AMOUNT_PERCENT,
  QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE,
  QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE,
  QBIT_FEE_WARNING_RELAY_FLOOR_MULTIPLE,
  QBIT_FEE_WARNING_SMALLEST_SEND_VSIZE,
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

  describe('the share check that needs no size', () => {
    const recommendedFeeRate = 9
    /** Twice what the smallest send, 3,817 vB, costs at 9 bits/vB. */
    const FLOOR = 68_706
    /** A rate below every rate condition, as a size estimate too large would show. */
    const feeRate = 1

    it('sizes the smallest send as one single-key P2MR input paying one P2MR output', () => {
      expect(QBIT_FEE_WARNING_SMALLEST_SEND_VSIZE).toBe(3_817)
      expect(QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE * recommendedFeeRate * 3_817).toBe(FLOOR)
    })

    it('flags a fee that is a large share of the payout whatever its rate, only when asked', () => {
      const judged = { fee: 400_000, feeRate, amount: 100_000, recommendedFeeRate }
      expect(assessQbitFee(judged).reasons).toEqual([])
      expect(assessQbitFee({ ...judged, checkFeeShareWithoutSize: true })).toEqual({
        fee: 400_000,
        feeRate,
        amount: 100_000,
        recommendedFeeRate,
        reasons: ['large_share_of_amount'],
      })
    })

    it('flags a fee at twice what the smallest send costs and not one bit less', () => {
      const judged = {
        feeRate,
        amount: 100_000,
        recommendedFeeRate,
        checkFeeShareWithoutSize: true,
      }
      expect(assessQbitFee({ ...judged, fee: FLOOR }).reasons).toEqual(['large_share_of_amount'])
      expect(assessQbitFee({ ...judged, fee: FLOOR - 1 }).reasons).toEqual([])
    })

    it('flags a fee at the share of the payout and not when the payout is one bit more', () => {
      const fee = 100_000
      const amount = (fee * 100) / QBIT_FEE_WARNING_AMOUNT_PERCENT
      const judged = { fee, feeRate, recommendedFeeRate, checkFeeShareWithoutSize: true }
      expect(assessQbitFee({ ...judged, amount }).reasons).toEqual(['large_share_of_amount'])
      expect(assessQbitFee({ ...judged, amount: amount + 1 }).reasons).toEqual([])
    })

    it('leaves a payment of the dust limit with sub-dust change folded into its fee unflagged', () => {
      // One input and one output at the recommended 1 bit/vB, plus the
      // largest change too small to keep: 6,671 bits, below twice 3,817.
      const fee = 3_817 + QBIT_P2MR_DUST - 1
      const judged = {
        fee,
        feeRate: fee / 3_817,
        amount: QBIT_P2MR_DUST,
        checkFeeShareWithoutSize: true,
      }
      expect(assessQbitFee({ ...judged, recommendedFeeRate: 1 }).reasons).toEqual([])
      // Without a recommendation the relay floor stands in for it.
      expect(assessQbitFee(judged).reasons).toEqual([])
      // At the busier 9 bits/vB the same payment pays 37,207 bits.
      expect(
        assessQbitFee({
          ...judged,
          fee: 9 * 3_817 + QBIT_P2MR_DUST - 1,
          feeRate: 9.75,
          recommendedFeeRate,
        }).reasons
      ).toEqual([])
    })

    it('confirms a small payment three inputs fund at the recommended rate', () => {
      // 11,341 vB at 1 bit/vB is more than twice the smallest send.
      expect(
        assessQbitFee({
          fee: 11_341,
          feeRate: 1,
          amount: 40_000,
          recommendedFeeRate: 1,
          checkFeeShareWithoutSize: true,
        }).reasons
      ).toEqual(['large_share_of_amount'])
    })

    it('never share-checks a transfer to the wallet itself', () => {
      expect(
        assessQbitFee({
          fee: 400_000,
          feeRate,
          amount: 0,
          recommendedFeeRate,
          checkFeeShareWithoutSize: true,
        }).reasons
      ).toEqual([])
    })

    it('caps the recommendation it is measured with, so a high quote cannot raise it', () => {
      // A quote of 10,000 bits/vB counts as 100: twice 3,817 vB at 100 is 763,400.
      const judged = {
        feeRate: 50,
        amount: 1_000_000,
        recommendedFeeRate: 10_000,
        checkFeeShareWithoutSize: true,
      }
      expect(assessQbitFee({ ...judged, fee: 763_400 }).reasons).toEqual(['large_share_of_amount'])
      expect(assessQbitFee({ ...judged, fee: 763_399 }).reasons).toEqual([])
    })
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
