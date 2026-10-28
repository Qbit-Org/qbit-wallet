import { beforeAll, describe, expect, it, vi } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import { QbitHdKeyring } from '../src/keyrings/qbit-hd-keyring'
import type { Encryptor } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

const PQC_SIGNATURE_BYTES = 3680
const KEYRING_NOT_LIVE =
  'The keyring was locked, removed or replaced while this operation was in progress'

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, structuredClone(value))
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

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill)
}

function signatureBytes(): Uint8Array {
  return new Uint8Array(PQC_SIGNATURE_BYTES)
}

async function createService() {
  const storage = new MemoryStorage()
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger(),
    t: (key: string) => key,
  })
  await service.boot('password')
  await service.createKeyringWithMnemonics(sampleMnemonic, "m/87'/1'/0'/0", '', AddressType.P2MR, 2)
  return { service, storage }
}

function durableKeyringData(storage: MemoryStorage): any {
  return JSON.parse(storage.values.get('keyringState').vault).data[0].data
}

function durableCounter(storage: MemoryStorage, pubkey: string): number {
  return durableKeyringData(storage).pqcSignatureCounters[pubkey] ?? 0
}

/**
 * Hold `pubkey`'s counter lock inside a signer callback. The signature's
 * counter reservation is already durable when the hold starts.
 */
async function holdCounterLock(service: KeyringService, pubkey: string) {
  const signing = deferred()
  const release = deferred()
  const pending = service
    .signPqcDigestWithCounter(pubkey, digest(1), async () => {
      signing.resolve()
      await release.promise
      return signatureBytes()
    })
    .then(
      signature => ({ signature }),
      (error: Error) => ({ error })
    )
  await signing.promise
  return { pending, release: release.resolve }
}

/** Resolve once the next operation has resolved its counter target. */
function trackCounterTarget(service: KeyringService) {
  const resolved = deferred()
  const realTarget = (service as any).getPqcSignatureCounterTarget
  vi.spyOn(service as any, 'getPqcSignatureCounterTarget').mockImplementationOnce(
    async (address: unknown) => {
      const target = await realTarget(address)
      resolved.resolve()
      return target
    }
  )
  return resolved.promise
}

/** Resolve once the next account mutation has resolved the keyring it changes. */
function trackAccountMutationKeyring(service: KeyringService) {
  const resolved = deferred()
  let keyring: unknown
  const realLockPubkeys = (service as any).getAccountMutationLockPubkeys
  vi.spyOn(service as any, 'getAccountMutationLockPubkeys').mockImplementationOnce(
    async (target: unknown, options: unknown) => {
      keyring = target
      const pubkeys = await realLockPubkeys(target, options)
      resolved.resolve()
      return pubkeys
    }
  )
  return { resolved: resolved.promise, keyring: () => keyring }
}

/** Lock, then unlock: the live keyrings are new instances loaded from the vault. */
async function lockAndUnlock(service: KeyringService) {
  await service.setLocked()
  await service.submitPassword('password')
}

