import {
  addressToScriptPubKey as qbitAddressToScriptPubKey,
  decodeP2mrAddress,
  outputScriptToAddress as qbitOutputScriptToAddress,
  p2mrAddressFromPubkey,
  type QbitNetworkName,
} from '@qbit-oss/protocol'
import { QBIT_P2MR_DUST } from '@qbit/wallet-shared'
import { AddressType, NetworkType } from '@qbit/wallet-types'
import { transactionCore } from '../transaction-core'
import { toPsbtNetwork } from '../network'

function qbitNetworkForNetworkType(networkType: NetworkType): QbitNetworkName {
  if (networkType === NetworkType.MAINNET) return 'mainnet'
  if (networkType === NetworkType.REGTEST) return 'regtest'
  return 'testnet4'
}

function networkTypeForQbitNetwork(network: QbitNetworkName): NetworkType {
  if (network === 'mainnet') return NetworkType.MAINNET
  if (network === 'regtest') return NetworkType.REGTEST
  return NetworkType.TESTNET
}

function isP2mrPrefix(address: string): boolean {
  const lower = address.toLowerCase()
  return lower.startsWith('qb1z') || lower.startsWith('tq1z') || lower.startsWith('qbrt1z')
}

/**
 * Convert public key to transactionCore payment object.
 */
export function publicKeyToPayment(publicKey: string, type: AddressType, networkType: NetworkType) {
  const network = toPsbtNetwork(networkType)
  if (!publicKey) return null
  const pubkey = Buffer.from(publicKey, 'hex')
  if (type === AddressType.P2PKH) {
    return transactionCore.payments.p2pkh({
      pubkey,
      network,
    })
  } else if (type === AddressType.P2WPKH || type === AddressType.BIP44_P2WPKH) {
    return transactionCore.payments.p2wpkh({
      pubkey,
      network,
    })
  } else if (type === AddressType.P2TR || type === AddressType.BIP44_P2TR) {
    return transactionCore.payments.p2tr({
      internalPubkey: pubkey.slice(1, 33),
      network,
    })
  } else if (type === AddressType.P2SH_P2WPKH) {
    const data = transactionCore.payments.p2wpkh({
      pubkey,
      network,
    })
    return transactionCore.payments.p2sh({
      pubkey,
      network,
      redeem: data,
    })
  }
  return null
}

/**
 * Convert public key to transactionCore address.
 */
export function publicKeyToAddress(publicKey: string, type: AddressType, networkType: NetworkType) {
  if (type === AddressType.P2MR) {
    try {
      return p2mrAddressFromPubkey(
        Buffer.from(publicKey, 'hex'),
        qbitNetworkForNetworkType(networkType)
      )
    } catch {
      return ''
    }
  }

  const payment = publicKeyToPayment(publicKey, type, networkType)
  if (payment && payment.address) {
    return payment.address
  } else {
    return ''
  }
}

/**
 * Convert public key to transactionCore scriptPk.
 */
export function publicKeyToScriptPk(
  publicKey: string,
  type: AddressType,
  networkType: NetworkType
) {
  if (type === AddressType.P2MR) {
    const address = publicKeyToAddress(publicKey, type, networkType)
    return address ? Buffer.from(qbitAddressToScriptPubKey(address)).toString('hex') : ''
  }

  const payment = publicKeyToPayment(publicKey, type, networkType)
  if (!payment || !payment.output) {
    return ''
  }
  return payment.output.toString('hex')
}

