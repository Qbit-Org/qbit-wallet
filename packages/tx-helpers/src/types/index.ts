import { AddressType } from '@qbit/wallet-types'

interface BaseUserToSignInput {
  index: number
  sighashTypes?: number[] | undefined
  disableTweakSigner?: boolean
  tapLeafHashToSign?: Buffer
}

export interface AddressUserToSignInput extends BaseUserToSignInput {
  address: string
}

export interface PublicKeyUserToSignInput extends BaseUserToSignInput {
  publicKey: string
}

export type UserToSignInput = AddressUserToSignInput | PublicKeyUserToSignInput

export interface SignPsbtOptions {
  autoFinalized?: boolean // whether to finalize psbt automatically
  toSignInputs?: UserToSignInput[]
}

export interface UnspentOutput {
  txid: string
  vout: number
  satoshis: number
  scriptPk: string
  pubkey: string
  addressType: AddressType
  rawtx?: string
}
