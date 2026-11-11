import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { BUS_EVENTS, BUS_METHODS, SESSION_EVENTS, walletColorForSlot } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import {
  contactBookService,
  keyringService,
  preferenceService,
  sessionService,
} from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'

// The real keyring service and preferences, over memory storage. The keyring
// service's own tests show that an addition whose vault write a lock overtakes
// still saves, and resolves: these show what the controller makes of that.

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

// The keyring service's storage. It can hold the next vault write open, and
// then let it complete, or fail it and every vault write after it.
class MemoryStorage {
  readonly values = new Map<string, any>()
  private held: { started: () => void; settled: Promise<void> } | undefined
  private failure: Error | undefined

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    if (key === 'keyringState' && value?.vault) {
      const held = this.held
      if (held) {
        this.held = undefined
        held.started()
        await held.settled
      }
      if (this.failure) throw this.failure
    }
    this.values.set(key, value)
  }

  holdNextVaultWrite() {
    const started = deferred()
    const settled = deferred()
    this.held = { started: started.resolve, settled: settled.promise }
    return {
      started: started.promise,
      release: settled.resolve,
      fail: (failure: Error) => {
        this.failure = failure
        settled.resolve()
      },
    }
  }
}

// It can hold the next save of the keyrings while they are encrypted, then
// let that save go on, or fail it alone.
class JsonEncryptor {
  private held: { started: () => void; settled: Promise<void>; failure?: Error } | undefined

  async encrypt(password: string, data: any): Promise<string> {
    // A save of the keyrings encrypts their list.
    const held = Array.isArray(data) ? this.held : undefined
    if (held) {
      this.held = undefined
      held.started()
      await held.settled
      if (held.failure) throw held.failure
    }
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }

  holdNextSave() {
    const started = deferred()
    const settled = deferred()
    const held: { started: () => void; settled: Promise<void>; failure?: Error } = {
      started: started.resolve,
      settled: settled.promise,
    }
    this.held = held
    return {
      started: started.promise,
      release: settled.resolve,
      fail: (failure: Error) => {
        held.failure = failure
        settled.resolve()
      },
    }
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
const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const THIRD_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const FOURTH_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const HD_PATH = "m/84'/0'/0'/0"
// The public key of the secp256k1 point G, not anyone's wallet.
const READONLY_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
// A Qbit mainnet address nobody holds the key to.
const WATCH_ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'

let storage: MemoryStorage
let encryptor: JsonEncryptor
let preferences: DiskAdapter
let wallet: WalletController
let announced: unknown[]

const recordAnnouncement = ({ method, params }: { method: string; params: unknown }) => {
  if (method === BUS_METHODS.ACCOUNTS_CHANGED) announced.push(params)
}

const createWallet = (mnemonic = MNEMONIC) =>
  wallet.createKeyringWithMnemonics(mnemonic, HD_PATH, '', AddressType.P2WPKH, 1)

/** The account announced to connected sites, by address, in order. */
const sitesTold = () =>
  vi
    .mocked(sessionService.broadcastEvent)
    .mock.calls.filter(([event]) => event === SESSION_EVENTS.accountsChanged)
    .map(([, accounts]) => accounts)

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  preferences = new DiskAdapter()
  await preferenceService.init({ storage: preferences as any, logger })
  storage = new MemoryStorage()
  encryptor = new JsonEncryptor()
  await keyringService.init({
    storage: storage as any,
    encryptor,
    logger,
    t: (key: string) => key,
    eventBus: { emit: vi.fn() } as any,
  })
  await keyringService.boot(PASSWORD)
  wallet = new WalletController()
  announced = []
  bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, recordAnnouncement)
  vi.spyOn(sessionService, 'broadcastEvent')
})

afterEach(() => {
  bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, recordAnnouncement)
})

describe('a lock that lands while an addition is saved', () => {
  const additions = [
    ['a created wallet', () => createWallet(), KeyringType.HdKeyring],
    [
      'a read-only wallet',
      () => wallet.createKeyringWithPublicKey(READONLY_PUBKEY, AddressType.P2WPKH),
      KeyringType.ReadonlyKeyring,
    ],
    [
      'a watched address',
      () => wallet.createKeyringWithAddress(WATCH_ADDRESS),
      KeyringType.WatchAddressKeyring,
    ],
  ] as const

  it.each(additions)(
    'reports %s as added, and selects and announces nothing while locked',
    async (_name, add, type) => {
      const selection = [
        preferenceService.getCurrentKeyringIndex(),
        preferenceService.getCurrentAccount(),
      ]
      const write = storage.holdNextVaultWrite()
      const adding = add()
      await write.started
      await wallet.lockWallet()
      write.release()

      await expect(adding).resolves.toBeUndefined()
      expect([
        preferenceService.getCurrentKeyringIndex(),
        preferenceService.getCurrentAccount(),
      ]).toEqual(selection)
      expect(announced).toEqual([])
      expect(sitesTold()).toEqual([])
      expect(preferenceService.getShowSafeNotice()).toBe(true)

      // The wallet was saved, once: the password unlocks it.
      await keyringService.submitPassword(PASSWORD)
      expect((await wallet.getKeyrings()).map(keyring => keyring.type)).toEqual([type])
    }
  )

  it('reports the account it derived as derived, and adds one account only', async () => {
    await createWallet()
    const [picked] = (await wallet.getKeyrings()) as any[]
    const selected = preferenceService.getCurrentAccount()
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const write = storage.holdNextVaultWrite()
    const deriving = wallet.deriveNewAccountFromMnemonic(picked, 'Spending')
    await write.started
    await wallet.lockWallet()
    write.release()

    await expect(deriving).resolves.toEqual({ floorScanPending: false })
    expect(preferenceService.getCurrentAccount()).toEqual(selected)
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])

    await keyringService.submitPassword(PASSWORD)
    const [unlocked] = (await wallet.getKeyrings()) as any[]
    expect(unlocked.accounts.map((account: any) => account.alianName)).toEqual([
      'Account 1',
      'Spending',
    ])
  })
})

