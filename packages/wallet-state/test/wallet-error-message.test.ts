import { describe, expect, it } from 'vitest'

import { walletErrorMessage } from '../src/utils/wallet-error-message'

describe('walletErrorMessage', () => {
  it.each([
    [
      'a rejection as it crosses the UI port',
      { code: -32603, message: 'Password is incorrect' },
      'Password is incorrect',
    ],
    ['an Error', new Error('Signing failed'), 'Signing failed'],
    ['a string rejection', 'Request rejected', 'Request rejected'],
  ])('shows the message of %s', (_name, error, shown) => {
    expect(walletErrorMessage(error, 'unknown_error')).toBe(shown)
  })

  it.each([
    ['an object without a message', { code: -32603, data: { reasons: [] } }],
    ['an empty message', { message: '' }],
    ['a message that is not a string', { message: { code: 4 } }],
    ['an Error without a message', new Error('')],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('falls back for %s, never "[object Object]"', (_name, error) => {
    expect(walletErrorMessage(error, 'unknown_error')).toBe('unknown_error')
  })
})
