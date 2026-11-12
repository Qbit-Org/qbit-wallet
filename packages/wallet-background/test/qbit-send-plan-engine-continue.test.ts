import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import { keyringService, preferenceService } from '../src/services'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
import {
  CHAIN,
  T0,
  World,
  account,
  newPlanGuard,
  nodeRejection,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// What a send plan's Continue approves (#188). Continue authorises signing
// in this session, as a start does, and records the signature figures it
// approves: every transaction of the plan that may still need a signature,
// read before the plan does anything else. Any signing later in the session
// must continue those figures exactly, as after a start: the counter moved
// by the plan's own signatures and nothing else. A signature that no
// recorded approval covers waits for the user's Continue, whether or not a
// lock came in between.

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

const AMOUNT = 12_000_000
const BUDGET_CHANGED = 'The signature budget changed since the plan was approved'
const NOT_APPROVED = 'The signatures this plan still needs are not approved in this session'

/**
 * A plan of one merge and a payment, signed through, and a restart: the
 * merge's signed bytes went with the session, and nothing is authorised.
 */
async function signedThroughThenRestarted(): Promise<{
  planId: string
  merge: string
  payment: string
}> {
  world.fund(150, 100_000)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const [merge, payment] = qbitSendPlanStore.get(plan.id)!.steps
  expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
  await world.restart()
  return { planId: plan.id, merge: merge!.txid, payment: payment!.txid }
}

/**
 * A plan whose merge is in the network and whose payment is signed, stored
 * paused `interrupted` (a record the store reads as valid), and a restart,
 * which leaves the wallet locked: Continue, offered once it is unlocked,
 * resumes it into waiting, with nothing to sign then.
 */
async function pausedWithMergeInTheNetwork(): Promise<{ planId: string; merge: string }> {
  world.fund(150, 100_000)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const merge = qbitSendPlanStore.get(plan.id)!.steps[0]!.txid
  const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
  document.plans[0].phase = 'paused'
  document.plans[0].pause = { reason: 'interrupted', at: Date.now() }
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
  await world.restart()
  expect(await world.plan()).toMatchObject({
    phase: 'paused',
    pause: { reason: 'interrupted' },
    actions: ['cancel'],
  })
  return { planId: plan.id, merge }
}

/**
 * A continue of `planId` made with the wallet unlocked, and a lock while
 * the figures it approved are read, so that they are still to be read at
 * the next unlock.
 */
async function continueThenLockWhileRead(planId: string): Promise<void> {
  world.keyring.unlock()
  const preflight = gateNextPreflight()
  await world.wallet.continueQbitSendPlan(planId)
  await preflight.reached
  await world.wallet.lockWallet()
  preflight.release()
  await world.settle()
}

/** A lock, and an unlock in the same session; `signedMeanwhile` signatures of another request come first. */
async function lockAndUnlock(signedMeanwhile = 0): Promise<void> {
  await world.wallet.lockWallet()
  world.keyring.unlock()
  world.keyring.signElsewhere(signedMeanwhile)
  world.engine.onUnlock()
  await world.settle()
}

/** The merge leaves the network for good, and its lookups miss it for the whole grace. */
async function mergeProvenAbsent(merge: string): Promise<void> {
  world.explorer.removeTx(merge)
  await world.tick()
  await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
}

/** The keyring's next preflight waits until `release`; `reached` resolves once it began. */
function gateNextPreflight(): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  let arrived: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrived = resolve))
  const preflight = world.keyring.preflightP2mrPsbtSigning
  vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementationOnce((async (
    ...args: Parameters<typeof preflight>
  ) => {
    arrived()
    await gate
    return preflight(...args)
  }) as never)
  return { reached, release }
}

/** The plan's merge confirms, and so does its payment. */
async function completes(planId: string): Promise<void> {
  for (let block = 0; block < 3 && (await world.plan())?.phase !== 'completed'; block++) {
    world.mine()
    await world.tick()
  }
  expect(await world.plan()).toMatchObject({ id: planId, phase: 'completed' })
  world.assertRecipientGuarantees(AMOUNT)
}

