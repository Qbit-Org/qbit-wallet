import bip39 from 'bip39'
// @ts-expect-error -- hdkey does not expose a compatible typed default export.
import hdkey from 'hdkey'

import { derivePQCKey, sign as signPqc, type PqcDerivedKey } from '@qbit-oss/pqc'
import * as qbitProtocol from '@qbit-oss/protocol'
import type { QbitNetworkName } from '@qbit-oss/protocol'
import type { QbitRestoreFloorSource, QbitRestoreFloorSourceRecord } from '@qbit/wallet-shared'
import bs58check from 'bs58check'

const { decode, encode } = bs58check

const type = 'Qbit HD Key Tree'
const DEFAULT_QBIT_HD_PATH = "m/87'/0'/0'/0"
const P2MR_DESCRIPTOR_HKDF_ACCOUNT = 0
const P2MR_DESCRIPTOR_HKDF_CHANGE = 0
const P2MR_DESCRIPTOR_PURPOSE = 87
const P2MR_DESCRIPTOR_ACCOUNT = 0
const MAX_DESCRIPTOR_INDEX = 0x7fffffff
export const PQC_MAX_SIGNATURES = 1 << 30
const PQC_WARNING_SIGNATURE_THRESHOLD = 1 << 28
const PQC_CRITICAL_SIGNATURE_THRESHOLD = PQC_MAX_SIGNATURES - (1 << 24)
const PQC_SIGNATURE_CACHE_MAX_PER_KEY = 16

interface DeserializeOption {
  hdPath?: string
  mnemonic?: string
  xpriv?: string
  activeIndexes?: number[]
  passphrase?: string
  pqcSignatureCounters?: Record<string, number>
  pqcSignatureCounterProvenance?: Record<string, QbitPqcSignatureCounterProvenance>
  pqcSignatureCounterChainFloors?: Record<string, number>
  pqcSignatureCache?: Record<string, Record<string, QbitPqcSignatureCacheEntry>>
  /**
   * True while a mnemonic-restored keyring has not yet completed its on-chain
   * signature-counter floor reconstruction. While set, every counter
   * reservation (and therefore every signature) is refused: a restored seed may
   * have signed on another install, so signing from an unfloored counter risks
   * SLH-DSA one-time-index reuse. Cleared only by a completed floor scan.
   */
  pqcFloorsPending?: boolean
  /**
   * Marks a keyring whose mnemonic came from user entry rather than fresh
   * generation. Changing its HD path or explicitly entering an unscanned
   * same-path sibling network re-arms `pqcFloorsPending`, because those floors
   * have never been observed on the newly active network.
   */
  pqcRestoredFromMnemonic?: boolean
  /**
   * Latched when any floor scan observed activity beyond the wallet's known
   * indexes — the two-live-wallets hazard. Never auto-cleared: a later clean
   * scan does not erase evidence that another instance may have signed.
   */
  pqcConcurrentInstanceHint?: boolean
  qbitRecoveryState?: QbitRecoveryVaultState | QbitV1RecoveryVaultState
  /**
   * Durable receive intents, scoped by the exact chain rather than the HD path.
   * Testnet4 and regtest intentionally share the same key derivation path, but
   * an address shown on one network must never become the current receive
   * intent on the other.
   */
  qbitReceiveStates?: Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>>
}

export type QbitPqcSignatureLimitState = 'normal' | 'warning' | 'critical' | 'exhausted'
export type QbitPqcSignatureCounterProvenance = 'local' | 'restored-floor'
export type QbitReceiveNetworkName = 'mainnet' | 'testnet4' | 'regtest'
export type QbitRecoveryVaultStatus = 'seed-only-restored' | 'migrating' | 'migrated'
export type QbitRecoveryMigrationPlanStatus = 'prepared' | 'signed' | 'broadcast' | 'confirmed'

export interface QbitRecoveryMigrationPlanVault {
  id: string
  sourcePubkey: string
  sourceAddress: string
  destinationAddress: string
  amount: number
  fee: number
  psbtHex: string
  status: QbitRecoveryMigrationPlanStatus
  signedPsbtHex?: string
  txid?: string
  /** Derivation index of the source account this plan sweeps. */
  sourceIndex?: number
  /**
   * Destination account derivation index. Per-account sweeps allocate these
   * contiguously from 0 so a fresh gap-limit restore of the destination seed
   * rediscovers every funded account even when the funded source indexes are
   * sparse; the plan itself records the source→destination pairing. Version-1
   * consolidated plans omit this and implicitly paid the destination anchor
   * (index 0).
   */
  destinationIndex?: number
  /** Destination account pubkey under the migration network's coin type. */
  destinationPubkey?: string
}

export interface QbitRecoveryMigrationVault {
  destinationKeyringIndex: number
  /**
   * Destination anchor identity: the index-0 pubkey and address under this
   * migration's network. Used only to re-locate the destination keyring —
   * the pay-to address of every sweep is recorded per plan.
   */
  destinationPubkey: string
  destinationAddress: string
  network: QbitReceiveNetworkName
  plans: QbitRecoveryMigrationPlanVault[]
  /**
   * Latched when normalization dropped a malformed plan from an active
   * migration. The dropped plan may have signed or even broadcast a
   * transaction this record no longer tracks, so archiving must not trust
   * the remaining plans alone: completion requires the caller to re-verify
   * the source on-chain and say so explicitly.
   */
  planRecordIncomplete?: true
}

/**
 * Per-network recovery lifecycle. Testnet4 and regtest share coin-1 keys but
 * are separate chains with separate UTXOs, so each network carries its own
 * discovery completeness, migration record, and archive — mirroring the
 * per-network scoping of `qbitReceiveStates`.
 */
export interface QbitRecoveryNetworkVaultState {
  status: QbitRecoveryVaultStatus
  /** True only when restore discovery ended after a complete trailing address gap. */
  addressDiscoveryComplete: boolean
  migration?: QbitRecoveryMigrationVault
}

export interface QbitRecoveryVaultState {
  version: 2
  /** Seed-level: the exposure hazard is the mnemonic, not any one chain. */
  acknowledgement: 'required' | 'accepted'
  /**
   * The user permanently dismissed the home-screen recovery warning. Only
   * meaningful after acknowledgement; it hides the residual banner, not the
   * per-request restored-floor signing confirmations.
   */
  warningDismissed?: true
  networks: Partial<Record<QbitReceiveNetworkName, QbitRecoveryNetworkVaultState>>
}

/** Pre-multi-network vault shape, upgraded on deserialize. */
export interface QbitV1RecoveryVaultState {
  version: 1
  status: QbitRecoveryVaultStatus
  acknowledgement: 'required' | 'accepted'
  addressDiscoveryComplete: boolean
  migration?: QbitRecoveryMigrationVault
}

export interface QbitReceiveIntentState {
  currentIndex: number | null
  /** Derivation indexes that have actually been presented as receive intents. */
  issuedIndexes: number[]
  /** Monotonic chain-activity observations used for single-use address hygiene. */
  usedIndexes: number[]
}

export interface QbitReceiveIntentMutation {
  account: QbitP2mrAccountInfo
  changed: boolean
}

export class QbitPqcSignatureCounterError extends RangeError {
  readonly code = 'PQC_SIGNATURE_COUNTER_EXHAUSTED'
  readonly pubkey: string
  readonly counter: number
  readonly limit: number
  readonly requested: number
  readonly state: QbitPqcSignatureLimitState

  constructor(pubkey: string, counter: number, requested: number) {
    super('PQC signature counter exhausted')
    this.name = 'QbitPqcSignatureCounterError'
    this.pubkey = pubkey
    this.counter = counter
    this.limit = PQC_MAX_SIGNATURES
    this.requested = requested
    this.state = pqcSignatureLimitState(counter)
  }
}

export class QbitPqcFloorsPendingError extends Error {
  readonly code = 'PQC_FLOORS_PENDING'

  constructor() {
    super(
      'PQC signature-counter floors have not been reconstructed for this restored wallet; signing is locked until the restore floor scan completes'
    )
    this.name = 'QbitPqcFloorsPendingError'
  }
}

export interface QbitP2mrAccountInfo {
  index: number
  pubkey: string
  path: string
  scriptPubKey: string
  leafScript: string
  addresses: Record<QbitNetworkName, string>
  hkdf: {
    account: number
    change: number
    index: number
  }
  signatureCounter: {
    count: number
    limit: number
    remaining: number
    state: QbitPqcSignatureLimitState
    provenance: QbitPqcSignatureCounterProvenance
    knownOnChainSignatures: number
  }
}

export interface QbitP2mrDescriptorInfo {
  branch: 'external' | 'internal'
  change: 0 | 1
  path: string
  descriptor: string
  descriptorNoChecksum: string
}

export interface QbitP2mrDescriptorExport {
  network: QbitNetworkName
  coinType: 0 | 1
  containsPrivateKeys: true
  external: QbitP2mrDescriptorInfo
  internal: QbitP2mrDescriptorInfo
  hkdf: {
    account: 0
    change: 0
  }
  coreProvenance: {
    repository: 'Qbit-Org/qbit'
    commit: '70fea84f5becfb57463247af09790df5ddd424f8'
    source: 'src/wallet/walletutil.cpp'
  }
}

export interface QbitPqcSignatureCounterReservation {
  pubkey: string
  previousCounter: number
  previousCounterProvenance: QbitPqcSignatureCounterProvenance
  newCounter: number
  signatureLimit: number
  signaturesRemaining: number
  limitState: QbitPqcSignatureLimitState
  counterProvenance: QbitPqcSignatureCounterProvenance
}

export interface QbitPqcSignatureCounterFloor {
  pubkey: string
  previousCounter: number
  observedCounter: number
  newCounter: number
  counterProvenance: QbitPqcSignatureCounterProvenance
}

export interface QbitPqcSignatureCacheEntry {
  signatureHex: string
  counter: number
  createdAt: number
}

