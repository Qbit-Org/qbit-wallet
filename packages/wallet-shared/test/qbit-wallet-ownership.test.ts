import { describe, expect, it } from 'vitest'

import { KeyringType } from '../src/constants'
import type { Account } from '../src/types/account'
import { qbitWalletOwnership, qbitWalletOwns } from '../src/utils/qbit-wallet-ownership'

function account(type: string, byte: string): Account {
  return {
    type,
    pubkey: byte.repeat(32),
    address: `qbrt1z${byte}`,
    key: byte,
    flag: 0,
    p2mr: {
      scriptPubKey: `5120${byte.repeat(32)}`,
      addresses: { mainnet: `qb1z${byte}`, regtest: `qbrt1z${byte}` },
    },
  } as unknown as Account
}

describe('qbit wallet ownership', () => {
  it('counts every account that can sign, by script and by address on any network', () => {
    const ownership = qbitWalletOwnership([
      account(KeyringType.QbitHdKeyring, 'aa'),
      account(KeyringType.ReadonlyKeyring, 'bb'),
      account(KeyringType.ColdWalletKeyring, 'cc'),
    ])
    expect(qbitWalletOwns(ownership, { scriptPubKeyHex: `5120${'AA'.repeat(32)}` })).toBe(true)
    expect(qbitWalletOwns(ownership, { address: 'QB1ZBB' })).toBe(true)
    expect(qbitWalletOwns(ownership, { address: 'qbrt1zcc' })).toBe(true)
    expect(
      qbitWalletOwns(ownership, { scriptPubKeyHex: `5120${'dd'.repeat(32)}`, address: '' })
    ).toBe(false)
  })

  it('does not count a watch-only address as the wallet’s', () => {
    const ownership = qbitWalletOwnership([
      account(KeyringType.QbitHdKeyring, 'aa'),
      account(KeyringType.WatchAddressKeyring, 'ee'),
    ])
    expect(qbitWalletOwns(ownership, { scriptPubKeyHex: `5120${'ee'.repeat(32)}` })).toBe(false)
    expect(qbitWalletOwns(ownership, { address: 'qbrt1zee' })).toBe(false)
  })
})
