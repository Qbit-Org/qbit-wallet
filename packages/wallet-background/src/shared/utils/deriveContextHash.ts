import { ErrorCodes, WalletError } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

export const chainTypeToCanonicalNetwork = (chainType: ChainType): string => {
  switch (chainType) {
    case ChainType.QBIT_MAINNET:
      return 'qbit-mainnet'
    case ChainType.QBIT_TESTNET4:
      return 'qbit-testnet4'
    case ChainType.QBIT_REGTEST:
      return 'qbit-regtest'
    default:
      throw new WalletError(
        ErrorCodes.UNSUPPORTED_NETWORK,
        `wallet chain "${chainType}" is not supported by deriveContextHash`,
      )
  }
}
