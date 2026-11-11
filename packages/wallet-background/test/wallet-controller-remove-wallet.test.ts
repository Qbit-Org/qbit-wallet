import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { BUS_EVENTS, BUS_METHODS, ErrorCodes, SESSION_EVENTS } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import { preferenceService, sessionService } from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'

// The keyrings as the keyring service keeps them: one per slot, in the order
// they were added, with an empty keyring in the slot of each removed wallet.
// The rest of the background, the preferences included, is the real one.
const keyrings = vi.hoisted(() => {
  type FakeKeyring = {
    type: string
    addressType: number
    accounts: string[]
    hdPath?: string
    /** Account metadata without addresses, so the wallet lists as corrupted. */
    unreadable?: boolean
    recovery?: unknown
    getAccounts(): Promise<string[]>
    getQbitRecoveryState(): unknown
  }
  const QBIT_HD = 'Qbit HD Key Tree'
  const live: FakeKeyring[] = []
  let ids = 0

  const keyring = (
    type: string,
    addressType: number,
    accounts: string[],
    extra: Partial<FakeKeyring> = {}
  ): FakeKeyring => {
    const created: FakeKeyring = {
      type,
      addressType,
      accounts,
      getAccounts: async () => created.accounts,
      getQbitRecoveryState: () => structuredClone(created.recovery),
      ...extra,
    }
    return created
  }
  const nextId = () => (++ids).toString(16).padStart(2, '0').repeat(32)
  const addresses = (id: string) => ({
    mainnet: `qb1z${id.slice(0, 16)}`,
    testnet4: `tq1z${id.slice(0, 16)}`,
    signet: `tq1z${id.slice(0, 16)}`,
    regtest: `qbrt1z${id.slice(0, 16)}`,
  })
  const p2mrMetadata = (id: string, readable: boolean) => ({
    pubkey: id,
    path: "m/87'/0'/0'/0/0",
    scriptPubKey: `5220${id}`,
    leafScript: `20${id}b3`,
    ...(readable ? { addresses: addresses(id) } : {}),
    hkdf: { account: 0, change: 0, index: 0 },
    signatureCounter: { count: 0, limit: 1073741824, remaining: 1073741824, state: 'normal' },
  })
  const display = (shown: FakeKeyring, index: number) => ({
    type: shown.type,
    index,
    addressType: shown.addressType,
    keyring: shown.type === QBIT_HD ? { hdPath: shown.hdPath } : {},
    accounts: shown.accounts.map(id => ({
      pubkey: id,
      brandName: shown.type,
      ...(shown.type === QBIT_HD ? { keyring: p2mrMetadata(id, !shown.unreadable) } : {}),
    })),
  })

  const service = {
    keyrings: live,
    memStore: { getState: () => ({ isUnlocked: true }) },
    getAllDisplayedKeyrings: vi.fn(async () => live.map((shown, index) => display(shown, index))),
    removeKeyring: vi.fn(async (index: number) => {
      // The slot is read before the first wait, as the keyring service reads
      // it, so two removals of one slot both find a wallet there.
      if (!live[index] || live[index]!.type === 'Empty') {
        throw new Error('no_keyring_found_for_the_requested_account')
      }
      await Promise.resolve()
      live[index] = keyring('Empty', 0, [])
    }),
    // The recovery record of the wallet holding this address.
    getQbitRecoveryVaultState: vi.fn(async (address: string) =>
      live
        .find(
          shown =>
            shown.type === QBIT_HD &&
            !shown.unreadable &&
            shown.accounts.some(id => Object.values(addresses(id)).includes(address))
        )
        ?.getQbitRecoveryState()
    ),
    createTmpKeyring: vi.fn(() => {
      throw new Error('every wallet in these tests is on the recorded path')
    }),
  }

  return {
    QBIT_HD,
    service,
    live,
    keyring,
    nextId,
    addresses,
    reset() {
      live.length = 0
      ids = 0
    },
  }
})

