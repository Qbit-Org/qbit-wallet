import { describe, expect, it } from 'vitest'

import {
  WALLET_COLOR_KEYS,
  defaultWalletName,
  isWalletColorKey,
  resolveWalletColor,
  walletColorForSlot,
} from '../src'

describe('wallet color palette', () => {
  it('holds about eight distinct keys', () => {
    expect(WALLET_COLOR_KEYS).toHaveLength(8)
    expect(new Set(WALLET_COLOR_KEYS).size).toBe(WALLET_COLOR_KEYS.length)
    for (const key of WALLET_COLOR_KEYS) {
      expect(key).toMatch(/^[a-z]+$/)
    }
  })

  it('gives each slot the palette key at its index, wrapping around', () => {
    WALLET_COLOR_KEYS.forEach((key, index) => {
      expect(walletColorForSlot(index)).toBe(key)
    })
    expect(walletColorForSlot(WALLET_COLOR_KEYS.length)).toBe(WALLET_COLOR_KEYS[0])
    expect(walletColorForSlot(WALLET_COLOR_KEYS.length + 3)).toBe(WALLET_COLOR_KEYS[3])
    expect(walletColorForSlot(10 * WALLET_COLOR_KEYS.length + 7)).toBe(WALLET_COLOR_KEYS[7])
  })

  it('gives the first key to a value that is not a slot index', () => {
    for (const value of [-1, -9, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(walletColorForSlot(value)).toBe(WALLET_COLOR_KEYS[0])
    }
    expect(walletColorForSlot(null as unknown as number)).toBe(WALLET_COLOR_KEYS[0])
    expect(walletColorForSlot('3' as unknown as number)).toBe(WALLET_COLOR_KEYS[0])
  })

  it('accepts only palette keys', () => {
    for (const key of WALLET_COLOR_KEYS) {
      expect(isWalletColorKey(key)).toBe(true)
    }
    for (const value of [
      null,
      undefined,
      '',
      'Blue',
      ' blue',
      '#1ab453',
      'toString',
      '__proto__',
      0,
      1,
      {},
      ['blue'],
      new String('blue'),
    ]) {
      expect(isWalletColorKey(value), String(value)).toBe(false)
    }
  })

  it('resolves a stored key, and falls back to the slot for anything else', () => {
    expect(resolveWalletColor('pink', 0)).toBe('pink')
    expect(resolveWalletColor('indigo', 9)).toBe('indigo')
    expect(resolveWalletColor(undefined, 2)).toBe(walletColorForSlot(2))
    expect(resolveWalletColor(null, 3)).toBe(walletColorForSlot(3))
    expect(resolveWalletColor('crimson', 4)).toBe(walletColorForSlot(4))
    expect(resolveWalletColor('#ff0000', 9)).toBe(walletColorForSlot(9))
    expect(resolveWalletColor(5, 1)).toBe(walletColorForSlot(1))
    expect(resolveWalletColor(undefined, -1)).toBe(WALLET_COLOR_KEYS[0])
  })
})

describe('defaultWalletName', () => {
  it('names a wallet after its position', () => {
    expect(defaultWalletName(1, [])).toBe('Wallet 1')
    expect(defaultWalletName(4, ['Qbit HD Wallet #1', 'Readonly #2', 'Savings'])).toBe('Wallet 4')
  })

  it('goes up past numbers another wallet is named with', () => {
    expect(defaultWalletName(2, ['Wallet 2'])).toBe('Wallet 3')
    expect(defaultWalletName(2, ['Wallet 3', 'Wallet 2', 'Wallet 5'])).toBe('Wallet 4')
    expect(defaultWalletName(1, ['Wallet 1', 'Wallet 2', 'Wallet 3'])).toBe('Wallet 4')
  })

  it('ignores lower numbers in use, and numbers that are only part of a name', () => {
    expect(defaultWalletName(3, ['Wallet 1', 'Wallet 2'])).toBe('Wallet 3')
    for (const name of ['Wallet #3', 'HD Wallet 3', 'Wallet 3a', 'Wallet 03', 'Wallet3']) {
      expect(defaultWalletName(3, [name]), name).toBe('Wallet 3')
    }
  })

  it('matches names ignoring case and surrounding or repeated spaces', () => {
    for (const name of ['wallet 2', 'WALLET 2', '  Wallet 2 ', 'Wallet\t 2', '\nwallet   2']) {
      expect(defaultWalletName(2, [name]), JSON.stringify(name)).toBe('Wallet 3')
    }
  })

  it('skips names that are not strings', () => {
    expect(defaultWalletName(1, [null, undefined, 1, {}])).toBe('Wallet 1')
  })

  it('starts at 1 for a position that is not a count', () => {
    for (const position of [0, -2, 1.5, Number.NaN]) {
      expect(defaultWalletName(position, []), String(position)).toBe('Wallet 1')
    }
    expect(defaultWalletName(0, ['Wallet 1'])).toBe('Wallet 2')
  })
})