export function decodeAddress(address: string) {
  if (isP2mrPrefix(address)) {
    try {
      const decoded = decodeP2mrAddress(address)
      return {
        networkType: networkTypeForQbitNetwork(decoded.network),
        addressType: AddressType.P2MR,
        dust: getAddressTypeDust(AddressType.P2MR),
      }
    } catch (e) {}
  }

  const mainnet = toPsbtNetwork(NetworkType.MAINNET)
  const testnet = transactionCore.networks.testnet
  const regtest = transactionCore.networks.regtest
  let decodeBase58: transactionCore.address.Base58CheckResult
  let decodeBech32: transactionCore.address.Bech32Result
  let networkType: NetworkType = NetworkType.MAINNET
  let addressType: AddressType = AddressType.UNKNOWN
  if (address.includes('1')) {
    try {
      decodeBech32 = transactionCore.address.fromBech32(address)
      if (decodeBech32.prefix === mainnet.bech32) {
        networkType = NetworkType.MAINNET
      } else if (decodeBech32.prefix === testnet.bech32) {
        networkType = NetworkType.TESTNET
      } else if (decodeBech32.prefix === regtest.bech32) {
        networkType = NetworkType.REGTEST
      } else {
        networkType = NetworkType.MAINNET
      }
      if (decodeBech32.version === 0) {
        if (decodeBech32.data.length === 20) {
          addressType = AddressType.P2WPKH
        } else if (decodeBech32.data.length === 32) {
          addressType = AddressType.P2WSH
        }
      } else if (decodeBech32.version === 1) {
        if (decodeBech32.data.length === 32) {
          addressType = AddressType.P2TR
        }
      }
      return {
        networkType,
        addressType,
        dust: getAddressTypeDust(addressType),
      }
    } catch (e) {}
  }

  try {
    decodeBase58 = transactionCore.address.fromBase58Check(address)
    if (decodeBase58.version === mainnet.pubKeyHash) {
      networkType = NetworkType.MAINNET
      addressType = AddressType.P2PKH
    } else if (decodeBase58.version === testnet.pubKeyHash) {
      networkType = NetworkType.TESTNET
      addressType = AddressType.P2PKH
    } else if (decodeBase58.version === regtest.pubKeyHash) {
      networkType = NetworkType.REGTEST
      addressType = AddressType.P2PKH
    } else if (decodeBase58.version === mainnet.scriptHash) {
      networkType = NetworkType.MAINNET
      addressType = AddressType.P2SH_P2WPKH
    } else if (decodeBase58.version === testnet.scriptHash) {
      networkType = NetworkType.TESTNET
      addressType = AddressType.P2SH_P2WPKH
    } else if (decodeBase58.version === regtest.scriptHash) {
      networkType = NetworkType.REGTEST
      addressType = AddressType.P2SH_P2WPKH
    }
    return {
      networkType,
      addressType,
      dust: getAddressTypeDust(addressType),
    }
  } catch (e) {}

  return {
    networkType: NetworkType.MAINNET,
    addressType: AddressType.UNKNOWN,
    dust: 546,
  }
}

function getAddressTypeDust(addressType: AddressType) {
  if (addressType === AddressType.P2MR) {
    return QBIT_P2MR_DUST
  } else if (addressType === AddressType.P2WPKH || addressType === AddressType.BIP44_P2WPKH) {
    return 294
  } else if (addressType === AddressType.P2TR || addressType === AddressType.BIP44_P2TR) {
    return 330
  } else {
    return 546
  }
}

/**
 * Get address type.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getAddressType(
  address: string,
  networkType: NetworkType = NetworkType.MAINNET
): AddressType {
  if (isP2mrPrefix(address)) {
    try {
      decodeP2mrAddress(address, qbitNetworkForNetworkType(networkType))
      return AddressType.P2MR
    } catch {
      return AddressType.UNKNOWN
    }
  }

  return decodeAddress(address).addressType
}

/**
 * Convert scriptPk to address.
 */
export function scriptPkToAddress(
  scriptPk: string | Buffer,
  networkType: NetworkType = NetworkType.MAINNET
) {
  const script = typeof scriptPk === 'string' ? Buffer.from(scriptPk, 'hex') : scriptPk
  try {
    return qbitOutputScriptToAddress(script, qbitNetworkForNetworkType(networkType))
  } catch (e) {}

  const network = toPsbtNetwork(networkType)
  try {
    const address = transactionCore.address.fromOutputScript(script, network)
    return address
  } catch (e) {
    return ''
  }
}

export function addressToScriptPk(address: string, networkType: NetworkType): Buffer {
  if (isP2mrPrefix(address)) {
    try {
      return Buffer.from(qbitAddressToScriptPubKey(address, qbitNetworkForNetworkType(networkType)))
    } catch (error) {
      throw new Error(`Invalid address: ${address}`)
    }
  }

  const network = toPsbtNetwork(networkType)

  try {
    return transactionCore.address.toOutputScript(address, network)
  } catch (error) {
    throw new Error(`Invalid address: ${address}`)
  }
}

export function isValidAddress(address: string, networkType: NetworkType): boolean {
  if (!address) return false
  if (isP2mrPrefix(address)) {
    try {
      decodeP2mrAddress(address, qbitNetworkForNetworkType(networkType))
      return true
    } catch (error) {
      return false
    }
  }

  const network = toPsbtNetwork(networkType)

  try {
    transactionCore.address.toOutputScript(address, network)
    return true
  } catch (error) {
    return false
  }
}
