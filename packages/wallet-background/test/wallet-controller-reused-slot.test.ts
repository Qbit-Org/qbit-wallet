import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { init as initPqc } from '@qbit-oss/pqc'
import type { QbitHdKeyring } from '@qbit/keyring-service/qbit-hd-keyring'
import { KeyringType } from '@qbit/keyring-service/types'
import type { WalletKeyring } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService } from '../src/services'

// A page keeps the wallets it read until it reads them again, and a slot can
// come to hold another wallet meanwhile: an addition whose save fails gives
// its slot back, as the fresh wallet of a recovery migration whose save fails
// does, so the next wallet added takes that slot; and a reset empties every
// slot. These run the real keyring service and preferences, over memory
// storage.

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const WRITE_FAILED = 'storage write failed'

// The keyring service's storage. It can hold the writes of a vault of a given
// number of keyrings open, then fail them, and every such write after them
// until told to stop: the keyring service writes each vault twice, from its
// store's subscriber and then for the change, one after the other.
class MemoryStorage {
  readonly values = new Map<string, any>()
  private failing: { keyrings: number; started: () => void; outcome: Promise<void> } | undefined

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    const failing = this.failing
    if (
      key === 'keyringState' &&
      failing &&
      value?.vault &&
      JSON.parse(value.vault).data.length === failing.keyrings
    ) {
      failing.started()
      await failing.outcome
    }
    this.values.set(key, value)
  }

  failVaultWritesOf(keyrings: number) {
    const started = deferred()
    let fail!: () => void
    const outcome = new Promise<void>((_resolve, reject) => {
      fail = () => reject(new Error(WRITE_FAILED))
    })
    // Only the writes it holds wait on it.
    outcome.catch(() => {})
    this.failing = { keyrings, started: started.resolve, outcome }
    return {
      started: started.promise,
      fail,
      stop: () => {
        this.failing = undefined
      },
    }
  }
}

class JsonEncryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

// The preferences' storage, which keeps what was written as JSON.
class DiskAdapter {
  disk = new Map<string, string>()

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    return { ...structuredClone(template), ...(await this.get(name)) }
  }

  async get(key: string): Promise<any> {
    const raw = this.disk.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: any): Promise<void> {
    this.disk.set(key, JSON.stringify(value))
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const PASSWORD = 'password'
const NO_LONGER_AVAILABLE = 'The selected wallet is no longer available'
const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const THIRD_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const FOURTH_MNEMONIC =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'
const HD_PATH = "m/84'/0'/0'/0"
const QBIT_PATH = "m/87'/0'/0'/0"

let storage: MemoryStorage
let wallet: WalletController

const createWallet = (mnemonic: string) =>
  wallet.createKeyringWithMnemonics(mnemonic, HD_PATH, '', AddressType.P2WPKH, 1)

// The wallets a staging adds: HD Key Tree wallets, or Qbit HD wallets on
// P2MR, the only wallets with P2MR descriptors to export.
type WalletKind = {
  create: (mnemonic: string) => Promise<unknown>
  /** Adds a wallet that lists no account. */
  addCorrupted: (mnemonic: string) => Promise<unknown>
}

const HD_WALLETS: WalletKind = {
  create: createWallet,
  addCorrupted: mnemonic =>
    keyringService.addNewKeyring(
      KeyringType.HdKeyring,
      { mnemonic, activeIndexes: [], hdPath: HD_PATH },
      AddressType.P2WPKH
    ),
}

const QBIT_HD_WALLETS: WalletKind = {
  create: mnemonic =>
    wallet.createKeyringWithMnemonics(mnemonic, QBIT_PATH, '', AddressType.P2MR, 1),
  addCorrupted: mnemonic =>
    keyringService.addNewKeyring(
      KeyringType.QbitHdKeyring,
      { mnemonic, activeIndexes: [], hdPath: QBIT_PATH },
      AddressType.P2MR
    ),
}

/** The P2MR descriptors of the Qbit HD wallet of `phrase`, on mainnet, the network selected here. */
const descriptorsOf = (phrase: string) =>
  keyringService
    .createTmpKeyring(KeyringType.QbitHdKeyring, {
      mnemonic: phrase,
      activeIndexes: [],
      hdPath: QBIT_PATH,
    })
    .exportP2mrDescriptors!('mainnet')

/** The wallets as a page holds them: read, then carried over the UI port as JSON. */
const readByPage = async (): Promise<WalletKeyring[]> =>
  JSON.parse(JSON.stringify(await wallet.getKeyrings()))

/** The names and colors the preferences hold. */
const stored = () => {
  const saved = JSON.parse(JSON.stringify((preferenceService as any).store))
  return { names: saved.keyringAlianNames, colors: saved.keyringColors }
}

/** A call's outcome as a promise, whether it throws or rejects. */
const attempt = (call: () => unknown): Promise<unknown> => Promise.resolve().then(call)

beforeAll(async () => {
  await initPqc()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  await preferenceService.init({ storage: new DiskAdapter() as any, logger })
  storage = new MemoryStorage()
  await keyringService.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger,
    t: (key: string) => key,
    eventBus: { emit: vi.fn() } as any,
  })
  await keyringService.boot(PASSWORD)
  wallet = new WalletController()
})

