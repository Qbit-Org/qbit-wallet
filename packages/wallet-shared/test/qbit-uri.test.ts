import { describe, expect, it } from 'vitest'

import {
  QbitUriParseError,
  formatQbitUri,
  isQbitUri,
  parseQbitUri,
} from '../src'

describe('qbit URI utilities', () => {
  it('formats receive URIs with an address and optional amount', () => {
    expect(formatQbitUri('qb1zexample')).toBe('qbit:qb1zexample')
    expect(formatQbitUri('qb1zexample', { amount: '1.25' })).toBe(
      'qbit:qb1zexample?amount=1.25'
    )
    expect(formatQbitUri('qb1zexample', { amount: 0.00000001 })).toBe(
      'qbit:qb1zexample?amount=0.00000001'
    )
    expect(formatQbitUri('qb1zexample', { label: 'Invoice 42' })).toBe(
      'qbit:qb1zexample?label=Invoice+42'
    )
  })

  it('parses qbit URIs and preserves decimal amount text', () => {
    expect(parseQbitUri('qbit:qb1zexample?amount=0.00000001&label=Coffee+%26+bagel')).toEqual({
      address: 'qb1zexample',
      amount: '0.00000001',
      label: 'Coffee & bagel',
    })
  })

  it('round-trips amount and Unicode label fields', () => {
    const uri = formatQbitUri('tq1pexample', {
      amount: '12.50000001',
      label: 'Café 東京',
    })
    expect(parseQbitUri(uri)).toEqual({
      address: 'tq1pexample',
      amount: '12.50000001',
      label: 'Café 東京',
    })
  })

  it('ignores non-payment strings without a URI scheme', () => {
    expect(parseQbitUri('qb1zexample')).toBeNull()
    expect(isQbitUri('qb1zexample')).toBe(false)
  })

  it('rejects other URI schemes', () => {
    expect(() => parseQbitUri('wallet:qb1zexample')).toThrow(QbitUriParseError)
  })

  it('rejects invalid qbit amounts', () => {
    expect(() => parseQbitUri('qbit:qb1zexample?amount=1.123456789')).toThrow(
      QbitUriParseError
    )
    expect(() => formatQbitUri('qb1zexample', { amount: '-1' })).toThrow(
      QbitUriParseError
    )
    expect(() => formatQbitUri('qb1zexample', { amount: 0.000000001 })).toThrow(
      QbitUriParseError
    )
    expect(() => parseQbitUri('qbit:qb1zexample?amount=')).toThrow(QbitUriParseError)
    expect(() => formatQbitUri('qb1zexample', { amount: '' })).toThrow(QbitUriParseError)
  })

  it('rejects authority-style qbit URLs', () => {
    expect(() => parseQbitUri('qbit://qb1zexample')).toThrow(QbitUriParseError)
  })
})
