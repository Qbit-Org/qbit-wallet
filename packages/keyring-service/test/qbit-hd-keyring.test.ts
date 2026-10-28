import { beforeAll, describe, expect, it, vi } from 'vitest'

import { init, sign as rawPqcSign, verify as verifyPqc } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  SIGHASH_DEFAULT,
  buildControlBlock,
  bytesToHex as protocolBytesToHex,
  createP2mrMessageProof,
  createP2mrPsbt,
  decodePsbt,
  descriptorChecksum,
  hexToBytes as protocolHexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrSighash,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  qbitDataSigPqcHash,
  qbitWalletMessageHash,
  verifyP2mrMessageProof,
  type P2mrSigningKey,
  type P2mrSpentOutput,
  type Psbt,
} from '@qbit-oss/protocol'
import { AddressType } from '@qbit/wallet-types'
import { KeyringService, QbitRestoredFloorConfirmationError } from '../src/keyring-service'
import { ColdWalletKeyring } from '../src/keyrings/cold-wallet-keyring'
import { QbitHdKeyring, QbitPqcSignatureCounterError } from '../src/keyrings/qbit-hd-keyring'
import { Encryptor } from '../src/types'

const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const PQC_MAX_SIGNATURES = 1 << 30
const PQC_SIGNATURE_BYTES = 3680
const DIGEST_A = 'ab'.repeat(32)
const DIGEST_B = 'cd'.repeat(32)
const DIGEST_C = 'ef'.repeat(32)

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

class BlockingMemoryStorage extends MemoryStorage {
  trackedCompletedWrites = 0
  private trackedKey: string | undefined
  private nextSetBlock:
    | { key: string; markStarted: () => void; waitForRelease: Promise<void> }
    | undefined

  blockNextSet(key: string) {
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let release!: () => void
    const waitForRelease = new Promise<void>(resolve => {
      release = resolve
    })
    this.trackedKey = key
    this.trackedCompletedWrites = 0
    this.nextSetBlock = { key, markStarted, waitForRelease }
    return { started, release }
  }

  override async set(key: string, value: any): Promise<void> {
    const snapshot = structuredClone(value)
    const block = this.nextSetBlock?.key === key ? this.nextSetBlock : undefined
    if (block) {
      this.nextSetBlock = undefined
      block.markStarted()
      await block.waitForRelease
    }
    await super.set(key, snapshot)
    if (this.trackedKey === key) {
      this.trackedCompletedWrites += 1
    }
  }
}

async function createUnlockedQbitService(
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
  const keyring = await service.createKeyringWithMnemonics(
    sampleMnemonic,
    "m/87'/1'/0'/0",
    '',
    AddressType.P2MR,
    2
  )
  return { service, keyring, storage, encryptor }
}

async function createRestoredQbitService(
  storage = new MemoryStorage(),
  observedSignatures = 3,
  accountCount = 1,
  addressDiscoveryComplete = true
) {
  const service = new KeyringService()
  await service.init({
    storage,
    encryptor: new JsonEncryptor(),
    logger: testLogger(),
    t: (key: string) => key,
  })
  await service.boot('password')
  const keyring = service.createTmpKeyring(QbitHdKeyring.type, {
    mnemonic: sampleMnemonic,
    activeIndexes: [0],
    hdPath: "m/87'/1'/0'/0",
  }) as QbitHdKeyring
  await service.addDiscoveredQbitKeyring(keyring, accountCount, addressDiscoveryComplete, 'regtest')
  const [pubkey] = await keyring.getAccounts()
  await service.restorePqcSignatureCounterFloors(pubkey!, () => ({ observedSignatures }), {
    lookahead: 0,
  })
  return { service, keyring, storage, pubkey: pubkey! }
}

function vaultPayload(storage: MemoryStorage) {
  const state = storage.values.get('keyringState')
  return JSON.parse(state.vault).data
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function dummyPqcSignature(byte: number): Uint8Array {
  return new Uint8Array(PQC_SIGNATURE_BYTES).fill(byte)
}

async function buildP2mrSpendFixture(
  keyring: QbitHdKeyring,
  options: { inputCount?: number; txidSeed?: number; hashType?: number } = {}
): Promise<{
  psbt: Psbt
  keys: P2mrSigningKey[]
  pubkey: Uint8Array
  leafHash: Uint8Array
  spentOutputs: P2mrSpentOutput[]
}> {
  const [account] = await keyring.getQbitAccounts()
  const pubkey = protocolHexToBytes(account!.pubkey)
  const leafScript = protocolHexToBytes(account!.leafScript)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
  const scriptPubKey = protocolHexToBytes(account!.scriptPubKey)
  const inputCount = options.inputCount ?? 1
  const txidSeed = options.txidSeed ?? 1
  const spentOutputs = Array.from({ length: inputCount }, (_, index) => ({
    value: 100_000n + BigInt(index) * 1_000n,
    scriptPubKey,
  }))
  const totalInput = spentOutputs.reduce((sum, output) => sum + output.value, 0n)
  const psbt = createP2mrPsbt({
    inputs: spentOutputs.map((witnessUtxo, index) => ({
      prevout: { txid: fixtureTxid(txidSeed + index), vout: index },
      witnessUtxo,
      leafScript,
      controlBlock,
      merkleRoot: leafHash,
    })),
    outputs: [{ value: totalInput - 2_000n, scriptPubKey }],
  })
  const keys = spentOutputs.map((_, inputIndex) => ({
    inputIndex,
    pubkey,
    leafHash,
    ...(options.hashType === undefined ? {} : { hashType: options.hashType }),
  }))
  return { psbt, keys, pubkey, leafHash, spentOutputs }
}

async function buildMixedAccountP2mrSpendFixture(keyring: QbitHdKeyring): Promise<{
  psbt: Psbt
  keys: P2mrSigningKey[]
}> {
  const accounts = (await keyring.getQbitAccounts()).slice(0, 2)
  if (accounts.length !== 2) {
    throw new Error('mixed-account fixture requires two accounts')
  }

  const plans = accounts.map((account, index) => {
    const pubkey = protocolHexToBytes(account.pubkey)
    const leafScript = protocolHexToBytes(account.leafScript)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    return {
      input: {
        prevout: { txid: fixtureTxid(80 + index), vout: index },
        witnessUtxo: {
          value: 100_000n + BigInt(index) * 1_000n,
          scriptPubKey: protocolHexToBytes(account.scriptPubKey),
        },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
      },
      key: { inputIndex: index, pubkey, leafHash },
    }
  })
  const psbt = createP2mrPsbt({
    inputs: plans.map(plan => plan.input),
    outputs: [
      {
        value: 199_000n,
        scriptPubKey: protocolHexToBytes(accounts[0]!.scriptPubKey),
      },
    ],
  })
  return { psbt, keys: plans.map(plan => plan.key) }
}

function fixtureTxid(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff)
}

