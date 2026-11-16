import { describe, expect, it } from 'vitest'

import { KeyringService } from '../src/keyring-service'

// hasPersistedVault answers what storage holds, which the next start reads;
// hasVault answers from memory. A reset stores the erased state first and
// changes memory last, so a reset that fails between the two leaves them
// apart (#206).

class Storage {
  readonly values = new Map<string, unknown>()
  failWriteOf: string | undefined
  failReads = false

  async get(key: string): Promise<unknown> {
    if (this.failReads) throw new Error('storage read failed')
    const value = this.values.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async set(key: string, value: unknown): Promise<void> {
    if (key === this.failWriteOf) throw new Error(`write of ${key} failed`)
    this.values.set(key, structuredClone(value))
  }
}

const encryptor = {
  encrypt: async (password: string, data: unknown) => JSON.stringify({ password, data }),
  decrypt: async (_password: string, data: string) => JSON.parse(data).data,
}
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

async function started(storage: Storage): Promise<KeyringService> {
  const keyring = new KeyringService()
  await keyring.init({ storage, encryptor, logger: quiet, t: (key: string) => key } as never)
  return keyring
}

function withVault(): Storage {
  const storage = new Storage()
  storage.values.set('keyringState', {
    booted: 'booted-marker',
    vault: 'encrypted-vault',
    boostValue: 'secure_1',
  })
  return storage
}

describe('KeyringService.hasPersistedVault', () => {
  it('answers what storage holds, as hasVault does at a start', async () => {
    const keyring = await started(withVault())
    await expect(keyring.hasPersistedVault()).resolves.toBe(true)
    expect(keyring.hasVault()).toBe(true)

    const empty = await started(new Storage())
    await expect(empty.hasPersistedVault()).resolves.toBe(false)
    expect(empty.hasVault()).toBe(false)
  })

  it('answers no vault after a reset that stored the erased state and then failed, while memory still holds it', async () => {
    const storage = withVault()
    const keyring = await started(storage)
    storage.failWriteOf = 'cached_pubkeys'

    await expect(keyring.resetAllData()).rejects.toThrow('write of cached_pubkeys failed')

    expect(keyring.hasVault()).toBe(true)
    await expect(keyring.hasPersistedVault()).resolves.toBe(false)
    // The next start reads the same.
    storage.failWriteOf = undefined
    expect((await started(storage)).hasVault()).toBe(false)
  })

  it('answers the vault kept after a reset that failed before it stored anything', async () => {
    const storage = withVault()
    const keyring = await started(storage)
    storage.failWriteOf = 'keyringState'

    await expect(keyring.resetAllData()).rejects.toThrow('write of keyringState failed')

    expect(keyring.hasVault()).toBe(true)
    await expect(keyring.hasPersistedVault()).resolves.toBe(true)
  })

  it('answers no vault after a reset that succeeded', async () => {
    const keyring = await started(withVault())

    await keyring.resetAllData()

    expect(keyring.hasVault()).toBe(false)
    await expect(keyring.hasPersistedVault()).resolves.toBe(false)
  })

  it('rejects when storage cannot be read', async () => {
    const storage = withVault()
    const keyring = await started(storage)
    storage.failReads = true

    await expect(keyring.hasPersistedVault()).rejects.toThrow('storage read failed')
  })
})
