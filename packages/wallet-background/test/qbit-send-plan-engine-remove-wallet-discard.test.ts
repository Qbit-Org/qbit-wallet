import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hexToBytes, p2mrAddressFromPubkey } from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { keyringService, preferenceService } from '../src/services'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_STORE_KEY,
  type QbitSendPlanRecord,
} from '../src/services/qbitSendPlanStore'
import { fakeTxid } from './qbit-fake-explorer'
import {
  CHAIN,
  T0,
  World,
  account,
  anotherAccountsPlan,
  newPlanGuard,
  p2mrAccount,
  watchPlanAnnouncements,
  wirePlanKeyring,
  type QbitSendPlanAccount,
} from './qbit-send-plan-engine-harness'

// Removing a wallet ends the send plans of the accounts it held (#188), and
// a storage write refused on the way stops none of it (#206): an entry the
// store cannot read that cannot be dropped, or a plan whose ending cannot be
// written, is named in what the removal reports, and every other entry and
// plan of the wallet is ended all the same. The removal itself stands. What
// could not be ended is held back: nothing of it is signed or broadcast, no
// work begins for its account, and an entry made readable meanwhile is not
// taken up as a plan that goes on. While the background runs, it is ended
// again at every tick until storage takes the write, its holds going with
// it, and what is left is logged when it changes, not at every tick. A wallet
// reset waits for such an attempt under way, and none begins while it runs.

const lockState = vi.hoisted(() => ({ isUnlocked: true }))
const guardHolder = vi.hoisted(() => ({ guard: undefined as unknown as object }))
vi.mock('../src/services', async () => {
  const { QbitSendGuardService } = await import('../src/services/qbitSendGuards')
  guardHolder.guard = new QbitSendGuardService()
  const guard = new Proxy(
    {},
    {
      get: (_target, property) => {
        const value = (guardHolder.guard as Record<PropertyKey, unknown>)[property]
        return typeof value === 'function' ? value.bind(guardHolder.guard) : value
      },
    }
  )
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
      // What a wallet removal reads and does (see `removeWallet`).
      getAllDisplayedKeyrings: vi.fn(async () => []),
      getQbitRecoveryVaultState: vi.fn(async () => undefined),
      createTmpKeyring: vi.fn(),
      removeKeyring: vi.fn(),
    },
    preferenceService: {
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
    },
    qbitSendGuardService: guard,
    sessionService: { broadcastEvent: vi.fn() },
    contactBookService: { listAlias: vi.fn(() => []) },
    permissionService: {},
  }
})
vi.mock('../src/services/approval', () => ({ default: {} }))

let world: World
let worlds: World[] = []

function newGuard(): void {
  newPlanGuard(guardHolder)
}

function freshWorld(): World {
  if (world?.wallet) world.engine.reset()
  newGuard()
  lockState.isUnlocked = true
  const next = new World(lockState, newGuard)
  worlds.push(next)
  wirePlanKeyring(next)
  return next
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.clearAllMocks()
  lockState.isUnlocked = true
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
  vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
  world = freshWorld()
  watchPlanAnnouncements(() => world)
})

