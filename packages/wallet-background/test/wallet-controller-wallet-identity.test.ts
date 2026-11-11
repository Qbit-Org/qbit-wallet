import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { BUS_EVENTS, BUS_METHODS, WALLET_COLOR_KEYS, walletColorForSlot } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import { preferenceService } from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'
import { discoverQbitActiveIndexes } from '../src/utils/qbit-api'
import {
  RELEASES,
  readReleaseStorage,
} from '../../../tests/fixtures/release-storage/release-storage'

// The keyrings as the keyring service keeps them: one per slot, in the order
// they were added, with an empty keyring in the slot of each removed wallet.
// The rest of the background, the preferences included, is the real one.
const keyrings = vi.hoisted(() => {
  type FakeKeyring = {
    type: string
    addressType: number
    accounts: string[]
    getAccounts(): Promise<string[]>
  }
  const QBIT_HD = 'Qbit HD Key Tree'
  const P2MR = 9
  const live: FakeKeyring[] = []
  let ids = 0
  // Additions wait here, after the keyring is in its slot, as a real
  // addition waits for its vault write.
  let additionGate: Promise<void> = Promise.resolve()

  const keyring = (type: string, addressType: number, accounts: string[]): FakeKeyring => ({
    type,
    addressType,
    accounts,
    getAccounts: async () => accounts,
  })
  const nextId = () => (++ids).toString(16).padStart(2, '0').repeat(32)
  const add = async (added: FakeKeyring) => {
    live.push(added)
    await additionGate
    return added
  }
  const p2mrMetadata = (id: string) => ({
    pubkey: id,
    path: "m/87'/0'/0'/0/0",
    scriptPubKey: `5220${id}`,
    leafScript: `20${id}b3`,
    addresses: {
      mainnet: `qb1z${id.slice(0, 16)}`,
      testnet4: `tq1z${id.slice(0, 16)}`,
      signet: `tq1z${id.slice(0, 16)}`,
      regtest: `qbrt1z${id.slice(0, 16)}`,
    },
    hkdf: { account: 0, change: 0, index: 0 },
    signatureCounter: { count: 0, limit: 1073741824, remaining: 1073741824, state: 'normal' },
  })
  const display = (shown: FakeKeyring, index: number) => {
    if (shown.type === QBIT_HD) {
      return {
        type: shown.type,
        index,
        addressType: shown.addressType,
        keyring: { hdPath: "m/87'/0'/0'/0" },
        accounts: shown.accounts.map(id => ({
          pubkey: id,
          brandName: shown.type,
          keyring: p2mrMetadata(id),
        })),
      }
    }
    return {
      type: shown.type,
      index,
      addressType: shown.addressType,
      keyring: {},
      // A watch-only keyring lists addresses, every other one public keys.
      accounts: shown.accounts.map(pubkey => ({ pubkey, brandName: shown.type })),
    }
  }

  const service = {
    keyrings: live,
    memStore: { getState: () => ({ isUnlocked: true }) },
    getAllDisplayedKeyrings: vi.fn(async () =>
      live.map((shown, index) => display(shown, index))
    ),
    displayForKeyring: vi.fn(async (shown: FakeKeyring, _addressType: number, index: number) =>
      display(shown, index)
    ),
    createKeyringWithMnemonics: vi.fn(
      async (_mnemonic: string, _hdPath: string, _passphrase: string, addressType: number) =>
        add(keyring(addressType === P2MR ? QBIT_HD : 'HD Key Tree', addressType, [nextId()]))
    ),
    // A keyring a screen shows before adding it, or a restore scans.
    createTmpKeyring: vi.fn((type: string, accounts: unknown) =>
      Array.isArray(accounts)
        ? keyring(type, 0, accounts)
        : {
            ...keyring(type, P2MR, []),
            activeAccounts: vi.fn(),
            getQbitAccounts: vi.fn(async () => []),
          }
    ),
    addDiscoveredQbitKeyring: vi.fn(async () => add(keyring(QBIT_HD, P2MR, [nextId()]))),
    importPublicKeyOnly: vi.fn(async (pubkey: string, addressType: number) =>
      add(keyring('Readonly', addressType, [pubkey]))
    ),
    importWatchAddress: vi.fn(async (address: string, addressType: number) =>
      add(keyring('Watch Address', addressType, [address]))
    ),
    createQbitMigrationKeyring: vi.fn(async () => {
      const id = nextId()
      const destination = await add(keyring(QBIT_HD, P2MR, [id]))
      return {
        destinationKeyringIndex: live.indexOf(destination),
        destinationPubkey: id,
        destinationAddress: p2mrMetadata(id).addresses.mainnet,
      }
    }),
    addNewAccount: vi.fn(async (shown: FakeKeyring) => {
      shown.accounts.push(nextId())
      return shown.accounts
    }),
    removeKeyring: vi.fn(async (index: number) => {
      live[index] = keyring('Empty', 0, [])
    }),
    removePreMnemonics: vi.fn(),
    getQbitRecoveryVaultState: vi.fn(async () => undefined),
    getQbitRecoveryState: vi.fn(async () => ({
      status: 'migrating',
      acknowledgement: 'accepted',
      counterConfidence: 'local',
      knownOnChainSignatures: 0,
    })),
  }

  return {
    service,
    live,
    keyring,
    nextId,
    holdAdditions(gate: Promise<void>) {
      additionGate = gate
    },
    reset() {
      live.length = 0
      ids = 0
      additionGate = Promise.resolve()
    },
  }
})

