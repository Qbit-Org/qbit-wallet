import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import { preferenceService, qbitSendGuardService } from '../src/services'
import { QBIT_SEND_PLAN_VIEW_REVISION_STRIDE } from '../src/services/qbitSendPlanEngine'
import type { QbitSendGuardService } from '../src/services/qbitSendGuards'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_STORE_KEY,
  type QbitSendPlanRecord,
} from '../src/services/qbitSendPlanStore'
import {
  CHAIN,
  RECIPIENT,
  T0,
  World,
  account,
  anotherAccountsPlan,
  isLookup,
  newPlanGuard,
  p2mrAccount,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// Two stored entries of the same plan id, or for the same account on one
// network, are each unreadable: which of them is the plan cannot be told.
// Once the account cancels the entry it is shown, or a wallet removal drops
// it, the entry left reads as a plan again (#188). Nothing of it was held
// while it was unreadable, so it is taken up as a restart takes up a stored
// plan: held again through the send guard's restore, pausing when something
// else holds or spent its outputs; signing nothing until a continue made
// while unlocked; shown with its own figures; and going on by the rules of
// a plan found at start-up.

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
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      getAutoLockTimeId: vi.fn(() => 0),
      getInitAlianNameStatus: vi.fn(() => true),
      getLockOnComputerLock: vi.fn(() => true),
      getLockOnWindowsClosed: vi.fn(() => true),
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

/** Another plan id, for a second entry of the same plan. */
const COPY_ID = 'c3'.repeat(16)
/** Another account of the wallet, on the same network. */
const otherAccount = p2mrAccount('22'.repeat(32))

/** The stored record of plan `planId`, as storage holds it. */
function storedRecord(planId: string): QbitSendPlanRecord {
  const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!) as {
    plans: QbitSendPlanRecord[]
  }
  return document.plans.find(plan => plan.id === planId)!
}

/** Store `plans` as the whole document, as a document changed on disk is, and restart. */
async function restartWith(plans: readonly unknown[]): Promise<void> {
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify({ version: 1, plans }))
  await world.restart()
}

/** The plan of 12,000,000 bits through one merge, signed and waiting for its merge to confirm. */
async function waitingPlan() {
  world.fund(150, 100_000)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
  expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
  return { plan, record: storedRecord(plan.id), held: await world.planHeld() }
}

/** Stored plan `planId` is read, and held as it was before the restart. */
async function expectHeldAsAfterRestart(planId: string, held: Set<string>): Promise<void> {
  expect(qbitSendPlanStore.get(planId)).toBeDefined()
  expect(await world.planHeld()).toEqual(held)
}

/** The announcements of plan `planId` made since `from`. */
function announced(planId: string, from = 0): number[] {
  return world.events
    .slice(from)
    .filter(event => event.planId === planId)
    .map(event => event.revision)
}

