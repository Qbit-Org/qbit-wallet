import { useMemo, useState } from 'react'
import { useI18n, useNavigation, useTools, useWallet } from 'src/context'
import { useChain, useVersionInfo } from 'src/hooks'

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

/**
 * The rows of the Settings tab. Address Type is not one of them: it is an
 * entry of Advanced Settings (`useAddressTypeSettingLogic`).
 */
export function useSettingsTabScreenLogic() {
  const nav = useNavigation()
  const chain = useChain()
  const wallet = useWallet()
  const tools = useTools()
  const [connected, setConnected] = useState(false)
  const versionInfo = useVersionInfo()
  const hasUpdate =
    versionInfo.latestVersion && versionInfo.latestVersion !== versionInfo.currentVesion
  const { t } = useI18n()

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

  const settings_security: SettingsItemType = useMemo(() => {
    return {
      key: 'settings_security',
      label: t('security'),
      value: '',
      desc: '',
      right: true,
      icon: 'security',
      onClick: (): void => {
        nav.navigate('SecurityScreen')
      },
    }
  }, [t, nav])

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
    settings_security,
    settings_appearance,
    settings_advanced,
    settings_aboutus,
    settings_lockwallet,
  }
}