describe('a lock that lands while the chain is switched', () => {
  it('keeps and saves the switch, and selects nothing while locked', async () => {
    await createWallet()
    const selection = [
      preferenceService.getCurrentKeyringIndex(),
      preferenceService.getCurrentAccount(),
    ]
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    const read = wallet.getCurrentKeyring
    vi.spyOn(wallet, 'getCurrentKeyring').mockImplementationOnce(async () => {
      const keyring = await read()
      await wallet.lockWallet()
      return keyring
    })

    await expect(wallet.setChainType(ChainType.QBIT_TESTNET4)).resolves.toBeUndefined()
    await (wallet as any).chainStateChangeTail

    expect(preferenceService.getChainType()).toBe(ChainType.QBIT_TESTNET4)
    expect((await preferences.get('preference')).chainType).toBe(ChainType.QBIT_TESTNET4)
    expect([
      preferenceService.getCurrentKeyringIndex(),
      preferenceService.getCurrentAccount(),
    ]).toEqual(selection)
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })
})

describe('a switch a page asks for', () => {
  it('is still refused when a lock lands while the wallets are read', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    // The wallets as the page listed them.
    const [first] = (await wallet.getKeyrings()) as any[]
    const selection = [
      preferenceService.getCurrentKeyringIndex(),
      preferenceService.getCurrentAccount(),
    ]
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    const read = keyringService.getAllDisplayedKeyrings
    vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementationOnce(async () => {
      const displayed = await read()
      await wallet.lockWallet()
      return displayed
    })

    await expect(wallet.changeKeyring(first, 0)).rejects.toThrow(
      'The selected wallet is no longer available'
    )
    expect([
      preferenceService.getCurrentKeyringIndex(),
      preferenceService.getCurrentAccount(),
    ]).toEqual(selection)
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })
})

// Another window reads the wallets, and its read takes long enough to finish
// only after a change is in the keyring service: it returns the wallets as
// they were before the change, and must not keep them for the reads after it.
async function holdNextRead(keyringIndex: number) {
  return holdReadOf(keyringIndex, () => wallet.getKeyrings())
}

/**
 * Starts `read`, whose read of the wallets is held, once it has read the
 * accounts of the wallet in slot `keyringIndex`, until it is finished.
 */
async function holdReadOf<T>(keyringIndex: number, read: () => Promise<T>) {
  // The first read after an unlock reads every keyring again.
  await keyringService.setLocked()
  await keyringService.submitPassword(PASSWORD)
  const keyring = keyringService.keyrings[keyringIndex]!
  const accounts = keyring.getAccounts.bind(keyring)
  const gate = deferred()
  vi.spyOn(keyring, 'getAccounts').mockImplementationOnce(async () => {
    const listed = await accounts()
    await gate.promise
    return listed
  })
  const reading = read()
  return {
    async finish() {
      gate.resolve()
      return reading
    },
  }
}

describe('a read of the wallets that started before an addition', () => {
  /** The wallets as a page holds them: they reach the background as JSON. */
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))

  it('lets a page switch to an account derived while that read was under way', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const [first] = await listed()
    const otherWindow = await holdNextRead(0)
    await wallet.deriveNewAccountFromMnemonic(first, 'Spending')
    // A page lists the wallets with the account derived, and switches to the
    // other wallet.
    const [derived, second] = await listed()
    expect(derived.accounts).toHaveLength(2)
    await wallet.changeKeyring(second, 0)
    // Read before the account was added, finished after it.
    expect((await otherWindow.finish())[0]!.accounts).toHaveLength(1)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    // The page switches back, to the account derived.
    await wallet.changeKeyring(derived, 1)

    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: 'keyring_0#1',
      alianName: 'Spending',
    })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_0#1' })])
    expect(sitesTold()).toEqual([[derived.accounts[1].address]])
  })

  it('lets a derived account be selected and announced', async () => {
    await createWallet()
    const [picked] = (await wallet.getKeyrings()) as any[]
    const otherWindow = await holdNextRead(0)
    announced.length = 0

    const write = storage.holdNextVaultWrite()
    const deriving = wallet.deriveNewAccountFromMnemonic(picked, 'Spending')
    await write.started
    // Read before the account was added, finished after.
    expect((await otherWindow.finish())[0]!.accounts).toHaveLength(1)
    write.release()

    await expect(deriving).resolves.toEqual({ floorScanPending: false })
    await expect(keyringService.keyrings[0]!.getAccounts()).resolves.toHaveLength(2)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: 'keyring_0#1',
      alianName: 'Spending',
    })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_0#1' })])
  })

  it('lets a created wallet be selected and announced', async () => {
    await createWallet()
    const otherWindow = await holdNextRead(0)
    announced.length = 0

    const write = storage.holdNextVaultWrite()
    const adding = createWallet(OTHER_MNEMONIC)
    await write.started
    expect(await otherWindow.finish()).toHaveLength(1)
    write.release()

    await expect(adding).resolves.toBeUndefined()
    expect(keyringService.keyrings).toHaveLength(2)
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_1#0' })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_1#0' })])
    expect(preferenceService.getShowSafeNotice()).toBe(true)
  })
})

describe('a read of the current account while an account is derived', () => {
  /** The wallets as a page holds them: they reach the background as JSON. */
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))

  it('answers with the account the derivation selected and announced meanwhile, not the first account', async () => {
    await createWallet()
    const [picked] = await listed()
    await wallet.deriveNewAccountFromMnemonic(picked)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_0#1' })
    // A site's read of its account lists the wallets before a third account
    // is derived, and ends once that account is selected and announced.
    const site = await holdReadOf(0, () => wallet.getCurrentAccount())
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    await wallet.deriveNewAccountFromMnemonic(picked, 'Spending')
    const derived = preferenceService.getCurrentAccount()
    expect(derived).toMatchObject({ key: 'keyring_0#2', alianName: 'Spending' })

    await expect(site.finish()).resolves.toMatchObject({
      key: 'keyring_0#2',
      address: derived!.address,
    })
    expect(preferenceService.getCurrentAccount()).toEqual(derived)
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_0#2' })])
    expect(sitesTold()).toEqual([[derived!.address]])
  })

  it('answers with the first account, and stores nothing, when three reads in a row miss the account stored as current', async () => {
    await createWallet()
    const [picked] = await listed()
    await wallet.deriveNewAccountFromMnemonic(picked)
    // An account the wallet does not hold is stored as current.
    const missing = {
      ...preferenceService.getCurrentAccount()!,
      pubkey: READONLY_PUBKEY,
      key: 'keyring_0#7',
      index: 7,
    }
    preferenceService.setCurrentAccount(missing)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    const reads = vi.spyOn(keyringService, 'getAllDisplayedKeyrings')

    await expect(wallet.getCurrentAccount()).resolves.toMatchObject({ key: 'keyring_0#0' })
    expect(reads).toHaveBeenCalledTimes(3)
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toEqual(missing)
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })
})

