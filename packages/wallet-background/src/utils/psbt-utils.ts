import { ToSignInput } from '@qbit/keyring-service/types'
import { transactionCore, getAddressType } from '@qbit/wallet-core'
import { AddressType } from '@qbit/wallet-types'

const DUMMY_SCRIPTS = {
  P2TR_FINAL_SCRIPT_WITNESS:
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  P2WPKH_FINAL_SCRIPT_WITNESS:
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  P2SH_P2WPKH_FINAL_SCRIPT_WITNESS:
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  P2SH_P2WPKH_FINAL_SCRIPT_SIG: '0000000000000000000000000000000000000000000000',
  P2PKH_FINAL_SCRIPT_SIG:
    '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
}

export function dummySignPsbt(userAddress: string, psbtStr: string, toSignInputs: ToSignInput[]) {
  const addressType = getAddressType(userAddress)
  const psbt = transactionCore.Psbt.fromBase64(psbtStr)
  toSignInputs.forEach(input => {
    dummySignPsbtInput(psbt, input.index, addressType)
  })
  return psbt
}

function dummySignPsbtInput(psbt: transactionCore.Psbt, inputIndex: number, addressType: AddressType) {
  if (addressType === AddressType.P2TR) {
    psbt.updateInput(inputIndex, {
      finalScriptWitness: Buffer.from(DUMMY_SCRIPTS.P2TR_FINAL_SCRIPT_WITNESS, 'hex'),
    })
  } else if (addressType === AddressType.P2WPKH) {
    psbt.updateInput(inputIndex, {
      finalScriptWitness: Buffer.from(DUMMY_SCRIPTS.P2WPKH_FINAL_SCRIPT_WITNESS, 'hex'),
    })
  } else if (addressType === AddressType.P2SH_P2WPKH) {
    psbt.updateInput(inputIndex, {
      finalScriptWitness: Buffer.from(DUMMY_SCRIPTS.P2SH_P2WPKH_FINAL_SCRIPT_WITNESS, 'hex'),
      finalScriptSig: Buffer.from(DUMMY_SCRIPTS.P2SH_P2WPKH_FINAL_SCRIPT_SIG, 'hex'),
    })
  } else if (addressType === AddressType.P2PKH) {
    psbt.updateInput(inputIndex, {
      finalScriptSig: Buffer.from(DUMMY_SCRIPTS.P2PKH_FINAL_SCRIPT_SIG, 'hex'),
    })
  }
}

export function formatPsbtHex(psbtHex: string) {
  let formatData = ''
  try {
    if (!/^[0-9a-fA-F]+$/.test(psbtHex)) {
      formatData = transactionCore.Psbt.fromBase64(psbtHex).toHex()
    } else {
      transactionCore.Psbt.fromHex(psbtHex)
      formatData = psbtHex
    }
  } catch (e) {
    throw new Error('invalid psbt')
  }
  return formatData
}

export function psbtFromString(psbtStr: string) {
  if (!/^[0-9a-fA-F]+$/.test(psbtStr)) {
    return transactionCore.Psbt.fromBase64(psbtStr)
  }
  return transactionCore.Psbt.fromHex(psbtStr)
}

export function getEstimateFee(psbt: transactionCore.Psbt, userAddress: string, userPubkey: string) {
  const signedPsbt = dummySignPsbt(
    userAddress,
    psbt.toBase64(),
    psbt.data.inputs.map((_, index) => ({ index, publicKey: userPubkey }))
  )
  return signedPsbt.getFee()
}
