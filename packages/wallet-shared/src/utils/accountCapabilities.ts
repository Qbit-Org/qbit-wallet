import { KeyringType } from '../constants'
import { Account } from '../types'

export enum AccountSignMethod {
  Local = 'local',
  ColdWallet = 'coldWallet',
  External = 'external',
  None = 'none',
}

export type AccountCapabilities = {
  canCreateSigningRequest: boolean
  canSignP2mrMessage: boolean
  signMethod: AccountSignMethod
  canChangeAddressType: boolean
}

/**
 * Whether the account can initiate the qbit P2MR send flow. QbitHd accounts
 * are excluded from generic signing requests, while P2MR sends and messages
 * use dedicated counter-safe paths.
 */
export function canCreateQbitSendRequest(
  account: (Pick<Account, 'type'> & { p2mr?: unknown }) | { type?: string; p2mr?: unknown } | null | undefined
): boolean {
  if (!account?.p2mr) return false
  if (getAccountCapabilities(account).canCreateSigningRequest) return true
  return account.type === KeyringType.QbitHdKeyring
}

export function getAccountCapabilities(
  account: Pick<Account, 'type'> | { type?: string } | null | undefined
): AccountCapabilities {
  const type = account?.type
  const hasAccountType = Boolean(type)
  const isWatchOnly = type === KeyringType.WatchAddressKeyring
  const isReadonly = type === KeyringType.ReadonlyKeyring
  const isQbitHd = type === KeyringType.QbitHdKeyring
  let signMethod = AccountSignMethod.None

  if (type === KeyringType.ColdWalletKeyring) {
    signMethod = AccountSignMethod.ColdWallet
  } else if (isReadonly) {
    signMethod = AccountSignMethod.External
  } else if (hasAccountType && !isWatchOnly) {
    signMethod = AccountSignMethod.Local
  }

  return {
    canCreateSigningRequest: hasAccountType && !isWatchOnly && !isQbitHd,
    canSignP2mrMessage: isQbitHd && signMethod === AccountSignMethod.Local,
    signMethod,
    canChangeAddressType:
      hasAccountType && !isWatchOnly && !isQbitHd && signMethod !== AccountSignMethod.ColdWallet,
  }
}
