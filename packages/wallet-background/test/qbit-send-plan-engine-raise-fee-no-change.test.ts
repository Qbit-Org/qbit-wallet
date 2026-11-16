import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type QbitSendPlanReview, type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
import { qbitSendPlanAccountKeys } from '../src/utils/qbit-send-plan-psbt'
import {
  lowestQbitSendPlanPaymentRaiseRate,
  priceQbitSendPlanPayment,
  type QbitSendPlanRevisionShape,
} from '../src/utils/qbit-send-plan-revision'
import {
  CHAIN,
  RECIPIENT_SCRIPT,
  T0,
  World,
  account,
  isBroadcast,
  newPlanGuard,
  nodeRejection,
  once,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A raise of a send plan's payment fee (#188) builds the payment again over
// the same inputs, and is offered only when it builds a different payment
// that pays more than every version of it so far (#206). A payment for an
// exact amount whose remainder below dust went to the fee already pays as
// fee all its inputs hold above the amount, whatever the rate: priced again
// it is the very transaction it was. Every scenario ends checking, over
// everything the explorer ever accepted, that the recipient is paid by
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

/**
 * 107 outputs of 100,000 bits: one merge of 106, then a payment of two
 * inputs (the merge's output and the one output left), whose size is small
 * enough that a remainder below dust is worth many hundredths of a bit/vB.
 */
const COUNT = 107
const VALUE = 100_000
/** A remainder that a change output cannot return (less than dust once its own fee is paid). */
const FOLDED = 2_000

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

async function raise(view: QbitSendPlanView, feeRate: number) {
  return world.prepare({
    target:
      view.target === 'everything'
        ? { kind: 'everything' }
        : { kind: 'amount', amount: view.amount },
    feeRate,
    revise: { planId: view.id, kind: 'raise_payment_fee' },
  })
}

async function reviewRaise(view: QbitSendPlanView, feeRate: number): Promise<QbitSendPlanReview> {
  const result = await raise(view, feeRate)
  if (!result.ok) throw new Error(`raise refused: ${result.reason}`)
  return result.review
}

/** Mine and tick until the plan completes, at most `blocks` times. */
async function confirmUntilCompleted(blocks = 3): Promise<QbitSendPlanView> {
  for (let block = 0; block < blocks && (await world.plan())?.phase !== 'completed'; block++) {
    world.mine()
    await world.tick()
  }
  const view = (await world.plan())!
  expect(view).toMatchObject({ phase: 'completed' })
  return view
}

/**
 * The 107 outputs funded, and what a plan sending everything of them sends
 * and pays: one merge, then a payment of two inputs without change.
 */
async function everythingOfTheOutputs(): Promise<QbitSendPlanReview> {
  world.fund(COUNT, VALUE)
  await world.open()
  const everything = await world.review({ target: { kind: 'everything' } })
  expect(everything.merges).toHaveLength(1)
  expect(everything.payment.inputCount).toBe(2)
  expect(everything.change).toBe(0)
  return everything
}

/**
 * A plan for `amount` started, its merge confirmed, and its payment refused
 * by the network for its fee, until `world.refuse` lets it go.
 */
async function refusedForItsFee(amount: number) {
  await world.startPlan({ target: { kind: 'amount', amount } })
  const payment = stored().steps.at(-1)!
  world.refuse.set(payment.txid, nodeRejection('mempool min fee not met'))
  world.mine()
  await world.tick()
  const view = (await world.plan())!
  expect(view).toMatchObject({ phase: 'paused', pause: { reason: 'payment_fee_too_low' } })
  return { view, payment }
}

/**
 * A plan for an exact amount whose remainder below dust went to the fee,
 * its payment refused for its fee: the payment's fee is all its two inputs
 * hold above the amount.
 */
async function withoutChangeRefused() {
  const everything = await everythingOfTheOutputs()
  const amount = everything.amount - FOLDED
  const { view, payment } = await refusedForItsFee(amount)
  const record = stored()
  expect(record.change).toBe(0)
  expect(payment.inputs).toHaveLength(2)
  expect(payment.fee).toBe(everything.payment.fee + FOLDED)
  expect(payment.inputs.reduce((total, input) => total + input.satoshis, 0)).toBe(
    amount + payment.fee
  )
  // A rate between the plan's and the one the payment's fee pays already:
  // priced at it, the payment is the very transaction it was.
  const within = (record.feeRate + payment.fee / payment.vsize) / 2
  return { view, payment, amount, within }
}

describe('a payment for an exact amount without change, refused for its fee', () => {
  it('offers no raise of its fee, and cancel ends the plan with the funds combined in the account', async () => {
    const { view, payment } = await withoutChangeRefused()
    expect(view.actions).toEqual(['continue', 'cancel'])
    const [merge] = stored().steps
    expect(merge).toMatchObject({ kind: 'merge', status: 'confirmed' })

    // The merge stays as it is, the payment goes, and so does every hold.
    expect(await world.wallet.cancelQbitSendPlan(view.id)).toBeNull()
    await world.settle()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    // The funds are in the account: the merge's output, unspent, and the
    // output the payment would have spent with it.
    const unspent = world.explorer.unspent(account.address)
    expect(payment.inputs.map(input => `${input.txid}:${input.vout}`)).toEqual([
      `${merge!.txid}:0`,
      expect.any(String),
    ])
    for (const input of payment.inputs) expect(unspent).toContain(`${input.txid}:${input.vout}`)
    expect(world.pushed.filter(txid => txid === payment.txid)).toHaveLength(1)
    world.assertRecipientGuarantees(undefined)
  })

  it('refuses a review of the raise asked for anyway, at any rate, with a reason, and writes nothing', async () => {
    const { view, within } = await withoutChangeRefused()
    const before = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    const announced = world.events.length
    const batches = world.keyring.batches.size
    // A page showing an earlier view of the plan may still offer the raise.
    for (const feeRate of [within, 2, 50]) {
      expect(await raise(view, feeRate)).toEqual({
        ok: false,
        reason: 'fee_not_raisable',
        maxSendable: 0,
        unconfirmedSatoshis: 0,
      })
    }
    expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(before)
    expect(world.events).toHaveLength(announced)
    expect(world.keyring.batches.size).toBe(batches)
    expect(drafts().size).toBe(0)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['continue', 'cancel'],
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('checks the request at the boundary before it refuses the raise', async () => {
    const { view, amount } = await withoutChangeRefused()
    const before = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    const revise = { planId: view.id, kind: 'raise_payment_fee' }
    const target = { kind: 'amount', amount }
    // The rate crosses a JSON port: NaN and Infinity arrive as null.
    for (const feeRate of [null, Number.NaN, Infinity, 0.1, 10_001, '2', undefined]) {
      await expect(world.prepare({ target, feeRate, revise }), `${feeRate}`).rejects.toThrow()
    }
    await expect(
      world.prepare({ target: { kind: 'amount', amount: amount - 1 }, feeRate: 2, revise })
    ).rejects.toThrow('same target')
    await expect(
      world.prepare({
        target,
        feeRate: 2,
        revise: { planId: 'f'.repeat(32), kind: 'raise_payment_fee' },
      })
    ).rejects.toThrow('not open')
    expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(before)
    expect(drafts().size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('sends the same payment again on continue, pausing again with no raise until the network takes it', async () => {
    const { view, payment, amount } = await withoutChangeRefused()
    await world.wallet.continueQbitSendPlan(view.id, world.shownTerms(view.id))
    await world.settle()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['continue', 'cancel'],
    })
    expect(world.pushed.filter(txid => txid === payment.txid)).toHaveLength(2)

    world.refuse.delete(payment.txid)
    await world.wallet.continueQbitSendPlan(view.id, world.shownTerms(view.id))
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'completed', paymentTxid: payment.txid })
    expect(world.feeOf(payment.txid)).toBe(payment.fee)
    world.assertRecipientGuarantees(amount)
  })

  it('offers no raise after a refusal without a reason either, leaving continue, a review again and cancel', async () => {
    const everything = await everythingOfTheOutputs()
    const amount = everything.amount - FOLDED
    await world.startPlan({ target: { kind: 'amount', amount } })
    world.mine()
    world.explorer.failures.push(
      once(request =>
        isBroadcast(request)
          ? {
              status: 400,
              body: JSON.stringify({ error: 'sendrawtransaction RPC error: {"code":-26}' }),
            }
          : undefined
      )
    )
    await world.tick()
    const view = (await world.plan())!
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue', 'replan', 'cancel'],
    })
    expect(await raise(view, 2)).toMatchObject({ ok: false, reason: 'fee_not_raisable' })
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a raise that leaves no change', () => {
  it('is the last raise offered: refused again for its fee, the plan offers continue and cancel', async () => {
    const everything = await everythingOfTheOutputs()
    // The payment returns change at the plan's rate; at 1.3 bits/vB what is
    // left is below dust, and goes to the fee.
    const funds = everything.amount + everything.payment.fee
    const amount = funds - 11_000
    const { view, payment } = await refusedForItsFee(amount)
    expect(stored().change).toBeGreaterThan(0)
    expect(view.actions).toEqual(['raise_payment_fee', 'continue', 'cancel'])

    const review = await reviewRaise(view, 1.3)
    expect(review).toMatchObject({ amount, change: 0, payment: { fee: 11_000 } })
    world.refuse.set(review.payment.txid, nodeRejection('mempool min fee not met'))
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const raised = (await world.plan())!
    expect(raised).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      paymentTxid: review.payment.txid,
      actions: ['continue', 'cancel'],
    })
    expect(stored().earlierPayments).toEqual([
      expect.objectContaining({ txid: payment.txid, dispatch: 'refused' }),
    ])
    expect(await raise(raised, 2)).toMatchObject({ ok: false, reason: 'fee_not_raisable' })

    expect(await world.wallet.cancelQbitSendPlan(raised.id)).toBeNull()
    await world.settle()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })
})

