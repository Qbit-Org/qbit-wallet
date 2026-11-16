import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type QbitSendPlanReview, type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_MAX_EARLIER_PAYMENTS,
  QBIT_SEND_PLAN_STORE_KEY,
} from '../src/services/qbitSendPlanStore'
import {
  CHAIN,
  T0,
  World,
  account,
  newPlanGuard,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A raise of a send plan's payment fee keeps the payment it builds again as
// an earlier version of it (#188), and a plan keeps at most
// `QBIT_SEND_PLAN_MAX_EARLIER_PAYMENTS` of them. A raise past them cannot
// start: it is not offered once the payment's versions are at the limit,
// and one a page showing an earlier view asks for anyway is refused with a
// reason the page shows, never thrown (#206). Every scenario ends checking,
// over everything the explorer ever accepted, that the recipient is paid by
// exactly one transaction of a reviewed amount, or not at all.

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

const LIMIT = QBIT_SEND_PLAN_MAX_EARLIER_PAYMENTS
/**
 * What the plan pays, out of 112 outputs of a million bits: a merge of 106
 * of them, then a payment of the merge's output and the outputs left, whose
 * change pays every raise's fee.
 */
const AMOUNT = 108_000_000
/** How a node's refusal without a reason reaches the wallet: an RPC code only. */
const WITHOUT_A_REASON = {
  status: 400,
  body: JSON.stringify({ error: 'sendrawtransaction RPC error: {"code":-26}' }),
}

/** The stored plan, as the engine last wrote it. */
function stored() {
  const record = qbitSendPlanStore.list()[0]
  if (!record) throw new Error('no plan stored')
  return record
}

/** What the engine keeps of reviews not started yet. */
function drafts(): Map<string, unknown> {
  return (world.engine as unknown as { drafts: Map<string, unknown> }).drafts
}

async function raise(view: QbitSendPlanView, feeRate: unknown) {
  return world.prepare({
    target: { kind: 'amount', amount: view.amount },
    feeRate,
    revise: { planId: view.id, kind: 'raise_payment_fee' },
  })
}

async function reviewRaise(view: QbitSendPlanView, feeRate: number): Promise<QbitSendPlanReview> {
  const result = await raise(view, feeRate)
  if (!result.ok) throw new Error(`raise refused: ${result.reason}`)
  return result.review
}

/**
 * A plan for `AMOUNT` started and its merge confirmed, every version of
 * whose payment, all spending the same inputs, the network refuses for its
 * fee: paused on the payment's fee, offering its raise.
 */
async function refusedForItsFee(): Promise<QbitSendPlanView> {
  world.fund(112, 1_000_000)
  await world.open()
  await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const payment = stored().steps.at(-1)!
  expect(stored().change).toBeGreaterThan(0)
  for (const input of payment.inputs) world.refuseSpending.add(`${input.txid}:${input.vout}`)
  world.mine()
  await world.tick()
  const view = (await world.plan())!
  expect(view).toMatchObject({
    phase: 'paused',
    pause: { reason: 'payment_fee_too_low' },
    actions: ['raise_payment_fee', 'continue', 'cancel'],
  })
  return view
}

/**
 * Raise the payment's fee of the plan `view` shows, to `feeRate`, and start
 * the raise: the new version is sent, and refused as the network refuses
 * it then. Resolves to the plan's view once it paused again.
 */
async function raiseAndStart(view: QbitSendPlanView, feeRate: number): Promise<QbitSendPlanView> {
  const review = await reviewRaise(view, feeRate)
  expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
  await world.settle()
  const next = (await world.plan())!
  expect(next).toMatchObject({ phase: 'paused', paymentTxid: review.payment.txid })
  return next
}

/**
 * The payment's fee raised `times` times, to 2, 3, ... bits/vB, every
 * version refused for its fee: the plan keeps `times` earlier versions of
 * its payment. Resolves to the view after the last refusal.
 */
async function raisedTimes(times: number): Promise<QbitSendPlanView> {
  let view = await refusedForItsFee()
  for (let raised = 1; raised <= times; raised++) {
    expect(view.actions).toContain('raise_payment_fee')
    view = await raiseAndStart(view, raised + 1)
    expect(view.pause).toMatchObject({ reason: 'payment_fee_too_low' })
    expect(stored().earlierPayments).toHaveLength(raised)
  }
  return view
}

describe('a payment whose fee was raised as many times as a plan keeps versions of it', () => {
  it('offers the raise that the plan can keep the last version for, and none once that one is refused too', async () => {
    const before = await raisedTimes(LIMIT - 1)
    // One more raise fits: the payment it replaces is the last earlier
    // version the plan can keep.
    expect(before.actions).toEqual(['raise_payment_fee', 'continue', 'cancel'])
    expect(before.paymentFeeRaiseLimitReached).toBeUndefined()

    const view = await raiseAndStart(before, LIMIT + 1)
    expect(stored().earlierPayments).toHaveLength(LIMIT)
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['continue', 'cancel'],
      paymentFeeRaiseLimitReached: true,
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('refuses a raise a page showing an earlier view asks for anyway, at any rate, with its own reason, and writes nothing', async () => {
    const earlier = await raisedTimes(LIMIT - 1)
    await raiseAndStart(earlier, LIMIT + 1)
    const before = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    const announced = world.events.length
    const batches = world.keyring.batches.size
    const pushed = world.pushed.length
    // Above the plan's rate, at the highest a page can send, and below the
    // plan's rate: no raise can start, whatever the rate.
    for (const feeRate of [LIMIT + 2, 50, 10_000, 1.5]) {
      expect(await raise(earlier, feeRate), `${feeRate}`).toEqual({
        ok: false,
        reason: 'fee_raise_limit_reached',
        maxSendable: 0,
        unconfirmedSatoshis: 0,
      })
    }
    // A rate the boundary does not take is refused there first.
    for (const feeRate of [null, Number.NaN, 0.1, 10_001, '20']) {
      await expect(raise(earlier, feeRate), `${feeRate}`).rejects.toThrow()
    }
    expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(before)
    expect(world.events).toHaveLength(announced)
    expect(world.keyring.batches.size).toBe(batches)
    expect(world.pushed).toHaveLength(pushed)
    expect(drafts().size).toBe(0)
    expect(stored().earlierPayments).toHaveLength(LIMIT)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['continue', 'cancel'],
      paymentFeeRaiseLimitReached: true,
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('sends the same payment again on continue, and completes once the network takes it, paying once', async () => {
    const view = await raisedTimes(LIMIT)
    const payment = stored().steps.at(-1)!
    await world.wallet.continueQbitSendPlan(view.id, world.shownTerms(view.id))
    await world.settle()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['continue', 'cancel'],
      paymentFeeRaiseLimitReached: true,
    })
    expect(world.pushed.filter(txid => txid === payment.txid)).toHaveLength(2)

    world.refuseSpending.clear()
    await world.wallet.continueQbitSendPlan(view.id, world.shownTerms(view.id))
    await world.settle()
    const completed = (await world.plan())!
    expect(completed).toMatchObject({ phase: 'completed', paymentTxid: payment.txid })
    expect(completed.paymentFeeRaiseLimitReached).toBeUndefined()
    expect(world.feeOf(payment.txid)).toBe(payment.fee)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('cancels with nothing sent, as no version left the wallet but refused, and lets go of every hold', async () => {
    const view = await raisedTimes(LIMIT)
    expect(await world.wallet.cancelQbitSendPlan(view.id)).toBeNull()
    await world.settle()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('offers continue, a replan and cancel after a refusal without a reason, no raise; the replan keeps no earlier version and pays', async () => {
    const before = await raisedTimes(LIMIT - 1)
    world.refusal = WITHOUT_A_REASON
    const view = await raiseAndStart(before, LIMIT + 1)
    expect(stored().earlierPayments).toHaveLength(LIMIT)
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue', 'replan', 'cancel'],
      paymentFeeRaiseLimitReached: true,
    })
    expect(await raise(before, 50)).toMatchObject({ ok: false, reason: 'fee_raise_limit_reached' })

    // A replan is a plan of its own over the account's outputs: it keeps no
    // earlier version of the payment, however many the plan it replaces kept.
    world.refuseSpending.clear()
    const replan = await world.review({
      target: { kind: 'amount', amount: AMOUNT },
      feeRate: 2,
      revise: { planId: view.id, kind: 'replan' },
    })
    expect(await world.wallet.startQbitSendPlan(replan.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(stored().earlierPayments).toBeUndefined()
    const completed = (await world.plan())!
    expect(completed).toMatchObject({ phase: 'completed', paymentTxid: replan.payment.txid })
    world.assertRecipientGuarantees(AMOUNT)
  })
})
