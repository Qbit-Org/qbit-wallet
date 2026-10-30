import { ObservableStore } from '@metamask/obs-store'
import { sha256 } from '@noble/hashes/sha256'
import * as bip39 from 'bip39'
import { EventEmitter } from 'events'

import { transactionCore } from '@qbit/wallet-core'
import { AddressType } from '@qbit/wallet-types'
import {
  PSBT_GLOBAL_UNSIGNED_TX,
  SIGHASH_DEFAULT,
  decodePsbt,
  p2mrSighash,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  validateP2mrSigningPlans,
  type P2mrSigningKey,
  type P2mrSpentOutput,
  type P2mrTransaction,
  type Psbt,
} from '@qbit-oss/protocol'
import {
  ColdWalletKeyring,
  HdKeyring,
  QbitHdKeyring,
  PQC_MAX_SIGNATURES,
  ReadonlyKeyring,
  SimpleKeyring,
  WatchAddressKeyring,
} from './keyrings'
import { EmptyKeyring } from './keyrings/empty-keyring'
import {
  ADDRESS_TYPES,
  DisplayedKeyring,
  Encryptor,
  Keyring,
  KeyringClass,
  KeyringServiceConfig,
  KeyringType,
  MemStoreState,
  ToSignInput,
} from './types'

import {
  BUS_EVENTS,
  BUS_METHODS,
  QBIT_MAX_FEE_RATE,
  QBIT_MAX_STANDARD_TX_WEIGHT,
  QbitRecoveryState,
  QbitSignatureBudgetImpact,
  WalletKeyring,
  qbitWitnessStackLength,
} from '@qbit/wallet-shared'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'
import type {
  QbitPqcHistoryObserver,
  QbitPqcRestoreFloorScan,
  QbitPqcSignatureCounterFloor,
  QbitPqcSignatureCounterProvenance,
  QbitPqcSignatureCounterReservation,
  QbitRecoveryMigrationPlanVault,
  QbitRecoveryNetworkVaultState,
  QbitRecoveryVaultState,
  QbitRecoveryVaultStatus,
  QbitReceiveNetworkName,
} from './keyrings/qbit-hd-keyring'
import { QBIT_RECOVERY_NETWORKS, qbitReceiveNetworksForHdPath } from './keyrings/qbit-hd-keyring'

const KEYRING_SDK_TYPES = {
  SimpleKeyring,
  HdKeyring,
  QbitHdKeyring,
  ColdWalletKeyring,
  ReadonlyKeyring,
  WatchAddressKeyring,
}

/**
 * Simple Mutex Lock for managing concurrent operations
 * Ensures only one operation can proceed at a time
 */
class SimpleMutex {
  private queue: (() => void)[] = []
  private locked: boolean = false

  async lock<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.locked = true
        try {
          const result = await fn()
          resolve(result)
        } catch (error) {
          reject(error)
        } finally {
          this.locked = false
          const next = this.queue.shift()
          if (next) {
            next()
          }
        }
      }

      if (!this.locked) {
        execute()
      } else {
        this.queue.push(execute)
      }
    })
  }

  isLocked(): boolean {
    return this.locked
  }
}

class KeyedMutex {
  private chains = new Map<string, Promise<void>>()

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const next = previous.then(
      () => current,
      () => current
    )
    this.chains.set(key, next)

    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (this.chains.get(key) === next) {
        this.chains.delete(key)
      }
    }
  }
}

class DisplayKeyring {
  accounts: string[] = []
  type = ''
  hdPath = ''
  accountIndexDerivation = false
  qbitRecovery?: QbitRecoveryState

  constructor(keyring: Keyring) {
    this.accounts = keyring.accounts || []
    this.type = keyring.type
    this.hdPath = (keyring as any).hdPath
    this.accountIndexDerivation = (keyring as any).accountIndexDerivation ?? false
  }
}

interface StoreState {
  booted: string
  vault: string | null
  boostValue: string
}

export type QbitPqcSigningInput = Uint8Array | string
export type QbitPqcSignatureBytes = Uint8Array | string

export interface QbitPqcCounteredSignerContext {
  pubkey: string
  cacheKey: string
  digest: Uint8Array
  reservation: QbitPqcSignatureCounterReservation
}

export interface QbitPqcCounteredSignature {
  pubkey: string
  cacheKey: string
  signature: Uint8Array
  cached: boolean
  counter: QbitPqcSignatureCounterReservation | null
}

export interface QbitP2mrPsbtCounteredSigningInput {
  psbt: Psbt
  keys: readonly P2mrSigningKey[]
}

export interface QbitP2mrPsbtCounterResult {
  inputIndex: number
  pubkey: string
  leafHash: string
  hashType: number
  cacheKey: string
  cached: boolean
  counter: QbitPqcSignatureCounterReservation | null
}

export interface QbitP2mrPsbtCounteredSignatureResult {
  psbt: Psbt
  signed: { inputIndex: number; pubkey: Uint8Array }[]
  counterResults: QbitP2mrPsbtCounterResult[]
}

interface QbitRestoredFloorSigningChallenge {
  id: string
  pubkey: string
  cacheKeys: string[]
  knownOnChainSignatures: number
  expiresAt: number
  confirmed: boolean
  allowDuringMigration: boolean
  // Allowed during a migration as a consolidation of a source no plan of
  // which is open, which signing checks again.
  migrationConsolidation?: boolean
  // Present only for resumable operations (a migration plan re-preflighted on
  // every poll); a preflight may reuse an existing challenge only when both
  // sides carry the same scope. One-shot preflights never set it, so two
  // batch entries signing identical content each get their own challenge.
  reuseScope?: string
}

const QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS = 5 * 60 * 1000
const QBIT_RESTORED_FLOOR_CHALLENGE_CAPACITY = 128
const UNLOCK_VAULT_READ_ATTEMPTS = 3

export class QbitRestoredFloorConfirmationError extends Error {
  readonly code = 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED'

  constructor(message = 'Restored-floor signing requires explicit confirmation') {
    super(message)
    this.name = 'QbitRestoredFloorConfirmationError'
  }
}

/**
 * Fired while the corresponding password mutation still holds its mutex, so
 * password-derived side state (e.g. a biometric-wrapped copy of the password)
 * can be invalidated before any concurrent unlock can observe the old value.
 */
export type PasswordLifecycleEvent = 'boot' | 'passwordChanged' | 'reset'

/**
 * KeyringService - Core service for managing multiple keyrings (wallets)
 * Aligned with qbit-extension keyring implementation
 */
export class KeyringService extends EventEmitter {
  private storage: ProxyStorageAdapter = undefined as any
  private logger: any
  private encryptor: Encryptor = undefined as any
  private t: any
  private eventBus: any

  // Core state - aligned with qbit-extension
  public keyringTypes: KeyringClass[] = []
  public store!: ObservableStore<StoreState>
  public memStore: ObservableStore<MemStoreState> = undefined as any
  public keyrings: Keyring[] = []
  public addressTypes: AddressType[] = []
  public password: string | null = null
  private unlockingMutex: SimpleMutex = new SimpleMutex()
  private pendingLockRequests: number = 0
  private passwordChangeMutex: SimpleMutex = new SimpleMutex()
  private persistenceMutex: SimpleMutex = new SimpleMutex()
  private storePersistenceMutex: SimpleMutex = new SimpleMutex()
  private pqcSignatureCounterMutex: KeyedMutex = new KeyedMutex()
  private qbitReceiveIntentMutex: SimpleMutex = new SimpleMutex()
  private qbitRecoveryMutex: SimpleMutex = new SimpleMutex()
  private qbitRestoredFloorSigningChallenges = new Map<string, QbitRestoredFloorSigningChallenge>()
  private cachedDisplayedKeyring: DisplayedKeyring[] | null = null
  private cachedDisplayedKeyringNetwork: QbitReceiveNetworkName | undefined = undefined
  private activeQbitNetworkResolver?: () => string | undefined
  private passwordLifecycleHook?: (event: PasswordLifecycleEvent) => Promise<void> | void
  private initialBoostValue: string = 'true'
  private storageKey: string = 'keyringState'
  private cachedKey: string = 'cached_pubkeys'
  private readonly MAX_CACHE_ITEMS: number = 20

  constructor() {
    super()
  }

  private persistStoreState = (state: StoreState): Promise<void> => {
    const snapshot = { ...state }
    return this.storePersistenceMutex.lock(() => this.storage.set(this.storageKey, snapshot))
  }

  /**
   * Generate a secure boost value for password verification
   * Uses a combination of timestamp and random string for better security
   */
  private generateSecureBoostValue(): string {
    const timestamp = Date.now().toString()
    const random = Math.random().toString(36).substring(2, 15)
    return `secure_${timestamp}_${random}`
  }

  /**
   * Upgrade boost value from initial 'true' to a more secure value
   * This enhances security by replacing the simple initial value
   */
  private upgradeBoostValueIfNeeded = async (): Promise<boolean> => {
    if (!this.password) {
      throw new Error(this.t('password_not_set'))
    }

    const boostValue = this.getBoostValue()
    // Only upgrade if still using the initial simple value
    if (boostValue === this.initialBoostValue || boostValue === 'true') {
      try {
        // Generate new secure boost value
        const newBoostValue = this.generateSecureBoostValue()

        // Re-encrypt with the new boost value
        const upgradedEncryptBooted = await this.encryptor.encrypt(this.password, newBoostValue)

        // Persist the upgraded value
        this.store.updateState({ booted: upgradedEncryptBooted, boostValue: newBoostValue })

        this.logger.info('[KeyringService] Boost value upgraded to secure version')
        return true
      } catch (error) {
        this.logger.error('[KeyringService] Failed to upgrade boost value:', error)
        // Fallback: keep using the old value if upgrade fails
        throw new Error(this.t('boost_value_upgrade_failed'))
      }
    }

    return false
  }

  /**
   * Atomically update earlier encrypted fields after their password and vault
   * contents have been validated. The whole store object is persisted before
   * the in-memory store is updated, so a failed write leaves the prior state
   * available for a safe retry.
   */
  private upgradeVaultEncryptionIfNeeded = async (): Promise<boolean> => {
    if (
      !this.password ||
      !this.encryptor.isVaultUpdated ||
      !this.encryptor.updateVault
    ) {
      return false
    }

    const currentState = this.store.getState()
    const nextState = { ...currentState }
    let changed = false
    for (const field of ['booted', 'vault'] as const) {
      const encryptedValue = currentState[field]
      if (
        typeof encryptedValue === 'string' &&
        encryptedValue.length > 0 &&
        !this.encryptor.isVaultUpdated(encryptedValue)
      ) {
        nextState[field] = await this.encryptor.updateVault(encryptedValue, this.password)
        changed = true
      }
    }
    if (!changed) return false

    await this.persistStoreState(nextState)
    this.store.updateState(nextState)
    this.logger.info('[KeyringService] Vault encryption upgraded')
    return true
  }

  /**
   * Initialize the service - must be called before use
   */
  async init(config: KeyringServiceConfig): Promise<void> {
    if (config.storage) {
      this.storage = config.storage
    }

    if (config.logger) {
      this.logger = config.logger
    }

    if (config.t) {
      this.t = config.t
    }

    if (config.eventBus) {
      this.eventBus = config.eventBus
    }

    if (config.encryptor) {
      this.encryptor = config.encryptor
    }

    if (config.boostValue) {
      this.initialBoostValue = config.boostValue
    }

    // Initialize supported keyring types
    this.keyringTypes = Object.values(KEYRING_SDK_TYPES) as KeyringClass[]

    // Initialize memory store - aligned with qbit-extension
    this.memStore = new ObservableStore<MemStoreState>({
      isUnlocked: false,
      keyringTypes: this.keyringTypes.map(krt => krt.type || krt.name),
      keyrings: [],
      preMnemonics: '',
      addressTypes: [],
    })

    this.keyrings = []
    this.addressTypes = []
    this.cachedDisplayedKeyring = null
    this.qbitRestoredFloorSigningChallenges.clear()
    this.password = null

    this.logger.debug('[KeyringService] Initialized')

    const keyringState = await this.storage.get(this.storageKey)
    this.loadStore(keyringState)
    this.store.subscribe(value => {
      this.persistStoreState(value).catch(error => {
        this.logger?.error?.(
          '[KeyringService] Failed to persist keyring state subscriber update',
          error
        )
      })
    })
  }

  // reset total keyrings
  resetAllData = async () => {
    // Clear persistent storage
    await this.persistStoreState({
      booted: '',
      vault: null,
      boostValue: this.initialBoostValue,
    })

    await this.storage.set(this.cachedKey, null)

    // Reset stores
    this.store.updateState({
      booted: '',
      boostValue: this.initialBoostValue,
      vault: null,
    })

    this.memStore.updateState({
      isUnlocked: false,
      keyrings: [],
      preMnemonics: '',
      addressTypes: [],
    })

    this.keyrings = []
    this.addressTypes = []
    this.cachedDisplayedKeyring = null
    this.qbitRestoredFloorSigningChallenges.clear()
    this.password = null

    await this.runPasswordLifecycleHook('reset')
  }

  loadStore = (initState: StoreState) => {
    this.store = new ObservableStore(initState)
  }

  boot = async (password: string) => {
    // Booting over an existing vault would replace the password verifier while
    // the vault stays encrypted under the old password; require a wipe first.
    if (this.hasVault()) {
      throw new Error(this.t('wallet_already_initialized'))
    }
    this.password = password
    const boostValue = this.generateSecureBoostValue()
    const encryptBooted = await this.encryptor.encrypt(password, boostValue)

    // Update both in-memory and persistent storage
    this.store.updateState({ booted: encryptBooted, boostValue })
    this.memStore.updateState({ isUnlocked: true })

    // A blob wrapped under a previous wallet's password is stale once a new
    // password verifier exists.
    await this.runPasswordLifecycleHook('boot')

    // Upgrade boost value on first boot (when initial value is still 'true')
    await this.upgradeBoostValueIfNeeded()

    this.setUnlocked()
    this.fullUpdate()
  }

  isBooted = () => {
    return !!this.store.getState().booted
  }

  hasVault = () => {
    return !!this.store.getState().vault
  }

  /**
   * Get current memory store state
   */
  getMemStore(): MemStoreState {
    return this.memStore.getState()
  }

  /**
   * Full Update
   *
   * Emits the `update` event and @returns a Promise that resolves to
   * the current state.
   *
   * Frequently used to end asynchronous chains in this class,
   * indicating consumers can often either listen for updates,
   * or accept a state-resolving promise to consume their results.
   *
   * @returns {Object} The controller state.
   */
  fullUpdate = (): MemStoreState => {
    this.emit('update', this.memStore.getState())
    return this.memStore.getState()
  }

  /**
   * Import Keychain using Private key
   *
   * @emits KeyringController#unlock
   * @param  privateKey - The privateKey to generate address
   * @returns  A Promise that resolves to the state.
   */
  importPrivateKey = async (privateKey: string, addressType: AddressType) => {
    // await this.persistAllKeyrings();
    const keyring = await this.addNewKeyring('Simple Key Pair', [privateKey], addressType)
    // await this.persistAllKeyrings();
    this.setUnlocked()
    this.fullUpdate()
    return keyring
  }

  importPublicKeyOnly = async (pubkey: string, addressType: AddressType) => {
    // await this.persistAllKeyrings()
    const keyring = await this.addNewKeyring('Readonly', [pubkey], addressType)
    // await this.persistAllKeyrings()
    this.setUnlocked()
    this.fullUpdate()
    return keyring
  }

  importWatchAddress = async (address: string, addressType: AddressType) => {
    const keyring = await this.addNewKeyring('Watch Address', [address], addressType)
    this.setUnlocked()
    this.fullUpdate()
    return keyring
  }

  generateMnemonic = (strength: 128 | 256 = 128): string => {
    return bip39.generateMnemonic(strength)
  }

  generatePreMnemonic = async (strength: 128 | 256 = 128): Promise<string> => {
    return this.passwordChangeMutex.lock(async () => {
      if (!this.password) {
        throw new Error(this.t('you_need_to_unlock_wallet_first'))
      }
      const mnemonic = this.generateMnemonic(strength)

      const preMnemonics = await this.encryptor.encrypt(this.password, mnemonic)
      this.memStore.updateState({ preMnemonics })
      return mnemonic
    })
  }

  getKeyringByType = (type: string) => {
    const keyring = this.keyrings.find(keyring => keyring.type === type)

    return keyring
  }

  removePreMnemonics = () => {
    this.memStore.updateState({ preMnemonics: '' })
  }

