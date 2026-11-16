import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'

import { accountActions } from '../../src/reducers/accounts'
import { keyringsActions } from '../../src/reducers/keyrings'
import { useAddressTypeSettingLogic } from '../../src/ui-hooks/useAddressTypeSettingLogic'
import { createHookTestHarness } from './testHelpers'

const CUSTOM_PATH_TIP =
  'the_wallet_currently_uses_a_custom_hd_path_and_does_not_support_switching_address_types'

interface WalletCase {
  type: string
  addressType: AddressType
  hdPath?: string
  accountIndex?: number
  accountIndexDerivation?: boolean
}

/** The hook for the current wallet `wallet` describes, with its account selected. */
function renderFor(wallet: WalletCase) {
  const harness = createHookTestHarness()
  const account = {
    type: wallet.type,
    address: 'qb1ztestaccount',
    brandName: 'Qbit',
    alianName: 'Account',
    displayBrandName: 'Qbit',
    index: wallet.accountIndex ?? 0,
    balance: 0,
    pubkey: '02abc123',
    key: 'account-1',
    flag: 0,
  }
  harness.store.dispatch(accountActions.setCurrent(account))
  harness.store.dispatch(
    keyringsActions.setCurrent({
      key: 'keyring-1',
      index: 0,
      type: wallet.type,
      addressType: wallet.addressType,
      accounts: [account],
      alianName: 'Wallet 1',
      color: 'green',
      hdPath: wallet.hdPath ?? '',
      ...(wallet.accountIndexDerivation ? { accountIndexDerivation: true } : {}),
    })
  )
  const view = renderHook(() => useAddressTypeSettingLogic(), { wrapper: harness.wrapper })
  return { harness, account, ...view }
}

describe('useAddressTypeSettingLogic', () => {
  it('is labelled Address Type', () => {
    const { result } = renderFor({ type: KeyringType.HdKeyring, addressType: AddressType.P2TR })

    expect(result.current.label).toBe('address_type')
    expect(Object.keys(result.current).sort()).toEqual(['label', 'onClick', 'value'])
  })

  describe('the value', () => {
    it('is the type, the HD path and the account index for an HD wallet', () => {
      const { result } = renderFor({
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2TR,
        accountIndex: 3,
      })

      expect(result.current.value).toBe("Taproot (P2TR) (m/86'/0'/0'/0/3)")
    })

    it('numbers the account in the account segment for a wallet that derives its accounts that way, as the Address Type screen does', () => {
      const { result } = renderFor({
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2TR,
        accountIndex: 3,
        accountIndexDerivation: true,
      })

      expect(result.current.value).toBe("Taproot (P2TR) (m/86'/0'/3'/0/0)")
    })

    it('falls back to the plain form when such a wallet stores a path too short to number that way', () => {
      const { result } = renderFor({
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2TR,
        hdPath: "m/86'",
        accountIndex: 3,
        accountIndexDerivation: true,
      })

      expect(result.current.value).toBe("Taproot (P2TR) (m/86'/3)")
    })

    it("shows the wallet's own HD path when it stores one", () => {
      const { result } = renderFor({
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2WPKH,
        hdPath: "m/84'/1'/0'/0",
        accountIndex: 1,
      })

      expect(result.current.value).toBe("Native Segwit (P2WPKH) (m/84'/1'/0'/0/1)")
    })

    it('follows the account selected', () => {
      const { result, harness, account } = renderFor({
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2TR,
      })
      expect(result.current.value).toBe("Taproot (P2TR) (m/86'/0'/0'/0/0)")

      act(() => {
        harness.store.dispatch(accountActions.setCurrent({ ...account, index: 7 }))
      })

      expect(result.current.value).toBe("Taproot (P2TR) (m/86'/0'/0'/0/7)")
    })

    it('is the type alone for a private-key wallet, which derives nothing', () => {
      const { result } = renderFor({
        type: KeyringType.SimpleKeyring,
        addressType: AddressType.P2WPKH,
        accountIndex: 2,
      })

      expect(result.current.value).toBe('Native Segwit (P2WPKH)')
    })

    it.each([
      // The Qbit wallet: its accounts have the one post-quantum type.
      [KeyringType.QbitHdKeyring, AddressType.P2MR, 'Post-Quantum P2MR'],
      // The read-only wallet of developer mode, which signs elsewhere.
      [KeyringType.ReadonlyKeyring, AddressType.P2WPKH, 'Native Segwit (P2WPKH)'],
      [KeyringType.ReadonlyKeyring, AddressType.P2TR, 'Taproot (P2TR)'],
      [KeyringType.ColdWalletKeyring, AddressType.P2TR, 'Taproot (P2TR)'],
      [KeyringType.WatchAddressKeyring, AddressType.P2WPKH, 'Native Segwit (P2WPKH)'],
    ])(
      'is the type alone for a %s wallet of type %s, which shows no path',
      (type, addressType, value) => {
        const { result } = renderFor({ type, addressType, accountIndex: 4 })

        expect(result.current.value).toBe(value)
      }
    )
  })

  describe('a tap', () => {
    it.each([
      [
        'an HD wallet on its standard path',
        { type: KeyringType.HdKeyring, addressType: AddressType.P2TR },
      ],
      [
        'an HD wallet that stores its standard path',
        { type: KeyringType.HdKeyring, addressType: AddressType.P2TR, hdPath: "m/86'/0'/0'/0" },
      ],
      [
        'a private-key wallet',
        { type: KeyringType.SimpleKeyring, addressType: AddressType.P2WPKH },
      ],
      [
        'the Qbit wallet on Mainnet',
        { type: KeyringType.QbitHdKeyring, addressType: AddressType.P2MR, hdPath: "m/87'/0'/0'/0" },
      ],
      [
        'the read-only wallet of developer mode',
        { type: KeyringType.ReadonlyKeyring, addressType: AddressType.P2WPKH },
      ],
    ])('opens the Address Type screen for %s', (_case, wallet) => {
      const { result, harness } = renderFor(wallet)

      result.current.onClick()

      expect(harness.navigation.navigate).toHaveBeenCalledWith('AddressTypeScreen')
      expect(harness.navigation.navigate).toHaveBeenCalledTimes(1)
      expect(harness.tools.showTip).not.toHaveBeenCalled()
    })

    // On a test network the Qbit wallet's path has that network's coin type,
    // which is not the path its type names.
    it('shows the tip, and opens nothing, for the Qbit wallet on a test network', () => {
      const { result, harness } = renderFor({
        type: KeyringType.QbitHdKeyring,
        addressType: AddressType.P2MR,
        hdPath: "m/87'/1'/0'/0",
      })
      expect(result.current.value).toBe('Post-Quantum P2MR')

      result.current.onClick()

      expect(harness.tools.showTip).toHaveBeenCalledWith(CUSTOM_PATH_TIP)
      expect(harness.navigation.navigate).not.toHaveBeenCalled()
    })

    it('shows a tip, and opens nothing, for a wallet on a custom HD path', () => {
      const { result, harness } = renderFor({
        type: KeyringType.HdKeyring,
        addressType: AddressType.P2TR,
        hdPath: "m/44'/1'/0'/0",
        accountIndex: 2,
      })
      // The path it does use is the one shown.
      expect(result.current.value).toBe("Taproot (P2TR) (m/44'/1'/0'/0/2)")

      result.current.onClick()

      expect(harness.tools.showTip).toHaveBeenCalledWith(CUSTOM_PATH_TIP)
      expect(harness.tools.showTip).toHaveBeenCalledTimes(1)
      expect(harness.navigation.navigate).not.toHaveBeenCalled()
    })
  })
})