vi.mock('../src/services', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services')>()),
  keyringService: keyrings.service,
}))

vi.mock('../src/utils/qbit-api', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/utils/qbit-api')>()),
  discoverQbitActiveIndexes: vi.fn(),
}))

// Keeps what was written as JSON, like chrome.storage.local.
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
// Public keys of the secp256k1 points G and 2G, not anyone's wallet.
const READONLY_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const OTHER_READONLY_PUBKEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
// A Qbit mainnet address nobody holds the key to.
const WATCH_ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'
const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

let adapter: DiskAdapter
let wallet: WalletController

/** What the preferences hold, as they would be saved. */
const stored = () => {
  const saved = JSON.parse(JSON.stringify((preferenceService as any).store))
  return { names: saved.keyringAlianNames, colors: saved.keyringColors }
}

async function loadPreferences(preference?: Record<string, unknown>) {
  if (preference) {
    adapter.disk.set('preference', JSON.stringify(preference))
  }
  await preferenceService.init({ storage: adapter as any, logger })
}

/** A wallet an earlier build created, straight into its slot. */
function existingWallet(type: string, accounts: string[], addressType = AddressType.P2WPKH) {
  keyrings.live.push(keyrings.keyring(type, addressType, accounts))
}

const createWallet = () =>
  wallet.createKeyringWithMnemonics(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR, 1)

async function namesAndColors() {
  return (await wallet.getKeyrings()).map(({ index, alianName, color }) => ({
    index,
    alianName,
    color,
  }))
}

beforeEach(async () => {
  vi.clearAllMocks()
  keyrings.reset()
  adapter = new DiskAdapter()
  await loadPreferences()
  wallet = new WalletController()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.mocked(discoverQbitActiveIndexes).mockResolvedValue({
    activeIndexes: [],
    highestActiveIndex: -1,
    scannedCount: 20,
    truncated: false,
  } as any)
  vi.spyOn(wallet as any, 'performQbitRestoreFloorScan').mockResolvedValue({
    possibleConcurrentInstance: false,
  })
  vi.spyOn(wallet, 'getQbitRestoreFloorsPending').mockResolvedValue(false)
})

