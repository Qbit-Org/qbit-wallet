import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { ErrorCodes } from '@qbit/wallet-shared'
import { BaseProxyStorageAdapter } from '@qbit/wallet-storage'
import { AddressType, ChainType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import {
  biometricUnlockService,
  contactBookService,
  keyringService,
  permissionService,
  phishingDetectService,
  preferenceService,
  qbitSendGuardService,
} from '../src/services'
import { QBIT_SEND_PLAN_CHAINS } from '@qbit/preference-service'
import { QBIT_CHAIN_TYPES } from '../src/controllers/wallet'
import { QBIT_CHAINS, type QbitSendPlanEngine } from '../src/services/qbitSendPlanEngine'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'

// A wallet removal over the real keyring service and preferences (#216): the
// record of the send plans it ends is on disk before the keyring service
// removes anything, and a removal refused for want of it removes and ends
// nothing; a removal that fails takes it back when nothing was removed, and
// keeps it when its vault write may have reached storage. A background that
// starts again hands the records to the plans before anything advances, and
// judges each from the keyring once it is unlocked. A wallet reset erases the
// records with the wallets.

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

type WriteMatch = (key: string, value: any) => boolean

// chrome.storage.local as every service sees it: JSON in, JSON out. A write
// can be held open until released, or made to fail.
class Disk extends BaseProxyStorageAdapter {
  readonly values = new Map<string, string>()
  private holds: { match: WriteMatch; started: () => void; settled: Promise<void> }[] = []
  private failures: { match: WriteMatch; left: number; error: Error }[] = []

  async get(key: string): Promise<any> {
    return this.read(key)
  }

  async set(key: string, value: any): Promise<void> {
    const raw = JSON.stringify(value)
    const copy = raw === undefined ? undefined : JSON.parse(raw)
    const hold = this.holds.find(candidate => candidate.match(key, copy))
    if (hold) {
      this.holds.splice(this.holds.indexOf(hold), 1)
      hold.started()
      await hold.settled
    }
    const failure = this.failures.find(
      candidate => candidate.left > 0 && candidate.match(key, copy)
    )
    if (failure) {
      failure.left -= 1
      throw failure.error
    }
    if (raw === undefined) this.values.delete(key)
    else this.values.set(key, raw)
  }

  read(key: string): any {
    const raw = this.values.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  holdNextWrite(match: WriteMatch) {
    const started = deferred()
    const settled = deferred()
    this.holds.push({ match, started: started.resolve, settled: settled.promise })
    return { started: started.promise, release: settled.resolve }
  }

  failWrites(match: WriteMatch, times = Number.POSITIVE_INFINITY, error = new Error('disk full')) {
    this.failures.push({ match, left: times, error })
  }

  stopFailing() {
    this.failures = []
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

const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() }
const PASSWORD = 'password'
const NEW_PASSWORD = 'a new password'
const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const HD_PATH = "m/84'/0'/0'/0"

const isVaultWrite: WriteMatch = (key, value) => key === 'keyringState' && Boolean(value?.vault)
const isPreferenceWrite: WriteMatch = key => key === 'preference'

let disk: Disk
let encryptor: JsonEncryptor
let wallet: WalletController

/** Start every service from what is on the disk, as a worker start does. */
async function startServices() {
  await preferenceService.init({ storage: disk, logger })
  await keyringService.init({
    storage: disk as any,
    encryptor,
    logger,
    t: (key: string) => key,
    eventBus: { emit: vi.fn() } as any,
  })
  await biometricUnlockService.init({ storage: disk, logger })
  await permissionService.init({ storage: disk, logger, autoSync: true })
  ;(contactBookService as any).initialized = false
  await contactBookService.init({ storage: disk, logger })
  phishingDetectService.destroy()
  await phishingDetectService.init({ adapter: disk, logger })
  qbitSendGuardService.init()
  await qbitSendPlanStore.init({ storage: disk })
}

/** A new controller, started as the background starts it (restoreAppState). */
async function startController(): Promise<WalletController> {
  const controller = new WalletController()
  controller.initRegtestAccess({
    adapter: {
      isOptionalPermission: () => true,
      containsPermission: async () => true,
      onPermissionRemoved: () => undefined,
    },
    fetch: async () => {
      throw new Error('offline')
    },
  })
  controller.restoreQbitSendPlanRemovals()
  await controller.restoreQbitSendPlans()
  // A reset that still cannot be finished leaves the rest to start.
  await controller.finishPendingWalletReset().catch(() => undefined)
  controller.startQbitSendPlanEngine()
  return controller
}

/**
 * Unlock with the password, as a page does, and let what the unlock began
 * settle: the plans, and a removal of unknown outcome, settled behind the
 * unlock on the chain-state queue.
 */
async function unlock(): Promise<void> {
  await wallet.unlock(PASSWORD)
  await settled()
}

/** The service worker starts again: every service reads the disk, the wallet locked. */
async function restartWorker(): Promise<void> {
  engineOf(wallet).reset()
  clearTimeout((wallet as any).timer)
  clearTimeout((wallet as any).qbitSendPlanRemovalSettleTimer)
  await startServices()
  wallet = await startController()
}

function engineOf(controller: WalletController) {
  return (controller as unknown as { qbitSendPlans: QbitSendPlanEngine })
    .qbitSendPlans as unknown as {
    reset(): void
    idle(): Promise<void>
    onUnlock(): void
    endPlansOf: QbitSendPlanEngine['endPlansOf']
    removalHeld: Set<string>
  }
}

/** Let what the chain-state queue holds run, and the plans settle what it began. */
async function settled(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await (wallet as any).chainStateChangeTail
    await engineOf(wallet).idle()
  }
}

/** The types of the slots of the vault on disk. */
const storedSlotTypes = (): string[] =>
  (JSON.parse(disk.read('keyringState').vault).data as { type: string }[]).map(slot => slot.type)

/** The accounts the plans hold back for removal records, as `chain:address`. */
const heldBack = (): string[] => [...engineOf(wallet).removalHeld].sort()

/** The wallet removal records on disk. */
const storedRemovals = (): any => disk.read('preference')?.qbitSendPlanRemovals

const createWallet = (mnemonic = MNEMONIC) =>
  wallet.createKeyringWithMnemonics(mnemonic, HD_PATH, '', AddressType.P2WPKH, 1)

/** The wallet in slot `index`, as a page lists it. */
async function listed(index: number) {
  const found = (await wallet.getKeyrings()).find(keyring => keyring.index === index)
  if (!found) throw new Error(`no wallet in slot ${index}`)
  return JSON.parse(JSON.stringify(found))
}

/** Every account of the wallet in slot `index` whose plans a removal ends, as `chain:address`. */
async function planAccountsOf(index: number): Promise<string[]> {
  const shown = await listed(index)
  return shown.accounts.map(
    (account: { address: string }) => `${ChainType.QBIT_MAINNET}:${account.address}`
  )
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.spyOn(log, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('chrome', {
    declarativeNetRequest: {
      getSessionRules: vi.fn(async () => []),
      updateSessionRules: vi.fn(async () => undefined),
    },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) },
  })
  disk = new Disk()
  encryptor = new JsonEncryptor()
  await startServices()
  wallet = await startController()
  await wallet.boot(PASSWORD)
  // Slot 0: the wallet removed; slot 1: a wallet that stays.
  await createWallet()
  await createWallet(OTHER_MNEMONIC)
})

