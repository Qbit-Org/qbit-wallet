import { describe, expect, it } from 'vitest'

import { QBIT_P2MR_DUST } from '../src/constants/common'
import type { FeeSummary } from '../src/types/common'
import type { QbitFeeWarningReason } from '../src/types/decode-tx'
import {
  QBIT_FEE_WARNING_AMOUNT_PERCENT,
  QBIT_FEE_WARNING_AMOUNT_RATE_MULTIPLE,
  QBIT_FEE_WARNING_RATE_BOUND,
  QBIT_FEE_WARNING_RECOMMENDED_RATE_MULTIPLE,
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

  it('takes live tiers from the 0.25 bits/vB relay floor up as a recommendation', () => {
    expect(qbitRecommendedFeeRate(liveSummary([0.25, 0.5, 1]))).toBe(1)
    expect(qbitRecommendedFeeRate(liveSummary([0.25, 0.25, 0.25]))).toBe(0.25)
    expect(qbitRecommendedFeeRate(liveSummary([0.25, 0.5, 0.75]))).toBe(0.75)
    // A tier below the floor is outside the policy: no recommendation.
    expect(qbitRecommendedFeeRate(liveSummary([0.24, 0.5, 1]))).toBeUndefined()
    expect(qbitRecommendedFeeRate(liveSummary([0, 0.5, 1]))).toBeUndefined()
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

  it('flags a rate of 100 bits/vB or more whatever the explorer recommends', () => {
    // The bound is its own, 400 times the 0.25 bits/vB floor, and stays at 100.
    expect(QBIT_FEE_WARNING_RATE_BOUND).toBe(100)
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
      assessQbitFee({ fee: 386_000, feeRate: 100, amount: 1_000_000_000 }).reasons
    ).toEqual(['above_relay_floor'])
    expect(assessQbitFee({ fee: 382_140, feeRate: 99, amount: 1_000_000_000 }).reasons).toEqual([])
    expect(
      assessQbitFee({ fee: 385_961, feeRate: 99.99, amount: 1_000_000_000 }).reasons
    ).toEqual([])
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
    // Without a recommendation the 1 bit/vB fallback rate stands in for it.
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
        highFeeAtNormalRate: true,
      })
    })

    it('marks the fee as high at a normal rate only when no rate condition holds', () => {
      const judged = { amount: 100_000, recommendedFeeRate, checkFeeShareWithoutSize: true }
      expect(assessQbitFee({ ...judged, fee: 400_000, feeRate: 17.9 })).toMatchObject({
        reasons: ['large_share_of_amount'],
        highFeeAtNormalRate: true,
      })
      // Twice the recommended 9 bits/vB: the share check flags it by its rate as well.
      const byRate = assessQbitFee({ ...judged, fee: 400_000, feeRate: 18 })
      expect(byRate.reasons).toEqual(['large_share_of_amount'])
      expect(byRate).not.toHaveProperty('highFeeAtNormalRate')
      // Below twice a 10,000 bits/vB quote, but a rate the relay floor check flags.
      const byRelayFloor = assessQbitFee({
        ...judged,
        fee: 800_000,
        feeRate: 100,
        amount: 1_000_000,
        recommendedFeeRate: 10_000,
      })
      expect(byRelayFloor.reasons).toEqual(['above_relay_floor', 'large_share_of_amount'])
      expect(byRelayFloor).not.toHaveProperty('highFeeAtNormalRate')
      expect(assessQbitFee({ ...judged, fee: 1_000, feeRate })).toEqual({
        fee: 1_000,
        feeRate,
        amount: 100_000,
        recommendedFeeRate,
        reasons: [],
      })
    })

    it('measures with the 1 bit/vB fallback rate when there is no live recommendation', () => {
      // Twice 3,817 vB at 1 bit/vB: a two-input payment at that rate pays about this much.
      const judged = { feeRate, amount: 20_000, checkFeeShareWithoutSize: true }
      expect(assessQbitFee({ ...judged, fee: 7_634 })).toMatchObject({
        reasons: ['large_share_of_amount'],
        highFeeAtNormalRate: true,
      })
      expect(assessQbitFee({ ...judged, fee: 7_633 }).reasons).toEqual([])
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
      // Without a recommendation the 1 bit/vB fallback rate stands in for it.
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
    for (const recommendedFeeRate of [
      0,
      0.24,
      0.2499,
      -1,
      10_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => assessQbitFee({ ...valid, recommendedFeeRate })).toThrow(RangeError)
    }
    for (const recommendedFeeRate of [0.25, 0.5, 0.999, 10_000]) {
      expect(assessQbitFee({ ...valid, recommendedFeeRate })).toMatchObject({ recommendedFeeRate })
    }
  })
})

const R = 'above_recommended_rate'
const F = 'above_relay_floor'
const S = 'large_share_of_amount'
const U = undefined

