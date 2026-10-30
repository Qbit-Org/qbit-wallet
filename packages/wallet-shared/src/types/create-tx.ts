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
  /** With `unconfirmed`: the in-mempool transactions a spend of this output builds on. */
  unconfirmedAncestors?: QbitUnconfirmedAncestor[]
}

/**
 * An unconfirmed transaction that a spend of the account's own unconfirmed
 * change depends on: the change's own transaction, or one of its unconfirmed
 * ancestors. qbit Core counts each against the spend's mempool ancestor
 * limits.
 */
export interface QbitUnconfirmedAncestor {
  txid: string
  /** Virtual size in vbytes: the serialized size, as `WITNESS_SCALE_FACTOR` is 1. */
  vsize: number
}

/**
 * An account's spendable Qbit outputs together with the network they were
 * loaded on. Outpoints exist on one network only, and the scriptPubKey they
 * pay is the same on every network, so a list of outputs on its own cannot
 * tell the builder which network it belongs to; a send built from a cached
 * list has to carry this chain back so the builder can refuse outputs that
 * were loaded before a switch to another network.
 *
 * `address` names the account the outputs were read for. The read can take
 * minutes for an account past the explorer's output limit, and the UI may
 * have moved to another account by the time it lands, so the UI keeps only
 * a snapshot whose account is still the selected one.
 */
export interface QbitUtxoSnapshot {
  address: string
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
  /** With `unconfirmed`: the in-mempool transactions a spend of this output builds on. */
  unconfirmedAncestors?: QbitUnconfirmedAncestor[]
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
