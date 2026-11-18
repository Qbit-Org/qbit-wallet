import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { formatBalanceAmount, useQbitDisplayLogic } from '../../src/ui-hooks/useQbitDisplayLogic'

describe('formatBalanceAmount', () => {
  it('formats an amount as satoshisToAmount writes it', () => {
    expect(formatBalanceAmount('118591.83137906')).toEqual({
      whole: '118,591',
      decimals: '83137',
      text: '118,591.83137',
      exact: '118,591.83137906',
      truncated: true,
    })
    expect(formatBalanceAmount('0.00001999')?.text).toBe('0.00001')
    expect(formatBalanceAmount('0.00000001')?.text).toBe('<0.00001')
    expect(formatBalanceAmount('0.00000000')?.text).toBe('0.00000')
    // Fewer decimals, or none, are the same amount.
    expect(formatBalanceAmount('0')?.exact).toBe('0.00000000')
    expect(formatBalanceAmount('12.5')?.exact).toBe('12.50000000')
    expect(formatBalanceAmount('20999999.99999999')?.text).toBe('20,999,999.99999')
    // Above 2^53 satoshis: exact only through the digit string, not a number.
    expect(formatBalanceAmount('90071992.54740993')?.exact).toBe('90,071,992.54740993')
  })

  it('formats nothing that is not an amount of coins with at most eight decimals', () => {
    for (const amount of [
      '--',
      '****',
      '',
      'NaN',
      '-1.00000000',
      '1.123456789',
      '1e3',
      ' 1',
      '1,000.00000',
    ]) {
      expect(formatBalanceAmount(amount), amount).toBeNull()
    }
  })

  it('refuses leading zeros in the whole part', () => {
    for (const amount of ['007', '00', '00.5', '01.00000000']) {
      expect(formatBalanceAmount(amount), amount).toBeNull()
    }
    expect(formatBalanceAmount('0.5')?.text).toBe('0.50000')
    expect(formatBalanceAmount('10.00000000')?.text).toBe('10.00000')
  })

  it('refuses what is not a string', () => {
    for (const amount of [5, 0, null, undefined, { toString: () => '5' }] as unknown as string[]) {
      expect(formatBalanceAmount(amount), String(amount)).toBeNull()
    }
  })
})

const displayOf = (balance: string) => renderHook(() => useQbitDisplayLogic(balance)).result.current

describe('useQbitDisplayLogic', () => {
  it('sets the whole coins and the point apart from the five decimals, with the exact amount', () => {
    expect(displayOf('118591.83137906')).toEqual({
      totalAmountMainPart: '118,591.',
      totalAmountSubPart: '83137',
      exactAmount: '118,591.83137906',
    })
    expect(displayOf('0.00000999')).toEqual({
      totalAmountMainPart: '<0.',
      totalAmountSubPart: '00001',
      exactAmount: '0.00000999',
    })
    expect(displayOf('0.00000000')).toEqual({
      totalAmountMainPart: '0.',
      totalAmountSubPart: '00000',
      exactAmount: '0.00000000',
    })
  })

  it('shows an unknown balance as -- with no exact amount', () => {
    for (const balance of ['--', 'NaN', '']) {
      expect(displayOf(balance), balance).toEqual({
        totalAmountMainPart: '',
        totalAmountSubPart: '--',
        exactAmount: undefined,
      })
    }
  })
})
