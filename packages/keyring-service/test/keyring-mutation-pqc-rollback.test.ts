import { beforeAll, describe, expect, it, vi } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import { HdKeyring } from '../src/keyrings/hd-keyring'
import type { Encryptor } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const hdMnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const secondQbitMnemonic =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const QBIT_TESTNET_PATH = "m/87'/1'/0'/0"
const QBIT_MAINNET_PATH = "m/87'/0'/0'/0"

const PQC_SIGNATURE_BYTES = 3680
const signingDigest = new Uint8Array(32).fill(7)

class MemoryStorage {
  readonly values = new Map<string, any>()
  /** Every keyring state that reached storage, in commit order. */
  readonly keyringStateWrites: any[] = []
  failingKeyringStateWrites = 0
  failAllKeyringStateWrites = false
  private keyringStateWriteGate: { markStarted: () => void; release: Promise<void> } | undefined

  /** Hold the next keyring state write until the test releases it. */
  blockNextKeyringStateWrite() {
    const started = deferred()
    const release = deferred()
    this.keyringStateWriteGate = { markStarted: started.resolve, release: release.promise }
    return { started: started.promise, release: release.resolve }
  }

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    const snapshot = structuredClone(value)
    const gate = key === 'keyringState' ? this.keyringStateWriteGate : undefined
    if (gate) {
      this.keyringStateWriteGate = undefined
      gate.markStarted()
      await gate.release
    }
    if (key === 'keyringState') {
      if (this.failAllKeyringStateWrites || this.failingKeyringStateWrites > 0) {
        this.failingKeyringStateWrites = Math.max(0, this.failingKeyringStateWrites - 1)
        throw new Error(`forced storage failure for ${key}`)
      }
      this.keyringStateWrites.push(snapshot)
    }
    this.values.set(key, snapshot)
  }
}

class JsonEncryptor implements Encryptor {
  private failNextVault = false

  failNextVaultEncryption(): void {
    this.failNextVault = true
  }

  async encrypt(password: string, data: any): Promise<string> {
    if (this.failNextVault && Array.isArray(data)) {
      this.failNextVault = false
      throw new Error('forced vault encryption failure')
    }
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
  const encryptor = new JsonEncryptor()
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor,
    logger: testLogger(),
    t: (key: string) => key,
  })
  await service.boot('password')
  // Keyring 0 is the signer every scenario advances the PQC counter on.
  await service.createKeyringWithMnemonics(
    sampleMnemonic,
    QBIT_TESTNET_PATH,
    '',
    AddressType.P2MR,
    2
  )
  return { service, storage, encryptor }
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

function vaultKeyrings(state: any): any[] {
  return JSON.parse(state.vault).data
}

function signerCounter(state: any, pubkey: string): number {
  return vaultKeyrings(state)[0].data.pqcSignatureCounters[pubkey] ?? 0
}

function testnetReceiveState(state: any): any {
  return vaultKeyrings(state)[0].data.qbitReceiveStates?.testnet4
}

/**
 * Park the mutation's own vault write (its first persistAllKeyrings call)
 * until the test releases it. The mutation has already changed the live
 * keyrings by then, and the pre-fix code had captured its vault snapshot.
 */
function parkNextPersist(service: KeyringService) {
  const realPersist = service.persistAllKeyrings
  const parked = deferred()
  const release = deferred()
  vi.spyOn(service, 'persistAllKeyrings').mockImplementationOnce(async () => {
    parked.resolve()
    await release.promise
    return realPersist()
  })
  return { parked: parked.promise, release: release.resolve }
}

/** Make the next changeHdPath call on the keyring (the rollback's restore) throw. */
function failNextHdPathRestore(keyring: any) {
  const changeHdPath = keyring.changeHdPath.bind(keyring)
  let calls = 0
  keyring.changeHdPath = (hdPath: string) => {
    calls += 1
    if (calls === 2) {
      throw new Error('forced HD-path rollback failure')
    }
    changeHdPath(hdPath)
  }
}

