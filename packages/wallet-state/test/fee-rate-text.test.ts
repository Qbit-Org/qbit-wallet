import { describe, expect, it } from 'vitest'

import { formatFeeRate } from '../src/utils/fee-rate-text'

describe('formatFeeRate', () => {
  it.each([
    // 955 bits for 3,817 vB, 0.2502 bits/vB: a one-input send at the relay floor.
    [955 / 3_817, '0.25'],
    // 936 bits for the same size, 0.2452 bits/vB: below the floor, never shown at it.
    [936 / 3_817, '0.24'],
    [0.29, '0.29'],
    [1.15, '1.15'],
    [0.999, '0.99'],
    [1, '1'],
    [0, '0'],
    [0.25, '0.25'],
    [0.5, '0.5'],
    [1_909 / 3_817, '0.5'],
    [5_726 / 3_817, '1.5'],
    [0.57, '0.57'],
    [2.01, '2.01'],
    [4.35, '4.35'],
    [100.24, '100.24'],
    [400, '400'],
    [10_000.999, '10000.99'],
  ])('shows %s bits/vB as %s', (feeRate, shown) => {
    expect(formatFeeRate(feeRate)).toBe(shown)
  })

  it.each([0.004, 0.0099, 1 / 3_817])(
    'shows a positive rate below a hundredth, %s, as "<0.01", not as no fee',
    feeRate => {
      expect(formatFeeRate(feeRate)).toBe('<0.01')
    }
  )

  it.each([
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    -0.004,
  ])('shows %s as "-"', feeRate => {
    expect(formatFeeRate(feeRate)).toBe('-')
  })

  it('shows every rate already in hundredths as it is, from 0.01 to 10,000 bits/vB', () => {
    const changed: number[] = []
    for (let hundredths = 1; hundredths <= 1_000_000; hundredths++) {
      const rate = hundredths / 100
      if (formatFeeRate(rate) !== String(rate)) changed.push(rate)
    }
    expect(changed).toEqual([])
  })

  it('never shows a rate a fee pays for its size above that rate, nor a hundredth or more below it', () => {
    const wrong: string[] = []
    for (const vsize of [141, 3_817, 3_860, 7_634, 99_999]) {
      for (let fee = 1; fee <= 20_000; fee++) {
        const shown = formatFeeRate(fee / vsize)
        if (shown === '<0.01') {
          if (fee / vsize >= 0.01) wrong.push(`${fee}/${vsize}: ${shown}`)
          continue
        }
        // A whole number of hundredths, compared exactly: shown * 100 <= 100 * fee / vsize.
        const shownHundredths = Math.round(Number(shown) * 100)
        if (shownHundredths * vsize > 100 * fee || (shownHundredths + 1) * vsize <= 100 * fee) {
          wrong.push(`${fee}/${vsize}: ${shown}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('shows the whole part of a rate too large for hundredths', () => {
    expect(formatFeeRate(2 ** 46 + 0.5)).toBe('70368744177664')
  })
})
