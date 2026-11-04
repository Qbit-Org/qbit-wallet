import { beforeAll, describe, expect, it } from 'vitest'

import { init as initPqc } from '@qbit-oss/pqc'
import { publicKeyToAddress } from '@qbit/wallet-core'
import { AddressType, NetworkType } from '@qbit/wallet-types'
import { BrowserPassworderEncryptor } from '../src/encryptor/browser-encryptor'
import { KeyringService } from '../src/keyring-service'
import {
  RELEASES,
  readReleaseStorage,
  type ReleaseStorage,
} from '../../../tests/fixtures/release-storage/release-storage'

// Each unlock decrypts the release's 900,000-round PBKDF2 vault twice.
const UNLOCK_TIMEOUT_MS = 120_000

// chrome.storage.local hands out copies, and keeps copies of what it is given.
class DumpStorage {
  constructor(readonly values: Record<string, unknown>) {}

  async get(key: string): Promise<any> {
    return structuredClone(this.values[key])
  }

  async set(key: string, value: any): Promise<void> {
    this.values[key] = structuredClone(value)
  }
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function open(dump: ReleaseStorage) {
  const service = new KeyringService()
  await service.init({
    storage: new DumpStorage(dump.storage) as any,
    encryptor: new BrowserPassworderEncryptor(),
    logger,
    t: (key: string) => key,
  })
  return service
}

async function unlock(dump: ReleaseStorage, password = dump.wallet.password) {
  const service = await open(dump)
  const state = await service.submitPassword(password)
  return { service, state }
}

/** Each unlocked keyring's type and the testnet address of each account. */
function walletsOf({ service, state }: { service: KeyringService; state: { keyrings: any[] } }) {
  return state.keyrings.map((keyring, index) => {
    const addressType = service.addressTypes[index] as AddressType
    return {
      type: keyring.type,
      addressType,
      addresses: keyring.accounts.map((account: any) =>
        // A Qbit HD account carries its P2MR addresses; others derive theirs.
        account.keyring
          ? account.keyring.addresses.testnet4
          : publicKeyToAddress(account.pubkey, addressType, NetworkType.TESTNET)
      ),
    }
  })
}

describe.each(RELEASES)('the vault stored by %s', release => {
  beforeAll(async () => {
    await initPqc()
  })

  it(
    'unlocks with its password and holds the release’s wallets and accounts',
    async () => {
      const dump = readReleaseStorage(release)
      const unlocked = await unlock(dump)
      const { service, state } = unlocked

      expect(state.isUnlocked).toBe(true)
      expect(service.isBooted()).toBe(true)
      expect(walletsOf(unlocked)).toEqual(
        dump.wallet.keyrings.map(keyring => ({
          type: keyring.type,
          addressType: keyring.addressType,
          addresses: keyring.accounts.map(account => account.address),
        }))
      )
      expect(state.keyrings[1].accounts[0].pubkey).toBe(dump.wallet.readonlyPublicKey)
    },
    UNLOCK_TIMEOUT_MS
  )

  it(
    'refuses a wrong password and keeps the vault',
    async () => {
      const dump = readReleaseStorage(release)
      const before = structuredClone(dump.storage['keyringState'])
      const service = await open(dump)

      await expect(service.submitPassword(`${dump.wallet.password}-wrong`)).rejects.toThrow(
        'password_error'
      )
      expect(dump.storage['keyringState']).toEqual(before)
    },
    UNLOCK_TIMEOUT_MS
  )

  it(
    'writes the vault again, and that vault unlocks with the same wallets',
    async () => {
      const dump = readReleaseStorage(release)
      const first = await unlock(dump)
      const newPassword = `${dump.wallet.password}-changed`

      // A password change serializes every loaded keyring into a new vault.
      await first.service.changePassword(dump.wallet.password, newPassword)

      expect(walletsOf(await unlock(dump, newPassword))).toEqual(walletsOf(first))
    },
    3 * UNLOCK_TIMEOUT_MS
  )
})
