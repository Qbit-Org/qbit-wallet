import { describe, expect, it, vi } from 'vitest'

import { BUS_EVENTS, BUS_METHODS } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import type { Encryptor, Keyring } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const secondMnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

interface Hold {
  started: Promise<void>
  release: () => void
}

class MemoryStorage {
  readonly values = new Map<string, any>()
  private heldKeyringStateWrite: { started: () => void; release: Promise<void> } | undefined

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    const held = this.heldKeyringStateWrite
    if (key === 'keyringState' && held) {
      this.heldKeyringStateWrite = undefined
      held.started()
      await held.release
    }
    this.values.set(key, value)
  }

  holdNextKeyringStateWrite(): Hold {
    const started = deferred()
    const release = deferred()
    this.heldKeyringStateWrite = { started: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }
}

class JsonEncryptor implements Encryptor {
  vaultDecryptCount = 0
  private heldDecrypt:
    | { target: 'booted' | 'vault'; started: () => void; release: Promise<void> }
    | undefined
  private heldVaultEncrypt: { started: () => void; release: Promise<void> } | undefined

  async encrypt(password: string, data: any): Promise<string> {
    const held = this.heldVaultEncrypt
    if (held && Array.isArray(data)) {
      this.heldVaultEncrypt = undefined
      held.started()
      await held.release
    }
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) {
      throw new Error('bad password')
    }
    // The vault holds the serialized keyring list; booted holds the verifier.
    const target = Array.isArray(parsed.data) ? 'vault' : 'booted'
    if (target === 'vault') {
      this.vaultDecryptCount += 1
    }
    const held = this.heldDecrypt
    if (held?.target === target) {
      this.heldDecrypt = undefined
      held.started()
      await held.release
    }
    return parsed.data
  }

  holdNextDecrypt(target: 'booted' | 'vault'): Hold {
    const started = deferred()
    const release = deferred()
    this.heldDecrypt = { target, started: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }

  holdNextVaultEncrypt(): Hold {
    const started = deferred()
    const release = deferred()
    this.heldVaultEncrypt = { started: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }
}

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

class UpgradingJsonEncryptor extends JsonEncryptor {
  private heldUpgrade: { started: () => void; release: Promise<void> } | undefined

  isVaultUpdated(encryptedData: string): boolean {
    return JSON.parse(encryptedData).outdated !== true
  }

  async updateVault(encryptedData: string, _password: string): Promise<string> {
    const held = this.heldUpgrade
    if (held) {
      this.heldUpgrade = undefined
      held.started()
      await held.release
    }
    const parsed = JSON.parse(encryptedData)
    delete parsed.outdated
    return JSON.stringify(parsed)
  }

  holdNextUpgrade(): Hold {
    const started = deferred()
    const release = deferred()
    this.heldUpgrade = { started: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }
}

// Lets every runnable task finish, so a write that is not queued would settle.
function drainTasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function track<T>(promise: Promise<T>) {
  const tracked = { promise, settled: false }
  promise.then(
    () => {
      tracked.settled = true
    },
    () => {
      tracked.settled = true
    }
  )
  return tracked
}

async function createUnlockedWallet(
  mnemonics = [sampleMnemonic, secondMnemonic],
  encryptor = new JsonEncryptor()
) {
  const storage = new MemoryStorage()
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor,
    logger: testLogger,
    t: (key: string) => key,
  })
  await service.boot('password')
  for (const mnemonic of mnemonics) {
    await service.createKeyringWithMnemonics(mnemonic, "m/84'/0'/0'/0", '', AddressType.P2WPKH, 1)
  }
  return { service, storage, encryptor }
}

async function reopenWallet(storage: MemoryStorage): Promise<KeyringService> {
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger,
    t: (key: string) => key,
  })
  await service.submitPassword('password')
  return service
}

function durableKeyringCount(storage: MemoryStorage): number {
  return JSON.parse(storage.values.get('keyringState').vault).data.length
}