describe('the plan left once the entry it conflicted with is cancelled', () => {
  it('holds, shows and pays the plan left once its account cancels the other entry for it, as a plan found at start-up', async () => {
    const { plan, record, held } = await waitingPlan()
    // A second entry for the same account: neither reads, and the copy,
    // stored first, is the one the account is shown.
    await restartWith([{ ...record, id: COPY_ID }, record])
    const shown = (await world.plan())!
    expect(shown).toMatchObject({
      id: COPY_ID,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
    expect((await world.planHeld()).size).toBe(0)
    const signed = world.keyring.signed.length
    const from = world.events.length

    await expect(world.wallet.cancelQbitSendPlan(shown.id)).resolves.toBeNull()
    await world.settle()

    // Read, held and announced at once, with nothing else asking for it.
    expect(qbitSendPlanStore.unreadable()).toEqual({ plans: [] })
    await expectHeldAsAfterRestart(plan.id, held)
    expect(Math.max(...announced(plan.id, from))).toBeGreaterThan(shown.revision)
    const view = (await world.plan())!
    expect(view).toMatchObject({
      id: plan.id,
      recipient: RECIPIENT,
      amount: 12_000_000,
      totalFee: plan.totalFee,
      phase: 'waiting',
    })
    expect(view.steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    expect(view.revision).toBeGreaterThanOrEqual(Math.max(...announced(plan.id, from)))
    world.assertRecipientGuarantees(undefined)

    // It goes on as a plan found at start-up: the merge confirms, and the
    // stored payment goes out as it was signed.
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })
    expect(world.keyring.signed).toHaveLength(signed)
    world.assertRecipientGuarantees(12_000_000)
  })

  it('signs nothing of the plan left until a continue made while unlocked, as after a restart', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    expect(review.merges).toHaveLength(2)
    // A lock in the second merge's signing: the first merge went out.
    let merges = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) merges += 1
      if (merges === 2 && index === 3) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(world.storedStatuses()).toEqual(['broadcast', 'planned', 'planned'])
    const planId = world.storedPlanId()!
    const record = storedRecord(planId)
    await restartWith([{ ...record, id: COPY_ID }, record])
    await world.unlock()
    const signed = world.keyring.signed.length
    const counter = world.keyring.counter

    await world.wallet.cancelQbitSendPlan(COPY_ID)
    await world.settle()
    await world.tick()

    // Unlocked, and not authorised in this session: it waits for continue.
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      id: planId,
      phase: 'paused',
      pause: { reason: 'interrupted' },
      amount: review.amount,
    })
    expect(paused.actions).toContain('continue')
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.keyring.counter).toBe(counter)

    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ id: planId, phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('pauses the plan left outputs_spent when something else spent its outputs while it could not be read', async () => {
    const { plan, record } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, record])
    expect(qbitSendPlanStore.planHolds()).toEqual([])
    // Another send spent one of its direct inputs meanwhile: nothing held it.
    const payment = record.steps.at(-1)!
    const direct = payment.inputs.find(input => input.txid !== plan.steps[0]!.txid)!
    await qbitSendGuardService.recordAcceptedBroadcast(CHAIN, 'ab'.repeat(32), [
      { txid: direct.txid, vout: direct.vout },
    ])

    await world.wallet.cancelQbitSendPlan(COPY_ID)
    await world.settle()

    expect(await world.plan()).toMatchObject({
      id: plan.id,
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
    })
    world.mine()
    await world.tick()
    world.assertRecipientGuarantees(undefined)
  })

  it('takes a spend recorded for one of the plan’s own transactions for no conflict', async () => {
    const { plan, record, held } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, record])
    // The merge's own spend of its inputs, as a lookup that found it records it.
    const merge = record.steps[0]!
    await qbitSendGuardService.recordAcceptedBroadcast(
      CHAIN,
      merge.txid,
      merge.inputs.map(({ txid, vout }) => ({ txid, vout }))
    )

    await world.wallet.cancelQbitSendPlan(COPY_ID)
    await world.settle()

    await expectHeldAsAfterRestart(plan.id, held)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'waiting' })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })
})

describe('entries left in conflict, and entries that cannot be read on their own', () => {
  it('keeps two entries still in conflict unreadable after a third goes, and takes the last up once the second goes too', async () => {
    const { plan, record, held } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, { ...record, id: 'd4'.repeat(16) }, record])
    const from = world.events.length

    await world.wallet.cancelQbitSendPlan(COPY_ID)
    await world.settle()
    // Still two entries for the account: the next is shown, nothing held.
    expect(await world.plan()).toMatchObject({
      id: 'd4'.repeat(16),
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
    expect((await world.planHeld()).size).toBe(0)
    expect(announced(plan.id, from)).toEqual([])

    await world.wallet.cancelQbitSendPlan('d4'.repeat(16))
    await world.settle()
    await expectHeldAsAfterRestart(plan.id, held)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'waiting', amount: 12_000_000 })
    world.mine()
    await world.tick()
    world.assertRecipientGuarantees(12_000_000)
  })

  it('drops only the cancelling account’s entry of a plan id two accounts share, and takes the other’s up for that account', async () => {
    const { plan, record } = await waitingPlan()
    const theirs = anotherAccountsPlan(record, otherAccount.pubkey, plan.id)
    await restartWith([record, theirs])
    expect(await world.plan()).toMatchObject({ id: plan.id, pause: { reason: 'unreadable' } })

    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toBeNull()
    await world.settle()

    expect(world.storedPlans()).toHaveLength(1)
    expect(qbitSendPlanStore.findOpen(CHAIN, account.address)).toBeUndefined()
    expect(await world.plan()).toBeNull()
    const kept = qbitSendPlanStore.findOpen(CHAIN, otherAccount.address)!
    expect(kept).toMatchObject({ id: plan.id, account: { address: otherAccount.address } })
    expect(await world.planHeld()).toEqual(
      new Set(
        qbitSendPlanStore.planHolds()[0]!.outpoints.map(({ txid, vout }) => `${txid}:${vout}`)
      )
    )
    // Shown to its own account with its figures, waiting for its continue.
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as never)
    expect(await world.plan()).toMatchObject({
      id: plan.id,
      address: otherAccount.address,
      amount: 12_000_000,
      phase: 'paused',
      pause: { reason: 'interrupted' },
    })
  })

  it('keeps the entry left unreadable, with only its cancel, when it fails its own checks', async () => {
    const { plan, record } = await waitingPlan()
    // A field this version does not know: unreadable on its own.
    await restartWith([
      { ...record, id: COPY_ID },
      { ...record, futureField: true },
    ])

    await world.wallet.cancelQbitSendPlan(COPY_ID)
    await world.settle()

    const view = (await world.plan())!
    expect(view).toMatchObject({
      id: plan.id,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
      amount: 0,
      steps: [],
    })
    expect((await world.planHeld()).size).toBe(0)
    expect(qbitSendPlanStore.list()).toEqual([])
    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toBeNull()
    expect(world.storedPlans()).toEqual([])
    expect(await world.plan()).toBeNull()
  })
})

