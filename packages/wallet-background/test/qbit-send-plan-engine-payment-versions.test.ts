import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bytesToHex, extractP2mrTransaction } from '@qbit-oss/protocol'
import { type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore from '../src/services/qbitSendPlanStore'
import { qbitSendPlanPsbtFromHex } from '../src/utils/qbit-send-plan-psbt'
import { fakeTxid } from './qbit-fake-explorer'
import {
  CHAIN,
  PAYER,
  PAYER_SCRIPT,
  RECIPIENT,
  RECIPIENT_SCRIPT,
  T0,
  World,
  account,
  isBroadcast,
  isLookup,
  newPlanGuard,
  nodeRejection,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// Every version of a send plan's payment whose bytes left the wallet (#188).
// A payment whose broadcast had no verdict and that the explorer then missed
// for the whole grace is proven absent, so the same bytes go out again, or a
// raise of its fee builds it again over the same inputs: neither can pay the
// recipient twice. But a node may still hold it, and it may still confirm:
// the plan remembers it, a spend of the payment's inputs by any version is
// the payment having gone through, and no replan pays the recipient again
// from other outputs while one may still confirm.

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

function stored() {
  const record = qbitSendPlanStore.list()[0]
  if (!record) throw new Error('no plan stored')
  return record
}

/** The stored plan's view as a page would be shown it now, without advancing the plan. */
function shownNow(): QbitSendPlanView {
  return world.engine.viewOf(stored())
}

const VALUE = 1_000_000
/** 121 of the 150 outputs: one merge of 106, and a payment of 16 inputs with change. */
const AMOUNT = 120_000_000

/**
 * A plan whose merges confirmed and whose payment P1 went out without a
 * verdict (the gateway failed before the explorer took it), and a restart:
 * every lookup then misses P1 for the whole grace, so it is proven absent
 * and sent again, and the network refuses it with `refusal`. (Within one
 * session the broadcast path keeps the earlier attempt's unknown outcome, so
 * a later refusal proves nothing; after a restart it does.) Resolves to the
 * paused view, unlocked, and P1's id and raw bytes.
 */
async function paymentMissedThenRefused(refusal: {
  status: number
  body: string
}): Promise<{ view: QbitSendPlanView; p1: string; p1Raw: string }> {
  world.fund(150, VALUE)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const p1 = plan.paymentTxid
  // Nothing of the payment has left the wallet yet.
  expect(plan.paymentMayConfirm).toBeUndefined()
  const signed = stored().steps.at(-1)!.signedPsbtHex!
  const p1Raw = bytesToHex(extractP2mrTransaction(qbitSendPlanPsbtFromHex(signed)))
  world.mine()
  // Every attempt of this broadcast fails at the gateway, the explorer never
  // having taken it.
  world.explorer.failures.push(request =>
    isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
  )
  await world.tick()
  world.explorer.failures.length = 0
  expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
  expect(world.explorer.txs.has(p1)).toBe(false)
  // From the broadcast without a verdict on, the view says P1 may still confirm.
  expect(shownNow()).toMatchObject({ phase: 'sending', paymentMayConfirm: true })
  await world.restart()
  world.refuse.set(p1, refusal)
  await world.tick()
  await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
  expect(world.storedStatuses()).toEqual(['confirmed', 'signed'])
  expect(stored().steps.at(-1)!.dispatch).toBe('unknown')
  world.refuse.delete(p1)
  await world.unlock()
  const view = (await world.plan())!
  expect(view.phase).toBe('paused')
  // Proven absent and refused when sent again, P1 may still confirm.
  expect(view.paymentMayConfirm).toBe(true)
  return { view, p1, p1Raw }
}

async function raisePayment(view: QbitSendPlanView, feeRate: number) {
  const result = await world.prepare({
    target: { kind: 'amount', amount: view.amount },
    feeRate,
    revise: { planId: view.id, kind: 'raise_payment_fee' },
  })
  if (!result.ok) throw new Error(`raise refused: ${result.reason}`)
  return result.review
}

/** P1's bytes reach the network by another way after all, and a block confirms them. */
async function p1MinedAnyway(p1Raw: string): Promise<void> {
  const answer = await world.explorer.fetch('https://explorer.invalid/api/tx', {
    method: 'POST',
    body: p1Raw,
  })
  expect(answer.status).toBe(200)
  world.mine()
}

describe('earlier versions of the payment', () => {
  it('completes with P1 when P1, missed for the grace and replaced by a raise, is mined anyway: the recipient is paid once', async () => {
    const { view, p1, p1Raw } = await paymentMissedThenRefused(
      nodeRejection('mempool min fee not met')
    )
    expect(view).toMatchObject({ pause: { reason: 'payment_fee_too_low' } })
    const review = await raisePayment(view, 2)
    const p2 = review.payment.txid
    expect(p2).not.toBe(p1)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    // P1 is mined while P2 is signed and before it goes.
    let signingP2: QbitSendPlanView | undefined
    world.keyring.beforeInput = async (txid, index) => {
      if (txid === p2 && index === 0) {
        signingP2 = shownNow()
        await p1MinedAnyway(p1Raw)
      }
    }
    await world.settle()
    await world.tick()
    world.keyring.beforeInput = undefined
    // While P2 is signed, P1, its earlier version, may still confirm.
    expect(signingP2).toMatchObject({ phase: 'signing', paymentMayConfirm: true })

    const done = (await world.plan())!
    expect(done).toMatchObject({ phase: 'completed', paymentTxid: p1, amount: AMOUNT })
    expect(done.actions).toEqual(['dismiss'])
    expect(done.paymentMayConfirm).toBeUndefined()
    expect(stored().steps.at(-1)).toMatchObject({ txid: p1, status: 'confirmed' })
    expect(stored().earlierPayments).toBeUndefined()
    // P2, if it went out at all, was refused: it spends what P1 spent.
    expect(world.explorer.txs.has(p2)).toBe(false)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('completes with P2 when P1 is never mined and the raise’s P2 is accepted, forgetting P1 once P2 confirms', async () => {
    const { view, p1 } = await paymentMissedThenRefused(nodeRejection('mempool min fee not met'))
    const review = await raisePayment(view, 2)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const completed = (await world.plan())!
    expect(completed).toMatchObject({
      phase: 'completed',
      paymentTxid: review.payment.txid,
    })
    // P1 may still confirm instead while P2 has not; but the plan has paid
    // the recipient, whichever version confirms, and says nothing of P1.
    expect(stored().earlierPayments).toEqual([
      expect.objectContaining({ txid: p1, dispatch: 'unknown', amount: AMOUNT }),
    ])
    expect(completed.paymentMayConfirm).toBeUndefined()
    world.mine()
    await world.tick()
    // A completed plan is advanced when a page reads it.
    await world.plan()
    expect(stored().steps.at(-1)).toMatchObject({ txid: review.payment.txid, status: 'confirmed' })
    expect(stored().earlierPayments).toBeUndefined()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('offers and prepares no replan while P1, missed and never mined, may still confirm; offers one once an input of it is spent elsewhere', async () => {
    const { view, p1 } = await paymentMissedThenRefused(
      nodeRejection('non-mandatory-script-verify-flag')
    )
    // Refused for no reason a raise or a wait would change: a replan would
    // be offered, but P1 may still confirm, and a replan pays from other
    // outputs; nor is a cancel, which would stop tracking P1.
    expect(view).toMatchObject({
      pause: { reason: 'payment_refused' },
      actions: ['continue'],
      paymentMayConfirm: true,
    })
    await expect(
      world.prepare({
        target: { kind: 'amount', amount: AMOUNT },
        revise: { planId: view.id, kind: 'replan' },
      })
    ).rejects.toThrow('does not offer')

    // Something else spends one of P1's inputs and confirms: no version of
    // the payment can confirm any more, and the replan is offered.
    const direct = stored().steps.at(-1)!.inputs.at(-1)!
    world.explorer.addTx({
      txid: fakeTxid(9_999, 5),
      inputs: [{ txid: direct.txid, vout: direct.vout }],
      outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: direct.satoshis - 10_000 }],
      height: world.explorer.tipHeight + 1,
    })
    await world.wallet.continueQbitSendPlan(view.id)
    await world.settle()
    const spent = (await world.plan())!
    expect(spent).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: ['replan', 'cancel'],
    })
    expect(spent.paymentMayConfirm).toBeUndefined()
    expect(stored().steps.at(-1)!.dispatch).toBeUndefined()
    expect(world.explorer.txs.has(p1)).toBe(false)
    world.assertRecipientGuarantees(undefined)
  })

  it('offers no raise of a merge’s fee once the payment’s bytes left the wallet: every version keeps the same inputs', async () => {
    const { view, p1 } = await paymentMissedThenRefused(nodeRejection('mempool min fee not met'))
    // A reorganisation takes the merge out again, and it stays unconfirmed
    // for long: before the payment went out, a raise of its fee was offered.
    const merge = stored().steps[0]!
    delete world.tx(merge.txid).height
    // Past the tick in which the merge was last read confirmed.
    await world.tick()
    await world.wallet.continueQbitSendPlan(view.id)
    await world.settle()
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    await world.tick(31 * 60_000)
    const slow = (await world.plan())!
    // Nor a cancel: P1 may still confirm, and the view says so while the
    // plan waits.
    expect(slow).toMatchObject({ phase: 'waiting', actions: [], paymentMayConfirm: true })
    expect(slow.slowMerge).toBeUndefined()
    await expect(
      world.prepare({
        target: { kind: 'amount', amount: AMOUNT },
        feeRate: 2,
        revise: { planId: view.id, kind: 'raise_merge_fee' },
      })
    ).rejects.toThrow('does not offer')
    // The merge confirms again, and the same payment goes.
    world.mine()
    await world.tick()
    const done = (await world.plan())!
    expect(done).toMatchObject({ phase: 'completed', paymentTxid: p1 })
    expect(done.paymentMayConfirm).toBeUndefined()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('completes with a transaction no version of the payment is, which spends its inputs and pays the recipient the amount', async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const merge = stored().steps[0]!
    // Before the merge confirms, a transaction the plan does not know spends
    // its output and pays the recipient the plan's amount.
    const other = world.explorer.addTx({
      txid: fakeTxid(9_998, 5),
      inputs: [{ txid: merge.txid, vout: 0 }],
      outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
    })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'completed',
      paymentTxid: other.txid,
      amount: AMOUNT,
      actions: ['dismiss'],
    })
    expect(stored().paidBy).toEqual({ txid: other.txid, amount: AMOUNT, fee: 0 })
    expect(stored().steps.at(-1)!.signedPsbtHex).toBeUndefined()
    expect(world.pushed).not.toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * A cancel asked for while a version of the payment may still confirm: it
 * answers with the plan as it is, and changes nothing of it, its holds
 * included.
 */
async function expectCancelRefused(planId: string): Promise<void> {
  const before = stored()
  const held = await world.planHeld()
  const answer = await world.wallet.cancelQbitSendPlan(planId)
  await world.settle()
  expect(answer).toMatchObject({ id: planId, phase: before.phase, paymentMayConfirm: true })
  expect(answer!.actions).not.toContain('cancel')
  expect(stored()).toMatchObject({ revision: before.revision, phase: before.phase })
  expect(await world.planHeld()).toEqual(held)
}

describe('a plan a version of whose payment may still confirm', () => {
  it('is never cancelled into nothing: no cancel is offered or made, it holds on, and completes once P1 is mined, paying once', async () => {
    const { view, p1, p1Raw } = await paymentMissedThenRefused(
      nodeRejection('non-mandatory-script-verify-flag')
    )
    expect(view).toMatchObject({ pause: { reason: 'payment_refused' }, actions: ['continue'] })
    // The view says why, and that something may be in the network; the
    // pause's technical detail is the refusal's own.
    expect(view.sent).toBe(true)
    expect(view.paymentMayConfirm).toBe(true)
    expect(view.pause?.detail).toBe(stored().pause?.detail)
    await expectCancelRefused(view.id)
    // P1's inputs stay held: nothing else can spend them, so nothing can pay
    // the recipient a second time.
    const held = await world.planHeld()
    for (const input of stored().steps.at(-1)!.inputs) {
      expect(held.has(`${input.txid}:${input.vout}`)).toBe(true)
    }

    await p1MinedAnyway(p1Raw)
    // Past the tick in which P1 was last read missing; a page's read
    // advances the paused plan.
    await world.tick()
    await world.plan()
    expect(await world.plan()).toMatchObject({
      phase: 'completed',
      paymentTxid: p1,
      actions: ['dismiss'],
    })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('offers no cancel while an earlier version may still confirm, though the payment now is refused, and completes with that version', async () => {
    const { view, p1, p1Raw } = await paymentMissedThenRefused(
      nodeRejection('mempool min fee not met')
    )
    const review = await raisePayment(view, 2)
    const p2 = review.payment.txid
    world.refuse.set(p2, nodeRejection('non-mandatory-script-verify-flag'))
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const paused = (await world.plan())!
    // P2 was only ever refused, but P1 may still confirm.
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue'],
      paymentMayConfirm: true,
    })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p2, status: 'signed', dispatch: 'refused' })
    expect(stored().earlierPayments).toEqual([
      expect.objectContaining({ txid: p1, dispatch: 'unknown' }),
    ])
    await expectCancelRefused(paused.id)

    world.refuse.delete(p2)
    await p1MinedAnyway(p1Raw)
    await world.tick()
    await world.plan()
    expect(await world.plan()).toMatchObject({ phase: 'completed', paymentTxid: p1 })
    expect(world.explorer.txs.has(p2)).toBe(false)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('says the plan sent something when the one transaction that left it is a version of the payment that may still confirm', async () => {
    const outpoints = world.fund(150, index => VALUE + index)
    await world.open()
    // Ranked by value, the merge spends the 106 largest outputs: refused
    // every time, it pauses the plan, which never sent anything.
    world.refuseSpending.add(outpoints[100]!)
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    await world.tick()
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'merge_refused' },
    })
    world.refuseSpending.clear()
    // A large output arrives: the replan pays from it alone, without a merge.
    world.fund(1, 2 * AMOUNT)
    const review = await world.review({
      target: { kind: 'amount', amount: AMOUNT },
      revise: { planId: plan.id, kind: 'replan' },
    })
    expect(review.merges).toEqual([])
    expect(review.paidFee).toBe(0)
    // Every attempt of its payment's broadcast fails at the gateway, the
    // explorer never taking it: the payment's outcome is unknown.
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    world.explorer.failures.length = 0
    expect(world.storedStatuses()).toEqual(['unknown'])
    await world.restart()
    world.refuse.set(review.payment.txid, nodeRejection('non-mandatory-script-verify-flag'))
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    await world.unlock()
    const paused = (await world.plan())!
    expect(world.storedStatuses()).toEqual(['signed'])
    expect(stored().steps.at(-1)!.dispatch).toBe('unknown')
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue'],
      sent: true,
      paymentMayConfirm: true,
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('lets go of P1 once a merge it spends can never confirm: the merge, sent again, is refused for spent inputs the explorer shows spent elsewhere', async () => {
    const { view } = await paymentMissedThenRefused(
      nodeRejection('non-mandatory-script-verify-flag')
    )
    const merge = stored().steps[0]!
    // A reorganisation takes the merge out, and a transaction the plan does
    // not know spends one of its inputs in the block that replaces it.
    world.explorer.removeTx(merge.txid)
    const input = merge.inputs[0]!
    world.explorer.addTx({
      txid: fakeTxid(9_997, 5),
      inputs: [{ txid: input.txid, vout: input.vout }],
      outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: input.satoshis - 10_000 }],
      height: world.explorer.tipHeight + 1,
    })
    await world.wallet.continueQbitSendPlan(view.id)
    await world.settle()
    // Missed for the whole grace, the merge is proven absent and must be
    // signed again: the continue approved no signature of a merge that had
    // confirmed, so the user continues once more.
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      actions: ['continue'],
      paymentMayConfirm: true,
    })
    await world.wallet.continueQbitSendPlan(view.id)
    await world.settle()
    await world.tick()
    await world.tick()
    // The node names spent inputs, and the explorer shows what spends one:
    // the merge can never confirm, so no version of the payment can.
    const settled = (await world.plan())!
    expect(settled).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: ['replan', 'cancel'],
    })
    expect(settled.paymentMayConfirm).toBeUndefined()
    expect(stored().steps.at(-1)!.dispatch).toBeUndefined()
    expect(stored().earlierPayments).toBeUndefined()
    world.assertRecipientGuarantees(undefined)
  })
})