describe('a read of the wallets that started before a removal', () => {
  /** The wallets as a page holds them: they reach the background as JSON. */
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))
  const slots = () => keyringService.keyrings.map(keyring => keyring.type)

  // Two wallets, the second one current. The wallet `pick` returns is removed
  // while another window's read of the wallets is held open, and that read
  // settles while the removal is saved, after `whileSaved` has run.
  async function removeWhileAReadIsHeld(
    pick: (wallets: any[]) => any,
    whileSaved: () => Promise<unknown> = async () => undefined
  ) {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const target = pick(await listed())
    const otherWindow = await holdNextRead(1)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const write = storage.holdNextVaultWrite()
    const removing = wallet.removeKeyring(target)
    await write.started
    await whileSaved()
    // Read before the removal, finished after it: that window lists both wallets.
    expect(await otherWindow.finish()).toHaveLength(2)
    write.release()
    return removing
  }

  it('never makes the removed wallet current', async () => {
    const removing = removeWhileAReadIsHeld(([, second]) => second)

    await expect(removing).resolves.toMatchObject({ key: 'keyring_0' })
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.Empty])
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    const first = preferenceService.getCurrentAccount()
    expect(first).toMatchObject({ key: 'keyring_0#0' })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_0#0' })])
    expect(sitesTold()).toEqual([[first!.address]])
  })

  it('keeps the last wallet while the wallets read still list the removed one', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const [, second] = await listed()
    const otherWindow = await holdNextRead(1)
    await wallet.removeKeyring(second)
    // Read before the removal, finished after it: that window still lists the
    // removed wallet.
    const [first, removed] = JSON.parse(JSON.stringify(await otherWindow.finish()))
    expect(removed).toMatchObject({ key: 'keyring_1' })

    await expect(wallet.removeKeyring(first)).rejects.toThrow(
      'removing_the_last_wallet_is_not_allowed'
    )
    await expect(wallet.removeKeyring(removed)).rejects.toThrow(
      'The selected wallet is no longer available'
    )
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.Empty])
  })

  it('lists the removed wallet no more once that read settles', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const [, second] = await listed()
    const otherWindow = await holdNextRead(1)
    await expect(wallet.removeKeyring(second)).resolves.toMatchObject({ key: 'keyring_0' })
    // Read before the removal, finished after it.
    expect(await otherWindow.finish()).toHaveLength(2)

    // The wallets read after it, as the removal popover reads them, and the
    // wallet current.
    expect((await listed()).map(keyring => keyring.key)).toEqual(['keyring_0'])
    await expect(wallet.getCurrentKeyring()).resolves.toMatchObject({ key: 'keyring_0' })
  })

  // The read settles after the lock, so the wallets read after the removal
  // are those before the lock, though every slot is empty now.
  it.each([
    ['another wallet', ([first]: any[]) => first],
    ['the current wallet', ([, second]: any[]) => second],
  ])(
    'returns no wallet, and selects nothing, when a lock lands while removing %s',
    async (_which, pick) => {
      const removing = removeWhileAReadIsHeld(pick, () => wallet.lockWallet())

      await expect(removing).resolves.toBeUndefined()
      expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
      expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_1#0' })
      expect(announced).toEqual([])
      expect(sitesTold()).toEqual([])
    }
  )

  it('keeps a wallet another window created since current, though that read lists the wallets before it', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const [first] = await listed()
    const otherWindow = await holdNextRead(1)
    // Another window creates a third wallet, which becomes current.
    await createWallet(THIRD_MNEMONIC)
    const selected = preferenceService.getCurrentAccount()
    expect(selected).toMatchObject({ key: 'keyring_2#0' })
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const write = storage.holdNextVaultWrite()
    const removing = wallet.removeKeyring(first)
    await write.started
    // Read before the third wallet was created, finished while the first is
    // removed: that window lists the first two wallets, without the third.
    expect(await otherWindow.finish()).toHaveLength(2)
    write.release()

    const kept = await removing
    expect(slots()).toEqual([KeyringType.Empty, KeyringType.HdKeyring, KeyringType.HdKeyring])
    expect(kept).toMatchObject({ key: 'keyring_2', accounts: [{ key: 'keyring_2#0' }] })
    expect(preferenceService.getCurrentKeyringIndex()).toBe(2)
    expect(preferenceService.getCurrentAccount()).toEqual(selected)
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })

  it('returns the current wallet as it is now, not as that read listed it', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const [first, second] = await listed()
    const otherWindow = await holdNextRead(1)
    await wallet.deriveNewAccountFromMnemonic(second, 'Spending')
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const write = storage.holdNextVaultWrite()
    const removing = wallet.removeKeyring(first)
    await write.started
    // Read before the account was added, finished while the first wallet is removed.
    const [, earlier] = await otherWindow.finish()
    expect(earlier!.accounts).toHaveLength(1)
    write.release()

    await expect(removing).resolves.toMatchObject({
      key: 'keyring_1',
      accounts: [{ key: 'keyring_1#0' }, { key: 'keyring_1#1', alianName: 'Spending' }],
    })
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_1#1' })
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })
})