vi.mock('../src/services', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services')>()),
  keyringService: keyrings.service,
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
const MAINNET_HD_PATH = "m/87'/0'/0'/0"

let wallet: WalletController

/** A Qbit HD wallet that lists its accounts, in the next slot; returns its first account's id. */
function usableWallet(accountCount = 1): string {
  const ids = Array.from({ length: accountCount }, () => keyrings.nextId())
  keyrings.live.push(
    keyrings.keyring(KeyringType.QbitHdKeyring, AddressType.P2MR, ids, {
      hdPath: MAINNET_HD_PATH,
    })
  )
  return ids[0]!
}

// One wallet of each kind the background lists as corrupted, with no
// accounts: an account list that is empty, accounts it cannot read, and a
// keyring type this build does not ship.
const CORRUPTED = {
  'that has no account': () => keyrings.keyring(KeyringType.HdKeyring, AddressType.P2WPKH, []),
  'whose accounts cannot be read': () =>
    keyrings.keyring(KeyringType.QbitHdKeyring, AddressType.P2MR, [keyrings.nextId()], {
      hdPath: MAINNET_HD_PATH,
      unreadable: true,
    }),
  'of a type this build does not ship': () => keyrings.keyring('Unknown Key Tree', 0, []),
}

/** The wallets as a page holds them: they reach the background as JSON. */
async function listed(): Promise<any[]> {
  return JSON.parse(JSON.stringify(await wallet.getKeyrings()))
}

const storedNames = () =>
  JSON.parse(JSON.stringify((preferenceService as any).store)).keyringAlianNames

/** A recovery record sweeping this wallet into the wallet `destinationId`, in slot `destinationKeyringIndex`. */
function migratingTo(destinationKeyringIndex: number, destinationId: string) {
  return {
    version: 2,
    acknowledgement: 'accepted',
    networks: {
      mainnet: {
        status: 'migrating',
        addressDiscoveryComplete: true,
        migration: {
          destinationKeyringIndex,
          destinationPubkey: destinationId,
          destinationAddress: keyrings.addresses(destinationId).mainnet,
          network: 'mainnet',
          plans: [],
        },
      },
    },
  }
}

/** The addresses of the accounts announced to the UI as selected, from now on. */
function announcedAccounts(): string[] {
  const announced: string[] = []
  const record = ({ method, params }: { method: string; params: any }) => {
    if (method === BUS_METHODS.ACCOUNTS_CHANGED) announced.push(params.address)
  }
  bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, record)
  stopRecording.push(() => bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, record))
  return announced
}
const stopRecording: (() => void)[] = []

/** The addresses announced to connected sites as their account, from now on. */
function sitesTold(): string[][] {
  const told: string[][] = []
  const broadcast = vi
    .spyOn(sessionService, 'broadcastEvent')
    .mockImplementation((event: string, data?: any) => {
      if (event === SESSION_EVENTS.accountsChanged) told.push(data)
    })
  stopRecording.push(() => broadcast.mockRestore())
  return told
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  stopRecording.splice(0).forEach(stop => stop())
})

beforeEach(async () => {
  vi.clearAllMocks()
  keyrings.reset()
  await preferenceService.init({ storage: new DiskAdapter() as any, logger })
  wallet = new WalletController()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
})