// What a staging leaves: the page's copy of a wallet that is gone, the page's
// copy, read again, of the wallet that took its slot, and that wallet's phrase.
type Staged = { stale: WalletKeyring; current: WalletKeyring; phrase: string }

async function additionWhoseSaveFailed(kind = HD_WALLETS): Promise<Staged> {
  await kind.create(MNEMONIC)
  const write = storage.failVaultWritesOf(2)
  const adding = kind.create(OTHER_MNEMONIC)
  await write.started
  // A page reads the wallets while the addition is saved.
  const [, stale] = await readByPage()
  write.fail()
  await expect(adding).rejects.toThrow(WRITE_FAILED)
  write.stop()

  // The next wallet added takes the slot the failed one gave back.
  await kind.create(THIRD_MNEMONIC)
  const [, current] = await readByPage()
  return { stale: stale!, current: current!, phrase: THIRD_MNEMONIC }
}

async function migrationWalletWhoseSaveFailed(): Promise<Staged> {
  const source = keyringService.createTmpKeyring(KeyringType.QbitHdKeyring, {
    mnemonic: MNEMONIC,
    activeIndexes: [0],
    hdPath: QBIT_PATH,
  })
  await keyringService.addDiscoveredQbitKeyring(source, 1, true, 'mainnet')
  const [pubkey] = await source.getAccounts()
  await keyringService.restorePqcSignatureCounterFloors(
    pubkey!,
    () => ({ observedSignatures: 3 }),
    { lookahead: 0 }
  )
  const freshMnemonic = await keyringService.generatePreMnemonic()
  const write = storage.failVaultWritesOf(2)
  const migrating = keyringService.createQbitMigrationKeyring({
    sourceAddress: pubkey!,
    mnemonic: freshMnemonic,
    hdPath: QBIT_PATH,
    passphrase: '',
    network: 'mainnet',
  })
  await write.started
  const [, stale] = await readByPage()
  write.fail()
  await expect(migrating).rejects.toThrow(WRITE_FAILED)
  write.stop()

  await wallet.createKeyringWithMnemonics(THIRD_MNEMONIC, QBIT_PATH, '', AddressType.P2MR, 1)
  const [, current] = await readByPage()
  return { stale: stale!, current: current!, phrase: THIRD_MNEMONIC }
}

async function resetThenNewWallets(kind = HD_WALLETS): Promise<Staged> {
  await kind.create(MNEMONIC)
  await kind.create(OTHER_MNEMONIC)
  const [, stale] = await readByPage()

  await keyringService.resetAllData()
  await keyringService.boot(PASSWORD)
  await kind.create(FOURTH_MNEMONIC)
  await kind.create(THIRD_MNEMONIC)
  const [, current] = await readByPage()
  return { stale: stale!, current: current!, phrase: THIRD_MNEMONIC }
}

async function resetOfCorruptedWalletThenNewWallets(kind = HD_WALLETS): Promise<Staged> {
  await kind.create(MNEMONIC)
  await kind.addCorrupted(OTHER_MNEMONIC)
  const [, stale] = await readByPage()
  expect(stale).toMatchObject({ isCorrupted: true, accounts: [] })

  await keyringService.resetAllData()
  await keyringService.boot(PASSWORD)
  await kind.create(FOURTH_MNEMONIC)
  await kind.create(THIRD_MNEMONIC)
  const [, current] = await readByPage()
  return { stale: stale!, current: current!, phrase: THIRD_MNEMONIC }
}

const operations: [string, (keyring: WalletKeyring) => unknown][] = [
  ['the recovery phrase', keyring => wallet.getMnemonics(PASSWORD, keyring)],
  ['a rename', keyring => wallet.setKeyringAlianName(keyring, 'Savings')],
  ['a color', keyring => wallet.setKeyringColor(keyring, 'pink')],
]