afterEach(async () => {
  for (const each of worlds) each.assertGuarantees()
  worlds = []
  if (world?.wallet) world.engine.reset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Another account of the removed wallet, on the same network. */
const otherAccount = p2mrAccount('22'.repeat(32))
/** A third account of the removed wallet. */
const thirdAccount = p2mrAccount('23'.repeat(32))
/** The account of a wallet that stays. */
const stayingAccount = p2mrAccount('77'.repeat(32))

/** What the removal hands the engine: every account of the removed wallet, by network and address. */
const REMOVED = [account, otherAccount, thirdAccount].map(owner => ({
  chain: CHAIN,
  address: owner.address,
}))

/** Ids of entries the store cannot read. */
const UNREADABLE_ID = 'd4'.repeat(16)
const SECOND_UNREADABLE_ID = 'e5'.repeat(16)
/** Another plan id, for a second entry of the same plan. */
const COPY_ID = 'c3'.repeat(16)

const AMOUNT = 12_000_000

type StoredEntry = { id?: string; account?: { address?: string } }

/** The entries of the stored document, as storage holds them. */
function storedEntries(): StoredEntry[] {
  const raw = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
  return raw ? (JSON.parse(raw) as { plans: StoredEntry[] }).plans : []
}

/** The stored record of plan `planId`, as storage holds it. */
function storedRecord(planId: string): QbitSendPlanRecord {
  return storedEntries().find(entry => entry.id === planId) as unknown as QbitSendPlanRecord
}

/** An entry this version cannot read, filed under `owner` on the test network. */
function unreadableEntry(id: string, owner: QbitSendPlanAccount): StoredEntry {
  return { id, chain: CHAIN, account: { address: owner.address } } as StoredEntry
}

/** Store `plans` as the whole document, as a document changed on disk is, and restart. */
async function restartWith(plans: readonly unknown[]): Promise<void> {
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify({ version: 1, plans }))
  await world.restart()
}

/**
 * Whether storing `value` as the document leaves out a stored entry `drops`
 * matches. An entry is told by its id and its account's address.
 */
function leavesOut(value: unknown, drops: (entry: StoredEntry) => boolean): boolean {
  const identity = (entry: StoredEntry): string => `${entry.id}|${entry.account?.address}`
  const kept = new Set((value as { plans: StoredEntry[] }).plans.map(identity))
  return storedEntries().some(entry => drops(entry) && !kept.has(identity(entry)))
}

/**
 * Storage refuses each write that would leave out a stored entry `drops`
 * matches, `times` times at most, and none once the function returned is
 * called.
 */
function refuseWritesDropping(
  drops: (entry: StoredEntry) => boolean,
  times = Number.POSITIVE_INFINITY
): () => void {
  const set = world.storage.set.bind(world.storage)
  let left = times
  world.storage.set = async (key, value) => {
    if (left > 0 && key === QBIT_SEND_PLAN_STORE_KEY && leavesOut(value, drops)) {
      left -= 1
      throw new Error('storage unavailable')
    }
    return set(key, value)
  }
  return () => {
    left = 0
  }
}

/**
 * The next write that would leave out a stored entry `drops` matches waits
 * until `release`; `reached` resolves once it waits.
 */
function holdNextWriteDropping(drops: (entry: StoredEntry) => boolean): {
  reached: Promise<void>
  release: () => void
} {
  const set = world.storage.set.bind(world.storage)
  let arrive: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrive = resolve))
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  let held = false
  world.storage.set = async (key, value) => {
    if (!held && key === QBIT_SEND_PLAN_STORE_KEY && leavesOut(value, drops)) {
      held = true
      arrive()
      await gate
    }
    return set(key, value)
  }
  return { reached, release }
}

/** Let what is queued behind settled promises run. */
async function flush(times = 50): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve()
}

/** Every warning logged from here on, by its message. */
function watchWarnings(): () => string[] {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
  return () => warn.mock.calls.map(([message]) => String(message))
}

/** The warning the background logs of what an ending of a removed wallet's plans left. */
const NOT_ENDED = (plans: number, unreadable: number): string =>
  `[WalletController] Send plans of the removed wallet not ended yet (${plans} plan(s), ${unreadable} entr(ies) the store cannot read): held back until they are ended or the background starts again`
/** The warning it logs once nothing of what an ending left is left. */
const ENDED_NOW =
  '[WalletController] Send plans of the removed wallet that were not ended are ended now'
/** The warning it logs of ended plans whose payment may already be in the network. */
const MAY_HAVE_PAID = (count: number): string =>
  `[WalletController] ${count} send plan(s) of the removed wallet may have paid already`

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