describe('a discard that drops nothing, and one that fails', () => {
  it('takes the plan up once when two pages cancel the shown entry at once', async () => {
    const { plan, record, held } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, record])
    const guard = guardHolder.guard as QbitSendGuardService
    const restores = vi.spyOn(guard, 'restorePlanHolds')

    await expect(
      Promise.all([
        world.wallet.cancelQbitSendPlan(COPY_ID),
        world.wallet.cancelQbitSendPlan(COPY_ID),
      ])
    ).resolves.toEqual([null, null])
    await world.settle()

    expect(restores).toHaveBeenCalledTimes(1)
    expect(restores.mock.calls[0]![0].map(entry => entry.planId)).toEqual([plan.id])
    await expectHeldAsAfterRestart(plan.id, held)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'waiting' })
  })

  it('leaves both entries unreadable and nothing held when the discard cannot be written', async () => {
    const { plan, record } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, record])
    const from = world.events.length
    const failure = new Error('storage unavailable')
    world.storage.failNextSet = failure

    await expect(world.wallet.cancelQbitSendPlan(COPY_ID)).rejects.toBe(failure)
    await world.settle()

    expect(qbitSendPlanStore.unreadable().plans.map(entry => entry.id)).toEqual([COPY_ID, plan.id])
    expect((await world.planHeld()).size).toBe(0)
    expect(announced(plan.id, from)).toEqual([])
    expect(await world.plan()).toMatchObject({ id: COPY_ID, pause: { reason: 'unreadable' } })
  })
})

describe('holding the plan left again', () => {
  /** The guard's next restore holds at once and answers once `release` is called. */
  function holdNextRestoreAnswer(): { arrived: Promise<void>; release: () => void } {
    const guard = guardHolder.guard as QbitSendGuardService
    const restorePlanHolds = guard.restorePlanHolds.bind(guard)
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let arrive = (): void => undefined
    const arrived = new Promise<void>(resolve => (arrive = resolve))
    vi.spyOn(guard, 'restorePlanHolds').mockImplementationOnce(async entries => {
      const restoring = restorePlanHolds(entries)
      arrive()
      await gate
      return restoring
    })
    return { arrived, release: () => release() }
  }

  it('lets go of what it took when a reset begins meanwhile, the reset waiting for it, and holds the plan again once the reset failed', async () => {
    const { plan, record, held } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, record])
    const restoring = holdNextRestoreAnswer()
    const cancelling = world.wallet.cancelQbitSendPlan(COPY_ID)
    await restoring.arrived
    expect((await world.planHeld()).size).toBeGreaterThan(0)

    let halted = false
    const halting = world.engine.halt().then(() => {
      halted = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(halted).toBe(false)
    restoring.release()
    await halting
    await expect(cancelling).resolves.toBeNull()
    expect((await world.planHeld()).size).toBe(0)
    expect(qbitSendPlanStore.get(plan.id)).toBeDefined()

    // The reset failed: the plans go on from what is stored, as at start-up.
    await world.engine.resume()
    await world.settle()
    await expectHeldAsAfterRestart(plan.id, held)
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'waiting' })
  })

  it('keeps the discard when the guard cannot hold the plan again, and the plan takes its hold at its first advance', async () => {
    const { plan, record, held } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, record])
    const guard = guardHolder.guard as QbitSendGuardService
    vi.spyOn(guard, 'restorePlanHolds').mockRejectedValueOnce(new Error('guard unavailable'))

    await expect(world.wallet.cancelQbitSendPlan(COPY_ID)).resolves.toBeNull()
    await world.settle()
    expect(qbitSendPlanStore.unreadable()).toEqual({ plans: [] })

    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'waiting' })
    await expectHeldAsAfterRestart(plan.id, held)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })
})

