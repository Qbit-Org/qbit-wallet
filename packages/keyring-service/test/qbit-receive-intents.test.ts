import { beforeAll, describe, expect, it, vi } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import {
  PQC_MAX_SIGNATURES,
  QbitHdKeyring,
  type QbitReceiveIntentState,
} from '../src/keyrings/qbit-hd-keyring'
import type { Encryptor } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

class MemoryStorage {
  readonly values = new Map<string, any>()
  failSetKeys = new Set<string>()
  failKeyringStateWriteWhen: ((value: any) => boolean) | undefined

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    const snapshot = structuredClone(value)
    if (this.failSetKeys.has(key)) {
      throw new Error(`forced storage failure for ${key}`)
    }
    if (key === 'keyringState' && this.failKeyringStateWriteWhen?.(snapshot)) {
      throw new Error(`forced storage failure for ${key}`)
    }
    this.values.set(key, snapshot)
  }

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    const stored = (await this.get(name)) || template
    await this.set(name, stored)
    return stored
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

class BlockingJsonEncryptor extends JsonEncryptor {
  private blockedEncryption:
    | {
        shouldBlock: (password: string, data: any) => boolean
        markStarted: () => void
        waitForRelease: Promise<void>
      }
    | undefined

  blockNextEncryption(
    shouldBlock: (password: string, data: any) => boolean
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
}

function testLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function createService(
  storage = new MemoryStorage(),
  encryptor: Encryptor = new JsonEncryptor()
) {
  const service = new KeyringService()
  await service.init({
    storage,
    encryptor,
    logger: testLogger(),
    t: (key: string) => key,
  })
  await service.boot('password')
  await service.createKeyringWithMnemonics(sampleMnemonic, "m/87'/1'/0'/0", '', AddressType.P2MR, 1)
  return { service, storage }
}

function receiveStateFromStoreState(
  state: any,
  network: 'mainnet' | 'testnet4' | 'regtest'
): QbitReceiveIntentState | undefined {
  const encryptedVault = state?.vault
  if (!encryptedVault) return undefined
  const vault = JSON.parse(encryptedVault).data
  return vault[0].data.qbitReceiveStates?.[network]
}

function vaultReceiveState(
  storage: MemoryStorage,
  network: 'mainnet' | 'testnet4' | 'regtest'
): QbitReceiveIntentState | undefined {
  return receiveStateFromStoreState(storage.values.get('keyringState'), network)
}

function encryptedPassword(ciphertext: string | null): string | undefined {
  if (!ciphertext) return undefined
  return JSON.parse(ciphertext).password
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('qbit receive intent persistence', () => {
  beforeAll(async () => {
    await init()
  })

  it('round-trips current, issued, and used indexes independently per network', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0],
      hdPath: "m/87'/1'/0'/0",
    })

    await keyring.setQbitReceiveIntent('testnet4', 0)
    keyring.recordQbitReceiveActivity('testnet4', [0])
    await keyring.setQbitReceiveIntent('regtest', 1)

    const revived = new QbitHdKeyring(await keyring.serialize())
    expect(revived.getQbitReceiveState('testnet4')).toEqual({
      currentIndex: 0,
      issuedIndexes: [0],
      usedIndexes: [0],
    })
    expect(revived.getQbitReceiveState('regtest')).toEqual({
      currentIndex: 1,
      issuedIndexes: [1],
      usedIndexes: [],
    })
    expect(revived.getQbitReceiveState('mainnet')).toEqual({
      currentIndex: null,
      issuedIndexes: [],
      usedIndexes: [],
    })
    expect((await revived.getQbitAccounts()).map(account => account.index)).toEqual([0, 1])
  })

  it('keeps mainnet and testnet counters bound to their independently derived keys', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0],
      hdPath: "m/87'/1'/0'/0",
    })
    const [testnetAccount] = await keyring.getQbitAccounts()
    await keyring.reservePqcSignatureCounter(testnetAccount!.pubkey)
    await keyring.setQbitReceiveIntent('testnet4', 0)

    keyring.changeHdPath("m/87'/0'/0'/0")
    const [mainnetAccount] = await keyring.getQbitAccounts()

    expect(mainnetAccount!.pubkey).not.toBe(testnetAccount!.pubkey)
    expect(await keyring.getPqcSignatureCounter(mainnetAccount!.pubkey)).toBe(0)
    expect(keyring.getQbitReceiveState('mainnet').currentIndex).toBeNull()
    expect(keyring.getQbitReceiveState('testnet4').currentIndex).toBe(0)

    keyring.changeHdPath("m/87'/1'/0'/0")
    expect(await keyring.getPqcSignatureCounter(testnetAccount!.pubkey)).toBe(1)
  })

  it('persists one idempotent intent mutation before returning it', async () => {
    const { service, storage } = await createService()
    const [account] = await service.getAccounts()

    await Promise.all([
      service.setQbitReceiveIntent(account!, 'testnet4', 1),
      service.setQbitReceiveIntent(account!, 'testnet4', 1),
    ])

    expect(vaultReceiveState(storage, 'testnet4')).toEqual({
      currentIndex: 1,
      issuedIndexes: [1],
      usedIndexes: [],
    })
    expect((service.keyrings[0] as QbitHdKeyring).activeIndexes).toEqual([0, 1])
  })

  it('rejects a receive intent that loses to a last-slot counter reservation', async () => {
    const { service, storage } = await createService()
    const [account] = await service.getAccounts()
    const keyring = service.keyrings[0] as QbitHdKeyring
    await service.applyPqcSignatureCounterFloor(account!, PQC_MAX_SIGNATURES - 1)

    const reservationMade = deferred()
    const releaseReservation = deferred()
    const reserveCounter = keyring.reservePqcSignatureCounter.bind(keyring)
    vi.spyOn(keyring, 'reservePqcSignatureCounter').mockImplementationOnce(
      async (pubkeyOrAddress, count) => {
        const reservation = await reserveCounter(pubkeyOrAddress, count)
        reservationMade.resolve()
        await releaseReservation.promise
        return reservation
      }
    )

    const reservationPromise = service.reservePqcSignatureCounter(account!)
    await reservationMade.promise

    const receivePromise = service.setQbitReceiveIntent(account!, 'testnet4', 0)
    const receiveAssertion = expect(receivePromise).rejects.toMatchObject({
      code: 'PQC_SIGNATURE_COUNTER_EXHAUSTED',
      counter: PQC_MAX_SIGNATURES,
    })
    releaseReservation.resolve()

    await expect(reservationPromise).resolves.toMatchObject({
      newCounter: PQC_MAX_SIGNATURES,
      signaturesRemaining: 0,
    })
    await receiveAssertion
    expect(keyring.getQbitReceiveState('testnet4')).toEqual({
      currentIndex: null,
      issuedIndexes: [],
      usedIndexes: [],
    })
    expect(vaultReceiveState(storage, 'testnet4')).toBeUndefined()
  })

  it('recovers the durable current intent and activity after a full relaunch', async () => {
    const { service, storage } = await createService()
    const [account] = await service.getAccounts()
    await service.setQbitReceiveIntent(account!, 'testnet4', 1)
    await service.recordQbitReceiveActivity(account!, 'testnet4', [0])
    await service.setLocked()

    const relaunched = new KeyringService()
    await relaunched.init({
      storage,
      encryptor: new JsonEncryptor(),
      logger: testLogger(),
      t: (key: string) => key,
    })
    await relaunched.submitPassword('password')
    const [relaunchedAccount] = await relaunched.getAccounts()

    await expect(relaunched.getQbitReceiveState(relaunchedAccount!, 'testnet4')).resolves.toEqual({
      currentIndex: 1,
      issuedIndexes: [1],
      usedIndexes: [0],
    })
  })

  it('rolls memory back when the durable vault write fails', async () => {
    const { service, storage } = await createService()
    const [account] = await service.getAccounts()
    await service.setQbitReceiveIntent(account!, 'testnet4', 0)
    storage.failSetKeys.add('keyringState')

    await expect(service.setQbitReceiveIntent(account!, 'testnet4', 1)).rejects.toThrow(
      'forced storage failure'
    )

    expect((service.keyrings[0] as QbitHdKeyring).activeIndexes).toEqual([0])
    await expect(service.getQbitReceiveState(account!, 'testnet4')).resolves.toEqual({
      currentIndex: 0,
      issuedIndexes: [0],
      usedIndexes: [],
    })
  })

  it.each(['intent', 'activity'] as const)(
    'serializes %s rollback with password changes',
    async mutationKind => {
      const storage = new MemoryStorage()
      const encryptor = new BlockingJsonEncryptor()
      const { service } = await createService(storage, encryptor)
      const [account] = await service.getAccounts()
      const keyring = service.keyrings[0] as QbitHdKeyring
      if (mutationKind === 'activity') {
        await service.setQbitReceiveIntent(account!, 'testnet4', 0)
      }

      const blockedEncryption = encryptor.blockNextEncryption(
        password => password === 'new-password'
      )
      const pendingPasswordChange = service.changePassword('password', 'new-password')
      await blockedEncryption.started

      storage.failKeyringStateWriteWhen = state => {
        const receiveState = receiveStateFromStoreState(state, 'testnet4')
        return mutationKind === 'intent'
          ? receiveState?.currentIndex === 1
          : receiveState?.usedIndexes.includes(0) === true
      }
      const operationEntry = vi.spyOn(keyring, 'getAccounts')
      const pendingMutation =
        mutationKind === 'intent'
          ? service.setQbitReceiveIntent(account!, 'testnet4', 1)
          : service.recordQbitReceiveActivity(account!, 'testnet4', [0])
      const enteredBeforePasswordCommit = operationEntry.mock.calls.length > 0

      blockedEncryption.release()
      await pendingPasswordChange
      await expect(pendingMutation).rejects.toThrow('forced storage failure for keyringState')
      await flushMicrotasks()

      expect(enteredBeforePasswordCommit).toBe(false)
      const liveState = service.store.getState()
      const durableState = storage.values.get('keyringState')
      expect(encryptedPassword(liveState.booted)).toBe('new-password')
      expect(encryptedPassword(liveState.vault)).toBe('new-password')
      expect(liveState).toEqual(durableState)
      await expect(service.getQbitReceiveState(account!, 'testnet4')).resolves.toEqual(
        mutationKind === 'intent'
          ? { currentIndex: null, issuedIndexes: [], usedIndexes: [] }
          : { currentIndex: 0, issuedIndexes: [0], usedIndexes: [] }
      )
    }
  )
})