describe('raises that pay more', () => {
  /** 150 outputs of a million bits: one merge of 106, and a payment of 45 inputs. */
  async function refusedPlan(target: Record<string, unknown>, count = 150, value = 1_000_000) {
    world.fund(count, value)
    await world.open()
    await world.startPlan({ target })
    world.mine()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? nodeRejection('min relay fee not met') : undefined))
    )
    await world.tick()
    const view = (await world.plan())!
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['raise_payment_fee', 'continue', 'cancel'],
    })
    return view
  }

  it('raises a payment that sends everything by lowering the amount', async () => {
    const view = await refusedPlan({ kind: 'everything' }, 250, 100_000)
    const before = stored()
    const payment = before.steps.at(-1)!
    const review = await reviewRaise(view, 2)
    expect(review).toMatchObject({ target: 'everything', change: 0, previousAmount: before.amount })
    expect(review.payment.fee).toBeGreaterThan(payment.fee)
    expect(review.amount).toBe(before.amount - (review.payment.fee - payment.fee))
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await confirmUntilCompleted()).toMatchObject({
      amount: review.amount,
      paymentTxid: review.payment.txid,
    })
    world.assertRecipientGuarantees(review.amount)
  })

  it('raises a payment with change as before, the amount kept and the extra fee from the change', async () => {
    const amount = 120_000_000
    const view = await refusedPlan({ kind: 'amount', amount })
    const before = stored()
    const payment = before.steps.at(-1)!
    const review = await reviewRaise(view, 2)
    expect(review).toMatchObject({ amount, feeRate: 2 })
    expect(review.payment.fee).toBeGreaterThan(payment.fee)
    expect(review.change).toBe(before.change - (review.payment.fee - payment.fee))
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await confirmUntilCompleted()).toMatchObject({ paymentTxid: review.payment.txid })
    world.assertRecipientGuarantees(amount)
    expect(world.feeOf(review.payment.txid)).toBe(review.payment.fee)
  })

  it('refuses a raise whose fee would equal the payment’s, and takes one paying a bit more', async () => {
    // At this rate the payment's size times the rate is no whole number, so
    // a slightly higher rate rounds up to the same fee.
    world.fund(150, 1_000_000)
    await world.open()
    const amount = 120_000_000
    await world.startPlan({ target: { kind: 'amount', amount }, feeRate: 1.00001 })
    world.mine()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? nodeRejection('min relay fee not met') : undefined))
    )
    await world.tick()
    const view = (await world.plan())!
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['raise_payment_fee', 'continue', 'cancel'],
    })
    const before = stored()
    const payment = before.steps.at(-1)!
    expect(before.change).toBeGreaterThan(0)
    const exact = payment.vsize * before.feeRate
    expect(Math.ceil(exact)).toBe(payment.fee)
    expect(Number.isInteger(exact)).toBe(false)

    // Above the plan's rate, the same fee: the very same transaction.
    const same = (exact + payment.fee) / 2 / payment.vsize
    expect(same).toBeGreaterThan(before.feeRate)
    expect(Math.ceil(payment.vsize * same)).toBe(payment.fee)
    const stored0 = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
    expect(await raise(view, same)).toEqual({
      ok: false,
      reason: 'fee_rate_too_low',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
      minimumFeeRate: 1.01,
    })
    expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(stored0)
    expect(drafts().size).toBe(0)

    // One bit more: another transaction, which starts and pays.
    const more = (payment.fee + 0.5) / payment.vsize
    const review = await reviewRaise(view, more)
    expect(review.payment).toMatchObject({ fee: payment.fee + 1 })
    expect(review.payment.txid).not.toBe(payment.txid)
    expect(review.change).toBe(before.change - 1)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({
      phase: 'completed',
      paymentTxid: review.payment.txid,
    })
    expect(world.feeOf(review.payment.txid)).toBe(payment.fee + 1)
    world.assertRecipientGuarantees(amount)
  })
})