describe('a change another window makes while a removal reads the wallets', () => {
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))

  /**
   * Holds open the first read of the wallets once the first wallet's slot is
   * empty: the one the removal makes once that wallet is gone. Says when it
   * has read them.
   */
  function holdTheReadAfterTheRemoval() {
    const read = keyringService.getAllDisplayedKeyrings
    const started = deferred()
    const gate = deferred()
    vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementation(async resetCache => {
      const displayed = await read(resetCache)
      if (keyringService.keyrings[0]?.type === KeyringType.Empty) {
        vi.mocked(keyringService.getAllDisplayedKeyrings).mockImplementation(read)
        started.resolve()
        await gate.promise
      }
      return displayed
    })
    return { started: started.promise, release: gate.resolve }
  }

  // The wallets made from `mnemonics`, the last one current; the first is
  // removed while `meanwhile` runs, in another window, during that read.
  async function removeTheFirst(
    mnemonics: string[],
    meanwhile: (wallets: any[]) => Promise<unknown>
  ) {
    for (const mnemonic of mnemonics) await createWallet(mnemonic)
    const wallets = await listed()
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    const read = holdTheReadAfterTheRemoval()

    const removing = wallet.removeKeyring(wallets[0])
    await read.started
    await meanwhile(wallets)
    read.release()
    return removing
  }

  it('keeps a wallet created meanwhile current, and returns it', async () => {
    const kept = await removeTheFirst([MNEMONIC, OTHER_MNEMONIC], () =>
      createWallet(THIRD_MNEMONIC)
    )

    expect(kept).toMatchObject({ key: 'keyring_2', accounts: [{ key: 'keyring_2#0' }] })
    expect(preferenceService.getCurrentKeyringIndex()).toBe(2)
    const created = preferenceService.getCurrentAccount()
    expect(created).toMatchObject({ key: 'keyring_2#0' })
    // Only the creation announced an account.
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_2#0' })])
    expect(sitesTold()).toEqual([[created!.address]])
  })

  it('lets a page switch to an account added to the current wallet while the removal read the wallets', async () => {
    for (const mnemonic of [MNEMONIC, OTHER_MNEMONIC]) await createWallet(mnemonic)
    const wallets = await listed()
    // The removal's read once the first wallet's slot is empty waits inside
    // the current wallet's accounts, having read them.
    const read = keyringService.getAllDisplayedKeyrings
    const started = deferred()
    const gate = deferred()
    vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementation(async resetCache => {
      if (keyringService.keyrings[0]?.type === KeyringType.Empty) {
        vi.mocked(keyringService.getAllDisplayedKeyrings).mockImplementation(read)
        const current = keyringService.keyrings[1]!
        const accounts = current.getAccounts.bind(current)
        vi.spyOn(current, 'getAccounts').mockImplementationOnce(async () => {
          const listedAccounts = await accounts()
          started.resolve()
          await gate.promise
          return listedAccounts
        })
      }
      return read(resetCache)
    })

    const removing = wallet.removeKeyring(wallets[0])
    await started.promise
    // Meanwhile the keyring service adds an account to the current wallet, as
    // issuing a receive address in another window does for a Qbit HD wallet.
    await keyringService.addNewAccount(keyringService.keyrings[1]!)
    gate.resolve()
    await expect(removing).resolves.toMatchObject({ key: 'keyring_1' })

    // The wallets read after the removal list the account, and a page that
    // lists them switches to it.
    const [current] = await listed()
    expect(current.accounts).toHaveLength(2)
    await wallet.changeKeyring(current, 1)
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_1#1' })
  })

  it('returns the wallet switched to meanwhile, and selects nothing', async () => {
    const kept = await removeTheFirst(
      [MNEMONIC, OTHER_MNEMONIC, THIRD_MNEMONIC],
      async ([, second]) => {
        await wallet.changeKeyring(second, 0)
      }
    )

    expect(kept).toMatchObject({ key: 'keyring_1' })
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    const switched = preferenceService.getCurrentAccount()
    expect(switched).toMatchObject({ key: 'keyring_1#0' })
    // Only the switch announced an account.
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_1#0' })])
    expect(sitesTold()).toEqual([[switched!.address]])
  })
})