describe('the plan left once a wallet removal drops the entry it conflicted with', () => {
  it('ends a plan left of the removed account in the same removal, as the removal ends any of its plans', async () => {
    const { plan, record } = await waitingPlan()
    await restartWith([{ ...record, id: COPY_ID }, record])
    const pushed = world.pushed.length

    await expect(
      world.engine.endPlansOf([{ chain: CHAIN, address: account.address }])
    ).resolves.toEqual({ ended: [plan.id], mayHaveBeenSent: [] })
    await world.settle()

    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(await world.plan()).toBeNull()
    world.mine()
    await world.tick()
    expect(world.pushed).toHaveLength(pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps a merge of unknown outcome held for a plan left of the removed account, as a cancel does', async () => {
    const { plan, record } = await waitingPlan()
    const merge = record.steps[0]!
    const unknown = { ...record, steps: [{ ...merge, status: 'unknown' }, record.steps[1]!] }
    await restartWith([{ ...unknown, id: COPY_ID }, unknown])
    // Its lookups get no answer.
    world.explorer.failures.push(request =>
      isLookup(request) ? { status: 503, body: 'unavailable' } : undefined
    )

    await expect(
      world.engine.endPlansOf([{ chain: CHAIN, address: account.address }])
    ).resolves.toEqual({ ended: [plan.id], mayHaveBeenSent: [] })
    await world.settle()

    expect(qbitSendPlanStore.get(plan.id)).toMatchObject({ phase: 'cancelling' })
    expect(await world.planHeld()).toEqual(
      new Set(merge.inputs.map(input => `${input.txid}:${input.vout}`))
    )
    world.explorer.failures.length = 0
    world.mine()
    await world.tick()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('lets a plan left of an account that stays go on', async () => {
    const { plan, record } = await waitingPlan()
    const theirs = anotherAccountsPlan(record, otherAccount.pubkey, plan.id)
    await restartWith([record, theirs])

    await expect(
      world.engine.endPlansOf([{ chain: CHAIN, address: account.address }])
    ).resolves.toEqual({ ended: [], mayHaveBeenSent: [] })
    await world.settle()

    expect(qbitSendPlanStore.findOpen(CHAIN, otherAccount.address)).toMatchObject({ id: plan.id })
    expect((await world.planHeld()).size).toBeGreaterThan(0)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(otherAccount as never)
    expect(await world.plan()).toMatchObject({ id: plan.id, pause: { reason: 'interrupted' } })
  })

  it('holds and advances nothing while the wallet is being reset, and takes the plan up once the reset is over', async () => {
    const { plan, record } = await waitingPlan()
    const theirs = anotherAccountsPlan(record, otherAccount.pubkey, plan.id)
    await restartWith([record, theirs])
    const engine = world.engine

    await engine.halt()
    await engine.endPlansOf([{ chain: CHAIN, address: account.address }])
    const left = qbitSendPlanStore.get(plan.id)!
    expect(left.account.address).toBe(otherAccount.address)
    expect((await world.planHeld()).size).toBe(0)
    await world.tick()
    expect(qbitSendPlanStore.get(plan.id)).toBe(left)
    expect((await world.planHeld()).size).toBe(0)

    // The reset failed: the plans go on from what is stored, as at start-up.
    await engine.resume()
    await world.settle()
    expect((await world.planHeld()).size).toBeGreaterThan(0)
    expect(qbitSendPlanStore.get(plan.id)!.revision).toBe(left.revision + 1)
  })
})

describe('the revision pages see', () => {
  it('announces the plan left above the stand-in it was shown as, and above any view of it before the restart', async () => {
    const { plan } = await waitingPlan()
    const before = (await world.plan())!
    const record = storedRecord(plan.id)
    await restartWith([{ ...record, id: COPY_ID }, record])
    const from = world.events.length

    await world.wallet.cancelQbitSendPlan(COPY_ID)
    await world.settle()

    const revisions = announced(plan.id, from)
    expect(revisions.length).toBeGreaterThan(0)
    expect(Math.min(...revisions)).toBeGreaterThan(before.revision)
    const view = (await world.plan())!
    expect(view.revision).toBeGreaterThanOrEqual(Math.max(...revisions))
    expect(view.revision).toBeGreaterThan(QBIT_SEND_PLAN_VIEW_REVISION_STRIDE)
  })
})
