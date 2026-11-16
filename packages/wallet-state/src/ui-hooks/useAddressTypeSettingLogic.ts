import { KeyringType } from '@qbit/keyring-service/types'
import {
  ADDRESS_TYPES,
  AccountSignMethod,
  getAccountCapabilities,
  getAccountDerivationPath,
} from '@qbit/wallet-shared'
import { useMemo } from 'react'
import { useI18n, useNavigation, useTools } from 'src/context'
import { useCurrentAccount, useCurrentKeyring } from 'src/hooks'

/** The Address Type entry of Advanced Settings. */
export interface AddressTypeSetting {
  label: string
  /**
   * The current address type by name. A wallet that derives its accounts and
   * can change type also shows the HD path with the account index.
   */
  value: string
  /**
   * Opens the Address Type screen. A wallet on a custom HD path cannot switch
   * types, so it gets a tip instead.
   */
  onClick: () => void
}

/**
 * The path of the account, as the Address Type screen shows it: a wallet that
 * numbers its accounts in the account segment is not shown the address-index
 * form. A stored path too short for that falls back to the plain form, so the
 * entry never fails to draw.
 */
function accountPath(hdPath: string, index: number, accountIndexDerivation?: boolean): string {
  try {
    return getAccountDerivationPath(hdPath, index, accountIndexDerivation)
  } catch {
    return `${hdPath}/${index}`
  }
}

/**
 * The Address Type entry, shown in Advanced Settings: what it says about the
 * current wallet's address type, and what a tap on it does.
 */
export function useAddressTypeSettingLogic(): AddressTypeSetting {
  const nav = useNavigation()
  const currentKeyring = useCurrentKeyring()
  const currentAccount = useCurrentAccount()
  const tools = useTools()
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

  return useMemo(() => {
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
      const path = accountPath(hdPath, currentAccount.index, currentKeyring.accountIndexDerivation)
      value = `${item.name} (${path})`
    }
    return {
      label: t('address_type'),
      value,
      onClick: (): void => {
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
  }, [
    t,
    nav,
    tools,
    isCustomHdPath,
    currentKeyring,
    currentAccount.index,
    currentKeyringCapabilities,
  ])
}
