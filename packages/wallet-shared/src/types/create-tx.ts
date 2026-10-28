import { AddressType, ChainType } from '@qbit/wallet-types'

export interface UnspentOutput {
  txid: string
  vout: number
  satoshis: number
  scriptPk: string
  pubkey: string
  addressType: AddressType
  rawtx?: string
  /** The account's own unconfirmed change; coin selection spends confirmed outputs first. */
  unconfirmed?: boolean
}

/**
 * An account's spendable Qbit outputs together with the network they were
 * loaded on. Outpoints exist on one network only, and the scriptPubKey they
 * pay is the same on every network, so a list of outputs on its own cannot
 * tell the builder which network it belongs to; a send built from a cached
 * list has to carry this chain back so the builder can refuse outputs that
 * were loaded before a switch to another network.
 */
export interface QbitUtxoSnapshot {
  chain: ChainType
  utxos: UnspentOutput[]
}

export interface UTXO {
  txid: string
  vout: number
  satoshis: number
  scriptPk: string
  addressType: AddressType
  /** The account's own unconfirmed change; coin selection spends confirmed outputs first. */
  unconfirmed?: boolean
}

export interface UTXO_Detail {
  txId: string
  outputIndex: number
  satoshis: number
  scriptPk: string
  addressType: AddressType
}

export enum TxType {
  SIGN_TX,
  SEND_QBIT,
}

export interface ToAddressInfo {
  address: string
}

export interface RawTxInfo {
  psbtHex: string
  rawtx: string
  toAddressInfo?: ToAddressInfo
  fee?: number
}