describe('a read of the current account while the current wallet is removed', () => {
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))
  const slots = () => keyringService.keyrings.map(keyring => keyring.type)

  /**
   * Three wallets, the first current. Its removal waits on the vault write,
   * which `whileSaved` holds open: a site asking for its account then reads
   * it the way provider getAccounts does, through getCurrentAccount.
   */
  async function removeTheCurrentWallet<T>(whileSaved: (wallets: any[]) => Promise<T>) {
    for (const mnemonic of [MNEMONIC, OTHER_MNEMONIC, THIRD_MNEMONIC]) await createWallet(mnemonic)
    const wallets = await listed()
    await wallet.changeKeyring(wallets[0], 0)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const write = storage.holdNextVaultWrite()
    const removing = wallet.removeKeyring(wallets[0])
    await write.started
    const seen = await whileSaved(wallets)
    return { removing, write, seen }
  }

  /** A site's read of its account while the removal is saved, and the selection stored then. */
  const readWhileSaved = async () => ({
    reading: wallet.getCurrentAccount(),
    stored: [
      preferenceService.getCurrentKeyringIndex(),
      preferenceService.getCurrentAccount()?.key,
    ],
  })

  /** Whether `promise` has settled once everything ready to run has run. */
  async function settledYet(promise: Promise<unknown>) {
    let settled = false
    promise.then(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    return settled
  }

  it('ends with the last usable wallet current, and tells sites and pages', async () => {
    const { removing, write, seen } = await removeTheCurrentWallet(readWhileSaved)
    // The site's read waits for the removal, and the selection stays as it
    // was until the removal settles it.
    expect(await settledYet(seen.reading)).toBe(false)
    expect(seen.stored).toEqual([0, 'keyring_0#0'])
    write.release()

    await expect(removing).resolves.toMatchObject({ key: 'keyring_2' })
    expect(slots()).toEqual([KeyringType.Empty, KeyringType.HdKeyring, KeyringType.HdKeyring])
    expect(preferenceService.getCurrentKeyringIndex()).toBe(2)
    const last = preferenceService.getCurrentAccount()
    expect(last).toMatchObject({ key: 'keyring_2#0' })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_2#0' })])
    expect(sitesTold()).toEqual([[last!.address]])
    // The site gets the account it was told.
    await expect(seen.reading).resolves.toMatchObject({ key: 'keyring_2#0' })
  })

  it('keeps the wallet it selected when a read that began while it was saved ends after it', async () => {
    let reading: Promise<unknown> | undefined
    const listing = keyringService.getAllDisplayedKeyrings
    const gate = deferred()
    const { removing, write } = await removeTheCurrentWallet(async () => {
      // The read has read the selection, and lists the wallets with the first
      // one gone; it ends once the removal has ended.
      vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementationOnce(
        async resetCache => {
          const displayed = await listing(resetCache)
          await gate.promise
          return displayed
        }
      )
      reading = wallet.getCurrentAccount()
    })
    write.release()
    await expect(removing).resolves.toMatchObject({ key: 'keyring_2' })
    gate.resolve()

    await expect(reading).resolves.toMatchObject({ key: 'keyring_2#0' })
    expect(preferenceService.getCurrentKeyringIndex()).toBe(2)
    const last = preferenceService.getCurrentAccount()
    expect(last).toMatchObject({ key: 'keyring_2#0' })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_2#0' })])
    expect(sitesTold()).toEqual([[last!.address]])
  })

  it('answers with no account, and stores nothing, from a read that began while it was saved and ends after a lock', async () => {
    let reading: Promise<unknown> | undefined
    const listing = keyringService.getAllDisplayedKeyrings
    const gate = deferred()
    const { removing, write } = await removeTheCurrentWallet(async () => {
      vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementationOnce(
        async resetCache => {
          const displayed = await listing(resetCache)
          await gate.promise
          return displayed
        }
      )
      reading = wallet.getCurrentAccount()
      await wallet.lockWallet()
    })
    write.release()
    await expect(removing).resolves.toBeUndefined()
    gate.resolve()
    await expect(reading).resolves.toBeNull()

    // As the wallet locked: the next unlock settles what is current.
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_0#0' })
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })

  it('lets a read waiting for it go when a lock lands while it is saved, with no account', async () => {
    const { removing, write, seen } = await removeTheCurrentWallet(readWhileSaved)
    await wallet.lockWallet()
    expect(await settledYet(seen.reading)).toBe(false)
    write.release()

    await expect(removing).resolves.toBeUndefined()
    await expect(seen.reading).resolves.toBeNull()
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_0#0' })
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })

  it('keeps a wallet a page switched to meanwhile, which announced itself', async () => {
    const { removing, write, seen } = await removeTheCurrentWallet(async wallets => {
      const reading = wallet.getCurrentAccount()
      await wallet.changeKeyring(wallets[1], 0)
      return { reading }
    })
    write.release()

    await expect(removing).resolves.toMatchObject({ key: 'keyring_1' })
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    const switched = preferenceService.getCurrentAccount()
    expect(switched).toMatchObject({ key: 'keyring_1#0' })
    // Only the switch announced an account, and the site's read answers with it.
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_1#0' })])
    expect(sitesTold()).toEqual([[switched!.address]])
    await expect(seen.reading).resolves.toMatchObject({ key: 'keyring_1#0' })
  })

  it('leaves the wallet current when the removal fails, and a read meanwhile answers with its account', async () => {
    const { removing, write, seen } = await removeTheCurrentWallet(readWhileSaved)
    expect(await settledYet(seen.reading)).toBe(false)
    write.fail(new Error('the vault could not be saved'))

    await expect(removing).rejects.toThrow('the vault could not be saved')
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring, KeyringType.HdKeyring])
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    const kept = preferenceService.getCurrentAccount()
    expect(kept).toMatchObject({ key: 'keyring_0#0' })
    await expect(seen.reading).resolves.toMatchObject({ key: 'keyring_0#0' })
    // No read answered with another wallet's account: there is nothing to correct.
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })

  /**
   * Starts a site's read of its account whose read of the wallets is held
   * once it has listed them, until the read is finished.
   */
  function startHeldAccountRead() {
    const listing = keyringService.getAllDisplayedKeyrings
    const gate = deferred()
    vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementationOnce(async resetCache => {
      const displayed = await listing(resetCache)
      await gate.promise
      return displayed
    })
    const reading = wallet.getCurrentAccount()
    return {
      finish() {
        gate.resolve()
        return reading
      },
    }
  }

  it('answers with the wallet still current when a read that began while it was saved ends after the save failed', async () => {
    let site: ReturnType<typeof startHeldAccountRead> | undefined
    const { removing, write } = await removeTheCurrentWallet(async () => {
      // The read lists the wallets with the first one's slot empty.
      site = startHeldAccountRead()
    })
    write.fail(new Error('the vault could not be saved'))
    await expect(removing).rejects.toThrow('the vault could not be saved')

    await expect(site!.finish()).resolves.toMatchObject({ key: 'keyring_0#0' })
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring, KeyringType.HdKeyring])
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_0#0' })
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })

  it('answers with the wallet it selected when a read listed the wallets before it and ends after it', async () => {
    for (const mnemonic of [MNEMONIC, OTHER_MNEMONIC, THIRD_MNEMONIC]) await createWallet(mnemonic)
    const wallets = await listed()
    await wallet.changeKeyring(wallets[0], 0)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    // The read lists the wallets with the first one in its slot.
    const site = startHeldAccountRead()

    await expect(wallet.removeKeyring(wallets[0])).resolves.toMatchObject({ key: 'keyring_2' })
    const last = preferenceService.getCurrentAccount()
    expect(last).toMatchObject({ key: 'keyring_2#0' })
    expect(sitesTold()).toEqual([[last!.address]])

    // It ends after the removal told the site the last wallet's account.
    await expect(site.finish()).resolves.toMatchObject({ key: 'keyring_2#0' })
    expect(preferenceService.getCurrentAccount()).toEqual(last)
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_2#0' })])
    expect(sitesTold()).toEqual([[last!.address]])
  })
})