  getPreMnemonics = async (): Promise<any> => {
    if (!this.memStore.getState().preMnemonics) {
      return ''
    }

    if (!this.password) {
      throw new Error(this.t('you_need_to_unlock_wallet_first'))
    }

    return await this.encryptor.decrypt(this.password, this.memStore.getState().preMnemonics)
  }

  /**
   * CreateNewVaultAndRestore Mnenoic
   *
   * Destroys any old encrypted storage,
   * creates a new HD wallet from the given seed with 1 account.
   *
   * @emits KeyringController#unlock
   * @param  seed - The BIP44-compliant seed phrase.
   * @returns  A Promise that resolves to the state.
   */
  createKeyringWithMnemonics = async (
    seed: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    accountCount: number,
    accountIndexDerivation = false,
    options?: { pqcFloorsPending?: boolean }
  ) => {
    if (accountCount < 1) {
      throw new Error(this.t('keyring_error_account_count'))
    }
    if (!bip39.validateMnemonic(seed)) {
      return Promise.reject(new Error(this.t('mnemonic_phrase_is_invalid')))
    }

    // await this.persistAllKeyrings();
    const activeIndexes: number[] = []
    for (let i = 0; i < accountCount; i++) {
      activeIndexes.push(i)
    }

    const keyring = await this.addNewKeyring(
      addressType === AddressType.P2MR ? KeyringType.QbitHdKeyring : KeyringType.HdKeyring,
      {
        mnemonic: seed,
        activeIndexes,
        hdPath,
        passphrase,
        accountIndexDerivation,
        pqcFloorsPending: addressType === AddressType.P2MR && options?.pqcFloorsPending === true,
      },
      addressType
    )
    const accounts = await keyring.getAccounts()
    if (!accounts[0]) {
      throw new Error(this.t('first_account_not_found'))
    }
    // this.persistAllKeyrings();
    this.setUnlocked()
    this.fullUpdate()
    return keyring
  }

  addDiscoveredQbitKeyring = async (
    keyring: Keyring,
    accountCount: number,
    addressDiscoveryComplete = false,
    network?: QbitReceiveNetworkName
  ): Promise<Keyring> => {
    if (
      keyring.type !== KeyringType.QbitHdKeyring ||
      !keyring.prepareForMnemonicRestore ||
      !Number.isInteger(accountCount) ||
      accountCount < 1 ||
      typeof addressDiscoveryComplete !== 'boolean'
    ) {
      throw new Error(this.t('not_supported'))
    }

    const serializedKeyring = await keyring.serialize()
    if (
      typeof serializedKeyring?.mnemonic !== 'string' ||
      !bip39.validateMnemonic(serializedKeyring.mnemonic)
    ) {
      throw new Error(this.t('mnemonic_phrase_is_invalid'))
    }

    const activeIndexes = Array.from({ length: accountCount }, (_value, index) => index)
    keyring.prepareForMnemonicRestore(activeIndexes, addressDiscoveryComplete, network)
    if (keyring.pqcFloorsPending !== true) {
      throw new Error('Qbit restore signing gate was not armed')
    }

    const addedKeyring = await this.addKeyring(keyring, AddressType.P2MR)
    this.setUnlocked()
    this.fullUpdate()
    return addedKeyring
  }