afterEach(async () => {
  engineOf(wallet).reset()
  clearTimeout((wallet as any).timer)
  clearTimeout((wallet as any).qbitSendPlanRemovalSettleTimer)
  await (wallet as any).chainStateChangeTail
  vi.unstubAllGlobals()
})

describe('a wallet removal', () => {
  it('stores the record of the plans it ends before the keyring service removes anything, and forgets it once nothing of them is left', async () => {
    const accounts = await planAccountsOf(0)
    let atRemoval: unknown
    const remove = keyringService.removeKeyring
    vi.spyOn(keyringService, 'removeKeyring').mockImplementation((...args) => {
      atRemoval = storedRemovals()
      return remove(...args)
    })

    await wallet.removeKeyring(await listed(0))

    expect(atRemoval).toEqual([
      {
        version: 1,
        id: expect.stringMatching(/^[0-9a-f]{32}$/),
        wallet: { index: 0, type: KeyringType.HdKeyring },
        accounts: accounts.map(key => ({
          chain: ChainType.QBIT_MAINNET,
          address: key.split(':')[1],
        })),
      },
    ])
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([1])
  })

  it('is refused when storage refuses the record: nothing is removed or ended, and it can be tried again', async () => {
    const removal = vi.spyOn(keyringService, 'removeKeyring')
    const ending = vi.spyOn(engineOf(wallet), 'endPlansOf')
    disk.failWrites(isPreferenceWrite)

    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow(
      'The wallet cannot be removed now: the record of its send plans could not be saved. Try again.'
    )

    expect(removal).not.toHaveBeenCalled()
    expect(ending).not.toHaveBeenCalled()
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([0, 1])
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])

    disk.stopFailing()
    await wallet.removeKeyring(await listed(0))
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([1])
    expect(storedRemovals()).toBeUndefined()
  })

  it('takes its record back when it is refused before anything is removed, the slot having changed meanwhile', async () => {
    const shown = await listed(0)
    const write = disk.holdNextWrite(
      (key, value) => key === 'preference' && Array.isArray(value?.qbitSendPlanRemovals)
    )
    const removing = wallet.removeKeyring(shown)
    await write.started
    // A lock and an unlock load the wallets again: the slot holds another
    // instance of the wallet than the one the page listed.
    await keyringService.setLocked()
    await keyringService.submitPassword(PASSWORD)
    write.release()

    await expect(removing).rejects.toThrow('The selected wallet is no longer available')
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([0, 1])
  })

  it('keeps its record when its vault write fails, holds the accounts back until a restart, and then finds the wallet there', async () => {
    const accounts = await planAccountsOf(0)
    disk.failWrites(isVaultWrite)

    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow('disk full')

    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)
    // An unlock in this run does not judge it: storage may hold the removal
    // or not, whatever memory holds.
    await wallet.lockWallet()
    await unlock()
    expect(heldBack()).toEqual(accounts)
    expect(storedRemovals()).toHaveLength(1)

    disk.stopFailing()
    await restartWorker()
    expect(heldBack()).toEqual(accounts)
    await unlock()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([0, 1])
  })
})