/** Chain-observed activity for one P2MR account, reported by an injected provider. */
export interface QbitPqcObservedActivity {
  /**
   * A lower bound on signatures this key has produced that are observable
   * on-chain — e.g. the number of this address's outputs that have been spent.
   * Used as a restore floor; counters are only ever raised, never lowered, and
   * message signatures remain invisible, so this is a *minimum*.
   */
  observedSignatures: number
  /** Whether the address shows any chain/mempool activity (for gap detection). */
  hasActivity?: boolean
  /** Which read produced `observedSignatures`, reported back with the floor. */
  floorSource?: QbitRestoreFloorSource
}

/** Injected per-account history lookup (wired to @qbit-oss/api by the wallet). */
export type QbitPqcHistoryObserver = (
  account: QbitP2mrAccountInfo
) => Promise<QbitPqcObservedActivity> | QbitPqcObservedActivity

export interface QbitPqcRestoreFloorScan {
  /** Floor results for the keyring's active accounts. */
  floors: QbitPqcSignatureCounterFloor[]
  /** The read behind each active account's floor, for accounts whose observer named one. */
  floorSources: QbitRestoreFloorSourceRecord[]
  /** Indexes scanned beyond the active range that unexpectedly show activity. */
  gapIndexesWithActivity: number[]
  /**
   * True when activity was found beyond the wallet's known indexes — a hint
   * that another instance of this seed may be (or have been) live, so the
   * local counters could understate real usage.
   */
  possibleConcurrentInstance: boolean
}

type ProtocolModule = typeof import('@qbit-oss/protocol')

// Static import (not dynamic): keyring-service runs inside the MV3 service
// worker, which cannot load webpack async chunks. Inlining avoids that.
async function loadProtocol(): Promise<ProtocolModule> {
  return qbitProtocol
}

export class QbitHdKeyring {
  static type = type

  type = type
  mnemonic = ''
  xpriv = ''
  passphrase = ''
  hdPath = DEFAULT_QBIT_HD_PATH
  root: any = null
  hdWallet?: any
  activeIndexes: number[] = []
  page = 0
  perPage = 5
  pqcSignatureCounters: Record<string, number> = {}
  pqcSignatureCounterProvenance: Record<string, QbitPqcSignatureCounterProvenance> = {}
  pqcSignatureCounterChainFloors: Record<string, number> = {}
  pqcSignatureCache: Record<string, Record<string, QbitPqcSignatureCacheEntry>> = {}
  pqcFloorsPending = false
  pqcRestoredFromMnemonic = false
  pqcConcurrentInstanceHint = false
  qbitRecoveryState?: QbitRecoveryVaultState
  qbitReceiveStates: Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>> = {}

  private _index2account: Record<number, QbitP2mrAccountInfo> = {}

  constructor(opts?: DeserializeOption) {
    if (opts) {
      this.deserialize(opts)
    }
  }

  async serialize(): Promise<DeserializeOption> {
    return {
      mnemonic: this.mnemonic,
      xpriv: this.xpriv,
      activeIndexes: this.activeIndexes,
      hdPath: this.hdPath,
      passphrase: this.passphrase,
      pqcSignatureCounters: { ...this.pqcSignatureCounters },
      pqcSignatureCounterProvenance: { ...this.pqcSignatureCounterProvenance },
      pqcSignatureCounterChainFloors: { ...this.pqcSignatureCounterChainFloors },
      pqcSignatureCache: clonePqcSignatureCache(this.pqcSignatureCache),
      pqcFloorsPending: this.pqcFloorsPending,
      pqcRestoredFromMnemonic: this.pqcRestoredFromMnemonic,
      pqcConcurrentInstanceHint: this.pqcConcurrentInstanceHint,
      qbitRecoveryState: cloneQbitRecoveryState(this.qbitRecoveryState),
      qbitReceiveStates: cloneQbitReceiveStates(this.qbitReceiveStates),
    }
  }

  async deserialize(_opts: DeserializeOption = {}) {
    if (this.root) {
      throw new Error('Qbit-Hd-Keyring: Secret recovery phrase already provided')
    }
    const opts = _opts as DeserializeOption
    this.mnemonic = ''
    this.xpriv = ''
    this.passphrase = opts.passphrase || ''
    this.root = null
    this.hdWallet = undefined
    this.hdPath = opts.hdPath || DEFAULT_QBIT_HD_PATH
    this._index2account = {}
    this.activeIndexes = []
    this.pqcSignatureCounters = normalizePqcSignatureCounters(opts.pqcSignatureCounters || {})
    this.pqcSignatureCounterProvenance = normalizePqcSignatureCounterProvenance(
      opts.pqcSignatureCounterProvenance || {},
      this.pqcSignatureCounters
    )
    this.pqcRestoredFromMnemonic =
      opts.pqcRestoredFromMnemonic === true || opts.pqcFloorsPending === true
    this.pqcSignatureCounterChainFloors = normalizePqcSignatureCounterChainFloors(
      opts.pqcSignatureCounterChainFloors || {},
      this.pqcSignatureCounters,
      this.pqcSignatureCounterProvenance,
      this.pqcRestoredFromMnemonic
    )
    if (this.pqcRestoredFromMnemonic) {
      Object.keys(this.pqcSignatureCounters).forEach(pubkey => {
        this.pqcSignatureCounterProvenance[pubkey] = 'restored-floor'
      })
    }
    this.pqcSignatureCache = normalizePqcSignatureCache(
      opts.pqcSignatureCache || {},
      this.pqcSignatureCounters
    )
    this.pqcFloorsPending = opts.pqcFloorsPending === true
    this.pqcConcurrentInstanceHint = opts.pqcConcurrentInstanceHint === true
    assertQbitHdPath(this.hdPath)
    this.qbitRecoveryState = normalizeQbitRecoveryState(
      opts.qbitRecoveryState,
      this.pqcRestoredFromMnemonic,
      qbitHdPathCoinType(this.hdPath)
    )
    this.qbitReceiveStates = normalizeQbitReceiveStates(opts.qbitReceiveStates || {})

    if (opts.mnemonic) {
      this.initFromMnemonic(opts.mnemonic)
    } else if (opts.xpriv) {
      this.initFromXpriv(opts.xpriv)
    }

    if (opts.activeIndexes) {
      this.activeIndexes = normalizeIndexes(opts.activeIndexes)
    }
    this.activeIndexes = normalizeQbitReceiveIndexes([
      ...this.activeIndexes,
      ...Object.values(this.qbitReceiveStates).flatMap(state =>
        state
          ? [
              ...state.issuedIndexes,
              ...state.usedIndexes,
              ...(state.currentIndex === null ? [] : [state.currentIndex]),
            ]
          : []
      ),
    ])
  }

  /**
   * Restore the serializable account/PQC state captured by serialize() onto
   * this live instance. deserialize() refuses to run twice, and replacing the
   * instance is not an option for rollbacks: PQC counter operations queued on
   * the service's counter mutex hold a reference to this object, so a failed
   * account mutation must roll back in place or their counter advances would
   * land on a detached keyring and never persist. Key material is untouched.
   */
  restoreAccountSnapshot(snapshot: DeserializeOption): void {
    this.pqcSignatureCounters = normalizePqcSignatureCounters(snapshot.pqcSignatureCounters || {})
    this.pqcSignatureCounterProvenance = normalizePqcSignatureCounterProvenance(
      snapshot.pqcSignatureCounterProvenance || {},
      this.pqcSignatureCounters
    )
    this.pqcSignatureCache = normalizePqcSignatureCache(
      snapshot.pqcSignatureCache || {},
      this.pqcSignatureCounters
    )
    this.pqcFloorsPending = snapshot.pqcFloorsPending === true
    this.pqcRestoredFromMnemonic =
      snapshot.pqcRestoredFromMnemonic === true || snapshot.pqcFloorsPending === true
    // Account removal deletes the removed key's observed chain floor along
    // with its counter state; a rollback that skipped the floor map would
    // retain the account while its live floor reads 0+ and a reopen falls
    // back to the full counter, including off-chain signatures, as known
    // on-chain usage.
    this.pqcSignatureCounterChainFloors = normalizePqcSignatureCounterChainFloors(
      snapshot.pqcSignatureCounterChainFloors || {},
      this.pqcSignatureCounters,
      this.pqcSignatureCounterProvenance,
      this.pqcRestoredFromMnemonic
    )
    this.pqcConcurrentInstanceHint = snapshot.pqcConcurrentInstanceHint === true
    this.qbitReceiveStates = normalizeQbitReceiveStates(snapshot.qbitReceiveStates || {})
    this.activeIndexes = normalizeQbitReceiveIndexes([
      ...normalizeIndexes(snapshot.activeIndexes || []),
      ...Object.values(this.qbitReceiveStates).flatMap(state =>
        state
          ? [
              ...state.issuedIndexes,
              ...state.usedIndexes,
              ...(state.currentIndex === null ? [] : [state.currentIndex]),
            ]
          : []
      ),
    ])
    // The rolled-back mutation may have derived its candidate account into
    // the cache, and getIndexByAddress resolves addresses from cache entries
    // regardless of activeIndexes — prune everything outside the restored
    // active set so a rejected account is not address-resolvable.
    const restoredIndexes = new Set(this.activeIndexes)
    for (const key of Object.keys(this._index2account)) {
      if (!restoredIndexes.has(Number(key))) {
        delete this._index2account[Number(key)]
      }
    }
  }

  initFromXpriv(xpriv: string) {
    if (this.root) {
      throw new Error('Qbit-Hd-Keyring: Secret recovery phrase already provided')
    }

    this.xpriv = xpriv
    this._index2account = {}
    this.hdWallet = hdkey.fromJSON({ xpriv })
    this.root = this.hdWallet.derive(this.hdPath)
  }

