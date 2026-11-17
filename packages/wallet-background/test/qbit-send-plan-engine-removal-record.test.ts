import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hexToBytes, p2mrAddressFromPubkey } from '@qbit-oss/protocol'
import { PreferenceService } from '@qbit/preference-service'
import { BUS_EVENTS, BUS_METHODS, KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { keyringService, preferenceService } from '../src/services'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_STORE_KEY,
  type QbitSendPlanRecord,
} from '../src/services/qbitSendPlanStore'
import {
  QBIT_SEND_PLAN_SLOW_MERGE_MS,
  QBIT_SEND_PLAN_UNREADABLE_ID,
} from '../src/services/qbitSendPlanEngine'
import { bgEventBus } from '../src/utils/eventBus'
import { fakeTxid } from './qbit-fake-explorer'
import {
  CHAIN,
  T0,
  World,
  account,
  newPlanGuard,
  p2mrAccount,
  watchPlanAnnouncements,
  wirePlanKeyring,
  type QbitSendPlanAccount,
} from './qbit-send-plan-engine-harness'

// A wallet removal stores a record of the send plans it ends before it
// removes anything (#216): which wallet, by its slot, and the accounts whose
// plans end. Until the record is forgotten, which needs nothing of those
// plans left or the wallet found there still, those accounts are held back:
// nothing of their plans is signed, broadcast or advanced, after a restart
// too. A restart judges the record from the keyring once it is unlocked:
// the wallet gone, its plans are ended; the wallet there still, the record
// goes and its plans go on. Here the preferences, where the record lives,
// are the real service over a disk of their own, which a restart reads
// again; the keyring service keeps the wallets by slot, as the vault does.

const lockState = vi.hoisted(() => ({ isUnlocked: true }))
const guardHolder = vi.hoisted(() => ({ guard: undefined as unknown as object }))
const preferencesHolder = vi.hoisted(() => ({ service: undefined as unknown as object }))
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  guardHolder.guard = new QbitSendGuardService()
  const forward = (holder: { [key: string]: object }, name: string): object =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          const target = holder[name] as Record<PropertyKey, unknown>
          const value = target[property]
          return typeof value === 'function' ? value.bind(target) : value
        },
      }
    )
  // What the tests read or steer of the preferences themselves; every other
  // preference, the removal records among them, is the real service's.
  const steered: Record<string, unknown> = {
    getCurrentAccount: vi.fn(),
    getAddressFlag: vi.fn(() => 0),
    getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
    getAutoLockTimeId: vi.fn(() => 3),
    getInitAlianNameStatus: vi.fn(() => true),
    getLockOnComputerLock: vi.fn(() => true),
    getLockOnWindowsClosed: vi.fn(() => true),
    getAccountAlianName: vi.fn((_key: string, name?: string) => name),
    getKeyringAlianName: vi.fn(() => 'Wallet'),
    getKeyringColor: vi.fn(() => undefined),
    getCurrentKeyringIndex: vi.fn(() => 1),
    removeKeyringAlianName: vi.fn(),
    removeKeyringColor: vi.fn(),
  }
  const real = forward(preferencesHolder as never, 'service') as Record<PropertyKey, unknown>
  return {
    keyringService: {
      keyrings: [],
      memStore: { getState: () => lockState },
      hasVault: vi.fn(() => true),
      setLocked: vi.fn(),
      preflightP2mrPsbtSigning: vi.fn(),
      openP2mrPsbtSigningBatch: vi.fn(),
      releaseP2mrPsbtSigningBatches: vi.fn(),
      signP2mrPsbtWithCounter: vi.fn(),
      confirmQbitRestoredFloorSigning: vi.fn(),
      releaseQbitRestoredFloorSigningChallenges: vi.fn(),
      getQbitRecoveryState: vi.fn(async () => undefined),
      submitPassword: vi.fn(),
      syncQbitHdPath: vi.fn(async () => false),
      getAllDisplayedKeyrings: vi.fn(async () => []),
      getQbitRecoveryVaultState: vi.fn(async () => undefined),
      createTmpKeyring: vi.fn(),
      removeKeyring: vi.fn(),
      // The write a removal of unknown outcome is settled by (see `unlockWallet`).
      persistAllKeyrings: vi.fn(),
    },
    preferenceService: new Proxy(steered, {
      get: (target, property) =>
        typeof property === 'string' && property in target ? target[property] : real[property],
    }),
    qbitSendGuardService: forward(guardHolder as never, 'guard'),
    sessionService: { broadcastEvent: vi.fn() },
    contactBookService: { listAlias: vi.fn(() => []) },
    permissionService: {},
  }
})
vi.mock('../src/services/approval', () => ({ default: {} }))

/** The preferences' storage, as chrome.storage.local keeps them: copies, as JSON. */
class PreferenceDisk {
  constructor(
    readonly disk: Map<string, string>,
    readonly faults: { refuse: boolean; writes: number }
  ) {}

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    return { ...structuredClone(template), ...((await this.get(name)) as object) }
  }

  async get(key: string): Promise<unknown> {
    const raw = this.disk.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.faults.writes += 1
    if (this.faults.refuse) throw new Error('storage unavailable')
    this.disk.set(key, JSON.stringify(value))
  }
}

/** What the preference service logs, by level. */
let preferenceLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

/** What storage holds of the preferences, whether it refuses their writes, and how many it was asked for. */
let preferenceDisk = new Map<string, string>()
const preferenceFaults = { refuse: false, writes: 0 }

/** The preferences as storage holds them, read by a service of their own, as a start does. */
async function loadPreferences(): Promise<void> {
  const service = new PreferenceService()
  await service.init({
    storage: new PreferenceDisk(preferenceDisk, preferenceFaults) as never,
    logger: preferenceLog,
  })
  preferencesHolder.service = service
}

/** The wallet removal records as storage holds them. */
function storedRemovals(): unknown {
  const raw = preferenceDisk.get('preference')
  return raw === undefined
    ? undefined
    : (JSON.parse(raw) as Record<string, unknown>).qbitSendPlanRemovals
}

/** Store `value` as the removal records, as another version would have, beside the preferences stored. */
function storeRemovals(value: unknown): void {
  const raw = preferenceDisk.get('preference')
  const stored = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>)
  preferenceDisk.set('preference', JSON.stringify({ ...stored, qbitSendPlanRemovals: value }))
}

// The wallets as the keyring service holds them, one per slot. `vault` is
// what storage holds; while locked the keyring service holds no slot.
const TEST_PATH = "m/87'/1'/0'/0"
type Slot = { type: string; listedPubkeys?: string[] }
let vault: Slot[] = []

function setSlots(slots: Slot[]): void {
  ;(keyringService as unknown as { keyrings: Slot[] }).keyrings = slots
}

/** An account's key as the keyring service lists it on the test networks' path. */
function listedKey(pubkeyHex: string) {
  const pubkey = hexToBytes(pubkeyHex)
  return {
    ...p2mrAccount(pubkeyHex).p2mr,
    path: `${TEST_PATH}/0`,
    addresses: {
      mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
      testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
      signet: p2mrAddressFromPubkey(pubkey, 'signet'),
      regtest: p2mrAddressFromPubkey(pubkey, 'regtest'),
    },
  }
}

/** A wallet that signs for the accounts of `listedPubkeys`. */
function signingWallet(listedPubkeys: string[]): Slot {
  return {
    type: KeyringType.QbitHdKeyring,
    mnemonic: `the phrase of the wallet of ${listedPubkeys[0]!.slice(0, 4)}`,
    passphrase: '',
    activeIndexes: listedPubkeys.map((_, index) => index),
    hdPath: TEST_PATH,
    listedPubkeys,
  } as Slot
}

/** How the keyring service's removal goes: each step waits here when one is set. */
const removalSteps: {
  /** Thrown before the removal checks anything. */
  refuse?: () => Error
  /** Awaited once the removal's checks passed, before the slot is emptied. */
  beforeEmpty?: () => Promise<void>
  /** Awaited once the slot is emptied and the vault written. */
  afterEmpty?: () => Promise<void>
} = {}

const lockStateUnlocked = (): void => {
  lockState.isUnlocked = true
}

let world: World
let worlds: World[] = []

function newGuard(): void {
  newPlanGuard(guardHolder)
}

function freshWorld(): World {
  if (world?.wallet) world.engine.reset()
  newGuard()
  lockStateUnlocked()
  const next = new World(lockState, newGuard)
  worlds.push(next)
  wirePlanKeyring(next)
  return next
}

/** Another account of the removed wallet, on the same network. */
const otherAccount = p2mrAccount('22'.repeat(32))
/** The account of a wallet that stays. */
const stayingAccount = p2mrAccount('77'.repeat(32))
/** The account of a wallet removed second, in the tests of two removals. */
const secondAccount = p2mrAccount('55'.repeat(32))
/** The account of a wallet added after the removal. */
const newAccount = p2mrAccount('88'.repeat(32))

const AMOUNT = 12_000_000

/** A prepare's refusal while a wallet removal's record holds the account. */
const REMOVAL_UNDER_WAY =
  'A wallet removal that involves this account has not finished, so a payment in several transactions cannot start yet.'
/** A prepare's refusal for an account the wallet does not sign for. */
const ACCOUNT_REQUIRED = 'Qbit send plans need an account this wallet signs for'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.clearAllMocks()
  lockStateUnlocked()
  preferenceDisk = new Map()
  preferenceFaults.refuse = false
  preferenceFaults.writes = 0
  preferenceLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  await loadPreferences()
  vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
  vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
  vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(1)
  // Slot 0: the wallet removed, which signs for the world's account and
  // another; slot 1: the current wallet, which stays.
  vault = [
    signingWallet([account.pubkey, otherAccount.pubkey]),
    signingWallet([stayingAccount.pubkey]),
  ]
  setSlots(vault)
  delete removalSteps.refuse
  delete removalSteps.beforeEmpty
  delete removalSteps.afterEmpty
  vi.mocked(keyringService.getAllDisplayedKeyrings).mockImplementation((async () =>
    (keyringService as unknown as { keyrings: Slot[] }).keyrings.map((slot, index) => ({
      type: slot.type,
      index,
      addressType: AddressType.P2MR,
      keyring: { hdPath: TEST_PATH },
      accounts: (slot.listedPubkeys ?? []).map(pubkey => ({
        pubkey,
        brandName: slot.type,
        keyring: listedKey(pubkey),
      })),
    }))) as never)
  // No account of these wallets on mainnet's path matters here.
  vi.mocked(keyringService.createTmpKeyring).mockImplementation((() => ({
    getQbitAccounts: async () => [],
  })) as never)
  vi.mocked(keyringService.removeKeyring).mockImplementation((async (
    index: number,
    options?: { beforeRemove?: () => Promise<void> }
  ) => {
    if (removalSteps.refuse) throw removalSteps.refuse()
    await options?.beforeRemove?.()
    await removalSteps.beforeEmpty?.()
    vault[index] = { type: KeyringType.Empty }
    await removalSteps.afterEmpty?.()
  }) as never)
  world = freshWorld()
  watchPlanAnnouncements(() => world)
})