describe('a background that starts again during a removal', () => {
  it('after the vault write and before the endings: holds the accounts back while locked, and finds the wallet gone at the unlock, though its phrase was added again', async () => {
    const accounts = await planAccountsOf(0)
    let removed!: Promise<unknown>
    const remove = keyringService.removeKeyring
    vi.spyOn(keyringService, 'removeKeyring').mockImplementation((...args) => {
      removed = remove(...args)
      return removed
    })
    // The worker stops as the plans are to be ended.
    vi.spyOn(engineOf(wallet), 'endPlansOf').mockReturnValue(new Promise(() => undefined))
    void wallet.removeKeyring(await listed(0))
    await vi.waitFor(() => expect(removed).toBeDefined())
    await removed
    // The same phrase is added again, in a new slot.
    await createWallet()
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([1, 2])

    await restartWorker()
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)

    await unlock()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })

  it('between the record and the vault write: finds the wallet there at the unlock, and the record goes', async () => {
    const accounts = await planAccountsOf(0)
    const removal = vi
      .spyOn(keyringService, 'removeKeyring')
      .mockReturnValue(new Promise(() => undefined))
    void wallet.removeKeyring(await listed(0))
    await vi.waitFor(() => expect(removal).toHaveBeenCalled())
    expect(storedRemovals()).toHaveLength(1)
    removal.mockRestore()

    await restartWorker()
    expect(heldBack()).toEqual(accounts)
    await unlock()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([0, 1])
  })
})

