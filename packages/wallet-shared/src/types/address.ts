export interface QbitBalance {
  confirm_amount: string
  pending_amount: string
  amount: string
}

export interface AddressAssets {
  totalAmount: string
  satoshis?: number
}

export interface AddressSummary {
  address: string
  /** Confirmed and unconfirmed outputs together, which is not what can be spent now. */
  mempoolInclusiveSatoshis: number
  loading?: boolean
}

export enum AddressFlagType {
  CONFIRMED_UTXO_MODE = 0b10,
}
