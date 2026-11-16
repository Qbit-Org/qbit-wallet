import { useEffect, useMemo, useRef, useState } from 'react'

import { numUtils } from '@qbit/base-utils'
import { ADDRESS_TYPES, KeyringType } from '@qbit/keyring-service/types'
import { getAccountCapabilities, getAccountDerivationPath } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import {
  useAppDispatch,
  useCurrentAccount,
  useCurrentKeyring,
  useI18n,
  useNavigation,
  useReloadAccounts,
  useTools,
  useWallet,
} from '..'

interface AddressTypeItem {
  address: string
  assets: { totalAmount: string; satoshis: number }
  name: string
  value: AddressType
}

export function useAddressTypeScreenLogic() {
  //   const isInTab = useExtensionIsInTab()
  const { t } = useI18n()

  const wallet = useWallet()
  const currentKeyring = useCurrentKeyring()
  const account = useCurrentAccount()
  const currentKeyringCapabilities = useMemo(
    () => getAccountCapabilities({ type: currentKeyring.type }),
    [currentKeyring.type]
  )

  const nav = useNavigation()
  const dispatch = useAppDispatch()
  const reloadAccounts = useReloadAccounts()
  const [addresses, setAddresses] = useState<string[]>([])
  const [addressAssets, setAddressAssets] = useState<{
    [key: string]: { totalAmount: string; satoshis: number }
  }>({})

  const tools = useTools()
  // The read asked for last: an earlier one that answers late shows nothing.
  const latestReadRef = useRef(0)
  const loadAddresses = async () => {
    const read = ++latestReadRef.current
    // Nothing read for the wallet or account before stays beside this one's
    // paths, also when this read fails.
    setAddresses([])
    setAddressAssets({})
    try {
      tools.showLoading(true)
      const _res = await wallet.getAllAddresses(currentKeyring, account.index || 0)
      if (read !== latestReadRef.current) return
      setAddresses(_res)
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
  // key, which the background refuses.
  useEffect(() => {
    if (!currentKeyring.key) return
    loadAddresses()
  }, [currentKeyring.key, account.index])

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
      const derivedPath = getAccountDerivationPath(
        v.hdPath,
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

    await wallet.changeAddressType(item.value)
    reloadAccounts()
    // navigate('MainScreen')
    tools.toastSuccess(t('address_type_changed'))

    nav.navToTab()
  }

  return {
    currentKeyring,
    items,
    wallet,
    onClickItem,
  }
}