describe('a large payment whose change is just above dust, refused for its fee', () => {
  /**
   * 211 outputs: one merge of 106, then a payment of 106 inputs. A hundredth
   * of a bit/vB more is about 4,000 bits on its size. Resolves to what the
   * payment's inputs hold, its fee at 1 bit/vB with change, and the least
   * change a raise to 1.01 bits/vB can take: from there the change pays the
   * payment's fee at 1.01 without change; below it no rate in hundredths,
   * the only rates a page sends, can be paid, though a finer one could.
   */
  async function largePayment() {
    world.fund(211, 1_000_000)
    await world.open()
    const everything = await world.review({ target: { kind: 'everything' } })
    expect(everything.payment.inputCount).toBe(106)
    // At 1 bit/vB a fee is the size; a change output adds 43 bytes.
    const withoutChange = everything.payment.fee
    const withChange = withoutChange + 43
    return {
      funds: everything.amount + withoutChange,
      withChange,
      leastRaisingChange: Math.ceil(withoutChange * 1.01) - withChange,
    }
  }

  it.each<[string, (leastRaisingChange: number) => number]>([
    ['2,900', () => 2_900],
    ['3,500', () => 3_500],
    ['one bit below what a raise to 1.01 can take', leastRaisingChange => leastRaisingChange - 1],
  ])(
    'offers no raise with change %s, and refuses a review of one at any rate, writing nothing',
    async (_label, changeOf) => {
      const { funds, withChange, leastRaisingChange } = await largePayment()
      const change = changeOf(leastRaisingChange)
      expect(change).toBeGreaterThanOrEqual(2_855)
      expect(change).toBeLessThan(leastRaisingChange)
      const amount = funds - withChange - change
      const { view, payment } = await refusedForItsFee(amount)
      expect(stored().change).toBe(change)
      expect(payment.fee).toBe(withChange)
      expect(view.actions).toEqual(['continue', 'cancel'])
      const before = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
      // Every rate a page can send, and a finer one, which would raise the
      // fee by a bit but which no page sends.
      for (const feeRate of [1.01, 1.02, 1.5, 2, 10, 10_000, 1.000001]) {
        expect(await raise(view, feeRate), `${feeRate}`).toEqual({
          ok: false,
          reason: 'fee_not_raisable',
          maxSendable: 0,
          unconfirmedSatoshis: 0,
        })
      }
      expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(before)
      expect(drafts().size).toBe(0)

      expect(await world.wallet.cancelQbitSendPlan(view.id)).toBeNull()
      await world.settle()
      expect(world.storedPlans()).toEqual([])
      expect((await world.planHeld()).size).toBe(0)
      world.assertRecipientGuarantees(undefined)
    }
  )

  it('offers the raise one bit of change later, and a raise to 1.01 starts and pays', async () => {
    const { funds, withChange, leastRaisingChange } = await largePayment()
    const amount = funds - withChange - leastRaisingChange
    const { view, payment } = await refusedForItsFee(amount)
    expect(stored().change).toBe(leastRaisingChange)
    expect(view.actions).toEqual(['raise_payment_fee', 'continue', 'cancel'])
    world.refuse.delete(payment.txid)

    // The plan's own rate is no raise: the refusal names the lowest that is.
    expect(await raise(view, 1)).toMatchObject({
      ok: false,
      reason: 'fee_rate_too_low',
      minimumFeeRate: 1.01,
    })
    const review = await reviewRaise(view, 1.01)
    // The change goes to the fee: the raised payment returns none.
    expect(review).toMatchObject({
      amount,
      change: 0,
      payment: { fee: withChange + leastRaisingChange },
    })
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({
      phase: 'completed',
      paymentTxid: review.payment.txid,
    })
    expect(world.feeOf(review.payment.txid)).toBe(review.payment.fee)
    world.assertRecipientGuarantees(amount)
  })
})

