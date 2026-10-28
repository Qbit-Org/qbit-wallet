import { describe, expect, it } from 'vitest'

import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import type { Encryptor } from '../src/types'

const password = 'boot-password'
const otherPassword = 'other-password'
const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

class RecordingStorage {
  readonly values = new Map<string, any>()
  readonly keyringStateWrites: any[] = []

  async get(key: string): Promise<any> {
    const value = this.values.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async set(key: string, value: any): Promise<void> {
    const snapshot = structuredClone(value)
    this.values.set(key, snapshot)
    if (key === 'keyringState') {
      this.keyringStateWrites.push(snapshot)
    }
  }
}

class JsonEncryptor implements Encryptor {
  async encrypt(secret: string, data: any): Promise<string> {
    return JSON.stringify({ password: secret, data })
  }

  async decrypt(secret: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== secret) {
      throw new Error('bad password')
    }
    return parsed.data
  }
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

async function createService(storage = new RecordingStorage()) {
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger,
    t: (key: string) => key,
  })
  return { service, storage }
}

async function createWallet() {
  const { service, storage } = await createService()
  await service.boot(password)
  await service.createKeyringWithMnemonics(
    sampleMnemonic,
    "m/84'/0'/0'/0",
    '',
    AddressType.P2WPKH,
    1
  )
  return { service, storage }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('KeyringService.boot', () => {
  it('refuses to boot over an existing vault and leaves all state untouched', async () => {
    const { service, storage } = await createWallet()
    await flushMicrotasks()
    const previousDurableState = structuredClone(storage.values.get('keyringState'))
    const previousStoreState = structuredClone(service.store.getState())
    const previousKeyring = service.keyrings[0]
    const writeCount = storage.keyringStateWrites.length

    await expect(service.boot(otherPassword)).rejects.toThrow('wallet_already_initialized')
    await flushMicrotasks()

    expect(storage.keyringStateWrites).toHaveLength(writeCount)
    expect(storage.values.get('keyringState')).toEqual(previousDurableState)
    expect(service.store.getState()).toEqual(previousStoreState)
    expect(service.password).toBe(password)
    expect(service.keyrings[0]).toBe(previousKeyring)

    const reopened = new KeyringService()
    await reopened.init({
      storage: storage as any,
      encryptor: new JsonEncryptor(),
      logger,
      t: (key: string) => key,
    })
    await expect(reopened.submitPassword(password)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('allows re-booting with a different password while no vault exists', async () => {
    const { service } = await createService()
    await service.boot(password)
    await expect(service.boot(otherPassword)).resolves.toBeUndefined()

    await expect(service.verifyPassword(otherPassword)).resolves.toBe(true)
    await expect(service.verifyPassword(password)).resolves.toBe(false)
    await service.createKeyringWithMnemonics(
      sampleMnemonic,
      "m/84'/0'/0'/0",
      '',
      AddressType.P2WPKH,
      1
    )
    expect(service.hasVault()).toBe(true)
  })

  it('allows booting again after a full reset', async () => {
    const { service } = await createWallet()
    await service.resetAllData()

    await expect(service.boot(otherPassword)).resolves.toBeUndefined()
    await service.createKeyringWithMnemonics(
      sampleMnemonic,
      "m/84'/0'/0'/0",
      '',
      AddressType.P2WPKH,
      1
    )
    await expect(service.verifyPassword(otherPassword)).resolves.toBe(true)
  })
})