/** fee, feeRate, amount, recommendedFeeRate, checkFeeShareWithoutSize, reasons, highFeeAtNormalRate */
type Judged = [
  number,
  number,
  number,
  number | undefined,
  boolean,
  QbitFeeWarningReason[],
  true?,
]

function expectAssessment([
  fee,
  feeRate,
  amount,
  recommendedFeeRate,
  checkFeeShareWithoutSize,
  reasons,
  highFeeAtNormalRate,
]: Judged): void {
  expect(
    assessQbitFee({ fee, feeRate, amount, recommendedFeeRate, checkFeeShareWithoutSize })
  ).toStrictEqual({
    fee,
    feeRate,
    amount,
    ...(recommendedFeeRate !== undefined ? { recommendedFeeRate } : {}),
    reasons,
    ...(highFeeAtNormalRate ? { highFeeAtNormalRate } : {}),
  })
}

describe('fee warnings at 1 bit/vB and above', () => {
  // What assessQbitFee returned while the floor was 1 bit/vB, read from that
  // code, not from this one. A rate of 1 bit/vB or more, judged without a
  // recommendation or against one of 1 bit/vB or more, gets the same answer
  // on both sides of every boundary: ten times the recommendation, 100
  // bits/vB, a quarter of the amount at twice the recommendation (1 bit/vB
  // without one), and twice the smallest send at the recommendation, capped
  // at 100 bits/vB.
  const UNCHANGED: Judged[] = [
  [77_200, 20, 10_000_000, 2, false, [R]],
  [77_161, 19.99, 10_000_000, 2, false, []],
  [38_600, 10, 10_000_000, 1, false, [R]],
  [38_561, 9.99, 10_000_000, 1, false, []],
  [48_250, 12.5, 10_000_000, 1.25, false, [R]],
  [48_211, 12.49, 10_000_000, 1.25, false, []],
  [347_400, 90, 10_000_000, 9, false, [R]],
  [347_361, 89.99, 10_000_000, 9, false, []],
  [366_700, 95, 10_000_000, 9.5, false, [R]],
  [366_661, 94.99, 10_000_000, 9.5, false, []],
  [38_600_000, 10_000, 1_000_000_000, 1_000, false, [R, F]],
  [38_599_961, 9_999.99, 1_000_000_000, 1_000, false, [F]],
  [386_000, 100, 1_000_000_000, U, false, [F]],
  [385_961, 99.99, 1_000_000_000, U, false, []],
  [386_039, 100.01, 1_000_000_000, U, false, [F]],
  [382_140, 99, 1_000_000_000, U, false, []],
  [386_000, 100, 1_000_000_000, 10, false, [R, F]],
  [386_000, 100, 1_000_000_000, 50, false, [F]],
  [386_000, 100, 1_000_000_000, 101, false, [F]],
  [1_544_000, 400, 25_000_000, 10_000, false, [F]],
  [38_600_000, 10_000, 1_000_000_000, 10_000, false, [F]],
  [77_200_000, 20_000, 1_000_000_000, U, false, [F]],
  [7_720, 2, 30_880, 1, false, [S]],
  [7_720, 2, 30_881, 1, false, []],
  [7_720, 1.99, 30_880, 1, false, []],
  [7_720, 2, 30_880, U, false, [S]],
  [7_720, 2, 30_881, U, false, []],
  [7_720, 1.99, 30_880, U, false, []],
  [7_720, 2, 0, U, false, []],
  [6_714, 1.74, 3_000, 1, false, []],
  [11_580, 3, 46_320, 1.5, false, [S]],
  [11_580, 2.99, 46_320, 1.5, false, []],
  [400_000, 18, 100_000, 9, false, [S]],
  [400_000, 17.99, 100_000, 9, false, []],
  [400_000, 1, 100_000, 9, false, []],
  [3_817, 1, 100_000, 1, false, []],
  [3_860, 1, 100_000, U, false, []],
  [0, 1, 100_000, U, false, []],
  [1_544_000, 400, 100_000, 1, false, [R, F, S]],
  [7_634, 1, 20_000, U, true, [S], true],
  [7_633, 1, 20_000, U, true, []],
  [7_634, 1, 20_000, 1, true, [S], true],
  [7_633, 1, 20_000, 1, true, []],
  [7_634, 1, 30_536, U, true, [S], true],
  [7_634, 1, 30_537, U, true, []],
  [7_634, 2, 20_000, U, true, [S]],
  [9_543, 1, 20_000, 1.25, true, [S], true],
  [9_542, 1, 20_000, 1.25, true, []],
  [68_706, 1, 100_000, 9, true, [S], true],
  [68_705, 1, 100_000, 9, true, []],
  [100_000, 1, 400_000, 9, true, [S], true],
  [100_000, 1, 400_001, 9, true, []],
  [400_000, 1, 100_000, 9, true, [S], true],
  [400_000, 17.9, 100_000, 9, true, [S], true],
  [400_000, 18, 100_000, 9, true, [S]],
  [400_000, 90, 100_000, 9, true, [R, S]],
  [400_000, 1, 0, 9, true, []],
  [1_000, 1, 100_000, 9, true, []],
  [381_700, 1, 1_000_000, 50, true, [S], true],
  [381_699, 1, 1_000_000, 50, true, []],
  [763_400, 50, 1_000_000, 100, true, [S], true],
  [763_400, 50, 1_000_000, 101, true, [S], true],
  [763_400, 50, 1_000_000, 10_000, true, [S], true],
  [763_399, 50, 1_000_000, 10_000, true, []],
  [800_000, 100, 1_000_000, 10_000, true, [F, S]],
  [6_671, 6_671 / 3_817, 2_855, 1, true, []],
  [6_671, 6_671 / 3_817, 2_855, U, true, []],
  [37_207, 9.75, 2_855, 9, true, []],
  [11_341, 1, 40_000, 1, true, [S], true],
  [1_544_000, 400, 100_000, 1, true, [R, F, S]],
  ]

  it.each(UNCHANGED)(
    'judges %s bits at %s bits/vB paying %s, recommended %s, sizeless check %s, as before',
    (...judged) => {
      expectAssessment(judged as Judged)
    }
  )
})