describe('default wallet names', () => {
  it('names every wallet a path adds "Wallet N", N counting the wallets once it is added', async () => {
    await createWallet()
    await wallet.restoreQbitKeyringWithFloors(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR)
    await wallet.createKeyringWithPublicKey(READONLY_PUBKEY, AddressType.P2WPKH)
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    // The fresh wallet a recovery migration of the restored wallet creates.
    await wallet.createQbitRecoveryMigrationWallet({
      sourceKeyringIndex: 1,
      mnemonic: MNEMONIC,
      hdPath: "m/87'/0'/0'/0",
      passphrase: '',
    })

    expect(keyrings.live.map(keyring => keyring.type)).toEqual([
      KeyringType.QbitHdKeyring,
      KeyringType.QbitHdKeyring,
      KeyringType.ReadonlyKeyring,
      KeyringType.WatchAddressKeyring,
      KeyringType.QbitHdKeyring,
    ])
    expect(await namesAndColors()).toEqual([
      { index: 0, alianName: 'Wallet 1', color: WALLET_COLOR_KEYS[0] },
      { index: 1, alianName: 'Wallet 2', color: WALLET_COLOR_KEYS[1] },
      { index: 2, alianName: 'Wallet 3', color: WALLET_COLOR_KEYS[2] },
      { index: 3, alianName: 'Wallet 4', color: WALLET_COLOR_KEYS[3] },
      { index: 4, alianName: 'Wallet 5', color: WALLET_COLOR_KEYS[4] },
    ])
    // Stored when each wallet was added, not on a later read.
    expect(stored()).toEqual({
      names: {
        keyring_0: 'Wallet 1',
        keyring_1: 'Wallet 2',
        keyring_2: 'Wallet 3',
        keyring_3: 'Wallet 4',
        keyring_4: 'Wallet 5',
      },
      colors: {
        keyring_0: WALLET_COLOR_KEYS[0],
        keyring_1: WALLET_COLOR_KEYS[1],
        keyring_2: WALLET_COLOR_KEYS[2],
        keyring_3: WALLET_COLOR_KEYS[3],
        keyring_4: WALLET_COLOR_KEYS[4],
      },
    })
  })

  it('selects the wallet it adds, by the name it stored', async () => {
    await createWallet()
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)

    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    expect(await wallet.getCurrentKeyring()).toMatchObject({
      index: 1,
      alianName: 'Wallet 2',
      color: WALLET_COLOR_KEYS[1],
    })
  })

  it('does not count removed wallets, while colors follow the slot', async () => {
    await createWallet()
    await createWallet()
    const [first, second] = (await wallet.getKeyrings()) as any[]
    await wallet.setKeyringAlianName(second, 'Savings')

    await wallet.removeKeyring(first)
    await createWallet()

    expect(await namesAndColors()).toEqual([
      { index: 1, alianName: 'Savings', color: WALLET_COLOR_KEYS[1] },
      { index: 2, alianName: 'Wallet 2', color: WALLET_COLOR_KEYS[2] },
    ])
  })

  it("goes up past a number another wallet's name uses", async () => {
    await createWallet()
    const [first] = (await wallet.getKeyrings()) as any[]
    await wallet.setKeyringAlianName(first, '  wallet 2 ')

    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    expect((await namesAndColors())[1]!.alianName).toBe('Wallet 3')

    // After a removal the count can land on a number in use too.
    const [, second] = (await wallet.getKeyrings()) as any[]
    await wallet.setKeyringAlianName(second, 'Wallet 4')
    await wallet.removeKeyring(first)
    await createWallet()
    await createWallet()
    expect((await namesAndColors()).map(keyring => keyring.alianName)).toEqual([
      'Wallet 4',
      'Wallet 2',
      'Wallet 3',
    ])
  })

  it('names a read-only wallet as the user typed it', async () => {
    await wallet.createKeyringWithPublicKey(READONLY_PUBKEY, AddressType.P2WPKH, ' Cold storage ')
    // A name of spaces only, or none at all over the UI port, is no name.
    await wallet.createKeyringWithPublicKey(OTHER_READONLY_PUBKEY, AddressType.P2WPKH, '   ')
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)

    expect((await namesAndColors()).map(keyring => keyring.alianName)).toEqual([
      'Cold storage',
      'Wallet 2',
      'Wallet 3',
    ])
  })

  it('gives two wallets added back to back their own slot, name and color', async () => {
    let release!: () => void
    keyrings.holdAdditions(new Promise<void>(resolve => (release = resolve)))

    const adding = Promise.all([
      wallet.createKeyringWithAddress(WATCH_ADDRESS),
      wallet.createKeyringWithPublicKey(READONLY_PUBKEY, AddressType.P2WPKH),
    ])
    await vi.waitFor(() => expect(keyrings.live).toHaveLength(2))
    release()
    await adding

    // Each addition stored its own wallet's name and color.
    expect(stored()).toEqual({
      names: { keyring_0: 'Wallet 1', keyring_1: 'Wallet 2' },
      colors: { keyring_0: WALLET_COLOR_KEYS[0], keyring_1: WALLET_COLOR_KEYS[1] },
    })
    expect(await namesAndColors()).toEqual([
      { index: 0, alianName: 'Wallet 1', color: WALLET_COLOR_KEYS[0] },
      { index: 1, alianName: 'Wallet 2', color: WALLET_COLOR_KEYS[1] },
    ])
  })

  it('replaces a name and a color left under a new wallet\'s key', async () => {
    // A reset that cleared the wallets but not the preferences.
    await loadPreferences({
      keyringAlianNames: { keyring_0: 'Qbit HD Wallet #1' },
      keyringColors: { keyring_0: 'pink' },
    })

    await createWallet()

    expect(await namesAndColors()).toEqual([
      { index: 0, alianName: 'Wallet 1', color: WALLET_COLOR_KEYS[0] },
    ])
  })
})

