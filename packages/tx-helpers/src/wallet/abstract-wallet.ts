import { transactionCore } from '@qbit/wallet-core'
import { SignMessageType } from '@qbit/wallet-shared'
import { SignPsbtOptions } from '../types'

export type TxHelperSignMessageType =
  | SignMessageType.ECDSA
  | SignMessageType.BIP322_SIMPLE

export interface AbstractWallet {
  signPsbt(psbt: transactionCore.Psbt, opts?: SignPsbtOptions): Promise<transactionCore.Psbt>
  signMessage(text: string, type: TxHelperSignMessageType): Promise<string>
}
