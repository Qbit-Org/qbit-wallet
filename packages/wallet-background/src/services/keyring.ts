import { KeyringService } from '@qbit/keyring-service'
import { ChainType } from '@qbit/wallet-types'

import preferenceService from './preference'

export const keyringService = new KeyringService()

// Display snapshots must project the active network's recovery lifecycle:
// a collapsed cross-network status cannot represent a partially migrated
// coin type and would let the home card disagree with the network-scoped
// authoritative state. The preference store owns the active chain, so it
// is resolved lazily on every read; before preferences load, the service
// falls back to the collapsed projection.
keyringService.setActiveQbitNetworkResolver(() => {
  const chainType = preferenceService.getChainType()
  if (chainType === ChainType.QBIT_MAINNET) return 'mainnet'
  if (chainType === ChainType.QBIT_REGTEST) return 'regtest'
  if (chainType === ChainType.QBIT_TESTNET4) return 'testnet4'
  return undefined
})

export default keyringService