describe('names an earlier build stored', () => {
  it('keeps them, and names a new wallet past them', async () => {
    const keyringAlianNames = { keyring_0: 'Qbit HD Wallet #1', keyring_1: 'Readonly #2' }
    await loadPreferences({ keyringAlianNames })
    existingWallet(KeyringType.QbitHdKeyring, [keyrings.nextId()], AddressType.P2MR)
    existingWallet(KeyringType.ReadonlyKeyring, [READONLY_PUBKEY])

    expect(await namesAndColors()).toEqual([
      { index: 0, alianName: 'Qbit HD Wallet #1', color: WALLET_COLOR_KEYS[0] },
      { index: 1, alianName: 'Readonly #2', color: WALLET_COLOR_KEYS[1] },
    ])
    expect(stored()).toEqual({ names: keyringAlianNames, colors: {} })

    await createWallet()
    expect(stored().names).toEqual({ ...keyringAlianNames, keyring_2: 'Wallet 3' })
  })

  it('names a wallet that has no stored name by its place, once', async () => {
    await loadPreferences({
      keyringAlianNames: { keyring_0: 'Qbit HD Wallet #1', keyring_2: 'Wallet 2' },
    })
    existingWallet(KeyringType.QbitHdKeyring, [keyrings.nextId()], AddressType.P2MR)
    existingWallet(KeyringType.ReadonlyKeyring, [READONLY_PUBKEY])
    existingWallet(KeyringType.WatchAddressKeyring, [WATCH_ADDRESS])
    const setName = vi.spyOn(preferenceService, 'setKeyringAlianName')

    const [first, second] = await Promise.all([wallet.getKeyrings(), wallet.getKeyrings()])
    const third = await wallet.getKeyrings()

    for (const listed of [first, second, third]) {
      expect(listed.map(keyring => keyring.alianName)).toEqual([
        'Qbit HD Wallet #1',
        'Wallet 3',
        'Wallet 2',
      ])
    }
    expect(setName).toHaveBeenCalledExactlyOnceWith('keyring_1', 'Wallet 3')
    // A name, but no color: that stays the slot's.
    expect(stored().colors).toEqual({})
  })

  it('names a corrupted wallet by the same rule, and a type this build does not ship by its label', async () => {
    existingWallet(KeyringType.ReadonlyKeyring, ['aa'.repeat(32)])
    existingWallet('Other Key Type', [])

    const listed = await wallet.getKeyrings()

    expect(listed).toMatchObject([
      { index: 0, isCorrupted: true, alianName: 'Wallet 1', color: WALLET_COLOR_KEYS[0] },
      {
        index: 1,
        isCorrupted: true,
        alianName: 'Unsupported Wallet #2',
        color: WALLET_COLOR_KEYS[1],
      },
    ])
    expect(stored().names).toEqual({
      keyring_0: 'Wallet 1',
      keyring_1: 'Unsupported Wallet #2',
    })
  })

  it('does not name a wallet whose slot a lock emptied while the wallets were read', async () => {
    existingWallet(KeyringType.WatchAddressKeyring, [WATCH_ADDRESS])
    const unlocked = [...keyrings.live]
    const read = keyrings.service.getAllDisplayedKeyrings.getMockImplementation()!
    keyrings.service.getAllDisplayedKeyrings.mockImplementationOnce(async () => {
      const displayed = await read()
      keyrings.live.length = 0
      return displayed
    })

    const listed = await wallet.getKeyrings()

    expect(listed.map(keyring => keyring.alianName)).toEqual(['Wallet 1'])
    expect(stored().names).toEqual({})

    keyrings.live.push(...unlocked)
    expect((await namesAndColors())[0]!.alianName).toBe('Wallet 1')
    expect(stored().names).toEqual({ keyring_0: 'Wallet 1' })
  })

  it('keeps names and colors across a lock, an unlock and a restart', async () => {
    await createWallet()
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    const [, watch] = (await wallet.getKeyrings()) as any[]
    await wallet.setKeyringColor(watch, 'gold')
    const before = await namesAndColors()

    const unlocked = [...keyrings.live]
    keyrings.live.length = 0
    expect(await wallet.getKeyrings()).toEqual([])
    keyrings.live.push(...unlocked)
    expect(await namesAndColors()).toEqual(before)

    await preferenceService.persist()
    await loadPreferences()
    wallet = new WalletController()
    expect(await namesAndColors()).toEqual(before)
    expect(before.map(keyring => keyring.color)).toEqual([WALLET_COLOR_KEYS[0], 'gold'])
  })
})