interface MutatorCase {
  name: string
  setup?: (service: KeyringService) => Promise<void>
  start: (service: KeyringService, signerAddress: string) => Promise<unknown>
  /** Whether the mutation is present in a serialized vault. */
  applied: (state: any) => boolean
  /**
   * The failed change survives the rollback: a Qbit keyring whose HD path
   * could not be restored stays on the new path.
   */
  keepsMutation?: boolean
}

async function addHdKeyring(service: KeyringService): Promise<void> {
  await service.createKeyringWithMnemonics(hdMnemonic, "m/84'/0'/0'/0", '', AddressType.P2WPKH, 1)
}

const mutators: MutatorCase[] = [
  {
    name: 'addKeyring',
    start: service =>
      service.addKeyring(
        new HdKeyring({ mnemonic: hdMnemonic, activeIndexes: [0], hdPath: "m/84'/0'/0'/0" }) as any,
        AddressType.P2WPKH
      ),
    applied: state => vaultKeyrings(state).length > 1,
  },
  {
    name: 'changeAddressType',
    setup: addHdKeyring,
    start: service => service.changeAddressType(1, AddressType.P2TR),
    applied: state => vaultKeyrings(state)[1].addressType === AddressType.P2TR,
  },
  {
    name: 'changeAddressType when the HD path cannot be restored',
    setup: async service => {
      await addHdKeyring(service)
      failNextHdPathRestore(service.keyrings[1])
    },
    start: service => service.changeAddressType(1, AddressType.P2TR),
    applied: state => vaultKeyrings(state)[1].addressType === AddressType.P2TR,
  },
  {
    name: 'syncQbitHdPath',
    setup: async service => {
      await service.createKeyringWithMnemonics(
        secondQbitMnemonic,
        QBIT_MAINNET_PATH,
        '',
        AddressType.P2MR,
        1
      )
    },
    // Moves only keyring 1; the signer is already on the testnet path.
    start: service => service.syncQbitHdPath(QBIT_TESTNET_PATH),
    applied: state => vaultKeyrings(state)[1].data.hdPath === QBIT_TESTNET_PATH,
  },
  {
    name: 'syncQbitHdPath when an HD path cannot be restored',
    setup: async service => {
      await service.createKeyringWithMnemonics(
        secondQbitMnemonic,
        QBIT_MAINNET_PATH,
        '',
        AddressType.P2MR,
        1
      )
      failNextHdPathRestore(service.keyrings[1])
    },
    start: service => service.syncQbitHdPath(QBIT_TESTNET_PATH),
    applied: state => vaultKeyrings(state)[1].data.hdPath === QBIT_TESTNET_PATH,
    keepsMutation: true,
  },
  {
    name: 'setQbitReceiveIntent',
    start: (service, signerAddress) => service.setQbitReceiveIntent(signerAddress, 'testnet4', 2),
    applied: state => testnetReceiveState(state)?.currentIndex === 2,
  },
  {
    name: 'markQbitReceiveIndexesIssued',
    start: (service, signerAddress) =>
      service.markQbitReceiveIndexesIssued(signerAddress, 'testnet4', [3]),
    applied: state => testnetReceiveState(state)?.issuedIndexes.includes(3) === true,
  },
  {
    name: 'recordQbitReceiveActivity',
    start: (service, signerAddress) =>
      service.recordQbitReceiveActivity(signerAddress, 'testnet4', [1]),
    applied: state => testnetReceiveState(state)?.usedIndexes.includes(1) === true,
  },
  {
    name: 'removeKeyring',
    setup: addHdKeyring,
    start: service => service.removeKeyring(1),
    applied: state => vaultKeyrings(state)[1].type === 'Empty',
  },
]

interface FailureMode {
  mode: string
  arm: (storage: MemoryStorage, encryptor: JsonEncryptor) => void
  error: string
  rollbackWriteFails: boolean
}