  initFromMnemonic(mnemonic: string) {
    if (this.root) {
      throw new Error('Qbit-Hd-Keyring: Secret recovery phrase already provided')
    }

    this.mnemonic = mnemonic
    this._index2account = {}

    const seed = bip39.mnemonicToSeedSync
      ? bip39.mnemonicToSeedSync(mnemonic, this.passphrase)
      : bip39.mnemonicToSeed(mnemonic, this.passphrase)
    this.hdWallet = hdkey.fromMasterSeed(seed)
    this.root = this.hdWallet.derive(this.hdPath)
  }

  changeHdPath(hdPath: string) {
    if (!this.mnemonic && !this.xpriv) {
      throw new Error('Qbit-Hd-Keyring: Not support')
    }

    assertQbitHdPath(hdPath)
    const pathChanged = hdPath !== this.hdPath
    this.hdPath = hdPath
    this.root = this.hdWallet.derive(this.hdPath)
    this._index2account = {}
    if (pathChanged) {
      // A restored seed re-derived on a different network has unscanned floors
      // there; close the signing gate until a scan on the new path completes.
      this.rearmPqcRestoreFloors()
    }
  }

  rearmPqcRestoreFloors(): boolean {
    if (!this.pqcRestoredFromMnemonic || this.pqcFloorsPending) return false
    this.pqcFloorsPending = true
    return true
  }

  async addAccounts(numberOfAccounts = 1) {
    let count = numberOfAccounts
    let currentIdx = 0
    const newAccounts: string[] = []

    while (count) {
      if (this.activeIndexes.includes(currentIdx)) {
        currentIdx += 1
        continue
      }
      const account = await this._accountFromIndex(currentIdx)
      this.activeIndexes.push(currentIdx)
      newAccounts.push(account.pubkey)
      currentIdx += 1
      count -= 1
    }

    return newAccounts
  }

  activeAccounts(indexes: number[]) {
    this.activeIndexes = normalizeIndexes(indexes)
    return this.activeIndexes
      .map(index => this._index2account[index]?.pubkey)
      .filter((pubkey): pubkey is string => Boolean(pubkey))
  }

  async getFirstPage() {
    this.page = 0
    return this.__getPage(1)
  }

  async getNextPage() {
    return this.__getPage(1)
  }

  async getPreviousPage() {
    return this.__getPage(-1)
  }

  async __getPage(increment: number) {
    this.page += increment

    if (!this.page || this.page <= 0) {
      this.page = 1
    }

    const from = (this.page - 1) * this.perPage
    const to = from + this.perPage
    const accounts: { address: string; index: number }[] = []

    for (let i = from; i < to; i += 1) {
      const account = await this._accountFromIndex(i)
      accounts.push({
        address: account.pubkey,
        index: i + 1,
      })
    }

    return accounts
  }

  async getAccounts() {
    const accounts = await this.getQbitAccounts()
    return accounts.map(account => account.pubkey)
  }

  async getQbitAccounts(): Promise<QbitP2mrAccountInfo[]> {
    const accounts: QbitP2mrAccountInfo[] = []
    for (const index of this.activeIndexes) {
      accounts.push(await this._accountFromIndex(index))
    }
    return accounts
  }

  prepareForMnemonicRestore(
    indexes: number[],
    addressDiscoveryComplete = false,
    network?: QbitReceiveNetworkName
  ): void {
    if (!this.mnemonic || !this.root) {
      throw new Error('Qbit-Hd-Keyring: mnemonic restore keyring is not initialized')
    }
    const activeIndexes = normalizeIndexes(indexes)
    if (activeIndexes.length === 0) {
      throw new Error('Qbit-Hd-Keyring: mnemonic restore requires an active account')
    }
    // Discovery ran against exactly one chain, so its completeness may only be
    // recorded for that network. Without a network the flag has nowhere safe
    // to land: coin type 0 implies mainnet, while coin type 1 is ambiguous
    // between testnet4 and regtest and conservatively records nothing
    // (discovery is resumable, so re-running it later is safe).
    const discoveredNetwork =
      network ?? (qbitHdPathCoinType(this.hdPath) === 0 ? 'mainnet' : undefined)
    if (discoveredNetwork !== undefined) {
      assertQbitReceiveNetwork(discoveredNetwork)
      assertQbitRecoveryNetworkMatchesCoinType(discoveredNetwork, this.hdPath)
    }

    // Keep the discovery cache: it contains public account metadata only, and
    // every temporary PQC secret buffer was zeroed by _accountFromIndex.
    this.activeIndexes = activeIndexes
    this.pqcFloorsPending = true
    this.pqcRestoredFromMnemonic = true
    this.qbitRecoveryState = defaultQbitRecoveryState(
      discoveredNetwork === undefined
        ? undefined
        : { network: discoveredNetwork, addressDiscoveryComplete }
    )
  }

  async getQbitReceiveAccount(index: number): Promise<QbitP2mrAccountInfo> {
    return this._accountFromIndex(index)
  }

  getQbitReceiveState(network: QbitReceiveNetworkName): QbitReceiveIntentState {
    assertQbitReceiveNetwork(network)
    return cloneQbitReceiveState(
      this.qbitReceiveStates[network] || {
        currentIndex: null,
        issuedIndexes: [],
        usedIndexes: [],
      }
    )
  }

  replaceQbitReceiveState(
    network: QbitReceiveNetworkName,
    state: QbitReceiveIntentState,
    activeIndexes = this.activeIndexes
  ): void {
    assertQbitReceiveNetwork(network)
    this.qbitReceiveStates[network] = normalizeQbitReceiveState(state)
    this.activeIndexes = normalizeQbitReceiveIndexes(activeIndexes)
  }

  async setQbitReceiveIntent(
    network: QbitReceiveNetworkName,
    index: number
  ): Promise<QbitReceiveIntentMutation> {
    assertQbitReceiveNetwork(network)
    assertDescriptorIndex(index)
    const account = await this._accountFromIndex(index)
    const previous = this.getQbitReceiveState(network)
    const issuedIndexes = previous.issuedIndexes.includes(index)
      ? previous.issuedIndexes
      : [...previous.issuedIndexes, index]
    const changed =
      previous.currentIndex !== index ||
      issuedIndexes.length !== previous.issuedIndexes.length ||
      !this.activeIndexes.includes(index)

    if (changed) {
      this.activeIndexes = normalizeQbitReceiveIndexes([...this.activeIndexes, index])
      this.qbitReceiveStates[network] = {
        currentIndex: index,
        issuedIndexes,
        usedIndexes: previous.usedIndexes,
      }
    }

    return { account, changed }
  }

  /**
   * Record indexes whose addresses are committed to receive funds outside the
   * interactive receive flow — e.g. structure-preserving migration sweeps —
   * so single-use hygiene never hands one of them out as a receive intent.
   * Unlike setQbitReceiveIntent this never changes the current intent.
   */
  markQbitReceiveIndexesIssued(
    network: QbitReceiveNetworkName,
    indexes: readonly number[]
  ): boolean {
    assertQbitReceiveNetwork(network)
    const state = this.getQbitReceiveState(network)
    const issuedIndexes = normalizeQbitReceiveIndexes([...state.issuedIndexes, ...indexes])
    const changed =
      issuedIndexes.length !== state.issuedIndexes.length ||
      indexes.some(index => !this.activeIndexes.includes(index))
    if (!changed) return false
    this.activeIndexes = normalizeQbitReceiveIndexes([...this.activeIndexes, ...indexes])
    this.qbitReceiveStates[network] = {
      ...state,
      issuedIndexes,
    }
    return true
  }

  recordQbitReceiveActivity(network: QbitReceiveNetworkName, indexes: readonly number[]): boolean {
    assertQbitReceiveNetwork(network)
    const state = this.getQbitReceiveState(network)
    const observedIndexes = normalizeQbitReceiveIndexes([...state.usedIndexes, ...indexes])
    for (const index of observedIndexes) {
      if (!this.activeIndexes.includes(index)) {
        throw new Error(`Qbit-Hd-Keyring: receive activity index ${index} is not active`)
      }
    }
    if (
      observedIndexes.length === state.usedIndexes.length &&
      observedIndexes.every((index, position) => index === state.usedIndexes[position])
    ) {
      return false
    }
    this.qbitReceiveStates[network] = {
      ...state,
      usedIndexes: observedIndexes,
    }
    return true
  }

  async getPqcSignatureCounter(pubkeyOrAddress: string): Promise<number> {
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    return this.pqcSignatureCounters[pubkey] || 0
  }

  async getPqcSignatureCounterPubkey(pubkeyOrAddress: string): Promise<string> {
    return this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
  }

  async getPqcSignatureCounterMetadata(pubkeyOrAddress: string): Promise<{
    pubkey: string
    provenance: QbitPqcSignatureCounterProvenance
    knownOnChainSignatures: number
    recoveryStatus: QbitRecoveryVaultStatus | 'clean'
  }> {
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    return {
      pubkey,
      provenance:
        this.pqcSignatureCounterProvenance[pubkey] ||
        (this.pqcRestoredFromMnemonic ? 'restored-floor' : 'local'),
      knownOnChainSignatures: this.pqcSignatureCounterChainFloors[pubkey] || 0,
      recoveryStatus: this.effectiveQbitRecoveryStatus(),
    }
  }

  /**
   * The migration lifecycle governs the keys of its own network. Keys
   * re-derived for a different coin type (e.g. mainnet after a testnet4
   * migration) were never scanned, planned, or swept by that migration, so
   * they remain seed-only restored instead of inheriting its archive.
   *
   * With a network argument, returns that network's status (guarded against
   * asking about a network the current derivation path cannot spend). Without
   * one, collapses the sibling networks sharing the current coin type into
   * the strictest answer for these keys: any active migration keeps them
   * migration-locked, and they read archived only when every sibling network
   * has archived — a sibling still awaiting its sweep must stay signable.
   */
  effectiveQbitRecoveryStatus(
    network?: QbitReceiveNetworkName
  ): QbitRecoveryVaultStatus | 'clean' {
    const state = this.qbitRecoveryState
    if (!state) return 'clean'
    const coinType = qbitHdPathCoinType(this.hdPath)
    if (network !== undefined) {
      assertQbitReceiveNetwork(network)
      if (qbitRecoveryNetworkCoinType(network) !== coinType) return 'seed-only-restored'
      return state.networks[network]?.status ?? 'seed-only-restored'
    }
    const statuses = QBIT_RECOVERY_NETWORKS.filter(
      candidate => qbitRecoveryNetworkCoinType(candidate) === coinType
    ).map(candidate => state.networks[candidate]?.status ?? 'seed-only-restored')
    if (statuses.some(status => status === 'migrating')) return 'migrating'
    if (statuses.every(status => status === 'migrated')) return 'migrated'
    return 'seed-only-restored'
  }

