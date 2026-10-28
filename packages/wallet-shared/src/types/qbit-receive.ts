export type QbitReceiveNetworkName = 'mainnet' | 'testnet4' | 'regtest'
export type QbitSignatureBudgetState = 'normal' | 'warning' | 'critical' | 'exhausted'
export type QbitCounterProvenance = 'local' | 'restored-floor'

export interface QbitReceiveAddressState {
  index: number
  address: string
  used: boolean
  signatureCounter: {
    count: number
    limit: number
    remaining: number
    state: QbitSignatureBudgetState
    provenance: QbitCounterProvenance
    knownOnChainSignatures: number
  }
}

export interface QbitReceiveGapState {
  limit: number
  highestUsedIndex: number
  trailingUnusedCount: number
  remainingIntentCapacity: number
  canCreate: boolean
}

export interface QbitReceiveState {
  network: QbitReceiveNetworkName
  current: QbitReceiveAddressState | null
  previous: QbitReceiveAddressState[]
  gap: QbitReceiveGapState
  activityStatus: 'live' | 'cached'
  floorsPending: boolean
  concurrentInstanceHint: boolean
}
