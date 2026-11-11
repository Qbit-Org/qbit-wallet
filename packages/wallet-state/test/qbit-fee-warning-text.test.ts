import type { QbitFeeAssessment } from '@qbit/wallet-shared'
import { describe, expect, it } from 'vitest'

import { qbitFeeWarningText } from '../src/utils/qbit-fee-warning-text'

const t = (key: string, substitutions?: string | string[]) =>
  Array.isArray(substitutions) ? `${key}:${substitutions.join(',')}` : key

function aboveBound(feeRate: number, fee: number): QbitFeeAssessment {
  return { fee, feeRate, amount: 10_000_000, reasons: ['above_relay_floor'] }
}

describe('qbitFeeWarningText', () => {
  it('measures a rate past the 100 bits/vB bound against the 0.25 bits/vB relay floor', () => {
    expect(qbitFeeWarningText(aboveBound(100, 381_700), t, 'QBT').lines).toEqual([
      'fee_warning_above_relay_floor:100,400,0.25',
    ])
    expect(qbitFeeWarningText(aboveBound(150, 572_550), t, 'QBT').lines).toEqual([
      'fee_warning_above_relay_floor:150,600,0.25',
    ])
  })

  it('gives the whole multiple of the floor, and the rate to two decimal places', () => {
    // 955 bits more than 100 bits/vB over 3,817 vB: 100.25 bits/vB, 401 times the floor.
    expect(qbitFeeWarningText(aboveBound(382_655 / 3_817, 382_655), t, 'QBT').lines).toEqual([
      'fee_warning_above_relay_floor:100.25,401,0.25',
    ])
    // 100.24 bits/vB is still 400 times it, not 401.
    expect(qbitFeeWarningText(aboveBound(100.24, 382_617), t, 'QBT').lines).toEqual([
      'fee_warning_above_relay_floor:100.24,400,0.25',
    ])
  })

  it('never gives a rate above the one paid', () => {
    // 382,650 bits for 3,817 vB: 100.2489 bits/vB, 100.24 and not 100.25.
    expect(qbitFeeWarningText(aboveBound(382_650 / 3_817, 382_650), t, 'QBT').lines).toEqual([
      'fee_warning_above_relay_floor:100.24,400,0.25',
    ])
    // 9,566 bits for 3,817 vB: 2.5062 bits/vB, 2.5 and not 2.51, beside a
    // recommendation already in hundredths, shown as it is.
    const text = qbitFeeWarningText(
      {
        fee: 9_566,
        feeRate: 9_566 / 3_817,
        amount: 10_000_000,
        recommendedFeeRate: 0.25,
        reasons: ['above_recommended_rate'],
      },
      t,
      'QBT'
    )
    expect(text.lines).toEqual(['fee_warning_above_recommended:2.5,10,0.25'])
  })

  it('compares with a recommendation below 1 bit/vB as it is', () => {
    const text = qbitFeeWarningText(
      {
        fee: 9_543,
        feeRate: 2.5,
        amount: 10_000_000,
        recommendedFeeRate: 0.25,
        reasons: ['above_recommended_rate'],
      },
      t,
      'QBT'
    )
    expect(text.lines).toEqual(['fee_warning_above_recommended:2.5,10,0.25'])
    expect(text.recommendationUnavailable).toBeUndefined()
  })
})