afterEach(async () => {
  // Each world is checked once, so a failure stays with the test it is in,
  // and everything is put back whatever the check finds.
  const checked = worlds
  worlds = []
  try {
    for (const each of checked) each.assertGuarantees()
  } finally {
    if (world?.wallet) world.engine.reset()
    setSlots([])
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

/**
 * The service worker starts again: memory goes; storage, the vault and the
 * explorer stay. It starts as the background does (restoreAppState): the
 * preferences, the plan store, the removal records, the plans' holds, then
 * the plans advance. The wallet is locked: the keyring holds no slot.
 */
async function restartBackground(): Promise<void> {
  world.engine.reset()
  // The worker that settled removals of unknown outcome is gone, with its timer.
  world.timers.clearTimeout(
    (world.wallet as unknown as { qbitSendPlanRemovalSettleTimer?: unknown })
      .qbitSendPlanRemovalSettleTimer
  )
  newGuard()
  world.keyring.restart()
  setSlots([])
  await loadPreferences()
  await qbitSendPlanStore.init({ storage: world.storage })
  world.wallet = world.controller()
  world.wallet.restoreQbitSendPlanRemovals()
  await world.wallet.restoreQbitSendPlans()
  world.wallet.startQbitSendPlanEngine()
  await world.settle()
}

/**
 * Unlock: the keyring loads the wallets from the vault, then the engine
 * hears of it, and, as the wallet's unlock does at its end, a removal of
 * unknown outcome is settled.
 */
async function unlockWallet(): Promise<void> {
  setSlots(vault)
  await world.unlock()
  await settleUnknownRemovals()
}

/** What the wallet's unlock does at its end: settle the removals of unknown outcome. */
async function settleUnknownRemovals(): Promise<void> {
  const controller = world.wallet as unknown as {
    settleQbitSendPlanRemovalsOfUnknownOutcome?: () => Promise<void>
    chainStateChangeTail: Promise<void>
  }
  await controller.settleQbitSendPlanRemovalsOfUnknownOutcome?.()
  await controller.chainStateChangeTail
  await world.settle()
}

/** The wallet in slot `index`, as a page lists it. */
async function listedWallet(index: number): Promise<{ index: number }> {
  const listed = JSON.parse(JSON.stringify(await world.wallet.getKeyrings())) as { index: number }[]
  const wallet = listed.find(item => item.index === index)
  if (!wallet) throw new Error(`no wallet in slot ${index}`)
  return wallet
}

/** Begin removing the wallet in slot `index`, as a page asks. */
async function startRemoval(index = 0): Promise<unknown> {
  return world.wallet.removeKeyring((await listedWallet(index)) as never)
}

/** Remove the wallet in slot `index`; resolves to what it warned of its plans. */
async function removeWallet(index = 0): Promise<string[]> {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
  try {
    await startRemoval(index)
    await world.settle()
    return warn.mock.calls
      .map(([message]) => String(message))
      .filter(message => message.includes('of the removed wallet'))
  } finally {
    warn.mockRestore()
  }
}

/** A promise `reached` that settles when the returned step runs, which then never ends. */
function stopTheWorker(): { reached: Promise<void>; step: () => Promise<void> } {
  let arrive: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrive = resolve))
  return {
    reached,
    step: () => {
      arrive()
      return new Promise<void>(() => undefined)
    },
  }
}

type StoredEntry = { id?: string }

function storedEntries(): StoredEntry[] {
  const raw = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
  return raw ? (JSON.parse(raw) as { plans: StoredEntry[] }).plans : []
}

/**
 * Whether storing `value` as the plan document leaves out a stored entry
 * `drops` matches.
 */
function leavesOut(value: unknown, drops: (entry: StoredEntry) => boolean): boolean {
  const kept = new Set((value as { plans: StoredEntry[] }).plans.map(entry => entry.id))
  return storedEntries().some(entry => drops(entry) && !kept.has(entry.id))
}

/** The plan store's storage refuses each write that would drop a plan `drops` matches, until stopped. */
function refuseWritesDropping(drops: (entry: StoredEntry) => boolean): () => void {
  const set = world.storage.set.bind(world.storage)
  let refusing = true
  world.storage.set = async (key, value) => {
    if (refusing && key === QBIT_SEND_PLAN_STORE_KEY && leavesOut(value, drops)) {
      throw new Error('storage unavailable')
    }
    return set(key, value)
  }
  return () => {
    refusing = false
  }
}

/** `count` confirmed outputs of `value` bits paying `owner`, an account other than the world's own. */
function fundAccount(owner: QbitSendPlanAccount, count: number, value: number): void {
  world.explorer.registerAddress(owner.address, owner.p2mr.scriptPubKey)
  for (let index = 0; index < count; index++) {
    const seed = world.funded++
    world.explorer.addTx({
      txid: fakeTxid(seed, 7),
      inputs: [{ txid: fakeTxid(seed, 9_000_000), vout: 0 }],
      outputs: [{ address: owner.address, script: owner.p2mr.scriptPubKey, value }],
      height: 100 + seed,
    })
  }
}

/** Start a plan of `amount` for `owner`, selected meanwhile; the world's own account is selected again after. */
async function startPlanOf(owner: QbitSendPlanAccount, amount = AMOUNT) {
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(owner as never)
  try {
    return await world.startPlan({ target: { kind: 'amount', amount } })
  } finally {
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
  }
}

/** The world's account's plan of `AMOUNT`, waiting for its merge with its payment signed. */
async function waitingPlan() {
  world.fund(150, 100_000)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
  return plan
}

/**
 * Blocks come and ticks pass, a page reading the selected account's plan
 * after each, and the explorer accepts everything: nothing of `payments`
 * leaves the wallet.
 */
async function expectNoneBroadcastAfterwards(payments: readonly string[]): Promise<void> {
  for (let block = 0; block < 3; block++) {
    world.mine()
    await world.tick()
    await world.plan()
  }
  for (const txid of payments) expect(world.pushed).not.toContain(txid)
}

/** Plan `planId` is ended: no record of it, read or stored, and nothing held. */
async function expectEnded(planId: string): Promise<void> {
  expect(qbitSendPlanStore.get(planId)).toBeUndefined()
  expect(storedEntries().some(entry => entry.id === planId)).toBe(false)
  expect((await world.planHeld()).size).toBe(0)
}

/** Plan `planId` is held back: stored, its outputs held, its payment never sent. */
async function expectHeldBack(planId: string, payment: string): Promise<void> {
  expect(qbitSendPlanStore.get(planId)).toBeDefined()
  expect((await world.planHeld()).size).toBeGreaterThan(0)
  expect(world.pushed).not.toContain(payment)
}

/** What the background told wallet pages of what endings left. */
function notices(): unknown[] {
  return vi
    .mocked(bgEventBus.emit)
    .mock.calls.filter(
      ([event, data]) =>
        event === BUS_EVENTS.broadcastToUI &&
        (data as { method?: string }).method === BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED
    )
    .map(([, data]) => JSON.parse(JSON.stringify((data as { params: unknown }).params)))
}

describe('a removal whose ending storage refused, then a restart', () => {
  it('ends the plan once the wallet is unlocked after the restart, and sends nothing of it, also after its merge confirms', async () => {
    const plan = await waitingPlan()
    const stop = refuseWritesDropping(entry => entry.id === plan.id)
    expect(await removeWallet()).toHaveLength(1)
    expect(vault[0]).toEqual({ type: KeyringType.Empty })
    expect(qbitSendPlanStore.get(plan.id)).toBeDefined()

    // Storage takes the writes again, and the worker starts again before
    // any later attempt ends the plan.
    stop()
    await restartBackground()
    await unlockWallet()

    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    world.assertRecipientGuarantees(undefined)
  })

  it('holds the plan back while the wallet stays locked after the restart, its merge confirming, ends nothing, and ends it at the unlock', async () => {
    const plan = await waitingPlan()
    const stop = refuseWritesDropping(entry => entry.id === plan.id)
    expect(await removeWallet()).toHaveLength(1)
    stop()
    await restartBackground()

    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectHeldBack(plan.id, plan.paymentTxid)
    expect(storedRemovals()).toHaveLength(1)

    await unlockWallet()
    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })

  it('tells every page once what the removal left, and nothing more when that is ended later', async () => {
    const plan = await waitingPlan()
    const stop = refuseWritesDropping(entry => entry.id === plan.id)
    expect(await removeWallet()).toHaveLength(1)
    expect(notices()).toEqual([{ plans: 1, unreadable: 0, storeUnavailable: false }])

    stop()
    await world.tick()
    await expectEnded(plan.id)
    expect(notices()).toEqual([{ plans: 1, unreadable: 0, storeUnavailable: false }])
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })

  it('tells no page anything of a removal that leaves nothing', async () => {
    const plan = await waitingPlan()
    expect(await removeWallet()).toEqual([])
    await expectEnded(plan.id)
    expect(notices()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('tells no page again when what is left changes, and tells each removal that leaves something', async () => {
    world.fund(150, 100_000)
    fundAccount(otherAccount, 150, 100_000)
    await world.open()
    const first = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const second = await startPlanOf(otherAccount)
    const stopFirst = refuseWritesDropping(entry => entry.id === first.id)
    const stopSecond = refuseWritesDropping(entry => entry.id === second.id)
    expect(await removeWallet()).toHaveLength(1)
    expect(notices()).toEqual([{ plans: 2, unreadable: 0, storeUnavailable: false }])

    // One of the two is ended at a tick: what is left changes, and no page
    // is told.
    stopSecond()
    await world.tick()
    expect(qbitSendPlanStore.get(second.id)).toBeUndefined()
    expect(notices()).toEqual([{ plans: 2, unreadable: 0, storeUnavailable: false }])

    // Another removal that leaves something is told on its own.
    vault.push(signingWallet([newAccount.pubkey]))
    fundAccount(newAccount, 150, 100_000)
    const third = await startPlanOf(newAccount)
    const stopThird = refuseWritesDropping(entry => entry.id === third.id)
    expect(await removeWallet(2)).toHaveLength(1)
    expect(notices()).toEqual([
      { plans: 2, unreadable: 0, storeUnavailable: false },
      { plans: 1, unreadable: 0, storeUnavailable: false },
    ])

    stopFirst()
    stopThird()
    await world.tick()
    expect(notices()).toHaveLength(2)
    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid, third.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a restart at a point of the removal', () => {
  it('after the vault write and before any ending, with no write refused: ends the plan at the unlock and sends nothing of it', async () => {
    const plan = await waitingPlan()
    const stopped = stopTheWorker()
    removalSteps.afterEmpty = stopped.step
    void startRemoval()
    await stopped.reached
    expect(vault[0]).toEqual({ type: KeyringType.Empty })

    await restartBackground()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectHeldBack(plan.id, plan.paymentTxid)

    await unlockWallet()
    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })

  it('between the record and the vault write: the wallet stays, its plan is held back until the unlock, then goes on and pays', async () => {
    const plan = await waitingPlan()
    const stopped = stopTheWorker()
    removalSteps.beforeEmpty = stopped.step
    void startRemoval()
    await stopped.reached
    expect(storedRemovals()).toHaveLength(1)

    await restartBackground()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectHeldBack(plan.id, plan.paymentTxid)

    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('after some endings and before the rest: ends what is left at the unlock', async () => {
    world.fund(150, 100_000)
    fundAccount(otherAccount, 150, 100_000)
    await world.open()
    const first = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const second = await startPlanOf(otherAccount)
    const stop = refuseWritesDropping(entry => entry.id === first.id)
    await removeWallet()
    expect(qbitSendPlanStore.get(second.id)).toBeUndefined()
    expect(qbitSendPlanStore.get(first.id)).toBeDefined()

    stop()
    await restartBackground()
    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid])
    await unlockWallet()
    await expectEnded(first.id)
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })

  it('after every ending and before the record is forgotten: forgets it at the unlock, nothing left to end', async () => {
    const plan = await waitingPlan()
    // Storage refuses the preferences once the vault is written.
    removalSteps.afterEmpty = async () => {
      preferenceFaults.refuse = true
    }
    expect(await removeWallet()).toEqual([])
    await expectEnded(plan.id)
    expect(storedRemovals()).toHaveLength(1)

    preferenceFaults.refuse = false
    await restartBackground()
    expect(storedRemovals()).toHaveLength(1)
    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a removal that fails once its record is stored', () => {
  it('takes its record back when nothing was removed, and the plan goes on', async () => {
    const plan = await waitingPlan()
    removalSteps.refuse = () => new Error('no_keyring_found_for_the_requested_account')
    await expect(startRemoval()).rejects.toThrow('no_keyring_found_for_the_requested_account')
    expect(storedRemovals()).toBeUndefined()

    world.mine()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('with the take-back refused too, then a restart: holds the plan back until the unlock finds the wallet, then the plan goes on and pays', async () => {
    const plan = await waitingPlan()
    // The record is stored, then storage refuses the preferences, and the
    // keyring service refuses the removal before anything is removed.
    removalSteps.refuse = () => {
      preferenceFaults.refuse = true
      return new Error('no_keyring_found_for_the_requested_account')
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    await expect(startRemoval()).rejects.toThrow('no_keyring_found_for_the_requested_account')
    expect(vault[0]).toMatchObject({ type: KeyringType.QbitHdKeyring })
    expect(storedRemovals()).toHaveLength(1)
    // Its merge confirms: nothing of the plan goes while its record stands.
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectHeldBack(plan.id, plan.paymentTxid)
    // The refused take-back is logged once, not at every tick.
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('could not be forgotten'))
    ).toHaveLength(1)
    warn.mockRestore()

    // Storage works again, and the worker starts again.
    preferenceFaults.refuse = false
    await restartBackground()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectHeldBack(plan.id, plan.paymentTxid)

    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('keeps its record when it failed once the slot began to be emptied and every vault write is refused, and judges it after a restart', async () => {
    const plan = await waitingPlan()
    removalSteps.beforeEmpty = async () => {
      throw new Error('storage unavailable')
    }
    vi.mocked(keyringService.persistAllKeyrings).mockRejectedValue(new Error('storage unavailable'))
    await expect(startRemoval()).rejects.toThrow('storage unavailable')
    await settleUnknownRemovals()
    expect(vault[0]).toMatchObject({ type: KeyringType.QbitHdKeyring })
    // Whether storage holds the removal is not known, and no write can tell
    // it: the record stays, and the plan is held back, through unlocks.
    expect(storedRemovals()).toHaveLength(1)
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await unlockWallet()
    await expectHeldBack(plan.id, plan.paymentTxid)
    expect(storedRemovals()).toHaveLength(1)

    delete removalSteps.beforeEmpty
    vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)
    await restartBackground()
    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a removal that fails once its checks passed, settled in the run', () => {
  it('after a lock before its vault write, takes the record back at the next unlock: the plan goes on and pays', async () => {
    const plan = await waitingPlan()
    removalSteps.beforeEmpty = async () => {
      // The wallet locks: the keyring service refuses the vault write.
      lockState.isUnlocked = false
      setSlots([])
      throw new Error('keyringcontroller_password_is_not_a_string')
    }
    await expect(startRemoval()).rejects.toThrow('keyringcontroller_password_is_not_a_string')
    delete removalSteps.beforeEmpty
    await settleUnknownRemovals()
    expect(vault[0]).toMatchObject({ type: KeyringType.QbitHdKeyring })
    // Locked, nothing tells the outcome yet: the plan is held back.
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    expect(storedRemovals()).toHaveLength(1)

    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('after a failure that followed its vault write, settles it at once as removed: its plan is ended and nothing of it is sent', async () => {
    const plan = await waitingPlan()
    removalSteps.afterEmpty = async () => {
      throw new Error('memory store refresh failed')
    }
    await expect(startRemoval()).rejects.toThrow('memory store refresh failed')
    delete removalSteps.afterEmpty
    await settleUnknownRemovals()
    expect(vault[0]).toEqual({ type: KeyringType.Empty })
    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a removal of unknown outcome that turns out to have removed the wallet', () => {
  it('tells every page once what it left', async () => {
    const plan = await waitingPlan()
    const stop = refuseWritesDropping(entry => entry.id === plan.id)
    removalSteps.afterEmpty = async () => {
      throw new Error('memory store refresh failed')
    }
    await expect(startRemoval()).rejects.toThrow('memory store refresh failed')
    delete removalSteps.afterEmpty
    await settleUnknownRemovals()
    expect(qbitSendPlanStore.get(plan.id)).toBeDefined()
    expect(notices()).toEqual([{ plans: 1, unreadable: 0, storeUnavailable: false }])

    stop()
    await world.tick()
    await expectEnded(plan.id)
    expect(notices()).toHaveLength(1)
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a forget storage keeps refusing', () => {
  /** The engine's warnings that a record could not be forgotten. */
  const keptNotes = (warn: { mock: { calls: unknown[][] } }): number =>
    warn.mock.calls.filter(([message]) => String(message).includes('could not be forgotten')).length

  it('is tried at spaced kicks, one write each, its first refusal alone logged, and goes once storage takes it', async () => {
    const plan = await waitingPlan()
    // Storage refuses the preferences once the vault is written.
    removalSteps.afterEmpty = async () => {
      preferenceFaults.refuse = true
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    await startRemoval()
    await world.settle()
    await expectEnded(plan.id)
    expect(storedRemovals()).toHaveLength(1)
    const writesAtRemoval = preferenceFaults.writes

    // Twelve ticks, three minutes: tried 15, 45 and 105 seconds after the
    // removal's own try.
    for (let tick = 0; tick < 12; tick++) await world.tick()
    expect(preferenceFaults.writes - writesAtRemoval).toBe(3)
    expect(preferenceLog.error).not.toHaveBeenCalled()
    expect(keptNotes(warn)).toBe(1)
    expect(storedRemovals()).toHaveLength(1)

    // Storage takes the writes again: the next try, 225 seconds after the
    // removal, forgets it.
    preferenceFaults.refuse = false
    for (let tick = 0; tick < 2; tick++) await world.tick()
    expect(storedRemovals()).toHaveLength(1)
    await world.tick()
    expect(storedRemovals()).toBeUndefined()
    expect(keptNotes(warn)).toBe(1)
    world.assertRecipientGuarantees(undefined)
  })

  it('spaces the tries out to eight minutes apart, and no further', async () => {
    const plan = await waitingPlan()
    removalSteps.afterEmpty = async () => {
      preferenceFaults.refuse = true
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    await startRemoval()
    await world.settle()
    await expectEnded(plan.id)
    const removedAt = Date.now()
    const writesAtRemoval = preferenceFaults.writes

    // 32 minutes of refusals: the seconds after the removal's own try at
    // which each try is made.
    const tries: number[] = []
    let writes = writesAtRemoval
    for (let tick = 0; tick < 128; tick++) {
      await world.tick()
      if (preferenceFaults.writes !== writes) tries.push((Date.now() - removedAt) / 1000)
      writes = preferenceFaults.writes
    }
    expect(tries).toEqual([15, 45, 105, 225, 465, 945, 1425, 1905])
    expect(preferenceFaults.writes - writesAtRemoval).toBe(tries.length)
    expect(keptNotes(warn)).toBe(1)
    expect(storedRemovals()).toHaveLength(1)
  })

  it('tries every record at once at an unlock, whenever its next try was due', async () => {
    const plan = await waitingPlan()
    removalSteps.afterEmpty = async () => {
      preferenceFaults.refuse = true
    }
    await startRemoval()
    await world.settle()
    await expectEnded(plan.id)
    // Five refusals in a row, the last 225 seconds after the removal: the
    // next try is due four minutes later.
    for (let tick = 0; tick < 16; tick++) await world.tick()
    expect(storedRemovals()).toHaveLength(1)

    // Storage takes writes again, and the wallet is locked and unlocked.
    preferenceFaults.refuse = false
    lockState.isUnlocked = false
    setSlots([])
    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()
    world.assertRecipientGuarantees(undefined)
  })

  it('tries a take-back storage keeps refusing at every tick, one write each, its first refusal alone logged, and lets the wallet go at the first tick storage takes it', async () => {
    const plan = await waitingPlan()
    removalSteps.refuse = () => {
      preferenceFaults.refuse = true
      return new Error('no_keyring_found_for_the_requested_account')
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    await expect(startRemoval()).rejects.toThrow('no_keyring_found_for_the_requested_account')
    delete removalSteps.refuse
    await world.settle()
    const writesAtRemoval = preferenceFaults.writes
    // Its merge confirms: only the record holds the plan back.
    world.mine()

    // Ten minutes of refusals.
    for (let tick = 0; tick < 40; tick++) await world.tick()
    expect(preferenceFaults.writes - writesAtRemoval).toBe(40)
    expect(preferenceLog.error).not.toHaveBeenCalled()
    expect(keptNotes(warn)).toBe(1)
    await expectHeldBack(plan.id, plan.paymentTxid)

    // Storage takes writes again: the next tick forgets the record, and
    // the wallet's plan goes on.
    preferenceFaults.refuse = false
    await world.tick()
    expect(storedRemovals()).toBeUndefined()
    expect(keptNotes(warn)).toBe(1)
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a removal while the plan store holds what names no account', () => {
  it.each([
    [
      'a document of another version, which the page of any account can drop',
      { version: 2, plans: [{ id: 'a1'.repeat(16) }] },
      () => world.wallet.cancelQbitSendPlan(QBIT_SEND_PLAN_UNREADABLE_ID),
    ],
    [
      'an entry that names no account, which the page of any account can drop',
      { version: 1, plans: [{ id: 'b2'.repeat(16) }] },
      () => world.wallet.cancelQbitSendPlan('b2'.repeat(16)),
    ],
  ])(
    'keeps its record while the store holds %s, ticking with nothing written, and forgets it once that goes',
    async (_label, document, drop) => {
      world.fund(150, 100_000)
      await world.open()
      world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
      await restartBackground()
      await unlockWallet()
      expect(await removeWallet()).toEqual([])
      expect(storedRemovals()).toHaveLength(1)

      const planWrites: unknown[] = []
      const set = world.storage.set.bind(world.storage)
      world.storage.set = async (key, value) => {
        planWrites.push(value)
        return set(key, value)
      }
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
      const preferenceWrites = preferenceFaults.writes
      for (let tick = 0; tick < 4; tick++) await world.tick()
      expect(planWrites).toEqual([])
      expect(preferenceFaults.writes).toBe(preferenceWrites)
      expect(warn).not.toHaveBeenCalled()
      expect(world.timers.scheduled).toBeGreaterThan(0)
      expect(storedRemovals()).toHaveLength(1)

      await drop()
      await world.tick()
      expect(storedRemovals()).toBeUndefined()
      world.assertRecipientGuarantees(undefined)
    }
  )
})

describe('the judgement of a record whose slot holds a wallet of another type', () => {
  it('judges its wallet gone: the plan of the account it names is ended', async () => {
    const plan = await waitingPlan()
    // Slot 1 holds the wallet that stays, of another keyring type than the record names.
    storeRemovals([
      {
        version: 1,
        id: 'cd'.repeat(16),
        wallet: { index: 1, type: KeyringType.HdKeyring },
        accounts: [{ chain: CHAIN, address: account.address }],
      },
    ])
    await restartBackground()
    await unlockWallet()
    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('the judgement of a record after a restart', () => {
  it('ends nothing when a lock lands in its read of the slots, and the next unlock settles it', async () => {
    const plan = await waitingPlan()
    const stopped = stopTheWorker()
    removalSteps.beforeEmpty = stopped.step
    void startRemoval()
    await stopped.reached
    await restartBackground()

    // The wallet unlocks, and a lock lands as the judgement reads the
    // slots: the keyring service is locked, and holds none.
    let reads = 0
    Object.defineProperty(keyringService, 'keyrings', {
      configurable: true,
      get: () => {
        reads += 1
        if (reads === 1) return vault
        lockState.isUnlocked = false
        return []
      },
    })
    try {
      lockStateUnlocked()
      world.engine.onUnlock()
      await world.settle()
    } finally {
      Object.defineProperty(keyringService, 'keyrings', {
        configurable: true,
        writable: true,
        value: [],
      })
    }
    expect(reads).toBeGreaterThan(1)
    await expectHeldBack(plan.id, plan.paymentTxid)
    expect(storedRemovals()).toHaveLength(1)

    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()
    world.mine()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('the same wallet added again', () => {
  it('does not keep its earlier plan going: added again while the plan is left, the plan is ended at the unlock after a restart', async () => {
    const plan = await waitingPlan()
    const stop = refuseWritesDropping(entry => entry.id === plan.id)
    await removeWallet()
    // The same phrase is added again: a new slot, the same accounts.
    vault.push(signingWallet([account.pubkey, otherAccount.pubkey]))
    // No plan begins for the account while the record names it.
    await expect(world.prepare({ target: { kind: 'amount', amount: AMOUNT } })).rejects.toThrow(
      REMOVAL_UNDER_WAY
    )

    stop()
    await restartBackground()
    await unlockWallet()
    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])

    // Its plans begin again once the record is forgotten.
    world.fund(150, 100_000)
    world.mine()
    const next = await world.startPlan({ target: { kind: 'amount', amount: 25_000_000 } })
    world.mine()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(next.paymentTxid)
    world.assertRecipientGuarantees(25_000_000)
  })

  it('never ends a plan made after the record is forgotten: everything ended, the forgetting refused, then the wallet added again, a plan, and a restart', async () => {
    const plan = await waitingPlan()
    removalSteps.afterEmpty = async () => {
      preferenceFaults.refuse = true
    }
    expect(await removeWallet()).toEqual([])
    await expectEnded(plan.id)
    expect(storedRemovals()).toHaveLength(1)
    vault.push(signingWallet([account.pubkey, otherAccount.pubkey]))
    await expect(world.prepare({ target: { kind: 'amount', amount: AMOUNT } })).rejects.toThrow(
      REMOVAL_UNDER_WAY
    )

    // Storage takes the writes again: the next tick forgets the record.
    preferenceFaults.refuse = false
    await world.tick()
    expect(storedRemovals()).toBeUndefined()
    // A plan that waits for a merge, its payment signed, as the restart comes.
    world.fund(150, 100_000)
    world.mine()
    const next = await world.startPlan({ target: { kind: 'amount', amount: 25_000_000 } })
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])

    await restartBackground()
    await unlockWallet()
    expect(qbitSendPlanStore.get(next.id)).toMatchObject({ phase: 'waiting' })
    world.mine()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(next.paymentTxid)
    world.assertRecipientGuarantees(25_000_000)
  })
})

describe('a wallet the record is not about', () => {
  it('neither holds back nor shields a wallet that holds none of its accounts: its plan pays while the removed wallet’s is ended', async () => {
    world.fund(150, 100_000)
    fundAccount(stayingAccount, 150, 100_000)
    await world.open()
    const removed = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const staying = await startPlanOf(stayingAccount)
    const stop = refuseWritesDropping(entry => entry.id === removed.id)
    await removeWallet()
    stop()
    await restartBackground()

    // Locked, the merges confirm: the staying wallet's stored payment goes,
    // the removed wallet's does not.
    world.mine()
    await world.tick()
    expect(world.pushed).toContain(staying.paymentTxid)
    expect(world.pushed).not.toContain(removed.paymentTxid)

    await unlockWallet()
    await expectNoneBroadcastAfterwards([removed.paymentTxid])
    expect(qbitSendPlanStore.get(removed.id)).toBeUndefined()
    expect(storedRemovals()).toBeUndefined()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('neither holds back nor shields a wallet added in a slot a failed save gave back', async () => {
    world.fund(150, 100_000)
    fundAccount(newAccount, 150, 100_000)
    await world.open()
    const removed = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const stop = refuseWritesDropping(entry => entry.id === removed.id)
    await removeWallet()
    // A wallet's save fails and gives its slot back; another wallet takes it.
    vault.push(signingWallet([secondAccount.pubkey]))
    vault.pop()
    vault.push(signingWallet([newAccount.pubkey]))
    const added = await startPlanOf(newAccount)

    stop()
    await restartBackground()
    world.mine()
    await world.tick()
    expect(world.pushed).toContain(added.paymentTxid)
    expect(world.pushed).not.toContain(removed.paymentTxid)

    await unlockWallet()
    await expectNoneBroadcastAfterwards([removed.paymentTxid])
    expect(qbitSendPlanStore.get(removed.id)).toBeUndefined()
    expect(storedRemovals()).toBeUndefined()
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a record that cannot be stored', () => {
  it('refuses the removal: the wallet stays, its plan goes on, nothing is ended', async () => {
    const plan = await waitingPlan()
    const ending = vi.spyOn(world.engine, 'endPlansOf')
    const record = qbitSendPlanStore.get(plan.id) as QbitSendPlanRecord
    preferenceFaults.refuse = true
    await expect(startRemoval()).rejects.toThrow(
      'The wallet cannot be removed now: the record of its send plans could not be saved. Try again.'
    )
    expect(vault[0]).toMatchObject({ type: KeyringType.QbitHdKeyring })
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()
    expect(ending).not.toHaveBeenCalled()
    expect(qbitSendPlanStore.get(plan.id)).toEqual(record)
    expect(storedRemovals()).toBeUndefined()

    preferenceFaults.refuse = false
    world.mine()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('two removals, each leaving something', () => {
  beforeEach(() => {
    // Slot 0 and slot 1 are removed one after the other; slot 2 stays.
    vault.length = 0
    vault.push(
      signingWallet([account.pubkey]),
      signingWallet([secondAccount.pubkey]),
      signingWallet([stayingAccount.pubkey])
    )
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(2)
  })

  it('keeps a record for each, and each settles on its own, across restarts', async () => {
    world.fund(150, 100_000)
    fundAccount(secondAccount, 150, 100_000)
    await world.open()
    const first = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const second = await startPlanOf(secondAccount)
    const stopSecond = refuseWritesDropping(entry => entry.id === second.id)
    const stopFirst = refuseWritesDropping(entry => entry.id === first.id)
    await removeWallet(0)
    await removeWallet(1)
    const records = storedRemovals() as { id: string; wallet: { index: number } }[]
    expect(records.map(record => record.wallet.index)).toEqual([0, 1])

    await restartBackground()
    await unlockWallet()
    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid])
    expect(storedRemovals()).toHaveLength(2)

    // The second's plan can be ended: its record goes, the first's stays.
    stopSecond()
    await world.tick()
    expect(qbitSendPlanStore.get(second.id)).toBeUndefined()
    expect(storedRemovals()).toEqual([records[0]])

    await restartBackground()
    await unlockWallet()
    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid])
    expect(storedRemovals()).toEqual([records[0]])

    stopFirst()
    await world.tick()
    expect(qbitSendPlanStore.get(first.id)).toBeUndefined()
    expect(storedRemovals()).toBeUndefined()
    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('removal records stored by another version', () => {
  it('reads preferences without them as no record: plans go on', async () => {
    const plan = await waitingPlan()
    expect(storedRemovals()).toBeUndefined()
    await restartBackground()
    world.mine()
    await world.tick()
    expect(world.pushed).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('keeps a record of a later version, holds back the accounts it names, ends nothing of them, and never writes over it', async () => {
    const plan = await waitingPlan()
    const later = {
      version: 2,
      id: 'ab'.repeat(16),
      wallet: { slot: 'keyring_0' },
      accounts: [{ chain: CHAIN, address: account.address }],
      reason: 'a field this version does not know',
    }
    storeRemovals([later])
    await restartBackground()
    await unlockWallet()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectHeldBack(plan.id, plan.paymentTxid)
    // A removal this version makes writes beside it, and forgets its own.
    vault.push(signingWallet([newAccount.pubkey]))
    expect(await removeWallet(2)).toEqual([])
    expect(storedRemovals()).toEqual([later])
    await expectHeldBack(plan.id, plan.paymentTxid)
    world.assertRecipientGuarantees(undefined)
  })

  it('starts with a malformed value, holds back what it names, ends nothing, and keeps it', async () => {
    const plan = await waitingPlan()
    const malformed = {
      version: 1,
      id: 'not an id',
      wallet: { index: 0, type: KeyringType.QbitHdKeyring },
      accounts: [{ chain: CHAIN, address: account.address }],
    }
    storeRemovals([malformed, 'not a record'])
    await restartBackground()
    await unlockWallet()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    await expectHeldBack(plan.id, plan.paymentTxid)
    expect(storedRemovals()).toEqual([malformed, 'not a record'])
    world.assertRecipientGuarantees(undefined)
  })

  it('starts with a value that is not a list, holds nothing back for it, and keeps it', async () => {
    const plan = await waitingPlan()
    storeRemovals('not a list')
    await restartBackground()
    world.mine()
    await world.tick()
    expect(world.pushed).toContain(plan.paymentTxid)
    expect(storedRemovals()).toBe('not a list')
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a wallet reset while a record holds accounts back', () => {
  it('waits for the attempt to forget a record under way, and none begins while it runs', async () => {
    const plan = await waitingPlan()
    removalSteps.afterEmpty = async () => {
      preferenceFaults.refuse = true
    }
    await removeWallet()
    await expectEnded(plan.id)
    expect(storedRemovals()).toHaveLength(1)

    // The next attempt to forget the record waits in storage.
    preferenceFaults.refuse = false
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let arrive: () => void = () => undefined
    const reached = new Promise<void>(resolve => (arrive = resolve))
    const disk = (preferencesHolder.service as unknown as { storage: PreferenceDisk }).storage
    const set = disk.set.bind(disk)
    let writes = 0
    disk.set = async (key, value) => {
      writes += 1
      if (writes === 1) {
        arrive()
        await gate
      }
      return set(key, value)
    }
    await world.tick(undefined, { settle: false })
    await reached

    let halted = false
    const halting = world.engine.halt().then(() => {
      halted = true
    })
    for (let index = 0; index < 50; index++) await Promise.resolve()
    const haltedWhileWaiting = halted
    release()
    await halting
    expect(haltedWhileWaiting).toBe(false)
    expect(storedRemovals()).toBeUndefined()

    // While the reset runs, nothing settles a record or ends a plan.
    world.engine.onUnlock()
    await world.tick()
    expect(writes).toBe(1)
    await world.engine.resume()
    await world.settle()
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a removal of unknown outcome whose settling storage refused', () => {
  /** The writes of the vault with no change, by which such a removal is settled. */
  const settleWrites = (): number =>
    vi
      .mocked(keyringService.persistAllKeyrings)
      .mock.calls.filter(([changed]) => (changed as unknown[]).length === 0).length

  /** The warnings that such a write was refused. */
  const refusedNotes = (warn: { mock: { calls: unknown[][] } }): number =>
    warn.mock.calls.filter(([message]) =>
      String(message).includes('The vault could not be written to settle a wallet removal')
    ).length

  /** Let what a timer put on the chain-state queue run, and the plans settle. */
  async function queueRan(): Promise<void> {
    await (world.wallet as unknown as { chainStateChangeTail: Promise<void> }).chainStateChangeTail
    await world.settle()
  }

  /** A removal that fails once its checks passed, nothing removed, whose settling write is refused. */
  async function failedRemoval(refusals: 'once' | 'always'): Promise<void> {
    removalSteps.beforeEmpty = async () => {
      throw new Error('storage unavailable')
    }
    if (refusals === 'once') {
      vi.mocked(keyringService.persistAllKeyrings).mockRejectedValueOnce(
        new Error('storage unavailable')
      )
    } else {
      vi.mocked(keyringService.persistAllKeyrings).mockRejectedValue(
        new Error('storage unavailable')
      )
    }
    await expect(startRemoval()).rejects.toThrow('storage unavailable')
    delete removalSteps.beforeEmpty
    await queueRan()
    expect(settleWrites()).toBe(1)
    expect(storedRemovals()).toHaveLength(1)
  }

  it('is settled at the next try, 15 seconds on, with no lock or unlock, and then writes the vault no more', async () => {
    const plan = await waitingPlan()
    await failedRemoval('once')
    world.mine()

    // Storage works again; nobody locks or unlocks the wallet.
    await world.tick(14_999)
    await queueRan()
    expect(settleWrites()).toBe(1)
    await expectHeldBack(plan.id, plan.paymentTxid)
    await world.tick(1)
    await queueRan()
    expect(settleWrites()).toBe(2)
    expect(storedRemovals()).toBeUndefined()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)

    // Nothing is left to settle: the vault is not written for it again.
    for (let tick = 0; tick < 40; tick++) {
      await world.tick()
      await queueRan()
    }
    expect(settleWrites()).toBe(2)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('is tried on the spacing of a refused forget while storage refuses, its first refusal alone logged, never while locked, and at once at the unlock', async () => {
    await waitingPlan()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    await failedRemoval('always')
    const failedAt = Date.now()

    const tries: number[] = []
    let writes = settleWrites()
    for (let tick = 0; tick < 128; tick++) {
      await world.tick()
      await queueRan()
      if (settleWrites() !== writes) tries.push((Date.now() - failedAt) / 1000)
      writes = settleWrites()
    }
    expect(tries).toEqual([15, 45, 105, 225, 465, 945, 1425, 1905])
    expect(refusedNotes(warn)).toBe(1)
    expect(storedRemovals()).toHaveLength(1)

    // Locked, nothing is written, however long; the unlock tries at once.
    lockState.isUnlocked = false
    setSlots([])
    for (let tick = 0; tick < 64; tick++) {
      await world.tick()
      await queueRan()
    }
    expect(settleWrites()).toBe(writes)
    vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)
    await unlockWallet()
    expect(settleWrites()).toBe(writes + 1)
    expect(storedRemovals()).toBeUndefined()
  })

  it('starts its spacing and its log again for a later removal of unknown outcome, once one was settled', async () => {
    await waitingPlan()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    await failedRemoval('always')
    // Two more refusals: the next try would be 105 seconds after the failure.
    for (let tick = 0; tick < 3; tick++) {
      await world.tick()
      await queueRan()
    }
    expect(settleWrites()).toBe(3)
    // Storage works again, and an unlock settles it: the wallet is there.
    vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)
    lockState.isUnlocked = false
    setSlots([])
    await unlockWallet()
    expect(storedRemovals()).toBeUndefined()

    // A later removal fails the same way, storage refusing again.
    removalSteps.beforeEmpty = async () => {
      throw new Error('storage unavailable')
    }
    vi.mocked(keyringService.persistAllKeyrings).mockRejectedValue(new Error('storage unavailable'))
    await expect(startRemoval()).rejects.toThrow('storage unavailable')
    delete removalSteps.beforeEmpty
    await queueRan()
    const writes = settleWrites()
    await world.tick()
    await queueRan()
    expect(settleWrites()).toBe(writes + 1)
    expect(refusedNotes(warn)).toBe(2)
  })
})

describe('a removal of unknown outcome, then the same wallet removed again', () => {
  it('tells every page once, for what the user saw as one removal, and both records go once the plan is ended', async () => {
    const plan = await waitingPlan()
    removalSteps.beforeEmpty = async () => {
      throw new Error('storage unavailable')
    }
    vi.mocked(keyringService.persistAllKeyrings).mockRejectedValue(new Error('storage unavailable'))
    await expect(startRemoval()).rejects.toThrow('storage unavailable')
    await settleUnknownRemovals()
    expect(storedRemovals()).toHaveLength(1)
    delete removalSteps.beforeEmpty
    vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)

    // The user removes the wallet again; the plan's ending is refused.
    const stop = refuseWritesDropping(entry => entry.id === plan.id)
    expect(await removeWallet()).toHaveLength(1)
    await settleUnknownRemovals()
    expect(notices()).toEqual([{ plans: 1, unreadable: 0, storeUnavailable: false }])
    expect(storedRemovals()).toHaveLength(2)

    stop()
    await world.tick()
    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    expect(notices()).toHaveLength(1)
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a plan-store entry that names no account, left after a removal', () => {
  const ENTRY = 'b2'.repeat(16)

  /**
   * The plan store holds `entry`, which names no account; after a restart
   * and an unlock the wallet in slot 0 is removed, and the page shows the
   * wallet that stays.
   */
  async function removedBesideTheEntry(entry: object = { id: ENTRY }): Promise<void> {
    world.fund(150, 100_000)
    await world.open()
    world.storage.values.set(
      QBIT_SEND_PLAN_STORE_KEY,
      JSON.stringify({ version: 1, plans: [entry] })
    )
    await restartBackground()
    await unlockWallet()
    expect(await removeWallet()).toEqual([])
    expect(storedRemovals()).toHaveLength(1)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
  }

  /** The same phrase added again, in a new slot, its account selected. */
  function addedAgain(): void {
    vault.push(signingWallet([account.pubkey, otherAccount.pubkey]))
    setSlots(vault)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
  }

  // An entry naming only an address is shown to that address's account alone:
  // see 'plan-store entries that name only a network or only an address'.
  it.each([
    ['names nothing of an account', { id: ENTRY }],
    ['names a network but no address', { id: ENTRY, chain: CHAIN }],
  ])(
    'that %s is shown to the account of a wallet that stays, as a document of another version is, and is dropped there',
    async (_label, entry) => {
      await removedBesideTheEntry(entry)
      expect(await world.plan()).toMatchObject({
        id: ENTRY,
        address: stayingAccount.address,
        phase: 'paused',
        pause: { reason: 'unreadable' },
        actions: ['cancel'],
      })
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(newAccount as never)
      expect(await world.plan()).toMatchObject({ id: ENTRY, address: newAccount.address })

      expect(await world.wallet.cancelQbitSendPlan(ENTRY)).toBeNull()
      expect(storedEntries()).toEqual([])
      expect(await world.plan()).toBeNull()
      world.assertRecipientGuarantees(undefined)
    }
  )

  it('once dropped, lets the record go at the next kick: the same phrase added again can prepare a plan', async () => {
    await removedBesideTheEntry()
    await world.wallet.cancelQbitSendPlan(ENTRY)
    await world.tick()
    expect(storedRemovals()).toBeUndefined()

    addedAgain()
    const prepared = await world.prepare({ target: { kind: 'amount', amount: AMOUNT } })
    expect(prepared).toMatchObject({ ok: true })
    world.assertRecipientGuarantees(undefined)
  })

  it('stays as it was when storage refuses to drop it: shown, the record kept, nothing prepared', async () => {
    await removedBesideTheEntry()
    world.storage.failNextSet = new Error('storage unavailable')
    await expect(world.wallet.cancelQbitSendPlan(ENTRY)).rejects.toThrow('storage unavailable')
    expect(storedEntries()).toEqual([{ id: ENTRY }])
    expect(await world.plan()).toMatchObject({ id: ENTRY, pause: { reason: 'unreadable' } })

    for (let tick = 0; tick < 4; tick++) await world.tick()
    expect(storedRemovals()).toHaveLength(1)
    addedAgain()
    await expect(world.prepare({ target: { kind: 'amount', amount: AMOUNT } })).rejects.toThrow(
      REMOVAL_UNDER_WAY
    )
    world.assertRecipientGuarantees(undefined)
  })
})

describe('plan-store entries that name no account, beside an account’s own plan', () => {
  const ENTRY = 'b2'.repeat(16)
  const OTHER_ENTRY = 'c3'.repeat(16)

  /** Store `entries` beside what the plan store holds, as damage or another version would have. */
  function storeBeside(entries: object[]): void {
    const raw = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    const document = raw ? (JSON.parse(raw) as { plans: object[] }) : { version: 1, plans: [] }
    document.plans.push(...entries)
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
  }

  it('shows an account its own plan, which advances and pays in view, and shows each entry to an account with no plan, which cannot prepare one until it drops them', async () => {
    const plan = await waitingPlan()
    storeBeside([{ id: ENTRY }, { id: OTHER_ENTRY }])
    await restartBackground()
    await unlockWallet()

    const shown = await world.plan()
    expect(shown).toMatchObject({ id: plan.id, address: account.address })
    expect(shown?.pause?.reason).not.toBe('unreadable')
    world.mine()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })

    // The account of the wallet that stays has no plan: it is shown each
    // entry in turn, and refused a plan of its own until they are dropped.
    fundAccount(stayingAccount, 150, 100_000)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    expect(await world.plan()).toMatchObject({ id: ENTRY, pause: { reason: 'unreadable' } })
    const target = { target: { kind: 'amount', amount: AMOUNT } }
    expect(await world.prepare(target)).toMatchObject({ ok: false, reason: 'plan_open' })
    expect(await world.wallet.cancelQbitSendPlan(ENTRY)).toBeNull()
    expect(await world.plan()).toMatchObject({ id: OTHER_ENTRY, pause: { reason: 'unreadable' } })
    expect(await world.wallet.cancelQbitSendPlan(OTHER_ENTRY)).toBeNull()
    expect(await world.plan()).toBeNull()
    expect(storedEntries().map(entry => entry.id)).toEqual([plan.id])
    expect(await world.prepare(target)).toMatchObject({ ok: true })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('keeps a removal’s record until the entry is dropped: the account with a plan is shown the entry once its plan is completed and dismissed, and drops it there', async () => {
    fundAccount(stayingAccount, 150, 100_000)
    await world.open()
    const plan = await startPlanOf(stayingAccount)
    storeBeside([{ id: ENTRY }])
    await restartBackground()
    await unlockWallet()
    // The page shows the wallet that stays; the other one, with no plan, is removed.
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    expect(await removeWallet()).toEqual([])
    expect(storedRemovals()).toHaveLength(1)

    expect(await world.plan()).toMatchObject({ id: plan.id, address: stayingAccount.address })
    world.mine()
    await world.tick()
    await world.plan()
    expect(world.pushed).toContain(plan.paymentTxid)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })
    for (let tick = 0; tick < 3; tick++) await world.tick()
    expect(storedRemovals()).toHaveLength(1)

    // Dismissed, the plan gives way to the entry, which the account drops:
    // the record goes at the next kick.
    await world.wallet.dismissQbitSendPlan(plan.id)
    expect(await world.plan()).toMatchObject({ id: ENTRY, pause: { reason: 'unreadable' } })
    expect(await world.wallet.cancelQbitSendPlan(ENTRY)).toBeNull()
    expect(storedRemovals()).toHaveLength(1)
    await world.tick()
    expect(storedRemovals()).toBeUndefined()
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a removal that also settles an earlier one of the same wallet', () => {
  /**
   * The wallet in slot 0 signs for the world's account and another, each
   * with a plan. Its first removal, while it lists the accounts `first`
   * names, fails once its checks passed, and the write that would settle
   * it is refused; its second, while it lists those `second` names,
   * succeeds. Storage refuses the endings of the plans `refused` names.
   */
  async function removedTwice(
    refused: (plans: { own: string; other: string }) => string[],
    listed = { first: [account.pubkey, otherAccount.pubkey], second: [account.pubkey] }
  ) {
    world.fund(150, 100_000)
    fundAccount(otherAccount, 150, 100_000)
    await world.open()
    const own = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const other = await startPlanOf(otherAccount)
    ;(vault[0] as { listedPubkeys: string[] }).listedPubkeys = listed.first
    removalSteps.beforeEmpty = async () => {
      throw new Error('storage unavailable')
    }
    vi.mocked(keyringService.persistAllKeyrings).mockRejectedValue(new Error('storage unavailable'))
    await expect(startRemoval()).rejects.toThrow('storage unavailable')
    await settleUnknownRemovals()
    delete removalSteps.beforeEmpty
    vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)
    ;(vault[0] as { listedPubkeys: string[] }).listedPubkeys = listed.second
    const ids = refused({ own: own.id, other: other.id })
    const stop = refuseWritesDropping(entry => ids.includes(entry.id ?? ''))
    await removeWallet()
    await settleUnknownRemovals()
    return { own, other, stop }
  }

  it('tells every page once of a plan left of an account only the earlier removal named', async () => {
    const { own, other, stop } = await removedTwice(plans => [plans.other])
    expect(notices()).toEqual([{ plans: 1, unreadable: 0, storeUnavailable: false }])
    expect(qbitSendPlanStore.get(own.id)).toBeUndefined()
    expect(qbitSendPlanStore.get(other.id)).toBeDefined()

    stop()
    await world.tick()
    await expectEnded(other.id)
    expect(storedRemovals()).toBeUndefined()
    expect(notices()).toHaveLength(1)
    await expectNoneBroadcastAfterwards([own.paymentTxid, other.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })

  it('tells every page once of a plan left of an account only the later removal named', async () => {
    const { own, other, stop } = await removedTwice(plans => [plans.other], {
      first: [account.pubkey],
      second: [account.pubkey, otherAccount.pubkey],
    })
    expect(notices()).toEqual([{ plans: 1, unreadable: 0, storeUnavailable: false }])
    expect(qbitSendPlanStore.get(own.id)).toBeUndefined()

    stop()
    await world.tick()
    await expectEnded(other.id)
    expect(storedRemovals()).toBeUndefined()
    expect(notices()).toHaveLength(1)
    world.assertRecipientGuarantees(undefined)
  })

  it('tells every page once, counting what is left of both removals’ accounts', async () => {
    const { own, other, stop } = await removedTwice(plans => [plans.own, plans.other])
    expect(notices()).toEqual([{ plans: 2, unreadable: 0, storeUnavailable: false }])

    stop()
    await world.tick()
    expect(qbitSendPlanStore.get(own.id)).toBeUndefined()
    expect(qbitSendPlanStore.get(other.id)).toBeUndefined()
    expect(storedRemovals()).toBeUndefined()
    expect(notices()).toHaveLength(1)
    await expectNoneBroadcastAfterwards([own.paymentTxid, other.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * A removal of the wallet in slot `index` that, once begun, stores its
 * record and then waits in the keyring service until `settle` says whether
 * the keyring service refuses it before removing anything or removes the
 * wallet.
 */
function removalOnHold(index = 0) {
  let decide: (outcome: 'refused' | 'removed') => void = () => undefined
  const decided = new Promise<'refused' | 'removed'>(resolve => (decide = resolve))
  const remove = vi.mocked(keyringService.removeKeyring).getMockImplementation() as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>
  vi.mocked(keyringService.removeKeyring).mockImplementationOnce((async (...args: unknown[]) => {
    if ((await decided) === 'refused') {
      throw new Error('no_keyring_found_for_the_requested_account')
    }
    return remove(...args)
  }) as never)
  let result: Promise<string> = Promise.resolve('not begun')
  return {
    /** Begin it; resolves once its record is stored. */
    begin: async (): Promise<void> => {
      result = startRemoval(index).then(
        () => 'removed',
        (error: Error) => error.message
      )
      await vi.waitFor(() => expect(storedRemovals()).toHaveLength(1))
    },
    /** Let the keyring service refuse it or remove the wallet; resolves to how it ended. */
    settle: async (outcome: 'refused' | 'removed'): Promise<string> => {
      decide(outcome)
      const ended = await result
      await world.settle()
      return ended
    },
  }
}

/** The plan store's next write waits for `step` first. */
function beforeNextPlanWrite(step: () => Promise<void>): void {
  const set = world.storage.set.bind(world.storage)
  let first = true
  world.storage.set = async (key, value) => {
    if (first) {
      first = false
      await step()
    }
    return set(key, value)
  }
}

/** Mine and tick `blocks` times, a page reading the plan after each. */
async function confirmBlocks(blocks: number): Promise<void> {
  for (let block = 0; block < blocks; block++) {
    world.mine()
    await world.tick()
    await world.plan()
  }
}

describe('work under way for an account when a removal of its wallet stores its record', () => {
  /** A review whose plan's first signature waits on the page's confirmed restored-floor challenge. */
  async function confirmedReview() {
    world.keyring.restoredFloor = true
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    return review
  }

  /** The removal stores its record once a start has stored and set going its plan, before its first signature. */
  function beginBeforeTheFirstSignature(removal: { begin: () => Promise<void> }): void {
    const guard = guardHolder.guard as { assertNoOverlap: (...args: unknown[]) => Promise<unknown> }
    const assertNoOverlap = guard.assertNoOverlap.bind(guard)
    vi.spyOn(guard, 'assertNoOverlap').mockImplementationOnce(async (...args: unknown[]) => {
      await removal.begin()
      return assertNoOverlap(...args)
    })
  }

  it('lets a start awaiting its first signature go on: it is answered as started, its payment is not sent while the record stands, and once the removal is refused it pays', async () => {
    const review = await confirmedReview()
    const removal = removalOnHold()
    beginBeforeTheFirstSignature(removal)
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    await confirmBlocks(2)
    const paidWhileRecorded = world.pushed.includes(review.payment.txid)

    expect(await removal.settle('refused')).toBe('no_keyring_found_for_the_requested_account')
    expect(storedRemovals()).toBeUndefined()
    await confirmBlocks(2)
    expect({
      answered: started.ok ? 'started' : started.reason,
      paidWhileRecorded,
      paid: world.pushed.includes(review.payment.txid),
    }).toEqual({ answered: 'started', paidWhileRecorded: false, paid: true })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('lets a start awaiting its first signature go on until the removal ends it: answered as started, then ended with the wallet, nothing of its payment sent', async () => {
    const review = await confirmedReview()
    const removal = removalOnHold()
    beginBeforeTheFirstSignature(removal)
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started).toMatchObject({ ok: true })

    expect(await removal.settle('removed')).toBe('removed')
    await expectEnded(started.ok ? started.plan.id : '')
    await expectNoneBroadcastAfterwards([review.payment.txid])
    world.assertRecipientGuarantees(undefined)
  })

  it('begins no plan for the account while the record stands: a start of a review made before it is refused, nothing written, and plans begin again once the record goes', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    const removal = removalOnHold()
    await removal.begin()

    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    await expect(world.prepare({ target: { kind: 'amount', amount: AMOUNT } })).rejects.toThrow(
      REMOVAL_UNDER_WAY
    )

    expect(await removal.settle('refused')).toBe('no_keyring_found_for_the_requested_account')
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    await confirmBlocks(2)
    expect(world.pushed).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('lets a continue under way go on: it is answered as continued, and once the removal is refused the plan pays', async () => {
    world.fund(150, 100_000)
    await world.open()
    // The wallet locks at the plan's first signature, and the worker starts
    // again: the plan waits for the user's continue.
    world.keyring.beforeInput = async () => {
      world.keyring.beforeInput = undefined
      await world.wallet.lockWallet()
    }
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    await restartBackground()
    await unlockWallet()
    const view = (await world.plan())!
    expect(view).toMatchObject({ id: plan.id, phase: 'paused', pause: { reason: 'interrupted' } })

    const removal = removalOnHold()
    beforeNextPlanWrite(() => removal.begin())
    const continued = await world.wallet
      .continueQbitSendPlan(view.id, world.shownTerms(view.id))
      .then(
        () => 'continued',
        (error: Error) => error.message
      )
    expect(await removal.settle('refused')).toBe('no_keyring_found_for_the_requested_account')
    await confirmBlocks(3)
    expect({ continued, paid: world.pushed.includes(plan.paymentTxid) }).toEqual({
      continued: 'continued',
      paid: true,
    })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('lets a fee raise under way go on: it is answered as started, and once the removal is refused the raised merge goes and the plan pays', async () => {
    world.fund(150, 1_000_000)
    await world.open()
    world.explorer.acceptReplacements = true
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 120_000_000 } })
    await world.tick(QBIT_SEND_PLAN_SLOW_MERGE_MS + 60_000)
    const view = (await world.plan())!
    expect(view).toMatchObject({ id: plan.id, phase: 'waiting', slowMerge: true })
    const merge = view.steps[0]!.txid
    const raise = await world.review({
      target: { kind: 'amount', amount: 120_000_000 },
      feeRate: 2,
      revise: { planId: view.id, kind: 'raise_merge_fee' },
    })

    const removal = removalOnHold()
    beforeNextPlanWrite(() => removal.begin())
    const started = await world.wallet.startQbitSendPlan(raise.draftId)
    expect(await removal.settle('refused')).toBe('no_keyring_found_for_the_requested_account')
    await confirmBlocks(3)
    const replacement =
      world.storedPlans()[0]?.steps[0]?.txid ?? qbitSendPlanStore.get(plan.id)?.steps[0]?.txid
    expect({
      answered: started.ok ? 'started' : started.reason,
      raised: replacement !== undefined && replacement !== merge,
      paid: world.pushed.includes(raise.payment.txid),
    }).toEqual({ answered: 'started', raised: true, paid: true })
  })
})

describe('a record restored at start-up, and a later removal of the same wallet', () => {
  it('judges the record at the first unlock, before any removal can run, and a kick while a later removal has emptied the slot in memory only ends nothing', async () => {
    const plan = await waitingPlan()
    // An earlier removal of the wallet was refused before it removed
    // anything, storage refusing to take its record back; the worker starts
    // again before a later try.
    removalSteps.refuse = () => {
      preferenceFaults.refuse = true
      return new Error('no_keyring_found_for_the_requested_account')
    }
    await expect(startRemoval()).rejects.toThrow('no_keyring_found_for_the_requested_account')
    delete removalSteps.refuse
    preferenceFaults.refuse = false
    expect(storedRemovals()).toHaveLength(1)
    await restartBackground()
    await expectHeldBack(plan.id, plan.paymentTxid)

    // The unlock judges it from the slots, where the wallet is: it goes.
    await unlockWallet()
    const goneAtUnlock = storedRemovals() === undefined

    // The wallet is removed again: its slot is emptied in memory, a tick
    // kicks the plans, and the vault write fails, the keyring service
    // putting the wallet back.
    const removed = vault[0]!
    removalSteps.afterEmpty = async () => {
      await world.tick()
      vault[0] = removed
      throw new Error('storage unavailable')
    }
    await expect(startRemoval()).rejects.toThrow('storage unavailable')
    delete removalSteps.afterEmpty
    const keptThroughTheRemoval = qbitSendPlanStore.get(plan.id) !== undefined
    await settleUnknownRemovals()

    // Nothing of the plan was ended: it goes on, and pays.
    await confirmBlocks(2)
    expect({
      goneAtUnlock,
      keptThroughTheRemoval,
      records: storedRemovals(),
      paid: world.pushed.includes(plan.paymentTxid),
    }).toEqual({ goneAtUnlock: true, keptThroughTheRemoval: true, records: undefined, paid: true })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a prepare for an account a removal record holds', () => {
  it('tells the same phrase added again that a wallet removal involving the account has not finished, after a restart too, and an account the wallet does not sign for that it needs one', async () => {
    const plan = await waitingPlan()
    const stop = refuseWritesDropping(entry => entry.id === plan.id)
    expect(await removeWallet()).toHaveLength(1)
    // The same phrase is added again, in a new slot.
    vault.push(signingWallet([account.pubkey, otherAccount.pubkey]))
    const target = { target: { kind: 'amount', amount: AMOUNT } }
    await expect(world.prepare(target)).rejects.toThrow(REMOVAL_UNDER_WAY)

    await restartBackground()
    await unlockWallet()
    await expect(world.prepare(target)).rejects.toThrow(REMOVAL_UNDER_WAY)
    // The same address in a wallet that only reads it: no wallet here signs for it.
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({
      ...account,
      type: KeyringType.ReadonlyKeyring,
    } as never)
    await expect(world.prepare(target)).rejects.toThrow(ACCOUNT_REQUIRED)

    // Once the plan is ended the record goes, and the account is answered as
    // any is: here, that its merge, sent before the removal, is unconfirmed.
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
    stop()
    await world.tick()
    expect(storedRemovals()).toBeUndefined()
    expect(await world.prepare(target)).toMatchObject({
      ok: false,
      reason: 'insufficient_balance',
    })
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a kick while a removal of unknown outcome is settled as removed', () => {
  /**
   * The verdicts the engine got for removal records, and the endings of
   * stored plans it ran for `owner`'s account, from here on.
   */
  function watchJudgements(owner: { address: string }) {
    const judge = vi.spyOn(
      world.wallet as unknown as { judgeQbitSendPlanRemoval: (id: string) => unknown },
      'judgeQbitSendPlanRemoval'
    )
    const ending = vi.spyOn(
      world.engine as unknown as {
        endStoredPlansOf: (accounts: ReadonlySet<string>) => Promise<unknown>
      },
      'endStoredPlansOf'
    )
    return {
      verdicts: () => judge.mock.results.map(result => result.value),
      endings: () =>
        ending.mock.calls.filter(([accounts]) =>
          [...accounts].some(key => key.endsWith(`:${owner.address}`))
        ).length,
    }
  }

  /** Storage holds the write that drops plan `planId` until a tick has kicked the plans; resolves to the verdicts got meanwhile. */
  function kickWhileDropping(planId: string, watch: { verdicts: () => unknown[] }) {
    const set = world.storage.set.bind(world.storage)
    let during: unknown[] | undefined
    world.storage.set = async (key, value) => {
      if (
        during === undefined &&
        key === QBIT_SEND_PLAN_STORE_KEY &&
        leavesOut(value, entry => entry.id === planId)
      ) {
        const before = watch.verdicts().length
        await world.tick(undefined, { settle: false })
        during = watch.verdicts().slice(before)
      }
      return set(key, value)
    }
    return () => during
  }

  it('judges nothing in the settling’s ending, which alone ends the plans', async () => {
    const plan = await waitingPlan()
    const watch = watchJudgements(account)
    const verdictsDuring = kickWhileDropping(plan.id, watch)
    // The removal fails once its vault write landed: its outcome is unknown
    // until the settling finds the slot empty.
    removalSteps.afterEmpty = async () => {
      throw new Error('memory store refresh failed')
    }
    await expect(startRemoval()).rejects.toThrow('memory store refresh failed')
    delete removalSteps.afterEmpty
    await settleUnknownRemovals()

    await expectEnded(plan.id)
    expect(storedRemovals()).toBeUndefined()
    expect({ verdictsDuring: verdictsDuring(), endings: watch.endings() }).toEqual({
      verdictsDuring: [undefined],
      endings: 1,
    })
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })

  it('judges nothing in the ending of an earlier removal of the same wallet, settled with a later one', async () => {
    world.fund(150, 100_000)
    fundAccount(otherAccount, 150, 100_000)
    await world.open()
    const own = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const other = await startPlanOf(otherAccount)
    // The first removal fails once its checks passed, its settling refused.
    removalSteps.beforeEmpty = async () => {
      throw new Error('storage unavailable')
    }
    vi.mocked(keyringService.persistAllKeyrings).mockRejectedValue(new Error('storage unavailable'))
    await expect(startRemoval()).rejects.toThrow('storage unavailable')
    await settleUnknownRemovals()
    delete removalSteps.beforeEmpty
    vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)

    // The second, which succeeds, no longer lists the other account: its
    // plan is ended as the earlier removal is settled with this one.
    ;(vault[0] as { listedPubkeys: string[] }).listedPubkeys = [account.pubkey]
    const watch = watchJudgements(otherAccount)
    const verdictsDuring = kickWhileDropping(other.id, watch)
    await removeWallet()
    await settleUnknownRemovals()

    expect(qbitSendPlanStore.get(own.id)).toBeUndefined()
    await expectEnded(other.id)
    expect(storedRemovals()).toBeUndefined()
    expect({ verdictsDuring: verdictsDuring(), endings: watch.endings() }).toEqual({
      verdictsDuring: [undefined],
      endings: 1,
    })
    await expectNoneBroadcastAfterwards([own.paymentTxid, other.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('plan-store entries that name only a network or only an address', () => {
  const ENTRY = 'd5'.repeat(16)
  const target = { target: { kind: 'amount', amount: AMOUNT } }

  /** The plan store holds `entry` beside what it holds; the worker starts again, and is unlocked. */
  async function storedBeside(entry: object): Promise<void> {
    world.fund(150, 100_000)
    await world.open()
    const raw = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    const document = raw ? (JSON.parse(raw) as { plans: object[] }) : { version: 1, plans: [] }
    document.plans.push(entry)
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await restartBackground()
    await unlockWallet()
  }

  /**
   * What the selected account is shown, what its prepare is answered, and
   * what its cancel of the entry does, in that order.
   */
  async function seenByTheAccount() {
    const shown = (await world.plan())?.id
    const prepared = await world.prepare(target)
    const cancel = await world.wallet.cancelQbitSendPlan(ENTRY).then(
      () => 'dropped',
      (error: Error) => error.message
    )
    return { shown, prepared: prepared.ok ? 'review' : prepared.reason, cancel }
  }

  /** `owner`'s account on testnet4, selected there; resolves to its address. */
  function selectedOnTestnet4(owner: { pubkey: string }): string {
    const address = p2mrAddressFromPubkey(hexToBytes(owner.pubkey), 'testnet4')
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({ ...owner, address } as never)
    return address
  }

  it('shows an entry naming only another network to no account of this one, which prepares as if it were not there and cannot drop it; an account of that network is shown it and drops it', async () => {
    const entry = { id: ENTRY, chain: ChainType.QBIT_TESTNET4 }
    await storedBeside(entry)

    expect({ ...(await seenByTheAccount()), stored: storedEntries() }).toEqual({
      shown: undefined,
      prepared: 'review',
      cancel: 'The Qbit send plan is not open',
      stored: [entry],
    })

    const address = selectedOnTestnet4(stayingAccount)
    expect(await world.plan()).toMatchObject({
      id: ENTRY,
      address,
      pause: { reason: 'unreadable' },
    })
    expect(await world.wallet.cancelQbitSendPlan(ENTRY)).toBeNull()
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('shows an entry naming only an address to the account of that address alone', async () => {
    const entry = { id: ENTRY, account: { address: stayingAccount.address } }
    await storedBeside(entry)

    // The world's account has another address: it is not shown the entry,
    // prepares as if it were not there, and cannot drop it.
    expect({ ...(await seenByTheAccount()), stored: storedEntries() }).toEqual({
      shown: undefined,
      prepared: 'review',
      cancel: 'The Qbit send plan is not open',
      stored: [entry],
    })

    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    expect(await world.plan()).toMatchObject({
      id: ENTRY,
      address: stayingAccount.address,
      pause: { reason: 'unreadable' },
    })
    expect(await world.wallet.cancelQbitSendPlan(ENTRY)).toBeNull()
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps no removal’s record for an entry that cannot be the plan of one of its accounts, which no account in the wallet is shown', async () => {
    // An entry naming the address of no account in the wallet.
    const entry = { id: ENTRY, account: { address: newAccount.address } }
    await storedBeside(entry)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    expect(await removeWallet()).toEqual([])
    expect(storedRemovals()).toBeUndefined()
    // The removal does not drop it: it is no plan of the removed wallet.
    expect(storedEntries()).toEqual([entry])
    expect(await world.plan()).toBeNull()
    world.assertRecipientGuarantees(undefined)
  })
})

/** The plan store holds `entries` beside what it holds; the worker starts again, and is unlocked. */
async function restartWithEntries(...entries: object[]): Promise<void> {
  const raw = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
  const document = raw ? (JSON.parse(raw) as { plans: object[] }) : { version: 1, plans: [] }
  document.plans.push(...entries)
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
  await restartBackground()
  await unlockWallet()
}

/** `owner`'s address on testnet4. */
function testnet4AddressOf(owner: { pubkey: string }): string {
  return p2mrAddressFromPubkey(hexToBytes(owner.pubkey), 'testnet4')
}

describe('an unreadable entry naming only an address of the removed wallet', () => {
  const ENTRY = 'e6'.repeat(16)
  const target = { target: { kind: 'amount', amount: AMOUNT } }

  it.each([
    ['the account the same phrase brings back', () => account.address],
    ['another of its accounts on this network', () => otherAccount.address],
    ['one of its accounts on another network', () => testnet4AddressOf(account)],
  ])(
    'is dropped by the removal when it names %s: its record goes, and the same phrase added again with fewer accounts can prepare',
    async (_label, address) => {
      world.fund(150, 100_000)
      await world.open()
      await restartWithEntries({ id: ENTRY, account: { address: address() } })
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
      expect(await removeWallet()).toEqual([])
      expect({ entries: storedEntries(), records: storedRemovals() }).toEqual({
        entries: [],
        records: undefined,
      })

      // The same phrase added again, listing the world's account alone.
      vault.push(signingWallet([account.pubkey]))
      setSlots(vault)
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
      expect(await world.prepare(target)).toMatchObject({ ok: true })
      world.assertRecipientGuarantees(undefined)
    }
  )

  it('is counted as left when storage refuses to drop it: every page is told, and a later kick drops it and lets the record go', async () => {
    world.fund(150, 100_000)
    await world.open()
    await restartWithEntries({ id: ENTRY, account: { address: otherAccount.address } })
    const stop = refuseWritesDropping(entry => entry.id === ENTRY)
    await removeWallet()
    expect(notices()).toEqual([{ plans: 0, unreadable: 1, storeUnavailable: false }])
    expect(storedRemovals()).toHaveLength(1)

    stop()
    await world.tick()
    expect(storedEntries()).toEqual([])
    expect(storedRemovals()).toBeUndefined()
    expect(notices()).toHaveLength(1)
    world.assertRecipientGuarantees(undefined)
  })

  it('is left alone when it names an account of a wallet that stays: the removal neither drops it nor waits for it', async () => {
    world.fund(150, 100_000)
    await world.open()
    const entry = { id: ENTRY, account: { address: stayingAccount.address } }
    await restartWithEntries(entry)
    expect(await removeWallet()).toEqual([])
    expect(storedEntries()).toEqual([entry])
    expect(storedRemovals()).toBeUndefined()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    expect(await world.plan()).toMatchObject({ id: ENTRY, address: stayingAccount.address })
    world.assertRecipientGuarantees(undefined)
  })

  it('is left alone when it names an account a wallet that stays signs for too, which the record leaves out', async () => {
    // The wallet that stays lists the removed wallet's other key as well.
    vault[1] = signingWallet([stayingAccount.pubkey, otherAccount.pubkey])
    world.fund(150, 100_000)
    await world.open()
    const entry = { id: ENTRY, account: { address: otherAccount.address } }
    await restartWithEntries(entry)
    expect(await removeWallet()).toEqual([])
    expect(storedEntries()).toEqual([entry])
    expect(storedRemovals()).toBeUndefined()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as never)
    expect(await world.plan()).toMatchObject({ id: ENTRY, address: otherAccount.address })
    world.assertRecipientGuarantees(undefined)
  })

  it('is dropped only once the wallet is known removed: not by a removal refused, nor while a removal’s outcome is unknown, nor while locked after a restart', async () => {
    world.fund(150, 100_000)
    await world.open()
    const entry = { id: ENTRY, account: { address: otherAccount.address } }
    await restartWithEntries(entry)

    // Refused before it removed anything: the wallet stays, and so does the entry.
    removalSteps.refuse = () => new Error('no_keyring_found_for_the_requested_account')
    await expect(startRemoval()).rejects.toThrow('no_keyring_found_for_the_requested_account')
    delete removalSteps.refuse
    expect(storedEntries()).toEqual([entry])

    // Failed once its vault write landed, the write that would settle it refused.
    removalSteps.afterEmpty = async () => {
      throw new Error('memory store refresh failed')
    }
    vi.mocked(keyringService.persistAllKeyrings).mockRejectedValue(new Error('storage unavailable'))
    await expect(startRemoval()).rejects.toThrow('memory store refresh failed')
    delete removalSteps.afterEmpty
    await settleUnknownRemovals()
    for (let tick = 0; tick < 3; tick++) await world.tick()
    expect(storedEntries()).toEqual([entry])

    // The worker starts again: locked, the record is not judged.
    await restartBackground()
    for (let tick = 0; tick < 3; tick++) await world.tick()
    expect(storedEntries()).toEqual([entry])

    // The unlock finds the wallet gone: the entry goes with the record.
    vi.mocked(keyringService.persistAllKeyrings).mockImplementation((async () => true) as never)
    await unlockWallet()
    expect({ entries: storedEntries(), records: storedRemovals() }).toEqual({
      entries: [],
      records: undefined,
    })
    world.assertRecipientGuarantees(undefined)
  })
})

describe('unreadable entries naming part of an account: the networks they are on, and the plans they wait behind', () => {
  const ENTRY = 'f7'.repeat(16)
  const OTHER_ENTRY = 'a8'.repeat(16)
  const ALL = [ChainType.QBIT_MAINNET, ChainType.QBIT_TESTNET4, CHAIN]

  it('counts an entry naming an address that is no plan address of any network on none: shown to nobody, it keeps no network from being held for a removal (holdNetworksIfIdle)', async () => {
    world.fund(150, 100_000)
    await world.open()
    const entry = { id: ENTRY, account: { address: 'notAnAddressOfAnyNetwork0' } }
    await restartWithEntries(entry)
    expect(await world.plan()).toBeNull()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    expect(await world.plan()).toBeNull()

    const release = world.engine.holdNetworksIfIdle(ALL)
    expect(release).toBeTypeOf('function')
    release?.()
    expect(storedEntries()).toEqual([entry])
    world.assertRecipientGuarantees(undefined)
  })

  it('counts an entry naming no network and no address on every network', async () => {
    world.fund(150, 100_000)
    await world.open()
    await restartWithEntries({ id: ENTRY })
    for (const chain of ALL) expect(world.engine.holdNetworksIfIdle([chain])).toBeUndefined()
    world.assertRecipientGuarantees(undefined)
  })

  it('counts an entry naming an address of one network on that network alone', async () => {
    world.fund(150, 100_000)
    await world.open()
    await restartWithEntries({ id: ENTRY, account: { address: testnet4AddressOf(newAccount) } })

    expect(world.engine.holdNetworksIfIdle([ChainType.QBIT_TESTNET4])).toBeUndefined()
    const release = world.engine.holdNetworksIfIdle([ChainType.QBIT_MAINNET, CHAIN])
    expect(release).toBeTypeOf('function')
    release?.()
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps a removal’s record for an entry naming only another network, which no account of this network is shown and an account of that network drops', async () => {
    world.fund(150, 100_000)
    await world.open()
    await restartWithEntries({ id: ENTRY, chain: ChainType.QBIT_TESTNET4 })
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    expect(await removeWallet()).toEqual([])
    expect(storedRemovals()).toHaveLength(1)
    expect(await world.plan()).toBeNull()

    const address = testnet4AddressOf(stayingAccount)
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue({
      ...stayingAccount,
      address,
    } as never)
    expect(await world.plan()).toMatchObject({ id: ENTRY, address })
    expect(await world.wallet.cancelQbitSendPlan(ENTRY)).toBeNull()
    await world.tick()
    expect(storedRemovals()).toBeUndefined()
    world.assertRecipientGuarantees(undefined)
  })

  it('shows an account its own plan before an entry naming only its network or only its address, and each of those once the plan is dismissed', async () => {
    const plan = await waitingPlan()
    await restartWithEntries(
      { id: ENTRY, chain: CHAIN },
      { id: OTHER_ENTRY, account: { address: account.address } }
    )
    expect(await world.plan()).toMatchObject({ id: plan.id })
    await confirmBlocks(2)
    expect(world.pushed).toContain(plan.paymentTxid)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })

    await world.wallet.dismissQbitSendPlan(plan.id)
    const shown: string[] = []
    for (let entry = 0; entry < 2; entry++) {
      const view = (await world.plan())!
      expect(view).toMatchObject({ pause: { reason: 'unreadable' } })
      shown.push(view.id)
      expect(await world.wallet.cancelQbitSendPlan(view.id)).toBeNull()
    }
    expect(shown.sort()).toEqual([ENTRY, OTHER_ENTRY].sort())
    expect(await world.plan()).toBeNull()
    world.assertRecipientGuarantees(AMOUNT)
  })
})
