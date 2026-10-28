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
  totalSatoshis: number
  spendableSatoshis: number
  loading?: boolean
}

export enum AddressFlagType {
  CONFIRMED_UTXO_MODE = 0b10,
}