describe('the lowest rate that raises a payment’s fee', () => {
  const keys = qbitSendPlanAccountKeys(account.p2mr.pubkey)
  const shape: QbitSendPlanRevisionShape = {
    paymentOutputScriptLengths: [RECIPIENT_SCRIPT.length / 2],
    accountScriptLength: keys.scriptPubKey.length,
    leafScriptLength: keys.leafScript.length,
    controlBlockLength: keys.controlBlock.length,
  }
  const FUNDS = 200_000
  /** An amount whose payment of two inputs at 1 bit/vB pays `FOLDED` more than its fee as fee. */
  const amountWithoutChange = (): number => {
    const everything = priceQbitSendPlanPayment(shape, FUNDS, 2, { kind: 'everything' }, 1)
    if (!everything.ok) throw new Error('not priced')
    return everything.amount - FOLDED
  }

  it('is none when the highest fee paid is all the inputs hold above the amount, and the first rate past the plan’s for a bit less', () => {
    const amount = amountWithoutChange()
    const target = { kind: 'amount', amount } as const
    const paid = priceQbitSendPlanPayment(shape, FUNDS, 2, target, 1)
    expect(paid).toMatchObject({ ok: true, change: 0, fee: FUNDS - amount })
    // Priced again at a higher rate, still the same fee.
    expect(priceQbitSendPlanPayment(shape, FUNDS, 2, target, 1.2)).toMatchObject({
      ok: true,
      fee: FUNDS - amount,
    })
    expect(lowestQbitSendPlanPaymentRaiseRate(shape, FUNDS, 2, target, 1, FUNDS - amount)).toBe(
      undefined
    )
    expect(lowestQbitSendPlanPaymentRaiseRate(shape, FUNDS, 2, target, 1, FUNDS - amount - 1)).toBe(
      1.01
    )
  })

  it('names the first rate past the plan’s that pays more, for everything and with change', () => {
    const everything = priceQbitSendPlanPayment(shape, FUNDS, 2, { kind: 'everything' }, 1)
    if (!everything.ok) throw new Error('not priced')
    expect(
      lowestQbitSendPlanPaymentRaiseRate(shape, FUNDS, 2, { kind: 'everything' }, 1, everything.fee)
    ).toBe(1.01)
    const withChange = { kind: 'amount', amount: 100_000 } as const
    const priced = priceQbitSendPlanPayment(shape, FUNDS, 2, withChange, 1)
    expect(priced).toMatchObject({ ok: true, includeChange: true })
    if (!priced.ok) throw new Error('not priced')
    expect(lowestQbitSendPlanPaymentRaiseRate(shape, FUNDS, 2, withChange, 1, priced.fee)).toBe(
      1.01
    )
    // A fee paid by an earlier version at a higher rate: the first rate that pays more.
    const earlier = priceQbitSendPlanPayment(shape, FUNDS, 2, withChange, 3)
    if (!earlier.ok) throw new Error('not priced')
    const lowest = lowestQbitSendPlanPaymentRaiseRate(shape, FUNDS, 2, withChange, 1, earlier.fee)
    expect(lowest).toBe(3.01)
  })

  it('is none past the policy’s highest rate, or when every higher fee leaves less than dust', () => {
    expect(
      lowestQbitSendPlanPaymentRaiseRate(shape, FUNDS, 2, { kind: 'everything' }, 10_000, 0)
    ).toBe(undefined)
    // Everything of funds that a fee at 1 bit/vB leaves exactly dust of.
    const tight = priceQbitSendPlanPayment(shape, 1_000_000, 2, { kind: 'everything' }, 1)
    if (!tight.ok) throw new Error('not priced')
    const funds = tight.fee + 2_855
    expect(priceQbitSendPlanPayment(shape, funds, 2, { kind: 'everything' }, 1)).toMatchObject({
      ok: true,
      amount: 2_855,
    })
    expect(
      lowestQbitSendPlanPaymentRaiseRate(shape, funds, 2, { kind: 'everything' }, 1, tight.fee)
    ).toBe(undefined)
  })

  it('is none for 106 inputs whose change no rate in hundredths can take, and 1.01 a bit of change later', () => {
    const funds = 106_000_000
    const everything = priceQbitSendPlanPayment(shape, funds, 106, { kind: 'everything' }, 1)
    if (!everything.ok) throw new Error('not priced')
    const withChange = everything.fee + 43
    const leastRaisingChange = Math.ceil(everything.fee * 1.01) - withChange
    const short = { kind: 'amount', amount: funds - withChange - (leastRaisingChange - 1) } as const
    expect(priceQbitSendPlanPayment(shape, funds, 106, short, 1)).toMatchObject({
      ok: true,
      change: leastRaisingChange - 1,
      fee: withChange,
    })
    expect(lowestQbitSendPlanPaymentRaiseRate(shape, funds, 106, short, 1, withChange)).toBe(
      undefined
    )
    // A step finer than any a page sends would raise the fee.
    expect(priceQbitSendPlanPayment(shape, funds, 106, short, 1.000001)).toMatchObject({
      ok: true,
      fee: withChange + 1,
    })
    const enough = { kind: 'amount', amount: funds - withChange - leastRaisingChange } as const
    expect(lowestQbitSendPlanPaymentRaiseRate(shape, funds, 106, enough, 1, withChange)).toBe(1.01)
    expect(priceQbitSendPlanPayment(shape, funds, 106, enough, 1.01)).toMatchObject({
      ok: true,
      change: 0,
      fee: withChange + leastRaisingChange,
    })
  })
})