describe.each(RELEASES)('wallets stored by %s', release => {
  it('keep their names, show their slot colors, and get nothing written', async () => {
    const dump = readReleaseStorage(release)
    const before = structuredClone(dump.storage['preference']) as Record<string, any>
    await loadPreferences(before)
    for (const keyring of dump.wallet.keyrings) {
      existingWallet(
        keyring.type,
        keyring.accounts.map(account => account.pubkey),
        keyring.addressType
      )
    }
    const setName = vi.spyOn(preferenceService, 'setKeyringAlianName')
    const setColor = vi.spyOn(preferenceService, 'setKeyringColor')

    const listed = await wallet.getKeyrings()

    expect(listed.map(({ alianName, color }) => ({ alianName, color }))).toEqual(
      dump.wallet.keyrings.map((keyring, index) => ({
        alianName: keyring.alianName,
        color: walletColorForSlot(index),
      }))
    )
    listed.forEach((keyring, index) => {
      expect(keyring.accounts.map(account => account.alianName)).toEqual(
        dump.wallet.keyrings[index]!.accounts.map(account => account.alianName)
      )
    })
    expect(setName).not.toHaveBeenCalled()
    expect(setColor).not.toHaveBeenCalled()
    expect(stored()).toEqual({ names: before['keyringAlianNames'], colors: {} })

    // A wallet added next is named and colored by the rule, past them.
    await createWallet()
    expect((await namesAndColors())[dump.wallet.keyrings.length]).toEqual({
      index: dump.wallet.keyrings.length,
      alianName: `Wallet ${dump.wallet.keyrings.length + 1}`,
      color: walletColorForSlot(dump.wallet.keyrings.length),
    })
  })
})