  createQbitMigrationKeyring = async ({
    sourceAddress,
    mnemonic,
    hdPath,
    passphrase,
    network,
  }: {
    sourceAddress: string
    mnemonic: string
    hdPath: string
    passphrase: string
    network: 'mainnet' | 'testnet4' | 'regtest'
  }): Promise<{
    destinationKeyringIndex: number
    destinationPubkey: string
    destinationAddress: string
  }> =>
    // The recovery snapshot and failure rollback below must not straddle a
    // password commit, or a defeated rollback would restore an old-password
    // vault beside the new-password verifier. Lock order:
    // passwordChangeMutex → qbitRecoveryMutex → pqcSignatureCounterMutex.
    this.passwordChangeMutex.lock(() => this.qbitRecoveryMutex.lock(async () => {
      if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error(this.t('mnemonic_phrase_is_invalid'))
      }
      const generatedMnemonic = await this.getPreMnemonics()
      if (!generatedMnemonic || generatedMnemonic !== mnemonic) {
        throw new Error('Qbit recovery migration requires a newly generated wallet seed')
      }
      const source = await this.getKeyringForAccount(sourceAddress, KeyringType.QbitHdKeyring)
      const sourceState = source.getQbitRecoveryState?.() as QbitRecoveryVaultState | undefined
      if (sourceState?.networks?.[network]?.status !== 'seed-only-restored') {
        throw new Error('Qbit recovery migration is already active or unavailable')
      }
      if (!source.beginQbitRecoveryMigration || !source.restoreQbitRecoveryState) {
        throw new Error(this.t('not_supported'))
      }

      const destination = new QbitHdKeyring({
        mnemonic,
        activeIndexes: [0],
        hdPath,
        passphrase,
      })
      const destinationAccounts = await destination.getAccounts()
      await this.checkForDuplicate(KeyringType.QbitHdKeyring, destinationAccounts)
      const destinationAccount = (await destination.getQbitAccounts())[0]
      const destinationPubkey = destinationAccount?.pubkey
      const destinationAddress = destinationAccount?.addresses[network]
      if (!destinationPubkey || !destinationAddress) {
        throw new Error('Fresh Qbit migration wallet has no destination account')
      }

      const sourcePubkeys = await source.getAccounts()
      return this.lockPqcSignatureCounterPubkeys(sourcePubkeys, async () => {
        this.assertLiveKeyrings([source])
        const lockedSourceState = source.getQbitRecoveryState?.() as
          | QbitRecoveryVaultState
          | undefined
        if (lockedSourceState?.networks?.[network]?.status !== 'seed-only-restored') {
          throw new Error('Qbit recovery migration is already active or unavailable')
        }

        const destinationKeyringIndex = this.keyrings.length
        source.beginQbitRecoveryMigration!(network, {
          destinationKeyringIndex,
          destinationPubkey,
          destinationAddress,
          network,
        })
        this.qbitRestoredFloorSigningChallenges.clear()
        this.keyrings.push(destination)
        this.addressTypes.push(AddressType.P2MR)
        this.cachedDisplayedKeyring = null

        let persisted = false
        try {
          await this.persistAllKeyrings([source, destination])
          persisted = true
          this.removePreMnemonics()
          await this._updateMemStoreKeyrings()
          this.fullUpdate()
        } catch (error) {
          if (!persisted) {
            // A lock during the write replaced the live keyrings; never pop
            // a keyring of the session unlocked since.
            const pushedIndex = this.keyrings.indexOf(destination)
            if (pushedIndex !== -1) {
              this.keyrings.splice(pushedIndex, 1)
              this.addressTypes.splice(pushedIndex, 1)
            }
            source.restoreQbitRecoveryState!(lockedSourceState)
            this.cachedDisplayedKeyring = null
            try {
              // Re-persist the restored live state instead of rewinding to the
              // pre-operation vault snapshot: counter persists from other
              // keyrings may have advanced the vault since the snapshot, and a
              // snapshot restore would durably rewind them (signature reuse).
              await this.persistAllKeyrings([source])
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to persist migration-keyring rollback',
                rollbackError
              )
            }
            try {
              await this._updateMemStoreKeyrings()
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to refresh migration-keyring rollback',
                rollbackError
              )
            }
          }
          throw error
        }

        return {
          destinationKeyringIndex,
          destinationPubkey,
          destinationAddress,
        }
      })
    }))

  /**
   * Begin a recovery migration for a network whose destination wallet already
   * exists — the fresh keyring a prior network's migration created. The caller
   * resolves that keyring by its recorded anchor identity (re-deriving under
   * the recorded network's coin type when needed) and passes the destination's
   * anchor identity under the network now migrating; this method re-verifies
   * both the identity and the destination's health before recording anything.
   */
  beginQbitRecoveryMigrationToExistingDestination = async ({
    sourceAddress,
    network,
    destinationPubkey,
    destinationAddress,
  }: {
    sourceAddress: string
    network: 'mainnet' | 'testnet4' | 'regtest'
    destinationPubkey: string
    destinationAddress: string
  }): Promise<{
    destinationKeyringIndex: number
    destinationPubkey: string
    destinationAddress: string
  }> =>
    // Same rationale and lock order as createQbitMigrationKeyring:
    // passwordChangeMutex → qbitRecoveryMutex → pqcSignatureCounterMutex.
    this.passwordChangeMutex.lock(() => this.qbitRecoveryMutex.lock(async () => {
      const source = await this.getKeyringForAccount(sourceAddress, KeyringType.QbitHdKeyring)
      const sourceState = source.getQbitRecoveryState?.() as QbitRecoveryVaultState | undefined
      if (sourceState?.networks?.[network]?.status !== 'seed-only-restored') {
        throw new Error('Qbit recovery migration is already active or unavailable')
      }
      if (!source.beginQbitRecoveryMigration || !source.restoreQbitRecoveryState) {
        throw new Error(this.t('not_supported'))
      }

      const destinationKeyringIndex = await this.findQbitKeyringIndex(
        destinationPubkey,
        destinationAddress
      )
      const destination =
        destinationKeyringIndex === undefined
          ? undefined
          : this.keyrings[destinationKeyringIndex]
      if (
        destinationKeyringIndex === undefined ||
        !destination ||
        destination === source ||
        destination.type !== KeyringType.QbitHdKeyring ||
        // The reused destination must be the healthy fresh wallet a prior
        // migration created — never another restored keyring with its own
        // recovery lifecycle, and never a sign-locked wallet.
        destination.pqcRestoredFromMnemonic === true ||
        destination.pqcFloorsPending === true ||
        destination.getQbitRecoveryState?.() !== undefined ||
        !destination.getQbitReceiveAccount
      ) {
        throw new Error('Qbit recovery migration destination is unavailable')
      }
      // The recorded identity must be the destination's index-0 account as
      // derived right now: anchor identity, not merely some matching account.
      const anchorAccount = await destination.getQbitReceiveAccount(0)
      if (
        anchorAccount?.pubkey?.toLowerCase() !== destinationPubkey.toLowerCase() ||
        anchorAccount?.addresses?.[network] !== destinationAddress
      ) {
        throw new Error('Qbit recovery migration destination is unavailable')
      }
      const anchorPubkey = anchorAccount.pubkey.toLowerCase()

      const sourcePubkeys = await source.getAccounts()
      return this.lockPqcSignatureCounterPubkeys(sourcePubkeys, async () => {
        this.assertLiveKeyrings([source])
        const lockedSourceState = source.getQbitRecoveryState?.() as
          | QbitRecoveryVaultState
          | undefined
        if (lockedSourceState?.networks?.[network]?.status !== 'seed-only-restored') {
          throw new Error('Qbit recovery migration is already active or unavailable')
        }

        source.beginQbitRecoveryMigration!(network, {
          destinationKeyringIndex,
          destinationPubkey: anchorPubkey,
          destinationAddress,
          network,
        })
        this.qbitRestoredFloorSigningChallenges.clear()
        this.cachedDisplayedKeyring = null

        let persisted = false
        try {
          await this.persistAllKeyrings([source])
          persisted = true
          await this._updateMemStoreKeyrings()
          this.fullUpdate()
        } catch (error) {
          if (!persisted) {
            source.restoreQbitRecoveryState!(lockedSourceState)
            this.cachedDisplayedKeyring = null
            try {
              // Re-persist the restored live state instead of rewinding to the
              // pre-operation vault snapshot: counter persists from other
              // keyrings may have advanced the vault since the snapshot, and a
              // snapshot restore would durably rewind them (signature reuse).
              await this.persistAllKeyrings([source])
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to persist migration-begin rollback',
                rollbackError
              )
            }
            try {
              await this._updateMemStoreKeyrings()
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to refresh migration-begin rollback',
                rollbackError
              )
            }
          }
          throw error
        }

        return {
          destinationKeyringIndex,
          destinationPubkey: anchorPubkey,
          destinationAddress,
        }
      })
    }))

  addKeyring = async (keyring: Keyring, addressType: AddressType) =>
    // A password change re-encrypts the live keyrings, so it must not commit
    // this mutation while its write or failure rollback is still pending.
    this.passwordChangeMutex.lock(async () => {
      if (keyring.type === KeyringType.ColdWalletKeyring) {
        // Defense in depth for D5/#23: no hardware/cold signer supports qbit's
        // SLH-DSA signatures, so new cold-wallet keyrings cannot be added. The
        // class stays registered so persisted vault decoding remains fail-safe.
        throw new Error(this.t('hardware_wallet_not_supported'))
      }
      const accounts = await keyring.getAccounts()
      await this.checkForDuplicate(keyring.type, accounts)

      const keyrings = this.keyrings
      keyrings.push(keyring)
      this.addressTypes.push(addressType)
      this.cachedDisplayedKeyring = null

      try {
        await this.persistAllKeyrings([keyring])
      } catch (error) {
        const keyringIndex = this.keyrings.indexOf(keyring)
        if (keyringIndex !== -1) {
          this.keyrings.splice(keyringIndex, 1)
          this.addressTypes.splice(keyringIndex, 1)
        }
        await this.persistMutationRollback('keyring-addition', keyrings)
        throw error
      }

      await this._updateMemStoreKeyrings()
      await this.fullUpdate()

      return keyring
    })

  changeAddressType = async (keyringIndex: number, addressType: AddressType) => {
    let lockRequired = false
    const result = this.passwordChangeMutex.lock(async () => {
      const keyrings = this.keyrings
      const keyring = keyrings[keyringIndex] as Keyring | undefined
      if (!keyring) {
        throw new Error(this.t('no_keyring_found_for_the_requested_account'))
      }
      if (addressType === AddressType.P2MR && keyring.type !== KeyringType.QbitHdKeyring) {
        throw new Error(this.t('not_supported'))
      }
      if (keyring.type === KeyringType.QbitHdKeyring && addressType !== AddressType.P2MR) {
        throw new Error(this.t('not_supported'))
      }

      const previousHdPath =
        keyring.type === KeyringType.HdKeyring ? ((keyring as any).hdPath as string) : undefined
      const hdPath =
        previousHdPath === undefined
          ? undefined
          : ADDRESS_TYPES.find(v => v.value === addressType)?.hdPath
      const changesHdPath =
        previousHdPath !== undefined && previousHdPath !== hdPath && !!keyring.changeHdPath
      const previousAddressType = this.addressTypes[keyringIndex]!
      // A failed HD-path restore leaves the live keyring unusable. Rebuild a
      // copy from its pre-change serialization now, so the rollback can swap
      // it in without an await that would let a queued vault write commit the
      // broken keyring. An HdKeyring keeps no PQC counter state, and its
      // accounts change only under passwordChangeMutex, so the copy stays
      // current.
      const rollbackKeyring = !changesHdPath
        ? null
        : (
            await this._restoreKeyring({
              type: keyring.type,
              data: structuredClone(await keyring.serialize()),
              addressType: previousAddressType,
            })
          ).keyring
      // A lock while the copy was built replaced the live keyrings.
      if (this.keyrings !== keyrings) {
        throw new Error(this.t('you_need_to_unlock_wallet_first'))
      }

      try {
        if (changesHdPath) {
          keyring.changeHdPath!(hdPath || '')
        }
        this.addressTypes[keyringIndex] = addressType
        this.cachedDisplayedKeyring = null

        await this.persistAllKeyrings([keyring])
      } catch (error) {
        let hdPathRestored = true
        if (changesHdPath && (keyring as any).hdPath !== previousHdPath) {
          try {
            keyring.changeHdPath!(previousHdPath!)
          } catch (rollbackError) {
            hdPathRestored = false
            this.logger?.error?.(
              '[KeyringService] Failed to restore address-type HD path',
              rollbackError
            )
          }
        }

        // A lock during the write discarded these keyrings, including a
        // broken one; the rollback must not touch a session unlocked since.
        if (!hdPathRestored && this.keyrings === keyrings) {
          // The live keyring no longer matches any durable state, so the
          // wallet must fail closed. First swap in the rebuilt copy and
          // re-persist the live keyrings: the vault then undoes only this
          // change and keeps every PQC counter persisted since it started.
          if (rollbackKeyring) {
            this.keyrings[keyringIndex] = rollbackKeyring
            this.addressTypes[keyringIndex] = previousAddressType
            this.cachedDisplayedKeyring = null
            try {
              await this.persistAllKeyrings([rollbackKeyring])
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to persist address-type rollback',
                rollbackError
              )
            }
          }

          // Clearing the live secrets here keeps queued vault operations
          // fail-safe, but the published lock runs through setLocked() after
          // this mutex section releases: unlockingMutex is always taken
          // before passwordChangeMutex (changePassword), so acquiring it here
          // would deadlock. A lock during the rollback write already cleared
          // this session.
          if (this.keyrings === keyrings) {
            this.keyrings = []
            this.addressTypes = []
            this.cachedDisplayedKeyring = null
            this.password = null
            lockRequired = true

            try {
              this.memStore.updateState({ isUnlocked: false })
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to refresh address-type rollback',
                rollbackError
              )
            }
          }
          throw error
        }

        if (this.keyrings === keyrings) {
          this.addressTypes[keyringIndex] = previousAddressType
        }
        await this.persistMutationRollback('address-type', keyrings)
        throw error
      }

      await this._updateMemStoreKeyrings()
      await this.fullUpdate()
      return keyring
    })

    try {
      return await result
    } catch (error) {
      if (lockRequired) {
        // Serialize the fail-closed lockdown with submitPassword/setLocked on
        // unlockingMutex so a concurrent unlock cannot publish an unlocked
        // state around the cleared keyrings.
        try {
          await this.setLocked()
        } catch (lockError) {
          this.logger?.error?.(
            '[KeyringService] Failed to lock after address-type rollback failure',
            lockError
          )
        }
      }
      throw error
    }
  }

  syncQbitHdPath = async (hdPath: string): Promise<boolean> =>
    // A password change re-encrypts the live keyrings, so it must not commit
    // this mutation while its write or failure rollback is still pending.
    this.passwordChangeMutex.lock(async () => {
      const keyrings = this.keyrings
      const pathChanges = keyrings
        .filter(
          keyring =>
            keyring.type === KeyringType.QbitHdKeyring && (keyring as any).hdPath !== hdPath
        )
        .map(keyring => ({ keyring, previousHdPath: (keyring as any).hdPath as string }))

      if (pathChanges.length === 0) {
        return false
      }

      for (const { keyring } of pathChanges) {
        if (!keyring.changeHdPath) {
          throw new Error(this.t('not_supported'))
        }
      }

      try {
        for (const { keyring } of pathChanges) {
          keyring.changeHdPath!(hdPath)
        }

        this.cachedDisplayedKeyring = null
        await this.storage.set(this.cachedKey, null)
        await this.persistAllKeyrings(pathChanges.map(({ keyring }) => keyring))
        await this._updateMemStoreKeyrings()
        this.fullUpdate()
        return true
      } catch (error) {
        for (const { keyring, previousHdPath } of pathChanges) {
          try {
            keyring.changeHdPath!(previousHdPath)
          } catch (rollbackError) {
            this.logger?.error?.('[KeyringService] Failed to restore Qbit HD path', rollbackError)
          }
        }
        // A Qbit keyring serializes its HD path and counters, never derived
        // keys, so a keyring whose path could not be restored still persists
        // one path together with every counter. The next sync retries it.
        await this.persistMutationRollback('Qbit HD-path', keyrings)
        throw error
      }
    })

  /**
   * Set Locked
   * This method deallocates all secrets, and effectively locks MetaMask.
   *
   * @emits KeyringController#lock
   * @returns {Promise<Object>} A Promise that resolves to the state.
   */
  setLocked = async (): Promise<MemStoreState> => {
    this.pendingLockRequests += 1
    try {
      this.memStore.updateState({ isUnlocked: false })

      const state = await this.unlockingMutex.lock(async () => {
        // set locked
        this.password = null

        // remove keyrings
        this.keyrings = []
        this.addressTypes = []
        this.cachedDisplayedKeyring = null
        this.qbitRestoredFloorSigningChallenges.clear()

        await this._updateMemStoreKeyrings()
        this.emit('lock')
        return this.fullUpdate()
      })
      return state
    } finally {
      this.pendingLockRequests -= 1
    }
  }

  /**
   * Submit Password
   *
   * Attempts to decrypt the current vault and load its keyrings
   * into memory. On an already-unlocked wallet it only verifies the
   * password and republishes the unlocked state.
   *
   * Temporarily also migrates any old-style vaults first, as well.
   * (Pre MetaMask 3.0.0)
   *
   * @emits KeyringController#unlock
   * @param {string} password - The keyring controller password.
   * @param {object} options - Optional work to finish before publishing the unlocked state.
   * @returns {Promise<Object>} A Promise that resolves to the state.
   */
  submitPassword = async (
    password: string,
    options: { beforeUnlock?: () => void | Promise<void> } = {}
  ): Promise<MemStoreState> => {
    return this.unlockingMutex.lock(async () => {
      const isValidPassword = await this.verifyPassword(password)
      if (!isValidPassword) {
        throw new Error(this.t('password_error'))
      }

      // Under unlockingMutex the password is the authoritative unlocked
      // signal (see changePassword). A second unlock from another surface's
      // lock screen or biometric prompt must not reload: in-flight operations
      // write through the live keyrings, and the pre-unlock work already ran
      // for this session. An unlocked wallet without live keyrings still
      // reloads, so its next write cannot commit an empty vault.
      if (this.password !== null && (this.keyrings.length > 0 || !this.hasVault())) {
        this.setUnlocked()
        return this.fullUpdate()
      }

      try {
        // Read the vault, publish its keyrings and the password, and run the
        // encryption upgrades as one vault transaction. A write that passed
        // its password check before a lock commits before the vault is read,
        // and one queued behind this section serializes the whole vault
        // instead of an empty or partial keyring list.
        await this.persistenceMutex.lock(async () => {
          if (this.hasVault()) {
            await this.loadVaultKeyrings(password)
          }
          this.password = password

          // Upgrade boost value if needed (on first unlock after initialization)
          await this.upgradeBoostValueIfNeeded()
          await this.upgradeVaultEncryptionIfNeeded()
        })
        await this._updateMemStoreKeyrings()

        this.cachedDisplayedKeyring = null

        await options.beforeUnlock?.()
      } catch (error) {
        this.password = null
        this.keyrings = []
        this.addressTypes = []
        this.cachedDisplayedKeyring = null
        this.qbitRestoredFloorSigningChallenges.clear()
        this.memStore.updateState({ isUnlocked: false, keyrings: [] })
        throw error
      }

      // A reset or a fail-closed lockdown during the pre-unlock work cleared
      // this session; publishing it would mark a wiped wallet as unlocked.
      if (this.password === password) {
        this.setUnlocked()
      }
      return this.fullUpdate()
    })
  }

  changePassword = async (oldPassword: string, newPassword: string) => {
    const performPasswordChange = async () => {
      // An empty password encrypts and persists cleanly, but can never unlock
      // again: submitPassword treats an empty stored password as unset and the
      // unlock UI refuses empty input. Reject it before touching any live or
      // durable state.
      if (!newPassword) {
        throw new Error(this.t('password_cannot_be_empty'))
      }

      // setLocked() flips memStore.isUnlocked before its cleanup queues on
      // unlockingMutex, so the flag can read locked while the password and
      // live keyrings are still loaded. Under unlockingMutex the password is
      // the authoritative unlocked signal; a queued lock still runs after
      // this commit and clears the live state it published.
      const wasUnlocked = this.password !== null

      // A wrong old password is user-correctable; report it distinctly instead
      // of collapsing it into the generic failure below.
      const isValidPassword = await this.verifyPassword(oldPassword)
      if (!isValidPassword) {
        throw new Error(this.t('password_error'))
      }

      let noVaultError: Error | null = null
      try {
        await this.persistenceMutex.lock(async () => {
          const currentState = { ...this.store.getState() }
          if (!currentState.vault) {
            noVaultError = new Error(this.t('cannot_unlock_without_a_previous_vault'))
            throw noVaultError
          }

          // An unlocked state without live keyrings must reload the durable
          // vault instead of committing an empty one.
          const serializedKeyrings =
            wasUnlocked && this.keyrings.length > 0
              ? await this.serializeLiveKeyrings()
              : await this.encryptor.decrypt(oldPassword, currentState.vault)
          const boostValue = currentState.boostValue || this.initialBoostValue
          const booted = await this.encryptor.encrypt(newPassword, boostValue)
          const vault = await this.encryptor.encrypt(newPassword, serializedKeyrings)

          const currentPreMnemonics = this.memStore.getState().preMnemonics
          let preMnemonics = currentPreMnemonics
          if (currentPreMnemonics) {
            const mnemonic = await this.encryptor.decrypt(oldPassword, currentPreMnemonics)
            preMnemonics = await this.encryptor.encrypt(newPassword, mnemonic)
          }

          const nextState: StoreState = {
            ...currentState,
            booted,
            vault,
            boostValue,
          }

          // Commit a complete encrypted snapshot before publishing any new-password state.
          await this.persistStoreState(nextState)
          this.password = wasUnlocked ? newPassword : null
          this.store.updateState(nextState)
          if (
            currentPreMnemonics &&
            this.memStore.getState().preMnemonics === currentPreMnemonics
          ) {
            this.memStore.updateState({ preMnemonics })
          }
        })
      } catch (error) {
        if (noVaultError && error === noVaultError) {
          throw error
        }
        this.logger?.error?.('[KeyringService] Failed to change password', error)
        throw new Error(this.t('change_password_failed'))
      }

      // Still inside unlockingMutex → passwordChangeMutex: a blob wrapping the
      // old password must be invalidated before any queued unlock or the next
      // password mutation can run against it.
      await this.runPasswordLifecycleHook('passwordChanged')

      try {
        this.fullUpdate()
      } catch (error) {
        // The new password is already durably committed; a listener failure
        // must not report the change itself as failed.
        this.logger?.error?.('[KeyringService] Failed to publish password change update', error)
      }
    }

    return this.unlockingMutex.lock(() => this.passwordChangeMutex.lock(performPasswordChange))
  }

  private getBoostValue = (): string => {
    return this.store.getState().boostValue || this.initialBoostValue
  }

  /**
   * Verify Password
   *
   * Attempts to decrypt the current vault with a given password
   * to verify its validity.
   *
   * Security: Only accepts upgraded boost values. Initial 'true' value
   * is rejected to prevent dictionary/collision attacks.
   *
   * @param {string} password
   */
  verifyPassword = async (password: string): Promise<boolean> => {
    const encryptedBooted = this.store.getState().booted
    if (!encryptedBooted) {
      throw new Error(this.t('cannot_unlock_without_a_previous_vault'))
    }
    try {
      const val = await this.encryptor.decrypt(password, encryptedBooted)
      // The initial boot sentinel is accepted only after authenticated decryption.
      if (val === 'true') {
        return true
      }

      if (val === this.getBoostValue()) {
        return true
      }

      return false
    } catch {
      return false
    }
  }

  /**
   * Add New Keyring
   *
   * Adds a new Keyring of the given `type` to the vault
   * and the current decrypted Keyrings array.
   *
   * All Keyring classes implement a unique `type` string,
   * and this is used to retrieve them from the keyringTypes array.
   *
   * @param  type - The type of keyring to add.
   * @param  opts - The constructor options for the keyring.
   * @returns  The new keyring.
   */
  addNewKeyring = async (
    type: string,
    opts: unknown,
    addressType: AddressType
  ): Promise<Keyring> => {
    const KeyringCtor = this.getKeyringClassForType(type)
    if (!KeyringCtor) {
      throw new Error(`Unknown keyring type: ${type}`)
    }
    const keyring = new KeyringCtor(opts)
    return await this.addKeyring(keyring, addressType)
  }

  createTmpKeyring = (type: string, opts: unknown) => {
    const Keyring = this.getKeyringClassForType(type)
    if (!Keyring) {
      throw new Error(`Unknown keyring type: ${type}`)
    }

    const keyring = new Keyring(opts)
    return keyring
  }

  /**
   * Checks for duplicate keypairs, using the the first account in the given
   * array. Rejects if a duplicate is found.
   *
   * Only supports 'Simple Key Pair'.
   *
   * @param {string} type - The key pair type to check for.
   * @param {Array<string>} newAccountArray - Array of new accounts.
   * @returns {Promise<Array<string>>} The account, if no duplicate is found.
   */
  checkForDuplicate = async (type: string, newAccountArray: string[]): Promise<string[]> => {
    const keyrings = this.getKeyringsByType(type)
    const _accounts = await Promise.all(keyrings.map(keyring => keyring.getAccounts()))

    const accounts: string[] = _accounts.reduce((m, n) => m.concat(n), [] as string[])

    const isIncluded = newAccountArray.some(account => {
      return accounts.find(key => key === account)
    })

    return isIncluded
      ? Promise.reject(new Error(this.t('wallet_existed')))
      : Promise.resolve(newAccountArray)
  }

  /**
   * Add New Account
   *
   * Calls the `addAccounts` method on the given keyring,
   * and then saves those changes.
   *
   * @param {Keyring} selectedKeyring - The currently selected keyring.
   * @returns {Promise<Object>} A Promise that resolves to the state.
   */
  addNewAccount = async (selectedKeyring: Keyring): Promise<string[]> =>
    // Same protection as addKeyring: the rollback below must not straddle a
    // password commit. The PQC counter locks freeze the keyring's counter,
    // provenance, cache, and floor state while the rollback snapshot is live —
    // a counter advanced after the snapshot must never be rewound by it.
    this.passwordChangeMutex.lock(async () => {
      const lockPubkeys = await this.getAccountMutationLockPubkeys(selectedKeyring, {
        includeNextAccount: true,
      })
      return this.lockPqcSignatureCounterPubkeys(lockPubkeys, async () => {
        // The caller resolved the keyring before these locks; a lock and
        // unlock while they were queued detached it.
        this.assertLiveKeyrings([selectedKeyring])
        const keyrings = this.keyrings
        const keyringIndex = keyrings.indexOf(selectedKeyring)
        const rollbackSnapshot = structuredClone(await selectedKeyring.serialize())
        const { keyring: rollbackKeyring } = await this._restoreKeyring({
          type: selectedKeyring.type,
          data: structuredClone(rollbackSnapshot),
          addressType: this.addressTypes[keyringIndex],
        })

        const accounts = await selectedKeyring.addAccounts(1)
        this.cachedDisplayedKeyring = null

        try {
          await this.persistAllKeyrings([selectedKeyring])
        } catch (error) {
          this.rollbackAccountMutation(
            keyringIndex,
            selectedKeyring,
            rollbackSnapshot,
            rollbackKeyring
          )
          await this.persistMutationRollback('account-addition', keyrings)
          throw error
        }

        accounts.forEach(hexAccount => {
          this.emit('newAccount', hexAccount)
        })
        await this._updateMemStoreKeyrings()
        await this.fullUpdate()
        return accounts
      })
    })

  private publicQbitRecoveryState = async (
    keyring: Keyring,
    network?: QbitReceiveNetworkName
  ): Promise<QbitRecoveryState> => {
    const state = keyring.getQbitRecoveryState?.() as QbitRecoveryVaultState | undefined
    const qbitAccounts =
      keyring.type === KeyringType.QbitHdKeyring && (keyring as any).getQbitAccounts
        ? await (keyring as any).getQbitAccounts()
        : []
    const knownOnChainSignatures = qbitAccounts.reduce(
      (sum: number, account: any) => sum + (account?.signatureCounter?.knownOnChainSignatures || 0),
      0
    )
    if (!state) {
      return {
        status: 'clean',
        acknowledgement: 'accepted',
        counterConfidence: 'local',
        knownOnChainSignatures,
      }
    }
    // Project one network's lifecycle. Callers that know the active network
    // pass it (display snapshots resolve it through the wired active-network
    // resolver); without one, fall back to the networks the current
    // derivation path can spend — the combined status for these keys, with
    // the migration record of whichever sibling that status describes.
    let status: QbitRecoveryState['status']
    let projectedNetwork: QbitReceiveNetworkName | undefined
    const siblings = qbitReceiveNetworksForHdPath(
      ((keyring as any).hdPath as string) ?? "m/87'/0'/0'/0"
    )
    if (network !== undefined) {
      projectedNetwork = network
      status =
        (keyring.effectiveQbitRecoveryStatus?.(network) as QbitRecoveryState['status']) ??
        state.networks[network]?.status ??
        'seed-only-restored'
    } else {
      status =
        (keyring.effectiveQbitRecoveryStatus?.() as QbitRecoveryState['status']) ??
        'seed-only-restored'
      projectedNetwork =
        status === 'migrating' || status === 'migrated'
          ? siblings.find(candidate => state.networks[candidate]?.status === status)
          : undefined
    }
    const record: QbitRecoveryNetworkVaultState | undefined =
      projectedNetwork === undefined ? undefined : state.networks[projectedNetwork]
    // Only attach the migration the projected status describes: an archived
    // sibling's record must not hide another network's "move funds" entry.
    const migration =
      record && (record.status === 'migrating' || record.status === 'migrated')
        ? record.migration
        : undefined
    const destinationKeyringIndex = migration
      ? await this.findQbitKeyringIndex(migration.destinationPubkey, migration.destinationAddress)
      : undefined
    const migrationDestinationReusable =
      status === 'seed-only-restored' &&
      Object.entries(state.networks).some(
        ([candidate, candidateRecord]) =>
          candidate !== projectedNetwork && candidateRecord?.migration !== undefined
      )
    const otherNetworksPendingRecovery =
      status === 'migrated' &&
      Object.entries(state.networks).some(
        ([candidate, candidateRecord]) =>
          candidate !== projectedNetwork &&
          (candidateRecord?.status ?? 'seed-only-restored') !== 'migrated'
      )
    return {
      status,
      acknowledgement: state.acknowledgement,
      ...(state.warningDismissed === true ? { warningDismissed: true } : {}),
      counterConfidence: 'chain-floor-only',
      knownOnChainSignatures,
      ...(migration
        ? {
            migration: {
              destinationKeyringIndex:
                destinationKeyringIndex ?? migration.destinationKeyringIndex,
              destinationAddress: migration.destinationAddress,
              network: migration.network,
              plans: migration.plans.map(plan => ({
                id: plan.id,
                sourceAddress: plan.sourceAddress,
                destinationAddress: plan.destinationAddress,
                amount: plan.amount,
                fee: plan.fee,
                status: plan.status,
                ...(plan.txid ? { txid: plan.txid } : {}),
                ...(plan.sourceIndex !== undefined ? { sourceIndex: plan.sourceIndex } : {}),
                ...(plan.destinationIndex !== undefined
                  ? { destinationIndex: plan.destinationIndex }
                  : {}),
              })),
            },
          }
        : {}),
      ...(migrationDestinationReusable ? { migrationDestinationReusable: true } : {}),
      ...(otherNetworksPendingRecovery ? { otherNetworksPendingRecovery: true } : {}),
    }
  }

  private findQbitKeyringIndex = async (
    pubkey: string,
    address: string
  ): Promise<number | undefined> => {
    for (let index = 0; index < this.keyrings.length; index += 1) {
      const candidate = this.keyrings[index]
      if (candidate?.type !== KeyringType.QbitHdKeyring || !(candidate as any).getQbitAccounts) {
        continue
      }
      const accounts = await (candidate as any).getQbitAccounts()
      if (
        accounts.some(
          (account: any) =>
            account?.pubkey?.toLowerCase() === pubkey.toLowerCase() &&
            Object.values(account?.addresses || {}).includes(address)
        )
      ) {
        return index
      }
    }
    return undefined
  }

  getQbitRecoveryState = async (
    address: string,
    network?: QbitReceiveNetworkName
  ): Promise<QbitRecoveryState> => {
    const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
    return this.publicQbitRecoveryState(keyring, network)
  }

  getQbitRecoveryVaultState = async (
    address: string
  ): Promise<QbitRecoveryVaultState | undefined> => {
    const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
    return keyring.getQbitRecoveryState?.()
  }

  private mutateQbitRecoveryState = async (
    address: string,
    mutate: (keyring: Keyring) => void,
    network?: QbitReceiveNetworkName
  ): Promise<QbitRecoveryState> =>
    // The recovery snapshot and failure rollback below must not straddle a
    // password commit, or a defeated rollback would restore an old-password
    // vault beside the new-password verifier. Lock order:
    // passwordChangeMutex → qbitRecoveryMutex.
    this.passwordChangeMutex.lock(() =>
      this.qbitRecoveryMutex.lock(async () => {
        const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
        if (!keyring.getQbitRecoveryState || !keyring.restoreQbitRecoveryState) {
          throw new Error(this.t('not_supported'))
        }
        const previousState = keyring.getQbitRecoveryState()
        let persisted = false
        try {
          mutate(keyring)
          this.cachedDisplayedKeyring = null
          await this.persistAllKeyrings([keyring])
          persisted = true
          await this._updateMemStoreKeyrings()
          this.fullUpdate()
        } catch (error) {
          if (!persisted) {
            keyring.restoreQbitRecoveryState(previousState)
            this.cachedDisplayedKeyring = null
            try {
              // Re-persist the restored live state instead of rewinding to the
              // pre-mutation vault snapshot: counter persists from other
              // keyrings may have advanced the vault since the snapshot, and a
              // snapshot restore would durably rewind them (signature reuse).
              await this.persistAllKeyrings([keyring])
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to persist recovery-state rollback',
                rollbackError
              )
            }
            try {
              await this._updateMemStoreKeyrings()
            } catch (rollbackError) {
              this.logger?.error?.(
                '[KeyringService] Failed to refresh recovery-state rollback',
                rollbackError
              )
            }
          }
          throw error
        }
        return this.publicQbitRecoveryState(keyring, network)
      })
    )

  acknowledgeQbitRecoveryRisk = (
    address: string,
    network?: QbitReceiveNetworkName
  ): Promise<QbitRecoveryState> =>
    this.mutateQbitRecoveryState(
      address,
      keyring => {
        if (!keyring.acknowledgeQbitRecoveryRisk) throw new Error(this.t('not_supported'))
        keyring.acknowledgeQbitRecoveryRisk()
      },
      network
    )

  dismissQbitRecoveryWarning = (
    address: string,
    network?: QbitReceiveNetworkName
  ): Promise<QbitRecoveryState> =>
    this.mutateQbitRecoveryState(
      address,
      keyring => {
        if (!keyring.dismissQbitRecoveryWarning) throw new Error(this.t('not_supported'))
        keyring.dismissQbitRecoveryWarning()
      },
      network
    )

  replaceQbitRecoveryMigrationPlans = (
    address: string,
    network: QbitReceiveNetworkName,
    plans: QbitRecoveryMigrationPlanVault[]
  ): Promise<QbitRecoveryState> =>
    this.mutateQbitRecoveryState(
      address,
      keyring => {
        if (!keyring.replaceQbitRecoveryMigrationPlans) throw new Error(this.t('not_supported'))
        keyring.replaceQbitRecoveryMigrationPlans(network, plans)
      },
      network
    )

  /**
   * Persist a migration plan replacement on the source keyring together with
   * the destination receive-ledger reservations backing the new plans' pay-to
   * indexes, as one vault commit. Reserving first and persisting the plans
   * second (or the reverse) leaves a durable half-state when the second write
   * throws: reservations no plan references permanently burn destination
   * indexes, and enough burned indexes walk later sweeps past the window a
   * standard gap-limit restore of the fresh seed scans. Lock order:
   * passwordChangeMutex → qbitRecoveryMutex → qbitReceiveIntentMutex.
   */
  replaceQbitRecoveryMigrationPlansWithDestinationReservations = (
    address: string,
    network: QbitReceiveNetworkName,
    plans: QbitRecoveryMigrationPlanVault[],
    destination: {
      anchor: string
      /** Freshly allocated indexes that must still be unknown to the ledger. */
      reserveIndexes: readonly number[]
      /**
       * Indexes the ledger may already track — a re-sweep pays the index its
       * source paired with in an earlier round. Marked issued idempotently.
       */
      reuseIndexes?: readonly number[]
    }
  ): Promise<QbitRecoveryState> =>
    this.passwordChangeMutex.lock(() =>
      this.qbitRecoveryMutex.lock(() =>
        this.qbitReceiveIntentMutex.lock(async () => {
          const sourceKeyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
          const destinationKeyring = await this.getKeyringForAccount(
            destination.anchor,
            KeyringType.QbitHdKeyring
          )
          if (
            !sourceKeyring.getQbitRecoveryState ||
            !sourceKeyring.restoreQbitRecoveryState ||
            !sourceKeyring.replaceQbitRecoveryMigrationPlans ||
            !destinationKeyring.getQbitReceiveState ||
            !destinationKeyring.replaceQbitReceiveState ||
            !destinationKeyring.markQbitReceiveIndexesIssued
          ) {
            throw new Error(this.t('not_supported'))
          }
          const previousRecoveryState = sourceKeyring.getQbitRecoveryState()
          const previousReceiveState = destinationKeyring.getQbitReceiveState(network)
          const previousActiveIndexes = [...((destinationKeyring as any).activeIndexes || [])]
          // The caller allocated its indexes from a ledger snapshot taken
          // before slow plan construction; refuse any index the receive flow
          // handed out in the meantime so a sweep never pays a presented
          // address. The caller re-allocates from the fresh ledger on retry.
          const committedIndexes = new Set<number>([
            ...previousReceiveState.issuedIndexes,
            ...previousReceiveState.usedIndexes,
          ])
          const collided = destination.reserveIndexes.find(index => committedIndexes.has(index))
          if (collided !== undefined) {
            throw new Error(
              `Qbit destination index ${collided} was issued while migration plans were being prepared`
            )
          }
          let persisted = false
          try {
            sourceKeyring.replaceQbitRecoveryMigrationPlans(network, plans)
            destinationKeyring.markQbitReceiveIndexesIssued(network, [
              ...destination.reserveIndexes,
              ...(destination.reuseIndexes ?? []),
            ])
            this.cachedDisplayedKeyring = null
            await this.persistAllKeyrings([sourceKeyring, destinationKeyring])
            persisted = true
            await this._updateMemStoreKeyrings()
            this.fullUpdate()
          } catch (error) {
            if (!persisted) {
              // Restore both keyrings in place and re-persist the corrected
              // live state instead of rewinding to a vault snapshot; see
              // mutateQbitRecoveryState.
              sourceKeyring.restoreQbitRecoveryState(previousRecoveryState)
              destinationKeyring.replaceQbitReceiveState(
                network,
                previousReceiveState,
                previousActiveIndexes
              )
              this.cachedDisplayedKeyring = null
              try {
                await this.persistAllKeyrings([sourceKeyring, destinationKeyring])
              } catch (rollbackError) {
                this.logger?.error?.(
                  '[KeyringService] Failed to persist migration-plan rollback',
                  rollbackError
                )
              }
              try {
                await this._updateMemStoreKeyrings()
              } catch (rollbackError) {
                this.logger?.error?.(
                  '[KeyringService] Failed to refresh migration-plan rollback',
                  rollbackError
                )
              }
            }
            throw error
          }
          return this.publicQbitRecoveryState(sourceKeyring, network)
        })
      )
    )

  updateQbitRecoveryMigrationPlan = (
    address: string,
    network: QbitReceiveNetworkName,
    planId: string,
    update: {
      status: 'prepared' | 'signed' | 'broadcast' | 'confirmed'
      signedPsbtHex?: string
      txid?: string
    }
  ): Promise<QbitRecoveryState> =>
    this.mutateQbitRecoveryState(
      address,
      keyring => {
        if (!keyring.updateQbitRecoveryMigrationPlan) throw new Error(this.t('not_supported'))
        keyring.updateQbitRecoveryMigrationPlan(network, planId, update)
      },
      network
    )

  markQbitRecoveryMigrated = (
    address: string,
    network: QbitReceiveNetworkName,
    options?: { allowIncompletePlanRecord?: boolean }
  ): Promise<QbitRecoveryState> =>
    this.mutateQbitRecoveryState(
      address,
      keyring => {
        if (!keyring.markQbitRecoveryMigrated) throw new Error(this.t('not_supported'))
        keyring.markQbitRecoveryMigrated(network, options)
      },
      network
    )

  reopenQbitRecoveryMigration = (
    address: string,
    network: QbitReceiveNetworkName,
    planIds: readonly string[]
  ): Promise<QbitRecoveryState> =>
    this.mutateQbitRecoveryState(
      address,
      keyring => {
        if (!keyring.reopenQbitRecoveryMigration) throw new Error(this.t('not_supported'))
        keyring.reopenQbitRecoveryMigration(network, planIds)
      },
      network
    )

  completeQbitRecoveryAddressDiscovery = (
    address: string,
    network: QbitReceiveNetworkName
  ): Promise<QbitRecoveryState> =>
    this.mutateQbitRecoveryState(
      address,
      keyring => {
        if (!keyring.completeQbitRecoveryAddressDiscovery) {
          throw new Error(this.t('not_supported'))
        }
        keyring.completeQbitRecoveryAddressDiscovery(network)
      },
      network
    )

  getQbitReceiveState = async (address: string, network: string): Promise<any> => {
    const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
    if (!keyring.getQbitReceiveState) {
      throw new Error(this.t('not_supported'))
    }
    return keyring.getQbitReceiveState(network)
  }

  private persistQbitReceiveState = async (changedKeyrings: readonly Keyring[]): Promise<void> => {
    await this.persistAllKeyrings(changedKeyrings)
    this.cachedDisplayedKeyring = null
    await this._updateMemStoreKeyrings()
    this.fullUpdate()
  }

  private withQbitReceiveStateMutation = <T>(mutation: () => Promise<T>): Promise<T> =>
    this.passwordChangeMutex.lock(() => this.qbitReceiveIntentMutex.lock(mutation))

  setQbitReceiveIntent = async (address: string, network: string, index: number): Promise<any> =>
    this.withQbitReceiveStateMutation(async () => {
      const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
      if (
        !keyring.getQbitReceiveState ||
        !keyring.getQbitReceiveAccount ||
        !keyring.replaceQbitReceiveState ||
        !keyring.setQbitReceiveIntent ||
        !keyring.assertPqcSignatureCounterAvailable
      ) {
        throw new Error(this.t('not_supported'))
      }
      // Preserve network validation before deriving or waiting on counter state.
      keyring.getQbitReceiveState(network)
      const targetAccount = await keyring.getQbitReceiveAccount(index)
      const targetAddress = targetAccount?.addresses?.[network]
      if (typeof targetAccount?.pubkey !== 'string' || typeof targetAddress !== 'string') {
        throw new Error(this.t('not_supported'))
      }
      return this.pqcSignatureCounterMutex.lock(targetAccount.pubkey, async () => {
        this.assertLiveKeyrings([keyring])
        const keyrings = this.keyrings
        await keyring.assertPqcSignatureCounterAvailable!(targetAddress, 1)
        const previousState = keyring.getQbitReceiveState!(network)
        const previousActiveIndexes = [...((keyring as any).activeIndexes || [])]
        const mutation = await keyring.setQbitReceiveIntent!(network, index)
        if (!mutation.changed) return mutation.account

        try {
          await this.persistQbitReceiveState([keyring])
        } catch (error) {
          keyring.replaceQbitReceiveState!(network, previousState, previousActiveIndexes)
          await this.persistMutationRollback('Qbit receive-state', keyrings)
          throw error
        }
        return mutation.account
      })
    })

  markQbitReceiveIndexesIssued = async (
    address: string,
    network: string,
    indexes: readonly number[]
  ): Promise<void> =>
    this.withQbitReceiveStateMutation(async () => {
      const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
      if (
        !keyring.getQbitReceiveState ||
        !keyring.replaceQbitReceiveState ||
        !keyring.markQbitReceiveIndexesIssued
      ) {
        throw new Error(this.t('not_supported'))
      }
      // A lock and unlock while the keyring was resolved detached it.
      this.assertLiveKeyrings([keyring])
      const previousState = keyring.getQbitReceiveState(network)
      const previousActiveIndexes = [...((keyring as any).activeIndexes || [])]
      const keyrings = this.keyrings
      if (!keyring.markQbitReceiveIndexesIssued(network, indexes)) return

      try {
        await this.persistQbitReceiveState([keyring])
      } catch (error) {
        keyring.replaceQbitReceiveState(network, previousState, previousActiveIndexes)
        await this.persistMutationRollback('Qbit receive-state', keyrings)
        throw error
      }
    })

  recordQbitReceiveActivity = async (
    address: string,
    network: string,
    indexes: readonly number[]
  ): Promise<void> =>
    this.withQbitReceiveStateMutation(async () => {
      const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
      if (
        !keyring.getQbitReceiveState ||
        !keyring.replaceQbitReceiveState ||
        !keyring.recordQbitReceiveActivity
      ) {
        throw new Error(this.t('not_supported'))
      }
      // A lock and unlock while the keyring was resolved detached it.
      this.assertLiveKeyrings([keyring])
      const previousState = keyring.getQbitReceiveState(network)
      const keyrings = this.keyrings
      if (!keyring.recordQbitReceiveActivity(network, indexes)) return

      try {
        await this.persistQbitReceiveState([keyring])
      } catch (error) {
        keyring.replaceQbitReceiveState(network, previousState)
        await this.persistMutationRollback('Qbit receive-state', keyrings)
        throw error
      }
    })

  /**
   * Export Account
   *
   * Requests the private key from the keyring controlling
   * the specified address.
   *
   * Returns a Promise that may resolve with the private key string.
   *
   * @param {string} address - The address of the account to export.
   * @returns {Promise<string>} The private key of the account.
   */
  exportAccount = async (address: string): Promise<string> => {
    const keyring = await this.getKeyringForAccount(address)
    const privkey = await keyring.exportAccount(address)
    return privkey
  }

  getPqcSignatureCounter = async (address: string): Promise<number> => {
    const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
    if (!keyring.getPqcSignatureCounter) {
      throw new Error(this.t('not_supported'))
    }
    return keyring.getPqcSignatureCounter(address)
  }

  /**
   * Re-arm the restore signing gate for the single keyring owning `address`,
   * so accounts activated beyond its scanned range stay sign-locked until a
   * floor scan reconstructs and persists their history floors.
   */
  rearmQbitRestoreFloorsForKeyring = async (address: string): Promise<boolean> => {
    const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
    if (keyring.pqcRestoredFromMnemonic !== true || !keyring.rearmPqcRestoreFloors) {
      throw new Error(this.t('not_supported'))
    }
    const pubkeys = await keyring.getAccounts()
    return this.lockPqcSignatureCounterPubkeys(pubkeys, async () => {
      this.assertLiveKeyrings([keyring])
      if (!keyring.rearmPqcRestoreFloors!()) return false
      const keyringPubkeys = new Set(pubkeys)
      for (const [challengeId, challenge] of this.qbitRestoredFloorSigningChallenges) {
        if (keyringPubkeys.has(challenge.pubkey)) {
          this.qbitRestoredFloorSigningChallenges.delete(challengeId)
        }
      }
      await this.persistPqcSignatureCounterState([keyring])
      return true
    })
  }

  rearmQbitRestoreFloors = async (): Promise<boolean> => {
    const restoredKeyrings = this.keyrings.filter(
      keyring =>
        keyring.type === KeyringType.QbitHdKeyring &&
        keyring.pqcRestoredFromMnemonic === true &&
        keyring.rearmPqcRestoreFloors
    )
    const pubkeys = (
      await Promise.all(restoredKeyrings.map(keyring => keyring.getAccounts()))
    ).flat()
    return this.lockPqcSignatureCounterPubkeys(pubkeys, async () => {
      this.assertLiveKeyrings(restoredKeyrings)
      let changed = false
      for (const keyring of restoredKeyrings) {
        changed = keyring.rearmPqcRestoreFloors!() || changed
      }
      if (!changed) return false

      this.qbitRestoredFloorSigningChallenges.clear()
      await this.persistPqcSignatureCounterState(restoredKeyrings)
      return true
    })
  }

  private getPqcSignatureCounterTarget = async (
    address: string
  ): Promise<{ keyring: Keyring; pubkey: string }> => {
    const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
    if (
      !keyring.getPqcSignatureCounterPubkey ||
      !keyring.getPqcSignatureCounter ||
      !keyring.reservePqcSignatureCounter ||
      !keyring.rollbackPqcSignatureCounterReservation
    ) {
      throw new Error(this.t('not_supported'))
    }
    return {
      keyring,
      pubkey: await keyring.getPqcSignatureCounterPubkey(address),
    }
  }

  private persistPqcSignatureCounterState = async (
    changedKeyrings: readonly Keyring[]
  ): Promise<void> => {
    await this.persistAllKeyrings(changedKeyrings)
    this.cachedDisplayedKeyring = null
    await this._updateMemStoreKeyrings()
    this.fullUpdate()
  }

  private rollbackPqcSignatureCounterReservation = async (
    keyring: Keyring,
    pubkey: string,
    reservation: QbitPqcSignatureCounterReservation
  ): Promise<void> => {
    await keyring.rollbackPqcSignatureCounterReservation!(pubkey, reservation)
    this.cachedDisplayedKeyring = null
    await this._updateMemStoreKeyrings()
    this.fullUpdate()
  }

  private lockPqcSignatureCounterPubkeys = async <T>(
    pubkeys: string[],
    fn: () => Promise<T>
  ): Promise<T> => {
    const keys = Array.from(new Set(pubkeys)).sort()
    const lockNext = (index: number): Promise<T> => {
      const key = keys[index]
      if (!key) {
        return fn()
      }
      return this.pqcSignatureCounterMutex.lock(key, () => lockNext(index + 1))
    }
    return lockNext(0)
  }

  /**
   * Every PQC counter mutation (reservations, floors, signature-cache writes,
   * restore scans) keys pqcSignatureCounterMutex by account pubkey. An account
   * mutation that captures a keyring snapshot for rollback must hold all of
   * those keys for the affected keyring, so no counter state can advance
   * between the snapshot and a rollback that would rewind it. Lock order is
   * passwordChangeMutex → qbitRecoveryMutex → pqcSignatureCounterMutex
   * (sorted keys) → persistenceMutex, matching setQbitReceiveIntent, the
   * recovery mutations, and the signing paths.
   */
  private getAccountMutationLockPubkeys = async (
    keyring: Keyring,
    options?: { includeNextAccount?: boolean }
  ): Promise<string[]> => {
    if (keyring.type !== KeyringType.QbitHdKeyring) {
      return []
    }
    const pubkeys = await keyring.getAccounts()
    if (options?.includeNextAccount && keyring.getQbitReceiveAccount) {
      // addAccounts(1) activates the lowest inactive index. getAccounts()
      // exposes that account to concurrent counter reservations before it is
      // durable, so its pubkey must be locked before the mutation happens.
      const activeIndexes: number[] = ((keyring as any).activeIndexes ?? []) as number[]
      let nextIndex = 0
      while (activeIndexes.includes(nextIndex)) {
        nextIndex += 1
      }
      const nextAccount = await keyring.getQbitReceiveAccount(nextIndex)
      if (typeof nextAccount?.pubkey === 'string') {
        pubkeys.push(nextAccount.pubkey)
      }
    }
    return pubkeys
  }

  /**
   * Undo a failed account mutation on the live keyring. Restores in place when
   * the keyring supports it: PQC counter operations queued on
   * pqcSignatureCounterMutex resolved their keyring reference before this
   * mutation took the counter locks, so replacing the object would detach
   * their target and fail them. Falls back to swapping in the pre-mutation
   * clone for keyrings without counter state.
   */
  private rollbackAccountMutation = (
    keyringIndex: number,
    keyring: Keyring,
    rollbackSnapshot: any,
    rollbackKeyring: Keyring
  ): void => {
    if (this.keyrings[keyringIndex] !== keyring) {
      return
    }
    if (keyring.restoreAccountSnapshot) {
      try {
        keyring.restoreAccountSnapshot(structuredClone(rollbackSnapshot))
        return
      } catch (rollbackError) {
        this.logger?.error?.(
          '[KeyringService] Failed to restore account-mutation snapshot in place',
          rollbackError
        )
      }
    }
    this.keyrings[keyringIndex] = rollbackKeyring
  }

  reservePqcSignatureCounter = async (
    address: string,
    count = 1
  ): Promise<QbitPqcSignatureCounterReservation> => {
    const { keyring, pubkey } = await this.getPqcSignatureCounterTarget(address)
    return this.pqcSignatureCounterMutex.lock(pubkey, async () => {
      this.assertLiveKeyrings([keyring])
      const reservation = await keyring.reservePqcSignatureCounter!(pubkey, count)
      try {
        await this.persistPqcSignatureCounterState([keyring])
      } catch (error) {
        await this.rollbackPqcSignatureCounterReservation(keyring, pubkey, reservation)
        throw error
      }
      return reservation
    })
  }

  applyPqcSignatureCounterFloor = async (
    address: string,
    observedCounter: number,
    provenance: QbitPqcSignatureCounterProvenance = 'restored-floor'
  ): Promise<QbitPqcSignatureCounterFloor> => {
    const { keyring, pubkey } = await this.getPqcSignatureCounterTarget(address)
    return this.pqcSignatureCounterMutex.lock(pubkey, async () => {
      if (!keyring.applyPqcSignatureCounterFloor) {
        throw new Error(this.t('not_supported'))
      }
      this.assertLiveKeyrings([keyring])
      const floor = await keyring.applyPqcSignatureCounterFloor(pubkey, observedCounter, provenance)
      await this.persistPqcSignatureCounterState([keyring])
      return floor
    })
  }

  /**
   * Restore-time scan: raise the keyring's PQC counters to the floor reported by
   * `observe` (a per-account chain-history lookup, wired to @qbit-oss/api by the
   * caller) and flag a possible concurrent instance if activity is found beyond
   * the known indexes. Persists once. Intended to run at restore (F2) / import,
   * before any signing.
   */
  restorePqcSignatureCounterFloors = async (
    address: string,
    observe: QbitPqcHistoryObserver,
    options?: { lookahead?: number }
  ): Promise<QbitPqcRestoreFloorScan> => {
    const keyring = await this.getKeyringForAccount(address, KeyringType.QbitHdKeyring)
    if (!keyring.getPqcSignatureCounterPubkey || !keyring.scanPqcSignatureCounterFloors) {
      throw new Error(this.t('not_supported'))
    }
    const targetPubkey = await keyring.getPqcSignatureCounterPubkey(address)
    const pubkeys = [targetPubkey, ...(await keyring.getAccounts())]
    return this.lockPqcSignatureCounterPubkeys(pubkeys, async () => {
      this.assertLiveKeyrings([keyring])
      const floorsPendingBeforeScan = keyring.pqcFloorsPending === true
      let result: QbitPqcRestoreFloorScan
      try {
        result = await keyring.scanPqcSignatureCounterFloors!(observe, options)
      } catch (error) {
        await this.persistPqcSignatureCounterState([keyring])
        throw error
      }
      try {
        await this.persistPqcSignatureCounterState([keyring])
      } catch (error) {
        if (floorsPendingBeforeScan) {
          // The vault still says floors are pending; memory must not be more
          // permissive than the vault, or a reload would re-lock a wallet the
          // UI already reported as unlocked.
          keyring.pqcFloorsPending = true
        }
        throw error
      }
      return result
    })
  }

  /**
   * Recovery status consulted by the restored-floor signing gates. The
   * collapsed cross-network projection cannot represent a partially migrated
   * coin type: with one sibling archived and the other still restored it
   * reads seed-only-restored, which would let an approved ordinary PSBT
   * spend the archived network's retained sources — and with the other
   * sibling migrating it reads migrating, which would let a reviewed
   * migration or protected-asset transfer challenge-sign against the
   * archive. Signing therefore consults the active network's own record: an
   * archived active network stays archived no matter what a sibling is
   * doing, while any other active status keeps a sibling's migration lock —
   * the sibling networks share PQC signature counters. When the active
   * network is unknown or belongs to another coin type, a partially
   * archived restored coin type fails closed as archived rather than open
   * as restored; an active migration keeps the coin-type-wide lock so its
   * exact-plan-bound signing survives a missing resolver.
   */
  private qbitSigningRecoveryStatus = (
    keyring: Keyring,
    collapsedStatus: QbitRecoveryVaultStatus | 'clean'
  ): QbitRecoveryVaultStatus | 'clean' => {
    if (
      (collapsedStatus !== 'seed-only-restored' && collapsedStatus !== 'migrating') ||
      !keyring.effectiveQbitRecoveryStatus
    ) {
      return collapsedStatus
    }
    const siblings = qbitReceiveNetworksForHdPath(
      ((keyring as any).hdPath as string) ?? "m/87'/0'/0'/0"
    )
    const activeNetwork = this.activeQbitDisplayNetwork()
    if (activeNetwork !== undefined && siblings.includes(activeNetwork)) {
      const activeStatus =
        (keyring.effectiveQbitRecoveryStatus(activeNetwork) as
          | QbitRecoveryVaultStatus
          | 'clean') ?? collapsedStatus
      if (collapsedStatus === 'migrating') {
        return activeStatus === 'migrated' ? 'migrated' : collapsedStatus
      }
      return activeStatus
    }
    if (collapsedStatus === 'migrating') {
      return collapsedStatus
    }
    const partiallyArchived = siblings.some(
      sibling => keyring.effectiveQbitRecoveryStatus!(sibling) === 'migrated'
    )
    return partiallyArchived ? 'migrated' : collapsedStatus
  }

  private issueQbitRestoredFloorSigningChallenge = async (
    keyring: Keyring,
    pubkey: string,
    cacheKeys: readonly string[],
    budget: QbitSignatureBudgetImpact,
    allowDuringMigration = false,
    reuseScope?: string,
    migrationConsolidation = false
  ): Promise<QbitSignatureBudgetImpact> => {
    const metadata = await keyring.getPqcSignatureCounterMetadata?.(pubkey)
    const recoveryStatus =
      metadata === undefined
        ? undefined
        : this.qbitSigningRecoveryStatus(keyring, metadata.recoveryStatus)
    const restored =
      !metadata || metadata.provenance === 'restored-floor' || recoveryStatus !== 'clean'
    if (!restored) return budget
    if (recoveryStatus === 'migrated') {
      throw new QbitRestoredFloorConfirmationError(this.t('qbit_recovery_archived_signing_blocked'))
    }
    if (recoveryStatus === 'migrating' && !allowDuringMigration) {
      throw new QbitRestoredFloorConfirmationError(this.t('qbit_recovery_migration_signing_only'))
    }

    const now = Date.now()
    for (const [challengeId, challenge] of this.qbitRestoredFloorSigningChallenges) {
      if (challenge.expiresAt < now) {
        this.qbitRestoredFloorSigningChallenges.delete(challengeId)
      }
    }
    const knownOnChainSignatures = metadata?.knownOnChainSignatures || 0
    const effectiveAllowDuringMigration =
      recoveryStatus === 'migrating' && allowDuringMigration
    const budgetWithChallenge = (
      challenge: QbitRestoredFloorSigningChallenge
    ): QbitSignatureBudgetImpact => ({
      ...budget,
      restoredFloorRisk: {
        recoveryStatus: 'seed-only-restored',
        counterConfidence: 'chain-floor-only',
        knownOnChainSignatures: challenge.knownOnChainSignatures,
        challengeId: challenge.id,
      },
    })
    // Signing consumes a challenge, so handing the same one to two requests
    // makes the second confirmation fail as expired. Reuse is therefore
    // limited to re-preflights of the same resumable operation.
    if (reuseScope !== undefined) {
      for (const challenge of this.qbitRestoredFloorSigningChallenges.values()) {
        const matchesExactRequest =
          challenge.reuseScope === reuseScope &&
          challenge.pubkey === pubkey &&
          challenge.knownOnChainSignatures === knownOnChainSignatures &&
          challenge.allowDuringMigration === effectiveAllowDuringMigration &&
          (challenge.migrationConsolidation === true) ===
            (effectiveAllowDuringMigration && migrationConsolidation) &&
          challenge.cacheKeys.length === cacheKeys.length &&
          challenge.cacheKeys.every((cacheKey, index) => cacheKey === cacheKeys[index])
        if (matchesExactRequest) return budgetWithChallenge(challenge)
      }
    }
    if (this.qbitRestoredFloorSigningChallenges.size >= QBIT_RESTORED_FLOOR_CHALLENGE_CAPACITY) {
      throw new QbitRestoredFloorConfirmationError(
        this.t('qbit_recovery_secure_confirmation_unavailable')
      )
    }

    const nonce = new Uint8Array(16)
    const webCrypto = (
      globalThis as unknown as {
        crypto?: { getRandomValues<T extends Uint8Array>(values: T): T }
      }
    ).crypto
    if (!webCrypto) {
      throw new QbitRestoredFloorConfirmationError(
        this.t('qbit_recovery_secure_confirmation_unavailable')
      )
    }
    webCrypto.getRandomValues(nonce)
    const id = bytesToHex(nonce)
    const challenge: QbitRestoredFloorSigningChallenge = {
      id,
      pubkey,
      cacheKeys: [...cacheKeys],
      knownOnChainSignatures,
      expiresAt: now + QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS,
      confirmed: false,
      allowDuringMigration: effectiveAllowDuringMigration,
      ...(effectiveAllowDuringMigration && migrationConsolidation
        ? { migrationConsolidation: true }
        : {}),
      ...(reuseScope === undefined ? {} : { reuseScope }),
    }
    this.qbitRestoredFloorSigningChallenges.set(id, challenge)
    return budgetWithChallenge(challenge)
  }

  confirmQbitRestoredFloorSigning = async (challengeId: string): Promise<void> => {
    const challenge = this.qbitRestoredFloorSigningChallenges.get(challengeId)
    if (!challenge || challenge.expiresAt < Date.now()) {
      this.qbitRestoredFloorSigningChallenges.delete(challengeId)
      throw new QbitRestoredFloorConfirmationError(
        this.t('qbit_recovery_signing_confirmation_expired')
      )
    }
    challenge.confirmed = true
  }

  private validateQbitRestoredFloorSigningChallenge = async (
    keyring: Keyring,
    pubkey: string,
    cacheKeys: readonly string[],
    expectedBudget?: QbitSignatureBudgetImpact
  ): Promise<string | undefined> => {
    const metadata = await keyring.getPqcSignatureCounterMetadata?.(pubkey)
    const recoveryStatus =
      metadata === undefined
        ? undefined
        : this.qbitSigningRecoveryStatus(keyring, metadata.recoveryStatus)
    const restored =
      !metadata || metadata.provenance === 'restored-floor' || recoveryStatus !== 'clean'
    if (!restored) return undefined
    if (recoveryStatus === 'migrated') {
      throw new QbitRestoredFloorConfirmationError(this.t('qbit_recovery_archived_signing_blocked'))
    }

    const challengeId = expectedBudget?.restoredFloorRisk?.challengeId
    const challenge =
      typeof challengeId === 'string'
        ? this.qbitRestoredFloorSigningChallenges.get(challengeId)
        : undefined
    if (challengeId && challenge && challenge.expiresAt < Date.now()) {
      this.qbitRestoredFloorSigningChallenges.delete(challengeId)
    }
    if (
      recoveryStatus === 'migrating' &&
      (challenge?.allowDuringMigration !== true ||
        (challenge.migrationConsolidation === true && qbitRecoveryPlanOpenFor(keyring, pubkey)))
    ) {
      if (challengeId) this.qbitRestoredFloorSigningChallenges.delete(challengeId)
      throw new QbitRestoredFloorConfirmationError(
        this.t('qbit_recovery_migration_signing_only')
      )
    }
    const matches =
      challenge?.confirmed === true &&
      challenge.expiresAt >= Date.now() &&
      challenge.pubkey === pubkey &&
      challenge.knownOnChainSignatures === (metadata?.knownOnChainSignatures || 0) &&
      challenge.cacheKeys.length === cacheKeys.length &&
      challenge.cacheKeys.every((cacheKey, index) => cacheKey === cacheKeys[index])
    if (!matches || !challengeId) {
      throw new QbitRestoredFloorConfirmationError(
        this.t('qbit_recovery_signing_confirmation_required')
      )
    }
    return challengeId
  }

  private consumeQbitRestoredFloorSigningChallenge = (challengeId?: string): void => {
    if (challengeId) {
      this.qbitRestoredFloorSigningChallenges.delete(challengeId)
    }
  }

  /**
   * Release challenges whose approval was rejected or cancelled, so abandoned
   * preflights cannot pin capacity for the full TTL and starve later requests.
   */
  releaseQbitRestoredFloorSigningChallenges = (challengeIds: readonly string[]): void => {
    for (const challengeId of challengeIds) {
      this.qbitRestoredFloorSigningChallenges.delete(challengeId)
    }
  }

  private getPqcSignatureBudgetLocked = async (
    keyring: Keyring,
    pubkey: string,
    cacheKeys: readonly string[]
  ): Promise<QbitSignatureBudgetImpact> => {
    if (!keyring.assertPqcSignatureCounterAvailable || !keyring.getPqcSignatureCounter) {
      throw new Error(this.t('not_supported'))
    }
    if (keyring.pqcFloorsPending) {
      await keyring.assertPqcSignatureCounterAvailable(pubkey, 1)
    }
    const required = keyring.estimatePqcSignatureCacheMisses
      ? await keyring.estimatePqcSignatureCacheMisses(pubkey, cacheKeys)
      : cacheKeys.length
    if (required > 0) {
      await keyring.assertPqcSignatureCounterAvailable(pubkey, required)
    }
    const counter = await keyring.getPqcSignatureCounter(pubkey)
    const remainingBefore = Math.max(0, PQC_MAX_SIGNATURES - counter)
    return {
      required,
      cached: Math.max(0, cacheKeys.length - required),
      remainingBefore,
      remainingAfter: Math.max(0, remainingBefore - required),
      limit: PQC_MAX_SIGNATURES,
    }
  }

  private assertExpectedPqcSignatureBudget(
    expected: QbitSignatureBudgetImpact | undefined,
    actual: QbitSignatureBudgetImpact,
    approvedBatchDuplicate = false
  ) {
    if (!expected) return
    // Signatures approved for an entry of one signPsbts batch that carries a
    // duplicated PSBT may be signed and cached by another entry of that batch
    // first — entries sign in any order — shifting approved signatures from
    // required to cached without changing the approved outcome: the same signature bytes are produced and the
    // counter still ends at the approved remainingAfter. Only a caller that
    // is signing such a batch duplicate may accept that shift; everywhere
    // else — including a replay of an already-signed approval — any drift
    // means the user approved a different impact than would occur.
    const requiredBecameCached = expected.required - actual.required
    const shiftTolerance = approvedBatchDuplicate
      ? requiredBecameCached >= 0
      : requiredBecameCached === 0
    const matches =
      actual.limit === expected.limit &&
      actual.remainingAfter === expected.remainingAfter &&
      shiftTolerance &&
      actual.required + actual.cached === expected.required + expected.cached &&
      actual.remainingBefore === expected.remainingBefore - requiredBecameCached
    if (!matches) {
      throw new Error('P2MR signature budget changed after approval')
    }
  }

  private signPqcDigestWithCounterTargetUnlocked = async (
    { keyring, pubkey }: { keyring: Keyring; pubkey: string },
    signingInput: QbitPqcSigningInput,
    signer: (context: QbitPqcCounteredSignerContext) => Promise<QbitPqcSignatureBytes>,
    expectedBudget?: QbitSignatureBudgetImpact,
    restoredFloorRiskAlreadyAuthorized = false
  ): Promise<QbitPqcCounteredSignature> => {
    // The target was resolved before this counter lock was taken. A lock and
    // unlock since then detached it, and its reservation would never persist.
    this.assertLiveKeyrings([keyring])
    const digest = normalizeSigningInput(signingInput)
    const cacheKey = pqcSignatureCacheKey(digest)
    const budget = await this.getPqcSignatureBudgetLocked(keyring, pubkey, [cacheKey])
    this.assertExpectedPqcSignatureBudget(expectedBudget, budget)
    const restoredFloorChallengeId = restoredFloorRiskAlreadyAuthorized
      ? undefined
      : await this.validateQbitRestoredFloorSigningChallenge(
          keyring,
          pubkey,
          [cacheKey],
          expectedBudget
        )
    const cached = await keyring.getPqcSignatureCacheEntry?.(pubkey, cacheKey)
    if (cached) {
      const signature = hexToBytes(cached.signatureHex)
      assertPqcSignatureBytes(signature)
      this.consumeQbitRestoredFloorSigningChallenge(restoredFloorChallengeId)
      return {
        pubkey,
        cacheKey,
        signature,
        cached: true,
        counter: null,
      }
    }

    const reservation = await keyring.reservePqcSignatureCounter!(pubkey, 1)
    try {
      // Fails unless the keyring is still live when the write commits, so a
      // signature is only released once the vault holds its reservation.
      await this.persistPqcSignatureCounterState([keyring])
    } catch (error) {
      await this.rollbackPqcSignatureCounterReservation(keyring, pubkey, reservation)
      throw error
    }

    const signature = normalizePqcSignatureBytes(
      await signer({
        pubkey,
        cacheKey,
        digest: new Uint8Array(digest),
        reservation,
      })
    )

    if (keyring.cachePqcSignature) {
      await keyring.cachePqcSignature(
        pubkey,
        cacheKey,
        bytesToHex(signature),
        reservation.newCounter
      )
      await this.persistPqcSignatureCounterState([keyring])
    }

    this.consumeQbitRestoredFloorSigningChallenge(restoredFloorChallengeId)
    return {
      pubkey,
      cacheKey,
      signature,
      cached: false,
      counter: reservation,
    }
  }

  private signPqcDigestWithCounterTarget = async (
    target: { keyring: Keyring; pubkey: string },
    signingInput: QbitPqcSigningInput,
    signer: (context: QbitPqcCounteredSignerContext) => Promise<QbitPqcSignatureBytes>,
    expectedBudget?: QbitSignatureBudgetImpact
  ): Promise<QbitPqcCounteredSignature> => {
    return this.pqcSignatureCounterMutex.lock(target.pubkey, () =>
      this.signPqcDigestWithCounterTargetUnlocked(target, signingInput, signer, expectedBudget)
    )
  }

  signPqcDigestWithCounter = async (
    address: string,
    signingInput: QbitPqcSigningInput,
    signer: (context: QbitPqcCounteredSignerContext) => Promise<QbitPqcSignatureBytes>
  ): Promise<QbitPqcCounteredSignature> => {
    const target = await this.getPqcSignatureCounterTarget(address)
    return this.signPqcDigestWithCounterTarget(target, signingInput, signer)
  }

  preflightP2mrMessageSigning = async (
    address: string,
    datasigHashes: readonly QbitPqcSigningInput[]
  ): Promise<QbitSignatureBudgetImpact> => {
    const target = await this.getPqcSignatureCounterTarget(address)
    const { keyring, pubkey } = target
    if (!keyring.assertPqcSignatureCounterAvailable) {
      throw new Error(this.t('not_supported'))
    }

    const cacheKeys = datasigHashes.map(hash => pqcSignatureCacheKey(normalizeSigningInput(hash)))
    return this.pqcSignatureCounterMutex.lock(pubkey, async () => {
      this.assertLiveKeyrings([keyring])
      const budget = await this.getPqcSignatureBudgetLocked(keyring, pubkey, cacheKeys)
      return this.issueQbitRestoredFloorSigningChallenge(keyring, pubkey, cacheKeys, budget)
    })
  }

  preflightP2mrPsbtSigning = async (
    address: string,
    { psbt, keys }: QbitP2mrPsbtCounteredSigningInput,
    options?: {
      allowMigrationProtectedAssetTransfer?: boolean
      allowMigrationConsolidation?: boolean
      reuseScope?: string
    }
  ): Promise<QbitSignatureBudgetImpact> => {
    const psbtSnapshot = clonePsbt(psbt)
    const keySnapshots = keys.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: key.pubkey.slice(),
      leafHash: key.leafHash.slice(),
      ...(key.hashType === undefined ? {} : { hashType: key.hashType }),
    }))
    const target = await this.getPqcSignatureCounterTarget(address)
    const { keyring, pubkey } = target
    if (!keyring.assertPqcSignatureCounterAvailable) {
      throw new Error(this.t('not_supported'))
    }

    validateP2mrSigningPlans({ psbt: psbtSnapshot, keys: keySnapshots })
    assertP2mrPsbtWithinStandardWeight(psbtSnapshot, keySnapshots)
    if (keySnapshots.some(key => bytesToHex(key.pubkey) !== pubkey)) {
      throw new Error('P2MR signing key does not match the selected account')
    }

    const tx = psbtUnsignedTransaction(psbtSnapshot)
    const spentOutputs = p2mrSpentOutputsFromPsbt(psbtSnapshot)
    const cacheKeys = keySnapshots.map(key => {
      const sighash = p2mrSighash({
        tx,
        inputIndex: key.inputIndex,
        spentOutputs,
        leafHash: key.leafHash,
        hashType: key.hashType ?? SIGHASH_DEFAULT,
      })
      return pqcSignatureCacheKey(sighash)
    })

    return this.pqcSignatureCounterMutex.lock(pubkey, async () => {
      this.assertLiveKeyrings([keyring])
      const budget = await this.getPqcSignatureBudgetLocked(keyring, pubkey, cacheKeys)
      const recoveryState = keyring.getQbitRecoveryState?.() as QbitRecoveryVaultState | undefined
      const serializedPsbt = bytesToHex(serializePsbt(psbtSnapshot))
      const isReviewedMigration = Object.values(recoveryState?.networks ?? {}).some(
        record =>
          record?.status === 'migrating' &&
          record.migration?.plans.some(
            plan =>
              plan.status === 'prepared' &&
              plan.sourcePubkey === pubkey &&
              plan.psbtHex === serializedPsbt
          ) === true
      )
      // This option is a trusted controller assertion, not provider input. The
      // controller grants it only after recomputing that this exact PSBT spends
      // a currently protected wallet UTXO.
      const isReviewedProtectedAssetTransfer =
        keyring.effectiveQbitRecoveryStatus?.() === 'migrating' &&
        options?.allowMigrationProtectedAssetTransfer === true
      // Also a trusted controller assertion: the controller grants it only
      // to a consolidation batch of a source whose outputs a migration cannot
      // read to plan them (#344). It holds only for a transaction that pays
      // all it spends, less a fee within the wallet's fee-rate ceiling, back
      // to the same script, while no plan of the source is open. So funds
      // still leave the source only through a plan, and no plan's inputs are
      // spent under it.
      const isSourceConsolidation =
        options?.allowMigrationConsolidation === true &&
        isP2mrSelfConsolidation(psbtSnapshot, tx, spentOutputs, keySnapshots) &&
        !qbitRecoveryPlanOpenFor(keyring, pubkey)
      return this.issueQbitRestoredFloorSigningChallenge(
        keyring,
        pubkey,
        cacheKeys,
        budget,
        isReviewedMigration || isReviewedProtectedAssetTransfer || isSourceConsolidation,
        options?.reuseScope,
        isSourceConsolidation
      )
    })
  }

  /**
   * Sign a precomputed P2MR message data-signature digest through the guarded
   * PQC cache/counter path. Message-domain hashing remains in the protocol and
   * wallet layers; this service accepts only the final 32-byte digest.
   */
  signP2mrMessageWithCounter = async (
    address: string,
    datasigHash: QbitPqcSigningInput,
    expectedBudget?: QbitSignatureBudgetImpact
  ): Promise<QbitPqcCounteredSignature> => {
    const target = await this.getPqcSignatureCounterTarget(address)
    const { keyring } = target
    if (!keyring.signPqcDigest) {
      throw new Error(this.t('not_supported'))
    }

    return this.signPqcDigestWithCounterTarget(
      target,
      datasigHash,
      context => keyring.signPqcDigest!(context.pubkey, context.digest),
      expectedBudget
    )
  }

  signP2mrPsbtWithCounter = async (
    address: string,
    { psbt, keys }: QbitP2mrPsbtCounteredSigningInput,
    expectedBudget?: QbitSignatureBudgetImpact,
    // Set only when the same approved signPsbts batch carries this request's
    // PSBT more than once: whichever duplicate signs first may cache the
    // approved signatures for the others, in any order.
    approvedBatchDuplicate = false
  ): Promise<QbitP2mrPsbtCounteredSignatureResult> => {
    const psbtSnapshot = clonePsbt(psbt)
    const keySnapshots = keys.map(key => ({
      inputIndex: key.inputIndex,
      pubkey: key.pubkey.slice(),
      leafHash: key.leafHash.slice(),
      ...(key.hashType === undefined ? {} : { hashType: key.hashType }),
    }))
    const target = await this.getPqcSignatureCounterTarget(address)
    const { keyring, pubkey } = target
    if (!keyring.signPqcDigest) {
      throw new Error(this.t('not_supported'))
    }

    validateP2mrSigningPlans({ psbt: psbtSnapshot, keys: keySnapshots })
    assertP2mrPsbtWithinStandardWeight(psbtSnapshot, keySnapshots)
    const keyPubkeys = keySnapshots.map(key => bytesToHex(key.pubkey))
    if (keyPubkeys.some(keyPubkey => keyPubkey !== pubkey)) {
      throw new Error('P2MR signing key does not match the selected account')
    }

    const tx = psbtUnsignedTransaction(psbtSnapshot)
    const spentOutputs = p2mrSpentOutputsFromPsbt(psbtSnapshot)
    const signingPlans = keySnapshots.map((key, index) => {
      const hashType = key.hashType ?? SIGHASH_DEFAULT
      const sighash = p2mrSighash({
        tx,
        inputIndex: key.inputIndex,
        spentOutputs,
        leafHash: key.leafHash,
        hashType,
      })
      return {
        key,
        keyPubkey: keyPubkeys[index]!,
        hashType,
        sighash,
        preSignedKey: p2mrPreSignedSignatureKey(key.inputIndex, key.pubkey, key.leafHash, sighash),
      }
    })
    return this.pqcSignatureCounterMutex.lock(pubkey, async () => {
      this.assertLiveKeyrings([keyring])
      const budget = await this.getPqcSignatureBudgetLocked(
        keyring,
        pubkey,
        signingPlans.map(plan => pqcSignatureCacheKey(plan.sighash))
      )
      this.assertExpectedPqcSignatureBudget(expectedBudget, budget, approvedBatchDuplicate)
      const restoredFloorChallengeId = await this.validateQbitRestoredFloorSigningChallenge(
        keyring,
        pubkey,
        signingPlans.map(plan => pqcSignatureCacheKey(plan.sighash)),
        expectedBudget
      )

      const preSigned = new Map<string, Uint8Array>()
      const counterResults: QbitP2mrPsbtCounterResult[] = []
      for (const { key, keyPubkey, hashType, sighash, preSignedKey } of signingPlans) {
        const countered = await this.signPqcDigestWithCounterTargetUnlocked(
          target,
          sighash,
          context => keyring.signPqcDigest!(context.pubkey, context.digest),
          undefined,
          true
        )
        preSigned.set(preSignedKey, countered.signature)
        counterResults.push({
          inputIndex: key.inputIndex,
          pubkey: keyPubkey,
          leafHash: bytesToHex(key.leafHash),
          hashType,
          cacheKey: countered.cacheKey,
          cached: countered.cached,
          counter: countered.counter,
        })
      }

      const signed = signP2mrPsbt({
        psbt: psbtSnapshot,
        keys: keySnapshots,
        sign: (sighash, context) => {
          const preSignedKey = p2mrPreSignedSignatureKey(
            context.inputIndex,
            context.pubkey,
            context.leafHash,
            sighash
          )
          const signature = preSigned.get(preSignedKey)
          if (!signature) {
            throw new Error('missing pre-signed P2MR signature')
          }
          return new Uint8Array(signature)
        },
      })

      this.consumeQbitRestoredFloorSigningChallenge(restoredFloorChallengeId)
      return {
        psbt: signed.psbt,
        signed: signed.signed,
        counterResults,
      }
    })
  }

  /**
   *
   * Remove Account
   *
   * Removes a specific account from a keyring
   * If the account is the last/only one then it also removes the keyring.
   *
   * @param {string} address - The address of the account to remove.
   * @returns {Promise<void>} A Promise that resolves if the operation was successful.
   */
  removeAccount = async (address: string, type: string, brand?: string): Promise<any> =>
    // Same protection as addNewAccount: the rollback below must not straddle
    // a password commit, and the PQC counter locks freeze the keyring's
    // counter, provenance, cache, and floor state while the rollback snapshot
    // is live.
    this.passwordChangeMutex.lock(async () => {
      const keyring = await this.getKeyringForAccount(address, type)

      // Not all the keyrings support this, so we have to check
      if (typeof keyring.removeAccount != 'function') {
        throw new Error(
          `Keyring ${keyring.type} ${this.t('does_not_support_account_removal_operations')}`
        )
      }

      const lockPubkeys = await this.getAccountMutationLockPubkeys(keyring)
      return this.lockPqcSignatureCounterPubkeys(lockPubkeys, async () => {
        // The keyring was resolved before these locks; a lock and unlock
        // while they were queued detached it.
        this.assertLiveKeyrings([keyring])
        const keyrings = this.keyrings
        const keyringIndex = keyrings.indexOf(keyring)
        const rollbackSnapshot = structuredClone(await keyring.serialize())
        const { keyring: rollbackKeyring } = await this._restoreKeyring({
          type: keyring.type,
          data: structuredClone(rollbackSnapshot),
          addressType: this.addressTypes[keyringIndex],
        })

        keyring.removeAccount(address)
        this.cachedDisplayedKeyring = null

        try {
          await this.persistAllKeyrings([keyring])
        } catch (error) {
          this.rollbackAccountMutation(keyringIndex, keyring, rollbackSnapshot, rollbackKeyring)
          await this.persistMutationRollback('account-removal', keyrings)
          throw error
        }

        this.emit('removedAccount', address)
        await this._updateMemStoreKeyrings()
        await this.fullUpdate()
      })
    })

  removeKeyring = async (keyringIndex: number): Promise<any> =>
    this.passwordChangeMutex.lock(async () => {
      const keyrings = this.keyrings
      const previousKeyring = keyrings[keyringIndex] as Keyring | undefined
      if (!previousKeyring) {
        throw new Error(this.t('no_keyring_found_for_the_requested_account'))
      }

      const emptyKeyring = new EmptyKeyring()
      delete keyrings[keyringIndex]
      keyrings[keyringIndex] = emptyKeyring
      this.cachedDisplayedKeyring = null

      try {
        await this.persistAllKeyrings([emptyKeyring])
      } catch (error) {
        // A lock during the write replaced the live keyrings.
        if (this.keyrings === keyrings) {
          keyrings[keyringIndex] = previousKeyring
        }
        await this.persistMutationRollback('keyring-removal', keyrings)
        throw error
      }

      await this._updateMemStoreKeyrings()
      await this.fullUpdate()
    })

  //
  // SIGNING METHODS
  //

  /** Sign a transaction with the selected keyring. */
  signTransaction = (keyring: Keyring, psbt: transactionCore.Psbt, inputs: ToSignInput[]) => {
    return keyring.signTransaction(psbt, inputs)
  }

  /**
   * Sign Message
   *
   * Attempts to sign the provided message parameters.
   */
  signMessage = async (address: string, keyringType: string, data: string) => {
    const keyring = await this.getKeyringForAccount(address, keyringType)
    const sig = await keyring.signMessage(address, data)
    return sig
  }

  /**
   * Decrypt Message
   *
   * Attempts to verify the provided message parameters.
   */
  verifyMessage = async (address: string, data: string, sig: string) => {
    const keyring = await this.getKeyringForAccount(address)
    const result = await keyring.verifyMessage(address, data, sig)
    return result
  }

  //
  // PRIVATE METHODS
  //

  private serializeLiveKeyrings = async () => {
    const entries = this.keyrings.map((keyring, index) => ({
      keyring,
      addressType: this.addressTypes[index],
    }))

    return Promise.all(
      entries.map(async ({ keyring, addressType }) => ({
        type: keyring.type,
        data: await keyring.serialize(),
        addressType,
      }))
    )
  }

  /**
   * A lock replaces the live keyrings, an unlock loads new instances from the
   * vault, and a keyring removal or rollback swaps one out. A keyring resolved
   * before any of these is detached: persistAllKeyrings serializes only the live list,
   * so a change made to it never reaches the vault. Refuse such a change
   * instead of reporting it as saved.
   */
  private assertLiveKeyrings = (keyrings: readonly Keyring[]): void => {
    if (keyrings.some(keyring => !this.keyrings.includes(keyring))) {
      throw new Error('The keyring was locked, removed or replaced while this operation was in progress')
    }
  }

  /**
   * Persist All Keyrings
   *
   * Iterates the current `keyrings` array,
   * serializes each one into a serialized array,
   * encrypts that array with the current password,
   * and persists that encrypted string to storage.
   *
   * @param changedKeyrings - The keyrings whose changes this write commits.
   *   The write fails, without committing, if any of them is no longer live
   *   once it reaches the persistence queue. Required, so that no caller can
   *   skip the check by omission; pass [] only for a write with no change.
   * @returns {Promise<boolean>} Resolves to true once keyrings are persisted.
   */
  persistAllKeyrings = (changedKeyrings: readonly Keyring[]): Promise<boolean> =>
    this.persistenceMutex.lock(async () => {
      // A lock can land while the keyrings serialize or encrypt. The write
      // still commits the keyrings it captured, under the password it checked.
      const password = this.password
      if (!password || typeof password !== 'string') {
        throw new Error(this.t('keyringcontroller_password_is_not_a_string'))
      }
      // A lock and unlock while this write waited in the queue leave a
      // password set beside new keyring instances. The live list is captured
      // synchronously below, so a keyring that passes here is serialized.
      this.assertLiveKeyrings(changedKeyrings)
      const booted = this.store.getState().booted
      const serializedKeyrings = await this.serializeLiveKeyrings()
      const encryptedString = await this.encryptor.encrypt(
        password,
        serializedKeyrings as unknown as Buffer
      )
      // A reset (and any new wallet booted after it) replaces the password
      // verifier; committing then would bring the wiped vault back.
      if (this.store.getState().booted !== booted) {
        throw new Error('The wallet was reset while this write was in progress')
      }
      this.store.updateState({ vault: encryptedString })
      await this.persistStoreState(this.store.getState())
      return true
    })

  /**
   * Re-persist the live keyrings after a failed mutation has been undone on
   * them. A rollback must never write back a vault snapshot taken before the
   * mutation: a signature on another account can persist its PQC counter and
   * signature cache while the mutation's write is pending, and the snapshot
   * would durably rewind them (signature reuse). The live keyrings carry every
   * such advance, so persisting them undoes only the failed mutation. If this
   * write fails too, the store keeps the newest vault a write built and the
   * live keyrings stay authoritative for the next successful persist.
   *
   * `keyrings` is the live list the mutation started from. A lock replaces
   * that list, and a session unlocked after it never saw the undo, so the
   * rollback does not persist it.
   */
  private persistMutationRollback = async (
    operation: string,
    keyrings: Keyring[]
  ): Promise<void> => {
    this.cachedDisplayedKeyring = null
    try {
      // Skips a session already replaced; the write re-checks once it holds
      // persistenceMutex, so a lock and unlock while it queues fails it too.
      if (this.keyrings === keyrings) {
        await this.persistAllKeyrings(keyrings)
      }
    } catch (rollbackError) {
      this.logger?.error?.(
        `[KeyringService] Failed to persist ${operation} rollback`,
        rollbackError
      )
    }
    try {
      await this._updateMemStoreKeyrings()
      this.fullUpdate()
    } catch (rollbackError) {
      this.logger?.error?.(
        `[KeyringService] Failed to refresh ${operation} rollback`,
        rollbackError
      )
    }
  }

  /**
   * Unlock Keyrings
   *
   * Attempts to unlock the persisted encrypted storage,
   * initializing the persisted keyrings to RAM.
   *
   * The vault is read under persistenceMutex, decrypted and restored into
   * local arrays, and the live keyrings are replaced in one step.
   * persistAllKeyrings serializes whatever `keyrings` holds, so emptying or
   * filling the live list in place would let a vault write during the decrypt
   * or the restore loop durably commit an empty or partial vault. A failed
   * decrypt or restore leaves the live keyrings untouched.
   *
   * @param {string} password - The keyring controller password.
   * @returns {Promise<Array<Keyring>>} The keyrings.
   */
  unlockKeyrings = async (password: string): Promise<any[]> => {
    await this.persistenceMutex.lock(() => this.loadVaultKeyrings(password))
    await this._updateMemStoreKeyrings()
    return this.keyrings
  }

  /**
   * Decrypts the vault and restores its keyrings into local arrays, then
   * replaces the live keyrings in one step. Callers hold persistenceMutex, so
   * no keyring persist commits between the read and the swap.
   */
  private loadVaultKeyrings = async (password: string): Promise<void> => {
    for (let attempt = 0; attempt < UNLOCK_VAULT_READ_ATTEMPTS; attempt += 1) {
      const encryptedVault = this.store.getState().vault
      if (!encryptedVault) {
        throw new Error(this.t('cannot_unlock_without_a_previous_vault'))
      }
      // A reset or a rollback that replaced the vault during this read is
      // newer than the snapshot; publishing the snapshot would let the next
      // persist undo it, so read the vault again.
      const vaultChanged = () => this.store.getState().vault !== encryptedVault

      const vault = await this.encryptor.decrypt(password, encryptedVault)
      if (vaultChanged()) {
        continue
      }

      const keyrings: Keyring[] = []
      const addressTypes: AddressType[] = []
      for (const serialized of Array.from(vault)) {
        const { keyring, addressType } = await this._restoreKeyring(serialized)
        keyrings.push(keyring)
        addressTypes.push(addressType)
      }
      if (vaultChanged()) {
        continue
      }

      this.keyrings = keyrings
      this.addressTypes = addressTypes
      this.cachedDisplayedKeyring = null
      return
    }

    // Each read costs a full key derivation and keyring restore; stop instead
    // of chasing a vault that keeps changing.
    throw new Error('Vault changed during every unlock attempt; try again')
  }

  /**
   * Restore Keyring
   *
   * Attempts to initialize a new keyring from the provided serialized payload.
   * On success, updates the memStore keyrings and returns the resulting
   * keyring instance.
   *
   * @param {Object} serialized - The serialized keyring.
   * @returns {Promise<Keyring>} The deserialized keyring.
   */
  restoreKeyring = async (serialized: any) => {
    const { keyring } = await this._restoreKeyring(serialized)
    await this._updateMemStoreKeyrings()
    return keyring
  }

  /**
   * Restore Keyring Helper
   *
   * Attempts to initialize a new keyring from the provided serialized payload.
   * On success, returns the resulting keyring instance.
   *
   * @param {Object} serialized - The serialized keyring.
   * @returns {Promise<Keyring>} The deserialized keyring.
   */
  _restoreKeyring = async (
    serialized: any
  ): Promise<{ keyring: Keyring; addressType: AddressType }> => {
    const { type, data, addressType } = serialized
    if (type === KeyringType.Empty) {
      const keyring = new EmptyKeyring()
      return {
        keyring,
        addressType: addressType,
      }
    }

    const Keyring = this.getKeyringClassForType(type)
    if (!Keyring) {
      throw new Error(`Unknown keyring type: ${type}`)
    }
    const keyring = new Keyring()
    await keyring.deserialize(data)

    // getAccounts also validates the accounts for some keyrings
    await keyring.getAccounts()
    return {
      keyring,
      addressType: addressType,
    }
  }

  /**
   * Get Keyring Class For Type
   *
   * Searches the current `keyringTypes` array
   * for a Keyring class whose unique `type` property
   * matches the provided `type`,
   * returning it if it exists.
   *
   * @param {string} type - The type whose class to get.
   * @returns {Keyring|undefined} The class, if it exists.
   */
  getKeyringClassForType = (type: string): KeyringClass | undefined => {
    return this.keyringTypes.find(kr => kr.type === type)
  }

  /**
   * Get Keyrings by Type
   *
   * Gets all keyrings of the given type.
   *
   * @param {string} type - The keyring types to retrieve.
   * @returns {Array<Keyring>} The keyrings.
   */
  getKeyringsByType = (type: string): Keyring[] => {
    return this.keyrings.filter(keyring => keyring.type === type)
  }

  /**
   * Get Accounts
   *
   * Returns the public addresses of all current accounts
   * managed by all currently unlocked keyrings.
   *
   * @returns {Promise<Array<string>>} The array of accounts.
   */
  getAccounts = async (): Promise<string[]> => {
    const keyrings = this.keyrings || []
    let addrs: string[] = []
    for (let i = 0; i < keyrings.length; i++) {
      const keyring = keyrings[i]
      if (!keyring) {
        continue
      }
      const accounts = await keyring.getAccounts()
      addrs = addrs.concat(accounts)
    }
    return addrs
  }

  /**
   * Get Keyring For Account
   *
   * Returns the currently initialized keyring that manages
   * the specified `address` if one exists.
   *
   * @param {string} address - An account address.
   * @returns {Promise<Keyring>} The keyring of the account, if it exists.
   */
  getKeyringForAccount = async (
    address: string,
    type?: string,
    start?: number,
    end?: number,
    includeWatchKeyring = true
  ): Promise<Keyring> => {
    this.logger.debug(`KeyringController - getKeyringForAccount: ${address}`)
    const keyrings = type ? this.keyrings.filter(keyring => keyring.type === type) : this.keyrings
    for (let i = 0; i < keyrings.length; i++) {
      const keyring = keyrings[i]
      if (!keyring) {
        continue
      }
      const accounts = await keyring.getAccounts()
      if (accounts.includes(address)) {
        return keyring
      }
      if (keyring.getIndexByAddress && keyring.getIndexByAddress(address) !== null) {
        return keyring
      }
    }
    throw new Error(this.t('no_keyring_found_for_the_requested_account'))
  }

  /**
   * Wire the wallet's active Qbit network into display snapshots. Without a
   * resolver the snapshot falls back to the collapsed cross-network status,
   * which cannot represent a partially migrated coin type (one sibling
   * archived while another still awaits recovery), so the home card could
   * transiently disagree with the network-scoped authoritative state.
   */
  setActiveQbitNetworkResolver = (resolver: () => string | undefined): void => {
    this.activeQbitNetworkResolver = resolver
  }

  /**
   * Register a hook fired on password mutations. For 'passwordChanged' it
   * runs while changePassword still holds unlockingMutex → passwordChangeMutex,
   * so state derived from the old password (e.g. a biometric-wrapped password
   * blob) is invalidated before any queued unlock runs. 'boot' and 'reset'
   * fire with no mutex held — boot only ever creates a fresh wallet (no vault
   * to race) and resetAllData relies on the consumer's fail-safe (a blob that
   * no longer decrypts or verifies is discarded at use). Hook failures are
   * logged and swallowed: the password mutation is already durably committed
   * and must not be reported as failed.
   */
  setPasswordLifecycleHook = (
    hook: ((event: PasswordLifecycleEvent) => Promise<void> | void) | undefined
  ): void => {
    this.passwordLifecycleHook = hook
  }

  private runPasswordLifecycleHook = async (event: PasswordLifecycleEvent): Promise<void> => {
    if (!this.passwordLifecycleHook) return
    try {
      await this.passwordLifecycleHook(event)
    } catch (error) {
      this.logger?.error?.('[KeyringService] password lifecycle hook failed', event, error)
    }
  }

  private activeQbitDisplayNetwork = (): QbitReceiveNetworkName | undefined => {
    try {
      const network = this.activeQbitNetworkResolver?.()
      return (QBIT_RECOVERY_NETWORKS as readonly string[]).includes(network as string)
        ? (network as QbitReceiveNetworkName)
        : undefined
    } catch {
      // An unavailable preference store must degrade to the collapsed
      // projection, never break the keyring list.
      return undefined
    }
  }

  /**
   * Display For Keyring
   *
   * Is used for adding the current keyrings to the state object.
   * @param {Keyring} keyring
   * @returns {Promise<Object>} A keyring display object, with type and accounts properties.
   */
  displayForKeyring = async (
    keyring: Keyring,
    addressType: AddressType,
    index: number
  ): Promise<DisplayedKeyring> => {
    const accounts = await keyring.getAccounts()
    const all_accounts: { pubkey: string; brandName: string; keyring?: any }[] = []
    const qbitAccounts =
      keyring.type === KeyringType.QbitHdKeyring && (keyring as any).getQbitAccounts
        ? await (keyring as any).getQbitAccounts()
        : undefined
    const displayKeyring = new DisplayKeyring(keyring)
    if (keyring.type === KeyringType.QbitHdKeyring) {
      displayKeyring.qbitRecovery = await this.publicQbitRecoveryState(
        keyring,
        this.activeQbitDisplayNetwork()
      )
    }
    for (let i = 0; i < accounts.length; i++) {
      const pubkey = accounts[i]
      if (!pubkey) continue
      all_accounts.push({
        pubkey,
        brandName: keyring.type,
        keyring: qbitAccounts?.[i],
      })
    }
    return {
      type: keyring.type,
      accounts: all_accounts,
      keyring: displayKeyring,
      addressType,
      index,
    }
  }

  getAllDisplayedKeyrings = async (resetCache?: boolean): Promise<DisplayedKeyring[]> => {
    // The cache is keyed by the active display network: testnet4 and regtest
    // share an HD path, so a network switch between them changes no keyring
    // yet still changes every recovery snapshot the cache holds.
    const activeNetwork = this.activeQbitDisplayNetwork()
    if (
      resetCache ||
      !this.cachedDisplayedKeyring ||
      this.cachedDisplayedKeyringNetwork !== activeNetwork
    ) {
      this.cachedDisplayedKeyring = await Promise.all(
        this.keyrings.map((keyring, index) =>
          this.displayForKeyring(keyring, this.addressTypes[index]!, index)
        )
      )
      this.cachedDisplayedKeyringNetwork = activeNetwork
    }
    return this.cachedDisplayedKeyring
  }

  getAllVisibleAccountsArray = async () => {
    const typedAccounts = await this.getAllDisplayedKeyrings()
    const result: { pubkey: string; type: string; brandName: string }[] = []
    typedAccounts.forEach(accountGroup => {
      result.push(
        ...accountGroup.accounts.map(account => ({
          pubkey: account.pubkey,
          brandName: account.brandName,
          type: accountGroup.type,
        }))
      )
    })

    return result
  }

  getAllPubkeys = async () => {
    const keyrings = await this.getAllDisplayedKeyrings()
    const result: { pubkey: string; type: string; brandName: string }[] = []
    keyrings.forEach(accountGroup => {
      result.push(
        ...accountGroup.accounts.map(account => ({
          pubkey: account.pubkey,
          brandName: account.brandName,
          type: accountGroup.type,
        }))
      )
    })

    return result
  }

  hasPubkey = async (pubkey: string) => {
    const addresses = await this.getAllPubkeys()
    return !!addresses.find(item => item.pubkey === pubkey)
  }

  /**
   * Clear Keyrings
   *
   * Deallocates all currently managed keyrings and accounts by locking the
   * wallet. Emptying the keyrings while the password stays set would let the
   * next vault write durably commit an empty vault. Prefer setLocked().
   */
  clearKeyrings = async (): Promise<void> => {
    await this.setLocked()
  }

  /**
   * Update Memstore Keyrings
   *
   * Updates the in-memory keyrings, without persisting.
   */
  _updateMemStoreKeyrings = async (): Promise<void> => {
    const keyrings = await Promise.all(
      this.keyrings.map((keyring, index) =>
        this.displayForKeyring(keyring, this.addressTypes[index] || AddressType.P2WPKH, index)
      )
    )
    return this.memStore.updateState({ keyrings })
  }

  /**
   * Unlock Keyrings
   *
   * Unlocks the keyrings.
   *
   * @emits KeyringController#unlock
   */
  setUnlocked = () => {
    if (this.pendingLockRequests > 0) {
      return
    }
    this.memStore.updateState({ isUnlocked: true })
    this.emit('unlock')
    if (this.eventBus) {
      this.eventBus.emit(BUS_EVENTS.broadcastToUI, {
        method: BUS_METHODS.UNLOCKED,
        params: {},
      })
    }
  }

  /**
   * Clean up cache to keep only the most recently accessed items
   * Uses LRU (Least Recently Used) strategy to limit cache size
   */
  private cleanupCache = async (cachedPubkeyData: any): Promise<any> => {
    if (!cachedPubkeyData) return cachedPubkeyData

    // Collect all cache entries with their access times
    const allEntries: {
      keyringIndex: string
      derivedIndex: string
      timestamp: number
      data: any
    }[] = []

    for (const keyringIndex in cachedPubkeyData) {
      if (!cachedPubkeyData[keyringIndex]) continue

      for (const derivedIndex in cachedPubkeyData[keyringIndex]) {
        const entry = cachedPubkeyData[keyringIndex][derivedIndex]
        if (entry && typeof entry === 'object') {
          allEntries.push({
            keyringIndex,
            derivedIndex,
            timestamp: entry.timestamp || 0,
            data: entry,
          })
        }
      }
    }

    // If total entries <= MAX_CACHE_ITEMS, no cleanup needed
    if (allEntries.length <= this.MAX_CACHE_ITEMS) {
      return cachedPubkeyData
    }

    // Sort by timestamp descending (most recent first)
    allEntries.sort((a, b) => b.timestamp - a.timestamp)

    // Keep only the most recent MAX_CACHE_ITEMS
    const toKeep = allEntries.slice(0, this.MAX_CACHE_ITEMS)

    // Rebuild cache with only kept items
    const cleanedCache: any = {}
    toKeep.forEach(entry => {
      if (!cleanedCache[entry.keyringIndex]) {
        cleanedCache[entry.keyringIndex] = {}
      }
      cleanedCache[entry.keyringIndex][entry.derivedIndex] = entry.data
    })

    this.logger?.debug(
      `[KeyringService] Cache cleanup: removed ${allEntries.length - toKeep.length} old entries, kept ${toKeep.length}`
    )

    return cleanedCache
  }

  getAllPubkeysByDerivedIndex = async (
    keyring: WalletKeyring,
    derivedIndex: number
  ): Promise<{ pubkey: string; type: AddressType }[]> => {
    const cachedPubkeys: {
      pubkey: string
      type: AddressType
    }[] = []

    let cachedPubkeyData: CachedPubkeyData = await this.storage.get(this.cachedKey)
    if (
      cachedPubkeyData &&
      cachedPubkeyData[keyring.index] &&
      cachedPubkeyData[keyring.index]![derivedIndex]
    ) {
      const cachedEntry = cachedPubkeyData[keyring.index]![derivedIndex]!

      // Update timestamp for LRU
      cachedEntry.timestamp = Date.now()
      await this.storage.set(this.cachedKey, cachedPubkeyData)

      return cachedEntry.data
    }

    const _keyring = this.keyrings[keyring.index]!

    if (_keyring.type === KeyringType.QbitHdKeyring) {
      const accounts = await _keyring.getAccounts()
      const pubkey = accounts[derivedIndex] || ''
      cachedPubkeys.push({
        pubkey,
        type: AddressType.P2MR,
      })
    } else if (_keyring.type === KeyringType.HdKeyring) {
      const pathPubkey: { [path: string]: string } = {}
      ADDRESS_TYPES.filter(v => v.displayIndex >= 0 && v.value !== AddressType.P2MR).forEach(v => {
        let pubkey = pathPubkey[v.hdPath]
        if (!pubkey && _keyring.getAccountByHdPath) {
          pubkey = _keyring.getAccountByHdPath(v.hdPath, derivedIndex)
        }
        cachedPubkeys.push({
          pubkey: pubkey || '',
          type: v.value,
        })
      })
    } else {
      ADDRESS_TYPES.filter(
        v => v.displayIndex >= 0 && v.usesBip44Path === false && v.value !== AddressType.P2MR
      ).forEach(v => {
        const pubkey = keyring.accounts[derivedIndex]!.pubkey
        cachedPubkeys.push({
          pubkey: pubkey || '',
          type: v.value,
        })
      })
    }

    cachedPubkeyData = cachedPubkeyData || {}
    cachedPubkeyData[keyring.index] = cachedPubkeyData[keyring.index] || {}

    // Store with timestamp for LRU tracking
    cachedPubkeyData[keyring.index]![derivedIndex] = {
      data: cachedPubkeys,
      timestamp: Date.now(),
    }

    // Clean up cache to keep only recent items
    cachedPubkeyData = await this.cleanupCache(cachedPubkeyData)

    await this.storage.set(this.cachedKey, cachedPubkeyData)

    return cachedPubkeys
  }
}