function firstP2mrSignature(psbt: Psbt): Uint8Array {
  return decodePsbt(psbt).inputs[0]!.scriptSigs[0]!.signature.signature
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

class BlockingJsonEncryptor extends JsonEncryptor {
  trackedEncryptions = 0
  private nextEncryptionBlock:
    | { markStarted: () => void; waitForRelease: Promise<void> }
    | undefined

  blockNextEncryption() {
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let release!: () => void
    const waitForRelease = new Promise<void>(resolve => {
      release = resolve
    })
    this.trackedEncryptions = 0
    this.nextEncryptionBlock = { markStarted, waitForRelease }
    return { started, release }
  }

  override async encrypt(password: string, data: any): Promise<string> {
    const block = this.nextEncryptionBlock
    this.nextEncryptionBlock = undefined
    this.trackedEncryptions += 1
    const encrypted = await super.encrypt(password, data)
    if (block) {
      block.markStarted()
      await block.waitForRelease
    }
    return encrypted
  }
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
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

describe('qbit-hd-keyring', () => {
  beforeAll(async () => {
    await init()
  })

  it('derives deterministic P2MR accounts from a mnemonic', async () => {
    const first = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0, 1],
      hdPath: "m/87'/1'/0'/0",
    })
    const second = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0, 1],
      hdPath: "m/87'/1'/0'/0",
    })

    const firstAccounts = await first.getQbitAccounts()
    const secondAccounts = await second.getQbitAccounts()

    expect(firstAccounts).toEqual(secondAccounts)
    expect(firstAccounts[0]!.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(firstAccounts[0]!.path).toBe("m/87'/1'/0'/0/0")
    expect(firstAccounts[0]!.hkdf).toEqual({ account: 0, change: 0, index: 0 })
    expect(firstAccounts[0]!.signatureCounter).toEqual({
      count: 0,
      limit: PQC_MAX_SIGNATURES,
      remaining: PQC_MAX_SIGNATURES,
      state: 'normal',
      provenance: 'local',
      knownOnChainSignatures: 0,
    })
    expect(firstAccounts[0]!.scriptPubKey).toMatch(/^5220[0-9a-f]{64}$/)
    expect(firstAccounts[0]!.leafScript).toMatch(/^20[0-9a-f]{64}b3$/)
    expect(firstAccounts[0]!.addresses.mainnet).toMatch(/^qb1z/)
    expect(firstAccounts[0]!.addresses.testnet4).toMatch(/^tq1z/)
    expect(firstAccounts[0]!.addresses.signet).toMatch(/^tq1z/)
    expect(firstAccounts[0]!.addresses.regtest).toMatch(/^qbrt1z/)
    expect(firstAccounts[1]!.pubkey).not.toBe(firstAccounts[0]!.pubkey)
  })

  it('rederives and persists Qbit HD accounts across the Core coin-type split', async () => {
    const { service, keyring, storage } = await createUnlockedQbitService()
    const [testnetAccount] = await keyring.getQbitAccounts()
    await service.reservePqcSignatureCounter(testnetAccount!.addresses.testnet4)
    storage.values.set('cached_pubkeys', { stale: true })

    await expect(service.syncQbitHdPath("m/87'/0'/0'/0")).resolves.toBe(true)

    const [mainnetAccount] = await keyring.getQbitAccounts()
    expect(keyring.hdPath).toBe("m/87'/0'/0'/0")
    expect(mainnetAccount!.path).toBe("m/87'/0'/0'/0/0")
    expect(mainnetAccount!.pubkey).not.toBe(testnetAccount!.pubkey)
    expect(mainnetAccount!.addresses.mainnet).toMatch(/^qb1z/)
    expect(mainnetAccount!.addresses.testnet4).toMatch(/^tq1z/)
    expect(mainnetAccount!.signatureCounter.count).toBe(0)
    expect(storage.values.get('cached_pubkeys')).toBeNull()
    expect(vaultPayload(storage)[0].data.hdPath).toBe("m/87'/0'/0'/0")
    await expect(service.syncQbitHdPath("m/87'/0'/0'/0")).resolves.toBe(false)

    await service.syncQbitHdPath("m/87'/1'/0'/0")
    const [restoredTestnetAccount] = await keyring.getQbitAccounts()
    expect(restoredTestnetAccount!.pubkey).toBe(testnetAccount!.pubkey)
    expect(restoredTestnetAccount!.signatureCounter.count).toBe(1)
  })

  it('serializes HD-path persistence with PQC counter reservations', async () => {
    const storage = new MemoryStorage()
    const encryptor = new BlockingJsonEncryptor()
    const { service, keyring } = await createUnlockedQbitService(storage, encryptor)
    const encryptionGate = encryptor.blockNextEncryption()

    const syncHdPath = service.syncQbitHdPath("m/87'/0'/0'/0")
    await encryptionGate.started

    const [mainnetAccount] = await keyring.getQbitAccounts()
    let markCounterReserved!: () => void
    const counterReserved = new Promise<void>(resolve => {
      markCounterReserved = resolve
    })
    const reserveCounter = keyring.reservePqcSignatureCounter.bind(keyring)
    vi.spyOn(keyring, 'reservePqcSignatureCounter').mockImplementation(
      async (pubkeyOrAddress, count) => {
        const reservation = await reserveCounter(pubkeyOrAddress, count)
        markCounterReserved()
        return reservation
      }
    )

    const reservationPromise = service.reservePqcSignatureCounter(mainnetAccount!.addresses.mainnet)
    await counterReserved
    await flushMicrotasks()
    const encryptionsBeforeMigrationFinished = encryptor.trackedEncryptions

    encryptionGate.release()
    await expect(syncHdPath).resolves.toBe(true)
    const reservation = await reservationPromise

    expect(encryptionsBeforeMigrationFinished).toBe(1)
    expect(reservation).toMatchObject({
      pubkey: mainnetAccount!.pubkey,
      previousCounter: 0,
      newCounter: 1,
    })
    expect(vaultPayload(storage)[0].data.hdPath).toBe("m/87'/0'/0'/0")
    expect(vaultPayload(storage)[0].data.pqcSignatureCounters[mainnetAccount!.pubkey]).toBe(1)

    await service.setLocked()
    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor,
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('password')

    expect(await restored.getPqcSignatureCounter(mainnetAccount!.addresses.mainnet)).toBe(1)
  })

  it('serializes subscriber vault writes with explicit persistence', async () => {
    const storage = new BlockingMemoryStorage()
    const { service, keyring, encryptor } = await createUnlockedQbitService(storage)
    const subscriberWriteGate = storage.blockNextSet('keyringState')

    const syncHdPath = service.syncQbitHdPath("m/87'/0'/0'/0")
    await subscriberWriteGate.started

    const [mainnetAccount] = await keyring.getQbitAccounts()
    let markCounterReserved!: () => void
    const counterReserved = new Promise<void>(resolve => {
      markCounterReserved = resolve
    })
    const reserveCounter = keyring.reservePqcSignatureCounter.bind(keyring)
    vi.spyOn(keyring, 'reservePqcSignatureCounter').mockImplementation(
      async (pubkeyOrAddress, count) => {
        const reservation = await reserveCounter(pubkeyOrAddress, count)
        markCounterReserved()
        return reservation
      }
    )

    const reservationPromise = service.reservePqcSignatureCounter(mainnetAccount!.addresses.mainnet)
    await counterReserved
    await flushMicrotasks()
    const completedWritesBeforeSubscriber = storage.trackedCompletedWrites

    subscriberWriteGate.release()
    await expect(syncHdPath).resolves.toBe(true)
    await expect(reservationPromise).resolves.toMatchObject({
      pubkey: mainnetAccount!.pubkey,
      previousCounter: 0,
      newCounter: 1,
    })

    expect(completedWritesBeforeSubscriber).toBe(0)
    expect(vaultPayload(storage)[0].data.pqcSignatureCounters[mainnetAccount!.pubkey]).toBe(1)

    await service.setLocked()
    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor,
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('password')

    expect(await restored.getPqcSignatureCounter(mainnetAccount!.addresses.mainnet)).toBe(1)
  })

  it.each([
    ['public-key cache', 'cached_pubkeys'],
    ['vault', 'keyringState'],
  ])('restores the previous HD path when %s persistence fails', async (_, failingKey) => {
    const { service, keyring, storage } = await createUnlockedQbitService()
    const [testnetAccount] = await keyring.getQbitAccounts()
    const previousVault = service.store.getState().vault
    const previousPersistedKeyring = structuredClone(vaultPayload(storage)[0])
    storage.values.set('cached_pubkeys', { stale: true })
    storage.failSetKeys.add(failingKey)

    await expect(service.syncQbitHdPath("m/87'/0'/0'/0")).rejects.toThrow(
      `forced storage failure for ${failingKey}`
    )

    const [restoredAccount] = await keyring.getQbitAccounts()
    const displayedAccount = service.memStore.getState().keyrings[0]?.accounts[0]
    expect(keyring.hdPath).toBe("m/87'/1'/0'/0")
    expect(restoredAccount!.pubkey).toBe(testnetAccount!.pubkey)
    expect(displayedAccount?.pubkey).toBe(testnetAccount!.pubkey)
    expect(vaultPayload(storage)[0]).toEqual(previousPersistedKeyring)
    expect(service.store.getState().vault).toBe(previousVault)
  })

  it('serializes HD-path rollback with password changes', async () => {
    const storage = new MemoryStorage()
    const encryptor = new BlockingJsonEncryptor()
    const { service, keyring } = await createUnlockedQbitService(storage, encryptor)
    const [testnetAccount] = await keyring.getQbitAccounts()

    const encryptionGate = encryptor.blockNextEncryption()
    const pendingPasswordChange = service.changePassword('password', 'new-password')
    await encryptionGate.started

    // Let the password change commit once, then fail every later vault write so
    // the HD-path sync's rollback persistence is defeated as well.
    let passwordCommitSeen = false
    storage.failKeyringStateWriteWhen = state => {
      if (passwordCommitSeen) return true
      passwordCommitSeen = JSON.parse(state.booted).password === 'new-password'
      return false
    }
    const changeHdPathSpy = vi.spyOn(keyring, 'changeHdPath')
    const pendingSync = service.syncQbitHdPath("m/87'/0'/0'/0")
    await flushMicrotasks()
    const mutatedBeforePasswordCommit = changeHdPathSpy.mock.calls.length > 0

    encryptionGate.release()
    await pendingPasswordChange
    await expect(pendingSync).rejects.toThrow('forced storage failure for keyringState')
    await flushMicrotasks()

    expect(mutatedBeforePasswordCommit).toBe(false)
    expect(keyring.hdPath).toBe("m/87'/1'/0'/0")
    const liveState = service.store.getState()
    const durableState = storage.values.get('keyringState')
    expect(JSON.parse(liveState.booted).password).toBe('new-password')
    expect(JSON.parse(liveState.vault).password).toBe('new-password')
    expect(liveState).toEqual(durableState)

    storage.failKeyringStateWriteWhen = undefined
    await service.setLocked()
    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor,
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('new-password')
    const restoredKeyring = restored.keyrings[0] as QbitHdKeyring
    const [restoredAccount] = await restoredKeyring.getQbitAccounts()
    expect(restoredKeyring.hdPath).toBe("m/87'/1'/0'/0")
    expect(restoredAccount!.pubkey).toBe(testnetAccount!.pubkey)
  })

  it('uses BIP32 path change but keeps canonical qbit Core HKDF change at zero', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [7],
      hdPath: "m/87'/1'/0'/1",
    })

    const [account] = await keyring.getQbitAccounts()

    expect(account!.path).toBe("m/87'/1'/0'/1/7")
    expect(account!.hkdf).toEqual({ account: 0, change: 0, index: 7 })
  })

  it('reserves and persists per-account PQC signature counters', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0],
      hdPath: "m/87'/1'/0'/0",
    })
    const [account] = await keyring.getQbitAccounts()

    const firstReservation = await keyring.reservePqcSignatureCounter(account!.pubkey)
    const secondReservation = await keyring.reservePqcSignatureCounter(
      account!.addresses.regtest,
      2
    )

    expect(firstReservation).toMatchObject({
      pubkey: account!.pubkey,
      previousCounter: 0,
      newCounter: 1,
      signatureLimit: PQC_MAX_SIGNATURES,
      signaturesRemaining: PQC_MAX_SIGNATURES - 1,
      limitState: 'normal',
    })
    expect(secondReservation).toMatchObject({
      pubkey: account!.pubkey,
      previousCounter: 1,
      newCounter: 3,
    })
    expect(await keyring.getPqcSignatureCounter(account!.pubkey)).toBe(3)
    expect((await keyring.getQbitAccounts())[0]!.signatureCounter.count).toBe(3)

    const restored = new QbitHdKeyring(await keyring.serialize())
    expect(await restored.getPqcSignatureCounter(account!.pubkey)).toBe(3)
    await expect(
      new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/1'/0'/0",
        pqcSignatureCounters: { [account!.pubkey]: PQC_MAX_SIGNATURES },
      }).reservePqcSignatureCounter(account!.pubkey)
    ).rejects.toThrow(QbitPqcSignatureCounterError)
  })

  it('applies restored counter floors without lowering local counters', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0],
      hdPath: "m/87'/1'/0'/0",
    })
    const [account] = await keyring.getQbitAccounts()

    const floor = await keyring.applyPqcSignatureCounterFloor(account!.pubkey, 4)
    expect(floor).toMatchObject({
      previousCounter: 0,
      observedCounter: 4,
      newCounter: 4,
      counterProvenance: 'restored-floor',
    })
    expect((await keyring.getQbitAccounts())[0]!.signatureCounter).toMatchObject({
      count: 4,
      provenance: 'restored-floor',
    })

    const unchanged = await keyring.applyPqcSignatureCounterFloor(account!.pubkey, 2)
    expect(unchanged).toMatchObject({
      previousCounter: 4,
      observedCounter: 2,
      newCounter: 4,
      counterProvenance: 'restored-floor',
    })
  })

  it('exports receive and change P2MR descriptors accepted by Qbit Core', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0],
      hdPath: "m/87'/1'/0'/0",
    })

    const mainnet = await keyring.exportP2mrDescriptors('mainnet')
    const testnet = await keyring.exportP2mrDescriptors('testnet4')
    const regtest = await keyring.exportP2mrDescriptors('regtest')

    expect(mainnet).toMatchObject({
      network: 'mainnet',
      coinType: 0,
      containsPrivateKeys: true,
      hkdf: { account: 0, change: 0 },
      coreProvenance: {
        repository: 'Qbit-Org/qbit',
        commit: '70fea84f5becfb57463247af09790df5ddd424f8',
        source: 'src/wallet/walletutil.cpp',
      },
    })
    expect(mainnet.external).toMatchObject({
      branch: 'external',
      change: 0,
      path: 'm/87h/0h/0h/0/*',
    })
    expect(mainnet.internal).toMatchObject({
      branch: 'internal',
      change: 1,
      path: 'm/87h/0h/0h/1/*',
    })
    expect(mainnet.external.descriptorNoChecksum).toMatch(
      /^mr\(pk\(pqc\(qprv[1-9A-HJ-NP-Za-km-z]+\/87h\/0h\/0h\/0\/\*\)\)\)$/
    )
    expect(mainnet.internal.descriptorNoChecksum).toMatch(
      /^mr\(pk\(pqc\(qprv[1-9A-HJ-NP-Za-km-z]+\/87h\/0h\/0h\/1\/\*\)\)\)$/
    )
    expect(mainnet.external.descriptor).toBe(
      `${mainnet.external.descriptorNoChecksum}#${descriptorChecksum(mainnet.external.descriptorNoChecksum)}`
    )
    expect(mainnet.internal.descriptor).toBe(
      `${mainnet.internal.descriptorNoChecksum}#${descriptorChecksum(mainnet.internal.descriptorNoChecksum)}`
    )

    expect(testnet.coinType).toBe(1)
    expect(testnet.external.path).toBe('m/87h/1h/0h/0/*')
    expect(testnet.internal.path).toBe('m/87h/1h/0h/1/*')
    expect(testnet.external.descriptorNoChecksum).toMatch(
      /^mr\(pk\(pqc\(tqpv[1-9A-HJ-NP-Za-km-z]+\/87h\/1h\/0h\/0\/\*\)\)\)$/
    )

    expect(regtest.coinType).toBe(1)
    expect(regtest.external.path).toBe('m/87h/1h/0h/0/*')
    expect(regtest.external.descriptorNoChecksum).toMatch(
      /^mr\(pk\(pqc\(qrpv[1-9A-HJ-NP-Za-km-z]+\/87h\/1h\/0h\/0\/\*\)\)\)$/
    )

    const [account] = await keyring.getQbitAccounts()
    expect(account!.hkdf).toEqual({ account: 0, change: 0, index: 0 })
  })

  it('exports the deterministic 64-byte PQC secret key for an active account', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0],
      hdPath: "m/87'/1'/0'/0",
    })
    const [account] = await keyring.getQbitAccounts()
    const secretKeyHex = await keyring.exportAccount(account!.pubkey)

    expect(secretKeyHex).toMatch(/^[0-9a-f]{128}$/)
    expect(secretKeyHex.endsWith(account!.pubkey)).toBe(true)
  })

  it('restores P2MR keyrings through the encrypted vault lifecycle', async () => {
    const storage = new MemoryStorage()
    const encryptor = new JsonEncryptor()
    const service = new KeyringService()
    await service.init({
      storage,
      encryptor,
      logger: testLogger(),
      t: (key: string) => key,
    })

    await service.boot('password')
    const keyring = await service.createKeyringWithMnemonics(
      sampleMnemonic,
      "m/87'/1'/0'/0",
      '',
      AddressType.P2MR,
      2
    )
    const accountsBeforeLock = await keyring.getAccounts()
    const reservations = await Promise.all(
      [0, 1, 2].map(() => service.reservePqcSignatureCounter(accountsBeforeLock[0]!))
    )

    expect(reservations.map(reservation => reservation.newCounter).sort((a, b) => a - b)).toEqual([
      1, 2, 3,
    ])
    expect(await service.getPqcSignatureCounter(accountsBeforeLock[0]!)).toBe(3)

    await service.setLocked()

    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor,
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('password')

    expect(await restored.getAccounts()).toEqual(accountsBeforeLock)
    expect(await restored.getPqcSignatureCounter(accountsBeforeLock[0]!)).toBe(3)
    await expect(
      restored.reservePqcSignatureCounter(accountsBeforeLock[0]!)
    ).resolves.toMatchObject({
      previousCounter: 3,
      newCounter: 4,
    })
    expect(restored.keyrings[0]!.type).toBe(QbitHdKeyring.type)
    expect(restored.addressTypes[0]).toBe(AddressType.P2MR)
  })

  it('persists a PQC counter before releasing a guarded signature and reuses cached repeats', async () => {
    const { service, storage } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    let signerCalls = 0
    let persistedCounterBeforeSigner = 0
    const signature = dummyPqcSignature(0x11)

    const first = await service.signPqcDigestWithCounter(pubkey!, DIGEST_A, async context => {
      signerCalls += 1
      const payload = vaultPayload(storage)
      persistedCounterBeforeSigner = payload[0].data.pqcSignatureCounters[context.pubkey]
      expect(hex(context.digest)).toBe(DIGEST_A)
      return signature
    })

    expect(first.cached).toBe(false)
    expect(first.signature).toEqual(signature)
    expect(first.counter).toMatchObject({ previousCounter: 0, newCounter: 1 })
    expect(persistedCounterBeforeSigner).toBe(1)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)

    const second = await service.signPqcDigestWithCounter(pubkey!, DIGEST_A, async () => {
      signerCalls += 1
      return dummyPqcSignature(0x99)
    })

    expect(second.cached).toBe(true)
    expect(second.signature).toEqual(signature)
    expect(second.counter).toBeNull()
    expect(signerCalls).toBe(1)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)

    await service.setLocked()
    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor: new JsonEncryptor(),
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('password')

    const fromRestoredCache = await restored.signPqcDigestWithCounter(
      pubkey!,
      DIGEST_A,
      async () => {
        throw new Error('cached signature should avoid signer callback')
      }
    )
    expect(fromRestoredCache.cached).toBe(true)
    expect(fromRestoredCache.signature).toEqual(signature)
    expect(await restored.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('preflights capacity for distinct uncached P2MR message digests without advancing counters', async () => {
    const { service } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    await service.signPqcDigestWithCounter(pubkey!, DIGEST_A, async () => dummyPqcSignature(0x12))
    await service.applyPqcSignatureCounterFloor(pubkey!, PQC_MAX_SIGNATURES - 1, 'local')

    await expect(
      service.preflightP2mrMessageSigning(pubkey!, [DIGEST_A, DIGEST_A, DIGEST_B, DIGEST_B])
    ).resolves.toEqual({
      required: 1,
      cached: 3,
      remainingBefore: 1,
      remainingAfter: 0,
      limit: PQC_MAX_SIGNATURES,
    })
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(PQC_MAX_SIGNATURES - 1)

    await expect(
      service.preflightP2mrMessageSigning(pubkey!, [DIGEST_A, DIGEST_B, DIGEST_C, DIGEST_C])
    ).rejects.toMatchObject({
      name: 'QbitPqcSignatureCounterError',
      requested: 2,
    })
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(PQC_MAX_SIGNATURES - 1)
  })

  it('preflights cache eviction across the full ordered P2MR message batch', async () => {
    const firstDigest = '01'.repeat(32)
    const interveningDigests = Array.from({ length: 16 }, (_, index) =>
      (index + 2).toString(16).padStart(2, '0').repeat(32)
    )
    const orderedDigests = [firstDigest, ...interveningDigests, firstDigest]
    const globallyDistinctCount = new Set(orderedDigests).size

    const insufficient = await createUnlockedQbitService()
    const [insufficientPubkey] = await insufficient.service.getAccounts()
    await insufficient.service.applyPqcSignatureCounterFloor(
      insufficientPubkey!,
      PQC_MAX_SIGNATURES - globallyDistinctCount,
      'local'
    )
    const persistState = vi.spyOn(insufficient.storage, 'set')
    persistState.mockClear()
    let insufficientSignerCalls = 0

    const signInsufficientBatch = async () => {
      await insufficient.service.preflightP2mrMessageSigning(insufficientPubkey!, orderedDigests)
      for (const digest of orderedDigests) {
        await insufficient.service.signPqcDigestWithCounter(
          insufficientPubkey!,
          digest,
          async () => {
            insufficientSignerCalls += 1
            return dummyPqcSignature(0x21)
          }
        )
      }
    }

    await expect(signInsufficientBatch()).rejects.toMatchObject({
      name: 'QbitPqcSignatureCounterError',
      requested: globallyDistinctCount + 1,
    })
    expect(insufficientSignerCalls).toBe(0)
    expect(await insufficient.service.getPqcSignatureCounter(insufficientPubkey!)).toBe(
      PQC_MAX_SIGNATURES - globallyDistinctCount
    )
    expect(persistState).not.toHaveBeenCalled()

    const sufficient = await createUnlockedQbitService()
    const [sufficientPubkey] = await sufficient.service.getAccounts()
    const requiredSignatures = globallyDistinctCount + 1
    await sufficient.service.applyPqcSignatureCounterFloor(
      sufficientPubkey!,
      PQC_MAX_SIGNATURES - requiredSignatures,
      'local'
    )
    await expect(
      sufficient.service.preflightP2mrMessageSigning(sufficientPubkey!, orderedDigests)
    ).resolves.toEqual({
      required: requiredSignatures,
      cached: 0,
      remainingBefore: requiredSignatures,
      remainingAfter: 0,
      limit: PQC_MAX_SIGNATURES,
    })

    const results = []
    for (const digest of orderedDigests) {
      results.push(
        await sufficient.service.signPqcDigestWithCounter(sufficientPubkey!, digest, async () =>
          dummyPqcSignature(0x22)
        )
      )
    }

    expect(results.every(result => result.cached === false)).toBe(true)
    expect(await sufficient.service.getPqcSignatureCounter(sufficientPubkey!)).toBe(
      PQC_MAX_SIGNATURES
    )
  })

  it('restores signature-cache keys in newest-first eviction order', async () => {
    const { keyring } = await createUnlockedQbitService()
    const qbitKeyring = keyring as QbitHdKeyring
    const [pubkey] = await qbitKeyring.getAccounts()
    const cacheKeys = Array.from({ length: 16 }, (_, index) =>
      (index + 1).toString(16).padStart(2, '0').repeat(32)
    )
    qbitKeyring.pqcSignatureCache[pubkey!] = Object.fromEntries(
      cacheKeys.map((cacheKey, index) => [
        cacheKey,
        { signatureHex: '00', counter: index + 1, createdAt: index + 1 },
      ])
    )

    const restored = new QbitHdKeyring()
    await restored.deserialize(await qbitKeyring.serialize())
    const newestCacheKey = cacheKeys[cacheKeys.length - 1]!
    const oldestCacheKey = cacheKeys[0]!
    const incomingCacheKey = 'ff'.repeat(32)

    expect(Object.keys(restored.pqcSignatureCache[pubkey!])).toEqual([...cacheKeys].reverse())
    await expect(
      restored.estimatePqcSignatureCacheMisses(pubkey!, [incomingCacheKey, newestCacheKey])
    ).resolves.toBe(1)
    await expect(
      restored.estimatePqcSignatureCacheMisses(pubkey!, [incomingCacheKey, oldestCacheKey])
    ).resolves.toBe(2)
  })

  it('signs and verifies P2MR message proofs while caching repeats and counting new messages', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const qbitKeyring = keyring as QbitHdKeyring
    const [account] = await qbitKeyring.getQbitAccounts()
    const originalSignPqcDigest = qbitKeyring.signPqcDigest.bind(qbitKeyring)
    const signedDigests: string[] = []
    qbitKeyring.signPqcDigest = async (address, digest) => {
      signedDigests.push(protocolBytesToHex(digest))
      return originalSignPqcDigest(address, digest)
    }

    const message = 'counter-safe P2MR message'
    const expectedAccount = { expectedAddress: account!.addresses.regtest }
    const datasigHash = qbitDataSigPqcHash(qbitWalletMessageHash(message))
    const first = await service.signP2mrMessageWithCounter(account!.addresses.regtest, datasigHash)
    const proof = createP2mrMessageProof({
      message,
      address: account!.addresses.regtest,
      pubkey: protocolHexToBytes(account!.pubkey),
      signature: first.signature,
      leafScript: protocolHexToBytes(account!.leafScript),
    })

    expect(first).toMatchObject({
      pubkey: account!.pubkey,
      cached: false,
      counter: expect.objectContaining({ previousCounter: 0, newCounter: 1 }),
    })
    expect(signedDigests).toEqual([protocolBytesToHex(datasigHash)])
    expect(verifyP2mrMessageProof(message, proof, verifyPqc, expectedAccount)).toBe(true)

    const repeated = await service.signP2mrMessageWithCounter(
      account!.addresses.regtest,
      datasigHash
    )
    expect(repeated).toMatchObject({ cached: true, counter: null })
    expect(repeated.signature).toEqual(first.signature)
    expect(signedDigests).toHaveLength(1)
    expect(await service.getPqcSignatureCounter(account!.pubkey)).toBe(1)

    const differentMessage = 'a different P2MR message'
    const differentDatasigHash = qbitDataSigPqcHash(qbitWalletMessageHash(differentMessage))
    const different = await service.signP2mrMessageWithCounter(
      account!.addresses.regtest,
      differentDatasigHash
    )
    const differentProof = createP2mrMessageProof({
      message: differentMessage,
      address: account!.addresses.regtest,
      pubkey: protocolHexToBytes(account!.pubkey),
      signature: different.signature,
      leafScript: protocolHexToBytes(account!.leafScript),
    })
    expect(different).toMatchObject({
      cached: false,
      counter: expect.objectContaining({ previousCounter: 1, newCounter: 2 }),
    })
    expect(signedDigests).toEqual([
      protocolBytesToHex(datasigHash),
      protocolBytesToHex(differentDatasigHash),
    ])
    expect(verifyP2mrMessageProof(differentMessage, differentProof, verifyPqc, expectedAccount)).toBe(true)
    expect(await service.getPqcSignatureCounter(account!.pubkey)).toBe(2)

    const otherPubkey = protocolHexToBytes('44'.repeat(32))
    const tamperedSignaturePrefix = proof.signature.startsWith('00') ? '01' : '00'
    const tamperedProofs = [
      { message: `${message}!`, proof },
      {
        message,
        proof: { ...proof, address: p2mrAddressFromPubkey(otherPubkey, 'regtest') },
      },
      { message, proof: { ...proof, pubkey: protocolBytesToHex(otherPubkey) } },
      {
        message,
        proof: { ...proof, signature: `${tamperedSignaturePrefix}${proof.signature.slice(2)}` },
      },
      {
        message,
        proof: { ...proof, leaf_script: `20${protocolBytesToHex(otherPubkey)}b3` },
      },
      { message, proof: { ...proof, control_block: 'c3' } },
    ]
    tamperedProofs.forEach(tampered => {
      expect(verifyP2mrMessageProof(tampered.message, tampered.proof, verifyPqc, expectedAccount)).toBe(false)
    })
  })

  it('rejects a stale P2MR message signature budget before signing or advancing its counter', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const approvedBudget = await service.preflightP2mrMessageSigning(pubkey!, [DIGEST_A])

    await service.signPqcDigestWithCounter(pubkey!, DIGEST_B, async () => dummyPqcSignature(0x31))
    const signer = vi.spyOn(keyring as QbitHdKeyring, 'signPqcDigest')

    await expect(
      service.signP2mrMessageWithCounter(pubkey!, DIGEST_A, approvedBudget)
    ).rejects.toThrow('P2MR signature budget changed after approval')

    expect(signer).not.toHaveBeenCalled()
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('resolves one stable keyring target for each countered P2MR operation', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [account] = await (keyring as QbitHdKeyring).getQbitAccounts()
    const resolveTarget = vi.spyOn(service as any, 'getPqcSignatureCounterTarget')

    await service.signP2mrMessageWithCounter(account!.addresses.regtest, DIGEST_A)
    expect(resolveTarget).toHaveBeenCalledTimes(1)

    resolveTarget.mockClear()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)
    await service.signP2mrPsbtWithCounter(account!.addresses.regtest, {
      psbt: fixture.psbt,
      keys: fixture.keys,
    })
    expect(resolveTarget).toHaveBeenCalledTimes(1)
  })

  it('does not burn a PQC counter when the pre-sign counter persist fails', async () => {
    const { service, storage } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    let signerCalls = 0
    storage.failSetKeys.add('keyringState')

    await expect(
      service.signPqcDigestWithCounter(pubkey!, DIGEST_B, async () => {
        signerCalls += 1
        return dummyPqcSignature(0x22)
      })
    ).rejects.toThrow('forced storage failure')

    expect(signerCalls).toBe(0)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(0)

    storage.failSetKeys.clear()
    await expect(
      service.signPqcDigestWithCounter(pubkey!, DIGEST_B, async () => {
        signerCalls += 1
        return dummyPqcSignature(0x23)
      })
    ).resolves.toMatchObject({
      cached: false,
      counter: expect.objectContaining({ previousCounter: 0, newCounter: 1 }),
    })
    expect(signerCalls).toBe(1)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('serializes concurrent PQC signing by key and only burns once for identical input', async () => {
    const { service } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    let signerCalls = 0

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        service.signPqcDigestWithCounter(pubkey!, DIGEST_C, async () => {
          signerCalls += 1
          await new Promise(resolve => setTimeout(resolve, 5))
          return dummyPqcSignature(0x55)
        })
      )
    )

    expect(results.filter(result => !result.cached)).toHaveLength(1)
    expect(results.filter(result => result.cached)).toHaveLength(2)
    expect(results.map(result => result.signature[0])).toEqual([0x55, 0x55, 0x55])
    expect(signerCalls).toBe(1)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('rejects ambiguous signing input strings and malformed PQC signatures', async () => {
    const { service } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()

    await expect(
      service.signPqcDigestWithCounter(pubkey!, 'deadbeef', async () => dummyPqcSignature(0x44))
    ).rejects.toThrow('32-byte digest')
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(0)

    await expect(
      service.signPqcDigestWithCounter(pubkey!, DIGEST_A, async () => Uint8Array.from([1, 2, 3]))
    ).rejects.toThrow(`expected ${PQC_SIGNATURE_BYTES}`)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('signs every P2MR PSBT input through the PQC counter exactly once', async () => {
    const { service, keyring, storage } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring, { inputCount: 3 })

    const signed = await service.signP2mrPsbtWithCounter(pubkey!, {
      psbt: fixture.psbt,
      keys: fixture.keys,
    })

    expect(signed.signed).toHaveLength(3)
    expect(signed.counterResults.map(result => result.cached)).toEqual([false, false, false])
    expect(signed.counterResults.map(result => result.counter?.previousCounter)).toEqual([0, 1, 2])
    expect(signed.counterResults.map(result => result.counter?.newCounter)).toEqual([1, 2, 3])
    expect(decodePsbt(signed.psbt).inputs.map(input => input.scriptSigs.length)).toEqual([1, 1, 1])
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(3)
    expect(vaultPayload(storage)[0].data.pqcSignatureCounters[pubkey!]).toBe(3)
  })

  it('preflights exact P2MR PSBT impact and rejects a stale approved budget', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring, { inputCount: 3 })
    const approvedBudget = await service.preflightP2mrPsbtSigning(pubkey!, {
      psbt: fixture.psbt,
      keys: fixture.keys,
    })

    expect(approvedBudget).toEqual({
      required: 3,
      cached: 0,
      remainingBefore: PQC_MAX_SIGNATURES,
      remainingAfter: PQC_MAX_SIGNATURES - 3,
      limit: PQC_MAX_SIGNATURES,
    })

    await service.signPqcDigestWithCounter(pubkey!, DIGEST_A, async () => dummyPqcSignature(0x32))
    const signer = vi.spyOn(keyring as QbitHdKeyring, 'signPqcDigest')

    await expect(
      service.signP2mrPsbtWithCounter(
        pubkey!,
        { psbt: fixture.psbt, keys: fixture.keys },
        approvedBudget
      )
    ).rejects.toThrow('P2MR signature budget changed after approval')

    expect(signer).not.toHaveBeenCalled()
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('refuses a P2MR PSBT over the standard transaction size before reserving any counter', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const qbitKeyring = keyring as QbitHdKeyring
    const signer = vi.spyOn(qbitKeyring, 'signPqcDigest')
    // 107 single-key inputs sign to 402,589 bytes, over qbit Core's 400,000 WU limit.
    const oversized = await buildP2mrSpendFixture(qbitKeyring, { inputCount: 107 })
    const oversizedInput = { psbt: oversized.psbt, keys: oversized.keys }

    await expect(service.preflightP2mrPsbtSigning(pubkey!, oversizedInput)).rejects.toThrow(
      'standard size of 400000 vB'
    )
    await expect(service.signP2mrPsbtWithCounter(pubkey!, oversizedInput)).rejects.toThrow(
      'standard size of 400000 vB'
    )
    expect(signer).not.toHaveBeenCalled()
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(0)

    // 106 inputs fit (398,827 bytes) and preflight as usual.
    const largest = await buildP2mrSpendFixture(qbitKeyring, { inputCount: 106, txidSeed: 200 })
    await expect(
      service.preflightP2mrPsbtSigning(pubkey!, { psbt: largest.psbt, keys: largest.keys })
    ).resolves.toMatchObject({ required: 106, cached: 0 })
  })

  it('rejects replaying a signed P2MR PSBT approval while a fresh preflight signs from cache', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)
    const input = () => ({ psbt: fixture.psbt, keys: fixture.keys })
    const approvedBudget = await service.preflightP2mrPsbtSigning(pubkey!, input())

    const signed = await service.signP2mrPsbtWithCounter(pubkey!, input(), approvedBudget)
    expect(signed.counterResults.map(result => result.cached)).toEqual([false])
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)

    // A failed broadcast leaves the signature cached and the counter spent.
    // Re-submitting the consumed approval must not quietly resolve; only a
    // fresh preflight that discloses the cached impact may reproduce the
    // signature, without consuming another counter.
    await expect(
      service.signP2mrPsbtWithCounter(pubkey!, input(), approvedBudget)
    ).rejects.toThrow('P2MR signature budget changed after approval')
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)

    const cachedBudget = await service.preflightP2mrPsbtSigning(pubkey!, input())
    expect(cachedBudget).toMatchObject({ required: 0, cached: 1 })
    const resigned = await service.signP2mrPsbtWithCounter(pubkey!, input(), cachedBudget)
    expect(resigned.counterResults.map(result => result.cached)).toEqual([true])
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('completes duplicated batch entries signed in reverse preparation order', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)
    const input = () => ({ psbt: fixture.psbt, keys: fixture.keys })
    // A signPsbts batch duplicating one PSBT preflights both entries before
    // any signing, so both approvals disclose the same fresh impact and both
    // carry the duplicate mark.
    const firstBudget = await service.preflightP2mrPsbtSigning(pubkey!, input())
    const secondBudget = await service.preflightP2mrPsbtSigning(pubkey!, input())

    const signedSecond = await service.signP2mrPsbtWithCounter(pubkey!, input(), secondBudget, true)
    expect(signedSecond.counterResults.map(result => result.cached)).toEqual([false])

    // The first-prepared entry signs after its duplicate cached the approved
    // signature; the disclosed shift completes without another counter.
    const signedFirst = await service.signP2mrPsbtWithCounter(pubkey!, input(), firstBudget, true)
    expect(signedFirst.counterResults.map(result => result.cached)).toEqual([true])
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('preflights every P2MR plan before signing a valid earlier input', async () => {
    const { service, keyring, storage } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring, { inputCount: 2 })
    const qbitKeyring = keyring as QbitHdKeyring
    const counteredSigner = vi.spyOn(service, 'signPqcDigestWithCounter')
    const signer = vi.spyOn(qbitKeyring, 'signPqcDigest')
    const serializedBefore = structuredClone(await qbitKeyring.serialize())
    const vaultBefore = storage.values.get('keyringState').vault
    const psbtBefore = serializePsbt(fixture.psbt)
    fixture.keys[1] = { ...fixture.keys[1]!, inputIndex: 99 }

    await expect(
      service.signP2mrPsbtWithCounter(pubkey!, { psbt: fixture.psbt, keys: fixture.keys })
    ).rejects.toThrow(/inputIndex/)

    expect(counteredSigner).not.toHaveBeenCalled()
    expect(signer).not.toHaveBeenCalled()
    expect(serializePsbt(fixture.psbt)).toEqual(psbtBefore)
    expect(await qbitKeyring.serialize()).toEqual(serializedBefore)
    expect(storage.values.get('keyringState').vault).toBe(vaultBefore)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(0)
  })

  it('signs immutable P2MR snapshots when caller inputs mutate during an await', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const qbitKeyring = keyring as QbitHdKeyring
    const fixture = await buildP2mrSpendFixture(qbitKeyring)
    const expectedPubkey = fixture.keys[0]!.pubkey.slice()
    const expectedLeafHash = fixture.keys[0]!.leafHash.slice()
    const signPqcDigest = qbitKeyring.signPqcDigest.bind(qbitKeyring)
    let markSignerStarted!: () => void
    let releaseSigner!: () => void
    const signerStarted = new Promise<void>(resolve => {
      markSignerStarted = resolve
    })
    const signerRelease = new Promise<void>(resolve => {
      releaseSigner = resolve
    })
    vi.spyOn(qbitKeyring, 'signPqcDigest').mockImplementation(async (address, digest) => {
      markSignerStarted()
      await signerRelease
      return signPqcDigest(address, digest)
    })

    const signing = service.signP2mrPsbtWithCounter(pubkey!, {
      psbt: fixture.psbt,
      keys: fixture.keys,
    })
    await signerStarted

    fixture.keys[0]!.inputIndex = 99
    fixture.keys[0]!.pubkey.fill(0)
    fixture.keys[0]!.leafHash.fill(0)
    fixture.keys.length = 0
    fixture.psbt.global[0]!.value.fill(0)
    fixture.psbt.inputs.length = 0
    fixture.psbt.outputs.length = 0
    releaseSigner()

    const result = await signing
    expect(result.signed).toEqual([
      { inputIndex: 0, pubkey: expectedPubkey, leafHash: expectedLeafHash },
    ])
    expect(result.counterResults[0]).toMatchObject({
      inputIndex: 0,
      pubkey: protocolBytesToHex(expectedPubkey),
      leafHash: protocolBytesToHex(expectedLeafHash),
      cached: false,
      counter: expect.objectContaining({ previousCounter: 0, newCounter: 1 }),
    })
    expect(decodePsbt(result.psbt).inputs[0]!.scriptSigs).toHaveLength(1)
  })

  it('preflights every P2MR key against the selected account before signing', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const accountPubkeys = await service.getAccounts()
    const fixture = await buildMixedAccountP2mrSpendFixture(keyring as QbitHdKeyring)
    const signer = vi.spyOn(keyring as QbitHdKeyring, 'signPqcDigest')

    await expect(
      service.signP2mrPsbtWithCounter(accountPubkeys[0]!, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })
    ).rejects.toThrow(/does not match the selected account/)

    expect(signer).not.toHaveBeenCalled()
    expect(await service.getPqcSignatureCounter(accountPubkeys[0]!)).toBe(0)
    expect(await service.getPqcSignatureCounter(accountPubkeys[1]!)).toBe(0)
  })

  it('rejects duplicate P2MR plans before signing or advancing a counter', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)
    const signer = vi.spyOn(keyring as QbitHdKeyring, 'signPqcDigest')

    await expect(
      service.signP2mrPsbtWithCounter(pubkey!, {
        psbt: fixture.psbt,
        keys: [fixture.keys[0]!, fixture.keys[0]!],
      })
    ).rejects.toThrow(/duplicate P2MR signing plan/)

    expect(signer).not.toHaveBeenCalled()
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(0)
  })

  it('rejects an already signed P2MR input before advancing a counter', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)
    const alreadySigned = signP2mrPsbt({
      psbt: fixture.psbt,
      keys: fixture.keys,
      sign: () => dummyPqcSignature(0x5a),
    }).psbt
    const signer = vi.spyOn(keyring as QbitHdKeyring, 'signPqcDigest')

    await expect(
      service.signP2mrPsbtWithCounter(pubkey!, { psbt: alreadySigned, keys: fixture.keys })
    ).rejects.toThrow(/already has a P2MR signature/)

    expect(signer).not.toHaveBeenCalled()
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(0)
  })

  it('reuses cached P2MR signatures for identical pubkey and sighash without advancing the counter', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)

    const first = await service.signP2mrPsbtWithCounter(pubkey!, {
      psbt: fixture.psbt,
      keys: fixture.keys,
    })
    const firstSignature = firstP2mrSignature(first.psbt)
    expect(first.counterResults[0]).toMatchObject({
      cached: false,
      counter: expect.objectContaining({ previousCounter: 0, newCounter: 1 }),
    })

    const second = await service.signP2mrPsbtWithCounter(pubkey!, {
      psbt: fixture.psbt,
      keys: fixture.keys,
    })

    expect(second.counterResults[0]).toMatchObject({ cached: true, counter: null })
    expect(protocolBytesToHex(firstP2mrSignature(second.psbt))).toBe(
      protocolBytesToHex(firstSignature)
    )
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('does not return a P2MR signature when the counter persist fails before signing', async () => {
    const { service, keyring, storage } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)
    const qbitKeyring = keyring as QbitHdKeyring
    const originalSignPqcDigest = qbitKeyring.signPqcDigest.bind(qbitKeyring)
    let signerCalls = 0
    qbitKeyring.signPqcDigest = async (address, digest) => {
      signerCalls += 1
      return originalSignPqcDigest(address, digest)
    }
    storage.failSetKeys.add('keyringState')

    let returnedSignature = false
    await expect(
      service
        .signP2mrPsbtWithCounter(pubkey!, { psbt: fixture.psbt, keys: fixture.keys })
        .then(result => {
          returnedSignature = decodePsbt(result.psbt).inputs[0]!.scriptSigs.length > 0
          return result
        })
    ).rejects.toThrow('forced storage failure')

    expect(returnedSignature).toBe(false)
    expect(signerCalls).toBe(0)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(0)
  })

  it('serializes concurrent P2MR countered signing for distinct sighashes without losing updates', async () => {
    const { service, keyring, storage } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixtures = await Promise.all(
      [0, 1, 2, 3].map(index =>
        buildP2mrSpendFixture(keyring as QbitHdKeyring, { txidSeed: 30 + index * 10 })
      )
    )

    const results = await Promise.all(
      fixtures.map(fixture =>
        service.signP2mrPsbtWithCounter(pubkey!, { psbt: fixture.psbt, keys: fixture.keys })
      )
    )

    expect(results).toHaveLength(4)
    expect(results.every(result => result.signed.length === 1)).toBe(true)
    expect(results.every(result => result.counterResults[0]!.cached === false)).toBe(true)
    expect(new Set(results.map(result => result.counterResults[0]!.cacheKey)).size).toBe(4)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(4)
    expect(vaultPayload(storage)[0].data.pqcSignatureCounters[pubkey!]).toBe(4)

    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor: new JsonEncryptor(),
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('password')
    expect(await restored.getPqcSignatureCounter(pubkey!)).toBe(4)
  })

  it('refuses P2MR signing when the PQC counter is exhausted and leaves the counter unchanged', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring)
    await service.applyPqcSignatureCounterFloor(pubkey!, PQC_MAX_SIGNATURES)
    const qbitKeyring = keyring as QbitHdKeyring
    const originalSignPqcDigest = qbitKeyring.signPqcDigest.bind(qbitKeyring)
    let signerCalls = 0
    qbitKeyring.signPqcDigest = async (address, digest) => {
      signerCalls += 1
      return originalSignPqcDigest(address, digest)
    }

    await expect(
      service.signP2mrPsbtWithCounter(pubkey!, { psbt: fixture.psbt, keys: fixture.keys })
    ).rejects.toThrow(QbitPqcSignatureCounterError)

    expect(signerCalls).toBe(0)
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(PQC_MAX_SIGNATURES)
  })

  it('produces the same P2MR signature bytes as raw @qbit-oss/pqc signing for the same account key and sighash', async () => {
    const { service, keyring } = await createUnlockedQbitService()
    const [pubkey] = await service.getAccounts()
    const fixture = await buildP2mrSpendFixture(keyring as QbitHdKeyring, {
      hashType: SIGHASH_DEFAULT,
    })
    const tx = psbtUnsignedTransaction(fixture.psbt)
    const sighash = p2mrSighash({
      tx,
      inputIndex: 0,
      spentOutputs: fixture.spentOutputs,
      leafHash: fixture.leafHash,
      hashType: SIGHASH_DEFAULT,
    })
    const secretKey = protocolHexToBytes(await (keyring as QbitHdKeyring).exportAccount(pubkey!))
    let expected: Uint8Array
    try {
      expected = rawPqcSign(secretKey, sighash)
    } finally {
      secretKey.fill(0)
    }

    const signed = await service.signP2mrPsbtWithCounter(pubkey!, {
      psbt: fixture.psbt,
      keys: fixture.keys,
    })

    expect(protocolBytesToHex(firstP2mrSignature(signed.psbt))).toBe(protocolBytesToHex(expected))
    expect(await service.getPqcSignatureCounter(pubkey!)).toBe(1)
  })

  it('reuses discovery derivations when arming a mnemonic restore and scanning its lookahead', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: Array.from({ length: 20 }, (_value, index) => index),
      hdPath: "m/87'/1'/0'/0",
    })
    const derivedBuffers: { pk32: Uint8Array; sk64: Uint8Array }[] = []
    const deriveSpy = vi
      .spyOn(keyring as any, '_derivePqcKey')
      .mockImplementation(async (index: number) => {
        const derived = {
          pk32: new Uint8Array(32).fill(index + 1),
          sk64: new Uint8Array(64).fill(0xa5),
        }
        derivedBuffers.push(derived)
        return derived
      })

    const discoveredAccounts = await keyring.getQbitAccounts()
    expect(discoveredAccounts).toHaveLength(20)
    expect(deriveSpy).toHaveBeenCalledTimes(20)
    expect(
      derivedBuffers.every(
        derived => derived.pk32.every(byte => byte === 0) && derived.sk64.every(byte => byte === 0)
      )
    ).toBe(true)

    keyring.prepareForMnemonicRestore([0, 1], true, 'regtest')
    expect(keyring.pqcFloorsPending).toBe(true)
    expect(keyring.getQbitRecoveryState()).toMatchObject({
      networks: {
        regtest: { addressDiscoveryComplete: true },
        testnet4: { addressDiscoveryComplete: false },
      },
    })
    await expect(
      keyring.assertPqcSignatureCounterAvailable(discoveredAccounts[0]!.pubkey)
    ).rejects.toMatchObject({ code: 'PQC_FLOORS_PENDING' })

    const observedIndexes: number[] = []
    await keyring.scanPqcSignatureCounterFloors(
      account => {
        observedIndexes.push(account.index)
        return { observedSignatures: 0 }
      },
      { lookahead: 20 }
    )

    expect(observedIndexes).toEqual(Array.from({ length: 22 }, (_value, index) => index))
    expect(deriveSpy.mock.calls.map(([index]) => index)).toEqual(
      Array.from({ length: 22 }, (_value, index) => index)
    )
    expect(
      (await keyring.getQbitAccounts()).map(account => account.signatureCounter.provenance)
    ).toEqual(['restored-floor', 'restored-floor'])
    expect(keyring.pqcFloorsPending).toBe(false)
  })

  it('persists the discovered keyring with its floor gate armed without re-deriving accounts', async () => {
    const storage = new MemoryStorage()
    const service = new KeyringService()
    await service.init({
      storage,
      encryptor: new JsonEncryptor(),
      logger: testLogger(),
      t: (key: string) => key,
    })
    await service.boot('password')

    const keyring = service.createTmpKeyring(QbitHdKeyring.type, {
      mnemonic: sampleMnemonic,
      activeIndexes: Array.from({ length: 20 }, (_value, index) => index),
      hdPath: "m/87'/1'/0'/0",
    }) as QbitHdKeyring
    const deriveSpy = vi
      .spyOn(keyring as any, '_derivePqcKey')
      .mockImplementation(async (index: number) => ({
        pk32: new Uint8Array(32).fill(index + 1),
        sk64: new Uint8Array(64).fill(0xa5),
      }))

    await keyring.getQbitAccounts()
    const added = await service.addDiscoveredQbitKeyring(keyring, 2, true, 'regtest')
    const serialized = await keyring.serialize()

    expect(added).toBe(keyring)
    expect(service.keyrings).toEqual([keyring])
    expect(deriveSpy).toHaveBeenCalledTimes(20)
    expect(serialized).toMatchObject({
      activeIndexes: [0, 1],
      pqcFloorsPending: true,
      pqcRestoredFromMnemonic: true,
      qbitRecoveryState: { networks: { regtest: { addressDiscoveryComplete: true } } },
    })
    expect(vaultPayload(storage)[0].data).toMatchObject({
      activeIndexes: [0, 1],
      pqcFloorsPending: true,
      pqcRestoredFromMnemonic: true,
      qbitRecoveryState: { networks: { regtest: { addressDiscoveryComplete: true } } },
    })
  })

  it('rejects an invalid discovered mnemonic before preparing or persisting the keyring', async () => {
    const storage = new MemoryStorage()
    const service = new KeyringService()
    await service.init({
      storage,
      encryptor: new JsonEncryptor(),
      logger: testLogger(),
      t: (key: string) => key,
    })
    await service.boot('password')

    const persistedState = structuredClone(storage.values.get('keyringState'))
    const keyring = service.createTmpKeyring(QbitHdKeyring.type, {
      mnemonic: 'not a valid mnemonic',
      activeIndexes: [0],
      hdPath: "m/87'/1'/0'/0",
    }) as QbitHdKeyring
    const prepareSpy = vi.spyOn(keyring, 'prepareForMnemonicRestore')

    await expect(service.addDiscoveredQbitKeyring(keyring, 1)).rejects.toThrow(
      'mnemonic_phrase_is_invalid'
    )

    expect(prepareSpy).not.toHaveBeenCalled()
    expect(service.keyrings).toEqual([])
    expect(storage.values.get('keyringState')).toEqual(persistedState)
  })

  it('raises PQC counters to the observed restore floor without lowering them', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0, 1],
      hdPath: "m/87'/1'/0'/0",
    })
    const accounts = await keyring.getQbitAccounts()
    // Pre-advance account 1 above the floor we will observe, to prove it is not lowered.
    await keyring.reservePqcSignatureCounter(accounts[1]!.pubkey, 9)

    const observed: Record<string, number> = {
      [accounts[0]!.pubkey]: 5,
      [accounts[1]!.pubkey]: 2,
    }
    const scan = await keyring.scanPqcSignatureCounterFloors(
      account => ({ observedSignatures: observed[account.pubkey] ?? 0 }),
      { lookahead: 0 }
    )

    expect(scan.floors).toHaveLength(2)
    expect(scan.possibleConcurrentInstance).toBe(false)
    expect(await keyring.getPqcSignatureCounter(accounts[0]!.pubkey)).toBe(5) // 0 -> 5
    expect(await keyring.getPqcSignatureCounter(accounts[1]!.pubkey)).toBe(9) // observed 2 < 9, kept

    const refreshed = await keyring.getQbitAccounts()
    expect(refreshed[0]!.signatureCounter).toMatchObject({
      count: 5,
      provenance: 'restored-floor',
      knownOnChainSignatures: 5,
    })
    expect(refreshed[1]!.signatureCounter).toMatchObject({
      count: 9,
      provenance: 'restored-floor',
      knownOnChainSignatures: 2,
    })
  })

  it('flags a possible concurrent instance when activity appears beyond known indexes', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: sampleMnemonic,
      activeIndexes: [0, 1],
      hdPath: "m/87'/1'/0'/0",
    })

    const clean = await keyring.scanPqcSignatureCounterFloors(() => ({ observedSignatures: 0 }), {
      lookahead: 5,
    })
    expect(clean.gapIndexesWithActivity).toEqual([])
    expect(clean.possibleConcurrentInstance).toBe(false)

    // Index 3 is beyond the active range [0, 1]; activity there is the hazard signal.
    const flagged = await keyring.scanPqcSignatureCounterFloors(
      account => ({ observedSignatures: 0, hasActivity: account.hkdf.index === 3 }),
      { lookahead: 5 }
    )
    expect(flagged.gapIndexesWithActivity).toContain(3)
    expect(flagged.possibleConcurrentInstance).toBe(true)
  })

  it('persists restored counter floors through the service wrapper', async () => {
    const { service, storage } = await createUnlockedQbitService()
    const [pubkey0] = await service.getAccounts()

    const scan = await service.restorePqcSignatureCounterFloors(
      pubkey0!,
      account => ({ observedSignatures: account.pubkey === pubkey0 ? 7 : 0 }),
      { lookahead: 0 }
    )
    expect(scan.floors.find(floor => floor.pubkey === pubkey0)).toMatchObject({
      newCounter: 7,
      counterProvenance: 'restored-floor',
    })
    expect(await service.getPqcSignatureCounter(pubkey0!)).toBe(7)
    expect(vaultPayload(storage)[0].data.pqcSignatureCounters[pubkey0!]).toBe(7)

    await service.setLocked()
    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor: new JsonEncryptor(),
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('password')
    expect(await restored.getPqcSignatureCounter(pubkey0!)).toBe(7)
  })

  it('serializes restore scans with PQC counter reservations', async () => {
    const { service } = await createUnlockedQbitService()
    const [pubkey0] = await service.getAccounts()
    let releaseObserve!: () => void
    let observeEntered!: () => void
    const observeEnteredPromise = new Promise<void>(resolve => {
      observeEntered = resolve
    })
    const releaseObservePromise = new Promise<void>(resolve => {
      releaseObserve = resolve
    })

    const restore = service.restorePqcSignatureCounterFloors(
      pubkey0!,
      async account => {
        if (account.pubkey === pubkey0) {
          observeEntered()
          await releaseObservePromise
          return { observedSignatures: 7 }
        }
        return { observedSignatures: 0 }
      },
      { lookahead: 0 }
    )
    await observeEnteredPromise

    let reservationSettled = false
    const reservation = service.reservePqcSignatureCounter(pubkey0!).then(result => {
      reservationSettled = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(reservationSettled).toBe(false)

    releaseObserve()
    await expect(restore).resolves.toMatchObject({
      floors: expect.arrayContaining([expect.objectContaining({ pubkey: pubkey0, newCounter: 7 })]),
    })
    await expect(reservation).resolves.toMatchObject({
      previousCounter: 7,
      newCounter: 8,
    })
    expect(await service.getPqcSignatureCounter(pubkey0!)).toBe(8)
  })

  it('persists restored floors observed before a scan failure', async () => {
    const { service, storage } = await createUnlockedQbitService()
    const [pubkey0, pubkey1] = await service.getAccounts()

    await expect(
      service.restorePqcSignatureCounterFloors(
        pubkey0!,
        account => {
          if (account.pubkey === pubkey0) {
            return { observedSignatures: 6 }
          }
          if (account.pubkey === pubkey1) {
            throw new Error('forced observe failure')
          }
          return { observedSignatures: 0 }
        },
        { lookahead: 0 }
      )
    ).rejects.toThrow('forced observe failure')

    expect(await service.getPqcSignatureCounter(pubkey0!)).toBe(6)
    expect(vaultPayload(storage)[0].data.pqcSignatureCounters[pubkey0!]).toBe(6)

    const restored = new KeyringService()
    await restored.init({
      storage,
      encryptor: new JsonEncryptor(),
      logger: testLogger(),
      t: (key: string) => key,
    })
    await restored.submitPassword('password')
    expect(await restored.getPqcSignatureCounter(pubkey0!)).toBe(6)
  })

  describe('seed-only restored wallet lifecycle', () => {
    it('defaults older restored vaults to an unacknowledged lower-bound risk state', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      const serialized = await keyring.serialize()
      delete serialized.qbitRecoveryState
      delete serialized.pqcSignatureCounterChainFloors

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)
      const state = reloaded.getQbitRecoveryState()
      const [account] = await reloaded.getQbitAccounts()

      expect(state).toEqual({
        version: 2,
        acknowledgement: 'required',
        networks: {
          mainnet: { status: 'seed-only-restored', addressDiscoveryComplete: false },
          testnet4: { status: 'seed-only-restored', addressDiscoveryComplete: false },
          regtest: { status: 'seed-only-restored', addressDiscoveryComplete: false },
        },
      })
      expect(account!.signatureCounter).toMatchObject({
        provenance: 'restored-floor',
        knownOnChainSignatures: 3,
      })
      expect(account!.pubkey).toBe(pubkey)
    })

    it('persists incomplete discovery and refuses to mark its migration archived', async () => {
      const { keyring } = await createRestoredQbitService(undefined, 3, 1, false)
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })

      expect(() => keyring.markQbitRecoveryMigrated('regtest')).toThrow(
        'recovery address discovery is incomplete'
      )
      expect(keyring.getQbitRecoveryState()).toMatchObject({
        networks: {
          regtest: {
            status: 'migrating',
            addressDiscoveryComplete: false,
            migration: { plans: [] },
          },
        },
      })
      await expect(keyring.serialize()).resolves.toMatchObject({
        qbitRecoveryState: { networks: { regtest: { addressDiscoveryComplete: false } } },
      })

      // A resumed scan that ends on a full trailing gap unblocks archiving.
      expect(keyring.completeQbitRecoveryAddressDiscovery('regtest')).toMatchObject({
        networks: { regtest: { addressDiscoveryComplete: true } },
      })
      expect(keyring.markQbitRecoveryMigrated('regtest')).toMatchObject({
        networks: {
          regtest: { status: 'migrated', addressDiscoveryComplete: true },
          // The sibling network's lifecycle is untouched by this archive.
          testnet4: { status: 'seed-only-restored' },
        },
      })
      await expect(keyring.serialize()).resolves.toMatchObject({
        qbitRecoveryState: {
          networks: { regtest: { status: 'migrated', addressDiscoveryComplete: true } },
        },
      })
    })

    it('reopens a version-1 migrated state whose discovery completeness is missing', async () => {
      const { keyring } = await createRestoredQbitService()
      const serialized = await keyring.serialize()
      serialized.qbitRecoveryState = {
        version: 1,
        status: 'migrated',
        acknowledgement: 'accepted',
        migration: {
          destinationKeyringIndex: 1,
          destinationPubkey: 'ff'.repeat(32),
          destinationAddress: 'qbit-regtest-destination',
          network: 'regtest',
          plans: [],
        },
      } as any

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)

      expect(reloaded.getQbitRecoveryState()).toMatchObject({
        acknowledgement: 'accepted',
        networks: {
          regtest: {
            status: 'migrating',
            addressDiscoveryComplete: false,
            migration: {
              destinationPubkey: 'ff'.repeat(32),
              plans: [],
            },
          },
          testnet4: { status: 'seed-only-restored' },
          mainnet: { status: 'seed-only-restored' },
        },
      })
    })

    it('drops only the damaged migration plan when normalizing a vault', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      keyring.acknowledgeQbitRecoveryRisk()
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      const signedPlan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: 'qbit-regtest-source',
        destinationAddress: 'qbit-regtest-destination',
        amount: 98_000,
        fee: 2_000,
        psbtHex: 'aa'.repeat(40),
        status: 'broadcast' as const,
        signedPsbtHex: 'bb'.repeat(40),
        txid: 'cc'.repeat(32),
      }
      keyring.replaceQbitRecoveryMigrationPlans('regtest', [signedPlan])
      const serialized = await keyring.serialize()
      ;(serialized.qbitRecoveryState as any).networks.regtest.migration.plans.push({
        ...signedPlan,
        id: `${pubkey}:1`,
        txid: 'not-a-transaction-id',
      })

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)
      const state = reloaded.getQbitRecoveryState()

      expect(state).toMatchObject({
        acknowledgement: 'accepted',
        networks: {
          regtest: {
            status: 'migrating',
            addressDiscoveryComplete: true,
            migration: {
              plans: [
                expect.objectContaining({
                  id: signedPlan.id,
                  status: 'broadcast',
                  signedPsbtHex: signedPlan.signedPsbtHex,
                  txid: signedPlan.txid,
                }),
              ],
              planRecordIncomplete: true,
            },
          },
        },
      })
      expect(state!.networks.regtest!.migration!.plans).toHaveLength(1)
    })

    it('requires on-chain verification to archive after losing a migration plan', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      keyring.acknowledgeQbitRecoveryRisk()
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      const confirmedPlan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: 'qbit-regtest-source',
        destinationAddress: 'qbit-regtest-destination',
        amount: 98_000,
        fee: 2_000,
        psbtHex: 'aa'.repeat(40),
        status: 'confirmed' as const,
        signedPsbtHex: 'bb'.repeat(40),
        txid: 'cc'.repeat(32),
      }
      keyring.replaceQbitRecoveryMigrationPlans('regtest', [confirmedPlan])
      const serialized = await keyring.serialize()
      ;(serialized.qbitRecoveryState as any).networks.regtest.migration.plans.push({
        ...confirmedPlan,
        id: `${pubkey}:1`,
        txid: 'not-a-transaction-id',
      })

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)

      // The dropped plan's transaction may still be in flight, so the marker
      // must survive another vault round trip and block a trusting archive.
      const roundTripped = new QbitHdKeyring()
      await roundTripped.deserialize(await reloaded.serialize())
      expect(roundTripped.getQbitRecoveryState()).toMatchObject({
        networks: {
          regtest: { status: 'migrating', migration: { planRecordIncomplete: true } },
        },
      })

      expect(() => reloaded.markQbitRecoveryMigrated('regtest')).toThrow(
        'recovery migration plan record is incomplete'
      )
      expect(
        reloaded.markQbitRecoveryMigrated('regtest', { allowIncompletePlanRecord: true })
      ).toMatchObject({ networks: { regtest: { status: 'migrated' } } })
    })

    it('reopens a migrated vault instead of resetting it when a plan is damaged', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      keyring.acknowledgeQbitRecoveryRisk()
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      const confirmedPlan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: 'qbit-regtest-source',
        destinationAddress: 'qbit-regtest-destination',
        amount: 98_000,
        fee: 2_000,
        psbtHex: 'aa'.repeat(40),
        status: 'confirmed' as const,
        signedPsbtHex: 'bb'.repeat(40),
        txid: 'cc'.repeat(32),
      }
      keyring.replaceQbitRecoveryMigrationPlans('regtest', [confirmedPlan])
      keyring.markQbitRecoveryMigrated('regtest')
      const serialized = await keyring.serialize()
      ;(serialized.qbitRecoveryState as any).networks.regtest.migration.plans.push({
        ...confirmedPlan,
        id: `${pubkey}:1`,
        amount: -1,
      })

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)

      expect(reloaded.getQbitRecoveryState()).toMatchObject({
        networks: {
          regtest: {
            status: 'migrating',
            addressDiscoveryComplete: true,
            migration: {
              plans: [expect.objectContaining({ id: confirmedPlan.id, status: 'confirmed' })],
              planRecordIncomplete: true,
            },
          },
        },
      })
    })

    it('fails post-restore local provenance safely without inventing a chain floor', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      const serialized = await keyring.serialize()
      serialized.pqcSignatureCounters = { [pubkey]: 6 }
      serialized.pqcSignatureCounterProvenance = { [pubkey]: 'local' }
      delete serialized.pqcSignatureCounterChainFloors
      delete serialized.qbitRecoveryState

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)
      const [account] = await reloaded.getQbitAccounts()

      expect(account!.signatureCounter).toMatchObject({
        count: 6,
        provenance: 'restored-floor',
        knownOnChainSignatures: 0,
      })
    })

    it('raises a restored counter to an explicit persisted chain floor', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      const serialized = await keyring.serialize()
      serialized.pqcSignatureCounters = { [pubkey]: 3 }
      serialized.pqcSignatureCounterChainFloors = { [pubkey]: 8 }

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)
      const [account] = await reloaded.getQbitAccounts()

      expect(account!.signatureCounter).toMatchObject({
        count: 8,
        provenance: 'restored-floor',
        knownOnChainSignatures: 8,
      })
    })

    it('persists acknowledgement and chain-floor-only usage through lock and unlock', async () => {
      const { service, storage, pubkey } = await createRestoredQbitService(undefined, 4)

      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'seed-only-restored',
        acknowledgement: 'required',
        counterConfidence: 'chain-floor-only',
        knownOnChainSignatures: 4,
      })
      await expect(service.acknowledgeQbitRecoveryRisk(pubkey)).resolves.toMatchObject({
        acknowledgement: 'accepted',
      })
      expect(vaultPayload(storage)[0].data.qbitRecoveryState).toEqual({
        version: 2,
        acknowledgement: 'accepted',
        networks: {
          mainnet: { status: 'seed-only-restored', addressDiscoveryComplete: false },
          testnet4: { status: 'seed-only-restored', addressDiscoveryComplete: false },
          regtest: { status: 'seed-only-restored', addressDiscoveryComplete: true },
        },
      })

      await service.setLocked()
      const reloaded = new KeyringService()
      await reloaded.init({
        storage,
        encryptor: new JsonEncryptor(),
        logger: testLogger(),
        t: (key: string) => key,
      })
      await reloaded.submitPassword('password')
      await expect(reloaded.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        acknowledgement: 'accepted',
        knownOnChainSignatures: 4,
      })
    })

    it('persists a permanent warning dismissal only after acknowledgement', async () => {
      const { service, storage, pubkey } = await createRestoredQbitService(undefined, 4)

      await expect(service.dismissQbitRecoveryWarning(pubkey)).rejects.toThrow(
        'recovery risk has not been acknowledged'
      )
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        acknowledgement: 'required',
      })

      await service.acknowledgeQbitRecoveryRisk(pubkey)
      await expect(service.dismissQbitRecoveryWarning(pubkey)).resolves.toMatchObject({
        acknowledgement: 'accepted',
        warningDismissed: true,
      })
      expect(vaultPayload(storage)[0].data.qbitRecoveryState).toMatchObject({
        version: 2,
        acknowledgement: 'accepted',
        warningDismissed: true,
      })

      await service.setLocked()
      const reloaded = new KeyringService()
      await reloaded.init({
        storage,
        encryptor: new JsonEncryptor(),
        logger: testLogger(),
        t: (key: string) => key,
      })
      await reloaded.submitPassword('password')
      await expect(reloaded.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        acknowledgement: 'accepted',
        warningDismissed: true,
      })
    })

    it('drops a warning dismissal that lacks an acceptance when normalizing a vault', async () => {
      const { keyring } = await createRestoredQbitService()
      keyring.acknowledgeQbitRecoveryRisk()
      keyring.dismissQbitRecoveryWarning()

      const serialized = await keyring.serialize()
      ;(serialized.qbitRecoveryState as any).acknowledgement = 'required'

      const reloaded = new QbitHdKeyring()
      await reloaded.deserialize(serialized)
      const state = reloaded.getQbitRecoveryState()
      expect(state).toMatchObject({ acknowledgement: 'required' })
      expect(state!.warningDismissed).toBeUndefined()
    })

    it('serializes recovery mutations with password changes', async () => {
      const storage = new MemoryStorage()
      const encryptor = new BlockingJsonEncryptor()
      const service = new KeyringService()
      await service.init({
        storage,
        encryptor,
        logger: testLogger(),
        t: (key: string) => key,
      })
      await service.boot('password')
      const keyring = service.createTmpKeyring(QbitHdKeyring.type, {
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/1'/0'/0",
      }) as QbitHdKeyring
      await service.addDiscoveredQbitKeyring(keyring, 1, true)
      const [pubkey] = await keyring.getAccounts()
      await service.restorePqcSignatureCounterFloors(pubkey!, () => ({ observedSignatures: 3 }), {
        lookahead: 0,
      })

      const encryptionGate = encryptor.blockNextEncryption()
      const pendingPasswordChange = service.changePassword('password', 'new-password')
      await encryptionGate.started

      // Let the password change commit once, then fail every later vault write
      // so the recovery mutation's rollback persistence is defeated as well.
      let passwordCommitSeen = false
      storage.failKeyringStateWriteWhen = state => {
        if (passwordCommitSeen) return true
        passwordCommitSeen = JSON.parse(state.booted).password === 'new-password'
        return false
      }
      const acknowledgeSpy = vi.spyOn(keyring, 'acknowledgeQbitRecoveryRisk')
      const pendingAcknowledge = service.acknowledgeQbitRecoveryRisk(pubkey!)
      await flushMicrotasks()
      const mutatedBeforePasswordCommit = acknowledgeSpy.mock.calls.length > 0

      encryptionGate.release()
      await pendingPasswordChange
      await expect(pendingAcknowledge).rejects.toThrow(
        'forced storage failure for keyringState'
      )
      await flushMicrotasks()

      expect(mutatedBeforePasswordCommit).toBe(false)
      expect(keyring.getQbitRecoveryState()).toMatchObject({ acknowledgement: 'required' })
      // A defeated rollback must never resurrect the old-password vault beside
      // the new-password boot verifier.
      const liveState = service.store.getState()
      expect(JSON.parse(liveState.booted).password).toBe('new-password')
      expect(JSON.parse(liveState.vault).password).toBe('new-password')

      storage.failKeyringStateWriteWhen = undefined
      await service.setLocked()
      const restored = new KeyringService()
      await restored.init({
        storage,
        encryptor,
        logger: testLogger(),
        t: (key: string) => key,
      })
      await restored.submitPassword('new-password')
      await expect(restored.getQbitRecoveryState(pubkey!)).resolves.toMatchObject({
        status: 'seed-only-restored',
        acknowledgement: 'required',
      })
    })

    it('requires a fresh exact-request confirmation for restored message signing', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 5)
      const budget = await service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])

      expect(budget.restoredFloorRisk).toMatchObject({
        recoveryStatus: 'seed-only-restored',
        counterConfidence: 'chain-floor-only',
        knownOnChainSignatures: 5,
      })
      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_A, budget)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(5)

      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)
      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_B, budget)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(5)
      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_A, budget)
      ).resolves.toMatchObject({
        cached: false,
        counter: expect.objectContaining({ previousCounter: 5, newCounter: 6 }),
      })
      const [account] = await keyring.getQbitAccounts()
      expect(account!.signatureCounter).toMatchObject({
        count: 6,
        provenance: 'restored-floor',
        knownOnChainSignatures: 5,
      })

      // Replaying the consumed approval shifts its required signature to
      // cached, which the strict budget assertion rejects before the
      // consumed one-shot challenge is even consulted.
      await expect(service.signP2mrMessageWithCounter(pubkey, DIGEST_A, budget)).rejects.toThrow(
        'P2MR signature budget changed after approval'
      )
      const cachedBudget = await service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])
      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_A, cachedBudget)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
      await service.confirmQbitRestoredFloorSigning(cachedBudget.restoredFloorRisk!.challengeId)
      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_A, cachedBudget)
      ).resolves.toMatchObject({ cached: true, counter: null })
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(6)
      await expect(
        service.confirmQbitRestoredFloorSigning(cachedBudget.restoredFloorRisk!.challengeId)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
    })

    it('retains a confirmed restored-floor message challenge after a pre-sign persist failure', async () => {
      const { service, keyring, storage, pubkey } = await createRestoredQbitService(undefined, 5)
      const budget = await service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])
      const challengeId = budget.restoredFloorRisk!.challengeId
      const signer = vi.spyOn(keyring, 'signPqcDigest')
      await service.confirmQbitRestoredFloorSigning(challengeId)
      storage.failSetKeys.add('keyringState')

      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_A, budget)
      ).rejects.toThrow('forced storage failure')
      expect(signer).not.toHaveBeenCalled()
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(5)

      storage.failSetKeys.delete('keyringState')
      // The confirmed challenge survived the persist failure, so retrying the
      // approved signing with the original budget needs no re-confirmation.
      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_A, budget)
      ).resolves.toMatchObject({
        cached: false,
        counter: expect.objectContaining({ previousCounter: 5, newCounter: 6 }),
      })
      expect(signer).toHaveBeenCalledTimes(1)
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(6)
      await expect(
        service.confirmQbitRestoredFloorSigning(challengeId)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
    })

    it('rejects challenge overflow without evicting live restored-floor approvals', async () => {
      const { service, pubkey } = await createRestoredQbitService(undefined, 5)
      const now = 1_000_000
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

      try {
        const confirmedBudget = await service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])
        await service.confirmQbitRestoredFloorSigning(
          confirmedBudget.restoredFloorRisk!.challengeId
        )

        const pendingBudgets = []
        for (let index = 1; index < 128; index += 1) {
          const digest = index.toString(16).padStart(64, '0')
          pendingBudgets.push(await service.preflightP2mrMessageSigning(pubkey, [digest]))
        }

        await expect(
          service.preflightP2mrMessageSigning(pubkey, ['ff'.repeat(32)])
        ).rejects.toThrow('qbit_recovery_secure_confirmation_unavailable')
        await Promise.all(
          pendingBudgets.map(budget =>
            service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)
          )
        )
        await expect(
          service.signP2mrMessageWithCounter(pubkey, DIGEST_A, confirmedBudget)
        ).resolves.toMatchObject({
          cached: false,
          counter: expect.objectContaining({ previousCounter: 5, newCounter: 6 }),
        })

        const replacement = await service.preflightP2mrMessageSigning(pubkey, ['ff'.repeat(32)])
        nowSpy.mockReturnValue(now + 5 * 60 * 1000 + 1)
        const recovered = await service.preflightP2mrMessageSigning(pubkey, ['fe'.repeat(32)])

        await expect(
          service.confirmQbitRestoredFloorSigning(replacement.restoredFloorRisk!.challengeId)
        ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
        await expect(
          service.confirmQbitRestoredFloorSigning(recovered.restoredFloorRisk!.challengeId)
        ).resolves.toBeUndefined()
      } finally {
        nowSpy.mockRestore()
      }
    })

    it('reuses exact restored-floor challenges across repeated migration preparation batches', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 5)
      const fixtures = await Promise.all(
        Array.from({ length: 129 }, (_, index) =>
          buildP2mrSpendFixture(keyring, { txidSeed: index + 1 })
        )
      )
      const [account] = await keyring.getQbitAccounts()
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      await service.replaceQbitRecoveryMigrationPlans(
        pubkey,
        'regtest',
        fixtures.slice(0, 64).map((fixture, index) => ({
          id: `${pubkey}:${index}`,
          sourcePubkey: pubkey,
          sourceAddress: account!.addresses.regtest,
          destinationAddress: 'qbit-regtest-destination',
          amount: 98_000,
          fee: 2_000,
          psbtHex: protocolBytesToHex(serializePsbt(fixture.psbt)),
          status: 'prepared' as const,
        }))
      )

      const firstPassChallengeIds: string[] = []
      for (let pass = 0; pass < 3; pass += 1) {
        const passChallengeIds: string[] = []
        for (const [index, fixture] of fixtures.slice(0, 64).entries()) {
          const budget = await service.preflightP2mrPsbtSigning(
            pubkey,
            {
              psbt: fixture.psbt,
              keys: fixture.keys,
            },
            { reuseScope: `qbit-recovery-migration:${pubkey}:${index}` }
          )
          passChallengeIds.push(budget.restoredFloorRisk!.challengeId)
        }
        if (pass === 0) {
          firstPassChallengeIds.push(...passChallengeIds)
        } else {
          expect(passChallengeIds).toEqual(firstPassChallengeIds)
        }
      }
      expect(new Set(firstPassChallengeIds).size).toBe(64)

      const distinctChallengeIds: string[] = []
      for (const fixture of fixtures.slice(64, 128)) {
        const budget = await service.preflightP2mrPsbtSigning(
          pubkey,
          { psbt: fixture.psbt, keys: fixture.keys },
          { allowMigrationProtectedAssetTransfer: true }
        )
        distinctChallengeIds.push(budget.restoredFloorRisk!.challengeId)
      }
      expect(new Set([...firstPassChallengeIds, ...distinctChallengeIds]).size).toBe(128)
      await expect(
        service.preflightP2mrPsbtSigning(
          pubkey,
          { psbt: fixtures[128]!.psbt, keys: fixtures[128]!.keys },
          { allowMigrationProtectedAssetTransfer: true }
        )
      ).rejects.toThrow('qbit_recovery_secure_confirmation_unavailable')
    })

    it('lets duplicate batch entries confirm and sign with their own challenges', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 5)
      const fixture = await buildP2mrSpendFixture(keyring, { txidSeed: 7 })
      const input = () => ({ psbt: fixture.psbt, keys: fixture.keys })

      // A signPsbts batch carrying the same PSBT twice preflights identical
      // cache keys; without a reuse scope each entry must get its own
      // one-shot challenge.
      const first = await service.preflightP2mrPsbtSigning(pubkey, input())
      const second = await service.preflightP2mrPsbtSigning(pubkey, input())
      expect(first.restoredFloorRisk!.challengeId).not.toBe(second.restoredFloorRisk!.challengeId)

      await service.confirmQbitRestoredFloorSigning(first.restoredFloorRisk!.challengeId)
      await service.confirmQbitRestoredFloorSigning(second.restoredFloorRisk!.challengeId)

      const signedFirst = await service.signP2mrPsbtWithCounter(pubkey, input(), first)
      expect(signedFirst.counterResults.map(result => result.cached)).toEqual([false])

      // The duplicate entry still completes: its own challenge survived the
      // first consume, and its approved signature is served from the cache
      // without advancing the counter. Only the batch signer may assert the
      // duplicate status; without it the shifted budget must reject.
      await expect(service.signP2mrPsbtWithCounter(pubkey, input(), second)).rejects.toThrow(
        'P2MR signature budget changed after approval'
      )
      const signedSecond = await service.signP2mrPsbtWithCounter(pubkey, input(), second, true)
      expect(signedSecond.counterResults.map(result => result.cached)).toEqual([true])
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(6)
    })

    it('clears confirmed restored-floor challenges when the wallet locks', async () => {
      const { service, pubkey } = await createRestoredQbitService(undefined, 1)
      const budget = await service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])
      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)

      await service.setLocked()
      await service.submitPassword('password')

      await expect(
        service.signP2mrMessageWithCounter(pubkey, DIGEST_A, budget)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(1)
    })

    it('enforces the same one-time restored-floor confirmation for PSBT signing', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 2)
      const fixture = await buildP2mrSpendFixture(keyring)
      const budget = await service.preflightP2mrPsbtSigning(pubkey, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })

      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)
      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).resolves.toMatchObject({
        signed: [expect.objectContaining({ inputIndex: 0 })],
      })
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(3)
    })

    it('retains a confirmed restored-floor multi-input PSBT challenge after a pre-sign persist failure', async () => {
      const { service, keyring, storage, pubkey } = await createRestoredQbitService(undefined, 2)
      const fixture = await buildP2mrSpendFixture(keyring, { inputCount: 2 })
      const budget = await service.preflightP2mrPsbtSigning(pubkey, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })
      const challengeId = budget.restoredFloorRisk!.challengeId
      const signer = vi.spyOn(keyring, 'signPqcDigest')
      await service.confirmQbitRestoredFloorSigning(challengeId)
      storage.failSetKeys.add('keyringState')

      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).rejects.toThrow('forced storage failure')
      expect(signer).not.toHaveBeenCalled()
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(2)

      storage.failSetKeys.delete('keyringState')
      await expect(service.confirmQbitRestoredFloorSigning(challengeId)).resolves.toBeUndefined()
      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).resolves.toMatchObject({
        signed: [
          expect.objectContaining({ inputIndex: 0 }),
          expect.objectContaining({ inputIndex: 1 }),
        ],
        counterResults: [
          expect.objectContaining({
            inputIndex: 0,
            cached: false,
            counter: expect.objectContaining({ previousCounter: 2, newCounter: 3 }),
          }),
          expect.objectContaining({
            inputIndex: 1,
            cached: false,
            counter: expect.objectContaining({ previousCounter: 3, newCounter: 4 }),
          }),
        ],
      })
      expect(signer).toHaveBeenCalledTimes(2)
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(4)
      await expect(
        service.confirmQbitRestoredFloorSigning(challengeId)
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
    })

    it('scopes the migration archive to the migration network coin type', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService()
      let activeNetwork: string | undefined = 'testnet4'
      service.setActiveQbitNetworkResolver(() => activeNetwork)
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      await expect(service.markQbitRecoveryMigrated(pubkey, 'regtest')).resolves.toMatchObject({
        status: 'migrated',
      })
      // The sibling network still awaits its own recovery, so the shared
      // coin-1 keys are not read-only yet: testnet4 funds must stay sweepable
      // through the usual restored-floor confirmation.
      const siblingBudget = await service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])
      expect(siblingBudget.restoredFloorRisk?.challengeId).toBeTruthy()
      // The archived network's own record governs signing while it is active,
      // and an unresolvable active network fails closed the same way instead
      // of falling open to the still-restored sibling's status.
      activeNetwork = 'regtest'
      await expect(service.preflightP2mrMessageSigning(pubkey, [DIGEST_B])).rejects.toThrow(
        'qbit_recovery_archived_signing_blocked'
      )
      activeNetwork = undefined
      await expect(service.preflightP2mrMessageSigning(pubkey, [DIGEST_B])).rejects.toThrow(
        'qbit_recovery_archived_signing_blocked'
      )
      activeNetwork = 'testnet4'
      await expect(service.getQbitRecoveryState(pubkey, 'testnet4')).resolves.toMatchObject({
        status: 'seed-only-restored',
      })
      await expect(service.getQbitRecoveryState(pubkey, 'regtest')).resolves.toMatchObject({
        status: 'migrated',
      })

      // Once every network of this coin type has archived, the keys become
      // read-only.
      keyring.beginQbitRecoveryMigration('testnet4', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-testnet4-destination',
        network: 'testnet4',
      })
      keyring.completeQbitRecoveryAddressDiscovery('testnet4')
      await expect(service.markQbitRecoveryMigrated(pubkey, 'testnet4')).resolves.toMatchObject({
        status: 'migrated',
      })
      await expect(service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])).rejects.toThrow(
        'archived'
      )

      // Mainnet re-derives coin-type-0 keys the migration never scanned,
      // planned, or swept; they stay seed-only restored and sign through the
      // usual confirmation challenge once their floors are reconstructed.
      activeNetwork = 'mainnet'
      keyring.changeHdPath("m/87'/0'/0'/0")
      const [mainnetPubkey] = await keyring.getAccounts()
      expect(mainnetPubkey).not.toBe(pubkey)
      await service.restorePqcSignatureCounterFloors(
        mainnetPubkey!,
        () => ({ observedSignatures: 2 }),
        { lookahead: 0 }
      )
      await expect(service.getQbitRecoveryState(mainnetPubkey!)).resolves.toMatchObject({
        status: 'seed-only-restored',
      })
      const budget = await service.preflightP2mrMessageSigning(mainnetPubkey!, [DIGEST_A])
      expect(budget.restoredFloorRisk?.challengeId).toBeTruthy()

      // Switching back to the migration coin type restores the archive.
      keyring.changeHdPath("m/87'/1'/0'/0")
      await service.restorePqcSignatureCounterFloors(pubkey, () => ({ observedSignatures: 3 }), {
        lookahead: 0,
      })
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'migrated',
      })
      await expect(service.preflightP2mrMessageSigning(pubkey, [DIGEST_B])).rejects.toThrow(
        'archived'
      )
    })

    it('gates PSBT signing by the active network when one sibling network is archived', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 2)
      let activeNetwork: string | undefined = 'regtest'
      service.setActiveQbitNetworkResolver(() => activeNetwork)
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      await service.markQbitRecoveryMigrated(pubkey, 'regtest')

      // While the wallet is on the archived network, ordinary signing is
      // blocked at preflight and at final signing — provider requests
      // included.
      const fixture = await buildP2mrSpendFixture(keyring)
      await expect(
        service.preflightP2mrPsbtSigning(pubkey, { psbt: fixture.psbt, keys: fixture.keys })
      ).rejects.toThrow('qbit_recovery_archived_signing_blocked')
      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys })
      ).rejects.toThrow('qbit_recovery_archived_signing_blocked')
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(2)

      // The still-restored sibling keeps signing through its confirmation
      // challenge.
      activeNetwork = 'testnet4'
      const budget = await service.preflightP2mrPsbtSigning(pubkey, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })
      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)
      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).resolves.toMatchObject({
        signed: [expect.objectContaining({ inputIndex: 0 })],
      })
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(3)
    })

    it('keeps the archived active network blocked while a sibling network migrates', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 2)
      let activeNetwork: string | undefined = 'regtest'
      service.setActiveQbitNetworkResolver(() => activeNetwork)
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      await service.markQbitRecoveryMigrated(pubkey, 'regtest')
      keyring.beginQbitRecoveryMigration('testnet4', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-testnet4-destination',
        network: 'testnet4',
      })

      // The sibling's migration collapses the coin type to migrating, but the
      // active network is archived: even a controller-attested protected-asset
      // transfer must not receive a challenge against the archive.
      const fixture = await buildP2mrSpendFixture(keyring)
      await expect(
        service.preflightP2mrPsbtSigning(
          pubkey,
          { psbt: fixture.psbt, keys: fixture.keys },
          { allowMigrationProtectedAssetTransfer: true }
        )
      ).rejects.toThrow('qbit_recovery_archived_signing_blocked')
      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys })
      ).rejects.toThrow('qbit_recovery_archived_signing_blocked')
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(2)

      // The migrating sibling itself keeps signing its reviewed plan while it
      // is the active network.
      activeNetwork = 'testnet4'
      const [account] = await keyring.getQbitAccounts()
      await service.replaceQbitRecoveryMigrationPlans(pubkey, 'testnet4', [
        {
          id: `${pubkey}:0`,
          sourcePubkey: pubkey,
          sourceAddress: account!.addresses.testnet4,
          destinationAddress: 'qbit-testnet4-destination',
          amount: 98_000,
          fee: 2_000,
          psbtHex: protocolBytesToHex(serializePsbt(fixture.psbt)),
          status: 'prepared' as const,
        },
      ])
      const budget = await service.preflightP2mrPsbtSigning(pubkey, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })
      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)
      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).resolves.toMatchObject({ signed: [expect.objectContaining({ inputIndex: 0 })] })
    })

    it('re-checks the active network between preflight confirmation and signing', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 2)
      let activeNetwork: string | undefined = 'testnet4'
      service.setActiveQbitNetworkResolver(() => activeNetwork)
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      await service.markQbitRecoveryMigrated(pubkey, 'regtest')

      const fixture = await buildP2mrSpendFixture(keyring)
      const budget = await service.preflightP2mrPsbtSigning(pubkey, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })
      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)

      // A network switch onto the archived sibling after approval must not
      // ride the already-confirmed challenge into an archived-source spend.
      activeNetwork = 'regtest'
      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).rejects.toThrow('qbit_recovery_archived_signing_blocked')
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(2)
    })

    it('rejects a pre-migration signing challenge after migration starts', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 2)
      const fixture = await buildP2mrSpendFixture(keyring)
      const budget = await service.preflightP2mrPsbtSigning(pubkey, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })
      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)

      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })

      await expect(
        service.signP2mrPsbtWithCounter(pubkey, { psbt: fixture.psbt, keys: fixture.keys }, budget)
      ).rejects.toThrow('qbit_recovery_migration_signing_only')
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(2)
    })

    it('does not issue a normal signing challenge when migration starts during preflight', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 2)
      const fixture = await buildP2mrSpendFixture(keyring)
      const getMetadata = keyring.getPqcSignatureCounterMetadata.bind(keyring)
      vi.spyOn(keyring, 'getPqcSignatureCounterMetadata').mockImplementationOnce(
        async address => {
          keyring.beginQbitRecoveryMigration('regtest', {
            destinationKeyringIndex: 1,
            destinationPubkey: 'ff'.repeat(32),
            destinationAddress: 'qbit-regtest-destination',
            network: 'regtest',
          })
          return getMetadata(address)
        }
      )

      await expect(
        service.preflightP2mrPsbtSigning(pubkey, {
          psbt: fixture.psbt,
          keys: fixture.keys,
        })
      ).rejects.toThrow('qbit_recovery_migration_signing_only')
      expect(await service.getPqcSignatureCounter(pubkey)).toBe(2)
    })

    it('atomically creates a genuinely fresh destination and persists migration transitions', async () => {
      const { service, keyring, storage, pubkey } = await createRestoredQbitService()
      const freshMnemonic = await service.generatePreMnemonic()
      const destination = await service.createQbitMigrationKeyring({
        sourceAddress: pubkey,
        mnemonic: freshMnemonic,
        hdPath: "m/87'/1'/0'/0",
        passphrase: '',
        network: 'regtest',
      })

      expect(destination.destinationPubkey).not.toBe(pubkey)
      expect(service.keyrings).toHaveLength(2)
      expect(await service.getPreMnemonics()).toBe('')
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'migrating',
        migration: {
          destinationKeyringIndex: 1,
          destinationAddress: destination.destinationAddress,
        },
      })
      expect(await service.getQbitRecoveryState(destination.destinationPubkey)).toMatchObject({
        status: 'clean',
        counterConfidence: 'local',
      })

      const fixture = await buildP2mrSpendFixture(keyring)
      const plan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: (await keyring.getQbitAccounts())[0]!.addresses.regtest,
        destinationAddress: destination.destinationAddress,
        amount: 98_000,
        fee: 2_000,
        psbtHex: protocolBytesToHex(serializePsbt(fixture.psbt)),
        status: 'prepared' as const,
      }
      await service.replaceQbitRecoveryMigrationPlans(pubkey, 'regtest', [plan])

      const unrelated = await buildP2mrSpendFixture(keyring, { txidSeed: 99 })
      await expect(
        service.preflightP2mrPsbtSigning(pubkey, {
          psbt: unrelated.psbt,
          keys: unrelated.keys,
        })
      ).rejects.toThrow('qbit_recovery_migration_signing_only')
      const protectedAssetBudget = await service.preflightP2mrPsbtSigning(
        pubkey,
        {
          psbt: unrelated.psbt,
          keys: unrelated.keys,
        },
        { allowMigrationProtectedAssetTransfer: true }
      )
      await expect(
        service.signP2mrPsbtWithCounter(
          pubkey,
          { psbt: unrelated.psbt, keys: unrelated.keys },
          protectedAssetBudget
        )
      ).rejects.toBeInstanceOf(QbitRestoredFloorConfirmationError)
      await service.confirmQbitRestoredFloorSigning(
        protectedAssetBudget.restoredFloorRisk!.challengeId
      )
      await expect(
        service.signP2mrPsbtWithCounter(
          pubkey,
          { psbt: unrelated.psbt, keys: unrelated.keys },
          protectedAssetBudget
        )
      ).resolves.toMatchObject({
        signed: [expect.objectContaining({ inputIndex: 0 })],
      })
      await expect(service.preflightP2mrMessageSigning(pubkey, [DIGEST_A])).rejects.toThrow(
        'qbit_recovery_migration_signing_only'
      )
      const migrationBudget = await service.preflightP2mrPsbtSigning(pubkey, {
        psbt: fixture.psbt,
        keys: fixture.keys,
      })
      expect(migrationBudget).toHaveProperty('restoredFloorRisk')
      await service.confirmQbitRestoredFloorSigning(
        migrationBudget.restoredFloorRisk!.challengeId
      )
      await expect(
        service.signP2mrPsbtWithCounter(
          pubkey,
          { psbt: fixture.psbt, keys: fixture.keys },
          migrationBudget
        )
      ).resolves.toMatchObject({
        signed: [expect.objectContaining({ inputIndex: 0 })],
      })

      await expect(
        service.updateQbitRecoveryMigrationPlan(pubkey, 'regtest', plan.id, {
          status: 'broadcast',
          signedPsbtHex: plan.psbtHex,
          txid: 'aa'.repeat(32),
        })
      ).rejects.toThrow('invalid recovery migration plan transition')
      await service.updateQbitRecoveryMigrationPlan(pubkey, 'regtest', plan.id, {
        status: 'signed',
        signedPsbtHex: plan.psbtHex,
        txid: 'aa'.repeat(32),
      })
      await service.updateQbitRecoveryMigrationPlan(pubkey, 'regtest', plan.id, {
        status: 'broadcast',
        signedPsbtHex: plan.psbtHex,
        txid: 'aa'.repeat(32),
      })
      await service.updateQbitRecoveryMigrationPlan(pubkey, 'regtest', plan.id, {
        status: 'confirmed',
        signedPsbtHex: plan.psbtHex,
        txid: 'aa'.repeat(32),
      })
      await expect(
        service.updateQbitRecoveryMigrationPlan(pubkey, 'regtest', plan.id, {
          status: 'broadcast',
          signedPsbtHex: plan.psbtHex,
          txid: 'bb'.repeat(32),
        })
      ).rejects.toThrow('invalid recovery migration plan transition')
      await expect(
        service.updateQbitRecoveryMigrationPlan(pubkey, 'regtest', plan.id, {
          status: 'broadcast',
          signedPsbtHex: plan.psbtHex,
          txid: 'aa'.repeat(32),
        })
      ).resolves.toMatchObject({
        migration: { plans: [expect.objectContaining({ status: 'broadcast' })] },
      })
      await service.updateQbitRecoveryMigrationPlan(pubkey, 'regtest', plan.id, {
        status: 'confirmed',
        signedPsbtHex: plan.psbtHex,
        txid: 'aa'.repeat(32),
      })
      await expect(service.markQbitRecoveryMigrated(pubkey, 'regtest')).resolves.toMatchObject({
        status: 'migrated',
        acknowledgement: 'accepted',
      })
      // The sibling network still awaits its own recovery, so the coin-1 keys
      // are only read-only once it archives too.
      keyring.beginQbitRecoveryMigration('testnet4', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-testnet4-destination',
        network: 'testnet4',
      })
      keyring.completeQbitRecoveryAddressDiscovery('testnet4')
      keyring.markQbitRecoveryMigrated('testnet4')
      await expect(
        service.preflightP2mrPsbtSigning(
          pubkey,
          { psbt: unrelated.psbt, keys: unrelated.keys },
          { allowMigrationProtectedAssetTransfer: true }
        )
      ).rejects.toThrow('qbit_recovery_archived_signing_blocked')
      await expect(service.preflightP2mrMessageSigning(pubkey, [DIGEST_B])).rejects.toThrow(
        'archived'
      )

      expect(vaultPayload(storage)).toHaveLength(2)
      expect(vaultPayload(storage)[0].data.qbitRecoveryState).toMatchObject({
        networks: {
          regtest: {
            status: 'migrated',
            migration: {
              plans: [expect.objectContaining({ status: 'confirmed' })],
            },
          },
        },
      })

      await expect(
        service.reopenQbitRecoveryMigration(pubkey, 'regtest', [plan.id])
      ).resolves.toMatchObject({
        status: 'migrating',
        migration: {
          plans: [expect.objectContaining({ status: 'broadcast' })],
        },
      })
      await expect(service.preflightP2mrMessageSigning(pubkey, [DIGEST_B])).rejects.toThrow(
        'qbit_recovery_migration_signing_only'
      )
    })

    it('waits for sibling source account signing before starting migration', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService(undefined, 2, 2)
      const [, siblingPubkey] = await keyring.getAccounts()
      const freshMnemonic = await service.generatePreMnemonic()
      const budget = await service.preflightP2mrMessageSigning(siblingPubkey!, [DIGEST_A])
      await service.confirmQbitRestoredFloorSigning(budget.restoredFloorRisk!.challengeId)

      const signPqcDigest = keyring.signPqcDigest.bind(keyring)
      let markSignerStarted!: () => void
      let releaseSigner!: () => void
      const signerStarted = new Promise<void>(resolve => {
        markSignerStarted = resolve
      })
      const signerRelease = new Promise<void>(resolve => {
        releaseSigner = resolve
      })
      vi.spyOn(keyring, 'signPqcDigest').mockImplementation(async (address, digest) => {
        if (address === siblingPubkey) {
          markSignerStarted()
          await signerRelease
        }
        return signPqcDigest(address, digest)
      })

      const signing = service.signP2mrMessageWithCounter(siblingPubkey!, DIGEST_A, budget)
      await signerStarted

      let markDestinationValidated!: () => void
      const destinationValidated = new Promise<void>(resolve => {
        markDestinationValidated = resolve
      })
      const checkForDuplicate = service.checkForDuplicate.bind(service)
      vi.spyOn(service, 'checkForDuplicate').mockImplementation(async (type, accounts) => {
        const result = await checkForDuplicate(type, accounts)
        markDestinationValidated()
        return result
      })
      let migrationSettled = false
      const migration = service
        .createQbitMigrationKeyring({
          sourceAddress: pubkey,
          mnemonic: freshMnemonic,
          hdPath: "m/87'/1'/0'/0",
          passphrase: '',
          network: 'regtest',
        })
        .finally(() => {
          migrationSettled = true
        })

      await destinationValidated
      await flushMicrotasks()
      expect(migrationSettled).toBe(false)
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'seed-only-restored',
      })

      releaseSigner()
      await expect(signing).resolves.toMatchObject({
        cached: false,
        counter: expect.objectContaining({ previousCounter: 2, newCounter: 3 }),
      })
      await expect(migration).resolves.toMatchObject({ destinationKeyringIndex: 1 })
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'migrating',
      })
    })

    it('rolls back both wallets when the atomic destination persist fails', async () => {
      const { service, storage, pubkey } = await createRestoredQbitService()
      storage.failSetKeys.add('keyringState')
      const freshMnemonic = await service.generatePreMnemonic()

      await expect(
        service.createQbitMigrationKeyring({
          sourceAddress: pubkey,
          mnemonic: freshMnemonic,
          hdPath: "m/87'/1'/0'/0",
          passphrase: '',
          network: 'regtest',
        })
      ).rejects.toThrow('forced storage failure')

      expect(service.keyrings).toHaveLength(1)
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'seed-only-restored',
      })
      expect(vaultPayload(storage)).toHaveLength(1)
    })

    it('refuses to label an imported mnemonic as a fresh migration wallet', async () => {
      const { service, pubkey } = await createRestoredQbitService()

      await expect(
        service.createQbitMigrationKeyring({
          sourceAddress: pubkey,
          mnemonic: service.generateMnemonic(),
          hdPath: "m/87'/1'/0'/0",
          passphrase: '',
          network: 'regtest',
        })
      ).rejects.toThrow('requires a newly generated wallet seed')
      expect(service.keyrings).toHaveLength(1)
    })

    it('commits migration plans and destination reservations as one vault write', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService()
      const freshMnemonic = await service.generatePreMnemonic()
      const destination = await service.createQbitMigrationKeyring({
        sourceAddress: pubkey,
        mnemonic: freshMnemonic,
        hdPath: "m/87'/1'/0'/0",
        passphrase: '',
        network: 'regtest',
      })
      const fixture = await buildP2mrSpendFixture(keyring)
      const plan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: (await keyring.getQbitAccounts())[0]!.addresses.regtest,
        destinationAddress: destination.destinationAddress,
        destinationPubkey: destination.destinationPubkey,
        destinationIndex: 0,
        amount: 98_000,
        fee: 2_000,
        psbtHex: protocolBytesToHex(serializePsbt(fixture.psbt)),
        status: 'prepared' as const,
      }

      await service.replaceQbitRecoveryMigrationPlansWithDestinationReservations(
        pubkey,
        'regtest',
        [plan],
        { anchor: destination.destinationPubkey, reserveIndexes: [0], reuseIndexes: [] }
      )

      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'migrating',
        migration: expect.objectContaining({
          plans: [expect.objectContaining({ id: `${pubkey}:0`, destinationIndex: 0 })],
        }),
      })
      await expect(
        service.getQbitReceiveState(destination.destinationPubkey, 'regtest')
      ).resolves.toMatchObject({ issuedIndexes: [0] })
    })

    it('rolls back plans and reservations together when the combined persist fails', async () => {
      const { service, keyring, storage, pubkey } = await createRestoredQbitService()
      const freshMnemonic = await service.generatePreMnemonic()
      const destination = await service.createQbitMigrationKeyring({
        sourceAddress: pubkey,
        mnemonic: freshMnemonic,
        hdPath: "m/87'/1'/0'/0",
        passphrase: '',
        network: 'regtest',
      })
      const fixture = await buildP2mrSpendFixture(keyring)
      const plan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: (await keyring.getQbitAccounts())[0]!.addresses.regtest,
        destinationAddress: destination.destinationAddress,
        destinationPubkey: destination.destinationPubkey,
        destinationIndex: 0,
        amount: 98_000,
        fee: 2_000,
        psbtHex: protocolBytesToHex(serializePsbt(fixture.psbt)),
        status: 'prepared' as const,
      }

      storage.failSetKeys.add('keyringState')
      await expect(
        service.replaceQbitRecoveryMigrationPlansWithDestinationReservations(
          pubkey,
          'regtest',
          [plan],
          { anchor: destination.destinationPubkey, reserveIndexes: [0] }
        )
      ).rejects.toThrow('forced storage failure')
      storage.failSetKeys.delete('keyringState')

      // Neither half of the failed commit survives: no plan references the
      // indexes, so no reservation may burn them.
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        status: 'migrating',
        migration: expect.objectContaining({ plans: [] }),
      })
      await expect(
        service.getQbitReceiveState(destination.destinationPubkey, 'regtest')
      ).resolves.toMatchObject({ issuedIndexes: [] })

      // The rolled-back reservation leaves the index free for the retry.
      await service.replaceQbitRecoveryMigrationPlansWithDestinationReservations(
        pubkey,
        'regtest',
        [plan],
        { anchor: destination.destinationPubkey, reserveIndexes: [0] }
      )
      await expect(
        service.getQbitReceiveState(destination.destinationPubkey, 'regtest')
      ).resolves.toMatchObject({ issuedIndexes: [0] })
    })

    it('refuses to reserve a destination index the receive ledger already tracks', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService()
      const freshMnemonic = await service.generatePreMnemonic()
      const destination = await service.createQbitMigrationKeyring({
        sourceAddress: pubkey,
        mnemonic: freshMnemonic,
        hdPath: "m/87'/1'/0'/0",
        passphrase: '',
        network: 'regtest',
      })
      await service.markQbitReceiveIndexesIssued(destination.destinationPubkey, 'regtest', [0])
      const fixture = await buildP2mrSpendFixture(keyring)
      const plan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: (await keyring.getQbitAccounts())[0]!.addresses.regtest,
        destinationAddress: destination.destinationAddress,
        destinationPubkey: destination.destinationPubkey,
        destinationIndex: 0,
        amount: 98_000,
        fee: 2_000,
        psbtHex: protocolBytesToHex(serializePsbt(fixture.psbt)),
        status: 'prepared' as const,
      }

      // The receive flow handed index 0 out between allocation and commit: a
      // sweep must not pay a presented address, so the commit is refused and
      // the caller re-allocates from the fresh ledger.
      await expect(
        service.replaceQbitRecoveryMigrationPlansWithDestinationReservations(
          pubkey,
          'regtest',
          [plan],
          { anchor: destination.destinationPubkey, reserveIndexes: [0] }
        )
      ).rejects.toThrow('was issued while migration plans were being prepared')
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        migration: expect.objectContaining({ plans: [] }),
      })

      // A re-sweep that deliberately pays its previously paired index passes
      // the same ledger state through reuseIndexes.
      await service.replaceQbitRecoveryMigrationPlansWithDestinationReservations(
        pubkey,
        'regtest',
        [plan],
        { anchor: destination.destinationPubkey, reserveIndexes: [], reuseIndexes: [0] }
      )
      await expect(service.getQbitRecoveryState(pubkey)).resolves.toMatchObject({
        migration: expect.objectContaining({
          plans: [expect.objectContaining({ id: `${pubkey}:0` })],
        }),
      })
    })
  })

  describe('multi-network recovery lifecycle (v2)', () => {
    it('upgrades a v1 vault by filing its lifecycle under the migration network', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      const serialized = await keyring.serialize()
      serialized.qbitRecoveryState = {
        version: 1,
        status: 'migrated',
        acknowledgement: 'accepted',
        addressDiscoveryComplete: true,
        migration: {
          destinationKeyringIndex: 1,
          destinationPubkey: 'ff'.repeat(32),
          destinationAddress: 'qbit-testnet4-destination',
          network: 'testnet4',
          plans: [
            {
              id: `${pubkey}:0`,
              sourcePubkey: pubkey,
              sourceAddress: 'qbit-testnet4-source',
              destinationAddress: 'qbit-testnet4-destination',
              amount: 98_000,
              fee: 2_000,
              psbtHex: 'aa'.repeat(40),
              status: 'confirmed' as const,
              signedPsbtHex: 'bb'.repeat(40),
              txid: 'cc'.repeat(32),
            },
          ],
        },
      } as any

      const upgraded = new QbitHdKeyring()
      await upgraded.deserialize(serialized)

      // The upgrade is what rescues stranded wallets: the archived network
      // keeps its record while every other network comes back migratable.
      expect(upgraded.getQbitRecoveryState()).toMatchObject({
        acknowledgement: 'accepted',
        networks: {
          testnet4: {
            status: 'migrated',
            addressDiscoveryComplete: true,
            migration: { network: 'testnet4', plans: [expect.objectContaining({ status: 'confirmed' })] },
          },
          mainnet: { status: 'seed-only-restored', addressDiscoveryComplete: false },
          regtest: { status: 'seed-only-restored', addressDiscoveryComplete: false },
        },
      })
      expect(() =>
        upgraded.beginQbitRecoveryMigration('regtest', {
          destinationKeyringIndex: 1,
          destinationPubkey: 'ff'.repeat(32),
          destinationAddress: 'qbit-regtest-destination',
          network: 'regtest',
        })
      ).not.toThrow()
    })

    it('upgrades a migration-less v1 vault by coin type', async () => {
      // Coin type 0 unambiguously means mainnet, so discovery completeness
      // carries over.
      const mainnetKeyring = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/0'/0'/0",
        pqcFloorsPending: true,
        qbitRecoveryState: {
          version: 1,
          status: 'seed-only-restored',
          acknowledgement: 'accepted',
          addressDiscoveryComplete: true,
        } as any,
      })
      expect(mainnetKeyring.getQbitRecoveryState()).toMatchObject({
        acknowledgement: 'accepted',
        networks: {
          mainnet: { status: 'seed-only-restored', addressDiscoveryComplete: true },
          testnet4: { addressDiscoveryComplete: false },
          regtest: { addressDiscoveryComplete: false },
        },
      })

      // Coin type 1 cannot tell testnet4 from regtest, so completeness is
      // conservatively reset for both (discovery is resumable).
      const coin1Keyring = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/1'/0'/0",
        pqcFloorsPending: true,
        qbitRecoveryState: {
          version: 1,
          status: 'seed-only-restored',
          acknowledgement: 'required',
          addressDiscoveryComplete: true,
        } as any,
      })
      expect(coin1Keyring.getQbitRecoveryState()).toMatchObject({
        networks: {
          mainnet: { addressDiscoveryComplete: false },
          testnet4: { status: 'seed-only-restored', addressDiscoveryComplete: false },
          regtest: { status: 'seed-only-restored', addressDiscoveryComplete: false },
        },
      })
    })

    it('collapses sibling statuses into the effective status for the derived coin type', async () => {
      const { keyring } = await createRestoredQbitService()
      expect(keyring.effectiveQbitRecoveryStatus()).toBe('seed-only-restored')

      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      expect(keyring.effectiveQbitRecoveryStatus()).toBe('migrating')
      expect(keyring.effectiveQbitRecoveryStatus('regtest')).toBe('migrating')
      expect(keyring.effectiveQbitRecoveryStatus('testnet4')).toBe('seed-only-restored')
      // A network of the other coin type was never derived by these keys.
      expect(keyring.effectiveQbitRecoveryStatus('mainnet')).toBe('seed-only-restored')

      keyring.markQbitRecoveryMigrated('regtest')
      // One archived sibling does not make the shared keys read-only.
      expect(keyring.effectiveQbitRecoveryStatus()).toBe('seed-only-restored')

      keyring.beginQbitRecoveryMigration('testnet4', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-testnet4-destination',
        network: 'testnet4',
      })
      keyring.completeQbitRecoveryAddressDiscovery('testnet4')
      keyring.markQbitRecoveryMigrated('testnet4')
      expect(keyring.effectiveQbitRecoveryStatus()).toBe('migrated')

      keyring.changeHdPath("m/87'/0'/0'/0")
      expect(keyring.effectiveQbitRecoveryStatus()).toBe('seed-only-restored')
      expect(keyring.effectiveQbitRecoveryStatus('regtest')).toBe('seed-only-restored')
    })

    it('preserves 1:1 plan bindings and drops plans with invalid destination indexes', async () => {
      const { keyring, pubkey } = await createRestoredQbitService()
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      const structuredPlan = {
        id: `${pubkey}:0`,
        sourcePubkey: pubkey,
        sourceAddress: 'qbit-regtest-source',
        destinationAddress: 'qbit-regtest-destination-3',
        amount: 98_000,
        fee: 2_000,
        psbtHex: 'aa'.repeat(40),
        status: 'prepared' as const,
        sourceIndex: 3,
        destinationIndex: 3,
        destinationPubkey: 'EE'.repeat(32),
      }
      keyring.replaceQbitRecoveryMigrationPlans('regtest', [structuredPlan])

      const roundTripped = new QbitHdKeyring()
      await roundTripped.deserialize(await keyring.serialize())
      expect(
        roundTripped.getQbitRecoveryState()!.networks.regtest!.migration!.plans[0]
      ).toMatchObject({
        sourceIndex: 3,
        destinationIndex: 3,
        destinationPubkey: 'ee'.repeat(32),
      })

      const corrupted = await roundTripped.serialize()
      ;(corrupted.qbitRecoveryState as any).networks.regtest.migration.plans[0].destinationIndex =
        -1
      const normalized = new QbitHdKeyring()
      await normalized.deserialize(corrupted)
      expect(normalized.getQbitRecoveryState()!.networks.regtest!.migration).toMatchObject({
        plans: [],
        planRecordIncomplete: true,
      })
    })

    it('marks migration destination indexes as issued without changing the receive intent', async () => {
      const keyring = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/1'/0'/0",
      })

      expect(keyring.markQbitReceiveIndexesIssued('regtest', [1, 3])).toBe(true)
      expect(keyring.getQbitReceiveState('regtest')).toMatchObject({
        currentIndex: null,
        issuedIndexes: [1, 3],
      })
      expect(keyring.activeIndexes).toEqual([0, 1, 3])
      // The sibling network's ledger is untouched.
      expect(keyring.getQbitReceiveState('testnet4').issuedIndexes).toEqual([])
      // Idempotent for already-issued active indexes.
      expect(keyring.markQbitReceiveIndexesIssued('regtest', [1])).toBe(false)
    })

    it('reuses the recorded destination wallet for a second network migration', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService()
      const freshMnemonic = await service.generatePreMnemonic()
      const created = await service.createQbitMigrationKeyring({
        sourceAddress: pubkey,
        mnemonic: freshMnemonic,
        hdPath: "m/87'/1'/0'/0",
        passphrase: '',
        network: 'regtest',
      })
      await service.markQbitRecoveryMigrated(pubkey, 'regtest')

      // The archived sibling advertises its destination for reuse.
      await expect(service.getQbitRecoveryState(pubkey, 'testnet4')).resolves.toMatchObject({
        status: 'seed-only-restored',
        migrationDestinationReusable: true,
      })
      await expect(service.getQbitRecoveryState(pubkey, 'regtest')).resolves.toMatchObject({
        status: 'migrated',
        otherNetworksPendingRecovery: true,
      })

      const destination = service.keyrings[created.destinationKeyringIndex] as QbitHdKeyring
      const anchor = await destination.getQbitReceiveAccount(0)
      const begun = await service.beginQbitRecoveryMigrationToExistingDestination({
        sourceAddress: pubkey,
        network: 'testnet4',
        destinationPubkey: anchor.pubkey,
        destinationAddress: anchor.addresses.testnet4,
      })
      expect(begun.destinationKeyringIndex).toBe(created.destinationKeyringIndex)
      await expect(service.getQbitRecoveryState(pubkey, 'testnet4')).resolves.toMatchObject({
        status: 'migrating',
        migration: {
          destinationKeyringIndex: created.destinationKeyringIndex,
          destinationAddress: anchor.addresses.testnet4,
        },
      })
      // The archived network's record is untouched by the sibling migration.
      await expect(service.getQbitRecoveryState(pubkey, 'regtest')).resolves.toMatchObject({
        status: 'migrated',
        migration: { destinationAddress: created.destinationAddress },
      })
      expect(keyring.getQbitRecoveryState()!.networks.testnet4!.migration!.network).toBe(
        'testnet4'
      )
    })

    it('refuses to reuse a restored or unknown keyring as a migration destination', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService()
      const [sourceAnchor] = await keyring.getQbitAccounts()

      // Pointing the reuse path at the restored source itself must fail.
      await expect(
        service.beginQbitRecoveryMigrationToExistingDestination({
          sourceAddress: pubkey,
          network: 'testnet4',
          destinationPubkey: sourceAnchor!.pubkey,
          destinationAddress: sourceAnchor!.addresses.testnet4,
        })
      ).rejects.toThrow('destination is unavailable')

      // An identity no keyring carries must fail too.
      await expect(
        service.beginQbitRecoveryMigrationToExistingDestination({
          sourceAddress: pubkey,
          network: 'testnet4',
          destinationPubkey: 'ff'.repeat(32),
          destinationAddress: 'qbit-testnet4-missing',
        })
      ).rejects.toThrow('destination is unavailable')
      await expect(service.getQbitRecoveryState(pubkey, 'testnet4')).resolves.toMatchObject({
        status: 'seed-only-restored',
      })
    })

    it('projects display snapshots onto the resolved active network', async () => {
      const { service, keyring, pubkey } = await createRestoredQbitService()
      keyring.beginQbitRecoveryMigration('regtest', {
        destinationKeyringIndex: 1,
        destinationPubkey: 'ff'.repeat(32),
        destinationAddress: 'qbit-regtest-destination',
        network: 'regtest',
      })
      await service.markQbitRecoveryMigrated(pubkey, 'regtest')

      // Without a resolver the collapsed sibling status cannot represent the
      // partially migrated coin type: it reads seed-only-restored and drops
      // the archived network's hints.
      const collapsed = await service.getAllDisplayedKeyrings(true)
      expect(collapsed[0]!.keyring.qbitRecovery).toMatchObject({ status: 'seed-only-restored' })
      expect(collapsed[0]!.keyring.qbitRecovery!.otherNetworksPendingRecovery).toBeUndefined()

      // With the archived network active, the snapshot matches the
      // network-scoped authoritative state the home card later refreshes to.
      let activeNetwork: string | undefined = 'regtest'
      service.setActiveQbitNetworkResolver(() => activeNetwork)
      const archived = await service.getAllDisplayedKeyrings()
      expect(archived[0]!.keyring.qbitRecovery).toMatchObject({
        status: 'migrated',
        otherNetworksPendingRecovery: true,
      })

      // A network switch between same-path siblings changes no keyring, so
      // only the network-keyed cache can invalidate the snapshot.
      activeNetwork = 'testnet4'
      const pending = await service.getAllDisplayedKeyrings()
      expect(pending[0]!.keyring.qbitRecovery).toMatchObject({
        status: 'seed-only-restored',
        migrationDestinationReusable: true,
      })

      // Unknown values and resolver failures degrade to the collapsed
      // projection instead of breaking the keyring list.
      activeNetwork = 'bogus'
      const invalid = await service.getAllDisplayedKeyrings()
      expect(invalid[0]!.keyring.qbitRecovery).toMatchObject({ status: 'seed-only-restored' })
      expect(invalid[0]!.keyring.qbitRecovery!.otherNetworksPendingRecovery).toBeUndefined()
      service.setActiveQbitNetworkResolver(() => {
        throw new Error('preferences unavailable')
      })
      const failed = await service.getAllDisplayedKeyrings(true)
      expect(failed[0]!.keyring.qbitRecovery).toMatchObject({ status: 'seed-only-restored' })
    })
  })

  describe('hardware-wallet gating (D5)', () => {
    it('rejects adding new cold-wallet keyrings but still revives persisted vault entries', async () => {
      const { service } = await createUnlockedQbitService()
      const coldWallet = new ColdWalletKeyring({
        xpub: 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz',
        addresses: ['bc1qexample'],
        publicKeys: ['02'.padEnd(66, 'a')],
      })

      await expect(service.addKeyring(coldWallet as any, AddressType.P2WPKH)).rejects.toThrow(
        'hardware_wallet_not_supported'
      )

      // Persisted vaults must still unlock: the class stays registered and
      // deserializes through the restore path.
      const revived = await service._restoreKeyring({
        type: coldWallet.type,
        data: await coldWallet.serialize(),
        addressType: AddressType.P2WPKH,
      })
      expect(revived.keyring.type).toBe(coldWallet.type)
      expect(await revived.keyring.getAccounts()).toHaveLength(1)
    })
  })

  describe('restore floor gate (pqcFloorsPending)', () => {
    it('refuses counter reservations while floors are pending and allows them after the scan', async () => {
      const keyring = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0, 1],
        hdPath: "m/87'/1'/0'/0",
        pqcFloorsPending: true,
      })
      const accounts = await keyring.getQbitAccounts()

      await expect(
        keyring.assertPqcSignatureCounterAvailable(accounts[0]!.pubkey)
      ).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })
      await expect(keyring.reservePqcSignatureCounter(accounts[0]!.pubkey)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })

      // Floor application itself must remain allowed while the gate is on.
      await keyring.applyPqcSignatureCounterFloor(accounts[0]!.pubkey, 3)
      expect(await keyring.getPqcSignatureCounter(accounts[0]!.pubkey)).toBe(3)

      const scan = await keyring.scanPqcSignatureCounterFloors(
        account => ({ observedSignatures: account.pubkey === accounts[0]!.pubkey ? 5 : 0 }),
        { lookahead: 0 }
      )
      expect(scan.floors).toHaveLength(2)
      expect(keyring.pqcFloorsPending).toBe(false)

      const reservation = await keyring.reservePqcSignatureCounter(accounts[0]!.pubkey)
      expect(reservation).toMatchObject({ previousCounter: 5, newCounter: 6 })
    })

    it('keeps the gate closed when the floor scan fails', async () => {
      const keyring = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/1'/0'/0",
        pqcFloorsPending: true,
      })
      const [account] = await keyring.getQbitAccounts()

      await expect(
        keyring.scanPqcSignatureCounterFloors(() => {
          throw new Error('esplora unreachable')
        })
      ).rejects.toThrow('esplora unreachable')

      expect(keyring.pqcFloorsPending).toBe(true)
      await expect(keyring.reservePqcSignatureCounter(account!.pubkey)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })
    })

    it('re-arms the gate when a restored keyring re-derives on another network path', async () => {
      const restored = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/0'/0'/0",
        pqcFloorsPending: true,
      })
      await restored.scanPqcSignatureCounterFloors(() => ({ observedSignatures: 0 }), {
        lookahead: 0,
      })
      expect(restored.pqcFloorsPending).toBe(false)

      // Mainnet -> testnet4 path switch re-derives keys whose floors were never observed.
      restored.changeHdPath("m/87'/1'/0'/0")
      expect(restored.pqcFloorsPending).toBe(true)
      const [account] = await restored.getQbitAccounts()
      await expect(restored.reservePqcSignatureCounter(account!.pubkey)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })

      // Same-path no-op must not re-arm; fresh (non-restored) keyrings never re-arm.
      await restored.scanPqcSignatureCounterFloors(() => ({ observedSignatures: 0 }), {
        lookahead: 0,
      })
      restored.changeHdPath("m/87'/1'/0'/0")
      expect(restored.pqcFloorsPending).toBe(false)

      const fresh = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/0'/0'/0",
      })
      fresh.changeHdPath("m/87'/1'/0'/0")
      expect(fresh.pqcFloorsPending).toBe(false)
    })

    it('re-arms and persists restored floors without changing the HD path', async () => {
      const { service, keyring, storage, pubkey } = await createRestoredQbitService()
      expect(keyring.pqcFloorsPending).toBe(false)

      await expect(service.rearmQbitRestoreFloors()).resolves.toBe(true)

      expect(keyring.pqcFloorsPending).toBe(true)
      expect(vaultPayload(storage)[0].data.pqcFloorsPending).toBe(true)
      await expect(keyring.reservePqcSignatureCounter(pubkey)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })
      await expect(service.rearmQbitRestoreFloors()).resolves.toBe(false)

      await service.setLocked()
      const relaunched = new KeyringService()
      await relaunched.init({
        storage,
        encryptor: new JsonEncryptor(),
        logger: testLogger(),
        t: (key: string) => key,
      })
      await relaunched.submitPassword('password')
      expect(relaunched.keyrings[0]?.pqcFloorsPending).toBe(true)
    })

    it('re-arms and persists floors for the single keyring owning an address', async () => {
      const { service, keyring, storage, pubkey } = await createRestoredQbitService()
      expect(keyring.pqcFloorsPending).toBe(false)

      await expect(service.rearmQbitRestoreFloorsForKeyring(pubkey)).resolves.toBe(true)

      expect(keyring.pqcFloorsPending).toBe(true)
      expect(vaultPayload(storage)[0].data.pqcFloorsPending).toBe(true)
      await expect(keyring.reservePqcSignatureCounter(pubkey)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })
      await expect(service.rearmQbitRestoreFloorsForKeyring(pubkey)).resolves.toBe(false)
    })

    it('fails preflight for fully cached batches while floors are pending', async () => {
      const { service, keyring } = await createUnlockedQbitService()
      const [pubkey0] = await service.getAccounts()

      await service.signPqcDigestWithCounter(pubkey0!, DIGEST_A, async () =>
        dummyPqcSignature(0xaa)
      )
      ;(keyring as any).pqcFloorsPending = true
      await expect(service.preflightP2mrMessageSigning(pubkey0!, [DIGEST_A])).rejects.toMatchObject(
        { code: 'PQC_FLOORS_PENDING' }
      )
      ;(keyring as any).pqcFloorsPending = false
      await expect(service.preflightP2mrMessageSigning(pubkey0!, [DIGEST_A])).resolves.toEqual({
        required: 0,
        cached: 1,
        remainingBefore: PQC_MAX_SIGNATURES - 1,
        remainingAfter: PQC_MAX_SIGNATURES - 1,
        limit: PQC_MAX_SIGNATURES,
      })
    })

    it('latches the concurrent-instance hint across scans and serialization', async () => {
      const keyring = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/1'/0'/0",
        pqcFloorsPending: true,
      })
      expect(keyring.pqcConcurrentInstanceHint).toBe(false)

      await keyring.scanPqcSignatureCounterFloors(
        account => ({ observedSignatures: 0, hasActivity: account.hkdf.index === 2 }),
        { lookahead: 5 }
      )
      expect(keyring.pqcConcurrentInstanceHint).toBe(true)

      // A later clean scan must not erase the recorded hazard.
      await keyring.scanPqcSignatureCounterFloors(() => ({ observedSignatures: 0 }), {
        lookahead: 5,
      })
      expect(keyring.pqcConcurrentInstanceHint).toBe(true)

      const revived = new QbitHdKeyring(await keyring.serialize())
      expect(revived.pqcConcurrentInstanceHint).toBe(true)
    })

    it('round-trips the pending gate through serialize/deserialize', async () => {
      const pending = new QbitHdKeyring({
        mnemonic: sampleMnemonic,
        activeIndexes: [0],
        hdPath: "m/87'/1'/0'/0",
        pqcFloorsPending: true,
      })
      const revived = new QbitHdKeyring(await pending.serialize())
      expect(revived.pqcFloorsPending).toBe(true)

      await revived.scanPqcSignatureCounterFloors(() => ({ observedSignatures: 0 }), {
        lookahead: 0,
      })
      const settled = new QbitHdKeyring(await revived.serialize())
      expect(settled.pqcFloorsPending).toBe(false)
    })

    it('re-closes the in-memory gate when the post-scan vault persist fails', async () => {
      const storage = new MemoryStorage()
      const service = new KeyringService()
      await service.init({
        storage,
        encryptor: new JsonEncryptor(),
        logger: testLogger(),
        t: (key: string) => key,
      })
      await service.boot('password')
      await service.createKeyringWithMnemonics(
        sampleMnemonic,
        "m/87'/1'/0'/0",
        '',
        AddressType.P2MR,
        1,
        false,
        { pqcFloorsPending: true }
      )
      const [pubkey0] = await service.getAccounts()

      storage.failSetKeys.add('keyringState')
      await expect(
        service.restorePqcSignatureCounterFloors(pubkey0!, () => ({ observedSignatures: 2 }), {
          lookahead: 0,
        })
      ).rejects.toThrow('forced storage failure')

      // The vault still says pending, so memory must too: signing stays refused.
      expect(service.keyrings[0]!.pqcFloorsPending).toBe(true)
      await expect(service.reservePqcSignatureCounter(pubkey0!)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })

      storage.failSetKeys.delete('keyringState')
      await service.restorePqcSignatureCounterFloors(pubkey0!, () => ({ observedSignatures: 2 }), {
        lookahead: 0,
      })
      expect(service.keyrings[0]!.pqcFloorsPending).toBe(false)
      await expect(service.reservePqcSignatureCounter(pubkey0!)).resolves.toMatchObject({
        previousCounter: 2,
        newCounter: 3,
      })
    })

    it('refuses cached signatures while floors are pending', async () => {
      const { service, keyring } = await createUnlockedQbitService()
      const [pubkey0] = await service.getAccounts()

      // Populate the deterministic signature cache through a normal sign.
      const first = await service.signPqcDigestWithCounter(pubkey0!, DIGEST_A, async () =>
        dummyPqcSignature(0xaa)
      )
      expect(first.cached).toBe(false)
      ;(keyring as any).pqcFloorsPending = true
      await expect(
        service.signPqcDigestWithCounter(pubkey0!, DIGEST_A, async () => dummyPqcSignature(0xaa))
      ).rejects.toMatchObject({ code: 'PQC_FLOORS_PENDING' })

      // Lifting the gate restores the cached fast path without a new increment.
      ;(keyring as any).pqcFloorsPending = false
      const again = await service.signPqcDigestWithCounter(pubkey0!, DIGEST_A, async () =>
        dummyPqcSignature(0xaa)
      )
      expect(again.cached).toBe(true)
      expect(await service.getPqcSignatureCounter(pubkey0!)).toBe(1)
    })

    it('persists the gate through the service vault and unlocks signing only after restore floors', async () => {
      const storage = new MemoryStorage()
      const service = new KeyringService()
      await service.init({
        storage,
        encryptor: new JsonEncryptor(),
        logger: testLogger(),
        t: (key: string) => key,
      })
      await service.boot('password')
      await service.createKeyringWithMnemonics(
        sampleMnemonic,
        "m/87'/1'/0'/0",
        '',
        AddressType.P2MR,
        2,
        false,
        { pqcFloorsPending: true }
      )
      const [pubkey0] = await service.getAccounts()
      expect(vaultPayload(storage)[0].data.pqcFloorsPending).toBe(true)

      await expect(service.reservePqcSignatureCounter(pubkey0!)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })

      // Simulate a crash before the floor scan: a fresh service from the same
      // vault must come back up with the gate still closed.
      await service.setLocked()
      const relaunched = new KeyringService()
      await relaunched.init({
        storage,
        encryptor: new JsonEncryptor(),
        logger: testLogger(),
        t: (key: string) => key,
      })
      await relaunched.submitPassword('password')
      await expect(relaunched.reservePqcSignatureCounter(pubkey0!)).rejects.toMatchObject({
        code: 'PQC_FLOORS_PENDING',
      })

      const scan = await relaunched.restorePqcSignatureCounterFloors(
        pubkey0!,
        account => ({ observedSignatures: account.pubkey === pubkey0 ? 4 : 0 }),
        { lookahead: 0 }
      )
      expect(scan.floors.find(floor => floor.pubkey === pubkey0)).toMatchObject({
        newCounter: 4,
        counterProvenance: 'restored-floor',
      })
      expect(vaultPayload(storage)[0].data.pqcFloorsPending).toBe(false)

      // 'restored-floor' provenance and the open gate survive a full lock/unlock cycle.
      await relaunched.setLocked()
      const reopened = new KeyringService()
      await reopened.init({
        storage,
        encryptor: new JsonEncryptor(),
        logger: testLogger(),
        t: (key: string) => key,
      })
      await reopened.submitPassword('password')
      const displayed = await reopened.getAllDisplayedKeyrings()
      const restoredAccount = displayed
        .flatMap(item => item.accounts as any[])
        .find(account => account.pubkey === pubkey0)
      expect(restoredAccount?.keyring?.signatureCounter).toMatchObject({
        count: 4,
        provenance: 'restored-floor',
      })
      await expect(reopened.reservePqcSignatureCounter(pubkey0!)).resolves.toMatchObject({
        previousCounter: 4,
        newCounter: 5,
      })
    })
  })
})