describe('renaming a wallet', () => {
  it('stores the name and returns the wallet with it', async () => {
    await createWallet()
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    const [, second] = (await wallet.getKeyrings()) as any[]

    expect(await wallet.setKeyringAlianName(second, 'Travel')).toEqual({
      ...second,
      alianName: 'Travel',
    })

    expect((await namesAndColors()).map(keyring => keyring.alianName)).toEqual([
      'Wallet 1',
      'Travel',
    ])
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an object', { name: 'Travel' }],
    ['an empty string', ''],
    ['spaces only', '   '],
  ])('refuses %s as a name and stores nothing', async (_label, name) => {
    await createWallet()
    const [first] = (await wallet.getKeyrings()) as any[]
    const before = stored()

    await expect(wallet.setKeyringAlianName(first, name as any)).rejects.toThrow(
      'Invalid wallet name'
    )

    expect(stored()).toEqual(before)
  })

  it('refuses a rename that arrives after another window removed the wallet', async () => {
    await createWallet()
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    const [, second] = (await wallet.getKeyrings()) as any[]

    await wallet.removeKeyring(second)
    const afterRemoval = stored()
    expect(afterRemoval.names).toEqual({ keyring_0: 'Wallet 1' })

    await expect(wallet.setKeyringAlianName(second, 'Travel')).rejects.toThrow(
      'The selected wallet is no longer available'
    )
    // The removal's cleanup stands: no name is stored for the empty slot.
    expect(stored()).toEqual(afterRemoval)
  })

  it('refuses a wallet that is malformed or not added, and stores nothing', async () => {
    await createWallet()
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    const [first] = (await wallet.getKeyrings()) as any[]
    const before = stored()

    for (const keyring of [
      null,
      undefined,
      'keyring_0',
      { ...first, index: undefined },
      { ...first, index: -1, key: 'keyring_-1' },
      { ...first, index: 0.5, key: 'keyring_0.5' },
      { ...first, key: 'keyring_1' },
      { ...first, type: undefined },
    ]) {
      await expect(
        wallet.setKeyringAlianName(keyring as any, 'Travel'),
        String(keyring)
      ).rejects.toThrow('Unknown wallet')
    }
    for (const keyring of [
      { ...first, index: 7, key: 'keyring_7' },
      { ...first, type: KeyringType.WatchAddressKeyring },
    ]) {
      await expect(wallet.setKeyringAlianName(keyring, 'Travel')).rejects.toThrow(
        'The selected wallet is no longer available'
      )
    }
    expect(stored()).toEqual(before)
  })

  it('renames a corrupted wallet, whatever made it corrupted', async () => {
    // A wallet that lists no account, one whose public key is not one, and
    // one of a type this build does not ship: each stays in its slot.
    existingWallet(KeyringType.HdKeyring, [])
    existingWallet(KeyringType.ReadonlyKeyring, ['aa'.repeat(32)])
    existingWallet('Other Key Type', [])
    const listed = (await wallet.getKeyrings()) as any[]
    expect(listed.map(keyring => keyring.isCorrupted)).toEqual([true, true, true])

    for (const [slot, keyring] of listed.entries()) {
      expect(await wallet.setKeyringAlianName(keyring, `Old keys ${slot + 1}`)).toMatchObject({
        key: keyring.key,
        alianName: `Old keys ${slot + 1}`,
      })
    }

    expect(stored().names).toEqual({
      keyring_0: 'Old keys 1',
      keyring_1: 'Old keys 2',
      keyring_2: 'Old keys 3',
    })
    expect((await wallet.getKeyrings()).map(keyring => keyring.alianName)).toEqual([
      'Old keys 1',
      'Old keys 2',
      'Old keys 3',
    ])
  })

  it('keeps the name and the color that came in last when an earlier change reads the wallets slowly', async () => {
    await createWallet()
    const [first] = (await wallet.getKeyrings()) as any[]
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const read = keyrings.service.getAllDisplayedKeyrings.getMockImplementation()!
    keyrings.service.getAllDisplayedKeyrings.mockImplementationOnce(async () => {
      await gate
      return read()
    })

    const changes = [
      wallet.setKeyringAlianName(first, 'Travel'),
      wallet.setKeyringAlianName(first, 'Savings'),
      wallet.setKeyringColor(first, 'pink'),
      wallet.setKeyringColor(first, 'gold'),
    ]
    release()
    await Promise.all(changes)

    expect(stored()).toMatchObject({
      names: { keyring_0: 'Savings' },
      colors: { keyring_0: 'gold' },
    })
  })
})