// Parks unlockKeyrings after it restored the first keyring, mid restore loop.
function holdAfterFirstRestore(service: KeyringService): Hold {
  const started = deferred()
  const release = deferred()
  const restoreKeyring = service._restoreKeyring
  let restoredCount = 0
  service._restoreKeyring = async serialized => {
    const restored = await restoreKeyring(serialized)
    restoredCount += 1
    if (restoredCount === 1) {
      started.resolve()
      await release.promise
    }
    return restored
  }
  return { started: started.promise, release: release.resolve }
}

// Parks the next serialize() of a keyring, mid persistAllKeyrings.
function holdNextSerialize(keyring: Keyring): Hold {
  const started = deferred()
  const release = deferred()
  const serialize = keyring.serialize.bind(keyring)
  vi.spyOn(keyring, 'serialize').mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    return serialize()
  })
  return { started: started.promise, release: release.resolve }
}

function holdUnlockStep(
  step: 'decrypt' | 'restore',
  service: KeyringService,
  encryptor: JsonEncryptor
): Hold {
  return step === 'decrypt' ? encryptor.holdNextDecrypt('vault') : holdAfterFirstRestore(service)
}

async function createLockedService(
  eventBus: { emit: ReturnType<typeof vi.fn> },
  beforeLock?: (service: KeyringService) => Promise<void>
) {
  const service = new KeyringService()
  await service.init({
    storage: new MemoryStorage() as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger,
    t: (key: string) => key,
    eventBus,
  })
  await service.boot('password')
  await beforeLock?.(service)
  await service.setLocked()
  eventBus.emit.mockClear()
  return service
}

