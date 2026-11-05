import { beforeAll, describe, expect, it } from 'vitest'

import * as browserPassworder from '@metamask/browser-passworder'
import { init } from '@qbit-oss/pqc'
import { AddressType } from '@qbit/wallet-types'
import { BrowserPassworderEncryptor } from '../src/encryptor/browser-encryptor'
import { KeyringService } from '../src/keyring-service'
import type { Encryptor } from '../src/types'

const password = 'migration-test-password'
const mnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

// { secret: 'fixture' } encrypted once under `password` by browser-passworder
// 2.0.3 itself, the earlier vault encryptor: 10,000-round PBKDF2 and no
// keyMetadata field. It came from `npm pack browser-passworder@2.0.3
// browserify-unibabel@3.0.0`, whose tarballs matched the lockfile integrity
// this package last installed (sha512-8mTcGjsV… and sha512-j3MX0k2d…).
const BROWSER_PASSWORDER_2_0_3_FIELD = JSON.stringify({
  data: 's5W68oOBptffuFwfad8hgv4KWpSXO1wBUI6xWQVK1ZJor9JK',
  iv: 'Uq1UPtNzB4kErv53thtbkw==',
  salt: 'KOdg93cc4Upum7aIaskDJ0AmqmJoR3Uat+olG1j0Xjc=',
})

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

// Writes the earlier format without the earlier package: the current library
// at 10,000 rounds, with the keyMetadata field it adds removed. The first test
// below checks that this uses the key derivation browser-passworder 2.0.3 did.
const previousEncryptor: Encryptor = {
  encrypt: async (secret, data) => {
    const payload = JSON.parse(
      await browserPassworder.encrypt(secret, data, undefined, undefined, {
        algorithm: 'PBKDF2',
        params: { iterations: 10_000 },
      })
    )
    if (payload.keyMetadata?.params?.iterations !== 10_000) {
      throw new Error('the library no longer records the requested key derivation')
    }
    delete payload.keyMetadata
    return JSON.stringify(payload)
  },
  decrypt: (secret, encryptedData) => browserPassworder.decrypt(secret, encryptedData),
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
  await service.createKeyringWithMnemonics(mnemonic, "m/87'/1'/0'/0", '', AddressType.P2MR, 1)
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

// The same field with explicit key-derivation metadata, which the library
// then uses instead of its earlier-format default.
function withPbkdf2Rounds(encryptedData: string, iterations: number): string {
  return JSON.stringify({
    ...JSON.parse(encryptedData),
    keyMetadata: { algorithm: 'PBKDF2', params: { iterations } },
  })
}

// QbitHdKeyring derives its PQC keys through the SDK's WebAssembly module.
beforeAll(async () => {
  await init()
})

describe('BrowserPassworderEncryptor vault migration', () => {
  it('builds earlier-format fixtures with the key derivation browser-passworder 2.0.3 used', async () => {
    const rebuilt = await previousEncryptor.encrypt(password, { secret: 'fixture' })

    for (const field of [BROWSER_PASSWORDER_2_0_3_FIELD, rebuilt]) {
      expect(Object.keys(JSON.parse(field)).sort()).toEqual(['data', 'iv', 'salt'])
      await expect(
        browserPassworder.decrypt(password, withPbkdf2Rounds(field, 10_000))
      ).resolves.toEqual({ secret: 'fixture' })
    }
    // The round count matters: the genuine field does not open at 900,000.
    await expect(
      browserPassworder.decrypt(password, withPbkdf2Rounds(BROWSER_PASSWORDER_2_0_3_FIELD, 900_000))
    ).rejects.toThrow()
  })

  it('migrates a field that browser-passworder 2.0.3 wrote', async () => {
    const encryptor = new BrowserPassworderEncryptor()

    expect(encryptor.isVaultUpdated(BROWSER_PASSWORDER_2_0_3_FIELD)).toBe(false)
    await expect(encryptor.decrypt(password, BROWSER_PASSWORDER_2_0_3_FIELD)).resolves.toEqual({
      secret: 'fixture',
    })

    const migrated = await encryptor.updateVault(BROWSER_PASSWORDER_2_0_3_FIELD, password)
    expectCurrentKdf(migrated)
    await expect(encryptor.decrypt(password, migrated)).resolves.toEqual({ secret: 'fixture' })
  })

  it('decrypts the earlier format and emits only the current KDF metadata', async () => {
    const encryptor = new BrowserPassworderEncryptor()
    const earlierVault = await previousEncryptor.encrypt(password, { secret: 'fixture' })

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