  getQbitRecoveryState(): QbitRecoveryVaultState | undefined {
    return cloneQbitRecoveryState(this.qbitRecoveryState)
  }

  restoreQbitRecoveryState(
    state: QbitRecoveryVaultState | QbitV1RecoveryVaultState | undefined
  ): void {
    this.qbitRecoveryState = normalizeQbitRecoveryState(
      state,
      this.pqcRestoredFromMnemonic,
      qbitHdPathCoinType(this.hdPath)
    )
  }

  acknowledgeQbitRecoveryRisk(): QbitRecoveryVaultState {
    if (!this.qbitRecoveryState) {
      throw new Error('Qbit-Hd-Keyring: wallet is not seed-only restored')
    }
    this.qbitRecoveryState = {
      ...this.qbitRecoveryState,
      acknowledgement: 'accepted',
    }
    return cloneQbitRecoveryState(this.qbitRecoveryState)!
  }

  dismissQbitRecoveryWarning(): QbitRecoveryVaultState {
    const state = this.qbitRecoveryState
    if (!state) {
      throw new Error('Qbit-Hd-Keyring: wallet is not seed-only restored')
    }
    if (state.acknowledgement !== 'accepted') {
      throw new Error('Qbit-Hd-Keyring: recovery risk has not been acknowledged')
    }
    this.qbitRecoveryState = {
      ...state,
      warningDismissed: true,
    }
    return cloneQbitRecoveryState(this.qbitRecoveryState)!
  }

  /**
   * Persist that a resumed gap-limit scan on this network ended on a complete
   * trailing gap. This is the only path that can turn a truncated restore's
   * discovery incompleteness back into an archivable migration.
   */
  completeQbitRecoveryAddressDiscovery(network: QbitReceiveNetworkName): QbitRecoveryVaultState {
    assertQbitReceiveNetwork(network)
    const state = this.qbitRecoveryState
    if (!state) {
      throw new Error('Qbit-Hd-Keyring: wallet is not seed-only restored')
    }
    this.qbitRecoveryState = this._replaceQbitRecoveryNetworkState(state, network, {
      ...this._qbitRecoveryNetworkState(state, network),
      addressDiscoveryComplete: true,
    })
    return cloneQbitRecoveryState(this.qbitRecoveryState)!
  }

  beginQbitRecoveryMigration(
    network: QbitReceiveNetworkName,
    migration: Omit<QbitRecoveryMigrationVault, 'plans'>
  ): QbitRecoveryVaultState {
    assertQbitReceiveNetwork(network)
    const state = this.qbitRecoveryState
    const record = state ? this._qbitRecoveryNetworkState(state, network) : undefined
    if (!state || record?.status !== 'seed-only-restored') {
      throw new Error('Qbit-Hd-Keyring: wallet cannot begin recovery migration')
    }
    if (migration.network !== network) {
      throw new Error('Qbit-Hd-Keyring: recovery migration network mismatch')
    }
    this.qbitRecoveryState = this._replaceQbitRecoveryNetworkState(state, network, {
      ...record,
      status: 'migrating',
      migration: {
        ...migration,
        plans: [],
      },
    })
    return cloneQbitRecoveryState(this.qbitRecoveryState)!
  }

  replaceQbitRecoveryMigrationPlans(
    network: QbitReceiveNetworkName,
    plans: QbitRecoveryMigrationPlanVault[]
  ): QbitRecoveryVaultState {
    assertQbitReceiveNetwork(network)
    const state = this.qbitRecoveryState
    const record = state ? this._qbitRecoveryNetworkState(state, network) : undefined
    if (!state || record?.status !== 'migrating' || !record.migration) {
      throw new Error('Qbit-Hd-Keyring: recovery migration is not active')
    }
    this.qbitRecoveryState = this._replaceQbitRecoveryNetworkState(state, network, {
      ...record,
      migration: {
        ...record.migration,
        plans,
      },
    })
    return cloneQbitRecoveryState(this.qbitRecoveryState)!
  }

  updateQbitRecoveryMigrationPlan(
    network: QbitReceiveNetworkName,
    planId: string,
    update: {
      status: QbitRecoveryMigrationPlanStatus
      signedPsbtHex?: string
      txid?: string
    }
  ): QbitRecoveryVaultState {
    assertQbitReceiveNetwork(network)
    const state = this.qbitRecoveryState
    const record = state ? this._qbitRecoveryNetworkState(state, network) : undefined
    if (record?.status !== 'migrating' || !record.migration) {
      throw new Error('Qbit-Hd-Keyring: recovery migration is not active')
    }
    const planIndex = record.migration.plans.findIndex(plan => plan.id === planId)
    const current = record.migration.plans[planIndex]
    if (!current) {
      throw new Error('Qbit-Hd-Keyring: recovery migration plan not found')
    }
    const currentRank = migrationPlanStatusRank(current.status)
    const nextRank = migrationPlanStatusRank(update.status)
    const reopensConfirmedPlan =
      current.status === 'confirmed' &&
      update.status === 'broadcast' &&
      update.signedPsbtHex?.toLowerCase() === current.signedPsbtHex &&
      update.txid?.toLowerCase() === current.txid
    if ((!reopensConfirmedPlan && nextRank < currentRank) || nextRank > currentRank + 1) {
      throw new Error('Qbit-Hd-Keyring: invalid recovery migration plan transition')
    }
    const plans = record.migration.plans.map((plan, index) =>
      index === planIndex
        ? {
            ...plan,
            ...update,
          }
        : plan
    )
    return this.replaceQbitRecoveryMigrationPlans(network, plans)
  }

  markQbitRecoveryMigrated(
    network: QbitReceiveNetworkName,
    options?: { allowIncompletePlanRecord?: boolean }
  ): QbitRecoveryVaultState {
    assertQbitReceiveNetwork(network)
    const state = this.qbitRecoveryState
    const record = state ? this._qbitRecoveryNetworkState(state, network) : undefined
    if (!state || record?.status !== 'migrating' || !record.migration) {
      throw new Error('Qbit-Hd-Keyring: recovery migration is not active')
    }
    if (record.migration.plans.some(plan => plan.status !== 'confirmed')) {
      throw new Error('Qbit-Hd-Keyring: recovery migration is not confirmed')
    }
    if (record.migration.planRecordIncomplete && options?.allowIncompletePlanRecord !== true) {
      throw new Error('Qbit-Hd-Keyring: recovery migration plan record is incomplete')
    }
    if (!record.addressDiscoveryComplete) {
      throw new Error('Qbit-Hd-Keyring: recovery address discovery is incomplete')
    }
    this.qbitRecoveryState = {
      ...this._replaceQbitRecoveryNetworkState(state, network, {
        ...record,
        status: 'migrated',
      })!,
      acknowledgement: 'accepted',
    }
    return cloneQbitRecoveryState(this.qbitRecoveryState)!
  }

  reopenQbitRecoveryMigration(
    network: QbitReceiveNetworkName,
    planIds: readonly string[]
  ): QbitRecoveryVaultState {
    assertQbitReceiveNetwork(network)
    const state = this.qbitRecoveryState
    const record = state ? this._qbitRecoveryNetworkState(state, network) : undefined
    if (!state || record?.status !== 'migrated' || !record.migration) {
      throw new Error('Qbit-Hd-Keyring: migrated recovery state is unavailable')
    }
    const affected = new Set(planIds)
    const plans = record.migration.plans.map(plan =>
      affected.has(plan.id) && plan.status === 'confirmed'
        ? { ...plan, status: 'broadcast' as const }
        : plan
    )
    this.qbitRecoveryState = this._replaceQbitRecoveryNetworkState(state, network, {
      ...record,
      status: 'migrating',
      migration: {
        ...record.migration,
        plans,
      },
    })
    return cloneQbitRecoveryState(this.qbitRecoveryState)!
  }

  private _qbitRecoveryNetworkState(
    state: QbitRecoveryVaultState,
    network: QbitReceiveNetworkName
  ): QbitRecoveryNetworkVaultState {
    return (
      state.networks[network] ?? { status: 'seed-only-restored', addressDiscoveryComplete: false }
    )
  }

  private _replaceQbitRecoveryNetworkState(
    state: QbitRecoveryVaultState,
    network: QbitReceiveNetworkName,
    record: QbitRecoveryNetworkVaultState
  ): QbitRecoveryVaultState | undefined {
    return normalizeQbitRecoveryState(
      {
        ...state,
        networks: {
          ...state.networks,
          [network]: record,
        },
      },
      true,
      qbitHdPathCoinType(this.hdPath)
    )
  }

  async assertPqcSignatureCounterAvailable(pubkeyOrAddress: string, count = 1): Promise<void> {
    if (this.pqcFloorsPending) {
      throw new QbitPqcFloorsPendingError()
    }
    assertSignatureCounterAdvance(count)
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    const currentCounter = this.pqcSignatureCounters[pubkey] || 0
    assertSignatureCounterCanAdvance(pubkey, currentCounter, count)
  }

