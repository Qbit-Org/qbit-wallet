import { beforeAll, describe, expect, it } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import { UnsupportedKeyring } from '../src/keyrings/unsupported-keyring'
import { KeyringType, type Encryptor } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const qbitHdPath = "m/87'/1'/0'/0"

const retiredEntries = [
  {
    type: 'HD Key Tree',
    data: {
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      activeIndexes: [0, 2],
      hdPath: "m/84'/0'/0'/0",
      passphrase: '',
    },
    addressType: AddressType.P2WPKH,
  },
  {
    type: 'Simple Key Pair',
    data: ['4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'],
    addressType: AddressType.P2TR,
  },
]

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, value)
  }
}

class JsonEncryptor implements Encryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) {
      throw new Error('bad password')
    }
    return parsed.data
  }
}

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

async function createService(storage: MemoryStorage): Promise<KeyringService> {
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger,
    t: (key: string) => key,
  })
  // HdKeyring and SimpleKeyring are about to leave the build; these tests are
  // about the vault that outlives them.
  service.keyringTypes = service.keyringTypes.filter(
    keyring => keyring.type !== 'HD Key Tree' && keyring.type !== 'Simple Key Pair'
  )
  return service
}

/** A vault whose entries, around a Qbit wallet, are of types the build does not ship. */
async function createVault(extraEntries: unknown[] = retiredEntries): Promise<MemoryStorage> {
  const storage = new MemoryStorage()
  const service = await createService(storage)
  await service.boot('password')
  await service.createKeyringWithMnemonics(sampleMnemonic, qbitHdPath, '', AddressType.P2MR, 1)
  const state = storage.values.get('keyringState')
  const vault = await new JsonEncryptor().decrypt('password', state.vault)
  storage.values.set('keyringState', {
    ...state,
    vault: await new JsonEncryptor().encrypt('password', [...extraEntries, ...vault]),
  })
  await service.setLocked()
  return storage
}

async function durableEntries(storage: MemoryStorage, password = 'password'): Promise<any[]> {
  return new JsonEncryptor().decrypt(password, storage.values.get('keyringState').vault)
}

describe('KeyringService vault entries of an unregistered type', () => {
  beforeAll(async () => {
    await init()
  })

  it('unlocks a vault holding HD Key Tree and Simple Key Pair entries beside a Qbit wallet', async () => {
    const service = await createService(await createVault())

    await service.submitPassword('password')

    expect(service.keyrings.map(keyring => keyring.type)).toEqual([
      'HD Key Tree',
      'Simple Key Pair',
      KeyringType.QbitHdKeyring,
    ])
    expect(service.addressTypes).toEqual([AddressType.P2WPKH, AddressType.P2TR, AddressType.P2MR])
    expect(service.keyrings[0]).toBeInstanceOf(UnsupportedKeyring)
    expect(service.keyrings[1]).toBeInstanceOf(UnsupportedKeyring)

    const accounts = await service.getAccounts()
    expect(accounts).toHaveLength(1)
    expect((await service.getKeyringForAccount(accounts[0]!)).type).toBe(KeyringType.QbitHdKeyring)

    const displayed = await service.getAllDisplayedKeyrings()
    expect(displayed.map(keyring => [keyring.type, keyring.accounts.length])).toEqual([
      ['HD Key Tree', 0],
      ['Simple Key Pair', 0],
      [KeyringType.QbitHdKeyring, 1],
    ])
    expect(service.getMemStore().isUnlocked).toBe(true)
  })

  it('carries the entries unchanged through vault writes and later unlocks', async () => {
    const storage = await createVault()
    const service = await createService(storage)
    await service.submitPassword('password')

    await service.addNewAccount(service.keyrings[2]!)

    const written = await durableEntries(storage)
    expect(written.slice(0, 2)).toEqual(retiredEntries)
    expect(written[2].type).toBe(KeyringType.QbitHdKeyring)
    expect(written[2].data.activeIndexes).toEqual([0, 1])

    await service.changePassword('password', 'new password')
    expect((await durableEntries(storage, 'new password')).slice(0, 2)).toEqual(retiredEntries)

    const reopened = await createService(storage)
    await reopened.submitPassword('new password')
    await expect(reopened.keyrings[0]!.serialize()).resolves.toEqual(retiredEntries[0]!.data)
    const copy = (await reopened.keyrings[0]!.serialize()) as { mnemonic?: string }
    delete copy.mnemonic
    await expect(reopened.keyrings[0]!.serialize()).resolves.toEqual(retiredEntries[0]!.data)
    await expect(reopened.keyrings[1]!.serialize()).resolves.toEqual(retiredEntries[1]!.data)
    expect(await reopened.getAccounts()).toHaveLength(2)
  })

  it('offers no accounts and refuses every keyring operation', async () => {
    const service = await createService(await createVault())
    await service.submitPassword('password')
    const keyring = service.keyrings[0]!

    await expect(keyring.getAccounts()).resolves.toEqual([])
    await expect(keyring.addAccounts(1)).rejects.toThrow('Unsupported keyring type: HD Key Tree')
    await expect(keyring.signTransaction({}, [])).rejects.toThrow('Unsupported keyring type')
    await expect(keyring.signMessage('a', 'b')).rejects.toThrow('Unsupported keyring type')
    await expect(keyring.verifyMessage('a', 'b', 'c')).rejects.toThrow('Unsupported keyring type')
    await expect(keyring.exportAccount('a')).rejects.toThrow('Unsupported keyring type')
    await expect(keyring.deserialize({})).rejects.toThrow('Unsupported keyring type')
    expect(() => keyring.removeAccount('a')).toThrow('Unsupported keyring type')
    await expect(service.addNewAccount(keyring)).rejects.toThrow('Unsupported keyring type')
  })

  it('creates nothing new of an unregistered type', async () => {
    const service = await createService(await createVault())
    await service.submitPassword('password')

    await expect(
      service.addNewKeyring('HD Key Tree', retiredEntries[0]!.data, AddressType.P2WPKH)
    ).rejects.toThrow('Unknown keyring type: HD Key Tree')
    expect(() => service.createTmpKeyring('Simple Key Pair', [])).toThrow(
      'Unknown keyring type: Simple Key Pair'
    )
  })

  it.each([
    ['no type', { data: {} }],
    ['an empty type', { type: '', data: {} }],
    ['a type that is not a string', { type: 7, data: {} }],
  ])('still refuses a vault with an entry that names %s', async (_case, entry) => {
    const service = await createService(await createVault([entry]))

    await expect(service.submitPassword('password')).rejects.toThrow('Unknown keyring type')
    expect(service.keyrings).toEqual([])
  })
})