interface CachedPubkeyData {
  [keyringIndex: string]: {
    [derivedIndex: string]: {
      data: { pubkey: string; type: AddressType }[]
      timestamp: number
    }
  }
}

const pqcCounterTextEncoder = new TextEncoder()
const PQC_SIGNATURE_BYTES = 3680
const PQC_SIGNATURE_CACHE_DOMAIN = pqcCounterTextEncoder.encode(
  'qbit-wallet-pqc-signature-cache-v1'
)

function pqcSignatureCacheKey(digest: Uint8Array): string {
  assertPqcDigestBytes(digest)
  return bytesToHex(sha256(concatBytes(PQC_SIGNATURE_CACHE_DOMAIN, digest)))
}

function normalizeSigningInput(signingInput: QbitPqcSigningInput): Uint8Array {
  const digest =
    typeof signingInput === 'string' ? hexToBytes(signingInput) : new Uint8Array(signingInput)
  assertPqcDigestBytes(digest)
  return digest
}

function assertPqcDigestBytes(digest: Uint8Array): void {
  if (digest.length !== 32) {
    throw new Error('PQC signing input must be a 32-byte digest')
  }
}

function normalizePqcSignatureBytes(signature: QbitPqcSignatureBytes): Uint8Array {
  const bytes = typeof signature === 'string' ? hexToBytes(signature) : new Uint8Array(signature)
  assertPqcSignatureBytes(bytes)
  return bytes
}