describe('a wallet reset while a removal record holds accounts back', () => {
  it('erases the record with the wallets: nothing holds back a wallet set up again from the same phrase', async () => {
    const accounts = await planAccountsOf(0)
    vi.spyOn(preferenceService, 'forgetQbitSendPlanRemoval').mockRejectedValue(
      new Error('disk full')
    )
    await wallet.removeKeyring(await listed(0))
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)
    vi.mocked(preferenceService.forgetQbitSendPlanRemoval).mockRestore()

    await wallet.resetWallet(PASSWORD)
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])

    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    expect(await planAccountsOf(0)).toEqual(accounts)
    expect(heldBack()).toEqual([])
    await restartWorker()
    expect(heldBack()).toEqual([])
  })
})

describe('a wallet reset after a removal', () => {
  it('leaves nothing of the earlier removal to settle a later one: a new wallet in the same slot whose removal fails at its vault write keeps its record', async () => {
    await wallet.removeKeyring(await listed(0))
    await wallet.resetWallet(PASSWORD)
    await wallet.boot(NEW_PASSWORD)
    // Slot 0 again: another wallet, set up after the reset.
    await wallet.createKeyringWithMnemonics(OTHER_MNEMONIC, HD_PATH, '', AddressType.P2WPKH, 1)
    await createWallet()
    const accounts = await planAccountsOf(0)
    disk.failWrites(isVaultWrite)

    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow('disk full')
    await engineOf(wallet).idle()
    await wallet.lockWallet()
    await wallet.unlock(NEW_PASSWORD)
    await engineOf(wallet).idle()

    // Whether storage holds that removal is not known in this run: the
    // record stays, and its accounts are held back.
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)
  })
})