  async reservePqcSignatureCounter(
    pubkeyOrAddress: string,
    count = 1
  ): Promise<QbitPqcSignatureCounterReservation> {
    if (this.pqcFloorsPending) {
      throw new QbitPqcFloorsPendingError()
    }
    assertSignatureCounterAdvance(count)
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    const previousCounter = this.pqcSignatureCounters[pubkey] || 0
    const previousCounterProvenance =
      this.pqcSignatureCounterProvenance[pubkey] ||
      (this.pqcRestoredFromMnemonic ? 'restored-floor' : 'local')
    assertSignatureCounterCanAdvance(pubkey, previousCounter, count)

    const newCounter = previousCounter + count
    this.pqcSignatureCounters[pubkey] = newCounter
    this.pqcSignatureCounterProvenance[pubkey] = previousCounterProvenance
    const index = await this._getIndexForPubkey(pubkey)
    if (this._index2account[index]) {
      this._index2account[index]!.signatureCounter = pqcSignatureCounterSnapshot(
        newCounter,
        previousCounterProvenance,
        this.pqcSignatureCounterChainFloors[pubkey] || 0
      )
    }

    return {
      pubkey,
      previousCounter,
      previousCounterProvenance,
      newCounter,
      signatureLimit: PQC_MAX_SIGNATURES,
      signaturesRemaining: PQC_MAX_SIGNATURES - newCounter,
      limitState: pqcSignatureLimitState(newCounter),
      counterProvenance: previousCounterProvenance,
    }
  }

  async rollbackPqcSignatureCounterReservation(
    pubkeyOrAddress: string,
    reservation: QbitPqcSignatureCounterReservation
  ): Promise<void> {
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    if (pubkey !== reservation.pubkey) {
      throw new Error('Qbit-Hd-Keyring: reservation pubkey mismatch')
    }
    const currentCounter = this.pqcSignatureCounters[pubkey] || 0
    if (currentCounter !== reservation.newCounter) {
      throw new Error('Qbit-Hd-Keyring: cannot roll back stale PQC counter reservation')
    }

    this.pqcSignatureCounters[pubkey] = reservation.previousCounter
    this.pqcSignatureCounterProvenance[pubkey] = reservation.previousCounterProvenance
    const index = await this._getIndexForPubkey(pubkey)
    if (this._index2account[index]) {
      this._index2account[index]!.signatureCounter = pqcSignatureCounterSnapshot(
        reservation.previousCounter,
        reservation.previousCounterProvenance,
        this.pqcSignatureCounterChainFloors[pubkey] || 0
      )
    }
  }

  async applyPqcSignatureCounterFloor(
    pubkeyOrAddress: string,
    observedCounter: number,
    provenance: QbitPqcSignatureCounterProvenance = 'restored-floor'
  ): Promise<QbitPqcSignatureCounterFloor> {
    assertSignatureCounterValue(observedCounter)
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    const previousCounter = this.pqcSignatureCounters[pubkey] || 0
    const newCounter = Math.max(previousCounter, observedCounter)
    const previousChainFloor = this.pqcSignatureCounterChainFloors[pubkey] || 0
    this.pqcSignatureCounterChainFloors[pubkey] = Math.max(previousChainFloor, observedCounter)
    const confirmsRestoredProvenance =
      this.pqcRestoredFromMnemonic && provenance === 'restored-floor'
    if (
      newCounter !== previousCounter ||
      this.pqcSignatureCounterChainFloors[pubkey] !== previousChainFloor ||
      confirmsRestoredProvenance
    ) {
      this.pqcSignatureCounters[pubkey] = newCounter
      this.pqcSignatureCounterProvenance[pubkey] = provenance
      const index = await this._getIndexForPubkey(pubkey)
      if (this._index2account[index]) {
        this._index2account[index]!.signatureCounter = pqcSignatureCounterSnapshot(
          newCounter,
          provenance,
          this.pqcSignatureCounterChainFloors[pubkey] || 0
        )
      }
    }

    return {
      pubkey,
      previousCounter,
      observedCounter,
      newCounter,
      counterProvenance: this.pqcSignatureCounterProvenance[pubkey] || 'local',
    }
  }

  /**
   * Restore-time safety scan. Raises each active account's signature counter to
   * the floor reported by `observe` (provenance `restored-floor`), then probes
   * `lookahead` indexes beyond the highest active index: activity there is a
   * two-live-wallets hazard signal (another instance of this seed may have
   * signed transactions this install never recorded). Counters are only raised.
   */
  async scanPqcSignatureCounterFloors(
    observe: QbitPqcHistoryObserver,
    options: { lookahead?: number } = {}
  ): Promise<QbitPqcRestoreFloorScan> {
    const lookahead = options.lookahead ?? 20
    if (!Number.isInteger(lookahead) || lookahead < 0) {
      throw new Error('Qbit-Hd-Keyring: lookahead must be a non-negative integer')
    }

    const floors: QbitPqcSignatureCounterFloor[] = []
    const floorSources: QbitRestoreFloorSourceRecord[] = []
    for (const account of await this.getQbitAccounts()) {
      const activity = await observe(account)
      assertSignatureCounterValue(activity.observedSignatures)
      floors.push(
        await this.applyPqcSignatureCounterFloor(
          account.pubkey,
          activity.observedSignatures,
          'restored-floor'
        )
      )
      if (activity.floorSource !== undefined) {
        floorSources.push({
          index: account.index,
          pubkey: account.pubkey,
          source: activity.floorSource,
        })
      }
    }

    const gapIndexesWithActivity: number[] = []
    const highestActive = this.activeIndexes.length > 0 ? Math.max(...this.activeIndexes) : -1
    for (let offset = 1; offset <= lookahead; offset += 1) {
      const index = highestActive + offset
      const account = await this._accountFromIndex(index)
      const activity = await observe(account)
      const active = activity.hasActivity ?? activity.observedSignatures > 0
      if (active) {
        gapIndexesWithActivity.push(index)
        // Latch immediately: an abort later in the probe must not lose an
        // already-observed two-live-wallets hazard (the failure-path persist
        // carries it into the vault).
        this.pqcConcurrentInstanceHint = true
      }
    }

    this.pqcFloorsPending = false

    return {
      floors,
      floorSources,
      gapIndexesWithActivity,
      possibleConcurrentInstance: gapIndexesWithActivity.length > 0,
    }
  }

  async getPqcSignatureCacheEntry(
    pubkeyOrAddress: string,
    cacheKey: string
  ): Promise<QbitPqcSignatureCacheEntry | undefined> {
    assertSignatureCacheKey(cacheKey)
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    const entry = this.pqcSignatureCache[pubkey]?.[cacheKey]
    return entry === undefined ? undefined : { ...entry }
  }

  /** Dry-run ordered cache lookups and insertions without mutating cache state. */
  async estimatePqcSignatureCacheMisses(
    pubkeyOrAddress: string,
    orderedCacheKeys: readonly string[]
  ): Promise<number> {
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    return estimatePqcSignatureCacheMisses(
      Object.keys(this.pqcSignatureCache[pubkey] || {}),
      orderedCacheKeys
    )
  }

  async cachePqcSignature(
    pubkeyOrAddress: string,
    cacheKey: string,
    signatureHex: string,
    counter: number,
    createdAt = Date.now()
  ): Promise<QbitPqcSignatureCacheEntry> {
    assertSignatureCacheKey(cacheKey)
    assertSignatureHex(signatureHex)
    assertSignatureCounterValue(counter)
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    this.pqcSignatureCache[pubkey] = insertPqcSignatureCacheEntry(
      this.pqcSignatureCache[pubkey] || {},
      cacheKey,
      {
        signatureHex: signatureHex.toLowerCase(),
        counter,
        createdAt,
      }
    )
    return { ...this.pqcSignatureCache[pubkey]![cacheKey]! }
  }

  async exportP2mrDescriptors(
    network: QbitNetworkName = 'mainnet'
  ): Promise<QbitP2mrDescriptorExport> {
    const protocol = await loadProtocol()
    const networkParams = protocol.getQbitNetwork(network)
    const coinType: 0 | 1 = network === 'mainnet' ? 0 : 1
    const qbitXpriv = reencodeExtendedPrivateKey(
      this._getMasterXpriv(),
      networkParams.bip32.private
    )

    return {
      network: networkParams.name,
      coinType,
      containsPrivateKeys: true,
      external: buildP2mrDescriptor(protocol, qbitXpriv, coinType, 0),
      internal: buildP2mrDescriptor(protocol, qbitXpriv, coinType, 1),
      hkdf: {
        account: P2MR_DESCRIPTOR_HKDF_ACCOUNT,
        change: P2MR_DESCRIPTOR_HKDF_CHANGE,
      },
      coreProvenance: {
        repository: 'Qbit-Org/qbit',
        commit: '70fea84f5becfb57463247af09790df5ddd424f8',
        source: 'src/wallet/walletutil.cpp',
      },
    }
  }

  getIndexByAddress(address: string) {
    for (const key in this._index2account) {
      const account = this._index2account[key]
      if (!account) continue
      if (account.pubkey === address || Object.values(account.addresses).includes(address)) {
        return Number(key)
      }
    }
    return null
  }

  async exportAccount(pubkey: string) {
    const index = await this._getIndexForPubkey(pubkey)
    const derived = await this._derivePqcKey(index)
    try {
      return bytesToHex(derived.sk64)
    } finally {
      derived.sk64.fill(0)
      derived.pk32.fill(0)
    }
  }

  async signPqcDigest(pubkeyOrAddress: string, digest: Uint8Array): Promise<Uint8Array> {
    if (!(digest instanceof Uint8Array) || digest.length !== 32) {
      throw new Error('Qbit-Hd-Keyring: PQC signing input must be a 32-byte digest')
    }
    const pubkey = await this._getPubkeyForPubkeyOrAddress(pubkeyOrAddress)
    const index = await this._getIndexForPubkey(pubkey)
    const derived = await this._derivePqcKey(index)
    try {
      if (bytesToHex(derived.pk32) !== pubkey) {
        throw new Error('Qbit-Hd-Keyring: derived PQC public key mismatch')
      }
      return signPqc(derived.sk64, new Uint8Array(digest))
    } finally {
      derived.sk64.fill(0)
      derived.pk32.fill(0)
    }
  }

  async signTransaction(): Promise<never> {
    throw new Error('P2MR transaction signing is not wired to qbit P2MR signing preimages yet')
  }

