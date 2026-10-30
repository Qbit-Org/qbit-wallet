import type { Account } from '../types/account'
import { AccountSignMethod, getAccountCapabilities } from './accountCapabilities'

/** The scripts and addresses of the accounts the user controls. */
export interface QbitWalletOwnership {
  /** Lowercase scriptPubKey hex; a P2MR script is the same on every network. */
  scriptPubKeys: ReadonlySet<string>
  /** Lowercase addresses on every network, for accounts without P2MR metadata too. */
  addresses: ReadonlySet<string>
}

/**
 * Every script and address of the accounts that can sign, by this wallet or
 * an external or cold signer. A watch-only account is someone else's
 * address the user follows, so paying it is not paying the wallet.
 */
export function qbitWalletOwnership(accounts: readonly Account[]): QbitWalletOwnership {
  const scriptPubKeys = new Set<string>()
  const addresses = new Set<string>()
  for (const account of accounts) {
    if (getAccountCapabilities(account).signMethod === AccountSignMethod.None) continue
    if (account.address) addresses.add(account.address.toLowerCase())
    if (!account.p2mr) continue
    scriptPubKeys.add(account.p2mr.scriptPubKey.toLowerCase())
    for (const address of Object.values(account.p2mr.addresses ?? {})) {
      if (address) addresses.add(address.toLowerCase())
    }
  }
  return { scriptPubKeys, addresses }
}

/** Whether an output script or address pays one of the wallet's accounts. */
export function qbitWalletOwns(
  ownership: QbitWalletOwnership,
  {
    scriptPubKeyHex,
    address,
  }: { scriptPubKeyHex?: string | undefined; address?: string | undefined }
): boolean {
  return (
    (scriptPubKeyHex !== undefined && ownership.scriptPubKeys.has(scriptPubKeyHex.toLowerCase())) ||
    (!!address && ownership.addresses.has(address.toLowerCase()))
  )
}
