import { describe, expect, it } from 'vitest'

import { KeyringType, WALLET_COLOR_KEYS, type WalletKeyring } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'

import keyringsReducer, { initialState, keyringsActions } from '../../src/reducers/keyrings'

function walletKeyring(index: number, color: WalletKeyring['color']): WalletKeyring {
  return {
    key: `keyring_${index}`,
    index,
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2MR,
    accounts: [],
    alianName: `Wallet ${index + 1}`,
    color,
    hdPath: "m/87'/0'/0'/0",
  }
}

describe('keyrings reducer', () => {
  it('starts with a palette key on the placeholder wallet', () => {
    expect(WALLET_COLOR_KEYS).toContain(initialState.current.color)
    expect(keyringsReducer(undefined, { type: 'unknown' })).toEqual(initialState)
  })

  it('updates the color of the wallet setKeyringColor returned, wherever it is listed', () => {
    const first = walletKeyring(0, 'green')
    const second = walletKeyring(1, 'blue')
    let state = keyringsReducer(initialState, keyringsActions['setKeyrings']!([first, second]))
    state = keyringsReducer(state, keyringsActions['setCurrent']!(second))

    state = keyringsReducer(state, keyringsActions['updateKeyringColor']!({ ...second, color: 'pink' }))

    expect(state.current.color).toBe('pink')
    expect(state.keyrings.map(keyring => keyring.color)).toEqual(['green', 'pink'])

    state = keyringsReducer(state, keyringsActions['updateKeyringColor']!({ ...first, color: 'gold' }))

    expect(state.current.color).toBe('pink')
    expect(state.keyrings.map(keyring => keyring.color)).toEqual(['gold', 'pink'])
    expect(state.keyrings.map(keyring => keyring.alianName)).toEqual(['Wallet 1', 'Wallet 2'])
  })
})