describe('fee warnings below 1 bit/vB', () => {
  const BELOW_ONE: Judged[] = [
    // Ten times a recommendation of 0.25 bits/vB is 2.5, and of 0.5 is 5.
    [9_650, 2.5, 10_000_000, 0.25, false, [R]],
    [9_611, 2.49, 10_000_000, 0.25, false, []],
    [19_300, 5, 10_000_000, 0.5, false, [R]],
    [19_261, 4.99, 10_000_000, 0.5, false, []],
    // 100 bits/vB whatever the recommendation.
    [386_000, 100, 1_000_000_000, 0.25, false, [R, F]],
    [385_961, 99.99, 1_000_000_000, 0.25, false, [R]],
    [386_000, 100, 1_000_000_000, 0.5, false, [R, F]],
    [385_961, 99.99, 1_000_000_000, 0.5, false, [R]],
    // 100 times the 0.25 bits/vB floor is no bound: 25 bits/vB is flagged
    // only as ten times a recommendation.
    [96_500, 25, 1_000_000_000, 0.25, false, [R]],
    [96_500, 25, 1_000_000_000, U, false, []],
    // The share check measures against 1 bit/vB, not a lower recommendation:
    // a quarter of the amount is flagged from 2 bits/vB, not from twice it.
    [7_720, 2, 30_880, 0.25, false, [S]],
    [7_720, 1.99, 30_880, 0.25, false, []],
    [7_720, 2, 30_880, 0.5, false, [S]],
    [7_720, 1.99, 30_880, 0.5, false, []],
    [1_930, 0.5, 7_720, 0.25, false, []],
    [3_860, 1, 15_440, 0.5, false, []],
    [9_650, 2.5, 38_600, 0.25, false, [R, S]],
    [1_544_000, 400, 100_000, 0.25, false, [R, F, S]],
    // A one-input payment of 10,000 bits at the recommendation, with 2,000
    // bits of change too small to keep paid as fee: 955 + 2,000 bits at
    // 0.25 bits/vB, 1,909 + 2,000 at 0.5. At 1 bit/vB it pays 5,817 bits.
    [2_955, 2_955 / 3_817, 10_000, 0.25, false, []],
    [3_909, 3_909 / 3_817, 10_000, 0.5, false, []],
    // A website's payment of the dust limit at the recommendation, with the
    // largest change too small to keep paid as fee, judged without its size.
    [3_809, 3_809 / 3_817, 2_855, 0.25, true, []],
    [4_763, 4_763 / 3_817, 2_855, 0.5, true, []],
    // Without its size the fee is measured against twice the smallest send
    // at 1 bit/vB, 7,634 bits, whatever the lower recommendation.
    [7_634, 0.25, 30_536, 0.25, true, [S], true],
    [7_633, 0.25, 30_532, 0.25, true, []],
    [7_634, 0.5, 30_536, 0.5, true, [S], true],
    [7_633, 0.5, 30_532, 0.5, true, []],
    // Without a recommendation a rate below 1 bit/vB is measured against the
    // 1 bit/vB fallback rate in the same way.
    [1_930, 0.5, 7_720, U, false, []],
    [1_909, 0.25, 7_636, U, true, []],
    [7_633, 0.25, 20_000, U, true, []],
    [7_634, 0.25, 20_000, U, true, [S], true],
  ]

  it.each(BELOW_ONE)(
    'judges %s bits at %s bits/vB paying %s, recommended %s, sizeless check %s',
    (...judged) => {
      expectAssessment(judged as Judged)
    }
  )
})