  async signMessage(): Promise<never> {
    throw new Error('P2MR message signing is not wired to qbit P2MR signing preimages yet')
  }

  async verifyMessage(): Promise<boolean> {
    return false
  }

  removeAccount(pubkey: string) {
    const index = this.getIndexByAddress(pubkey)
    if (index === null) {
      throw new Error(`PublicKey ${pubkey} not found in this keyring`)
    }
    const account = this._index2account[index]
    if (account) {
      delete this.pqcSignatureCounters[account.pubkey]
      delete this.pqcSignatureCounterProvenance[account.pubkey]
      delete this.pqcSignatureCounterChainFloors[account.pubkey]
      delete this.pqcSignatureCache[account.pubkey]
    }
    this.activeIndexes = this.activeIndexes.filter(activeIndex => activeIndex !== index)
    delete this._index2account[index]
  }

  private async _accountFromIndex(index: number): Promise<QbitP2mrAccountInfo> {
    assertDescriptorIndex(index)
    if (!this._index2account[index]) {
      const protocol = await loadProtocol()
      const derived = await this._derivePqcKey(index)
      try {
        const pubkey = bytesToHex(derived.pk32)
        const pubkeyBytes = protocol.hexToBytes(pubkey)
        const leafScript = protocol.singleKeyLeafScript(pubkeyBytes)
        const root = protocol.p2mrLeafHash(protocol.P2MR_LEAF_VERSION_V1, leafScript)
        const scriptPubKey = protocol.p2mrScriptPubKey(root)
        const signatureCounter = this.pqcSignatureCounters[pubkey] || 0
        this.pqcSignatureCounters[pubkey] = signatureCounter
        const counterProvenance =
          this.pqcSignatureCounterProvenance[pubkey] ||
          (this.pqcRestoredFromMnemonic ? 'restored-floor' : 'local')
        this.pqcSignatureCounterProvenance[pubkey] = counterProvenance
        const knownOnChainSignatures = this.pqcSignatureCounterChainFloors[pubkey] || 0
        this.pqcSignatureCounterChainFloors[pubkey] = knownOnChainSignatures
        this._index2account[index] = {
          index,
          pubkey,
          path: `${this.hdPath}/${index}`,
          scriptPubKey: protocol.bytesToHex(scriptPubKey),
          leafScript: protocol.bytesToHex(leafScript),
          addresses: {
            mainnet: protocol.p2mrAddressFromPubkey(pubkeyBytes, 'mainnet'),
            testnet4: protocol.p2mrAddressFromPubkey(pubkeyBytes, 'testnet4'),
            signet: protocol.p2mrAddressFromPubkey(pubkeyBytes, 'signet'),
            regtest: protocol.p2mrAddressFromPubkey(pubkeyBytes, 'regtest'),
          },
          hkdf: {
            account: P2MR_DESCRIPTOR_HKDF_ACCOUNT,
            change: P2MR_DESCRIPTOR_HKDF_CHANGE,
            index,
          },
          signatureCounter: pqcSignatureCounterSnapshot(
            signatureCounter,
            counterProvenance,
            knownOnChainSignatures
          ),
        }
      } finally {
        derived.sk64.fill(0)
        derived.pk32.fill(0)
      }
    }

    return this._index2account[index] as QbitP2mrAccountInfo
  }

  private async _derivePqcKey(index: number): Promise<PqcDerivedKey> {
    if (!this.root) {
      throw new Error('Qbit-Hd-Keyring: Secret recovery phrase not provided')
    }
    assertDescriptorIndex(index)
    const child = this.root.deriveChild(index)
    const privateKey = new Uint8Array(child.privateKey)
    try {
      return derivePQCKey(
        privateKey,
        P2MR_DESCRIPTOR_HKDF_ACCOUNT,
        P2MR_DESCRIPTOR_HKDF_CHANGE,
        index
      )
    } finally {
      privateKey.fill(0)
      if (child.privateKey) {
        child.privateKey.fill(0)
      }
    }
  }

  private async _getIndexForPubkey(pubkey: string): Promise<number> {
    for (const index of this.activeIndexes) {
      const account = await this._accountFromIndex(index)
      if (account.pubkey === pubkey) {
        return index
      }
    }
    throw new Error(`PublicKey ${pubkey} not found in this keyring`)
  }

  private async _getPubkeyForPubkeyOrAddress(pubkeyOrAddress: string): Promise<string> {
    if (/^[0-9a-fA-F]{64}$/.test(pubkeyOrAddress)) {
      return (await this._accountFromIndex(await this._getIndexForPubkey(pubkeyOrAddress))).pubkey
    }
    const index = this.getIndexByAddress(pubkeyOrAddress)
    if (index === null) {
      throw new Error(`P2MR account ${pubkeyOrAddress} not found in this keyring`)
    }
    return (await this._accountFromIndex(index)).pubkey
  }

  private _getMasterXpriv(): string {
    const xpriv = this.xpriv || this.hdWallet?.toJSON?.().xpriv || this.hdWallet?.privateExtendedKey
    if (!xpriv) {
      throw new Error('Qbit-Hd-Keyring: Secret recovery phrase not provided')
    }
    return xpriv
  }
}

function buildP2mrDescriptor(
  protocol: ProtocolModule,
  qbitXpriv: string,
  coinType: 0 | 1,
  change: 0 | 1
): QbitP2mrDescriptorInfo {
  const path = `m/${P2MR_DESCRIPTOR_PURPOSE}h/${coinType}h/${P2MR_DESCRIPTOR_ACCOUNT}h/${change}/*`
  const descriptorNoChecksum = `mr(pk(pqc(${qbitXpriv}/${P2MR_DESCRIPTOR_PURPOSE}h/${coinType}h/${P2MR_DESCRIPTOR_ACCOUNT}h/${change}/*)))`
  return {
    branch: change === 0 ? 'external' : 'internal',
    change,
    path,
    descriptorNoChecksum,
    descriptor: protocol.addDescriptorChecksum(descriptorNoChecksum),
  }
}

function reencodeExtendedPrivateKey(xpriv: string, version: number): string {
  const decoded = new Uint8Array(decode(xpriv))
  if (decoded.length !== 78) {
    throw new Error('Qbit-Hd-Keyring: extended private key payload must be 78 bytes')
  }
  const versionBytes = uint32Be(version)
  decoded.set(versionBytes, 0)
  return encode(Buffer.from(decoded))
}

function uint32Be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError('BIP32 version must be a uint32')
  }
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  )
}

function pqcSignatureLimitState(count: number): QbitPqcSignatureLimitState {
  if (count >= PQC_MAX_SIGNATURES) return 'exhausted'
  if (count >= PQC_CRITICAL_SIGNATURE_THRESHOLD) return 'critical'
  if (count >= PQC_WARNING_SIGNATURE_THRESHOLD) return 'warning'
  return 'normal'
}

function pqcSignatureCounterSnapshot(
  count: number,
  provenance: QbitPqcSignatureCounterProvenance,
  knownOnChainSignatures: number
): QbitP2mrAccountInfo['signatureCounter'] {
  assertSignatureCounterValue(count)
  assertSignatureCounterValue(knownOnChainSignatures)
  return {
    count,
    limit: PQC_MAX_SIGNATURES,
    remaining: Math.max(0, PQC_MAX_SIGNATURES - count),
    state: pqcSignatureLimitState(count),
    provenance,
    knownOnChainSignatures,
  }
}

export const QBIT_RECOVERY_NETWORKS = ['mainnet', 'testnet4', 'regtest'] as const

function assertQbitReceiveNetwork(network: string): asserts network is QbitReceiveNetworkName {
  if (network !== 'mainnet' && network !== 'testnet4' && network !== 'regtest') {
    throw new Error(`Qbit-Hd-Keyring: unsupported receive network ${network}`)
  }
}

function qbitRecoveryNetworkCoinType(network: QbitReceiveNetworkName): 0 | 1 {
  return network === 'mainnet' ? 0 : 1
}

function assertQbitRecoveryNetworkMatchesCoinType(
  network: QbitReceiveNetworkName,
  hdPath: string
): void {
  if (qbitRecoveryNetworkCoinType(network) !== qbitHdPathCoinType(hdPath)) {
    throw new Error(
      `Qbit-Hd-Keyring: network ${network} does not match the derivation coin type`
    )
  }
}

function normalizeQbitReceiveState(state: QbitReceiveIntentState): QbitReceiveIntentState {
  const issuedIndexes = normalizeQbitReceiveIndexes(state.issuedIndexes || [])
  const usedIndexes = normalizeQbitReceiveIndexes(state.usedIndexes || [])
  const currentIndex = state.currentIndex === null ? null : state.currentIndex
  if (currentIndex !== null) {
    assertDescriptorIndex(currentIndex)
    if (!issuedIndexes.includes(currentIndex)) {
      issuedIndexes.push(currentIndex)
      issuedIndexes.sort((left, right) => left - right)
    }
  }
  return { currentIndex, issuedIndexes, usedIndexes }
}

function normalizeQbitReceiveStates(
  states: Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>>
): Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>> {
  const normalized: Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>> = {}
  for (const network of ['mainnet', 'testnet4', 'regtest'] as const) {
    const state = states[network]
    if (state) normalized[network] = normalizeQbitReceiveState(state)
  }
  return normalized
}

function cloneQbitReceiveState(state: QbitReceiveIntentState): QbitReceiveIntentState {
  return {
    currentIndex: state.currentIndex,
    issuedIndexes: [...state.issuedIndexes],
    usedIndexes: [...state.usedIndexes],
  }
}

function cloneQbitReceiveStates(
  states: Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>>
): Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>> {
  const cloned: Partial<Record<QbitReceiveNetworkName, QbitReceiveIntentState>> = {}
  for (const network of ['mainnet', 'testnet4', 'regtest'] as const) {
    const state = states[network]
    if (state) cloned[network] = cloneQbitReceiveState(state)
  }
  return cloned
}