function assertPqcSignatureBytes(signature: Uint8Array): void {
  if (signature.length !== PQC_SIGNATURE_BYTES) {
    throw new Error(
      `PQC signer returned ${signature.length} bytes, expected ${PQC_SIGNATURE_BYTES}`
    )
  }
}

/**
 * Whether `keys` sign every input of `tx`, every output pays the one script
 * all of them spend, and the fee is no more than the wallet's highest fee
 * rate would charge for its signed size: a consolidation that leaves the
 * funds where they were, less a fee.
 */
function isP2mrSelfConsolidation(
  psbt: Psbt,
  tx: P2mrTransaction,
  spentOutputs: readonly P2mrSpentOutput[],
  keys: readonly { inputIndex: number; hashType?: number }[]
): boolean {
  const script = spentOutputs[0] && bytesToHex(spentOutputs[0].scriptPubKey)
  const signed = new Set(keys.map(key => key.inputIndex))
  if (
    script === undefined ||
    tx.outputs.length === 0 ||
    !spentOutputs.every(
      (output, index) => signed.has(index) && bytesToHex(output.scriptPubKey) === script
    ) ||
    !tx.outputs.every(output => bytesToHex(output.scriptPubKey) === script)
  ) {
    return false
  }
  const fee =
    spentOutputs.reduce((sum, output) => sum + output.value, 0n) -
    tx.outputs.reduce((sum, output) => sum + output.value, 0n)
  return (
    fee >= 0n && fee <= BigInt(p2mrSignedSizeFloor(psbt, keys)) * BigInt(QBIT_MAX_FEE_RATE)
  )
}

