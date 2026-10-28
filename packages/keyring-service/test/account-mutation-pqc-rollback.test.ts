import { beforeAll, describe, expect, it, vi } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import { QbitHdKeyring } from '../src/keyrings/qbit-hd-keyring'
import type { Encryptor } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

const PQC_SIGNATURE_BYTES = 3680
const signingDigest = new Uint8Array(32).fill(7)

class MemoryStorage {
  readonly values = new Map<string, any>()
  failKeyringStateWriteWhen: ((value: any) => boolean) | undefined

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    const snapshot = structuredClone(value)
    if (key === 'keyringState' && this.failKeyringStateWriteWhen?.(snapshot)) {
      throw new Error(`forced storage failure for ${key}`)
    }
    this.values.set(key, snapshot)
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
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

async function reopenService(storage: MemoryStorage): Promise<KeyringService> {
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger(),
    t: (key: string) => key,
  })
  await service.submitPassword('password')
  return service
}

function vaultKeyringData(state: any): any | undefined {
  const encryptedVault = state?.vault
  if (!encryptedVault) return undefined
  return JSON.parse(encryptedVault).data?.[0]?.data
}

function durableKeyringData(storage: MemoryStorage): any | undefined {
  return vaultKeyringData(storage.values.get('keyringState'))
}

/**
 * Park an account mutation right after it captures its rollback snapshot
 * (the snapshot is the first serialize() call of the operation) so the test
 * controls exactly what interleaves before the mutation resumes.
 */
function parkRollbackSnapshot(keyring: QbitHdKeyring) {
  const realSerialize = keyring.serialize.bind(keyring)
  const snapshotTaken = deferred()
  const release = deferred()
  vi.spyOn(keyring, 'serialize').mockImplementationOnce(async () => {
    const snapshot = await realSerialize()
    snapshotTaken.resolve()
    await release.promise
    return snapshot
  })
  return { snapshotTaken: snapshotTaken.promise, release: release.resolve }
}