const failureModes: FailureMode[] = [
  {
    // The write fails before the vault is rebuilt; the rollback write succeeds.
    mode: 'its vault encryption fails',
    arm: (_storage, encryptor) => encryptor.failNextVaultEncryption(),
    error: 'forced vault encryption failure',
    rollbackWriteFails: false,
  },
  {
    // The vault is rebuilt but both durable writes fail; the rollback write
    // succeeds.
    mode: 'its durable write fails',
    arm: storage => {
      storage.failingKeyringStateWrites = 2
    },
    error: 'forced storage failure for keyringState',
    rollbackWriteFails: false,
  },
  {
    // Storage stays down through the rollback write and recovers afterwards.
    mode: 'its durable write and the rollback write fail',
    arm: storage => {
      storage.failAllKeyringStateWrites = true
    },
    error: 'forced storage failure for keyringState',
    rollbackWriteFails: true,
  },
]

const cases = mutators.flatMap(mutator =>
  failureModes.map(failure => ({
    ...mutator,
    ...failure,
    title: `never rewinds a concurrently persisted PQC counter when ${mutator.name} fails because ${failure.mode}`,
  }))
)

describe('keyring mutator rollback vs PQC counter persistence', () => {
  beforeAll(async () => {
    await init()
  })

  for (const {
    title,
    setup,
    start,
    applied,
    keepsMutation,
    arm,
    error,
    rollbackWriteFails,
  } of cases) {
    it(title, async () => {
      const { service, storage, encryptor } = await createService()
      await setup?.(service)
      const [signer] = await service.keyrings[0]!.getAccounts()

      // Baseline: counter N = 1, durably persisted.
      await service.reservePqcSignatureCounter(signer!)
      const baselineWrites = storage.keyringStateWrites.length
      expect(signerCounter(storage.values.get('keyringState'), signer!)).toBe(1)

      // 1. Start the mutation and park its own vault write.
      const park = parkNextPersist(service)
      const pendingMutation = start(service, signer!)
      const mutationRejection = expect(pendingMutation).rejects.toThrow(error)
      await park.parked

      // 2. A signature on another account reserves N+1, signs, caches and
      // persists while the mutation's write is pending.
      const signature = await service.signPqcDigestWithCounter(
        signer!,
        signingDigest,
        async () => new Uint8Array(PQC_SIGNATURE_BYTES)
      )
      expect(signature).toMatchObject({
        cached: false,
        counter: { previousCounter: 1, newCounter: 2 },
      })
      expect(signerCounter(storage.values.get('keyringState'), signer!)).toBe(2)

      // 3. The mutation's write fails and it rolls back.
      arm(storage, encryptor)
      park.release()
      await mutationRejection
      await flushMicrotasks()
      storage.failAllKeyringStateWrites = false

      // 4. No write ever moved the durable counter backward.
      const durableCounters = storage.keyringStateWrites
        .slice(baselineWrites)
        .map(state => signerCounter(state, signer!))
      expect(durableCounters.length).toBeGreaterThan(0)
      expect(durableCounters).toEqual([...durableCounters].sort((a, b) => a - b))
      const durable = storage.values.get('keyringState')
      expect(signerCounter(durable, signer!)).toBe(2)
      if (!rollbackWriteFails) {
        // The rollback write undid only the failed mutation.
        expect(applied(durable)).toBe(keepsMutation === true)
      }

      // 5. The store's vault keeps N+1 as well: reloading it (lock, then
      // unlock) never rewinds the live counter.
      await service.setLocked()
      await service.submitPassword('password')
      expect(await service.getPqcSignatureCounter(signer!)).toBe(2)
      expect(applied(service.store.getState())).toBe(keepsMutation === true)

      // 6. The next reservation is N+2 — N+1 is never reissued — and it
      // commits the rolled-back state durably.
      await expect(service.reservePqcSignatureCounter(signer!)).resolves.toMatchObject({
        previousCounter: 2,
        newCounter: 3,
      })
      const reopened = await reopenService(storage)
      expect(await reopened.getPqcSignatureCounter(signer!)).toBe(3)
      await expect(
        reopened.keyrings[0]!.getPqcSignatureCacheEntry!(signer!, signature.cacheKey)
      ).resolves.toMatchObject({ counter: 2 })
      expect(applied(reopened.store.getState())).toBe(keepsMutation === true)
    })
  }

  it('does not restore a removed keyring into the keyrings a lock replaced', async () => {
    const { service } = await createService()
    await addHdKeyring(service)

    const park = parkNextPersist(service)
    const pendingRemoval = service.removeKeyring(1)
    const removalRejection = expect(pendingRemoval).rejects.toThrow(
      'keyringcontroller_password_is_not_a_string'
    )
    await park.parked

    await service.setLocked()
    park.release()
    await removalRejection

    expect(service.keyrings).toEqual([])
    expect(service.addressTypes).toEqual([])
    await service.submitPassword('password')
    expect(service.keyrings).toHaveLength(2)
    expect(service.keyrings[1]!.type).toBe('HD Key Tree')
  })

  it('rejects a keyring index that holds no keyring without touching the live list', async () => {
    const { service, storage } = await createService()
    const durableBefore = structuredClone(storage.values.get('keyringState'))

    await expect(service.removeKeyring(3)).rejects.toThrow(
      'no_keyring_found_for_the_requested_account'
    )
    await expect(service.changeAddressType(3, AddressType.P2TR)).rejects.toThrow(
      'no_keyring_found_for_the_requested_account'
    )

    expect(service.keyrings).toHaveLength(1)
    expect(storage.values.get('keyringState')).toEqual(durableBefore)
    await expect(
      service.reservePqcSignatureCounter((await service.getAccounts())[0]!)
    ).resolves.toMatchObject({ newCounter: 1 })
  })

  it('does not lock a session unlocked during the fail-closed address-type rollback', async () => {
    const { service, storage, encryptor } = await createService()
    await addHdKeyring(service)
    failNextHdPathRestore(service.keyrings[1])

    // The change's own write fails, the HD-path restore fails, and the
    // rollback write that follows is held.
    encryptor.failNextVaultEncryption()
    const rollbackWrite = storage.blockNextKeyringStateWrite()
    const pendingChange = service.changeAddressType(1, AddressType.P2TR)
    const changeRejection = expect(pendingChange).rejects.toThrow('forced vault encryption failure')
    await rollbackWrite.started

    // The user locks and unlocks again while the rollback write is pending.
    await service.setLocked()
    const pendingUnlock = service.submitPassword('password')
    rollbackWrite.release()
    await changeRejection
    await expect(pendingUnlock).resolves.toMatchObject({ isUnlocked: true })
    await flushMicrotasks()

    // The fail-closed lockdown belonged to the discarded session; the new one
    // stays unlocked on the rolled-back vault.
    expect(service.password).toBe('password')
    expect(service.memStore.getState().isUnlocked).toBe(true)
    expect(service.keyrings).toHaveLength(2)
    expect(service.addressTypes[1]).toBe(AddressType.P2WPKH)
    expect(vaultKeyrings(storage.values.get('keyringState'))[1].addressType).toBe(
      AddressType.P2WPKH
    )
  })

  it('does not change the address type when the wallet locks while the rollback copy is built', async () => {
    const { service, storage } = await createService()
    await addHdKeyring(service)
    const durableBefore = structuredClone(storage.values.get('keyringState'))
    const restoreKeyring = service._restoreKeyring
    vi.spyOn(service, '_restoreKeyring').mockImplementationOnce(async serialized => {
      await service.setLocked()
      return restoreKeyring(serialized)
    })

    await expect(service.changeAddressType(1, AddressType.P2TR)).rejects.toThrow(
      'you_need_to_unlock_wallet_first'
    )

    expect(service.keyrings).toEqual([])
    expect(service.addressTypes).toEqual([])
    expect(storage.values.get('keyringState')).toEqual(durableBefore)
    await service.submitPassword('password')
    expect(service.addressTypes[1]).toBe(AddressType.P2WPKH)
  })
})