describe('what a continue approves', () => {
  it('never signs by itself after a continue into sending when another request signed with the key and the merge is gone for good', async () => {
    const { planId, merge, payment } = await signedThroughThenRestarted()
    // The merge confirms, and the network refuses the payment for its fee.
    world.refuse.set(payment, nodeRejection('mempool min fee not met'))
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
    })
    world.refuse.clear()
    // A reorganisation takes the merge out again.
    world.explorer.removeTx(merge)

    world.keyring.unlock()
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    // The payment waits for its merge.
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const signed = world.keyring.signed.length
    const counter = world.keyring.counter

    await lockAndUnlock(1)
    await mergeProvenAbsent(merge)
    // Its bytes went with the restart, so it needs signing again: the
    // plan does not sign it by itself.
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.keyring.counter).toBe(counter + 1)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted', detail: NOT_APPROVED },
      actions: ['continue', 'cancel'],
    })

    // The user's continue approves what is left as it stands now.
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    expect(world.keyring.signed.slice(signed)).toEqual([merge])
    await completes(planId)
  })

  it('waits for continue to sign again a merge that had confirmed when the user continued, though nothing else signed', async () => {
    const { planId, merge, payment } = await signedThroughThenRestarted()
    world.refuse.set(payment, nodeRejection('mempool min fee not met'))
    world.mine()
    await world.tick()
    world.refuse.clear()
    world.explorer.removeTx(merge)
    world.keyring.unlock()
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    const signed = world.keyring.signed.length

    await lockAndUnlock()
    await mergeProvenAbsent(merge)
    // The continue approved what might still need a signature then: the
    // merge had confirmed, so a signing of it is no part of that.
    expect(world.keyring.signed).toHaveLength(signed)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted', detail: NOT_APPROVED },
    })
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    expect(world.keyring.signed).toHaveLength(signed + 1)
    await completes(planId)
  })

  it('checks a merge signed again after a continue into waiting against the figures the continue approved: another request’s signature waits for continue', async () => {
    const { planId, merge } = await pausedWithMergeInTheNetwork()
    world.keyring.unlock()
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const signed = world.keyring.signed.length

    await lockAndUnlock(1)
    await mergeProvenAbsent(merge)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted', detail: BUDGET_CHANGED },
      actions: ['continue', 'cancel'],
    })

    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    expect(world.keyring.signed).toHaveLength(signed + 1)
    await completes(planId)
  })

  it('signs a merge again by itself after a continue into waiting when only the plan’s own signatures moved the counter', async () => {
    const { planId, merge } = await pausedWithMergeInTheNetwork()
    world.keyring.unlock()
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    const signed = world.keyring.signed.length

    await lockAndUnlock()
    await mergeProvenAbsent(merge)
    expect(world.keyring.signed).toHaveLength(signed + 1)
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    await completes(planId)
  })

  it('reads the figures of a continue a lock kept from being read at the unlock, before another request can sign', async () => {
    const { planId, merge } = await pausedWithMergeInTheNetwork()
    expect(lockState.isUnlocked).toBe(false)
    // A continue while locked is refused, and authorises nothing.
    await expect(world.wallet.continueQbitSendPlan(planId)).rejects.toThrow(
      'cannot continue while the wallet is locked'
    )
    await continueThenLockWhileRead(planId)
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const signed = world.keyring.signed.length

    await world.unlock()
    world.keyring.signElsewhere(1)
    await mergeProvenAbsent(merge)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted', detail: BUDGET_CHANGED },
    })
  })

  it('reads a continue’s figures again at the unlock when the wallet locks while they are read', async () => {
    const { planId, merge } = await pausedWithMergeInTheNetwork()
    await continueThenLockWhileRead(planId)
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const signed = world.keyring.signed.length

    // Read again at the unlock, they hold: the merge is signed again by
    // itself once proven absent.
    await world.unlock()
    await mergeProvenAbsent(merge)
    expect(world.keyring.signed).toHaveLength(signed + 1)
    await completes(planId)
  })

  it('reads no figures of a continue a lock kept from being read when the wallet unlocks on another network', async () => {
    const { planId, merge } = await pausedWithMergeInTheNetwork()
    await continueThenLockWhileRead(planId)
    const signed = world.keyring.signed.length

    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    await world.unlock()
    vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
    await mergeProvenAbsent(merge)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted', detail: NOT_APPROVED },
    })
  })

  it('signs nothing a continue could not read the figures of, and the next continue reads them again', async () => {
    const { planId, merge } = await pausedWithMergeInTheNetwork()
    world.keyring.unlock()
    vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementationOnce(async () => {
      throw new Error('The counter could not be read')
    })
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const signed = world.keyring.signed.length

    await mergeProvenAbsent(merge)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted', detail: NOT_APPROVED },
    })
    await world.wallet.continueQbitSendPlan(planId)
    await world.settle()
    expect(world.keyring.signed).toHaveLength(signed + 1)
    await completes(planId)
  })
})
