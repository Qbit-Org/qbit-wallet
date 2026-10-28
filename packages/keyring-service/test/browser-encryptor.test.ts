import { describe, expect, it } from 'vitest'

import { AddressType } from '@qbit/wallet-types'
// This earlier package remains installed only to generate migration fixtures.
// @ts-ignore
import * as previousPassworder from 'browser-passworder'
import { BrowserPassworderEncryptor } from '../src/encryptor/browser-encryptor'
import { KeyringService } from '../src/keyring-service'
import type { Encryptor } from '../src/types'

const password = 'migration-test-password'
const mnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

class MemoryStorage {
  readonly values = new Map<string, any>()
  failNextKey: string | undefined

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    if (this.failNextKey === key) {
      this.failNextKey = undefined
      throw new Error(`forced migration write failure for ${key}`)
    }
    this.values.set(key, structuredClone(value))
  }
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

const previousEncryptor: Encryptor = {
  encrypt: (secret, data) => previousPassworder.encrypt(secret, data),
  decrypt: (secret, encryptedData) => previousPassworder.decrypt(secret, encryptedData),
}

async function createWalletWithEarlierEncryption(storage: MemoryStorage) {
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: previousEncryptor,
    logger,
    t: (key: string) => key,
  })
  await service.boot(password)
  await service.createKeyringWithMnemonics(
    mnemonic,
    "m/84'/0'/0'/0",
    '',
    AddressType.P2WPKH,
    1
  )
  await service.setLocked()
}

function expectCurrentKdf(encryptedData: string) {
  expect(JSON.parse(encryptedData)).toMatchObject({
    data: expect.any(String),
    iv: expect.any(String),
    salt: expect.any(String),
    keyMetadata: {
      algorithm: 'PBKDF2',
      params: { iterations: 900_000 },
    },
  })
}

describe('BrowserPassworderEncryptor vault migration', () => {
  it('decrypts the earlier format and emits only the current KDF metadata', async () => {
    const encryptor = new BrowserPassworderEncryptor()
    const earlierVault = await previousPassworder.encrypt(password, { secret: 'fixture' })

    expect(encryptor.isVaultUpdated(earlierVault)).toBe(false)
    await expect(encryptor.decrypt(password, earlierVault)).resolves.toEqual({
      secret: 'fixture',
    })

    const migrated = await encryptor.updateVault(earlierVault, password)
    expectCurrentKdf(migrated)
    expect(encryptor.isVaultUpdated(migrated)).toBe(true)
    await expect(encryptor.decrypt(password, migrated)).resolves.toEqual({ secret: 'fixture' })

    const fresh = await encryptor.encrypt(password, { secret: 'fresh' })
    expectCurrentKdf(fresh)
  })

  it('atomically upgrades earlier boot and vault fields on successful unlock', async () => {
    const storage = new MemoryStorage()
    await createWalletWithEarlierEncryption(storage)
    const earlierState = structuredClone(storage.values.get('keyringState'))
    expect(JSON.parse(earlierState.booted).keyMetadata).toBeUndefined()
    expect(JSON.parse(earlierState.vault).keyMetadata).toBeUndefined()

    const service = new KeyringService()
    await service.init({
      storage: storage as any,
      encryptor: new BrowserPassworderEncryptor(),
      logger,
      t: (key: string) => key,
    })
    await service.submitPassword(password)

    const migratedState = storage.values.get('keyringState')
    expectCurrentKdf(migratedState.booted)
    expectCurrentKdf(migratedState.vault)
    expect(service.keyrings).toHaveLength(1)
    await expect(service.keyrings[0]!.serialize()).resolves.toMatchObject({ mnemonic })
  })

  it('keeps the prior durable state and fails closed when migration cannot persist', async () => {
    const storage = new MemoryStorage()
    await createWalletWithEarlierEncryption(storage)
    const earlierState = structuredClone(storage.values.get('keyringState'))

    const service = new KeyringService()
    await service.init({
      storage: storage as any,
      encryptor: new BrowserPassworderEncryptor(),
      logger,
      t: (key: string) => key,
    })
    storage.failNextKey = 'keyringState'

    await expect(service.submitPassword(password)).rejects.toThrow(
      'forced migration write failure'
    )
    expect(storage.values.get('keyringState')).toEqual(earlierState)
    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.memStore.getState().isUnlocked).toBe(false)
  })
})