function normalizePqcSignatureCounters(counters: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {}
  Object.entries(counters).forEach(([pubkey, count]) => {
    if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
      throw new Error('Qbit-Hd-Keyring: invalid PQC signature counter pubkey')
    }
    assertSignatureCounterValue(count)
    normalized[pubkey.toLowerCase()] = count
  })
  return normalized
}

function normalizePqcSignatureCounterProvenance(
  provenance: Record<string, QbitPqcSignatureCounterProvenance>,
  counters: Record<string, number>
): Record<string, QbitPqcSignatureCounterProvenance> {
  const normalized: Record<string, QbitPqcSignatureCounterProvenance> = {}
  Object.keys(counters).forEach(pubkey => {
    const value = provenance[pubkey] || provenance[pubkey.toUpperCase()]
    normalized[pubkey] = value === 'restored-floor' ? 'restored-floor' : 'local'
  })
  return normalized
}

function normalizePqcSignatureCounterChainFloors(
  floors: Record<string, number>,
  counters: Record<string, number>,
  provenance: Record<string, QbitPqcSignatureCounterProvenance>,
  restoredFromMnemonic: boolean
): Record<string, number> {
  const normalized: Record<string, number> = {}
  Object.entries(counters).forEach(([pubkey, counter]) => {
    const rawFloor = floors[pubkey] ?? floors[pubkey.toUpperCase()]
    if (rawFloor !== undefined) {
      assertSignatureCounterValue(rawFloor)
      normalized[pubkey] = rawFloor
      counters[pubkey] = Math.max(counter, rawFloor)
      return
    }
    // Older vaults did not retain the observed floor separately. A key that
    // still carries restored-floor provenance has not signed since restore in
    // those vaults, so its counter is the best usable chain-floor record.
    // If later signing rewrote provenance to local, use the safe lower bound
    // of zero rather than mislabeling local/off-chain use as on-chain history.
    normalized[pubkey] =
      restoredFromMnemonic && provenance[pubkey] === 'restored-floor' ? counter : 0
  })
  return normalized
}

function defaultQbitRecoveryNetworkState(): QbitRecoveryNetworkVaultState {
  return { status: 'seed-only-restored', addressDiscoveryComplete: false }
}

function defaultQbitRecoveryState(discovered?: {
  network: QbitReceiveNetworkName
  addressDiscoveryComplete: boolean
}): QbitRecoveryVaultState {
  const networks: Partial<Record<QbitReceiveNetworkName, QbitRecoveryNetworkVaultState>> = {}
  for (const network of QBIT_RECOVERY_NETWORKS) {
    networks[network] = defaultQbitRecoveryNetworkState()
  }
  if (discovered) {
    networks[discovered.network]!.addressDiscoveryComplete =
      discovered.addressDiscoveryComplete === true
  }
  return {
    version: 2,
    acknowledgement: 'required',
    networks,
  }
}

/**
 * Upgrade the single-network v1 record into the per-network v2 shape. This
 * upgrade is what rescues wallets stranded by a v1 single-network archive:
 * the networks the v1 lifecycle never touched come back as seed-only
 * restored, so their guided migration can begin.
 */
function upgradeQbitV1RecoveryState(
  state: QbitV1RecoveryVaultState,
  coinType: 0 | 1
): QbitRecoveryVaultState {
  const networks: Partial<Record<QbitReceiveNetworkName, QbitRecoveryNetworkVaultState>> = {}
  const migrationNetwork =
    state.migration &&
    (state.migration.network === 'mainnet' ||
      state.migration.network === 'testnet4' ||
      state.migration.network === 'regtest')
      ? state.migration.network
      : undefined
  if (migrationNetwork !== undefined) {
    // The v1 migration binds the whole version-1 lifecycle to its network.
    networks[migrationNetwork] = {
      status: state.status,
      addressDiscoveryComplete: state.addressDiscoveryComplete === true,
      migration: state.migration,
    }
  } else if (state.migration) {
    // A migration whose network is unrecognizable cannot be filed anywhere;
    // every network falls back to the safe default, matching the v1 rule
    // that reset an invalid migration record.
  } else if (coinType === 0) {
    networks.mainnet = {
      status: state.status,
      addressDiscoveryComplete: state.addressDiscoveryComplete === true,
    }
  } else {
    // Coin type 1 cannot distinguish a testnet4 restore from a regtest one,
    // so the status lands on both siblings while discovery completeness is
    // conservatively reset: discovery is resumable and re-running it is safe,
    // whereas trusting it for the network that was never scanned is not.
    networks.testnet4 = { status: state.status, addressDiscoveryComplete: false }
    networks.regtest = { status: state.status, addressDiscoveryComplete: false }
  }
  return {
    version: 2,
    acknowledgement: state.acknowledgement === 'accepted' ? 'accepted' : 'required',
    networks,
  }
}

function normalizeQbitRecoveryState(
  state: QbitRecoveryVaultState | QbitV1RecoveryVaultState | undefined,
  restoredFromMnemonic: boolean,
  coinType: 0 | 1
): QbitRecoveryVaultState | undefined {
  if (!restoredFromMnemonic) return undefined
  if (!state) return defaultQbitRecoveryState()
  if (state.version === 1) {
    return normalizeQbitRecoveryState(
      upgradeQbitV1RecoveryState(state, coinType),
      restoredFromMnemonic,
      coinType
    )
  }
  if (state.version !== 2) return defaultQbitRecoveryState()
  const networks: Partial<Record<QbitReceiveNetworkName, QbitRecoveryNetworkVaultState>> = {}
  for (const network of QBIT_RECOVERY_NETWORKS) {
    networks[network] = normalizeQbitRecoveryNetworkState(network, state.networks?.[network])
  }
  const acknowledgement = state.acknowledgement === 'accepted' ? 'accepted' : 'required'
  return {
    version: 2,
    acknowledgement,
    // A dismissal without an acceptance has no valid provenance; drop it so
    // the un-acknowledged warning cannot arrive pre-dismissed.
    ...(acknowledgement === 'accepted' && state.warningDismissed === true
      ? { warningDismissed: true as const }
      : {}),
    networks,
  }
}

function normalizeQbitRecoveryNetworkState(
  network: QbitReceiveNetworkName,
  record: QbitRecoveryNetworkVaultState | undefined
): QbitRecoveryNetworkVaultState {
  if (!record) return defaultQbitRecoveryNetworkState()
  const status: QbitRecoveryVaultStatus =
    record.status === 'migrating' || record.status === 'migrated'
      ? record.status
      : 'seed-only-restored'
  const addressDiscoveryComplete = record.addressDiscoveryComplete === true
  if (status === 'seed-only-restored') return { status, addressDiscoveryComplete }

  const migration = record.migration
  if (
    !migration ||
    !Number.isSafeInteger(migration.destinationKeyringIndex) ||
    migration.destinationKeyringIndex < 0 ||
    !isPqcPubkey(migration.destinationPubkey) ||
    typeof migration.destinationAddress !== 'string' ||
    migration.destinationAddress.length === 0 ||
    migration.destinationAddress.length > 200 ||
    // The record's key is authoritative; a migration filed under another
    // network's record is corruption, not a relocation.
    migration.network !== network ||
    !Array.isArray(migration.plans)
  ) {
    return { status: 'seed-only-restored', addressDiscoveryComplete }
  }

  // Degrade per plan instead of resetting the whole record: wiping it would
  // discard signed (possibly broadcast) migration transactions and the
  // completed-discovery flag over one bad entry. A dropped plan forces a
  // migrated wallet back to migrating so completion is re-verified on-chain.
  const plans: QbitRecoveryMigrationPlanVault[] = []
  const planIds = new Set<string>()
  let droppedPlan = false
  for (const rawPlan of migration.plans) {
    let plan: QbitRecoveryMigrationPlanVault
    try {
      plan = normalizeQbitRecoveryMigrationPlan(rawPlan)
    } catch {
      droppedPlan = true
      continue
    }
    if (planIds.has(plan.id)) {
      droppedPlan = true
      continue
    }
    planIds.add(plan.id)
    plans.push(plan)
  }
  const normalizedMigration: QbitRecoveryMigrationVault = {
    destinationKeyringIndex: migration.destinationKeyringIndex,
    destinationPubkey: migration.destinationPubkey.toLowerCase(),
    destinationAddress: migration.destinationAddress,
    network: migration.network,
    plans,
    ...(droppedPlan || migration.planRecordIncomplete === true
      ? { planRecordIncomplete: true as const }
      : {}),
  }
  if (
    status === 'migrated' &&
    (!addressDiscoveryComplete || droppedPlan || plans.some(plan => plan.status !== 'confirmed'))
  ) {
    return {
      status: 'migrating',
      addressDiscoveryComplete,
      migration: normalizedMigration,
    }
  }
  return { status, addressDiscoveryComplete, migration: normalizedMigration }
}