describe('removing a corrupted wallet', () => {
  it.each(Object.entries(CORRUPTED))(
    'removes a wallet %s, and only it',
    async (_kind, corrupted) => {
      usableWallet()
      keyrings.live.push(corrupted())
      usableWallet()
      const [, broken] = await listed()
      expect(broken).toMatchObject({ index: 1, key: 'keyring_1', accounts: [], isCorrupted: true })

      await wallet.removeKeyring(broken)

      expect(keyrings.service.removeKeyring).toHaveBeenCalledTimes(1)
      expect(keyrings.service.removeKeyring).toHaveBeenCalledWith(1, {
        beforeRemove: expect.any(Function),
      })
      expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([0, 2])
      expect(storedNames()).not.toHaveProperty('keyring_1')
    }
  )

  it('removes it once when two windows ask, and never another wallet in its place', async () => {
    usableWallet()
    keyrings.live.push(CORRUPTED['whose accounts cannot be read']())
    keyrings.live.push(CORRUPTED['whose accounts cannot be read']())
    const [, first, second] = await listed()

    const results = await Promise.allSettled([
      wallet.removeKeyring(first),
      wallet.removeKeyring(first),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      'The selected wallet is no longer available'
    )

    // The wallet in a slot is the one picked only while it is the same kind
    // of wallet and still lists no account (a network switch can make it
    // readable again). Nor is a slot or key the page never listed.
    keyrings.live[2]!.unreadable = false
    for (const captured of [
      second,
      { ...second, type: KeyringType.HdKeyring },
      { ...second, index: 5, key: 'keyring_5' },
      { ...second, key: 'keyring_0' },
    ]) {
      await expect(wallet.removeKeyring(captured), JSON.stringify(captured)).rejects.toThrow(
        'The selected wallet is no longer available'
      )
    }
    expect(keyrings.service.removeKeyring).toHaveBeenCalledTimes(1)
    expect(keyrings.service.removeKeyring).toHaveBeenCalledWith(1, {
      beforeRemove: expect.any(Function),
    })
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([0, 2])
  })

  it('refuses a wallet that is malformed, and removes nothing', async () => {
    usableWallet()
    keyrings.live.push(CORRUPTED['that has no account']())
    const [, broken] = await listed()

    // Over the UI port a missing wallet arrives as null.
    for (const captured of [
      null,
      undefined,
      'keyring_1',
      { ...broken, accounts: undefined },
      { ...broken, accounts: {} },
    ]) {
      await expect(wallet.removeKeyring(captured as any), String(captured)).rejects.toThrow(
        'Unknown wallet'
      )
    }
    expect(keyrings.service.removeKeyring).not.toHaveBeenCalled()
  })

  it('asks to confirm the recovery risks of a corrupted wallet a migration involves', async () => {
    // A migration sweeps the corrupted wallet in slot 1 into the wallet in
    // slot 0, and the wallet in slot 0 into the corrupted wallet in slot 2.
    const destination = usableWallet()
    keyrings.live.push(CORRUPTED['whose accounts cannot be read']())
    keyrings.live.push(CORRUPTED['whose accounts cannot be read']())
    keyrings.live[1]!.recovery = migratingTo(0, destination)
    keyrings.live[0]!.recovery = migratingTo(2, keyrings.live[2]!.accounts[0]!)
    const [, source, sweptInto] = await listed()

    const sourceReasons = [{ role: 'source', network: 'mainnet', status: 'migrating' }]
    await expect(wallet.removeKeyring(source)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: { reasons: sourceReasons },
    })
    const destinationReasons = [{ role: 'destination', network: 'mainnet', status: 'migrating' }]
    await expect(wallet.removeKeyring(sweptInto)).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
      data: { reasons: destinationReasons },
    })
    expect(keyrings.service.removeKeyring).not.toHaveBeenCalled()

    await wallet.removeKeyring(source, {
      acknowledgedQbitRecoveryRisks: true,
      acknowledgedQbitRecoveryReasons: sourceReasons as any,
    })
    expect(keyrings.service.removeKeyring).toHaveBeenCalledWith(1, {
      beforeRemove: expect.any(Function),
    })
  })
})