describe('a removal that fails once its checks passed, settled in the run', () => {
  const THIRD_MNEMONIC =
    'legal winner thank year wave sausage worth useful legal winner thank yellow'

  /** The wallet locks as the removal is about to write the vault: the keyring service refuses the write. */
  function lockBeforeTheVaultWrite(): void {
    const persist = keyringService.persistAllKeyrings
    let locked = false
    vi.spyOn(keyringService, 'persistAllKeyrings').mockImplementation(async changed => {
      if (!locked && changed.some(keyring => keyring.type === KeyringType.Empty)) {
        locked = true
        await wallet.lockWallet()
      }
      return persist(changed)
    })
  }

  it('after a lock before its vault write, takes the record back at the next unlock: nothing was removed, and the accounts go on', async () => {
    const accounts = await planAccountsOf(0)
    lockBeforeTheVaultWrite()
    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow()
    vi.mocked(keyringService.persistAllKeyrings).mockRestore()
    await settled()
    // Locked, no write tells the outcome yet: the accounts stay held back.
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)

    await unlock()
    await settled()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    expect(storedSlotTypes()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
    // A later vault write changes nothing of it.
    await createWallet(THIRD_MNEMONIC)
    await settled()
    expect(heldBack()).toEqual([])
  })

  it('settles nothing when a lock lands right after its own write, and the next unlock settles it', async () => {
    const accounts = await planAccountsOf(0)
    lockBeforeTheVaultWrite()
    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow()
    vi.mocked(keyringService.persistAllKeyrings).mockRestore()
    await settled()
    // The write that settles it lands, and the wallet locks before its verdict.
    const persist = keyringService.persistAllKeyrings
    let lockedAfter = false
    vi.spyOn(keyringService, 'persistAllKeyrings').mockImplementation(async changed => {
      const saved = await persist(changed)
      if (!lockedAfter && changed.length === 0) {
        lockedAfter = true
        await keyringService.setLocked()
      }
      return saved
    })
    const ending = vi.spyOn(engineOf(wallet), 'endPlansOf')
    await unlock()
    await settled()
    expect(lockedAfter).toBe(true)
    expect(ending).not.toHaveBeenCalled()
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)

    vi.mocked(keyringService.persistAllKeyrings).mockRestore()
    await unlock()
    await settled()
    expect(ending).not.toHaveBeenCalled()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })

  it('after a failure that followed its vault write, settles it at once as removed, and ends its plans', async () => {
    const accounts = await planAccountsOf(0)
    const update = keyringService._updateMemStoreKeyrings
    let failed = false
    vi.spyOn(keyringService, '_updateMemStoreKeyrings').mockImplementation(async () => {
      if (!failed && storedSlotTypes()[0] === KeyringType.Empty) {
        failed = true
        throw new Error('memory store refresh failed')
      }
      return update()
    })
    const ending = vi.spyOn(engineOf(wallet), 'endPlansOf')

    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow(
      'memory store refresh failed'
    )
    await settled()

    expect(storedSlotTypes()[0]).toBe(KeyringType.Empty)
    expect(ending).toHaveBeenCalledTimes(1)
    expect(ending.mock.calls[0]![0].map(item => `${item.chain}:${item.address}`).sort()).toEqual(
      accounts
    )
    expect(ending.mock.calls[0]![1]).toMatch(/^[0-9a-f]{32}$/)
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })

  it('keeps the outcome unknown while every vault write is refused, its write tried again at each unlock, and a restart judges it', async () => {
    const accounts = await planAccountsOf(0)
    disk.failWrites(isVaultWrite)
    const writes = vi.spyOn(keyringService, 'persistAllKeyrings')
    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow('disk full')
    await settled()
    // The write that would settle it was tried, and refused.
    expect(writes.mock.calls.filter(([changed]) => changed.length === 0)).toHaveLength(1)
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)

    await wallet.lockWallet()
    await unlock()
    await settled()
    expect(writes.mock.calls.filter(([changed]) => changed.length === 0)).toHaveLength(2)
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)

    disk.stopFailing()
    await restartWorker()
    await unlock()
    await settled()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })

  it('is settled as removed when a later removal of the same slot succeeds, its own write having been refused', async () => {
    const accounts = await planAccountsOf(0)
    disk.failWrites(isVaultWrite)
    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow('disk full')
    await settled()
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)

    // Storage takes writes again, and the wallet is removed again, with no
    // unlock in between.
    disk.stopFailing()
    await wallet.removeKeyring(await listed(0))
    await settled()
    expect(storedSlotTypes()[0]).toBe(KeyringType.Empty)
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })

  /** A removal that fails at its vault write, and whose settling write is refused too. */
  async function unknownOutcome(): Promise<string[]> {
    const accounts = await planAccountsOf(0)
    disk.failWrites(isVaultWrite)
    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow('disk full')
    await settled()
    disk.stopFailing()
    expect(storedRemovals()).toHaveLength(1)
    expect(heldBack()).toEqual(accounts)
    return accounts
  }

  /** The writes of the vault with no change, by which a removal of unknown outcome is settled. */
  const settlingWrites = (writes: { mock: { calls: unknown[][] } }): number =>
    writes.mock.calls.filter(([changed]) => (changed as unknown[]).length === 0).length

  it('waits for a wallet addition under way before its write: storage keeps no wallet of that addition, which failed', async () => {
    await unknownOutcome()
    // A wallet is being added: it is in the slots, about to be saved, when
    // the settling begins, as after an unlock or a removal; it has every
    // chance to write first. Then storage refuses the addition's write and
    // its rollback's, until the addition has failed.
    const persist = keyringService.persistAllKeyrings
    let settling: Promise<void> | undefined
    vi.spyOn(keyringService, 'persistAllKeyrings').mockImplementation(async changed => {
      if (!settling && changed.length === 1 && changed[0]!.type === KeyringType.HdKeyring) {
        settling = (wallet as any).settleQbitSendPlanRemovalsOfUnknownOutcome()
        await Promise.race([settling, new Promise(resolve => setTimeout(resolve, 50))])
        disk.failWrites(isVaultWrite)
      }
      return persist(changed)
    })
    const adding = createWallet(THIRD_MNEMONIC).finally(() => disk.stopFailing())
    await expect(adding).rejects.toThrow('disk full')
    await settling
    vi.mocked(keyringService.persistAllKeyrings).mockRestore()
    await settled()

    // The wallet whose addition failed is in neither the slots nor storage;
    // the settling wrote the slots as they are, and found the wallet there.
    expect(keyringService.keyrings).toHaveLength(2)
    expect(storedSlotTypes()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })

  it('cannot wait for itself: an addition under way goes on to its end while the settling waits, which then writes', async () => {
    await unknownOutcome()
    const save = disk.holdNextWrite(isVaultWrite)
    const adding = createWallet(THIRD_MNEMONIC)
    await save.started
    const writes = vi.spyOn(keyringService, 'persistAllKeyrings')
    let done = false
    const settling = (wallet as any)
      .settleQbitSendPlanRemovalsOfUnknownOutcome()
      .then(() => (done = true))
    try {
      for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setTimeout(resolve, 0))
      // The addition's save is held in storage: the settling waits, unwritten.
      expect(settlingWrites(writes)).toBe(0)
      expect(done).toBe(false)
    } finally {
      save.release()
    }
    await adding
    await settling
    await settled()
    expect(settlingWrites(writes)).toBe(1)
    expect(storedSlotTypes()).toEqual([
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
    ])
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })

  it('may store the wallet of an addition that begins once its wait is over, as any vault write queued then may, and still judges the removal from its own slot and ends its accounts’ plans alone', async () => {
    const accounts = await planAccountsOf(0)
    // The removal's vault write lands, and it fails after it: its slot is
    // empty. The write that would settle it is refused, to be tried again.
    const update = keyringService._updateMemStoreKeyrings
    let failed = false
    vi.spyOn(keyringService, '_updateMemStoreKeyrings').mockImplementation(async () => {
      if (!failed && storedSlotTypes()[0] === KeyringType.Empty) {
        failed = true
        disk.failWrites(isVaultWrite)
        throw new Error('memory store refresh failed')
      }
      return update()
    })
    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow(
      'memory store refresh failed'
    )
    await settled()
    vi.mocked(keyringService._updateMemStoreKeyrings).mockRestore()
    disk.stopFailing()
    expect(heldBack()).toEqual(accounts)
    const ending = vi.spyOn(engineOf(wallet), 'endPlansOf')

    // Another write of the vault is under way, as a signature's can be, held
    // by storage: the settling's write queues behind it, its wait over.
    const other = disk.holdNextWrite(isVaultWrite)
    const writing = keyringService.persistAllKeyrings([])
    await other.started
    const writes = vi.spyOn(keyringService, 'persistAllKeyrings')
    const settling = (wallet as any).settleQbitSendPlanRemovalsOfUnknownOutcome()
    while (settlingWrites(writes) === 0) await new Promise(resolve => setTimeout(resolve, 0))
    // A wallet addition begins: its wallet goes into the slots, and its write
    // queues behind the settling's. Storage takes the held write and the
    // settling's, each a write of the store's subscriber and its own, and
    // refuses the addition's and its rollback's.
    const adding = createWallet(THIRD_MNEMONIC)
    while (keyringService.keyrings.length < 3) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    let vaultWrites = 0
    disk.failWrites((key, value) => isVaultWrite(key, value) && ++vaultWrites > 4)
    other.release()
    await writing
    await expect(adding).rejects.toThrow('disk full')
    await settling
    await settled()
    disk.stopFailing()

    // The settling's write stored the wallet whose addition failed, which
    // the slots no longer hold; the next write of the vault drops it.
    expect(storedSlotTypes()).toEqual([
      KeyringType.Empty,
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
    ])
    expect(keyringService.keyrings).toHaveLength(2)
    // The removal was judged from its own slot, empty, and ended the plans
    // of its accounts alone.
    expect(ending).toHaveBeenCalledTimes(1)
    expect(ending.mock.calls[0]![0].map(item => `${item.chain}:${item.address}`).sort()).toEqual(
      accounts
    )
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    await keyringService.persistAllKeyrings([])
    expect(storedSlotTypes()).toEqual([KeyringType.Empty, KeyringType.HdKeyring])
  })

  it('is forgotten by a wallet reset in between: no write settles it later, and nothing holds back a wallet set up again', async () => {
    const accounts = await planAccountsOf(0)
    disk.failWrites(isVaultWrite)
    await expect(wallet.removeKeyring(await listed(0))).rejects.toThrow('disk full')
    await settled()
    expect(heldBack()).toEqual(accounts)
    disk.stopFailing()

    await wallet.resetWallet(PASSWORD)
    await settled()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    const writes = vi.spyOn(keyringService, 'persistAllKeyrings')
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    await wallet.lockWallet()
    await wallet.unlock(NEW_PASSWORD)
    await settled()
    expect(writes.mock.calls.filter(([changed]) => changed.length === 0)).toEqual([])
    expect(heldBack()).toEqual([])
  })

  it('is tried no more after a wallet reset: no try is left due, and a later refusal is logged and spaced afresh', async () => {
    const controller = wallet as any
    await unknownOutcome()
    expect(controller.qbitSendPlanRemovalSettleTimer).toBeDefined()

    await wallet.resetWallet(PASSWORD)
    await settled()
    expect(controller.qbitSendPlanRemovalSettleTimer).toBeUndefined()

    // A wallet set up again, and a removal of it that fails the same way.
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    vi.mocked(log.warn).mockClear()
    await unknownOutcome()
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter(([message]) =>
          String(message).includes('The vault could not be written to settle a wallet removal')
        )
    ).toHaveLength(1)
    expect(controller.qbitSendPlanRemovalSettleRefusals).toBe(1)
  })

  describe('with a second removal of the same slot queued behind it', () => {
    /** Removals of the wallet in slot 0 asked for twice at once, the first one's vault writes refused. */
    async function twoRemovals() {
      const shown = await listed(0)
      // The first removal's write and its rollback's: each a write of the
      // store's subscriber and the removal's own.
      disk.failWrites(isVaultWrite, 4)
      let vaultWrites = 0
      const write = disk.holdNextWrite(
        (key, value) => isVaultWrite(key, value) && ++vaultWrites === 5
      )
      const first = wallet.removeKeyring(shown)
      const second = wallet.removeKeyring(shown)
      await expect(first).rejects.toThrow('disk full')
      await write.started
      return { second, write }
    }

    it('settles nothing while that removal writes, though a kick reads the slot empty then; that removal failing too, the next unlock takes both back', async () => {
      const accounts = await planAccountsOf(0)
      const ending = vi.spyOn(engineOf(wallet), 'endPlansOf')
      const { second, write } = await twoRemovals()
      // The slot reads empty in memory while the second removal writes.
      expect((await wallet.getKeyrings()).map(keyring => keyring.index)).toEqual([1])
      engineOf(wallet).onUnlock()
      await engineOf(wallet).idle()
      expect(ending).not.toHaveBeenCalled()
      expect(storedRemovals()).toHaveLength(2)
      expect(heldBack()).toEqual(accounts)

      disk.failWrites(isVaultWrite)
      write.release()
      await expect(second).rejects.toThrow('disk full')
      await settled()
      expect(ending).not.toHaveBeenCalled()
      expect(storedRemovals()).toHaveLength(2)

      disk.stopFailing()
      await wallet.lockWallet()
      await unlock()
      await settled()
      expect(ending).not.toHaveBeenCalled()
      expect(storedRemovals()).toBeUndefined()
      expect(heldBack()).toEqual([])
      expect(storedSlotTypes()).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
    })

    it('settles it as removed once that removal succeeded', async () => {
      const accounts = await planAccountsOf(0)
      const { second, write } = await twoRemovals()
      write.release()
      await second
      await settled()
      expect(storedSlotTypes()[0]).toBe(KeyringType.Empty)
      expect(storedRemovals()).toBeUndefined()
      expect(heldBack()).toEqual([])
      expect(accounts).toHaveLength(1)
    })
  })
})