describe('what the view says of a version of the payment that may still confirm', () => {
  it('says nothing of one for a payment the network only ever refused outright', async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    world.refuse.set(plan.paymentTxid, nodeRejection('non-mandatory-script-verify-flag'))
    world.mine()
    await world.tick()
    const paused = (await world.plan())!
    // Every broadcast of it was refused: no version can confirm, so the
    // plan offers a replan and a cancel, and says nothing of one.
    expect(stored().steps.at(-1)).toMatchObject({ status: 'signed', dispatch: 'refused' })
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue', 'replan', 'cancel'],
    })
    expect(paused.paymentMayConfirm).toBeUndefined()
    // Nothing is in doubt: no timer keeps checking it.
    expect(world.timers.scheduled).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a paused plan a version of whose payment may still confirm, every page closed', () => {
  it('keeps checking by itself and completes once that version is mined, signing and sending nothing meanwhile', async () => {
    const { view, p1, p1Raw } = await paymentMissedThenRefused(
      nodeRejection('non-mandatory-script-verify-flag')
    )
    expect(view).toMatchObject({ phase: 'paused', paymentMayConfirm: true })
    // The engine's timer, not a page, advances it from here.
    expect(world.timers.scheduled).toBe(1)
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    for (let tick = 0; tick < 3; tick++) {
      const before = world.explorer.requests.length
      await world.tick()
      // Each version is looked up at most once a tick.
      const lookups = world.explorer.requests
        .slice(before)
        .filter(request => isLookup(request) && request.path.includes(p1))
      expect(lookups.length).toBeLessThanOrEqual(1)
      expect(world.timers.scheduled).toBe(1)
    }
    expect(stored()).toMatchObject({ phase: 'paused' })
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)

    await p1MinedAnyway(p1Raw)
    await world.tick()
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p1, status: 'confirmed' })
    // Completed: no timer is left for it.
    expect(world.timers.scheduled).toBe(0)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    expect(await world.plan()).toMatchObject({ phase: 'completed', paymentTxid: p1 })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('forgets that version by itself once an input of the payment is spent by a transaction that is no version, and offers a replan and a cancel again', async () => {
    const { view, p1 } = await paymentMissedThenRefused(
      nodeRejection('non-mandatory-script-verify-flag')
    )
    expect(view).toMatchObject({ actions: ['continue'], paymentMayConfirm: true })
    // Something else spends one of the payment's inputs and confirms.
    const direct = stored().steps.at(-1)!.inputs.at(-1)!
    world.explorer.addTx({
      txid: fakeTxid(9_996, 5),
      inputs: [{ txid: direct.txid, vout: direct.vout }],
      outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: direct.satoshis - 10_000 }],
      height: world.explorer.tipHeight + 1,
    })
    // Ticks alone read what spends the payment's inputs, a few transactions at a time.
    for (let tick = 0; tick < 4 && stored().steps.at(-1)!.dispatch !== undefined; tick++) {
      await world.tick()
    }
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(stored().steps.at(-1)!.dispatch).toBeUndefined()
    expect(stored().earlierPayments).toBeUndefined()
    // Nothing is in doubt any more: the timer stops.
    expect(world.timers.scheduled).toBe(0)
    const shown = (await world.plan())!
    expect(shown).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: ['replan', 'cancel'],
    })
    expect(shown.paymentMayConfirm).toBeUndefined()
    expect(world.explorer.txs.has(p1)).toBe(false)
    world.assertRecipientGuarantees(undefined)
  })

  it('checks nothing while the engine is halted for a reset, and checks again once it resumes', async () => {
    await paymentMissedThenRefused(nodeRejection('non-mandatory-script-verify-flag'))
    expect(world.timers.scheduled).toBe(1)
    await world.engine.halt()
    expect(world.timers.scheduled).toBe(0)
    const before = world.explorer.requests.length
    await world.tick()
    await world.tick()
    expect(world.explorer.requests).toHaveLength(before)
    await world.engine.resume()
    await world.settle()
    expect(world.timers.scheduled).toBe(1)
    expect(stored()).toMatchObject({ phase: 'paused' })
    world.assertRecipientGuarantees(undefined)
  })
})
