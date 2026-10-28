import { NetworkType } from '@qbit/wallet-types'
import { transactionCore } from '../transaction-core'

/** Convert a wallet network type to the transaction library network. */
export function toPsbtNetwork(networkType: NetworkType) {
  if (networkType === NetworkType.MAINNET) {
    return transactionCore.networks.bitcoin
  } else if (networkType === NetworkType.TESTNET) {
    return transactionCore.networks.testnet
  } else {
    return transactionCore.networks.regtest
  }
}

/** Convert a transaction library network to the wallet network type. */
export function toNetworkType(network: transactionCore.Network) {
  if (network.bech32 == transactionCore.networks.bitcoin.bech32) {
    return NetworkType.MAINNET
  } else if (network.bech32 == transactionCore.networks.testnet.bech32) {
    return NetworkType.TESTNET
  } else {
    return NetworkType.REGTEST
  }
}
