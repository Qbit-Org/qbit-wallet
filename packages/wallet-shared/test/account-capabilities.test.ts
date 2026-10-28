import { describe, expect, it } from 'vitest'

import { KeyringType, canCreateQbitSendRequest, getAccountCapabilities } from '../src'

describe('account message signing capabilities', () => {
  it('exposes only the dedicated P2MR message path for generated Qbit HD accounts', () => {
    expect(getAccountCapabilities({ type: KeyringType.QbitHdKeyring })).toMatchObject({
      canCreateSigningRequest: false,
      canSignP2mrMessage: true,
    })
  })

  it('keeps cold-wallet accounts excluded from qbit signing paths', () => {
    expect(getAccountCapabilities({ type: KeyringType.ColdWalletKeyring })).toMatchObject({
      canChangeAddressType: false,
      canSignP2mrMessage: false,
    })
    // No p2mr payload means no qbit send requests from cold-wallet accounts.
    expect(canCreateQbitSendRequest({ type: KeyringType.ColdWalletKeyring })).toBe(false)
  })

  it('keeps existing and watch-only account capabilities unchanged', () => {
    expect(getAccountCapabilities({ type: KeyringType.HdKeyring })).toMatchObject({
      canCreateSigningRequest: true,
      canSignP2mrMessage: false,
    })
    expect(getAccountCapabilities({ type: KeyringType.WatchAddressKeyring })).toMatchObject({
      canCreateSigningRequest: false,
      canSignP2mrMessage: false,
    })
  })
})