describe.each<[string, () => Promise<Staged>]>([
  ['an addition whose save failed gave its slot to the next wallet', additionWhoseSaveFailed],
  [
    "a recovery migration's fresh wallet whose save failed gave its slot to the next wallet",
    migrationWalletWhoseSaveFailed,
  ],
  ['a reset, after which new wallets took the slots', resetThenNewWallets],
  [
    'a reset, after which a new wallet took the slot of a corrupted one',
    resetOfCorruptedWalletThenNewWallets,
  ],
])('a page that listed a wallet before %s', (_staging, stage) => {
  it.each(operations)(
    'is refused %s for it, and the wallet in the slot now is left as it was',
    async (_operation, run) => {
      const { stale, current, phrase } = await stage()
      // Another wallet of the same type, under the same slot and key.
      expect(current).toMatchObject({ index: stale.index, key: stale.key, type: stale.type })
      expect(current.accounts[0]!.pubkey).not.toBe(stale.accounts[0]?.pubkey)
      const before = stored()

      await expect(attempt(() => run(stale))).rejects.toThrow(NO_LONGER_AVAILABLE)

      expect(stored()).toEqual(before)
      // The page's copy read again names the wallet in the slot now.
      await expect(attempt(() => run(current))).resolves.toBeTruthy()
      await expect(wallet.getMnemonics(PASSWORD, current)).resolves.toMatchObject({
        mnemonic: phrase,
      })
    }
  )
})

it("refuses a copy read before another window changed the wallet's address type, and answers it read again", async () => {
  await createWallet(MNEMONIC)
  const [stale] = await readByPage()
  // The change derives the wallet's accounts again, on the new type's path.
  await keyringService.changeAddressType(0, AddressType.P2TR)
  const [current] = await readByPage()
  expect(current!.accounts[0]!.pubkey).not.toBe(stale!.accounts[0]!.pubkey)
  const before = stored()

  for (const [operation, run] of operations) {
    await expect(
      attempt(() => run(stale!)),
      operation
    ).rejects.toThrow(NO_LONGER_AVAILABLE)
  }
  expect(stored()).toEqual(before)

  await expect(wallet.getMnemonics(PASSWORD, current!)).resolves.toMatchObject({
    mnemonic: MNEMONIC,
  })
  await expect(
    attempt(() => wallet.setKeyringAlianName(current!, 'Savings'))
  ).resolves.toMatchObject({ alianName: 'Savings' })
})

it('answers for a corrupted wallet, whatever made it corrupted: its phrase, a rename and a color', async () => {
  await createWallet(MNEMONIC)
  // A wallet that lists no account.
  await keyringService.addNewKeyring(
    KeyringType.HdKeyring,
    { mnemonic: OTHER_MNEMONIC, activeIndexes: [], hdPath: HD_PATH },
    AddressType.P2WPKH
  )
  // A key tree kept under an address type it cannot show an address for.
  await keyringService.addNewKeyring(
    KeyringType.HdKeyring,
    { mnemonic: THIRD_MNEMONIC, activeIndexes: [0], hdPath: HD_PATH },
    AddressType.P2MR
  )
  // A public key that is not one.
  await keyringService.importPublicKeyOnly('aa'.repeat(32), AddressType.P2WPKH)
  const [, noAccount, noAddress, notAKey] = await readByPage()
  expect([noAccount, noAddress, notAKey]).toMatchObject([
    { isCorrupted: true, corruptedReason: 'No account', accounts: [] },
    { isCorrupted: true, corruptedReason: 'Invalid Public Key', accounts: [] },
    { isCorrupted: true, corruptedReason: 'Invalid Public Key', accounts: [] },
  ])

  await expect(wallet.getMnemonics(PASSWORD, noAccount!)).resolves.toMatchObject({
    mnemonic: OTHER_MNEMONIC,
  })
  await expect(wallet.getMnemonics(PASSWORD, noAddress!)).resolves.toMatchObject({
    mnemonic: THIRD_MNEMONIC,
  })
  await expect(wallet.getMnemonics(PASSWORD, notAKey!)).rejects.toThrow('not_supported')
  for (const [slot, keyring] of [noAccount!, noAddress!, notAKey!].entries()) {
    await expect(
      attempt(() => wallet.setKeyringAlianName(keyring, `Old keys ${slot}`))
    ).resolves.toMatchObject({ key: keyring.key, alianName: `Old keys ${slot}` })
    await expect(attempt(() => wallet.setKeyringColor(keyring, 'gold'))).resolves.toMatchObject({
      key: keyring.key,
      color: 'gold',
    })
  }

  expect(stored()).toMatchObject({
    names: { keyring_1: 'Old keys 0', keyring_2: 'Old keys 1', keyring_3: 'Old keys 2' },
    colors: { keyring_1: 'gold', keyring_2: 'gold', keyring_3: 'gold' },
  })
})