describe('KeyringService.submitPassword', () => {
  it('waits for pre-unlock work before publishing the unlocked state', async () => {
    const eventBus = { emit: vi.fn() }
    const service = await createLockedService(eventBus)
    const unlockListener = vi.fn()
    service.on('unlock', unlockListener)

    let releaseBeforeUnlock!: () => void
    const beforeUnlockGate = new Promise<void>(resolve => {
      releaseBeforeUnlock = resolve
    })
    let markBeforeUnlockStarted!: () => void
    const beforeUnlockStarted = new Promise<void>(resolve => {
      markBeforeUnlockStarted = resolve
    })
    const beforeUnlock = vi.fn(async () => {
      markBeforeUnlockStarted()
      await beforeUnlockGate
    })

    const submit = service.submitPassword('password', { beforeUnlock })
    await beforeUnlockStarted

    expect(beforeUnlock).toHaveBeenCalledOnce()
    expect(service.memStore.getState().isUnlocked).toBe(false)
    expect(unlockListener).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()

    releaseBeforeUnlock()
    await submit

    expect(service.memStore.getState().isUnlocked).toBe(true)
    expect(unlockListener).toHaveBeenCalledOnce()
    expect(eventBus.emit).toHaveBeenCalledWith(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.UNLOCKED,
      params: {},
    })
  })

  it('preserves immediate unlock publication when no hook is provided', async () => {
    const eventBus = { emit: vi.fn() }
    const service = await createLockedService(eventBus)
    const unlockListener = vi.fn()
    service.on('unlock', unlockListener)

    await service.submitPassword('password')

    expect(service.memStore.getState().isUnlocked).toBe(true)
    expect(unlockListener).toHaveBeenCalledOnce()
    expect(eventBus.emit).toHaveBeenCalledWith(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.UNLOCKED,
      params: {},
    })
  })

  it('does not publish an unlock when a lock is requested during pre-unlock work', async () => {
    const eventBus = { emit: vi.fn() }
    const service = await createLockedService(eventBus)
    const unlockListener = vi.fn()
    const lockListener = vi.fn()
    service.on('unlock', unlockListener)
    service.on('lock', lockListener)

    let releaseBeforeUnlock!: () => void
    const beforeUnlockGate = new Promise<void>(resolve => {
      releaseBeforeUnlock = resolve
    })
    let markBeforeUnlockStarted!: () => void
    const beforeUnlockStarted = new Promise<void>(resolve => {
      markBeforeUnlockStarted = resolve
    })

    const submit = service.submitPassword('password', {
      beforeUnlock: async () => {
        markBeforeUnlockStarted()
        await beforeUnlockGate
      },
    })
    await beforeUnlockStarted

    const pendingLock = service.setLocked()
    expect(service.memStore.getState().isUnlocked).toBe(false)

    releaseBeforeUnlock()
    await Promise.all([submit, pendingLock])

    expect(service.memStore.getState().isUnlocked).toBe(false)
    expect(unlockListener).not.toHaveBeenCalled()
    expect(lockListener).toHaveBeenCalledOnce()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('clears decrypted state when pre-unlock work fails and permits a retry', async () => {
    const eventBus = { emit: vi.fn() }
    const service = await createLockedService(eventBus, async unlockedService => {
      await unlockedService.createKeyringWithMnemonics(
        sampleMnemonic,
        "m/84'/0'/0'/0",
        '',
        AddressType.P2WPKH,
        1
      )
    })
    const unlockListener = vi.fn()
    const lockListener = vi.fn()
    service.on('unlock', unlockListener)
    service.on('lock', lockListener)
    const failure = new Error('pre-unlock work failed')

    await expect(
      service.submitPassword('password', {
        beforeUnlock: async () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)

    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.addressTypes).toEqual([])
    expect(service.memStore.getState()).toMatchObject({
      isUnlocked: false,
      keyrings: [],
    })
    expect(unlockListener).not.toHaveBeenCalled()
    expect(lockListener).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()

    await expect(service.submitPassword('password')).resolves.toMatchObject({ isUnlocked: true })

    expect(service.keyrings).toHaveLength(1)
    expect(service.memStore.getState().keyrings).toHaveLength(1)
    expect(unlockListener).toHaveBeenCalledOnce()
  })
})

describe('KeyringService unlock vs concurrent vault writes', () => {
  it.each(['decrypt', 'restore'] as const)(
    'queues a vault write during the unlock %s until the whole vault is live',
    async step => {
      const { service, storage, encryptor } = await createUnlockedWallet()
      await service.setLocked()

      const hold = holdUnlockStep(step, service, encryptor)
      const unlock = service.submitPassword('password')
      await hold.started

      // A pre-lock operation's final persist lands while the unlock rebuilds.
      const persist = track(service.persistAllKeyrings([]))
      await drainTasks()
      expect(persist.settled).toBe(false)
      expect(durableKeyringCount(storage)).toBe(2)

      hold.release()
      await expect(unlock).resolves.toMatchObject({ isUnlocked: true })
      await expect(persist.promise).resolves.toBe(true)
      expect(service.keyrings).toHaveLength(2)
      expect(durableKeyringCount(storage)).toBe(2)

      const reopened = await reopenWallet(storage)
      expect(reopened.keyrings).toHaveLength(2)
    }
  )

  it.each(['decrypt', 'restore'] as const)(
    'keeps the live keyrings and queues writes while unlockKeyrings is in its %s step',
    async step => {
      const { service, storage, encryptor } = await createUnlockedWallet()
      const liveKeyrings = service.keyrings
      const liveAddressTypes = service.addressTypes

      const hold = holdUnlockStep(step, service, encryptor)
      const reload = service.unlockKeyrings('password')
      await hold.started

      expect(service.keyrings).toBe(liveKeyrings)
      expect(service.addressTypes).toBe(liveAddressTypes)
      const persist = track(service.persistAllKeyrings([]))
      await drainTasks()
      expect(persist.settled).toBe(false)

      hold.release()
      await reload
      await expect(persist.promise).resolves.toBe(true)
      expect(service.keyrings).toHaveLength(2)
      expect(service.memStore.getState().keyrings).toHaveLength(2)
      expect(durableKeyringCount(storage)).toBe(2)

      const reopened = await reopenWallet(storage)
      expect(reopened.keyrings).toHaveLength(2)
    }
  )

  it('rejects a held persist that resumes after a lock before the next unlock reads the vault', async () => {
    const { service, storage, encryptor } = await createUnlockedWallet()
    const vaultDecryptCount = encryptor.vaultDecryptCount

    // An in-flight write holds the persistence queue and a second one (for
    // example a floor scan's final persist) waits behind it across a lock.
    const heldWrite = storage.holdNextKeyringStateWrite()
    const firstPersist = service.persistAllKeyrings([])
    await heldWrite.started
    const queuedPersist = service.persistAllKeyrings([]).then(
      () => 'persisted',
      (error: Error) => error.message
    )

    await service.setLocked()
    const unlock = service.submitPassword('password')
    await drainTasks()
    expect(encryptor.vaultDecryptCount).toBe(vaultDecryptCount)

    heldWrite.release()
    await expect(firstPersist).resolves.toBe(true)
    await expect(queuedPersist).resolves.toBe('keyringcontroller_password_is_not_a_string')
    await expect(unlock).resolves.toMatchObject({ isUnlocked: true })
    expect(service.keyrings).toHaveLength(2)
    expect(durableKeyringCount(storage)).toBe(2)

    const reopened = await reopenWallet(storage)
    expect(reopened.keyrings).toHaveLength(2)
  })

  it('commits a write that a lock interrupted under the password it checked', async () => {
    const { service, storage } = await createUnlockedWallet([sampleMnemonic])
    service.keyrings[0]!.addAccounts(1)
    const hold = holdNextSerialize(service.keyrings[0]!)

    const persist = service.persistAllKeyrings([])
    await hold.started
    await service.setLocked()
    hold.release()

    await expect(persist).resolves.toBe(true)
    expect(JSON.parse(storage.values.get('keyringState').vault).password).toBe('password')
    const reopened = await reopenWallet(storage)
    await expect(reopened.keyrings[0]!.getAccounts()).resolves.toHaveLength(2)
  })

  it('does not bring back a vault that a reset wiped during a write', async () => {
    const { service, storage } = await createUnlockedWallet()
    const hold = holdNextSerialize(service.keyrings[0]!)

    const persist = service.persistAllKeyrings([])
    await hold.started
    await service.resetAllData()
    hold.release()

    await expect(persist).rejects.toThrow('The wallet was reset while this write was in progress')
    await drainTasks()
    expect(service.store.getState()).toMatchObject({ booted: '', vault: null })
    expect(storage.values.get('keyringState')).toMatchObject({ booted: '', vault: null })
  })

  it('does not publish an unlock when a reset wipes the wallet during pre-unlock work', async () => {
    const { service } = await createUnlockedWallet()
    await service.setLocked()
    const unlockListener = vi.fn()
    service.on('unlock', unlockListener)

    await expect(
      service.submitPassword('password', {
        beforeUnlock: () => service.resetAllData(),
      })
    ).resolves.toMatchObject({ isUnlocked: false })

    expect(unlockListener).not.toHaveBeenCalled()
    expect(service.password).toBeNull()
    expect(service.memStore.getState().isUnlocked).toBe(false)
  })

  it('verifies a second unlock without reloading or clearing the live keyrings', async () => {
    const eventBus = { emit: vi.fn() }
    const { service, storage, encryptor } = await createUnlockedWallet()
    ;(service as any).eventBus = eventBus
    const unlockListener = vi.fn()
    service.on('unlock', unlockListener)
    const liveKeyrings = service.keyrings
    const liveAddressTypes = service.addressTypes
    const vaultDecryptCount = encryptor.vaultDecryptCount
    const beforeUnlock = vi.fn()

    await expect(service.submitPassword('wrong-password', { beforeUnlock })).rejects.toThrow(
      'password_error'
    )
    expect(service.password).toBe('password')
    expect(service.keyrings).toBe(liveKeyrings)
    expect(service.memStore.getState().isUnlocked).toBe(true)

    // A write lands while the second unlock verifies the password.
    const heldVerify = encryptor.holdNextDecrypt('booted')
    const secondUnlock = service.submitPassword('password', { beforeUnlock })
    await heldVerify.started
    await expect(service.persistAllKeyrings([])).resolves.toBe(true)
    expect(durableKeyringCount(storage)).toBe(2)

    heldVerify.release()
    await expect(secondUnlock).resolves.toMatchObject({ isUnlocked: true })

    expect(service.keyrings).toBe(liveKeyrings)
    expect(service.addressTypes).toBe(liveAddressTypes)
    expect(encryptor.vaultDecryptCount).toBe(vaultDecryptCount)
    expect(beforeUnlock).not.toHaveBeenCalled()
    expect(service.memStore.getState().keyrings).toHaveLength(2)
    expect(unlockListener).toHaveBeenCalledOnce()
    expect(eventBus.emit).toHaveBeenCalledWith(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.UNLOCKED,
      params: {},
    })
  })

  it('re-reads a vault that a newer write replaced while the unlock was decrypting', async () => {
    const { service, encryptor } = await createUnlockedWallet([sampleMnemonic])
    const singleKeyringVault = service.store.getState().vault
    await service.createKeyringWithMnemonics(
      secondMnemonic,
      "m/84'/0'/0'/0",
      '',
      AddressType.P2WPKH,
      1
    )
    await service.setLocked()

    const heldDecrypt = encryptor.holdNextDecrypt('vault')
    const unlock = service.submitPassword('password')
    await heldDecrypt.started
    // A rollback restores the earlier vault after the unlock read the newer one.
    service.store.updateState({ vault: singleKeyringVault })
    heldDecrypt.release()

    await expect(unlock).resolves.toMatchObject({ isUnlocked: true })
    expect(service.keyrings).toHaveLength(1)
    expect(service.store.getState().vault).toBe(singleKeyringVault)
  })

  it('stops re-reading a vault that changes during every unlock attempt', async () => {
    const { service, encryptor } = await createUnlockedWallet([sampleMnemonic])
    const singleKeyringVault = service.store.getState().vault
    await service.createKeyringWithMnemonics(
      secondMnemonic,
      "m/84'/0'/0'/0",
      '',
      AddressType.P2WPKH,
      1
    )
    const twoKeyringVault = service.store.getState().vault
    await service.setLocked()
    const vaultDecryptCount = encryptor.vaultDecryptCount

    const replacements = [singleKeyringVault, twoKeyringVault, singleKeyringVault]
    let heldDecrypt = encryptor.holdNextDecrypt('vault')
    const unlock = service.submitPassword('password').then(
      () => 'unlocked',
      (error: Error) => error.message
    )
    for (const [index, replacement] of replacements.entries()) {
      await heldDecrypt.started
      service.store.updateState({ vault: replacement })
      const current = heldDecrypt
      if (index < replacements.length - 1) {
        heldDecrypt = encryptor.holdNextDecrypt('vault')
      }
      current.release()
    }

    await expect(unlock).resolves.toBe('Vault changed during every unlock attempt; try again')
    expect(encryptor.vaultDecryptCount - vaultDecryptCount).toBe(3)
    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.memStore.getState()).toMatchObject({ isUnlocked: false, keyrings: [] })

    await expect(service.submitPassword('password')).resolves.toMatchObject({ isUnlocked: true })
    expect(service.keyrings).toHaveLength(1)
  })

  it('reads the vault only after a pre-lock write that is still encrypting commits', async () => {
    const { service, storage, encryptor } = await createUnlockedWallet([sampleMnemonic])
    service.keyrings[0]!.addAccounts(1)
    const vaultDecryptCount = encryptor.vaultDecryptCount

    // The write passed its password check and serialized the new account
    // before the lock, and is still encrypting when the next unlock starts.
    const heldEncrypt = encryptor.holdNextVaultEncrypt()
    const persist = service.persistAllKeyrings([])
    await heldEncrypt.started
    await service.setLocked()

    const unlock = service.submitPassword('password')
    await drainTasks()
    expect(encryptor.vaultDecryptCount).toBe(vaultDecryptCount)

    heldEncrypt.release()
    await expect(persist).resolves.toBe(true)
    await expect(unlock).resolves.toMatchObject({ isUnlocked: true })
    await expect(service.keyrings[0]!.getAccounts()).resolves.toHaveLength(2)

    await service.persistAllKeyrings([])
    const reopened = await reopenWallet(storage)
    await expect(reopened.keyrings[0]!.getAccounts()).resolves.toHaveLength(2)
  })

  it('queues a write behind the vault encryption upgrade instead of letting the upgrade roll it back', async () => {
    const encryptor = new UpgradingJsonEncryptor()
    const { service, storage } = await createUnlockedWallet([sampleMnemonic], encryptor)
    const vault = JSON.parse(service.store.getState().vault!)
    service.store.updateState({ vault: JSON.stringify({ ...vault, outdated: true }) })
    await service.setLocked()

    const heldUpgrade = encryptor.holdNextUpgrade()
    const unlock = service.submitPassword('password')
    await heldUpgrade.started

    // The keyrings are live while the upgrade re-encrypts the vault it read;
    // a write derives an account in that window.
    service.keyrings[0]!.addAccounts(1)
    const persist = service.persistAllKeyrings([])
    heldUpgrade.release()

    await expect(unlock).resolves.toMatchObject({ isUnlocked: true })
    await expect(persist).resolves.toBe(true)
    expect(JSON.parse(storage.values.get('keyringState').vault).outdated).toBeUndefined()
    const reopened = await reopenWallet(storage)
    await expect(reopened.keyrings[0]!.getAccounts()).resolves.toHaveLength(2)
  })

  it('reloads on a second unlock when an unlocked wallet has no live keyrings', async () => {
    const { service, storage } = await createUnlockedWallet()
    service.keyrings = []
    service.addressTypes = []

    await expect(service.submitPassword('password')).resolves.toMatchObject({ isUnlocked: true })
    expect(service.keyrings).toHaveLength(2)
    expect(service.memStore.getState().keyrings).toHaveLength(2)
    await service.persistAllKeyrings([])
    expect(durableKeyringCount(storage)).toBe(2)
  })

  it('does not resurrect a wallet that was reset while the unlock was decrypting', async () => {
    const { service, storage, encryptor } = await createUnlockedWallet()
    await service.setLocked()

    const heldDecrypt = encryptor.holdNextDecrypt('vault')
    const unlock = service.submitPassword('password')
    await heldDecrypt.started
    await service.resetAllData()
    heldDecrypt.release()

    await expect(unlock).rejects.toThrow('cannot_unlock_without_a_previous_vault')
    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.memStore.getState()).toMatchObject({ isUnlocked: false, keyrings: [] })
    expect(storage.values.get('keyringState')).toMatchObject({ booted: '', vault: null })
  })

  it('locks the wallet in clearKeyrings so a later write cannot commit an empty vault', async () => {
    const { service, storage } = await createUnlockedWallet()

    await service.clearKeyrings()

    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.memStore.getState()).toMatchObject({ isUnlocked: false, keyrings: [] })
    await expect(service.persistAllKeyrings([])).rejects.toThrow(
      'keyringcontroller_password_is_not_a_string'
    )
    expect(durableKeyringCount(storage)).toBe(2)

    await expect(service.submitPassword('password')).resolves.toMatchObject({ isUnlocked: true })
    expect(service.keyrings).toHaveLength(2)
  })
})
