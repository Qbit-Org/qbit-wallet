import { useEffect, useMemo, useRef, useState } from 'react'

import { numUtils } from '@qbit/base-utils'
import { ADDRESS_TYPES, KeyringType } from '@qbit/keyring-service/types'
import { getAccountCapabilities, getAccountDerivationPath } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import {
  useAppDispatch,
  useAppSelector,
  useChainType,
  useCurrentAccount,
  useCurrentKeyring,
  useI18n,
  useNavigation,
  useReloadAccounts,
  useTools,
  useWallet,
} from '..'
import { walletErrorMessage } from 'src/utils/wallet-error-message'
import { standardHdPath } from './useAddressTypeSettingLogic'

interface AddressTypeItem {
  /** The account's address of this type; none until read, or when it cannot be read. */
  address: string
  assets: { totalAmount: string; satoshis: number }
  name: string
  value: AddressType
}

/** The account's address of each type a read found. */
type AddressesByType = Partial<Record<AddressType, string>>

export function useAddressTypeScreenLogic() {
  //   const isInTab = useExtensionIsInTab()
  const { t } = useI18n()

  const wallet = useWallet()
  const currentKeyring = useCurrentKeyring()
  const account = useCurrentAccount()
  const chainType = useChainType()
  const currentKeyringCapabilities = useMemo(
    () => getAccountCapabilities({ type: currentKeyring.type }),
    [currentKeyring.type]
  )
  // A wallet with one fixed type (the Qbit wallet, a watch or a cold wallet):
  // its address is the account's own, which the background set for the
  // network the wallet is on, once the wallet shown lists that account. A
  // page hears of an account made current in another window before it has
  // the account's wallet, and for that moment holds the wallet before with
  // the new wallet's account: that account's address and balance are not
  // this wallet's. The wallet lists its accounts by key (`keyring_<slot>#<n>`)
  // with each one's address on the network it is on; both must agree, so a
  // list still of another network, or of a wallet that held the slot before,
  // shows nothing either.
  const fixedType = !currentKeyringCapabilities.canChangeAddressType
  const fixedAddress =
    fixedType &&
    account.address &&
    currentKeyring.accounts.some(
      listed => listed.key === account.key && listed.address === account.address
    )
      ? account.address
      : ''

  const nav = useNavigation()
  const dispatch = useAppDispatch()
  const reloadAccounts = useReloadAccounts()
  const [addresses, setAddresses] = useState<AddressesByType>({})
  const [addressAssets, setAddressAssets] = useState<{
    [key: string]: { totalAmount: string; satoshis: number }
  }>({})

  const tools = useTools()
  // The read asked for last: an earlier one that answers late shows nothing.
  const latestReadRef = useRef(0)

  /**
   * The account's addresses, as a list to read balances for and by type.
   *
   * A wallet that can change type: the background lists one address per type
   * it derives, in the order of the types' values from P2PKH (0) on
   * (keyring-service getAllPubkeysByDerivedIndex), so the address at a
   * position is that of the type with that value.
   *
   * A wallet with one fixed type: the account's own address, while the wallet
   * shown lists that account (`fixedAddress`), and none otherwise. Its list from the
   * background does not say which type an entry is: the Qbit wallet's one
   * P2MR address stands first, not at P2MR's value, and for a watch or a cold
   * wallet the entries are derived from a public key such an account may not
   * have. Nothing is read from the background for it.
   */
  const readAddresses = async (): Promise<{ listed: string[]; byType: AddressesByType }> => {
    if (fixedType) {
      if (!fixedAddress) return { listed: [], byType: {} }
      return { listed: [fixedAddress], byType: { [currentKeyring.addressType]: fixedAddress } }
    }
    const listed: string[] = await wallet.getAllAddresses(currentKeyring, account.index || 0)
    const byType: AddressesByType = {}
    listed.forEach((address, position) => {
      byType[position as AddressType] = address
    })
    return { listed, byType }
  }

  const loadAddresses = async () => {
    const read = ++latestReadRef.current
    // Nothing read for the wallet or account before stays beside this one's
    // paths, also when this read fails.
    setAddresses({})
    setAddressAssets({})
    try {
      tools.showLoading(true)
      const { listed: _res, byType } = await readAddresses()
      if (read !== latestReadRef.current) return
      setAddresses(byType)
      if (_res.length === 0) return
      const balances = await wallet.getMultiAddressSummaries(_res.join(','))
      if (read !== latestReadRef.current) return
      // A new object for each read: handed the same one again, the state
      // would not change and a later read's balances would never show.
      const assets: { [key: string]: { totalAmount: string; satoshis: number } } = {}
      for (let i = 0; i < _res.length; i++) {
        const address = _res[i]
        const balance = balances[i]
        const satoshis = balance.totalSatoshis
        assets[address] = {
          totalAmount: numUtils.satoshisToAmount(balance.totalSatoshis),
          satoshis,
        }
      }
      setAddressAssets(assets)
    } catch (e) {
      console.error(e)
    } finally {
      if (read === latestReadRef.current) tools.showLoading(false)
    }
  }

  // A page opened on this screen (by its address, or reloaded) has no wallet
  // in its store yet: the read waits for the wallet, and is made again for
  // another wallet or account, instead of asking once for a wallet with no
  // key, which the background refuses. A wallet with one fixed type reads
  // again when its account's address changes. Every wallet reads again on
  // another network, whose balances are not the ones shown: a watch or a cold
  // wallet keeps one address on every network, so only the network says its
  // balance is another; a Qbit wallet's address changes with the network, and
  // the page may hear of the network before the account's new address.
  useEffect(() => {
    if (!currentKeyring.key) return
    loadAddresses()
  }, [currentKeyring.key, account.index, fixedAddress, chainType])

  const addressTypes = useMemo(() => {
    // Wallets backed by a fixed address do not allow switching address types.
    if (!currentKeyringCapabilities.canChangeAddressType) {
      return ADDRESS_TYPES.filter(v => v.value === currentKeyring.addressType)
    }

    if (currentKeyring.type === KeyringType.HdKeyring) {
      return ADDRESS_TYPES.filter(v => {
        if (v.displayIndex < 0) {
          return false
        }
        if (v.value === AddressType.P2MR) {
          return false
        }
        // MagicEden only supports P2WPKH and P2TR
        if (currentKeyring.accountIndexDerivation) {
          return v.value === AddressType.P2WPKH || v.value === AddressType.P2TR
        }
        const address = addresses[v.value]
        const balance = addressAssets[address]
        if (v.usesBip44Path) {
          if (!balance || balance.satoshis == 0) {
            return false
          }
        }
        return true
      }).sort((a, b) => a.displayIndex - b.displayIndex)
    } else {
      return ADDRESS_TYPES.filter(
        v => v.displayIndex >= 0 && v.usesBip44Path != true && v.value !== AddressType.P2MR
      ).sort((a, b) => a.displayIndex - b.displayIndex)
    }
  }, [
    currentKeyring.type,
    currentKeyring.addressType,
    currentKeyringCapabilities.canChangeAddressType,
    currentKeyring.accountIndexDerivation,
    addressAssets,
    addresses,
  ])

  const items: AddressTypeItem[] = useMemo(() => {
    return addressTypes.map(v => {
      const address = addresses[v.value]
      const assets = addressAssets[address] || {
        totalAmount: '--',
        satoshis: 0,
      }
      // The path the wallet derives this type on, on the network it is on.
      const derivedPath = getAccountDerivationPath(
        standardHdPath(v, chainType),
        account.index || 0,
        currentKeyring.accountIndexDerivation
      )
      let name = `${v.name} (${derivedPath})`
      if (currentKeyring.type === KeyringType.SimpleKeyring) {
        name = `${v.name}`
      } else if (currentKeyring.type === KeyringType.ColdWalletKeyring) {
        name = `❄️ ${v.name} (${derivedPath}) - ${t('Fixed by cold wallet')}`
      }

      return {
        address,
        assets,
        name,
        value: v.value,
      }
    })
  }, [
    addressTypes,
    addresses,
    addressAssets,
    account.index,
    chainType,
    currentKeyring.type,
    currentKeyring.accountIndexDerivation,
  ])

  const onClickItem = async (item: AddressTypeItem) => {
    if (item.value == currentKeyring.addressType) {
      return
    }

    if (!currentKeyringCapabilities.canChangeAddressType) {
      tools.toastError(t('not_supported'))
      return
    }

    try {
      await wallet.changeAddressType(item.value)
    } catch (e) {
      // The background refused the change: it is shown as refused, with the
      // background's message; the accounts are not read again, nothing says
      // the type changed and the screen stays open. A refusal reaches the
      // page as a plain `{ message }` object.
      tools.toastError(walletErrorMessage(e, t('unknown_error')))
      return
    }
    reloadAccounts()
    // navigate('MainScreen')
    tools.toastSuccess(t('address_type_changed'))

    nav.navToTab()
  }

  // The cards show the account's balances, so they hide them as the home
  // screen's card does.
  const balanceHidden = useAppSelector(state => state.ui.isBalanceHidden)

  return {
    currentKeyring,
    items,
    balanceHidden,
    wallet,
    onClickItem,
  }
}