function normalizeQbitRecoveryMigrationPlan(
  plan: QbitRecoveryMigrationPlanVault
): QbitRecoveryMigrationPlanVault {
  if (
    !plan ||
    typeof plan.id !== 'string' ||
    plan.id.length === 0 ||
    plan.id.length > 200 ||
    !isPqcPubkey(plan.sourcePubkey) ||
    typeof plan.sourceAddress !== 'string' ||
    plan.sourceAddress.length === 0 ||
    plan.sourceAddress.length > 200 ||
    typeof plan.destinationAddress !== 'string' ||
    plan.destinationAddress.length === 0 ||
    plan.destinationAddress.length > 200 ||
    !Number.isSafeInteger(plan.amount) ||
    plan.amount <= 0 ||
    !Number.isSafeInteger(plan.fee) ||
    plan.fee < 0 ||
    !isEvenHex(plan.psbtHex) ||
    (plan.sourceIndex !== undefined && !isDescriptorIndex(plan.sourceIndex)) ||
    (plan.destinationIndex !== undefined && !isDescriptorIndex(plan.destinationIndex)) ||
    (plan.destinationPubkey !== undefined && !isPqcPubkey(plan.destinationPubkey))
  ) {
    throw new Error('Qbit-Hd-Keyring: invalid recovery migration plan')
  }
  const status: QbitRecoveryMigrationPlanStatus =
    plan.status === 'signed' || plan.status === 'broadcast' || plan.status === 'confirmed'
      ? plan.status
      : 'prepared'
  if (status !== 'prepared') {
    if (!isEvenHex(plan.signedPsbtHex)) {
      throw new Error('Qbit-Hd-Keyring: signed recovery migration plan is missing')
    }
    if (typeof plan.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(plan.txid)) {
      throw new Error('Qbit-Hd-Keyring: recovery migration transaction id is missing')
    }
  }
  return {
    id: plan.id,
    sourcePubkey: plan.sourcePubkey.toLowerCase(),
    sourceAddress: plan.sourceAddress,
    destinationAddress: plan.destinationAddress,
    amount: plan.amount,
    fee: plan.fee,
    psbtHex: plan.psbtHex.toLowerCase(),
    status,
    ...(plan.signedPsbtHex ? { signedPsbtHex: plan.signedPsbtHex.toLowerCase() } : {}),
    ...(plan.txid ? { txid: plan.txid.toLowerCase() } : {}),
    ...(plan.sourceIndex !== undefined ? { sourceIndex: plan.sourceIndex } : {}),
    ...(plan.destinationIndex !== undefined ? { destinationIndex: plan.destinationIndex } : {}),
    ...(plan.destinationPubkey !== undefined
      ? { destinationPubkey: plan.destinationPubkey.toLowerCase() }
      : {}),
  }
}

function cloneQbitRecoveryState(
  state: QbitRecoveryVaultState | undefined
): QbitRecoveryVaultState | undefined {
  if (!state) return undefined
  const networks: Partial<Record<QbitReceiveNetworkName, QbitRecoveryNetworkVaultState>> = {}
  for (const network of QBIT_RECOVERY_NETWORKS) {
    const record = state.networks[network]
    if (!record) continue
    networks[network] = {
      ...record,
      ...(record.migration
        ? {
            migration: {
              ...record.migration,
              plans: record.migration.plans.map(plan => ({ ...plan })),
            },
          }
        : {}),
    }
  }
  return {
    version: 2,
    acknowledgement: state.acknowledgement,
    ...(state.warningDismissed === true ? { warningDismissed: true as const } : {}),
    networks,
  }
}

function migrationPlanStatusRank(status: QbitRecoveryMigrationPlanStatus): number {
  return ['prepared', 'signed', 'broadcast', 'confirmed'].indexOf(status)
}

function isPqcPubkey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

function isEvenHex(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(value)
  )
}

function normalizePqcSignatureCache(
  cache: Record<string, Record<string, QbitPqcSignatureCacheEntry>>,
  counters: Record<string, number>
): Record<string, Record<string, QbitPqcSignatureCacheEntry>> {
  const normalized: Record<string, Record<string, QbitPqcSignatureCacheEntry>> = {}
  Object.entries(cache).forEach(([pubkey, entries]) => {
    const normalizedPubkey = pubkey.toLowerCase()
    if (!(normalizedPubkey in counters)) return
    const normalizedEntries: Record<string, QbitPqcSignatureCacheEntry> = {}
    Object.entries(entries || {}).forEach(([cacheKey, entry]) => {
      assertSignatureCacheKey(cacheKey)
      assertSignatureHex(entry.signatureHex)
      assertSignatureCounterValue(entry.counter)
      if (!Number.isFinite(entry.createdAt) || entry.createdAt < 0) {
        throw new RangeError('PQC signature cache timestamp must be a non-negative number')
      }
      normalizedEntries[cacheKey] = {
        signatureHex: entry.signatureHex.toLowerCase(),
        counter: entry.counter,
        createdAt: entry.createdAt,
      }
    })
    normalized[normalizedPubkey] = trimPqcSignatureCache(normalizedEntries)
  })
  return normalized
}

function clonePqcSignatureCache(
  cache: Record<string, Record<string, QbitPqcSignatureCacheEntry>>
): Record<string, Record<string, QbitPqcSignatureCacheEntry>> {
  const cloned: Record<string, Record<string, QbitPqcSignatureCacheEntry>> = {}
  Object.entries(cache).forEach(([pubkey, entries]) => {
    cloned[pubkey] = {}
    Object.entries(entries).forEach(([cacheKey, entry]) => {
      cloned[pubkey]![cacheKey] = { ...entry }
    })
  })
  return cloned
}

function trimPqcSignatureCache(
  entries: Record<string, QbitPqcSignatureCacheEntry>
): Record<string, QbitPqcSignatureCacheEntry> {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, a], [, b]) => b.createdAt - a.createdAt)
      .slice(0, PQC_SIGNATURE_CACHE_MAX_PER_KEY)
  )
}

function insertPqcSignatureCacheEntry(
  entries: Record<string, QbitPqcSignatureCacheEntry>,
  cacheKey: string,
  entry: QbitPqcSignatureCacheEntry
): Record<string, QbitPqcSignatureCacheEntry> {
  // Object insertion order is the live newest-to-oldest eviction order.
  return Object.fromEntries(
    [
      [cacheKey, entry] as const,
      ...Object.entries(entries).filter(([existingCacheKey]) => existingCacheKey !== cacheKey),
    ].slice(0, PQC_SIGNATURE_CACHE_MAX_PER_KEY)
  )
}

function estimatePqcSignatureCacheMisses(
  currentCacheKeys: readonly string[],
  orderedCacheKeys: readonly string[]
): number {
  const simulatedCacheKeys = currentCacheKeys.slice(0, PQC_SIGNATURE_CACHE_MAX_PER_KEY)
  let misses = 0

  orderedCacheKeys.forEach(cacheKey => {
    assertSignatureCacheKey(cacheKey)
    if (simulatedCacheKeys.includes(cacheKey)) return

    misses += 1
    simulatedCacheKeys.unshift(cacheKey)
    if (simulatedCacheKeys.length > PQC_SIGNATURE_CACHE_MAX_PER_KEY) {
      simulatedCacheKeys.pop()
    }
  })

  return misses
}

function assertSignatureCounterValue(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > PQC_MAX_SIGNATURES) {
    throw new RangeError('PQC signature counter must be in range 0..2^30')
  }
}

function assertSignatureCounterCanAdvance(pubkey: string, counter: number, count: number): void {
  if (counter > PQC_MAX_SIGNATURES - count) {
    throw new QbitPqcSignatureCounterError(pubkey, counter, count)
  }
}

function assertSignatureCounterAdvance(count: number): void {
  if (!Number.isInteger(count) || count <= 0 || count > PQC_MAX_SIGNATURES) {
    throw new RangeError('PQC signature counter reservation must be in range 1..2^30')
  }
}

function assertSignatureCacheKey(cacheKey: string): void {
  if (!/^[0-9a-f]{64}$/.test(cacheKey)) {
    throw new Error('PQC signature cache key must be a 32-byte lowercase hex string')
  }
}

function assertSignatureHex(signatureHex: string): void {
  if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length % 2 !== 0) {
    throw new Error('PQC signature cache value must be even-length hex')
  }
}

function assertQbitHdPath(path: string): void {
  const segments = path.split('/')
  if (segments.length !== 5 || segments[0] !== 'm') {
    throw new Error('Qbit-Hd-Keyring: hdPath must be m/87h/{coin_type}h/0h/{change}')
  }
  const [purpose, coinType, account, change] = segments.slice(1)
  if (parseHardenedSegment(purpose) !== 87) {
    throw new Error('Qbit-Hd-Keyring: purpose must be 87h')
  }
  const coin = parseHardenedSegment(coinType)
  if (coin !== 0 && coin !== 1) {
    throw new Error('Qbit-Hd-Keyring: coin type must be 0h or 1h')
  }
  if (parseHardenedSegment(account) !== 0) {
    throw new Error('Qbit-Hd-Keyring: account must be 0h')
  }
  const changeIndex = parsePlainSegment(change)
  if (changeIndex !== 0 && changeIndex !== 1) {
    throw new Error('Qbit-Hd-Keyring: change must be 0 or 1')
  }
}

function qbitHdPathCoinType(path: string): 0 | 1 {
  return parseHardenedSegment(path.split('/')[2]) === 0 ? 0 : 1
}

/** Networks whose funds the keys derived under `hdPath` can spend. */
export function qbitReceiveNetworksForHdPath(hdPath: string): QbitReceiveNetworkName[] {
  return QBIT_RECOVERY_NETWORKS.filter(
    network => qbitRecoveryNetworkCoinType(network) === qbitHdPathCoinType(hdPath)
  )
}

function parseHardenedSegment(segment: string | undefined): number {
  if (segment === undefined || !/^([0-9]+)(['h])$/.test(segment)) {
    throw new Error('Qbit-Hd-Keyring: expected hardened hdPath segment')
  }
  return Number.parseInt(segment.slice(0, -1), 10)
}

function parsePlainSegment(segment: string | undefined): number {
  if (segment === undefined || !/^[0-9]+$/.test(segment)) {
    throw new Error('Qbit-Hd-Keyring: expected non-hardened hdPath segment')
  }
  return Number.parseInt(segment, 10)
}

function normalizeIndexes(indexes: number[]): number[] {
  return indexes.map(index => {
    assertDescriptorIndex(index)
    return index
  })
}

function normalizeQbitReceiveIndexes(indexes: readonly number[]): number[] {
  return Array.from(
    new Set(
      indexes.map(index => {
        assertDescriptorIndex(index)
        return index
      })
    )
  ).sort((left, right) => left - right)
}

function isDescriptorIndex(index: unknown): index is number {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= MAX_DESCRIPTOR_INDEX
}

function assertDescriptorIndex(index: number): void {
  if (!isDescriptorIndex(index)) {
    throw new RangeError('P2MR descriptor index must be a non-hardened uint31')
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