// The export screen reads a Qbit HD wallet's phrase, then its P2MR descriptors,
// with the same copy of the wallet. The descriptors hold the wallet's private
// keys, so they are held to the rule the phrase is.
describe.each<[string, () => Promise<Staged>]>([
  [
    'an addition whose save failed gave its slot to the next wallet',
    () => additionWhoseSaveFailed(QBIT_HD_WALLETS),
  ],
  [
    "a recovery migration's fresh wallet whose save failed gave its slot to the next wallet",
    migrationWalletWhoseSaveFailed,
  ],
  [
    'a reset, after which new wallets took the slots',
    () => resetThenNewWallets(QBIT_HD_WALLETS),
  ],
  [
    'a reset, after which a new wallet took the slot of a corrupted one',
    () => resetOfCorruptedWalletThenNewWallets(QBIT_HD_WALLETS),
  ],
])('a page that listed a Qbit HD wallet before %s', (_staging, stage) => {
  it('is refused its P2MR descriptors, and gets those of the wallet in the slot now once it reads the wallets again', async () => {
    const { stale, current, phrase } = await stage()
    // Another Qbit HD wallet on P2MR, under the same slot and key.
    for (const keyring of [stale, current]) {
      expect(keyring).toMatchObject({
        index: stale.index,
        key: stale.key,
        type: KeyringType.QbitHdKeyring,
        addressType: AddressType.P2MR,
      })
    }

    await expect(wallet.exportP2mrDescriptors(PASSWORD, stale)).rejects.toThrow(NO_LONGER_AVAILABLE)

    await expect(wallet.exportP2mrDescriptors(PASSWORD, current)).resolves.toEqual(
      await descriptorsOf(phrase)
    )
  })
})

it("never answers another wallet's P2MR descriptors after the phrase of the wallet a page named", async () => {
  await QBIT_HD_WALLETS.create(MNEMONIC)
  const write = storage.failVaultWritesOf(2)
  const adding = QBIT_HD_WALLETS.create(OTHER_MNEMONIC)
  await write.started
  // A page lists the wallet while its addition is saved, and the export
  // screen gets its phrase.
  const [, listed] = await readByPage()
  await expect(wallet.getMnemonics(PASSWORD, listed!)).resolves.toMatchObject({
    mnemonic: OTHER_MNEMONIC,
  })
  write.fail()
  await expect(adding).rejects.toThrow(WRITE_FAILED)
  write.stop()
  // The next wallet added takes the slot the failed one gave back before the
  // screen asks for the descriptors, with the same copy.
  await QBIT_HD_WALLETS.create(THIRD_MNEMONIC)

  await expect(wallet.exportP2mrDescriptors(PASSWORD, listed!)).rejects.toThrow(
    NO_LONGER_AVAILABLE
  )
})

it.each<[string, (index: number) => Promise<unknown>]>([
  ['a lock', () => keyringService.setLocked()],
  ['a removal', index => keyringService.removeKeyring(index)],
])('refuses the P2MR descriptors when %s lands while they are read', async (_change, change) => {
  await QBIT_HD_WALLETS.create(MNEMONIC)
  await QBIT_HD_WALLETS.create(OTHER_MNEMONIC)
  const [, listed] = await readByPage()
  const live = keyringService.keyrings[1] as QbitHdKeyring
  const read = live.exportP2mrDescriptors.bind(live)
  const exported = vi.spyOn(live, 'exportP2mrDescriptors').mockImplementation(async network => {
    const descriptors = await read(network)
    await change(1)
    return descriptors
  })

  await expect(wallet.exportP2mrDescriptors(PASSWORD, listed!)).rejects.toThrow(
    NO_LONGER_AVAILABLE
  )
  expect(exported).toHaveBeenCalledTimes(1)
})

it('exports the P2MR descriptors of a corrupted Qbit HD wallet, which lists no account', async () => {
  await QBIT_HD_WALLETS.create(MNEMONIC)
  await QBIT_HD_WALLETS.addCorrupted(OTHER_MNEMONIC)
  const [, corrupted] = await readByPage()
  expect(corrupted).toMatchObject({
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2MR,
    isCorrupted: true,
    accounts: [],
  })

  await expect(wallet.exportP2mrDescriptors(PASSWORD, corrupted!)).resolves.toEqual(
    await descriptorsOf(OTHER_MNEMONIC)
  )
})