describe('the wallet selected after a removal', () => {
  // Wallets in slots 0, 1 and 2; the one in slot 1 has two accounts.
  async function threeWallets() {
    usableWallet()
    usableWallet(2)
    usableWallet()
    return listed()
  }

  it.each([
    // The user is on the first wallet and removes the last one.
    ['the last wallet', 0, 0, 2],
    ['an earlier wallet', 1, 1, 0],
    // The current wallet is the last one left, on its second account.
    ['the wallet after it', 1, 1, 2],
  ])(
    'stays the current wallet and account when %s is removed, and nothing is announced',
    async (_which, currentWallet, currentAccount, removed) => {
      const wallets = await threeWallets()
      await wallet.changeKeyring(wallets[currentWallet], currentAccount)
      const announced = announcedAccounts()
      const told = sitesTold()

      await expect(wallet.removeKeyring(wallets[removed])).resolves.toMatchObject({
        index: currentWallet,
        key: `keyring_${currentWallet}`,
      })

      const account = wallets[currentWallet].accounts[currentAccount]
      expect(preferenceService.getCurrentKeyringIndex()).toBe(currentWallet)
      expect(preferenceService.getCurrentAccount()).toMatchObject({
        key: account.key,
        address: account.address,
      })
      expect(announced).toEqual([])
      expect(told).toEqual([])
      expect(await wallet.getCurrentAccount()).toMatchObject({ key: account.key })
    }
  )

  it('stays the current wallet when another is removed and the last wallet is corrupted', async () => {
    usableWallet()
    usableWallet()
    keyrings.live.push(CORRUPTED['whose accounts cannot be read']())
    const wallets = await listed()
    await wallet.changeKeyring(wallets[1], 0)
    const announced = announcedAccounts()

    await expect(wallet.removeKeyring(wallets[0])).resolves.toMatchObject({ index: 1 })

    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: wallets[1].accounts[0].key,
    })
    expect(announced).toEqual([])
  })

  it.each([
    ['the last usable wallet, as before', 'usable', 1, 2],
    // The last wallet is corrupted, so the one before it.
    ['the last usable wallet when the last one is corrupted', 'corrupted', 1, 0],
  ])(
    'is %s, with its first account, when the current wallet is removed',
    async (_which, last, removed, selected) => {
      usableWallet()
      usableWallet(2)
      if (last === 'usable') usableWallet()
      else keyrings.live.push(CORRUPTED['whose accounts cannot be read']())
      const wallets = await listed()
      await wallet.changeKeyring(wallets[removed], 1)
      const announced = announcedAccounts()
      const told = sitesTold()

      await expect(wallet.removeKeyring(wallets[removed])).resolves.toMatchObject({
        index: selected,
        key: `keyring_${selected}`,
      })

      // What the background keeps as selected, before any read can fall back.
      const account = wallets[selected].accounts[0]
      expect(preferenceService.getCurrentKeyringIndex()).toBe(selected)
      expect(preferenceService.getCurrentAccount()).toMatchObject({
        key: account.key,
        address: account.address,
      })
      expect(announced).toEqual([account.address])
      expect(told).toEqual([[account.address]])
      expect(await wallet.getCurrentAccount()).toMatchObject({ key: account.key })
    }
  )

  // The wallet stored as current cannot stay current: the removal selects as
  // when the current wallet is removed.
  it.each([
    [
      'a slot a removal left empty, its account still stored',
      () => {
        keyrings.live[1] = keyrings.keyring('Empty', 0, [])
      },
    ],
    [
      'a wallet that is corrupted now',
      () => {
        keyrings.live[1]!.unreadable = true
      },
    ],
    ['a slot no wallet has', () => preferenceService.setCurrentKeyringIndex(7)],
  ])('is the last usable wallet when the one stored as current is %s', async (_which, spoil) => {
    usableWallet()
    usableWallet()
    usableWallet()
    usableWallet()
    const wallets = await listed()
    await wallet.changeKeyring(wallets[1], 0)
    spoil()
    const announced = announcedAccounts()

    await expect(wallet.removeKeyring(wallets[0])).resolves.toMatchObject({ index: 3 })

    const account = wallets[3].accounts[0]
    expect(preferenceService.getCurrentKeyringIndex()).toBe(3)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: account.key })
    expect(announced).toEqual([account.address])
  })

  // A site's read that began before the removal finds the wallet stored as
  // current corrupted while the removal is saved, and waits for it.
  it('is the last usable wallet, announced, though a read found the current wallet corrupted meanwhile', async () => {
    usableWallet()
    usableWallet()
    usableWallet()
    usableWallet()
    const wallets = await listed()
    await wallet.changeKeyring(wallets[1], 0)
    keyrings.live[1]!.unreadable = true
    const announced = announcedAccounts()
    const told = sitesTold()
    const reads = keyrings.service.getAllDisplayedKeyrings
    const listing = reads.getMockImplementation()!
    const listedForTheRead = deferred()
    reads.mockImplementationOnce(async () => {
      const shown = await listing()
      await listedForTheRead.promise
      return shown
    })
    const reading = wallet.getCurrentAccount()
    const saved = deferred()
    keyrings.service.removeKeyring.mockImplementationOnce(async (index: number) => {
      await saved.promise
      keyrings.live[index] = keyrings.keyring('Empty', 0, [])
    })
    const removing = wallet.removeKeyring(wallets[2])
    await vi.waitFor(() => expect(keyrings.service.removeKeyring).toHaveBeenCalled())

    listedForTheRead.resolve()
    // The read stores nothing, and waits for the removal.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(preferenceService.getCurrentKeyringIndex()).toBe(1)
    let answered = false
    void reading.then(() => (answered = true))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(answered).toBe(false)
    saved.resolve()

    await expect(removing).resolves.toMatchObject({ index: 3 })
    const account = wallets[3].accounts[0]
    expect(preferenceService.getCurrentKeyringIndex()).toBe(3)
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: account.key })
    expect(announced).toEqual([account.address])
    expect(told).toEqual([[account.address]])
    // The read answers with the account the removal told the site.
    await expect(reading).resolves.toMatchObject({ key: account.key })
  })

  // Each read misses the wallet stored as current, as when other windows keep
  // adding wallets and making them current while the wallets are read.
  it('reads the wallets three times at most, and selects nothing, while every read misses the current wallet', async () => {
    const wallets = await threeWallets()
    await wallet.changeKeyring(wallets[2], 0)
    const announced = announcedAccounts()
    const told = sitesTold()
    const reads = keyrings.service.getAllDisplayedKeyrings
    const listing = reads.getMockImplementation()!
    stopRecording.push(() => reads.mockImplementation(listing))
    reads.mockClear()
    reads.mockImplementation(async () =>
      (await listing()).filter(shown => shown.index !== 2 || keyrings.live[0]!.type !== 'Empty')
    )

    await expect(wallet.removeKeyring(wallets[0])).resolves.toBeUndefined()

    // One read before the removal, three after it.
    expect(reads).toHaveBeenCalledTimes(4)
    expect(preferenceService.getCurrentKeyringIndex()).toBe(2)
    expect(preferenceService.getCurrentAccount()).toMatchObject({
      key: wallets[2].accounts[0].key,
    })
    expect(announced).toEqual([])
    expect(told).toEqual([])
  })

  // Another window switches while the removal is saved: the selection is
  // judged once the wallet is gone, so the newer switch is not undone.
  it.each([
    ['another wallet, which stays current', 1, 1, 1, 1],
    ['the wallet being removed, so the last usable one becomes current', 2, 0, 1, 0],
  ])(
    'keeps what a switch made meanwhile in another window leaves: a switch to %s',
    async (_which, switchedWallet, switchedAccount, selected, selectedAccount) => {
      const wallets = await threeWallets()
      await wallet.changeKeyring(wallets[0], 0)
      const saved = deferred()
      keyrings.service.removeKeyring.mockImplementationOnce(async (index: number) => {
        await saved.promise
        keyrings.live[index] = keyrings.keyring('Empty', 0, [])
      })
      const removing = wallet.removeKeyring(wallets[2])
      await vi.waitFor(() => expect(keyrings.service.removeKeyring).toHaveBeenCalled())
      const announced = announcedAccounts()

      await wallet.changeKeyring(wallets[switchedWallet], switchedAccount)
      saved.resolve()

      await expect(removing).resolves.toMatchObject({ index: selected })
      const account = wallets[selected].accounts[selectedAccount]
      expect(preferenceService.getCurrentKeyringIndex()).toBe(selected)
      expect(preferenceService.getCurrentAccount()).toMatchObject({ key: account.key })
      // The switch announced its account; the removal announces only a change it makes.
      const switched = wallets[switchedWallet].accounts[switchedAccount].address
      expect(announced).toEqual(
        switched === account.address ? [switched] : [switched, account.address]
      )
    }
  )
})