describe('PQC counter reservations across a lock and unlock', () => {
  beforeAll(async () => {
    await init()
  })

  it('refuses, without signing, a signature queued on its counter lock across a lock and unlock', async () => {
    const { service, storage } = await createService()
    const [account0] = await service.getAccounts()
    const detached = service.keyrings[0]

    // Signature A holds the counter lock with counter 1 durably reserved.
    const signatureA = await holdCounterLock(service, account0!)
    expect(durableCounter(storage, account0!)).toBe(1)

    // Signature B resolves the live keyring, then queues behind A.
    const targetResolved = trackCounterTarget(service)
    const signerB = vi.fn(async () => signatureBytes())
    const pendingB = service.signPqcDigestWithCounter(account0!, digest(2), signerB)
    const settledB = pendingB.then(
      signature => ({ signature }),
      (error: Error) => ({ error })
    )
    await targetResolved

    await lockAndUnlock(service)
    expect(service.keyrings[0]).not.toBe(detached)

    signatureA.release()
    const [resultA, resultB] = await Promise.all([signatureA.pending, settledB])

    // B targets the keyring the lock detached: it never reaches its signer.
    expect(resultB).toEqual({ error: new Error(KEYRING_NOT_LIVE) })
    expect(signerB).not.toHaveBeenCalled()
    // A's counter was durable before the lock, but its signature-cache write
    // targets the detached keyring and cannot commit either.
    expect(resultA).toEqual({ error: new Error(KEYRING_NOT_LIVE) })

    // The next signature on the live keyring takes a count no released
    // signature holds, and the vault records it.
    const signatureC = await service.signPqcDigestWithCounter(account0!, digest(3), async () =>
      signatureBytes()
    )
    expect(signatureC.counter).toMatchObject({ previousCounter: 1, newCounter: 2 })
    expect(durableCounter(storage, account0!)).toBe(2)
  })

  it('refuses to sign when a lock and unlock land between the reservation and its write', async () => {
    const { service, storage } = await createService()
    const [account0] = await service.getAccounts()
    const detached = service.keyrings[0] as QbitHdKeyring

    // Park the reservation after it advanced the detached keyring's counter:
    // the counter-lock check has passed and the vault write is still ahead.
    const reserved = deferred()
    const resume = deferred()
    const realReserve = detached.reservePqcSignatureCounter.bind(detached)
    vi.spyOn(detached, 'reservePqcSignatureCounter').mockImplementationOnce(
      async (pubkey, count) => {
        const reservation = await realReserve(pubkey, count)
        reserved.resolve()
        await resume.promise
        return reservation
      }
    )

    const signer = vi.fn(async () => signatureBytes())
    const pending = service.signPqcDigestWithCounter(account0!, digest(2), signer)
    const rejection = expect(pending).rejects.toThrow(KEYRING_NOT_LIVE)
    await reserved.promise

    await lockAndUnlock(service)
    resume.resolve()
    await rejection

    expect(signer).not.toHaveBeenCalled()
    expect(await detached.getPqcSignatureCounter(account0!)).toBe(0)
    expect(durableCounter(storage, account0!)).toBe(0)
    const next = await service.signPqcDigestWithCounter(account0!, digest(3), async () =>
      signatureBytes()
    )
    expect(next.counter).toMatchObject({ previousCounter: 0, newCounter: 1 })
    expect(durableCounter(storage, account0!)).toBe(1)
  })

  it.each([
    {
      operation: 'reservePqcSignatureCounter',
      start: (service: KeyringService, pubkey: string) =>
        service.reservePqcSignatureCounter(pubkey),
    },
    {
      operation: 'applyPqcSignatureCounterFloor',
      start: (service: KeyringService, pubkey: string) =>
        service.applyPqcSignatureCounterFloor(pubkey, 5),
    },
  ])('refuses $operation queued across a lock and unlock', async ({ start }) => {
    const { service, storage } = await createService()
    const [account0] = await service.getAccounts()
    const held = await holdCounterLock(service, account0!)

    const targetResolved = trackCounterTarget(service)
    const pending = start(service, account0!)
    const rejection = expect(pending).rejects.toThrow(KEYRING_NOT_LIVE)
    await targetResolved

    await lockAndUnlock(service)
    held.release()
    await rejection
    await held.pending

    // The live keyring and the vault agree on the counter.
    expect(durableCounter(storage, account0!)).toBe(1)
    expect(await service.getPqcSignatureCounter(account0!)).toBe(1)
  })

  it.each([
    {
      operation: 'addNewAccount',
      start: (service: KeyringService, _accounts: string[]) =>
        service.addNewAccount(service.keyrings[0]!),
    },
    {
      operation: 'removeAccount',
      start: (service: KeyringService, accounts: string[]) =>
        service.removeAccount(accounts[1]!, service.keyrings[0]!.type),
    },
  ])(
    'does not report $operation as done when a lock and unlock replaced its keyring',
    async ({ start }) => {
      const { service, storage } = await createService()
      const accounts = await service.getAccounts()
      const detached = service.keyrings[0]
      const held = await holdCounterLock(service, accounts[0]!)

      const mutation = trackAccountMutationKeyring(service)
      const pending = start(service, accounts)
      const rejection = expect(pending).rejects.toThrow(KEYRING_NOT_LIVE)
      await mutation.resolved
      expect(mutation.keyring()).toBe(detached)

      await lockAndUnlock(service)
      held.release()
      await rejection
      await held.pending

      expect(durableKeyringData(storage).activeIndexes).toEqual([0, 1])
      await expect(service.getAccounts()).resolves.toEqual(accounts)
      expect(service.memStore.getState().keyrings[0]!.accounts).toHaveLength(2)
    }
  )

  it('does not report a receive intent as saved when a lock and unlock replaced its keyring', async () => {
    const { service, storage } = await createService()
    const [account0] = await service.getAccounts()
    const detached = service.keyrings[0] as QbitHdKeyring
    const held = await holdCounterLock(service, account0!)

    // The intent resolves its keyring and target account, then queues on
    // the target's counter lock.
    const targetResolved = deferred()
    const realReceiveAccount = detached.getQbitReceiveAccount.bind(detached)
    vi.spyOn(detached, 'getQbitReceiveAccount').mockImplementationOnce(async index => {
      const account = await realReceiveAccount(index)
      targetResolved.resolve()
      return account
    })
    const pending = service.setQbitReceiveIntent(account0!, 'testnet4', 0)
    const rejection = expect(pending).rejects.toThrow(KEYRING_NOT_LIVE)
    await targetResolved.promise

    await lockAndUnlock(service)
    held.release()
    await rejection
    await held.pending

    expect(durableKeyringData(storage).qbitReceiveStates?.testnet4?.currentIndex ?? null).toBeNull()
    const live = service.keyrings[0] as QbitHdKeyring
    expect(live.getQbitReceiveState('testnet4').currentIndex).toBeNull()
  })
})