describe('accounts that a record this version cannot read names', () => {
  it('are let go of once Reset Wallet erased the record, also for a wallet set up again from the same phrase', async () => {
    const accounts = await planAccountsOf(0)
    const [chain, address] = accounts[0]!.split(':')
    const preferences = disk.read('preference')
    preferences.qbitSendPlanRemovals = [
      { version: 2, id: 'ab'.repeat(16), accounts: [{ chain, address }] },
    ]
    disk.values.set('preference', JSON.stringify(preferences))
    await restartWorker()
    expect(heldBack()).toEqual([accounts[0]])
    await unlock()

    await wallet.resetWallet(PASSWORD)
    await settled()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    expect(await planAccountsOf(0)).toEqual(accounts)
    await settled()
    expect(heldBack()).toEqual([])
  })
})

describe('the judgement of a record while no slot is loaded', () => {
  it('gives no verdict while the keyring holds no wallet, and judges the record once a slot is loaded', async () => {
    await wallet.resetWallet(PASSWORD)
    await wallet.boot(NEW_PASSWORD)
    // Booted and unlocked, with no wallet yet: no slot is loaded.
    expect(wallet.isUnlocked()).toBe(true)
    expect(keyringService.keyrings).toEqual([])
    const record = await preferenceService.addQbitSendPlanRemoval(
      { index: 0, type: KeyringType.HdKeyring },
      [{ chain: ChainType.QBIT_MAINNET, address: 'bc1qnoslotloaded' }]
    )
    // As a start would hand it over.
    wallet.restoreQbitSendPlanRemovals()
    engineOf(wallet).onUnlock()
    await settled()
    expect(storedRemovals()).toEqual([record])
    expect(heldBack()).toEqual([`${ChainType.QBIT_MAINNET}:bc1qnoslotloaded`])

    // Slot 0 holds a wallet of the record's type: it is there still.
    await createWallet()
    engineOf(wallet).onUnlock()
    await settled()
    expect(storedRemovals()).toBeUndefined()
    expect(heldBack()).toEqual([])
  })
})