/** Start a plan of `AMOUNT` for `owner`, selected meanwhile; the world's own account is selected again after. */
async function startPlanOf(owner: QbitSendPlanAccount) {
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(owner as never)
  try {
    return await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
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

describe('a removal that cannot drop an entry the store cannot read', () => {
  it('ends the wallet’s readable plan when dropping its unreadable entry fails once, and nothing of that plan is broadcast afterwards', async () => {
    const plan = await waitingPlan()
    await restartWith([storedRecord(plan.id), unreadableEntry(UNREADABLE_ID, otherAccount)])
    expect(qbitSendPlanStore.get(plan.id)).toBeDefined()
    expect(qbitSendPlanStore.unreadable().plans.map(entry => entry.id)).toEqual([UNREADABLE_ID])
    refuseWritesDropping(entry => entry.id === UNREADABLE_ID, 1)

    const outcome = await world.engine.endPlansOf(REMOVED)
    await world.settle()

    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    expect(outcome).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [],
      notEnded: { plans: [], unreadable: [UNREADABLE_ID] },
    })
    await expectEnded(plan.id)
    // The entry went at the first tick, storage taking the write again.
    expect(qbitSendPlanStore.unreadable().plans).toEqual([])
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps an entry it can never drop unreadable and holding nothing, tries again at every tick, and drops it once storage takes the write', async () => {
    const plan = await waitingPlan()
    await restartWith([storedRecord(plan.id), unreadableEntry(UNREADABLE_ID, otherAccount)])
    const stop = refuseWritesDropping(entry => entry.id === UNREADABLE_ID)
    const drops = vi.spyOn(qbitSendPlanStore, 'discardUnreadable')

    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [],
      notEnded: { plans: [], unreadable: [UNREADABLE_ID] },
    })
    await world.settle()
    expect(drops).toHaveBeenCalledTimes(1)
    await expectEnded(plan.id)

    // Three ticks, each trying the drop again, each refused: the entry stays
    // as it was, unreadable, read as no plan, holding nothing.
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    expect(drops).toHaveBeenCalledTimes(4)
    expect(qbitSendPlanStore.unreadable().plans.map(entry => entry.id)).toEqual([UNREADABLE_ID])
    expect(storedEntries().map(entry => entry.id)).toEqual([UNREADABLE_ID])
    expect(qbitSendPlanStore.list()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)

    stop()
    await world.tick()
    expect(drops).toHaveBeenCalledTimes(5)
    expect(qbitSendPlanStore.unreadable().plans).toEqual([])
    expect(storedEntries()).toEqual([])
    // Nothing is left to end, so nothing is tried again.
    await world.tick()
    await world.tick()
    expect(drops).toHaveBeenCalledTimes(5)
    world.assertRecipientGuarantees(undefined)
  })

  it('counts a drop whose write landed though storage reported it failed as left, and drops the entry again at the next tick', async () => {
    const plan = await waitingPlan()
    await restartWith([storedRecord(plan.id), unreadableEntry(UNREADABLE_ID, otherAccount)])
    // The drop's write lands, and storage reports it failed: the store reads
    // as before it, and its next write puts the entry back.
    const set = world.storage.set.bind(world.storage)
    let reportFailure = true
    world.storage.set = async (key, value) => {
      await set(key, value)
      if (reportFailure) {
        reportFailure = false
        throw new Error('storage reported a failure')
      }
    }

    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [],
      notEnded: { plans: [], unreadable: [UNREADABLE_ID] },
    })
    await world.settle()
    await expectEnded(plan.id)
    expect(storedEntries().map(entry => entry.id)).toEqual([UNREADABLE_ID])

    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    expect(qbitSendPlanStore.unreadable().plans).toEqual([])
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('goes on to the next entry when dropping the first fails, and ends the readable plan all the same', async () => {
    const plan = await waitingPlan()
    await restartWith([
      unreadableEntry(UNREADABLE_ID, otherAccount),
      storedRecord(plan.id),
      unreadableEntry(SECOND_UNREADABLE_ID, thirdAccount),
    ])
    const stop = refuseWritesDropping(entry => entry.id === UNREADABLE_ID)

    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [],
      notEnded: { plans: [], unreadable: [UNREADABLE_ID] },
    })
    await world.settle()
    await expectEnded(plan.id)
    // The second entry went; only the first is left.
    expect(storedEntries().map(entry => entry.id)).toEqual([UNREADABLE_ID])

    stop()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('ends the plan an entry reads as once the other entry for its account goes, though dropping that entry failed', async () => {
    const plan = await waitingPlan()
    const record = storedRecord(plan.id)
    // Two entries for the account: each unreadable, which of them is its
    // plan not being told; each reads as a plan on its own.
    await restartWith([record, { ...record, id: COPY_ID }])
    expect(qbitSendPlanStore.unreadable().plans.map(entry => entry.id)).toEqual([plan.id, COPY_ID])
    refuseWritesDropping(entry => entry.id === plan.id, 1)

    // Dropping the first fails; dropping the second makes the first the
    // account's plan, which is ended with the others.
    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [],
    })
    await world.settle()
    await expectEnded(plan.id)
    expect(storedEntries()).toEqual([])

    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })

  it('holds back an entry an account that stays makes readable after the removal, and ends it at the next tick', async () => {
    const plan = await waitingPlan()
    const record = storedRecord(plan.id)
    // The removed wallet's entry and a staying wallet's share a plan id:
    // each unreadable, though each reads as a plan on its own.
    const removed = anotherAccountsPlan(record, otherAccount.p2mr.pubkey, UNREADABLE_ID)
    const staying = anotherAccountsPlan(record, stayingAccount.p2mr.pubkey, UNREADABLE_ID)
    await restartWith([removed, staying])
    expect(qbitSendPlanStore.unreadable().plans).toHaveLength(2)
    const stop = refuseWritesDropping(entry => entry.account?.address === otherAccount.address)

    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [],
      mayHaveBeenSent: [],
      notEnded: { plans: [], unreadable: [UNREADABLE_ID] },
    })
    await world.settle()

    // The staying account cancels the entry it is shown: the removed
    // wallet's entry reads as its plan again. Held again, it goes no
    // further: nothing of it is written, signed or sent.
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(stayingAccount as never)
    await expect(world.wallet.cancelQbitSendPlan(UNREADABLE_ID)).resolves.toBeNull()
    await world.settle()
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
    const madeReadable = qbitSendPlanStore.get(UNREADABLE_ID)!
    expect(madeReadable).toMatchObject({
      account: { address: otherAccount.address },
      phase: 'signing',
      revision: (removed as { revision: number }).revision,
    })
    expect((await world.planHeld()).size).toBeGreaterThan(0)
    const signedBefore = world.keyring.signed.length

    // Storage takes the write again: the next tick ends it.
    stop()
    await world.tick()
    await expectEnded(UNREADABLE_ID)
    expect(storedEntries()).toEqual([])
    await expectNoneBroadcastAfterwards([madeReadable.steps.at(-1)!.txid])
    expect(world.keyring.signed).toHaveLength(signedBefore)
    world.assertRecipientGuarantees(undefined)
  })

  it('reports the store unread, holds the accounts back, and ends their plans once the store reads again', async () => {
    const plan = await waitingPlan()
    // The store cannot answer: its load failed.
    await expect(
      qbitSendPlanStore.init({
        storage: {
          get: async () => {
            throw new Error('storage unavailable')
          },
          set: async () => undefined,
        },
      })
    ).rejects.toThrow('storage unavailable')

    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [],
      mayHaveBeenSent: [],
      notEnded: { plans: [], unreadable: [], storeUnavailable: true },
    })

    // The store reads again: the merge confirms, and the next tick ends
    // the plan before anything of it leaves.
    await qbitSendPlanStore.init({ storage: world.storage })
    world.mine()
    await world.tick()
    await expectEnded(plan.id)
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a removal that cannot end one of the wallet’s plans', () => {
  it('ends the second plan when ending the first fails, sends nothing of the first, and ends it at the next tick', async () => {
    world.fund(150, 100_000)
    fundAccount(otherAccount, 150, 100_000)
    await world.open()
    const first = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const second = await startPlanOf(otherAccount)
    expect(qbitSendPlanStore.list().map(record => record.id)).toEqual([first.id, second.id])
    refuseWritesDropping(entry => entry.id === first.id, 1)

    const outcome = await world.engine.endPlansOf(REMOVED)
    await world.settle()
    expect(qbitSendPlanStore.get(second.id)).toBeUndefined()

    // Its merge confirms and a page reads it: the first plan, still stored
    // and held until the next tick, goes no further.
    world.mine()
    await world.plan()
    expect(world.pushed).not.toContain(first.paymentTxid)

    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid])
    expect(outcome).toEqual({
      ended: [second.id],
      mayHaveBeenSent: [],
      notEnded: { plans: [first.id], unreadable: [] },
    })
    await expectEnded(first.id)
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('begins no work for the account while its plan is left, and lets it begin once the plan is ended', async () => {
    const plan = await waitingPlan()
    const stop = refuseWritesDropping(entry => entry.id === plan.id)

    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [],
      mayHaveBeenSent: [],
      notEnded: { plans: [plan.id], unreadable: [] },
    })
    await world.settle()
    // Held back: no continue and no prepare for the account, and nothing of
    // the plan goes on, its merge confirmed and a page reading it. The
    // continue names the terms the plan states, as a page showing it does.
    await expect(
      world.wallet.continueQbitSendPlan(plan.id, world.shownTerms(plan.id))
    ).rejects.toThrow('The Qbit send plan is not open')
    await expect(world.prepare({ target: { kind: 'amount', amount: 1_000_000 } })).rejects.toThrow(
      'Qbit send plans need an account this wallet signs for'
    )
    world.mine()
    await world.tick()
    await world.plan()
    expect(qbitSendPlanStore.get(plan.id)).toMatchObject({ phase: 'waiting' })
    expect(world.pushed).not.toContain(plan.paymentTxid)

    stop()
    await world.tick()
    await expectEnded(plan.id)
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    // The same prepare is answered now, as for any account: one transaction
    // carries this amount, so no plan is needed.
    expect(await world.prepare({ target: { kind: 'amount', amount: 1_000_000 } })).toMatchObject({
      ok: false,
      reason: 'not_needed',
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('ends what an earlier removal left when the account is removed again, and lets work begin at once', async () => {
    const plan = await waitingPlan()
    refuseWritesDropping(entry => entry.id === plan.id, 1)
    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [],
      mayHaveBeenSent: [],
      notEnded: { plans: [plan.id], unreadable: [] },
    })

    // Its wallet restored and removed again, before any tick.
    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [],
    })
    await world.settle()
    await expectEnded(plan.id)
    expect(await world.prepare({ target: { kind: 'amount', amount: 1_000_000 } })).toMatchObject({
      ok: false,
      reason: 'not_needed',
    })
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('what is logged of what a removal left', () => {
  it('logs what is left when it changes and once nothing is, not at every tick, and tries again at every tick all the same', async () => {
    const plan = await waitingPlan()
    await restartWith([storedRecord(plan.id), unreadableEntry(UNREADABLE_ID, otherAccount)])
    const stopEntry = refuseWritesDropping(entry => entry.id === UNREADABLE_ID)
    const stopPlan = refuseWritesDropping(entry => entry.id === plan.id)
    const drops = vi.spyOn(qbitSendPlanStore, 'discardUnreadable')
    const deletes = vi.spyOn(qbitSendPlanStore, 'delete')
    const warned = watchWarnings()

    expect(await world.engine.endPlansOf(REMOVED)).toEqual({
      ended: [],
      mayHaveBeenSent: [],
      notEnded: { plans: [plan.id], unreadable: [UNREADABLE_ID] },
    })
    await world.settle()
    // The removal's own attempt logs each refusal.
    expect(warned()).toEqual([
      '[WalletController] An entry of a removed wallet the store cannot read could not be dropped',
      '[WalletController] A Qbit send plan of a removed wallet could not be ended',
    ])

    // Twenty ticks, each trying both again, each refused: nothing changed,
    // so nothing more is logged.
    for (let tick = 0; tick < 20; tick++) await world.tick()
    expect(drops).toHaveBeenCalledTimes(21)
    expect(deletes).toHaveBeenCalledTimes(21)
    expect(warned()).toHaveLength(2)

    // Storage takes the plan's write: what is left changed, logged once.
    stopPlan()
    await world.tick()
    await expectEnded(plan.id)
    expect(warned().slice(2)).toEqual([NOT_ENDED(0, 1)])
    for (let tick = 0; tick < 5; tick++) await world.tick()
    expect(drops).toHaveBeenCalledTimes(27)
    expect(warned()).toHaveLength(3)

    // And the entry's: nothing is left, logged once.
    stopEntry()
    await world.tick()
    expect(storedEntries()).toEqual([])
    expect(warned().slice(3)).toEqual([ENDED_NOW])
    for (let tick = 0; tick < 5; tick++) await world.tick()
    expect(drops).toHaveBeenCalledTimes(28)
    expect(warned()).toHaveLength(4)
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a wallet reset while a removal left something', () => {
  it('waits for the attempt under way to end what is left, and begins none while it runs', async () => {
    const plan = await waitingPlan()
    await restartWith([storedRecord(plan.id), unreadableEntry(UNREADABLE_ID, otherAccount)])
    const stopEntry = refuseWritesDropping(entry => entry.id === UNREADABLE_ID)
    refuseWritesDropping(entry => entry.id === plan.id, 1)
    expect((await world.engine.endPlansOf(REMOVED)).notEnded).toEqual({
      plans: [plan.id],
      unreadable: [UNREADABLE_ID],
    })
    await world.settle()
    const drops = vi.spyOn(qbitSendPlanStore, 'discardUnreadable')

    // At the next tick the entry's drop is refused again, and the plan's
    // deletion waits.
    const write = holdNextWriteDropping(entry => entry.id === plan.id)
    await world.tick(undefined, { settle: false })
    await write.reached
    expect(drops).toHaveBeenCalledTimes(1)

    // A wallet reset begins: it waits for that attempt.
    let halted = false
    const halting = world.engine.halt().then(() => {
      halted = true
    })
    await flush()
    // Read before the write goes on, which the store's queue waits for.
    const haltedWithTheWriteWaiting = halted
    write.release()
    await halting
    expect(haltedWithTheWriteWaiting).toBe(false)
    // The attempt's write landed before the reset could go on.
    expect(qbitSendPlanStore.get(plan.id)).toBeUndefined()
    expect(storedEntries().map(entry => entry.id)).toEqual([UNREADABLE_ID])

    // While it runs, nothing begins another: neither an unlock nor time.
    const writes: unknown[] = []
    const set = world.storage.set.bind(world.storage)
    world.storage.set = async (key, value) => {
      writes.push(value)
      return set(key, value)
    }
    world.engine.onUnlock()
    await world.tick()
    await flush()
    expect(drops).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])

    // The reset erases the plans and what they held, storage taking its
    // write, and is over.
    stopEntry()
    await (guardHolder.guard as { resetAllData(): Promise<void> }).resetAllData()
    await qbitSendPlanStore.resetAllData()
    await world.engine.resume()
    await world.settle()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a wallet removal whose send plans cannot all be ended', () => {
  // Slot 0: the wallet removed, which signs for the world's account and the
  // other account; slot 1: the current wallet, which stays.
  const TEST_PATH = "m/87'/1'/0'/0"

  /** The keyrings the keyring service keeps, by slot. */
  const slots = (keyringService as unknown as { keyrings: unknown[] }).keyrings

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

  function signingWallet(listedPubkeys: string[]) {
    return {
      type: KeyringType.QbitHdKeyring,
      mnemonic: `the phrase of the wallet of ${listedPubkeys[0]!.slice(0, 4)}`,
      passphrase: '',
      activeIndexes: listedPubkeys.map((_, index) => index),
      hdPath: TEST_PATH,
      listedPubkeys,
    }
  }

  beforeEach(() => {
    slots.length = 0
    slots.push(
      signingWallet([account.pubkey, otherAccount.pubkey]),
      signingWallet([stayingAccount.pubkey])
    )
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(1)
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockImplementation((async () =>
      slots.map((slot, index) => {
        const { type, listedPubkeys } = slot as { type: string; listedPubkeys?: string[] }
        return {
          type,
          index,
          addressType: AddressType.P2MR,
          keyring: { hdPath: TEST_PATH },
          accounts: (listedPubkeys ?? []).map(pubkey => ({
            pubkey,
            brandName: type,
            keyring: listedKey(pubkey),
          })),
        }
      })) as never)
    // No account of these wallets on mainnet's path matters here.
    vi.mocked(keyringService.createTmpKeyring).mockImplementation((() => ({
      getQbitAccounts: async () => [],
    })) as never)
    vi.mocked(keyringService.removeKeyring).mockImplementation((async (
      index: number,
      options?: { beforeRemove?: () => Promise<void> }
    ) => {
      await options?.beforeRemove?.()
      slots[index] = { type: KeyringType.Empty }
    }) as never)
  })

  afterEach(() => {
    slots.length = 0
  })

  /** Remove the wallet in slot 0, as a page lists it; resolves to what the removal warned of its plans. */
  async function removeWallet(): Promise<string[]> {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const listed = JSON.parse(JSON.stringify(await world.wallet.getKeyrings())) as {
      index: number
    }[]
    const wallet = listed.find(item => item.index === 0)
    if (!wallet) throw new Error('no wallet in slot 0')
    await world.wallet.removeKeyring(wallet as never)
    await world.settle()
    const warnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter(message => message.includes('of the removed wallet'))
    warn.mockRestore()
    return warnings
  }

  it('says a plan ended at the next tick may have paid already when its payment was in the network', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    refuseWritesDropping(entry => entry.id === plan.id, 1)

    expect(await removeWallet()).toEqual([NOT_ENDED(1, 0)])
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    const warned = watchWarnings()
    await world.tick()
    expect(warned()).toEqual([MAY_HAVE_PAID(1), ENDED_NOW])
    await expectEnded(plan.id)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('removes the wallet when dropping its unreadable entry fails once, ends its readable plan, and says what is left', async () => {
    const plan = await waitingPlan()
    await restartWith([storedRecord(plan.id), unreadableEntry(UNREADABLE_ID, otherAccount)])
    refuseWritesDropping(entry => entry.id === UNREADABLE_ID, 1)

    expect(await removeWallet()).toEqual([NOT_ENDED(0, 1)])
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    await expectEnded(plan.id)
    expect(storedEntries().map(entry => entry.id)).toEqual([UNREADABLE_ID])

    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('removes the wallet when dropping the first of two entries keeps failing, drops the second, and says what is left', async () => {
    const plan = await waitingPlan()
    await restartWith([
      unreadableEntry(UNREADABLE_ID, otherAccount),
      storedRecord(plan.id),
      unreadableEntry(SECOND_UNREADABLE_ID, otherAccount),
    ])
    const stop = refuseWritesDropping(entry => entry.id === UNREADABLE_ID)

    expect(await removeWallet()).toEqual([NOT_ENDED(0, 1)])
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    await expectEnded(plan.id)
    expect(storedEntries().map(entry => entry.id)).toEqual([UNREADABLE_ID])
    await world.tick()
    expect(storedEntries().map(entry => entry.id)).toEqual([UNREADABLE_ID])

    stop()
    await expectNoneBroadcastAfterwards([plan.paymentTxid])
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('removes the wallet when ending one of its plans fails, ends the other, and says what is left', async () => {
    world.fund(150, 100_000)
    fundAccount(otherAccount, 150, 100_000)
    await world.open()
    const first = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const second = await startPlanOf(otherAccount)
    refuseWritesDropping(entry => entry.id === first.id, 1)

    expect(await removeWallet()).toEqual([NOT_ENDED(1, 0)])
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    expect(qbitSendPlanStore.get(second.id)).toBeUndefined()

    await expectNoneBroadcastAfterwards([first.paymentTxid, second.paymentTxid])
    await expectEnded(first.id)
    expect(storedEntries()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('says nothing more when every plan of the wallet is ended', async () => {
    const plan = await waitingPlan()
    expect(await removeWallet()).toEqual([])
    await expectEnded(plan.id)
    world.assertRecipientGuarantees(undefined)
  })
})
