import { decodeAddress } from '@qbit/wallet-core'
import { AddressType, NetworkType } from '@qbit/wallet-types'
import { UnspentOutput } from 'src/types'
import { ErrorCodes, QBIT_P2MR_DUST, WalletError } from '@qbit/wallet-shared'

/**
 * select utxos so that the total amount of utxos is greater than or equal to targetAmount
 * return the selected utxos and the unselected utxos
 * @param utxos
 * @param targetAmount
 */
function selectUtxos(utxos: UnspentOutput[], targetAmount: number) {
  let selectedUtxos: UnspentOutput[] = []
  let remainingUtxos: UnspentOutput[] = []

  let totalAmount = 0
  for (const utxo of utxos) {
    if (totalAmount < targetAmount) {
      totalAmount += utxo.satoshis
      selectedUtxos.push(utxo)
    } else {
      remainingUtxos.push(utxo)
    }
  }

  return {
    selectedUtxos,
    remainingUtxos,
  }
}

/**
 * return the added virtual size of the utxo
 */
function getAddedVirtualSize(addressType: AddressType) {
  if (addressType === AddressType.P2WPKH || addressType === AddressType.BIP44_P2WPKH) {
    return 41 + (1 + 1 + 72 + 1 + 33) / 4
  } else if (addressType === AddressType.P2TR || addressType === AddressType.BIP44_P2TR) {
    return 41 + (1 + 1 + 64) / 4
  } else if (addressType === AddressType.P2PKH) {
    return 41 + 1 + 1 + 72 + 1 + 33
  } else if (addressType === AddressType.P2SH_P2WPKH) {
    return 41 + 24 + (1 + 1 + 72 + 1 + 33) / 4
  }
  throw new WalletError(ErrorCodes.UNKNOWN)
}

function getOutputVirtualSize(addressType: AddressType) {
  if (addressType === AddressType.P2WPKH || addressType === AddressType.BIP44_P2WPKH) {
    return 31
  } else if (addressType === AddressType.P2TR || addressType === AddressType.BIP44_P2TR) {
    return 43
  } else if (addressType === AddressType.P2PKH) {
    return 34
  } else if (addressType === AddressType.P2SH_P2WPKH) {
    return 32
  }
  throw new WalletError(ErrorCodes.UNKNOWN)
}

function getScriptOutputVirtualSize(script: Buffer) {
  return 8 + getVarIntSize(script.length) + script.length
}

function getVarIntSize(value: number) {
  if (value < 0xfd) {
    return 1
  } else if (value <= 0xffff) {
    return 3
  } else if (value <= 0xffffffff) {
    return 5
  }
  return 9
}

function hasWitness(addressType: AddressType) {
  return (
    addressType === AddressType.P2WPKH ||
    addressType === AddressType.BIP44_P2WPKH ||
    addressType === AddressType.P2TR ||
    addressType === AddressType.BIP44_P2TR ||
    addressType === AddressType.P2SH_P2WPKH
  )
}

export function getUtxoDust(addressType: AddressType) {
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getAddressUtxoDust(
  address: string,
  networkType: NetworkType = NetworkType.MAINNET
) {
  return decodeAddress(address).dust
}

export const utxoHelper = {
  selectUtxos,
  getAddedVirtualSize,
  getOutputVirtualSize,
  getScriptOutputVirtualSize,
  getVarIntSize,
  hasWitness,
  getUtxoDust,
  getAddressUtxoDust,
}