describe('the networks a send plan can be on', () => {
  it('are the same to the removal, to the record it stores and to the plans', () => {
    const networks = [...QBIT_CHAIN_TYPES].sort()
    expect([...QBIT_SEND_PLAN_CHAINS].sort()).toEqual(networks)
    expect([...QBIT_CHAINS].sort()).toEqual(networks)
  })
})

describe('plans orphaned by a reset whose erase of them keeps failing', () => {
  // The gap of a new vault written while such plans are stored, then a
  // restart that finds a vault and takes them for its own, cannot be reached
  // through a reset a user runs: the reset leaves its pending mark, and boot,
  // the one way to write a new vault, finishes that reset first, the plans'
  // erase included, or is refused.
  it('leaves no way to write a new vault until they are erased, and a restart keeps them stopped meanwhile', async () => {
    // A stored document of another version: plans this version cannot read.
    disk.values.set(
      QBIT_SEND_PLAN_STORE_KEY,
      JSON.stringify({ version: 2, plans: [{ id: 'a1'.repeat(16) }] })
    )
    await restartWorker()
    await unlock()
    disk.failWrites(key => key === QBIT_SEND_PLAN_STORE_KEY)

    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })
    expect(keyringService.hasVault()).toBe(false)
    expect(disk.read('preference')?.walletResetPending).toBe(true)
    expect(disk.values.has(QBIT_SEND_PLAN_STORE_KEY)).toBe(true)

    await expect(wallet.boot(NEW_PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })
    expect(keyringService.isBooted()).toBe(false)
    expect(disk.read('keyringState')?.vault).toBeFalsy()

    await restartWorker()
    expect(keyringService.hasVault()).toBe(false)
    expect((engineOf(wallet) as unknown as { keysGone: boolean }).keysGone).toBe(true)
    await expect(wallet.boot(NEW_PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })
    expect(disk.read('keyringState')?.vault).toBeFalsy()

    disk.stopFailing()
    await wallet.boot(NEW_PASSWORD)
    expect(
      disk.values.has(QBIT_SEND_PLAN_STORE_KEY) ? disk.read(QBIT_SEND_PLAN_STORE_KEY).plans : []
    ).toEqual([])
    await createWallet()
    expect(disk.read('keyringState')?.vault).toBeTruthy()
  })
})