describe('an address type change while the current wallet is removed', () => {
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))
  const addressTypes = () => [...keyringService.addressTypes]

  // Three wallets, the first current; the third is the last usable one once
  // the first is gone.
  async function threeWalletsOnTheFirst() {
    for (const mnemonic of [MNEMONIC, OTHER_MNEMONIC, THIRD_MNEMONIC]) await createWallet(mnemonic)
    const wallets = await listed()
    await wallet.changeKeyring(wallets[0], 0)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    return wallets
  }

  it('changes the wallet current once the removal has settled it, never the removed slot', async () => {
    const wallets = await threeWalletsOnTheFirst()
    const write = storage.holdNextVaultWrite()
    const removing = wallet.removeKeyring(wallets[0])
    await write.started

    // The first wallet's slot is empty now.
    const changing = wallet.changeAddressType(AddressType.P2TR)
    write.release()

    await expect(removing).resolves.toMatchObject({ key: 'keyring_2' })
    await expect(changing).resolves.toBeUndefined()
    expect(keyringService.keyrings[0]!.type).toBe(KeyringType.Empty)
    expect(addressTypes()).toEqual([AddressType.P2WPKH, AddressType.P2WPKH, AddressType.P2TR])
    const current = await wallet.getCurrentKeyring()
    expect(current).toMatchObject({ key: 'keyring_2', addressType: AddressType.P2TR })
    expect(preferenceService.getCurrentKeyringIndex()).toBe(2)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: 'keyring_2#0',
      address: current!.accounts[0]!.address,
    })
    // The removal told the last wallet's account, and the change its new address.
    expect(sitesTold()).toEqual([[wallets[2].accounts[0].address], [current!.accounts[0]!.address]])
  })

  it('changes the wallet current when it runs, though the removal reached the keyring service first', async () => {
    const wallets = await threeWalletsOnTheFirst()
    // Another window adds a wallet, and holds every change to the wallets
    // while it is saved; the removal waits behind it, its target still in its slot.
    const save = encryptor.holdNextSave()
    const adding = createWallet(FOURTH_MNEMONIC)
    await save.started
    const removal = vi.spyOn(keyringService, 'removeKeyring')
    const removing = wallet.removeKeyring(wallets[0])
    await vi.waitFor(() => expect(removal).toHaveBeenCalled())

    const changing = wallet.changeAddressType(AddressType.P2TR)
    save.release()

    await expect(adding).resolves.toBeUndefined()
    await expect(removing).resolves.toMatchObject({ key: 'keyring_3' })
    await expect(changing).resolves.toBeUndefined()
    expect(keyringService.keyrings[0]!.type).toBe(KeyringType.Empty)
    // The removed slot keeps its address type; the wallet current gets the new one.
    expect(addressTypes()).toEqual([
      AddressType.P2WPKH,
      AddressType.P2WPKH,
      AddressType.P2WPKH,
      AddressType.P2TR,
    ])
    await expect(wallet.getCurrentKeyring()).resolves.toMatchObject({
      key: 'keyring_3',
      addressType: AddressType.P2TR,
    })
  })
})

describe('a switch another window makes while an address type change is under way', () => {
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))
  const addressTypes = () => [...keyringService.addressTypes]

  /**
   * Two wallets: the first, with two accounts, current on its second, and
   * another with `otherAccounts` accounts. The first wallet's address type
   * is changed to P2TR, and while the change is saved a page switches to
   * the other wallet's first account.
   */
  async function switchToTheOtherWhileSaved(otherAccounts: number) {
    await createWallet()
    await wallet.deriveNewAccountFromMnemonic((await listed())[0])
    await createWallet(OTHER_MNEMONIC)
    for (let account = 1; account < otherAccounts; account++) {
      await wallet.deriveNewAccountFromMnemonic((await listed())[1])
    }
    const wallets = await listed()
    await wallet.changeKeyring(wallets[0], 1)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const save = encryptor.holdNextSave()
    const changing = wallet.changeAddressType(AddressType.P2TR)
    await save.started
    await wallet.changeKeyring(wallets[1], 0)
    save.release()
    return { changing, wallets }
  }

  it.each([
    ['has an account at the place of the one current before', 2],
    ['has no account at that place', 1],
  ])(
    'saves the change, and keeps the switch to the other wallet, which %s',
    async (_which, otherAccounts) => {
      const { changing, wallets } = await switchToTheOtherWhileSaved(otherAccounts)

      await expect(changing).resolves.toBeUndefined()
      expect(addressTypes()).toEqual([AddressType.P2TR, AddressType.P2WPKH])
      // The switch stays, and is the only account announced.
      const switched = wallets[1].accounts[0]
      expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
      expect(preferenceService.getCurrentAccount()).toMatchObject({
        key: 'keyring_1#0',
        address: switched.address,
      })
      expect(announced).toEqual([expect.objectContaining({ key: 'keyring_1#0' })])
      expect(sitesTold()).toEqual([[switched.address]])

      // The vault holds the change.
      await keyringService.setLocked()
      await keyringService.submitPassword(PASSWORD)
      expect(addressTypes()).toEqual([AddressType.P2TR, AddressType.P2WPKH])
    }
  )

  it('selects the account a page switched to on the wallet changed, at its place, and tells its new address', async () => {
    await createWallet()
    await wallet.deriveNewAccountFromMnemonic((await listed())[0])
    const [changed] = await listed()
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_0#1' })
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    // A page switches to the first account once the change has read the
    // account current, before the accounts are derived again.
    const change = keyringService.changeAddressType
    vi.spyOn(keyringService, 'changeAddressType').mockImplementationOnce(async (index, type) => {
      await wallet.changeKeyring(changed, 0)
      return change(index, type)
    })

    await expect(wallet.changeAddressType(AddressType.P2TR)).resolves.toBeUndefined()

    const [rederived] = await listed()
    expect(rederived).toMatchObject({ addressType: AddressType.P2TR })
    const first = rederived.accounts[0]
    expect(first.address).not.toBe(changed.accounts[0].address)
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: 'keyring_0#0',
      address: first.address,
    })
    // The switch told its address, then the change the account's new one.
    expect(sitesTold()).toEqual([[changed.accounts[0].address], [first.address]])
  })

  it('keeps the account a page switched to while the change was saved, read with its new address', async () => {
    await createWallet()
    await wallet.deriveNewAccountFromMnemonic((await listed())[0])
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_0#1' })
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const save = encryptor.holdNextSave()
    const changing = wallet.changeAddressType(AddressType.P2TR)
    await save.started
    // A page lists the wallets, the accounts derived again already, and
    // switches to the first account.
    const [rederived] = await listed()
    expect(rederived).toMatchObject({ addressType: AddressType.P2TR })
    await wallet.changeKeyring(rederived, 0)
    save.release()

    await expect(changing).resolves.toBeUndefined()
    const first = rederived.accounts[0]
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: 'keyring_0#0',
      address: first.address,
    })
    // No other account is told.
    expect(sitesTold().length).toBeGreaterThan(0)
    expect(sitesTold()).toEqual(sitesTold().map(() => [first.address]))
  })

  it('saves the change, and selects nothing, when the wallet locks while it is saved', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const wallets = await listed()
    await wallet.changeKeyring(wallets[0], 0)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    const write = storage.holdNextVaultWrite()
    const changing = wallet.changeAddressType(AddressType.P2TR)
    await write.started
    await wallet.lockWallet()
    write.release()

    await expect(changing).resolves.toBeUndefined()
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: 'keyring_0#0',
      address: wallets[0].accounts[0].address,
    })
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
    await keyringService.submitPassword(PASSWORD)
    expect(addressTypes()).toEqual([AddressType.P2TR, AddressType.P2WPKH])
  })
})

