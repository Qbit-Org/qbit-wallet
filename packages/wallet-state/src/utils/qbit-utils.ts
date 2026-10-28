import { decodeP2mrAddress, type QbitNetworkName } from '@qbit-oss/protocol'
import { QBIT_P2MR_DUST } from '@qbit/wallet-shared'
import { AddressType, NetworkType } from '@qbit/wallet-types'
import * as bip39 from 'bip39'

function qbitNetworkForNetworkType(networkType?: NetworkType): QbitNetworkName | undefined {
  if (networkType === NetworkType.MAINNET) return 'mainnet'
  if (networkType === NetworkType.REGTEST) return 'regtest'
  if (networkType === NetworkType.TESTNET) return 'testnet4'
  return undefined
}

function isP2mrPrefix(address: string): boolean {
  const lower = address.toLowerCase()
  return lower.startsWith('qb1z') || lower.startsWith('tq1z') || lower.startsWith('qbrt1z')
}

function isValidP2mrAddress(address: string, networkType?: NetworkType): boolean {
  try {
    decodeP2mrAddress(address, qbitNetworkForNetworkType(networkType))
    return true
  } catch {
    return false
  }
}

export function getAddressType(address: string, networkType?: NetworkType) {
  if (isP2mrPrefix(address)) {
    return isValidP2mrAddress(address, networkType) ? AddressType.P2MR : AddressType.UNKNOWN
  }
  return AddressType.UNKNOWN
}

export function isValidAddress(address: string, networkType?: NetworkType) {
  return isP2mrPrefix(address) && isValidP2mrAddress(address, networkType)
}

export function getAddressUtxoDust(address: string) {
  const addressType = getAddressType(address)
  if (addressType === AddressType.P2MR) {
    return QBIT_P2MR_DUST
  } else {
    return QBIT_P2MR_DUST
  }
}

export function isValidHdPath(path: string): boolean {
  if (!path || typeof path !== 'string') {
    return false
  }

  // HD path should start with 'm' or 'M'
  if (!path.startsWith('m') && !path.startsWith('M')) {
    return false
  }

  // Split by '/' and validate each component
  const components = path.split('/')

  // First component should be 'm' or 'M'
  if (components[0] !== 'm' && components[0] !== 'M') {
    return false
  }

  // Validate each path component after 'm'
  for (let i = 1; i < components.length; i++) {
    const component = components[i]

    if (!component) {
      return false
    }

    // Check if it's a hardened path (ends with ')
    const isHardened = component.endsWith("'")
    const numberPart = isHardened ? component.slice(0, -1) : component

    // Check if the number part is a valid integer
    if (!/^\d+$/.test(numberPart)) {
      return false
    }

    const num = parseInt(numberPart, 10)

    // Check if number is within valid range (0 to 2^31-1)
    if (num < 0 || num >= Math.pow(2, 31)) {
      return false
    }
  }

  return true
}

export function validateMnemonic(mnemonic: string): boolean {
  // do not use bip39.validateMnemonic here to reduce bundle size
  // const words = mnemonic.trim().split(/\s+/);
  // const wordCount = words.length;
  // return [12, 15, 18, 21, 24].includes(wordCount);

  return bip39.validateMnemonic(mnemonic)
}
