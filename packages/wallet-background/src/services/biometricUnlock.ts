import {
  BIOMETRIC_UNLOCK_RECORD_VERSION,
  type BiometricUnlockRecord,
  type BiometricUnlockStatus,
} from '@qbit/wallet-shared'

import keyringService from './keyring'

interface BiometricUnlockServiceConfig {
  storage: {
    get(key: string): Promise<any>
    set(key: string, value: any): Promise<void>
  }
  logger?: any
}

const STORAGE_KEY = 'biometricUnlock'

/**
 * Owns the persisted biometric-unlock record (the AES-256-GCM-wrapped wallet
 * password; see BiometricUnlockRecord). The WebAuthn ceremony and all key
 * derivation run in the UI page — this service only stores, returns, and
 * invalidates the wrapped record.
 *
 * Writes go straight to the storage adapter rather than through the debounced
 * persist-store proxy: invalidation is security-relevant and must be durable
 * before the caller proceeds, not up to a second later.
 */
export class BiometricUnlockService {
  private storage: BiometricUnlockServiceConfig['storage'] = undefined as any
  private logger: any

  async init(config: BiometricUnlockServiceConfig): Promise<void> {
    this.storage = config.storage
    this.logger = config.logger

    // Any password mutation makes a previously wrapped password stale. For
    // password changes the hook runs while the mutation still holds its
    // keyring mutex, so a queued biometric unlock can never race a change
    // against the old blob; boot/reset fire unmutexed and lean on the unlock
    // path's fail-safe (an undecryptable or unverifiable blob is discarded).
    keyringService.setPasswordLifecycleHook(async () => {
      await this.clearRecord()
    })
  }

  async getStatus(): Promise<BiometricUnlockStatus> {
    const record = await this.readRecord()
    return { enrolled: record !== null }
  }

  /**
   * Persist a freshly wrapped record. The password must be the wallet
   * password (step-up: enrolling always re-proves knowledge of it), which
   * also guarantees the record was wrapped for the current vault.
   */
  async saveRecord(record: BiometricUnlockRecord, password: string): Promise<void> {
    const isValidPassword = await keyringService.verifyPassword(password)
    if (!isValidPassword) {
      throw new Error('biometric enrollment requires a valid wallet password')
    }
    if (!this.isWellFormed(record)) {
      throw new Error('malformed biometric unlock record')
    }
    await this.storage.set(STORAGE_KEY, record)

    // Close the verify→write race against a concurrent password change: the
    // change's lifecycle hook clears this key inside the keyring mutex, so
    // either it ran after our write (key already gone) or our write landed
    // after the new password committed — in which case this re-verify sees
    // the new verifier, fails, and discards the stale record.
    const stillValid = await keyringService.verifyPassword(password).catch(() => false)
    if (!stillValid) {
      await this.clearRecord()
      throw new Error('wallet password changed during biometric enrollment')
    }
  }

  /** Full record for the unlock ceremony (wrapped material included). */
  async getRecord(): Promise<BiometricUnlockRecord | null> {
    return this.readRecord()
  }

  async clearRecord(): Promise<void> {
    await this.storage.set(STORAGE_KEY, null)
  }

  private async readRecord(): Promise<BiometricUnlockRecord | null> {
    try {
      const value = await this.storage.get(STORAGE_KEY)
      if (!this.isWellFormed(value)) {
        return null
      }
      return value
    } catch (error) {
      this.logger?.error?.('[BiometricUnlockService] failed to read record', error)
      return null
    }
  }

  private isWellFormed(value: any): value is BiometricUnlockRecord {
    return (
      !!value &&
      typeof value === 'object' &&
      value.version === BIOMETRIC_UNLOCK_RECORD_VERSION &&
      typeof value.credentialId === 'string' &&
      value.credentialId.length > 0 &&
      typeof value.prfSalt === 'string' &&
      value.prfSalt.length > 0 &&
      typeof value.wrappedPassword === 'string' &&
      value.wrappedPassword.length > 0 &&
      typeof value.iv === 'string' &&
      value.iv.length > 0 &&
      typeof value.createdAt === 'number'
    )
  }
}

const biometricUnlockService = new BiometricUnlockService()

export default biometricUnlockService
