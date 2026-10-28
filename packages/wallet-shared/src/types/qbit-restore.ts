export type QbitRestoreNetworkName = 'mainnet' | 'testnet4' | 'regtest'

/** Gap-limit address discovery outcome for a mnemonic restore. */
export interface QbitRestoreDiscoverySummary {
  /** Indexes (0-based derivation order) with balance or any chain history. */
  activeIndexes: number[]
  /** Highest active index, or -1 when the seed shows no activity at all. */
  highestActiveIndex: number
  /** How many indexes were derived and queried. */
  scannedCount: number
  /** True when the scan hit its index cap before observing a full trailing gap. */
  truncated: boolean
}

/** Outcome of the PQC signature-counter floor reconstruction pass. */
export interface QbitRestoreFloorScanSummary {
  network: QbitRestoreNetworkName
  keyringsScanned: number
  accountsScanned: number
  /** Sum of observed signatures across scanned accounts and networks sharing their HD path. */
  totalObservedSignatures: number
  /** How many accounts had their counter raised to a restored floor. */
  restoredFloorCount: number
  /** Derivation indexes beyond the restored range that show unexpected activity. */
  gapIndexesWithActivity: number[]
  /** True when gap activity suggests another live instance of this seed. */
  possibleConcurrentInstance: boolean
}

/**
 * Recovery report returned by the restore orchestration. When
 * `floorsCompleted` is false the wallet exists but signing stays locked until
 * a floor-scan retry succeeds.
 */
export type QbitRestoreReport = {
  network: QbitRestoreNetworkName
  accountsRestored: number
  discovery: QbitRestoreDiscoverySummary
} & (
  | { floorsCompleted: true; floorScan: QbitRestoreFloorScanSummary }
  | { floorsCompleted: false; floorError: string }
)

/**
 * Outcome of a manual account derivation. The account is committed and
 * selected before a mnemonic-restored Qbit keyring's in-band floor scan runs;
 * `floorScanPending` is true when that scan did not lift the signing gate, in
 * which case the account exists but the keyring cannot sign until a deferred
 * scan (next unlock or chain switch) completes.
 */
export interface DeriveAccountResult {
  floorScanPending: boolean
  /** Why the in-band floor scan left the gate closed; diagnostic only. */
  floorScanError?: string
}