describe('an unlock after a lock', () => {
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))
  const slots = () => keyringService.keyrings.map(keyring => keyring.type)

  beforeEach(async () => {
    // An unlock reads the contact book.
    await contactBookService.init({ storage: new DiskAdapter() as any, logger })
  })

  afterEach(() => {
    // The auto-lock an unlock starts.
    clearTimeout(wallet.timer)
  })

  it.each([
    ['', false],
    [', though a site read its account while the wallets loaded', true],
  ])(
    'tells sites and pages the account it makes current, when the lock came while the current wallet was removed%s',
    async (_while, siteReads) => {
      for (const mnemonic of [MNEMONIC, OTHER_MNEMONIC, THIRD_MNEMONIC])
        await createWallet(mnemonic)
      const wallets = await listed()
      await wallet.changeKeyring(wallets[0], 0)
      const write = storage.holdNextVaultWrite()
      const removing = wallet.removeKeyring(wallets[0])
      await write.started
      await wallet.lockWallet()
      write.release()
      await expect(removing).resolves.toBeUndefined()
      // Nothing can be selected while locked: the removed wallet's slot and
      // account, which the sites were last told, stay stored as current. So
      // does a store that an earlier release left the same way.
      expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
      expect(preferenceService.getCurrentAccount()).toMatchObject({
        key: 'keyring_0#0',
        address: wallets[0].accounts[0].address,
      })
      announced.length = 0
      vi.mocked(sessionService.broadcastEvent).mockClear()
      if (siteReads) {
        // The wallets are loaded, and the unlock is about to select from them.
        const submit = keyringService.submitPassword
        vi.spyOn(keyringService, 'submitPassword').mockImplementationOnce((password, options) =>
          submit(password, {
            beforeUnlock: async () => {
              await expect(wallet.getCurrentAccount()).resolves.toMatchObject({
                key: 'keyring_1#0',
              })
              await options?.beforeUnlock?.()
            },
          })
        )
      }

      await wallet.unlock(PASSWORD)

      expect(slots()).toEqual([KeyringType.Empty, KeyringType.HdKeyring, KeyringType.HdKeyring])
      // The first usable wallet, as whenever the wallet stored as current
      // cannot be read.
      expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
      const current = preferenceService.getCurrentAccount()
      expect(current).toMatchObject({ key: 'keyring_1#0' })
      expect(announced).toEqual([expect.objectContaining({ key: 'keyring_1#0' })])
      expect(sitesTold()).toEqual([[current!.address]])
    }
  )

  it('announces nothing when nothing changed while it was locked', async () => {
    for (const mnemonic of [MNEMONIC, OTHER_MNEMONIC]) await createWallet(mnemonic)
    const wallets = await listed()
    await wallet.changeKeyring(wallets[0], 0)
    const selection = [
      preferenceService.getCurrentKeyringIndex(),
      preferenceService.getCurrentAccount(),
    ]
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    await wallet.lockWallet()
    await wallet.unlock(PASSWORD)

    expect([
      preferenceService.getCurrentKeyringIndex(),
      preferenceService.getCurrentAccount(),
    ]).toEqual(selection)
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })
})

describe("a page's copy of a wallet whose phrase was restored again", () => {
  // The wallets as the page listed them; then another window removes the
  // first wallet and restores its phrase, which takes a new slot.
  async function restoreTheFirstAgain() {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const listed = JSON.parse(JSON.stringify(await wallet.getKeyrings()))
    await wallet.removeKeyring(listed[0])
    await createWallet()
    await wallet.changeKeyring(listed[1], 0)
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    return listed
  }

  it('is not switched to: the wallet in the new slot is another wallet', async () => {
    const [removed] = await restoreTheFirstAgain()

    await expect(wallet.changeKeyring(removed, 0)).rejects.toThrow(
      'The selected wallet is no longer available'
    )
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_1#0' })
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])
  })

  it('removes nothing: the wallet in the new slot is another wallet', async () => {
    const [removed] = await restoreTheFirstAgain()

    await expect(wallet.removeKeyring(removed)).rejects.toThrow(
      'The selected wallet is no longer available'
    )
    expect(keyringService.keyrings.map(keyring => keyring.type)).toEqual([
      KeyringType.Empty,
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
    ])
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_1#0' })
  })
})

