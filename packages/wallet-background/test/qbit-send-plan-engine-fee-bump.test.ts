import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import { type QbitSendGuardService } from '../src/services/qbitSendGuards'
import qbitSendPlanStore from '../src/services/qbitSendPlanStore'
import {
  CHAIN,
  T0,
  World,
  account,
  inputsOfPsbt,
  newPlanGuard,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A page's fee bump (Speed up) of a send plan's transactions (#188). The
// send guard refuses a bump's claim over an input a plan holds, and a
// completed plan holds its payment's inputs until the payment confirms or
// the plan is dismissed: the bump's assessment asks the guard the same
// question, so it never offers a bump whose signing would be refused.

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
// The harness signs with placeholder signatures, which a bump's check that
// the account signed the original cannot verify; every other check of the
// assessment runs as it does for a payment the keyring signed.
vi.mock('../src/utils/qbit-fee-bump', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/utils/qbit-fee-bump')>()),
  qbitP2mrTransactionSignedBy: vi.fn(() => true),
}))

let world: World
let worlds: World[] = []

function newGuard(): void {
  newPlanGuard(guardHolder)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.clearAllMocks()
  lockState.isUnlocked = true
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
  vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
  newGuard()
  world = new World(lockState, newGuard)
  worlds.push(world)
  wirePlanKeyring(world)
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

/**
 * The explorer reports what a transaction of the plan pays in fees, as a
 * real one does and as a bump's assessment checks against the original's
 * bytes; the fake reports none, and knows no inputs of the funding.
 */
function reportFees(): void {
  const esploraTx = world.explorer.esploraTx.bind(world.explorer)
  vi.spyOn(world.explorer, 'esploraTx').mockImplementation((tx, options) => {
    const shown = esploraTx(tx, options)
    const known = !tx.coinbase && tx.inputs.every(input => world.explorer.txs.has(input.txid))
    return known ? { ...shown, fee: world.feeOf(tx.txid) } : shown
  })
}

/**
 * One merge of 106 outputs, then a payment of 120,000,000 bits whose change
 * covers a bump at the next whole rate.
 */
async function onePlan() {
  reportFees()
  world.fund(150, 1_000_000)
  await world.open()
  return world.startPlan({ target: { kind: 'amount', amount: 120_000_000 } })
}

describe('a page’s fee bump of a send plan’s transactions', () => {
  it('refuses one of an open plan’s merge for the reason it did before plans held payments', async () => {
    const plan = await onePlan()
    const merge = plan.steps[0]!.txid
    // A merge pays one output back to the account and nothing else, which no
    // bump can take a fee from: refused before any hold is looked at.
    expect(await world.wallet.getQbitFeeBumpEligibility(merge)).toEqual({
      eligible: false,
      reason: 'unverifiable',
    })
    await expect(
      world.wallet.createBumpFeeQbitPsbt({ txid: merge, feeRate: 50 })
    ).rejects.toThrow('(unverifiable)')
  })

  it('offers none of a completed plan’s pending payment, whose signing the guard refuses, until the plan is dismissed; then it is offered and signs', async () => {
    const plan = await onePlan()
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed', paymentTxid: plan.paymentTxid })
    const payment = plan.paymentTxid
    expect(world.tx(payment).height).toBeUndefined()
    // The completed plan holds its payment's inputs while the payment is unconfirmed.
    const record = qbitSendPlanStore.list()[0]!
    const inputs = inputsOfPsbt(record.steps.at(-1)!.unsignedPsbtHex)
    const held = await world.planHeld()
    expect(inputs.every(key => held.has(key))).toBe(true)

    // The assessment asks the guard what the bump's claim is refused for.
    expect(await world.wallet.getQbitFeeBumpEligibility(payment)).toEqual({
      eligible: false,
      reason: 'held_by_send_plan',
    })
    await expect(
      world.wallet.createBumpFeeQbitPsbt({ txid: payment, feeRate: 2 })
    ).rejects.toThrow('(held_by_send_plan)')
    // A bump built without that answer, as one was before, is refused at its
    // signing, before any signature, for that very hold.
    const guard = guardHolder.guard as QbitSendGuardService
    vi.spyOn(guard, 'getPlanHeldOutpointKeys').mockResolvedValueOnce(new Set())
    const unseen = await world.wallet.createBumpFeeQbitPsbt({ txid: payment, feeRate: 2 })
    const signatures = world.keyring.signed.length
    await expect(world.wallet.signPsbtV2(unseen)).rejects.toThrow('held by an open send plan')
    expect(world.keyring.signed).toHaveLength(signatures)

    // Dismissed, the plan lets go: the payment is bumped like any pending one.
    await world.wallet.dismissQbitSendPlan(plan.id)
    expect(await world.planHeld()).toEqual(new Set())
    expect(await world.wallet.getQbitFeeBumpEligibility(payment)).toMatchObject({
      eligible: true,
      originalTxid: payment,
    })
    const bump = await world.wallet.createBumpFeeQbitPsbt({ txid: payment, feeRate: 2 })
    const signed = await world.wallet.signPsbtV2(bump)
    expect(signed.qbitSendBroadcastClaim).toMatchObject({ replaces: payment })
    expect(world.keyring.signed).toHaveLength(signatures + 1)
  })
})