describe('the last usable wallet', () => {
  it('is never removed, while a corrupted wallet beside it is', async () => {
    usableWallet()
    keyrings.live.push(CORRUPTED['that has no account']())
    const [only, broken] = await listed()
    await wallet.changeKeyring(only, 0)

    await expect(wallet.removeKeyring(only)).rejects.toThrow(
      'removing_the_last_wallet_is_not_allowed'
    )
    expect(keyrings.service.removeKeyring).not.toHaveBeenCalled()
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: only.accounts[0].key })

    await wallet.removeKeyring(broken)
    expect(keyrings.service.removeKeyring).toHaveBeenCalledWith(1, {
      beforeRemove: expect.any(Function),
    })
    await expect(wallet.removeKeyring(only)).rejects.toThrow(
      'removing_the_last_wallet_is_not_allowed'
    )
    expect(keyrings.service.removeKeyring).toHaveBeenCalledTimes(1)
  })

  it('is refused before the recovery risks are asked about', async () => {
    usableWallet()
    keyrings.live.push(CORRUPTED['whose accounts cannot be read']())
    keyrings.live[0]!.recovery = migratingTo(1, keyrings.live[1]!.accounts[0]!)
    const [only] = await listed()

    await expect(wallet.removeKeyring(only)).rejects.toThrow(
      'removing_the_last_wallet_is_not_allowed'
    )
    expect(keyrings.service.removeKeyring).not.toHaveBeenCalled()
  })

  it('leaves every wallet in place when none of them is usable', async () => {
    keyrings.live.push(CORRUPTED['that has no account']())
    keyrings.live.push(CORRUPTED['of a type this build does not ship']())

    for (const target of await listed()) {
      await expect(wallet.removeKeyring(target)).rejects.toThrow(
        'removing_the_last_wallet_is_not_allowed'
      )
    }
    expect(keyrings.service.removeKeyring).not.toHaveBeenCalled()
  })

  it('stays when two windows each remove one of the last two', async () => {
    usableWallet()
    usableWallet()
    const [first, second] = await listed()
    await wallet.changeKeyring(second, 0)

    const results = await Promise.allSettled([
      wallet.removeKeyring(first),
      wallet.removeKeyring(second),
    ])

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      'removing_the_last_wallet_is_not_allowed'
    )
    expect(keyrings.service.removeKeyring).toHaveBeenCalledTimes(1)
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([1])
    expect(preferenceService.getCurrentAccount()).toMatchObject({ key: second.accounts[0].key })
  })
})
