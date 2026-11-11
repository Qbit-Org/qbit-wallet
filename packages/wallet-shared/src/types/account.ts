import { AddressType } from '@qbit/wallet-types'
import type { WalletColorKey } from '../utils/wallet-identity'
import type { QbitRecoveryState } from './qbit-recovery-lifecycle'

export type WalletKeyring = {
  key: string
  index: number
  type: string
  addressType: AddressType
  accounts: Account[]
  alianName: string
  /**
   * The wallet's palette key: the one stored for it, or its slot's
   * (`walletColorForSlot(index)`) when none is stored or the stored key is
   * unknown. Always one of WALLET_COLOR_KEYS.
   */
  color: WalletColorKey
  hdPath: string
  accountIndexDerivation?: boolean
  qbitRecovery?: QbitRecoveryState
}

export interface Account {
  type: string
  pubkey: string
  address: string
  brandName?: string
  alianName?: string
  displayBrandName?: string
  index?: number
  balance?: number
  key: string
  flag: number
  p2mr?: {
    pubkey: string
    path: string
    scriptPubKey: string
    leafScript: string
    addresses: {
      mainnet: string
      testnet4: string
      signet: string
      regtest: string
    }
    hkdf: {
      account: number
      change: number
      index: number
    }
    signatureCounter: {
      count: number
      limit: number
      remaining: number
      state: 'normal' | 'warning' | 'critical' | 'exhausted'
      provenance: 'local' | 'restored-floor'
      knownOnChainSignatures: number
    }
  }
}