describe('a removal while another window adds a wallet', () => {
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))
  const slots = () => keyringService.keyrings.map(keyring => keyring.type)

  // One wallet, current; another window adds a second one, whose save is
  // held while the first wallet's removal waits for it.
  async function removeTheOnlyWalletWhileOneIsAdded() {
    await createWallet()
    const [only] = await listed()
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()
    const save = encryptor.holdNextSave()
    const adding = createWallet(OTHER_MNEMONIC)
    await save.started
    const removal = vi.spyOn(keyringService, 'removeKeyring')
    const removing = wallet.removeKeyring(only)
    await vi.waitFor(() => expect(removal).toHaveBeenCalled())
    return { save, adding, removing }
  }

  it('is refused, and the wallet stays, when the wallet being added fails to save', async () => {
    const { save, adding, removing } = await removeTheOnlyWalletWhileOneIsAdded()
    save.fail(new Error('the vault could not be saved'))

    await expect(adding).rejects.toThrow('the vault could not be saved')
    await expect(removing).rejects.toThrow('removing_the_last_wallet_is_not_allowed')
    expect(slots()).toEqual([KeyringType.HdKeyring])
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: 'keyring_0#0' })
    await expect(wallet.getCurrentAccount()).resolves.toMatchObject({ key: 'keyring_0#0' })
    expect(announced).toEqual([])
    expect(sitesTold()).toEqual([])

    // The vault holds it too.
    await keyringService.setLocked()
    await keyringService.submitPassword(PASSWORD)
    expect(slots()).toEqual([KeyringType.HdKeyring])
  })

  it('is refused, and removes nothing, when the wallet asked for fails to save and the next wallet added takes its slot', async () => {
    await createWallet()
    // Another window adds a wallet, whose save is held, and a page lists it
    // while it is saved.
    const save = encryptor.holdNextSave()
    const failing = createWallet(OTHER_MNEMONIC)
    await save.started
    const [, listedWhileSaved] = await listed()
    expect(listedWhileSaved).toMatchObject({ index: 1, key: 'keyring_1' })
    // A third window adds a wallet, which waits for that save.
    const additions = vi.spyOn(keyringService, 'addKeyring')
    const next = createWallet(THIRD_MNEMONIC)
    await vi.waitFor(() => expect(additions).toHaveBeenCalledTimes(1))
    // The page removes the wallet it listed; the removal waits behind both.
    const removal = vi.spyOn(keyringService, 'removeKeyring')
    const removing = wallet.removeKeyring(listedWhileSaved)
    await vi.waitFor(() => expect(removal).toHaveBeenCalled())
    announced.length = 0
    vi.mocked(sessionService.broadcastEvent).mockClear()

    // The save fails, and the wallet added next takes the slot it gives back.
    save.fail(new Error('the vault could not be saved'))
    await expect(failing).rejects.toThrow('the vault could not be saved')
    await expect(next).resolves.toBeUndefined()

    await expect(removing).rejects.toThrow('The selected wallet is no longer available')
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
    const [, added] = await listed()
    expect(added.accounts[0].pubkey).not.toBe(listedWhileSaved.accounts[0].pubkey)
    // It keeps the name and the color its addition stored, and stays current.
    expect(preferenceService.getKeyringAlianName('keyring_1')).toBe('Wallet 2')
    expect(preferenceService.getKeyringColor('keyring_1')).toBe(walletColorForSlot(1))
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: 'keyring_1#0',
      address: added.accounts[0].address,
    })
    expect(announced).toEqual([expect.objectContaining({ key: 'keyring_1#0' })])
    expect(sitesTold()).toEqual([[added.accounts[0].address]])

    // The vault holds it too.
    await keyringService.setLocked()
    await keyringService.submitPassword(PASSWORD)
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
  })

  /** Adds a wallet that lists no account, as a page lists a corrupted wallet. */
  const addCorrupted = (mnemonic: string) =>
    keyringService.addNewKeyring(
      KeyringType.HdKeyring,
      { mnemonic, activeIndexes: [], hdPath: HD_PATH },
      AddressType.P2WPKH
    )

  it('removes a corrupted wallet, which lists no account, while its slot holds it', async () => {
    await createWallet()
    await addCorrupted(OTHER_MNEMONIC)
    const [, corrupted] = await listed()
    expect(corrupted).toMatchObject({ index: 1, isCorrupted: true, accounts: [] })

    await expect(wallet.removeKeyring(corrupted)).resolves.toMatchObject({ key: 'keyring_0' })
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.Empty])
  })

  it('is refused for a corrupted wallet that fails to save, though the wallet that takes its slot lists no account either', async () => {
    await createWallet()
    const save = encryptor.holdNextSave()
    const failing = addCorrupted(OTHER_MNEMONIC)
    await save.started
    const [, listedWhileSaved] = await listed()
    expect(listedWhileSaved).toMatchObject({ index: 1, isCorrupted: true, accounts: [] })
    const additions = vi.spyOn(keyringService, 'addKeyring')
    const next = addCorrupted(THIRD_MNEMONIC)
    await vi.waitFor(() => expect(additions).toHaveBeenCalledTimes(1))
    const removal = vi.spyOn(keyringService, 'removeKeyring')
    const removing = wallet.removeKeyring(listedWhileSaved)
    await vi.waitFor(() => expect(removal).toHaveBeenCalled())

    save.fail(new Error('the vault could not be saved'))
    await expect(failing).rejects.toThrow('the vault could not be saved')
    const added = await next

    await expect(removing).rejects.toThrow('The selected wallet is no longer available')
    expect(keyringService.keyrings[1]).toBe(added)
    expect(slots()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
    // The name the slot got when the page listed it stays.
    expect(preferenceService.getKeyringAlianName('keyring_1')).toBe('Wallet 2')
  })

  it('removes the wallet when the wallet being added is saved, and leaves that one current', async () => {
    const { save, adding, removing } = await removeTheOnlyWalletWhileOneIsAdded()
    save.release()

    await expect(adding).resolves.toBeUndefined()
    await expect(removing).resolves.toMatchObject({ key: 'keyring_1' })
    expect(slots()).toEqual([KeyringType.Empty, KeyringType.HdKeyring])
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    const added = preferenceService.getCurrentAccount()
    expect(added).toMatchObject({ key: 'keyring_1#0' })
    // The addition announced its account, and so does the removal when it
    // selects that wallet before the addition does: no other account.
    expect(announced.length).toBeGreaterThan(0)
    expect(announced).toEqual(announced.map(() => expect.objectContaining({ key: 'keyring_1#0' })))
    expect(sitesTold()).toEqual(announced.map(() => [added!.address]))
  })
})