describe('wallet colors', () => {
  it('shows a wallet without a stored color its slot color, wrapping, and writes none', async () => {
    const slots = WALLET_COLOR_KEYS.length + 2
    for (let slot = 0; slot < slots; slot++) {
      existingWallet(KeyringType.WatchAddressKeyring, [`${WATCH_ADDRESS}${slot}`])
    }
    const setColor = vi.spyOn(preferenceService, 'setKeyringColor')

    const listed = await namesAndColors()

    expect(listed.map(keyring => keyring.color)).toEqual(
      Array.from({ length: slots }, (_value, slot) => walletColorForSlot(slot))
    )
    expect(listed[WALLET_COLOR_KEYS.length]!.color).toBe(WALLET_COLOR_KEYS[0])
    expect(setColor).not.toHaveBeenCalled()
    expect(stored().colors).toEqual({})
  })

  it('shows the slot color for a stored key that is not in the palette, and keeps it stored', async () => {
    const keyringColors = { keyring_0: 'crimson', keyring_1: 42, keyring_2: 'teal' }
    await loadPreferences({ keyringColors })
    existingWallet(KeyringType.WatchAddressKeyring, [`${WATCH_ADDRESS}0`])
    existingWallet(KeyringType.WatchAddressKeyring, [`${WATCH_ADDRESS}1`])
    existingWallet(KeyringType.WatchAddressKeyring, [`${WATCH_ADDRESS}2`])

    expect((await namesAndColors()).map(keyring => keyring.color)).toEqual([
      walletColorForSlot(0),
      walletColorForSlot(1),
      'teal',
    ])
    expect(stored().colors).toEqual(keyringColors)
  })

  it('carries a palette key on every wallet the background returns', async () => {
    await createWallet()
    existingWallet(KeyringType.ReadonlyKeyring, ['aa'.repeat(32)])
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    await wallet.setKeyringColor(((await wallet.getKeyrings()) as any[])[2], 'violet')

    const listed = (await wallet.getKeyrings()) as any[]
    expect(listed.map(keyring => keyring.color)).toEqual([
      walletColorForSlot(0),
      walletColorForSlot(1),
      'violet',
    ])
    expect(listed[1].isCorrupted).toBe(true)
    expect((await wallet.getCurrentKeyring())?.color).toBe('violet')
    expect((await wallet.getEditingKeyring()).color).toBe(walletColorForSlot(0))
    expect(await wallet.setKeyringAlianName(listed[2], 'Renamed')).toMatchObject({
      alianName: 'Renamed',
      color: 'violet',
    })
    // A wallet shown before it is added, as the restore screens do.
    const preview = await wallet.createTmpKeyringWithAddress(WATCH_ADDRESS)
    expect(WALLET_COLOR_KEYS).toContain(preview.color)
    expect(stored().colors).toEqual({ keyring_0: WALLET_COLOR_KEYS[0], keyring_2: 'violet' })
  })

  it('sets a color the user picks', async () => {
    await createWallet()
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    const [first, second] = (await wallet.getKeyrings()) as any[]

    expect(await wallet.setKeyringColor(second, 'pink')).toEqual({ ...second, color: 'pink' })
    expect(await wallet.setKeyringColor(first, 'indigo')).toMatchObject({
      key: 'keyring_0',
      color: 'indigo',
    })

    expect((await namesAndColors()).map(keyring => keyring.color)).toEqual(['indigo', 'pink'])
    expect(stored().colors).toEqual({ keyring_0: 'indigo', keyring_1: 'pink' })
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an object', { color: 'pink' }],
    ['an unknown key', 'crimson'],
    ['a key in another case', 'Pink'],
    ['a color value', '#1ab453'],
    ['an inherited name', 'toString'],
  ])('refuses %s as a color and stores nothing', async (_label, color) => {
    await createWallet()
    const [first] = (await wallet.getKeyrings()) as any[]
    const before = stored()

    await expect(wallet.setKeyringColor(first, color as any)).rejects.toThrow(
      'Unknown wallet color'
    )

    expect(stored()).toEqual(before)
  })

  it('refuses a wallet that is malformed, not added or removed, and stores nothing', async () => {
    await createWallet()
    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    const [first, second] = (await wallet.getKeyrings()) as any[]
    const before = stored()

    for (const keyring of [
      null,
      undefined,
      'keyring_0',
      { ...first, index: undefined },
      { ...first, index: -1, key: 'keyring_-1' },
      { ...first, index: 0.5, key: 'keyring_0.5' },
      { ...first, key: 'keyring_1' },
      { ...first, type: undefined },
    ]) {
      await expect(wallet.setKeyringColor(keyring as any, 'pink'), String(keyring)).rejects.toThrow(
        'Unknown wallet'
      )
    }
    for (const keyring of [
      { ...first, index: 7, key: 'keyring_7' },
      { ...first, type: KeyringType.WatchAddressKeyring },
    ]) {
      await expect(wallet.setKeyringColor(keyring, 'pink')).rejects.toThrow(
        'The selected wallet is no longer available'
      )
    }
    expect(stored()).toEqual(before)

    await wallet.removeKeyring(second)
    const afterRemoval = stored()
    await expect(wallet.setKeyringColor(second, 'pink')).rejects.toThrow(
      'The selected wallet is no longer available'
    )
    expect(stored()).toEqual(afterRemoval)
  })

  it("forgets a removed wallet's name and color, and a later wallet takes neither", async () => {
    await createWallet()
    await createWallet()
    const [first, second] = (await wallet.getKeyrings()) as any[]
    await wallet.setKeyringColor(second, 'pink')
    await wallet.setKeyringAlianName(second, 'Spending')

    await wallet.removeKeyring(second)
    expect(stored()).toEqual({
      names: { keyring_0: 'Wallet 1' },
      colors: { keyring_0: WALLET_COLOR_KEYS[0] },
    })

    await wallet.createKeyringWithAddress(WATCH_ADDRESS)
    expect(await namesAndColors()).toEqual([
      { index: 0, alianName: first.alianName, color: WALLET_COLOR_KEYS[0] },
      { index: 2, alianName: 'Wallet 2', color: WALLET_COLOR_KEYS[2] },
    ])
  })
})