/** Whether a migration holds a plan of `pubkey`, on any network, that has not confirmed. */
function qbitRecoveryPlanOpenFor(keyring: Keyring, pubkey: string): boolean {
  const recoveryState = keyring.getQbitRecoveryState?.() as QbitRecoveryVaultState | undefined
  return Object.values(recoveryState?.networks ?? {}).some(
    record =>
      record?.status === 'migrating' &&
      record.migration?.plans.some(
        plan => plan.sourcePubkey === pubkey && plan.status !== 'confirmed'
      ) === true
  )
}

function p2mrSpentOutputsFromPsbt(psbt: Psbt): P2mrSpentOutput[] {
  return decodePsbt(psbt).inputs.map((input, index) => {
    if (!input.witnessUtxo) {
      throw new Error(`P2MR PSBT input ${index} is missing a witness UTXO`)
    }
    return {
      value: input.witnessUtxo.value,
      scriptPubKey: new Uint8Array(input.witnessUtxo.scriptPubKey),
    }
  })
}

/**
 * Refuse, before any counter is reserved, a PSBT whose signed transaction
 * cannot fit qbit Core's standard weight (its serialized size, with no
 * witness discount): no node relays it, so its signatures would be spent for
 * nothing. The size counted is a floor: the unsigned transaction plus, for
 * each input this request signs, a witness of its signatures and its
 * smallest leaf script and control block, and an empty witness for every
 * other input. For a single-key spend that floor is exact.
 */
