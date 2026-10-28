import { P2mrMessageProof, ToSignMessage } from './sign-message'
import { QbitProviderSignPsbtOptions, ToSignData } from './sign-tx'

export interface RequestMethodSendQbitParams {
  sendQbitParams: {
    toAddress: string
    satoshis: number
    feeRate?: number
    memo?: string
    memos?: string[]
  }
  toSignDatas?: ToSignData[]
}

export interface RequestMethodSignMessageParams {
  text: string

  toSignMessages?: ToSignMessage[]
}

export interface RequestMethodVerifyMessageParams {
  address: string
  text: string
  proof: P2mrMessageProof
}

export interface RequestMethodSignPsbtParams {
  psbtHex: string
  options: QbitProviderSignPsbtOptions
  toSignDatas?: ToSignData[]
}

export interface RequestMethodSignPsbtsParams {
  psbtHexs: string[]
  options: QbitProviderSignPsbtOptions[]
  toSignDatas?: ToSignData[]
}