describe('account mutation rollback vs PQC counter persistence', () => {
  beforeAll(async () => {
    await init()
  })

  it.each([
    {
      operation: 'addition',
      start: (service: KeyringService, _accounts: string[]) =>
        service.addNewAccount(service.keyrings[0]!),
      // Only the account-addition commit carries a third active account.
      failWrite: (data: any) => (data?.activeIndexes?.length ?? 0) > 2,
    },
    {
      operation: 'removal',
      start: (service: KeyringService, accounts: string[]) =>
        service.removeAccount(accounts[1]!, service.keyrings[0]!.type),
      // Only the account-removal commit drops to a single active account.
      failWrite: (data: any) => (data?.activeIndexes?.length ?? 2) < 2,
    },
  ])(
    'never rewinds a concurrently persisted PQC counter when an account $operation fails',
    async ({ start, failWrite }) => {
      const { service, storage } = await createService()
      const keyring = service.keyrings[0] as QbitHdKeyring
      const accounts = await service.getAccounts()
      const account0 = accounts[0]!

      // Baseline: counter N = 1, durably persisted.
      await service.reservePqcSignatureCounter(account0)
      expect(await service.getPqcSignatureCounter(account0)).toBe(1)

      const park = parkRollbackSnapshot(keyring)
      storage.failKeyringStateWriteWhen = state => failWrite(vaultKeyringData(state))

      // 1. Start the account operation; it parks after capturing its rollback
      // snapshot at counter N.
      const pendingMutation = start(service, accounts)
      const mutationRejection = expect(pendingMutation).rejects.toThrow(
        'forced storage failure for keyringState'
      )
      await park.snapshotTaken

      // 2. A concurrent guarded counter operation reserves N+1, signs, caches
      // the signature, and persists. Give it every chance to interleave with
      // the parked account operation; under the fix it queues on the counter
      // locks the account operation holds instead.
      const pendingSignature = service.signPqcDigestWithCounter(
        account0,
        signingDigest,
        async () => new Uint8Array(PQC_SIGNATURE_BYTES)
      )
      for (
        let index = 0;
        index < 25 && (await keyring.getPqcSignatureCounter(account0)) === 1;
        index += 1
      ) {
        await flushMicrotasks()
      }

      // 3. Resume the account operation; its own persist fails.
      park.release()
      await mutationRejection
      const signature = await pendingSignature
      expect(signature).toMatchObject({
        cached: false,
        counter: { previousCounter: 1, newCounter: 2 },
      })

      // 4. The failed account mutation is rolled back — in place, so counter
      // operations that resolved the keyring before queueing stay attached to
      // the live instance.
      await expect(service.getAccounts()).resolves.toEqual(accounts)
      expect(service.keyrings[0]).toBe(keyring)

      // 5. Live state retains N+1 with its cache and provenance.
      expect(await service.getPqcSignatureCounter(account0)).toBe(2)
      expect(keyring.pqcSignatureCounterProvenance[account0]).toBe('local')
      await expect(
        keyring.getPqcSignatureCacheEntry(account0, signature.cacheKey)
      ).resolves.toMatchObject({ counter: 2 })

      // 5. Durable state retains N+1 with its cache and provenance.
      const durable = durableKeyringData(storage)
      expect(durable.activeIndexes).toEqual([0, 1])
      expect(durable.pqcSignatureCounters[account0]).toBe(2)
      expect(durable.pqcSignatureCounterProvenance[account0]).toBe('local')
      expect(durable.pqcSignatureCache[account0]?.[signature.cacheKey]).toMatchObject({
        counter: 2,
      })

      // 5. A relaunch from durable state sees the same.
      storage.failKeyringStateWriteWhen = undefined
      const reopened = await reopenService(storage)
      await expect(reopened.getAccounts()).resolves.toEqual(accounts)
      expect(await reopened.getPqcSignatureCounter(account0)).toBe(2)
      const reopenedKeyring = reopened.keyrings[0] as QbitHdKeyring
      expect(reopenedKeyring.pqcSignatureCounterProvenance[account0]).toBe('local')
      await expect(
        reopenedKeyring.getPqcSignatureCacheEntry(account0, signature.cacheKey)
      ).resolves.toMatchObject({ counter: 2 })

      // 6. The next reservation is N+2 — N+1 is never reissued.
      await expect(reopened.reservePqcSignatureCounter(account0)).resolves.toMatchObject({
        previousCounter: 2,
        newCounter: 3,
      })
    }
  )

  it('does not leave a rolled-back account addition address-resolvable', async () => {
    const { service, storage } = await createService()
    const keyring = service.keyrings[0] as QbitHdKeyring
    const accounts = await service.getAccounts()

    // The candidate a failed addition derives: the lowest inactive index.
    const candidate = await keyring.getQbitReceiveAccount(2)

    storage.failKeyringStateWriteWhen = state =>
      (vaultKeyringData(state)?.activeIndexes?.length ?? 0) > 2
    await expect(service.addNewAccount(keyring)).rejects.toThrow(
      'forced storage failure for keyringState'
    )

    // The rollback restored the account list, and the rejected candidate no
    // longer resolves as a wallet account through the derived-account cache.
    await expect(service.getAccounts()).resolves.toEqual(accounts)
    expect(keyring.getIndexByAddress(candidate.pubkey)).toBeNull()
    for (const address of Object.values(candidate.addresses)) {
      expect(keyring.getIndexByAddress(address)).toBeNull()
    }
    await expect(service.getKeyringForAccount(candidate.pubkey)).rejects.toThrow(
      'no_keyring_found_for_the_requested_account'
    )

    // A retried addition re-derives and activates the same candidate.
    storage.failKeyringStateWriteWhen = undefined
    await expect(service.addNewAccount(keyring)).resolves.toEqual([candidate.pubkey])
    expect(keyring.getIndexByAddress(candidate.pubkey)).toBe(2)
  })

  it('restores the removed account chain floor when the removal rolls back', async () => {
    const { service, storage } = await createService()
    const keyring = service.keyrings[0] as QbitHdKeyring
    const accounts = await service.getAccounts()
    const account1 = accounts[1]!

    // The wallet observed on-chain usage for the account being removed.
    keyring.pqcSignatureCounters[account1] = 3
    keyring.pqcSignatureCounterChainFloors[account1] = 3

    storage.failKeyringStateWriteWhen = state =>
      (vaultKeyringData(state)?.activeIndexes?.length ?? 2) < 2
    await expect(service.removeAccount(account1, keyring.type)).rejects.toThrow(
      'forced storage failure for keyringState'
    )

    // The rollback retains the account together with its observed floor:
    // without the floor the retained account would report 0+ live, and a
    // reopen's older-vault fallback could substitute the full counter — including
    // off-chain signatures — as known on-chain usage.
    await expect(service.getAccounts()).resolves.toEqual(accounts)
    expect(keyring.pqcSignatureCounterChainFloors[account1]).toBe(3)
    await expect(keyring.getPqcSignatureCounterMetadata(account1)).resolves.toMatchObject({
      knownOnChainSignatures: 3,
    })
  })

  it('serializes counter reservations behind an in-flight account addition', async () => {
    const { service } = await createService()
    const keyring = service.keyrings[0] as QbitHdKeyring
    const [account0] = await service.getAccounts()

    const park = parkRollbackSnapshot(keyring)
    const pendingAdd = service.addNewAccount(keyring)
    await park.snapshotTaken

    // While the addition holds the counter locks, a reservation must not
    // advance the live counter.
    const pendingReservation = service.reservePqcSignatureCounter(account0!)
    for (let index = 0; index < 25; index += 1) {
      await flushMicrotasks()
    }
    expect(await keyring.getPqcSignatureCounter(account0!)).toBe(0)

    park.release()
    await expect(pendingAdd).resolves.toHaveLength(1)
    await expect(pendingReservation).resolves.toMatchObject({
      previousCounter: 0,
      newCounter: 1,
    })
  })
})