function assertP2mrPsbtWithinStandardWeight(
  psbt: Psbt,
  keys: readonly { inputIndex: number; hashType?: number }[]
): void {
  if (p2mrSignedSizeFloor(psbt, keys) > QBIT_MAX_STANDARD_TX_WEIGHT) {
    throw new Error(
      `P2MR transaction would exceed the standard size of ${QBIT_MAX_STANDARD_TX_WEIGHT} vB once signed`
    )
  }
}

/** The floor `assertP2mrPsbtWithinStandardWeight` describes, in vB. */
function p2mrSignedSizeFloor(
  psbt: Psbt,
  keys: readonly { inputIndex: number; hashType?: number }[]
): number {
  const unsignedTx = psbt.global.find(
    entry => entry.key.length === 1 && entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX
  )
  if (!unsignedTx) {
    throw new Error('P2MR PSBT is missing its unsigned transaction')
  }
  const summary = decodePsbt(psbt)
  const signatureLengths = new Map<number, number[]>()
  for (const key of keys) {
    const explicitHashType = (key.hashType ?? SIGHASH_DEFAULT) !== SIGHASH_DEFAULT
    const lengths = signatureLengths.get(key.inputIndex) ?? []
    lengths.push(PQC_SIGNATURE_BYTES + (explicitHashType ? 1 : 0))
    signatureLengths.set(key.inputIndex, lengths)
  }
  // Segwit marker and flag.
  let size = unsignedTx.value.length + 2
  summary.inputs.forEach((input, inputIndex) => {
    const signatures = signatureLengths.get(inputIndex)
    if (!signatures || input.leafScripts.length === 0) {
      size += qbitWitnessStackLength(signatures ?? [])
      return
    }
    size += Math.min(
      ...input.leafScripts.map(leaf =>
        qbitWitnessStackLength([...signatures, leaf.script.length, leaf.controlBlock.length])
      )
    )
  })
  return size
}

function clonePsbt(psbt: Psbt): Psbt {
  const cloneMap = (map: Psbt['global']): Psbt['global'] =>
    map.map(entry => ({ key: entry.key.slice(), value: entry.value.slice() }))

  return {
    global: cloneMap(psbt.global),
    inputs: psbt.inputs.map(cloneMap),
    outputs: psbt.outputs.map(cloneMap),
  }
}

function p2mrPreSignedSignatureKey(
  inputIndex: number,
  pubkey: Uint8Array,
  leafHash: Uint8Array,
  sighash: Uint8Array
): string {
  return `${inputIndex}:${bytesToHex(pubkey)}:${bytesToHex(leafHash)}:${bytesToHex(sighash)}`
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('expected even-length hex')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  chunks.forEach(chunk => {
    out.set(chunk, offset)
    offset += chunk.length
  })
  return out
}
