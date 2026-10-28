import { KeyringType } from '@qbit/keyring-service/types'
import {
  ADDRESS_TYPES,
  AccountSignMethod,
  getAccountCapabilities,
} from '@qbit/wallet-shared'
import { useMemo, useState } from 'react'
import { useI18n, useNavigation, useTools, useWallet } from 'src/context'
import { useChain, useCurrentAccount, useCurrentKeyring, useVersionInfo } from 'src/hooks'

export interface SettingsItemType {
  key: string
  label?: string
  value?: string
  desc?: string
  danger?: boolean
  right: boolean
  icon?: string
  badge?: string
  onClick?: () => void
}

export function useSettingsTabScreenLogic() {
  const nav = useNavigation()
  const currentKeyring = useCurrentKeyring()
  const currentAccount = useCurrentAccount()
  const chain = useChain()
  const wallet = useWallet()
  const tools = useTools()
  const [connected, setConnected] = useState(false)
  const versionInfo = useVersionInfo()
  const hasUpdate =
    versionInfo.latestVersion && versionInfo.latestVersion !== versionInfo.currentVesion
  const { t } = useI18n()

  const isCustomHdPath = useMemo(() => {
    const item = ADDRESS_TYPES.find(v => v.value === currentKeyring.addressType)
    if (!item) return false
    return currentKeyring.hdPath !== '' && item.hdPath !== currentKeyring.hdPath
  }, [currentKeyring])

  const currentKeyringCapabilities = useMemo(
    () => getAccountCapabilities({ type: currentKeyring.type }),
    [currentKeyring.type]
  )

  const settings_connectedSites: SettingsItemType = useMemo(() => {
    const value = connected ? t('connected') : t('not_connected')
    return {
      key: 'settings_connectedSites',
      label: t('connected_sites'),
      value,
      desc: '',
      right: true,
      icon: 'connectedSites',
      onClick: () => {
        nav.navigate('ConnectedSitesScreen')
      },
    }
  }, [t, connected])

  const settings_switchNetwork: SettingsItemType = useMemo(() => {
    return {
      key: 'settings_switchNetwork',
      label: t('switch_network'),
      value: '',
      desc: '',
      right: true,
      icon: 'network',
      onClick: () => {
        nav.navigate('NetworkTypeScreen')
      },
    }
  }, [t])

  const settings_addressBook: SettingsItemType = useMemo(() => {
    return {
      key: 'settings_addressBook',
      label: t('address_book'),
      value: t('addressbook_desc'),
      desc: '',
      right: true,
      icon: 'addressBook',
      onClick: () => {
        // todo
        nav.navigate('ContactsScreen', {})
      },
    }
  }, [t])
  const settings_addressType: SettingsItemType = useMemo(() => {
    let value = ''
    const item =
      ADDRESS_TYPES.find(v => v.value === currentKeyring.addressType) || ADDRESS_TYPES[0]!
    const hdPath = currentKeyring.hdPath || item.hdPath
    if (
      currentKeyring.type === KeyringType.SimpleKeyring ||
      currentKeyringCapabilities.signMethod === AccountSignMethod.External ||
      !currentKeyringCapabilities.canChangeAddressType
    ) {
      value = `${item.name}`
    } else {
      value = `${item.name} (${hdPath}/${currentAccount.index})`
    }
    return {
      key: 'settings_addressType',
      label: t('address_type'),
      value,
      desc: '',
      right: true,
      icon: 'addressType',
      onClick: () => {
        if (isCustomHdPath) {
          tools.showTip(
            t(
              'the_wallet_currently_uses_a_custom_hd_path_and_does_not_support_switching_address_types'
            )
          )
          return
        }
        nav.navigate('AddressTypeScreen')
      },
    }
  }, [t, isCustomHdPath, currentKeyring, currentAccount.index, currentKeyringCapabilities])

  const settings_appearance: SettingsItemType = useMemo(() => {
    return {
      key: 'settings_appearance',
      label: t('appearance'),
      value: '',
      desc: '',
      right: true,
      icon: 'appearance',
      onClick: () => {
        nav.navigate('AppearanceScreen')
      },
    }
  }, [t])

  const settings_advanced = useMemo(() => {
    return {
      key: 'settings_advanced',
      label: t('advanced_settings'),
      value: '',
      desc: '',
      right: true,
      icon: 'advance',
      onClick: () => {
        nav.navigate('AdvancedScreen')
      },
    }
  }, [t])

  const settings_aboutus = useMemo(() => {
    return {
      key: 'settings_aboutus',
      label: t('about_qbit_wallet'),
      value: '',
      desc: '',
      right: true,
      icon: 'aboutUsLogo',
      badge: hasUpdate ? t('new_version') : undefined,
      onClick: () => {
        nav.navigate('AboutUsScreen')
      },
    }
  }, [t, hasUpdate])

  const settings_lockwallet = useMemo(() => {
    return {
      key: 'settings_lockwallet',
      label: t('lock_wallet'),
      value: '',
      desc: '',
      right: false,
      icon: 'lock',
      onClick: () => {
        // Navigate only after the lock round-trip succeeds; if the wallet is
        // still unlocked, the unlock screen would just bounce straight back
        // to main, so a failed lock surfaces a toast instead.
        wallet
          .lockWallet()
          .then(() => {
            nav.navToLock({
              autoUnlockByFace: false,
            })
          })
          .catch((error: unknown) => {
            console.error('Lock wallet error:', error)
            tools.toastError(t('failed_to_lock_wallet'))
          })
      },
    }
  }, [t])

  return {
    settings_connectedSites,
    settings_switchNetwork,
    settings_addressBook,
    settings_addressType,
    settings_appearance,
    settings_advanced,
    settings_aboutus,
    settings_lockwallet,
  }
}
