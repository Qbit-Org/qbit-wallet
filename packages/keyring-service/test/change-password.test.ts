import { describe, expect, it } from 'vitest'

import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import type { Encryptor } from '../src/types'

const oldPassword = 'old-password'
const newPassword = 'new-password'
const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

interface StoreState {
  booted: string
  vault: string | null
  boostValue: string
}

class PasswordChangeStorage {
  readonly values = new Map<string, any>()
  readonly keyringStateWrites: StoreState[] = []
  private keyringStateWriteFailure: Error | undefined
  private partialWriteFailure:
    | { oldPassword: string; newPassword: string; mixedStateWritten: boolean }
    | undefined

  async get(key: string): Promise<any> {
    const value = this.values.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async set(key: string, value: any): Promise<void> {
    const snapshot = structuredClone(value)
    if (key === 'keyringState' && this.keyringStateWriteFailure) {
      throw this.keyringStateWriteFailure
    }
    if (key === 'keyringState' && this.partialWriteFailure) {
      const bootedPassword = encryptedPassword(snapshot.booted)
      const vaultPassword = encryptedPassword(snapshot.vault)
      const isMixedState =
        bootedPassword === this.partialWriteFailure.newPassword &&
        vaultPassword === this.partialWriteFailure.oldPassword
      const touchesNewPassword =
        bootedPassword === this.partialWriteFailure.newPassword ||
        vaultPassword === this.partialWriteFailure.newPassword

      if (isMixedState && !this.partialWriteFailure.mixedStateWritten) {
        this.partialWriteFailure.mixedStateWritten = true
      } else if (touchesNewPassword) {
        throw new Error('forced password-change persistence failure')
      }
    }

    this.values.set(key, snapshot)
    if (key === 'keyringState') {
      this.keyringStateWrites.push(snapshot)
    }
  }

  armKeyringStateWriteFailure(): void {
    this.keyringStateWriteFailure = new Error('forced keyring-state persistence failure')
  }

  disarmKeyringStateWriteFailure(): void {
    this.keyringStateWriteFailure = undefined
  }

  armPartialWriteFailure(oldSecret: string, newSecret: string): void {
    this.partialWriteFailure = {
      oldPassword: oldSecret,
      newPassword: newSecret,
      mixedStateWritten: false,
    }
  }

  disarmPartialWriteFailure(): void {
    this.partialWriteFailure = undefined
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

class FailingJsonEncryptor extends JsonEncryptor {
  private failingVaultPassword: string | undefined

  failNextVaultEncryption(password: string): void {
    this.failingVaultPassword = password
  }

  override async encrypt(password: string, data: any): Promise<string> {
    if (password === this.failingVaultPassword && Array.isArray(data)) {
      this.failingVaultPassword = undefined
      throw new Error('forced vault encryption failure')
    }
    return super.encrypt(password, data)
  }
}

class BlockingJsonEncryptor extends JsonEncryptor {
  decryptCallCount = 0
  private blockedEncryption:
    | {
        shouldBlock: (password: string, data: any) => boolean
        markStarted: () => void
        waitForRelease: Promise<void>
      }
    | undefined

  blockNextEncryption(
    shouldBlock: (password: string, data: any) => boolean = () => true
  ): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const waitForRelease = new Promise<void>(resolve => {
      release = resolve
    })
    this.blockedEncryption = { shouldBlock, markStarted, waitForRelease }
    return { started, release }
  }

  override async encrypt(password: string, data: any): Promise<string> {
    const blockedEncryption = this.blockedEncryption
    if (blockedEncryption?.shouldBlock(password, data)) {
      this.blockedEncryption = undefined
      blockedEncryption.markStarted()
      await blockedEncryption.waitForRelease
    }
    return super.encrypt(password, data)
  }

  override async decrypt(password: string, encryptedData: string): Promise<any> {
    this.decryptCallCount += 1
    return super.decrypt(password, encryptedData)
  }
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

class RecordingLogger {
  readonly errors: unknown[][] = []
  debug() {}
  info() {}
  warn() {}
  error(...args: unknown[]) {
    this.errors.push(args)
  }
}

function encryptedPassword(ciphertext: string | null): string | undefined {
  if (!ciphertext) return undefined
  return JSON.parse(ciphertext).password
}

async function createWallet(
  storage = new PasswordChangeStorage(),
  encryptor: Encryptor = new JsonEncryptor(),
  serviceLogger: typeof logger = logger
) {
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor,
    logger: serviceLogger,
    t: (key: string) => key,
  })
  await service.boot(oldPassword)
  await service.createKeyringWithMnemonics(
    sampleMnemonic,
    "m/84'/0'/0'/0",
    '',
    AddressType.P2WPKH,
    1
  )
  return { service, storage, encryptor }
}

async function reopenWallet(
  storage: PasswordChangeStorage,
  encryptor: Encryptor = new JsonEncryptor()
): Promise<KeyringService> {
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor,
    logger,
    t: (key: string) => key,
  })
  return service
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('KeyringService.changePassword', () => {
  it('retains the old live and durable state when vault encryption fails', async () => {
    const encryptor = new FailingJsonEncryptor()
    const recordingLogger = new RecordingLogger()
    const { service, storage } = await createWallet(undefined, encryptor, recordingLogger)
    const pendingMnemonic = await service.generatePreMnemonic()
    const previousPendingCiphertext = service.memStore.getState().preMnemonics
    const previousDurableState = structuredClone(storage.values.get('keyringState'))
    const previousStoreState = structuredClone(service.store.getState())
    const previousKeyring = service.keyrings[0]
    const writeCount = storage.keyringStateWrites.length
    encryptor.failNextVaultEncryption(newPassword)

    await expect(service.changePassword(oldPassword, newPassword)).rejects.toThrow(
      'change_password_failed'
    )
    await flushMicrotasks()

    expect(storage.keyringStateWrites).toHaveLength(writeCount)
    expect(storage.values.get('keyringState')).toEqual(previousDurableState)
    expect(service.store.getState()).toEqual(previousStoreState)
    expect(service.password).toBe(oldPassword)
    expect(service.keyrings[0]).toBe(previousKeyring)
    expect(service.memStore.getState()).toMatchObject({
      isUnlocked: true,
      preMnemonics: previousPendingCiphertext,
    })
    await expect(encryptor.decrypt(oldPassword, previousPendingCiphertext)).resolves.toBe(
      pendingMnemonic
    )
    await expect(previousKeyring!.serialize()).resolves.toMatchObject({ mnemonic: sampleMnemonic })
    expect(recordingLogger.errors).toHaveLength(1)
    expect((recordingLogger.errors[0]![1] as Error).message).toBe('forced vault encryption failure')
  })

  it('does not persist a mixed-password state when the durable commit fails', async () => {
    const recordingLogger = new RecordingLogger()
    const { service, storage } = await createWallet(undefined, undefined, recordingLogger)
    const previousDurableState = structuredClone(storage.values.get('keyringState'))
    const previousStoreState = structuredClone(service.store.getState())
    const previousKeyring = service.keyrings[0]
    const writeCount = storage.keyringStateWrites.length
    storage.armPartialWriteFailure(oldPassword, newPassword)

    await expect(service.changePassword(oldPassword, newPassword)).rejects.toThrow(
      'change_password_failed'
    )
    await flushMicrotasks()

    expect(storage.keyringStateWrites).toHaveLength(writeCount)
    expect(storage.values.get('keyringState')).toEqual(previousDurableState)
    expect(service.store.getState()).toEqual(previousStoreState)
    expect(service.password).toBe(oldPassword)
    expect(service.keyrings[0]).toBe(previousKeyring)
    expect(service.memStore.getState().isUnlocked).toBe(true)
    await expect(previousKeyring!.serialize()).resolves.toMatchObject({ mnemonic: sampleMnemonic })
    expect(recordingLogger.errors).toHaveLength(1)
    expect((recordingLogger.errors[0]![1] as Error).message).toBe(
      'forced password-change persistence failure'
    )

    storage.disarmPartialWriteFailure()
    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(oldPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('commits only complete snapshots and restarts with only the new password', async () => {
    const { service, storage } = await createWallet()
    const writeCount = storage.keyringStateWrites.length

    await expect(service.changePassword(oldPassword, newPassword)).resolves.toBeUndefined()
    await flushMicrotasks()

    const passwordChangeWrites = storage.keyringStateWrites.slice(writeCount)
    expect(passwordChangeWrites.length).toBeGreaterThan(0)
    for (const state of passwordChangeWrites) {
      expect(encryptedPassword(state.booted)).toBe(newPassword)
      expect(encryptedPassword(state.vault)).toBe(newPassword)
    }
    expect(service.password).toBe(newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(oldPassword)).rejects.toThrow('password_error')
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('rolls back a failed keyring import instead of committing it during a later password change', async () => {
    const encryptor = new FailingJsonEncryptor()
    const { service, storage } = await createWallet(undefined, encryptor)
    const previousVault = service.store.getState().vault
    const liveMnemonic = service.generateMnemonic()
    encryptor.failNextVaultEncryption(oldPassword)

    await expect(
      service.createKeyringWithMnemonics(
        liveMnemonic,
        "m/86'/0'/0'/0",
        '',
        AddressType.P2TR,
        1
      )
    ).rejects.toThrow('forced vault encryption failure')

    expect(service.keyrings).toHaveLength(1)
    expect(service.addressTypes).toEqual([AddressType.P2WPKH])
    expect(service.store.getState().vault).toBe(previousVault)

    await service.changePassword(oldPassword, newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    expect(reopened.keyrings).toHaveLength(1)
    expect(reopened.addressTypes).toEqual([AddressType.P2WPKH])

    // The rolled-back import stays retryable instead of tripping the
    // duplicate-wallet guard on a leftover live keyring.
    await expect(
      service.createKeyringWithMnemonics(
        liveMnemonic,
        "m/86'/0'/0'/0",
        '',
        AddressType.P2TR,
        1
      )
    ).resolves.toBeDefined()
    expect(service.keyrings).toHaveLength(2)
    await expect(service.keyrings[1]!.serialize()).resolves.toMatchObject({
      mnemonic: liveMnemonic,
    })
  })

  it('rolls back a failed account addition instead of committing it during a later password change', async () => {
    const { service, storage } = await createWallet()
    const keyring = service.keyrings[0]!
    const previousAccounts = await keyring.getAccounts()
    const previousVault = service.store.getState().vault
    const announcedAccounts: string[] = []
    service.on('newAccount', account => announcedAccounts.push(account))
    storage.armKeyringStateWriteFailure()

    await expect(service.addNewAccount(keyring)).rejects.toThrow(
      'forced keyring-state persistence failure'
    )

    await expect(service.getAccounts()).resolves.toEqual(previousAccounts)
    expect(service.store.getState().vault).toBe(previousVault)
    expect(announcedAccounts).toEqual([])

    storage.disarmKeyringStateWriteFailure()
    await service.changePassword(oldPassword, newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.getAccounts()).resolves.toEqual(previousAccounts)

    const addedAccounts = await service.addNewAccount(service.keyrings[0]!)
    expect(addedAccounts).toHaveLength(1)
    expect(announcedAccounts).toEqual(addedAccounts)
  })

  it('does not commit a failed account removal during a later password change', async () => {
    const encryptor = new FailingJsonEncryptor()
    const { service, storage } = await createWallet(undefined, encryptor)
    const keyring = service.keyrings[0]!
    const account = (await keyring.getAccounts())[0]!
    const removedAccounts: string[] = []
    service.on('removedAccount', removedAccount => removedAccounts.push(removedAccount))
    encryptor.failNextVaultEncryption(oldPassword)

    await expect(service.removeAccount(account, keyring.type)).rejects.toThrow(
      'forced vault encryption failure'
    )

    await expect(service.getAccounts()).resolves.toContain(account)
    expect(removedAccounts).toEqual([])

    await service.changePassword(oldPassword, newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.getAccounts()).resolves.toContain(account)
  })

  it('does not commit a failed keyring removal during a later password change', async () => {
    const { service, storage } = await createWallet()
    const keyring = service.keyrings[0]!
    const account = (await keyring.getAccounts())[0]!
    const previousVault = service.store.getState().vault
    storage.armKeyringStateWriteFailure()

    await expect(service.removeKeyring(0)).rejects.toThrow(
      'forced keyring-state persistence failure'
    )

    expect(service.keyrings[0]).toBe(keyring)
    expect(service.store.getState().vault).toBe(previousVault)
    await expect(service.getAccounts()).resolves.toContain(account)

    storage.disarmKeyringStateWriteFailure()
    await service.changePassword(oldPassword, newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.getAccounts()).resolves.toContain(account)
  })

  it('does not commit a failed address type change during a later password change', async () => {
    const { service, storage } = await createWallet()
    const keyring = service.keyrings[0]!
    const previousHdPath = (keyring as any).hdPath
    const previousAddressType = service.addressTypes[0]
    const previousAccounts = await keyring.getAccounts()
    const previousVault = service.store.getState().vault
    storage.armKeyringStateWriteFailure()

    await expect(service.changeAddressType(0, AddressType.P2TR)).rejects.toThrow(
      'forced keyring-state persistence failure'
    )

    expect(service.keyrings[0]).toBe(keyring)
    expect((keyring as any).hdPath).toBe(previousHdPath)
    expect(service.addressTypes[0]).toBe(previousAddressType)
    await expect(keyring.getAccounts()).resolves.toEqual(previousAccounts)
    expect(service.store.getState().vault).toBe(previousVault)

    storage.disarmKeyringStateWriteFailure()
    await service.changePassword(oldPassword, newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    expect((reopened.keyrings[0] as any).hdPath).toBe(previousHdPath)
    expect(reopened.addressTypes[0]).toBe(previousAddressType)
    await expect(reopened.keyrings[0]!.getAccounts()).resolves.toEqual(previousAccounts)
  })

  it('locks and discards live state when an address type rollback cannot restore the HD path', async () => {
    const { service, storage } = await createWallet()
    const keyring = service.keyrings[0]!
    const previousHdPath = (keyring as any).hdPath
    const previousAddressType = service.addressTypes[0]
    const previousAccounts = await keyring.getAccounts()
    const previousVault = service.store.getState().vault
    const previousDurableState = structuredClone(storage.values.get('keyringState'))
    const changeHdPath = keyring.changeHdPath!.bind(keyring)
    let changeHdPathCallCount = 0
    keyring.changeHdPath = hdPath => {
      changeHdPathCallCount += 1
      if (changeHdPathCallCount === 2) {
        throw new Error('forced HD-path rollback failure')
      }
      changeHdPath(hdPath)
    }
    storage.armKeyringStateWriteFailure()

    await expect(service.changeAddressType(0, AddressType.P2TR)).rejects.toThrow(
      'forced keyring-state persistence failure'
    )
    await flushMicrotasks()

    expect(changeHdPathCallCount).toBe(2)
    expect(service.store.getState().vault).toBe(previousVault)
    expect(storage.values.get('keyringState')).toEqual(previousDurableState)
    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.addressTypes).toEqual([])
    expect(service.memStore.getState()).toMatchObject({
      isUnlocked: false,
      keyrings: [],
      addressTypes: [],
    })

    storage.disarmKeyringStateWriteFailure()
    await service.changePassword(oldPassword, newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(oldPassword)).rejects.toThrow('password_error')
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    expect((reopened.keyrings[0] as any).hdPath).toBe(previousHdPath)
    expect(reopened.addressTypes[0]).toBe(previousAddressType)
    await expect(reopened.keyrings[0]!.getAccounts()).resolves.toEqual(previousAccounts)
  })

  it('keeps a concurrent unlock from publishing an unlocked state during a failed address-type rollback', async () => {
    const { service, storage } = await createWallet()
    await service.setLocked()

    // Park an unlock right before it publishes, holding unlockingMutex with
    // decrypted keyrings loaded — the window the fail-closed cleanup used to
    // race without the mutex.
    let releaseUnlock!: () => void
    const unlockGate = new Promise<void>(resolve => {
      releaseUnlock = resolve
    })
    const pendingUnlock = service.submitPassword(oldPassword, {
      beforeUnlock: () => unlockGate,
    })
    await flushMicrotasks()
    expect(service.keyrings).toHaveLength(1)

    // The parked unlock reloaded the live keyrings; patch the instance the
    // address-type change will actually operate on.
    const keyring = service.keyrings[0]!
    const previousHdPath = (keyring as any).hdPath
    const changeHdPath = keyring.changeHdPath!.bind(keyring)
    let changeHdPathCallCount = 0
    keyring.changeHdPath = hdPath => {
      changeHdPathCallCount += 1
      if (changeHdPathCallCount === 2) {
        throw new Error('forced HD-path rollback failure')
      }
      changeHdPath(hdPath)
    }
    storage.armKeyringStateWriteFailure()

    const pendingChange = expect(service.changeAddressType(0, AddressType.P2TR)).rejects.toThrow(
      'forced keyring-state persistence failure'
    )
    for (let index = 0; index < 10 && service.password !== null; index += 1) {
      await flushMicrotasks()
    }
    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])

    releaseUnlock()
    await expect(pendingUnlock).resolves.toMatchObject({ isUnlocked: false })
    await pendingChange
    await flushMicrotasks()

    expect(service.memStore.getState()).toMatchObject({ isUnlocked: false, keyrings: [] })
    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])

    storage.disarmKeyringStateWriteFailure()
    await expect(service.submitPassword(oldPassword)).resolves.toMatchObject({ isUnlocked: true })
    expect(service.keyrings).toHaveLength(1)
    expect((service.keyrings[0] as any).hdPath).toBe(previousHdPath)
  })

  it('preserves the durable vault when an unlocked wallet has no live keyrings', async () => {
    const { service, storage } = await createWallet()
    service.keyrings = []
    service.addressTypes = []

    expect(service.memStore.getState().isUnlocked).toBe(true)
    expect(service.keyrings).toEqual([])

    await service.changePassword(oldPassword, newPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    expect(reopened.keyrings).toHaveLength(1)
    expect(reopened.addressTypes).toEqual([AddressType.P2WPKH])
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('re-encrypts the stored vault when changing the password while locked', async () => {
    const { service, storage } = await createWallet()
    const pendingMnemonic = await service.generatePreMnemonic()
    await service.setLocked()

    expect(service.keyrings).toEqual([])
    expect(service.addressTypes).toEqual([])
    expect(service.memStore.getState().isUnlocked).toBe(false)

    await service.changePassword(oldPassword, newPassword)

    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.addressTypes).toEqual([])
    expect(service.memStore.getState()).toMatchObject({
      isUnlocked: false,
      keyrings: [],
    })
    await expect(service.getPreMnemonics()).rejects.toThrow(
      'you_need_to_unlock_wallet_first'
    )
    await expect(service.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(service.getPreMnemonics()).resolves.toBe(pendingMnemonic)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(oldPassword)).rejects.toThrow('password_error')
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    expect(reopened.keyrings).toHaveLength(1)
    expect(reopened.addressTypes).toEqual([AddressType.P2WPKH])
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('re-encrypts a pending mnemonic only after the durable commit succeeds', async () => {
    const encryptor = new JsonEncryptor()
    const { service } = await createWallet(undefined, encryptor)
    const pendingMnemonic = await service.generatePreMnemonic()
    const oldCiphertext = service.memStore.getState().preMnemonics

    await service.changePassword(oldPassword, newPassword)

    const newCiphertext = service.memStore.getState().preMnemonics
    expect(newCiphertext).not.toBe(oldCiphertext)
    await expect(encryptor.decrypt(newPassword, newCiphertext)).resolves.toBe(pendingMnemonic)
    await expect(encryptor.decrypt(oldPassword, newCiphertext)).rejects.toThrow('bad password')
    await expect(service.getPreMnemonics()).resolves.toBe(pendingMnemonic)
  })

  it('does not restore a pending mnemonic cleared during password change', async () => {
    const encryptor = new BlockingJsonEncryptor()
    const { service } = await createWallet(undefined, encryptor)
    const pendingMnemonic = await service.generatePreMnemonic()
    const blockedEncryption = encryptor.blockNextEncryption(
      (password, data) => password === newPassword && data === pendingMnemonic
    )

    const pendingPasswordChange = service.changePassword(oldPassword, newPassword)
    await blockedEncryption.started

    service.removePreMnemonics()
    expect(service.memStore.getState().preMnemonics).toBe('')

    blockedEncryption.release()
    await pendingPasswordChange

    expect(service.password).toBe(newPassword)
    expect(service.memStore.getState().preMnemonics).toBe('')
    await expect(service.getPreMnemonics()).resolves.toBe('')
  })

  it('serializes pending mnemonic generation with password changes', async () => {
    const encryptor = new BlockingJsonEncryptor()
    const { service } = await createWallet(undefined, encryptor)
    const blockedEncryption = encryptor.blockNextEncryption()
    const pendingGeneration = service.generatePreMnemonic()
    await blockedEncryption.started

    const decryptCallCount = encryptor.decryptCallCount
    const pendingPasswordChange = service.changePassword(oldPassword, newPassword)
    const passwordChangeEnteredDuringGeneration =
      encryptor.decryptCallCount !== decryptCallCount

    blockedEncryption.release()
    const pendingMnemonic = await pendingGeneration
    await pendingPasswordChange

    expect(passwordChangeEnteredDuringGeneration).toBe(false)
    const ciphertext = service.memStore.getState().preMnemonics
    await expect(encryptor.decrypt(newPassword, ciphertext)).resolves.toBe(pendingMnemonic)
    await expect(encryptor.decrypt(oldPassword, ciphertext)).rejects.toThrow('bad password')
  })

  it('serializes password submission with password changes', async () => {
    const encryptor = new BlockingJsonEncryptor()
    const { service } = await createWallet(undefined, encryptor)
    const blockedEncryption = encryptor.blockNextEncryption()
    const pendingPasswordChange = service.changePassword(oldPassword, newPassword)
    await blockedEncryption.started

    const decryptCallCount = encryptor.decryptCallCount
    const pendingPasswordSubmission = expect(service.submitPassword(oldPassword)).rejects.toThrow(
      'password_error'
    )
    await flushMicrotasks()

    expect(encryptor.decryptCallCount).toBe(decryptCallCount)

    blockedEncryption.release()
    await pendingPasswordChange
    await pendingPasswordSubmission
  })

  it('leaves the wallet locked when locking races with a password change', async () => {
    const encryptor = new BlockingJsonEncryptor()
    const { service } = await createWallet(undefined, encryptor)
    await service.generatePreMnemonic()

    const blockedEncryption = encryptor.blockNextEncryption()
    const pendingPasswordChange = service.changePassword(oldPassword, newPassword)
    await blockedEncryption.started

    const pendingLock = service.setLocked()
    expect(service.memStore.getState().isUnlocked).toBe(false)
    expect(service.password).toBe(oldPassword)
    expect(service.keyrings).toHaveLength(1)

    blockedEncryption.release()
    await Promise.all([pendingPasswordChange, pendingLock])

    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.addressTypes).toEqual([])
    expect(service.memStore.getState()).toMatchObject({
      isUnlocked: false,
      keyrings: [],
    })
    await expect(service.getPreMnemonics()).rejects.toThrow(
      'you_need_to_unlock_wallet_first'
    )
  })

  it('re-encrypts the live keyrings when a lock request is queued behind the password change', async () => {
    const encryptor = new BlockingJsonEncryptor()
    const { service, storage } = await createWallet(undefined, encryptor)

    // Park a pre-mnemonic generation on its encryption so the password change
    // acquires unlockingMutex but queues behind it on passwordChangeMutex.
    const blockedEncryption = encryptor.blockNextEncryption()
    const pendingGeneration = service.generatePreMnemonic()
    await blockedEncryption.started
    const pendingPasswordChange = service.changePassword(oldPassword, newPassword)
    await flushMicrotasks()

    // A lock request now flips the public flag immediately, but its cleanup
    // queues on unlockingMutex behind the password change.
    const pendingLock = service.setLocked()
    expect(service.memStore.getState().isUnlocked).toBe(false)
    expect(service.password).toBe(oldPassword)
    expect(service.keyrings).toHaveLength(1)

    // Model a live mutation whose own persist has not landed yet (for example
    // a PQC counter reservation): the live keyrings are ahead of the last
    // durable vault when the password change runs.
    const extraKeyring = service.createTmpKeyring('Simple Key Pair', [
      '88544d58a328a380a4a433e4bb44b2a9f8a1152b1467393cfc8f8e5d81137162',
    ])
    service.keyrings.push(extraKeyring)
    service.addressTypes.push(AddressType.P2WPKH)

    blockedEncryption.release()
    await pendingGeneration
    await Promise.all([pendingPasswordChange, pendingLock])

    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.memStore.getState().isUnlocked).toBe(false)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
    expect(reopened.keyrings).toHaveLength(2)
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('rejects an empty new password while unlocked without touching live or durable state', async () => {
    const recordingLogger = new RecordingLogger()
    const { service, storage } = await createWallet(undefined, undefined, recordingLogger)
    const pendingMnemonic = await service.generatePreMnemonic()
    const previousPendingCiphertext = service.memStore.getState().preMnemonics
    const previousDurableBytes = JSON.stringify(storage.values.get('keyringState'))
    const previousStoreState = structuredClone(service.store.getState())
    const previousKeyring = service.keyrings[0]
    const writeCount = storage.keyringStateWrites.length

    await expect(service.changePassword(oldPassword, '')).rejects.toThrow(
      'password_cannot_be_empty'
    )
    await flushMicrotasks()

    expect(storage.keyringStateWrites).toHaveLength(writeCount)
    expect(JSON.stringify(storage.values.get('keyringState'))).toBe(previousDurableBytes)
    expect(service.store.getState()).toEqual(previousStoreState)
    expect(service.password).toBe(oldPassword)
    expect(service.keyrings[0]).toBe(previousKeyring)
    expect(service.memStore.getState()).toMatchObject({
      isUnlocked: true,
      preMnemonics: previousPendingCiphertext,
    })
    await expect(service.getPreMnemonics()).resolves.toBe(pendingMnemonic)
    expect(recordingLogger.errors).toHaveLength(0)

    const durableState = storage.values.get('keyringState')
    expect(encryptedPassword(durableState.booted)).toBe(oldPassword)
    expect(encryptedPassword(durableState.vault)).toBe(oldPassword)

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword('')).rejects.toThrow('password_error')
    await expect(reopened.submitPassword(oldPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('rejects an empty new password while locked and keeps the old password unlocking', async () => {
    const recordingLogger = new RecordingLogger()
    const { service, storage } = await createWallet(undefined, undefined, recordingLogger)
    await service.setLocked()
    const previousDurableBytes = JSON.stringify(storage.values.get('keyringState'))
    const previousStoreState = structuredClone(service.store.getState())
    const writeCount = storage.keyringStateWrites.length

    await expect(service.changePassword(oldPassword, '')).rejects.toThrow(
      'password_cannot_be_empty'
    )
    await flushMicrotasks()

    expect(storage.keyringStateWrites).toHaveLength(writeCount)
    expect(JSON.stringify(storage.values.get('keyringState'))).toBe(previousDurableBytes)
    expect(service.store.getState()).toEqual(previousStoreState)
    expect(service.password).toBeNull()
    expect(service.keyrings).toEqual([])
    expect(service.memStore.getState().isUnlocked).toBe(false)
    expect(recordingLogger.errors).toHaveLength(0)

    const durableState = storage.values.get('keyringState')
    expect(encryptedPassword(durableState.booted)).toBe(oldPassword)
    expect(encryptedPassword(durableState.vault)).toBe(oldPassword)

    await expect(service.submitPassword(oldPassword)).resolves.toMatchObject({ isUnlocked: true })

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword('')).rejects.toThrow('password_error')
    await expect(reopened.submitPassword(oldPassword)).resolves.toMatchObject({ isUnlocked: true })
    await expect(reopened.keyrings[0]!.serialize()).resolves.toMatchObject({
      mnemonic: sampleMnemonic,
    })
  })

  it('rejects a wrong old password distinctly without logging a service failure', async () => {
    const recordingLogger = new RecordingLogger()
    const { service, storage } = await createWallet(undefined, undefined, recordingLogger)
    const previousDurableState = structuredClone(storage.values.get('keyringState'))
    const writeCount = storage.keyringStateWrites.length

    await expect(service.changePassword('wrong-password', newPassword)).rejects.toThrow(
      'password_error'
    )
    await flushMicrotasks()

    expect(storage.keyringStateWrites).toHaveLength(writeCount)
    expect(storage.values.get('keyringState')).toEqual(previousDurableState)
    expect(service.password).toBe(oldPassword)
    expect(recordingLogger.errors).toHaveLength(0)
  })

  it('preserves the no-vault error without logging a transaction failure', async () => {
    const storage = new PasswordChangeStorage()
    const recordingLogger = new RecordingLogger()
    const service = new KeyringService()
    await service.init({
      storage: storage as any,
      encryptor: new JsonEncryptor(),
      logger: recordingLogger,
      t: (key: string) => key,
    })
    await service.boot(oldPassword)
    const previousStoreState = structuredClone(service.store.getState())

    await expect(service.changePassword(oldPassword, newPassword)).rejects.toThrow(
      'cannot_unlock_without_a_previous_vault'
    )
    await flushMicrotasks()

    expect(service.password).toBe(oldPassword)
    expect(service.store.getState()).toEqual(previousStoreState)
    expect(recordingLogger.errors).toHaveLength(0)
  })

  it('does not report failure when a post-commit update listener throws', async () => {
    const recordingLogger = new RecordingLogger()
    const { service, storage } = await createWallet(undefined, undefined, recordingLogger)
    service.on('update', () => {
      throw new Error('listener boom')
    })

    await expect(service.changePassword(oldPassword, newPassword)).resolves.toBeUndefined()
    await flushMicrotasks()

    expect(service.password).toBe(newPassword)
    expect(recordingLogger.errors).toHaveLength(1)
    expect((recordingLogger.errors[0]![1] as Error).message).toBe('listener boom')

    const reopened = await reopenWallet(storage)
    await expect(reopened.submitPassword(newPassword)).resolves.toMatchObject({ isUnlocked: true })
  })
})
