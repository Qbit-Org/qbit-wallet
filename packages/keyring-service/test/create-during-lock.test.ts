import { describe, expect, it, vi } from 'vitest'

import { BUS_EVENTS, BUS_METHODS } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import type { Encryptor } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const samplePrivateKey = '88544d58a328a380a4a433e4bb44b2a9f8a1152b1467393cfc8f8e5d81137162'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

// Keeps what was written, and can hold the next vault write open.
class MemoryStorage {
  readonly values = new Map<string, any>()
  private held: { started: () => void; release: Promise<void> } | undefined

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    const held = this.held
    if (key === 'keyringState' && held && value?.vault) {
      this.held = undefined
      held.started()
      await held.release
    }
    this.values.set(key, value)
  }

  holdNextVaultWrite() {
    const started = deferred()
    const release = deferred()
    this.held = { started: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }
}

class JsonEncryptor implements Encryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

const testLogger = { debug() {}, info() {}, warn() {}, error() {} }

async function bootedService() {
  const storage = new MemoryStorage()
  const eventBus = { emit: vi.fn() }
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger,
    t: (key: string) => key,
    eventBus: eventBus as any,
  })
  await service.boot('password')
  return { service, storage, eventBus }
}

const unlockedBroadcasts = (eventBus: { emit: ReturnType<typeof vi.fn> }) =>
  eventBus.emit.mock.calls.filter(
    ([event, payload]) =>
      event === BUS_EVENTS.broadcastToUI && payload?.method === BUS_METHODS.UNLOCKED
  )

describe('KeyringService create and import while the wallet locks', () => {
  const creates = [
    [
      'createKeyringWithMnemonics',
      (service: KeyringService) =>
        service.createKeyringWithMnemonics(sampleMnemonic, "m/84'/0'/0'/0", '', AddressType.P2WPKH, 1),
    ],
    [
      'importPrivateKey',
      (service: KeyringService) => service.importPrivateKey(samplePrivateKey, AddressType.P2WPKH),
    ],
  ] as const

  it.each(creates)(
    '%s does not undo a lock that completes while the keyring is saved',
    async (_name, create) => {
      const { service, storage, eventBus } = await bootedService()
      const write = storage.holdNextVaultWrite()
      const creating = create(service)
      await write.started

      await service.setLocked()
      expect(service.memStore.getState().isUnlocked).toBe(false)
      eventBus.emit.mockClear()
      write.release()
      await creating

      // The lock wins: no secrets are loaded, so nothing reads unlocked.
      expect(service.password).toBeNull()
      expect(service.memStore.getState().isUnlocked).toBe(false)
      expect(unlockedBroadcasts(eventBus)).toEqual([])

      // The keyring was saved, and the password unlocks it.
      await service.submitPassword('password')
      expect(service.memStore.getState().isUnlocked).toBe(true)
      expect(service.keyrings).toHaveLength(1)
    }
  )

  it.each(creates)('%s publishes the unlocked state when no lock comes in', async (_name, create) => {
    const { service, eventBus } = await bootedService()
    eventBus.emit.mockClear()
    await create(service)
    expect(service.memStore.getState().isUnlocked).toBe(true)
    expect(unlockedBroadcasts(eventBus)).toHaveLength(1)
  })
})