describe('adding an account to a wallet that is not current', () => {
  it('derives the account on the wallet picked and selects it under the name given', async () => {
    await createWallet()
    await createWallet()
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    const [picked] = (await wallet.getKeyrings()) as any[]
    const announced: any[] = []
    const record = ({ method, params }: { method: string; params: any }) => {
      if (method === BUS_METHODS.ACCOUNTS_CHANGED) announced.push(params)
    }
    bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, record)

    try {
      await expect(wallet.deriveNewAccountFromMnemonic(picked, 'Spending')).resolves.toEqual({
        floorScanPending: false,
      })
    } finally {
      bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, record)
    }

    expect(keyrings.live[0]!.accounts).toHaveLength(2)
    expect(keyrings.live[1]!.accounts).toHaveLength(1)
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(await wallet.getCurrentAccount()).toMatchObject({
      key: 'keyring_0#1',
      alianName: 'Spending',
    })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_0#1', alianName: 'Spending' })])
    expect(await wallet.getCurrentKeyring()).toMatchObject({
      index: 0,
      alianName: 'Wallet 1',
      color: WALLET_COLOR_KEYS[0],
    })
  })

  it('names the account it derived even when a switch elsewhere lands meanwhile', async () => {
    await createWallet()
    await createWallet()
    const [picked, other] = (await wallet.getKeyrings()) as any[]
    const selectKeyring = (wallet as any).selectKeyring
    vi.spyOn(wallet as any, 'selectKeyring').mockImplementation(async (...args: unknown[]) => {
      await selectKeyring(...args)
      // Another window selects the other wallet right after.
      preferenceService.setCurrentKeyringIndex(other.index)
      preferenceService.setCurrentAccount(other.accounts[0])
    })

    await wallet.deriveNewAccountFromMnemonic(picked, 'Spending')

    expect(preferenceService.getAccountAlianName('keyring_0#1')).toBe('Spending')
    expect(preferenceService.getAccountAlianName('keyring_1#0')).toBe('Account 1')
  })
})
