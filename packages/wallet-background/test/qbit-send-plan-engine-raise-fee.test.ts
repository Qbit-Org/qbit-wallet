import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type QbitSendPlanReview, type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import {
  QBIT_SEND_PLAN_SLOW_MERGE_MS,
  QBIT_SEND_PLAN_TICK_MS,
} from '../src/services/qbitSendPlanEngine'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore from '../src/services/qbitSendPlanStore'
import { fakeTxid } from './qbit-fake-explorer'
import {
  CHAIN,
  PAYER,
  PAYER_SCRIPT,
  T0,
  World,
  account,
  isBroadcast,
  isLookup,
  newPlanGuard,
  nodeRejection,
  once,
  p2mrAccount,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// Raising the fee inside an open send plan (#188): a merge that stays
// unconfirmed is replaced by one paying more, and a payment the network
// refuses for its fee is built again at a higher rate. In both the
// recipient is paid by exactly one transaction, and an amount never
// changes; every scenario ends checking that over everything the explorer
// ever accepted (`World.assertGuarantees`).

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

/** Long enough for a merge accepted and still unconfirmed to count as slow. */
const SLOW_MS = QBIT_SEND_PLAN_SLOW_MERGE_MS + 60_000

/**
 * Outputs of a million bits: a plan for an amount returns change below the
 * smallest output it spends (a shorter prefix would pay otherwise), so only
 * outputs this large leave change that can absorb a full merge's extra fee.
 */
const VALUE = 1_000_000
/** 121 of the 150 outputs: one merge of 106, and a payment of 16 inputs with change. */
const AMOUNT = 120_000_000

/**
 * `count` outputs of `value` bits, a plan of `target` started over them,
 * every merge sent and still unconfirmed after `SLOW_MS`. The explorer
 * takes a replacement paying more, evicting the merge it replaces.
 */
async function slowPlan(
  target: Record<string, unknown> = { kind: 'amount', amount: AMOUNT },
  count = 150,
  value = VALUE
): Promise<QbitSendPlanView> {
  world.fund(count, value)
  await world.open()
  world.explorer.acceptReplacements = true
  const started = await world.startPlan({ target })
  expect(started.phase).toBe('signing')
  let view = (await world.plan())!
  expect(view).toMatchObject({ phase: 'waiting', actions: ['cancel'] })
  expect(view.slowMerge).toBeUndefined()
  await world.tick(SLOW_MS)
  view = (await world.plan())!
  expect(view).toMatchObject({ phase: 'waiting', slowMerge: true })
  return view
}

/** The stored plan, as the engine last wrote it. */
function stored() {
  const record = qbitSendPlanStore.list()[0]
  if (!record) throw new Error('no plan stored')
  return record
}

async function raise(
  view: QbitSendPlanView,
  kind: 'raise_merge_fee' | 'raise_payment_fee',
  feeRate: number
) {
  return world.prepare({
    target:
      view.target === 'everything'
        ? { kind: 'everything' }
        : { kind: 'amount', amount: view.amount },
    feeRate,
    revise: { planId: view.id, kind },
  })
}

async function reviewRaise(
  view: QbitSendPlanView,
  kind: 'raise_merge_fee' | 'raise_payment_fee',
  feeRate: number
): Promise<QbitSendPlanReview> {
  const result = await raise(view, kind, feeRate)
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

describe('raising a slow merge’s fee', () => {
  it('offers the raise once a merge has stayed unconfirmed for long, and pays the same amount through one replacement', async () => {
    const view = await slowPlan()
    expect(view.actions).toEqual(['raise_merge_fee', 'cancel'])
    const before = stored()
    const [merge, payment] = before.steps
    const held = await world.planHeld()

    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    expect(review).toMatchObject({
      revises: { planId: view.id, kind: 'raise_merge_fee' },
      target: 'amount',
      amount: AMOUNT,
      feeRate: 2,
      paidFee: 0,
    })
    expect(review.previousAmount).toBeUndefined()
    expect(review.merges).toHaveLength(1)
    expect(review.merges[0]!.fee).toBeGreaterThanOrEqual(merge!.fee + merge!.vsize)
    expect(review.change).toBeLessThan(before.change)
    expect(review.payment.txid).not.toBe(payment!.txid)
    expect(review.totalFee).toBe(review.merges[0]!.fee + review.payment.fee)
    // What the replaced merge's inputs and the payment's inputs need.
    expect(review.signatureCount).toBe(merge!.inputs.length + payment!.inputs.length)
    expect(review.signatureBudget).toMatchObject({ required: review.signatureCount })

    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started).toMatchObject({ ok: true })
    await world.settle()
    const after = stored()
    const [replacement, rebuilt] = after.steps
    expect(replacement).toMatchObject({
      status: 'broadcast',
      replaces: { txid: merge!.txid, fee: merge!.fee },
      inputs: merge!.inputs,
    })
    expect(replacement!.txid).not.toBe(merge!.txid)
    expect(rebuilt).toMatchObject({ txid: review.payment.txid, status: 'signed' })
    expect(after.feeRate).toBe(2)
    // The explorer took the replacement in the merge's place.
    expect(world.explorer.txs.has(merge!.txid)).toBe(false)
    expect(world.feeOf(replacement!.txid)).toBe(review.merges[0]!.fee)
    // Until one of them confirms, both versions' outputs stay held, and
    // every input.
    const holding = await world.planHeld()
    expect([...held].every(key => holding.has(key))).toBe(true)
    expect(holding.has(`${replacement!.txid}:0`)).toBe(true)
    expect(holding.has(`${merge!.txid}:0`)).toBe(true)
    expect(await world.plan()).toMatchObject({ actions: ['cancel'], revision: expect.any(Number) })

    world.mine()
    await world.tick()
    const confirmed = stored()
    expect(confirmed.steps[0]!.replaces).toBeUndefined()
    expect((await world.planHeld()).has(`${merge!.txid}:0`)).toBe(false)
    const done = await confirmUntilCompleted()
    expect(done.totalFee).toBe(review.totalFee)
    world.assertRecipientGuarantees(AMOUNT)
    expect(world.feeOf(review.payment.txid)).toBe(review.payment.fee)
    expect(world.tx(review.payment.txid).outputs.at(-1)).toMatchObject({ value: review.change })
    // The payment signed against the replaced merge never left the wallet.
    expect(world.pushed).not.toContain(payment!.txid)
  })

  it('reads the merges’ times as stored, leaving out what is not a time', async () => {
    const view = await slowPlan()
    const record = stored()
    const [merge] = record.steps
    const broadcastAt = (record.extra?.['mergeBroadcastAt'] as Record<string, number>)[merge!.txid]!
    // Bookkeeping some other version wrote next to the times: not read as one.
    await qbitSendPlanStore.put(
      {
        ...record,
        extra: {
          ...record.extra,
          mergeBroadcastAt: { [merge!.txid]: broadcastAt, ['ab'.repeat(32)]: 'soon' },
          mergeConfirmedAt: [1, 2],
        },
      },
      record.revision
    )
    expect(await world.plan()).toMatchObject({ id: view.id, slowMerge: true })
    // Its broadcast time kept the merge slow, and a raise keeps it with the merge.
    const review = await reviewRaise((await world.plan())!, 'raise_merge_fee', 2)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(stored().extra).toMatchObject({ mergeConfirmedAt: {} })
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('says something was sent while a raised merge’s replacement is not signed yet', async () => {
    const view = await slowPlan()
    expect(view.sent).toBe(true)
    const merge = stored().steps[0]!
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    // The wallet locks as the replacement's signing begins: the plan pauses
    // with the replacement not signed, and the merge it replaces in the
    // network, paying its fee.
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) void world.wallet.lockWallet()
    }
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    world.keyring.beforeInput = undefined
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'locked' },
      actions: ['cancel'],
      sent: true,
    })
    expect(paused.steps.map(step => step.status)).toEqual(['planned', 'planned'])
    expect(stored().steps[0]!.replaces?.txid).toBe(merge.txid)
    expect(world.explorer.txs.get(merge.txid)?.height).toBeUndefined()
    await world.unlock()
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('says nothing was sent while no transaction of the plan has gone out', async () => {
    world.fund(150, VALUE)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) void world.wallet.lockWallet()
    }
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'locked' },
      sent: false,
    })
    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting', sent: true })
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('raises everything: every merge replaced, the amount recomputed, stating the one it replaces', async () => {
    const view = await slowPlan({ kind: 'everything' }, 250, 100_000)
    const before = stored()
    expect(before.steps).toHaveLength(3)
    const review = await reviewRaise(view, 'raise_merge_fee', 2.5)
    expect(review).toMatchObject({ target: 'everything', previousAmount: before.amount, change: 0 })
    expect(review.amount).toBeLessThan(before.amount)
    expect(review.merges).toHaveLength(2)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const after = stored()
    expect(after.steps.slice(0, 2).map(step => step.replaces?.txid)).toEqual(
      before.steps.slice(0, 2).map(step => step.txid)
    )
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(review.amount)
    expect(world.tx(review.payment.txid).outputs).toHaveLength(1)
  })

  it('refuses a raise the change cannot absorb, with the largest amount it can send', async () => {
    world.fund(150, 100_000)
    await world.open()
    const largest = (await world.review({ target: { kind: 'everything' } })).amount
    const amount = largest - 200_000
    freshWorldWith150()
    const view = await slowPlanOf(amount)
    const refused = await raise(view, 'raise_merge_fee', 3)
    expect(refused).toMatchObject({ ok: false, reason: 'insufficient_balance' })
    const maxSendable = (refused as { maxSendable: number }).maxSendable
    expect(maxSendable).toBeGreaterThan(0)
    expect(maxSendable).toBeLessThan(amount)
    // Nothing changed.
    expect(stored().feeRate).toBe(1)
    expect(stored().steps[0]!.replaces).toBeUndefined()
  })

  it('refuses a rate not above the plan’s, or too low to replace its merge, naming the lowest that works', async () => {
    const view = await slowPlan()
    for (const feeRate of [1, 0.5]) {
      const refused = await raise(view, 'raise_merge_fee', feeRate)
      expect(refused, `${feeRate}`).toMatchObject({ ok: false, reason: 'fee_rate_too_low' })
    }
    // Above the plan's rate, but short of a bit a byte more for the merge.
    const short = await raise(view, 'raise_merge_fee', 1.5)
    expect(short).toMatchObject({ ok: false, reason: 'fee_rate_too_low' })
    const minimum = (short as { minimumFeeRate?: number }).minimumFeeRate!
    expect(minimum).toBeGreaterThan(1.99)
    expect(Math.round(minimum * 100)).toBe(minimum * 100)
    const below = await raise(view, 'raise_merge_fee', Math.round(minimum * 100 - 1) / 100)
    expect(below).toMatchObject({ ok: false, reason: 'fee_rate_too_low', minimumFeeRate: minimum })
    expect(await raise(view, 'raise_merge_fee', minimum)).toMatchObject({ ok: true })
  })

  it('validates the raise at the boundary: malformed rates, a plan that is not open, another account’s plan', async () => {
    const view = await slowPlan()
    const revise = { planId: view.id, kind: 'raise_merge_fee' }
    const target = { kind: 'amount', amount: AMOUNT }
    for (const feeRate of [null, Number.NaN, Infinity, 0.1, 10_001, '3']) {
      await expect(world.prepare({ target, feeRate, revise }), `${feeRate}`).rejects.toThrow()
    }
    await expect(
      world.prepare({
        target,
        feeRate: 3,
        revise: { planId: 'f'.repeat(32), kind: 'raise_merge_fee' },
      })
    ).rejects.toThrow('not open')
    await expect(
      world.prepare({ target: { kind: 'amount', amount: AMOUNT - 1 }, feeRate: 3, revise })
    ).rejects.toThrow('same target')
    // Another account selected: its plan is not this one.
    const other = p2mrAccount('22'.repeat(32))
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(other as never)
    await expect(world.prepare({ target, feeRate: 3, revise })).rejects.toThrow('not open')
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
    expect(stored().feeRate).toBe(1)
  })

  it('waits while a merge’s outcome is unknown, and refuses a second raise until the first has settled', async () => {
    world.fund(250, 100_000)
    await world.open()
    world.explorer.acceptReplacements = true
    const review = await world.review({ target: { kind: 'everything' } })
    // The second merge's answer is lost and nothing can look it up.
    let broadcasts = 0
    world.explorer.failures.push(request => {
      if (!isBroadcast(request)) return undefined
      broadcasts += 1
      return broadcasts === 2
        ? { status: 502, body: 'bad gateway', afterAccepting: true }
        : undefined
    })
    // Nothing can be looked up while the plan starts; then only the second merge.
    let refused: (path: string) => boolean = () => true
    world.explorer.failures.push(request =>
      isLookup(request) && refused(request.path)
        ? { status: 400, body: 'lookup refused' }
        : undefined
    )
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    const unknownTxid = stored().steps[1]!.txid
    refused = path => path.includes(unknownTxid)
    expect(stored().steps.map(step => step.status)).toEqual(['broadcast', 'unknown', 'signed'])
    await world.tick(SLOW_MS)
    const view = (await world.plan())!
    expect(view.slowMerge).toBe(true)
    expect(await raise(view, 'raise_merge_fee', 3)).toMatchObject({
      ok: false,
      reason: 'outputs_unavailable',
    })
    // Found at last: the raise goes through.
    refused = () => false
    await world.tick()
    const first = await reviewRaise((await world.plan())!, 'raise_merge_fee', 3)
    expect(first.merges).toHaveLength(2)
    expect(await world.wallet.startQbitSendPlan(first.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const replaced = stored()
      .steps.slice(0, 2)
      .map(step => step.replaces!.txid)
    // The replacements have only just gone out: no raise is offered, and
    // none is prepared.
    const raised = (await world.plan())!
    expect(raised.actions).toEqual(['cancel'])
    await expect(raise(raised, 'raise_merge_fee', 5)).rejects.toThrow(
      'does not offer this revision now'
    )
    // Slow in their turn, while nothing can tell whether the merges they
    // replaced are still in the network: offered, and refused until they
    // have settled.
    refused = path => replaced.some(txid => path.includes(txid))
    await world.tick(SLOW_MS)
    const slowAgain = (await world.plan())!
    expect(slowAgain.actions).toContain('raise_merge_fee')
    expect(await raise(slowAgain, 'raise_merge_fee', 5)).toMatchObject({
      ok: false,
      reason: 'outputs_unavailable',
    })
    // Every lookup misses them now. Not seen for longer than the grace
    // period, but the grace counts from the first miss: settled once the
    // misses have lasted it.
    refused = () => false
    await world.tick()
    expect(
      stored()
        .steps.slice(0, 2)
        .every(step => step.replaces !== undefined)
    ).toBe(true)
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expect(
      stored()
        .steps.slice(0, 2)
        .every(step => step.replaces === undefined)
    ).toBe(true)
    expect(await raise((await world.plan())!, 'raise_merge_fee', 5)).toMatchObject({ ok: true })
    world.mine()
    await world.tick()
    world.assertGuarantees()
  })

  it('refuses, in prepare and in start, a revision the plan does not offer', async () => {
    world.fund(150, VALUE)
    await world.open()
    world.explorer.acceptReplacements = true
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const waiting = (await world.plan())!
    // A merge in the network, but not for long: nothing to raise yet.
    expect(waiting).toMatchObject({ phase: 'waiting', actions: ['cancel'] })
    for (const kind of ['raise_merge_fee', 'raise_payment_fee'] as const) {
      await expect(raise(waiting, kind, 3), kind).rejects.toThrow(
        'does not offer this revision now'
      )
    }
    await expect(
      world.prepare({
        target: { kind: 'amount', amount: AMOUNT },
        revise: { planId: waiting.id, kind: 'replan' },
      })
    ).rejects.toThrow('does not offer this revision now')
    // Start checks again. A raise reviewed while it was offered is not
    // started once the plan stops offering it: here the wall clock went
    // back, and the merge no longer counts as slow. The draft goes.
    await world.tick(SLOW_MS)
    const slow = (await world.plan())!
    expect(slow.actions).toContain('raise_merge_fee')
    const review = await reviewRaise(slow, 'raise_merge_fee', 2)
    vi.setSystemTime(Date.now() - SLOW_MS)
    await expect(world.wallet.startQbitSendPlan(review.draftId)).rejects.toThrow(
      'does not offer this revision now'
    )
    vi.setSystemTime(Date.now() + SLOW_MS)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(stored()).toMatchObject({ feeRate: 1, phase: 'waiting' })
    world.mine()
    await world.tick()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('stops with a replan when the merge it replaced confirms first, and the replan pays the amount', async () => {
    const view = await slowPlan()
    const before = stored()
    const [merge, payment] = before.steps
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    // A block takes the merge while its replacement is being signed.
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      if (signings === 1 && index === 0) world.mine([merge!.txid])
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'merge_refused' },
      actions: ['replan', 'cancel'],
    })
    // The step shows the version that is in the chain.
    expect(paused.steps[0]).toMatchObject({
      txid: merge!.txid,
      status: 'confirmed',
      fee: merge!.fee,
    })
    const voided = stored()
    expect(voided.steps[0]!.replaces).toMatchObject({ txid: merge!.txid, confirmed: true })
    expect(voided.steps.at(-1)).toMatchObject({ status: 'planned' })
    expect(voided.steps.at(-1)!.signedPsbtHex).toBeUndefined()
    // The merge's output is the plan's to spend now; the replacement's is gone.
    const held = await world.planHeld()
    expect(held.has(`${merge!.txid}:0`)).toBe(true)
    expect(held.has(`${voided.steps[0]!.txid}:0`)).toBe(false)
    expect(world.pushed).not.toContain(review.payment.txid)
    expect(world.pushed).not.toContain(payment!.txid)

    const replan = await world.review({
      target: { kind: 'amount', amount: AMOUNT },
      revise: { planId: paused.id, kind: 'replan' },
    })
    expect(replan).toMatchObject({ amount: AMOUNT, paidFee: merge!.fee })
    expect(await world.wallet.startQbitSendPlan(replan.draftId)).toMatchObject({ ok: true })
    await world.settle()
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
    expect(world.recipientOutputs()[0]!.txid).toBe(replan.payment.txid)
  })

  it('stops with a replan when the merge it replaced confirms after the replacement was in the network', async () => {
    const view = await slowPlan()
    const [merge] = stored().steps
    const kept = world.tx(merge!.txid)
    const original = { txid: kept.txid, inputs: [...kept.inputs], outputs: [...kept.outputs] }
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    const replacement = stored().steps[0]!
    expect(replacement.status).toBe('broadcast')
    // A block mines the merge after all: the replacement leaves the mempool.
    world.explorer.removeTx(replacement.txid)
    world.explorer.addTx({ ...original, height: ++world.explorer.tipHeight })
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'merge_refused' },
      actions: ['replan', 'cancel'],
    })
    expect(stored().steps[0]!.replaces).toMatchObject({ confirmed: true })
    expect(world.pushed).not.toContain(review.payment.txid)
    world.assertRecipientGuarantees(undefined)
  })

  it('looks a replacement whose answer was lost up, and records it once found, sending nothing again', async () => {
    const view = await slowPlan()
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    world.explorer.failures.push(
      once(request =>
        isBroadcast(request)
          ? { status: 502, body: 'bad gateway', afterAccepting: true }
          : undefined
      ),
      request => (isLookup(request) ? { status: 400, body: 'lookup refused' } : undefined)
    )
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    const replacement = stored().steps[0]!
    expect(stored().steps.map(step => step.status)).toEqual(['unknown', 'signed'])
    expect(replacement.replaces).toBeDefined()
    world.explorer.failures.length = 0
    await world.tick()
    expect(stored().steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
    expect(world.pushed.filter(txid => txid === replacement.txid)).toHaveLength(1)
    expect(world.keyring.signed.filter(txid => txid === replacement.txid)).toHaveLength(1)
  })

  it('sends a replacement whose answer was lost again only once it is proven absent', async () => {
    const view = await slowPlan()
    const [merge] = stored().steps
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    world.explorer.failures.push(request =>
      isBroadcast(request) ? new TypeError('fetch failed') : undefined
    )
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    const replacement = stored().steps[0]!
    expect(replacement.status).toBe('unknown')
    // Neither version is rebuilt while either may be in the network.
    world.explorer.failures.length = 0
    await world.tick()
    expect(stored().steps[0]!.status).toBe('unknown')
    expect(world.explorer.txs.has(merge!.txid)).toBe(true)
    await world.tick(10 * 60_000)
    expect(stored().steps[0]).toMatchObject({ txid: replacement.txid, status: 'broadcast' })
    expect(world.explorer.txs.has(merge!.txid)).toBe(false)
    expect(world.keyring.signed.filter(txid => txid === replacement.txid)).toHaveLength(1)
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('pauses on a restart between the swap and the signatures, holding both versions, and continue finishes it', async () => {
    const view = await slowPlan()
    const [merge] = stored().steps
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    const reached = hangSigning(1, 50)
    void world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    const replacement = stored().steps[0]!
    expect(replacement).toMatchObject({ status: 'planned', replaces: { txid: merge!.txid } })
    const held = await world.planHeld()
    expect(held.has(`${merge!.txid}:0`)).toBe(true)
    expect(held.has(`${replacement.txid}:0`)).toBe(true)
    expect(replacement.inputs.every(input => held.has(`${input.txid}:${input.vout}`))).toBe(true)

    world.keyring.beforeInput = undefined
    world.keyring.unlock()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    expect(paused.actions).toEqual(['continue', 'cancel'])
    await world.wallet.continueQbitSendPlan(paused.id)
    await world.settle()
    expect(stored().steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('pauses on a lock between the swap and the signatures, and goes on after the unlock', async () => {
    const view = await slowPlan()
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      if (signings === 1 && index === 30) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })
    expect(stored().steps[0]).toMatchObject({ status: 'planned' })
    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('finds a replacement the explorer took before a restart cut its answer, and sends nothing twice', async () => {
    const view = await slowPlan()
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    const accepted = world.explorer.accepted.length
    world.hang = 'accept'
    void world.wallet.startQbitSendPlan(review.draftId)
    await vi.waitFor(() => expect(world.explorer.accepted).toHaveLength(accepted + 1))
    // Written ahead of its broadcast, the replacement's verdict never came.
    const replacement = stored().steps[0]!
    expect(replacement.status).toBe('unknown')
    world.hang = undefined
    await world.restart()
    // Looked up while the plan waits for continue: found.
    expect(stored().steps[0]).toMatchObject({ txid: replacement.txid, status: 'broadcast' })
    world.keyring.unlock()
    const paused = (await world.plan())!
    await world.wallet.continueQbitSendPlan(paused.id)
    await world.settle()
    await world.tick()
    expect(stored().steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
    expect(world.pushed.filter(txid => txid === replacement.txid)).toHaveLength(1)
    expect(world.keyring.signed.filter(txid => txid === replacement.txid)).toHaveLength(1)
  })

  it('records a replacement’s verdict that lands after a lock, then signs the payment after the unlock', async () => {
    const view = await slowPlan()
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    const accepted = world.explorer.accepted.length
    let release: () => void = () => undefined
    world.gate = new Promise(resolve => (release = resolve))
    void world.wallet.startQbitSendPlan(review.draftId)
    await vi.waitFor(() => expect(world.explorer.accepted).toHaveLength(accepted + 1))
    await world.wallet.lockWallet()
    world.gate = undefined
    release()
    await world.settle()
    expect(stored().steps[0]!.status).toBe('broadcast')
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })
    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('still refuses a page’s fee bump of the plan’s merge, and of its replacement', async () => {
    const view = await slowPlan()
    const [merge] = stored().steps
    const before = await world.wallet.getQbitFeeBumpEligibility(merge!.txid)
    expect(before.eligible).toBe(false)
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    const replacement = stored().steps[0]!
    for (const txid of [merge!.txid, replacement.txid]) {
      const bump = await world.wallet.getQbitFeeBumpEligibility(txid)
      expect(bump.eligible, txid).toBe(false)
      await expect(
        world.wallet.createBumpFeeQbitPsbt({ txid, feeRate: 50 }),
        txid
      ).rejects.toThrow()
    }
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('starts a raise whose replaced merge confirmed before its first signature, stopped for a replan, holding what the stored plan needs', async () => {
    world.keyring.restoredFloor = true
    world.fund(150, VALUE)
    await world.open()
    world.explorer.acceptReplacements = true
    const first = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      first.signatureBudget.restoredFloorRisk!.challengeId
    )
    await world.wallet.startQbitSendPlan(first.draftId)
    await world.settle()
    await world.tick(SLOW_MS)
    const view = (await world.plan())!
    const [merge] = stored().steps
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    const challengeId = review.signatureBudget.restoredFloorRisk!.challengeId
    await world.wallet.confirmQbitRestoredFloorSigning(challengeId)
    // The merge confirms while the user reads the review, past the read the
    // review made of it.
    world.mine([merge!.txid])
    vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)

    let returned = false
    const started = world.wallet.startQbitSendPlan(review.draftId).then(result => {
      returned = true
      return result
    })
    await world.settle()
    await vi.waitFor(() => expect(returned).toBe(true))
    expect(await started).toMatchObject({
      ok: true,
      plan: { phase: 'paused', pause: { reason: 'merge_refused' }, actions: ['replan', 'cancel'] },
    })
    // Nothing of the raise was signed, and its challenge is let go of.
    expect(world.keyring.signed).not.toContain(review.payment.txid)
    expect(world.keyring.challenges.has(challengeId)).toBe(false)
    // Held: the merge that confirmed (its output is the plan's to spend
    // now) and the outputs the payment spends directly, and nothing else.
    const after = stored()
    const replacement = after.steps[0]!
    expect(replacement.replaces).toMatchObject({ txid: merge!.txid, confirmed: true })
    const direct = after.steps
      .at(-1)!
      .inputs.filter(input => input.txid !== replacement.txid)
      .map(input => `${input.txid}:${input.vout}`)
    expect(await world.planHeld()).toEqual(new Set([`${merge!.txid}:0`, ...direct]))

    const replan = await world.review({
      target: { kind: 'amount', amount: AMOUNT },
      revise: { planId: view.id, kind: 'replan' },
    })
    await world.wallet.confirmQbitRestoredFloorSigning(
      replan.signatureBudget.restoredFloorRisk!.challengeId
    )
    expect(await world.wallet.startQbitSendPlan(replan.draftId)).toMatchObject({ ok: true })
    await world.settle()
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('offers no raise while the plan signs, and starts one offered once it waits, the plan writing nothing meanwhile', async () => {
    world.fund(350, 100_000)
    await world.open()
    world.explorer.acceptReplacements = true
    const review = await world.review({ target: { kind: 'everything' } })
    expect(review.merges).toHaveLength(3)
    // The second merge's signing waits at its 30th input while the first
    // merge, sent, grows slow.
    const signing = gateSigning(2, 30)
    await world.wallet.startQbitSendPlan(review.draftId)
    await signing.reached
    vi.setSystemTime(Date.now() + SLOW_MS)
    // A signing writes the plan with every merge it sends, and reads none
    // it has sent: no raise is offered, nor any merge called slow, and a
    // page that asks for one anyway is refused.
    const whileSigning = (await world.wallet.getQbitSendPlan())!
    expect(whileSigning).toMatchObject({ phase: 'signing', actions: ['cancel'] })
    expect(whileSigning.slowMerge).toBeUndefined()
    await expect(raise(whileSigning, 'raise_merge_fee', 2)).rejects.toThrow(
      'does not offer this revision now'
    )
    signing.release()
    await world.settle()
    world.keyring.beforeInput = undefined

    const waiting = (await world.plan())!
    expect(waiting).toMatchObject({
      phase: 'waiting',
      slowMerge: true,
      actions: ['raise_merge_fee', 'cancel'],
    })
    const raised = await reviewRaise(waiting, 'raise_merge_fee', 2)
    // The plan advances by itself while the user reads the review, and
    // writes nothing: the review stays that of the stored plan.
    const revision = stored().revision
    for (let count = 0; count < 4; count++) await world.tick()
    expect(stored().revision).toBe(revision)
    expect(await world.wallet.startQbitSendPlan(raised.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(world.storedStatuses()).toEqual(['broadcast', 'broadcast', 'broadcast', 'signed'])
    expect(
      stored()
        .steps.slice(0, 3)
        .every(step => step.replaces !== undefined)
    ).toBe(true)
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(raised.amount)
  })

  it('offers the raise to a slow plan paused for anything but a lock, and starts it, the plan writing nothing meanwhile', async () => {
    world.fund(350, 100_000)
    await world.open()
    world.explorer.acceptReplacements = true
    const review = await world.review({ target: { kind: 'everything' } })
    // A lock stops the second merge's signing at its 30th input.
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      if (signings === 2 && index === 30) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    await world.tick(SLOW_MS)
    // Paused by a lock, the plan signs on by itself on the next unlock: no
    // raise.
    const locked = (await world.plan())!
    expect(locked).toMatchObject({
      phase: 'paused',
      pause: { reason: 'locked' },
      actions: ['cancel'],
    })
    expect(locked.slowMerge).toBeUndefined()

    // After a restart the plan waits for the user instead, and offers it.
    await world.restart()
    await world.unlock()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      slowMerge: true,
      actions: ['continue', 'raise_merge_fee', 'cancel'],
    })
    const raised = await reviewRaise(paused, 'raise_merge_fee', 2)
    const revision = stored().revision
    for (let count = 0; count < 4; count++) await world.tick()
    expect(stored().revision).toBe(revision)
    expect(await world.wallet.startQbitSendPlan(raised.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(world.storedStatuses()).toEqual(['broadcast', 'broadcast', 'broadcast', 'signed'])
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(raised.amount)
  })

  it('carries the plan on at once when a raise’s start finds it changed', async () => {
    const view = await slowPlan()
    const [merge, payment] = stored().steps
    const raised = await reviewRaise(view, 'raise_merge_fee', 2)

    // Another write lands while the swap holds both plans' outputs, and the
    // merge confirms: the swap's write meets a newer revision.
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementationOnce(async (record, readRevision) => {
      const current = stored()
      await put({ ...current }, current.revision)
      world.mine([merge!.txid])
      vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
      return put(record, readRevision)
    })
    expect(await world.wallet.startQbitSendPlan(raised.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    vi.mocked(qbitSendPlanStore.put).mockImplementation(put)
    // No tick: the plan carries on as it was, finds its merge confirmed and
    // sends the payment it signed.
    await world.settle()
    expect(stored()).toMatchObject({ phase: 'completed', feeRate: 1 })
    expect(world.pushed).toContain(payment!.txid)
    expect(world.pushed).not.toContain(raised.payment.txid)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('starts a raise once when two starts of its draft race, its batch and holds those of the stored plan', async () => {
    const view = await slowPlan()
    const [merge] = stored().steps
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    const [first, second] = await Promise.allSettled([
      world.wallet.startQbitSendPlan(review.draftId),
      world.wallet.startQbitSendPlan(review.draftId),
    ])
    expect(first).toMatchObject({ status: 'fulfilled', value: { ok: true } })
    expect(second).toEqual(first)
    await world.settle()
    // Signed through on the batch the start opened, nothing paused.
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    const replacement = stored().steps[0]!
    const held = await world.planHeld()
    expect(held.has(`${replacement.txid}:0`)).toBe(true)
    expect(held.has(`${merge!.txid}:0`)).toBe(true)
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('writes the plan back, holding what it held, when a restored-floor raise’s draft expires while its start writes it', async () => {
    world.keyring.restoredFloor = true
    world.fund(150, VALUE)
    await world.open()
    world.explorer.acceptReplacements = true
    const first = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      first.signatureBudget.restoredFloorRisk!.challengeId
    )
    await world.wallet.startQbitSendPlan(first.draftId)
    await world.settle()
    await world.tick(SLOW_MS)
    const view = (await world.plan())!
    expect(view.actions).toContain('raise_merge_fee')
    const before = stored()
    const held = await world.planHeld()
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const signed = [...world.keyring.signed]
    const confirmations = [...world.keyring.confirmations]
    // The raise's draft expires while its start writes the raise: the
    // challenge the page confirmed goes with it.
    const set = world.storage.set.bind(world.storage)
    let expire = true
    world.storage.set = async (key, value) => {
      if (expire) {
        expire = false
        vi.setSystemTime(review.expiresAt + 1)
        world.timers.runDue()
      }
      return set(key, value)
    }
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    world.storage.set = set
    await world.settle()
    const after = stored()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after.steps).toEqual(before.steps)
    expect(after.feeRate).toBe(before.feeRate)
    expect(await world.planHeld()).toEqual(held)
    expect(world.keyring.signed).toEqual(signed)
    expect(world.keyring.confirmations).toEqual(confirmations)
    expect(world.keyring.challenges.size).toBe(0)
    expect(world.keyring.batches.size).toBe(0)
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('writes the plan back as it was when a raise’s challenge is not confirmed, and starts the same draft once it is', async () => {
    world.keyring.restoredFloor = true
    world.fund(150, VALUE)
    await world.open()
    world.explorer.acceptReplacements = true
    const first = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      first.signatureBudget.restoredFloorRisk!.challengeId
    )
    await world.wallet.startQbitSendPlan(first.draftId)
    await world.settle()
    await world.tick(SLOW_MS)
    const view = (await world.plan())!
    expect(view.actions).toContain('raise_merge_fee')
    const before = stored()
    const held = await world.planHeld()
    const review = await reviewRaise(view, 'raise_merge_fee', 2)
    expect(review.signatureBudget.restoredFloorRisk).toBeDefined()
    const refused = await world.wallet.startQbitSendPlan(review.draftId).catch(error => error)
    expect(refused).toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
    await world.settle()
    const after = stored()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after.steps).toEqual(before.steps)
    expect(after.feeRate).toBe(before.feeRate)
    expect(await world.planHeld()).toEqual(held)
    expect(world.explorer.txs.has(before.steps[0]!.txid)).toBe(true)

    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(stored().steps[0]).toMatchObject({
      status: 'broadcast',
      replaces: { txid: before.steps[0]!.txid },
    })
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('raising the payment’s fee', () => {
  /** A plan whose merges confirmed and whose payment the network refused for its fee. */
  async function feeRefusedPayment(
    target: Record<string, unknown> = { kind: 'amount', amount: AMOUNT },
    count = 150,
    value = VALUE
  ): Promise<QbitSendPlanView> {
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

  it('builds the payment again at a higher rate after the network refused its fee, the amount kept', async () => {
    const view = await feeRefusedPayment()
    const before = stored()
    const [merge, payment] = before.steps
    const review = await reviewRaise(view, 'raise_payment_fee', 2)
    expect(review).toMatchObject({
      amount: AMOUNT,
      feeRate: 2,
      paidFee: merge!.fee,
      merges: [],
      signatureCount: payment!.inputs.length,
    })
    expect(review.change).toBeLessThan(before.change)
    expect(review.payment.fee).toBeGreaterThan(payment!.fee)
    expect(review.totalFee).toBe(merge!.fee + review.payment.fee)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const done = (await world.plan())!
    expect(done).toMatchObject({ phase: 'completed', paymentTxid: review.payment.txid })
    expect(stored().steps[0]).toEqual(merge)
    world.assertRecipientGuarantees(AMOUNT)
    expect(world.feeOf(review.payment.txid)).toBe(review.payment.fee)
  })

  it('builds everything’s payment again at a higher rate, stating the amount it replaces', async () => {
    const view = await feeRefusedPayment({ kind: 'everything' }, 250, 100_000)
    const before = stored()
    const review = await reviewRaise(view, 'raise_payment_fee', 2)
    expect(review).toMatchObject({ target: 'everything', previousAmount: before.amount, change: 0 })
    expect(review.amount).toBe(before.amount - (review.payment.fee - before.steps.at(-1)!.fee))
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount: review.amount })
    world.assertRecipientGuarantees(review.amount)
  })

  it('answers draft_expired, holding nothing, when a cancel removes the plan before a raise’s first hold change', async () => {
    const view = await feeRefusedPayment()
    const review = await reviewRaise(view, 'raise_payment_fee', 2)
    // Another page's cancel removes the plan (nothing of it is unknown)
    // just before the raise changes its holds.
    const guard = guardHolder.guard as {
      replacePlanOutpoints: (...args: never[]) => Promise<unknown>
    }
    const replace = guard.replacePlanOutpoints.bind(guard)
    let cancelled: unknown
    vi.spyOn(guard, 'replacePlanOutpoints').mockImplementationOnce(async (...args) => {
      cancelled = await world.wallet.cancelQbitSendPlan(view.id)
      return replace(...args)
    })
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(cancelled).toBeNull()
    await world.settle()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(world.keyring.batches.size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('refuses a rate not above the plan’s, naming the lowest that works', async () => {
    const view = await feeRefusedPayment()
    expect(await raise(view, 'raise_payment_fee', 1)).toMatchObject({
      ok: false,
      reason: 'fee_rate_too_low',
      minimumFeeRate: 1.01,
    })
    expect(await raise(view, 'raise_payment_fee', 1.01)).toMatchObject({ ok: true })
  })

  it('is neither offered nor prepared once the payment may be in the network', async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    world.mine()
    world.explorer.failures.push(
      once(request =>
        isBroadcast(request)
          ? { status: 502, body: 'bad gateway', afterAccepting: true }
          : undefined
      ),
      request =>
        isLookup(request) && request.path.includes(plan.paymentTxid)
          ? { status: 400, body: 'lookup refused' }
          : undefined
    )
    await world.tick()
    const view = (await world.plan())!
    expect(view).toMatchObject({ phase: 'sending', actions: [] })
    expect(stored().steps.at(-1)!.status).toBe('unknown')
    await expect(raise(view, 'raise_payment_fee', 2)).rejects.toThrow(
      'payment may be in the network'
    )
    world.explorer.failures.length = 0
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a revision and a signing under way', () => {
  it('starts no revision while a signing is under way: a raise reviewed before a continue expires, and the signing goes on untouched', async () => {
    world.fund(250, 100_000)
    await world.open()
    world.explorer.acceptReplacements = true
    const first = await world.review({ target: { kind: 'everything' } })
    // The second merge's signing is cut by a restart: the plan waits for continue.
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      return signings === 2 && index === 50 ? new Promise<void>(() => undefined) : undefined
    }
    void world.wallet.startQbitSendPlan(first.draftId)
    await vi.waitFor(() => expect(signings).toBe(2))
    await world.restart()
    world.keyring.beforeInput = undefined
    world.keyring.unlock()
    await world.tick(SLOW_MS)
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      actions: ['continue', 'raise_merge_fee', 'cancel'],
    })
    const raised = await reviewRaise(paused, 'raise_merge_fee', 2)

    // Continue: the second merge is being signed when the raise starts.
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let reached: () => void = () => undefined
    const signing = new Promise<void>(resolve => (reached = resolve))
    world.keyring.beforeInput = async (_txid, index) => {
      if (index === 30) {
        reached()
        await gate
      }
    }
    const counter = world.keyring.counter
    await world.wallet.continueQbitSendPlan(paused.id)
    await signing
    // The raise reviewed before the continue is refused on the revision it
    // read, before it touches the signing; and no revision is offered while
    // the plan signs.
    expect(await world.wallet.startQbitSendPlan(raised.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    const session = (
      world.engine as unknown as { sessions: Map<string, { stop?: AbortController }> }
    ).sessions.get(paused.id)
    expect(session?.stop?.signal.aborted).toBe(false)
    await expect(raise(paused, 'raise_merge_fee', 3)).rejects.toThrow(
      'does not offer this revision now'
    )
    expect(session?.stop?.signal.aborted).toBe(false)
    release()
    world.keyring.beforeInput = undefined
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const steps = stored().steps
    // Signed once each, from the continue on: the second merge and the payment.
    expect(world.keyring.counter - counter).toBe(steps[1]!.inputs.length + steps[2]!.inputs.length)
    expect(world.keyring.signed.filter(txid => txid === steps[1]!.txid)).toHaveLength(1)
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(first.amount)
  })

  it('checks a raise’s first signature against its unconfirmed challenge when a continue was writing as the raise started', async () => {
    world.keyring.restoredFloor = true
    world.fund(150, VALUE)
    await world.open()
    const first = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      first.signatureBudget.restoredFloorRisk!.challengeId
    )
    await world.wallet.startQbitSendPlan(first.draftId)
    await world.settle()
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
    const review = await reviewRaise(view, 'raise_payment_fee', 2)
    expect(review.signatureBudget.restoredFloorRisk).toBeDefined()

    // The page has not confirmed the raise's challenge. Another page's
    // continue reads the plan while the raise's write is under way, and its
    // own write comes after it.
    const set = world.storage.set.bind(world.storage)
    let continued: Promise<unknown> | undefined
    world.storage.set = async (key, value) => {
      if (!continued) {
        continued = world.wallet.continueQbitSendPlan(view.id).catch(error => error)
      }
      return set(key, value)
    }
    const refused = await world.wallet.startQbitSendPlan(review.draftId).catch(error => error)
    world.storage.set = set
    expect(await continued).toMatchObject({ message: 'The Qbit send plan cannot continue now' })
    // The raise's first signature was checked, and refused: the raise is
    // undone, the plan as it was, the draft kept.
    expect(refused).toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
    await world.settle()
    const after = stored()
    expect(after.steps).toEqual(before.steps)
    expect(after).toMatchObject({ phase: 'paused', feeRate: before.feeRate })

    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({
      phase: 'completed',
      paymentTxid: review.payment.txid,
    })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

/** The node's refusal as the production explorer relays it: its RPC code, and no reason. */
function codeOnly(code: number): { status: number; body: string } {
  return {
    status: 400,
    body: JSON.stringify({ error: `sendrawtransaction RPC error: {"code":${code}}` }),
  }
}

describe('refusals that carry only an RPC code', () => {
  it('pauses a payment refused without a reason, offering a raise with continue and replan, and the raise pays it', async () => {
    world.fund(150, VALUE)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    world.mine()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? codeOnly(-26) : undefined))
    )
    await world.tick()
    const view = (await world.plan())!
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused', detail: expect.stringContaining('-26') },
      actions: ['raise_payment_fee', 'continue', 'replan', 'cancel'],
    })
    world.assertRecipientGuarantees(undefined)
    const review = await reviewRaise(view, 'raise_payment_fee', 2)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({
      phase: 'completed',
      paymentTxid: review.payment.txid,
    })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('goes back to waiting when a payment refused without a reason spends a merge that is no longer confirmed', async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    world.mine()
    const merge = plan.steps[0]!.txid
    // The block that confirmed the merge is replaced as the payment goes out.
    world.explorer.failures.push(
      once(request => {
        if (!isBroadcast(request)) return undefined
        delete world.tx(merge).height
        return codeOnly(-25)
      })
    )
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    world.assertRecipientGuarantees(undefined)
    await confirmUntilCompleted()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('pauses outputs_spent when a merge refused without a reason has an input that something else spends', async () => {
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(request => (isBroadcast(request) ? codeOnly(-26) : undefined))
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const input = stored().steps[0]!.inputs[0]!
    // Another wallet on the same seed spent one of its inputs.
    world.explorer.addTx({
      txid: fakeTxid(990_001, 5),
      inputs: [{ txid: input.txid, vout: input.vout }],
      outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: input.satoshis - 10_000 }],
    })
    await world.tick()
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: ['replan', 'cancel'],
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('decides a payment refused without a reason with the newest merges read afresh, each transaction’s outspends read once after the refusal', async () => {
    // 1,100 outputs, five to a funding transaction.
    for (let funding = 0; funding < 220; funding++) {
      world.explorer.addTx({
        txid: fakeTxid(980_000 + funding, 7),
        inputs: [{ txid: fakeTxid(980_000 + funding, 9_000_000), vout: 0 }],
        outputs: Array.from({ length: 5 }, () => ({
          address: account.address,
          script: account.p2mr.scriptPubKey,
          value: 100_000,
        })),
        height: 100 + funding,
      })
    }
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    const direct = stored()
      .steps.at(-1)!
      .inputs.filter(input => !plan.steps.some(step => step.txid === input.txid))
    expect(direct.length).toBeGreaterThan(5)
    // The merges confirm; in the next tick the plan sends the payment, which
    // the network refuses without a reason.
    world.mine()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? codeOnly(-26) : undefined))
    )
    const from = world.explorer.requests.length
    await world.tick()
    expect(
      world
        .storedStatuses()
        .slice(0, -1)
        .every(status => status === 'confirmed')
    ).toBe(true)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
    })
    // In that tick: each merge's state read twice before the payment went
    // (by the waiting step, then afresh immediately before the payment), the
    // eight seen confirmed last once more after its refusal, and every
    // transaction's outspends at most once before the payment went, and
    // once, afresh, after its refusal.
    const tick = world.explorer.requests.slice(from)
    const sent = tick.findIndex(request => isBroadcast(request))
    const countReads = (requests: readonly { path: string }[]) => {
      const counts = new Map<string, { status: number; outspends: number }>()
      for (const { path } of requests) {
        const match = path.match(/^\/tx\/([0-9a-f]{64})\/(status|outspends)$/)
        if (!match) continue
        const entry = counts.get(match[1]!) ?? { status: 0, outspends: 0 }
        entry[match[2] as 'status' | 'outspends'] += 1
        counts.set(match[1]!, entry)
      }
      return counts
    }
    const reads = countReads(tick)
    const beforeRefusal = countReads(tick.slice(0, sent))
    const afterRefusal = countReads(tick.slice(sent))
    const merges = plan.steps.slice(0, -1)
    expect(merges.length).toBeGreaterThan(8)
    const thrice = merges.filter(merge => reads.get(merge.txid)?.status === 3)
    expect(thrice).toHaveLength(8)
    for (const merge of merges) {
      expect(beforeRefusal.get(merge.txid)?.status, merge.txid).toBe(2)
      expect(reads.get(merge.txid)?.status, merge.txid).toBeLessThanOrEqual(3)
      expect(afterRefusal.get(merge.txid)?.outspends, merge.txid).toBe(1)
    }
    for (const [txid, counts] of beforeRefusal) {
      expect(counts.outspends, txid).toBeLessThanOrEqual(1)
    }
    for (const [txid, counts] of afterRefusal) {
      expect(counts.outspends, txid).toBeLessThanOrEqual(1)
    }
    // The outspends of the payment's direct inputs: one read a funding transaction.
    const fundings = new Set(direct.map(input => input.txid))
    expect(fundings.size).toBeLessThan(direct.length)
    for (const txid of fundings) expect(afterRefusal.get(txid)?.outspends).toBe(1)
    world.assertRecipientGuarantees(undefined)
  })

  it('reads what spends the payment’s inputs after the refusal it explains, so a spend since the waiting plan looked pauses outputs_spent', async () => {
    world.fund(250, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    const merge = plan.steps[0]!
    world.mine()
    // The merges confirm; in the next tick the waiting plan reads what
    // spends their outputs, then sends the payment. Meanwhile another wallet
    // with the same key spends the first merge's output, and the network
    // refuses the payment without a reason.
    world.explorer.failures.push(
      once(request => {
        if (!isBroadcast(request)) return undefined
        world.explorer.addTx({
          txid: fakeTxid(990_001, 3),
          inputs: [{ txid: merge.txid, vout: 0 }],
          outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: 1_000 }],
        })
        return codeOnly(-26)
      })
    )
    const from = world.explorer.requests.length
    await world.tick()
    const requests = world.explorer.requests.slice(from)
    const sent = requests.findIndex(request => isBroadcast(request))
    const outspends = `/tx/${merge.txid}/outspends`
    expect(requests.slice(0, sent).some(request => request.path === outspends)).toBe(true)
    expect(requests.slice(sent).filter(request => request.path === outspends)).toHaveLength(1)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('pauses merge_refused when a merge refused without a reason has every input unspent', async () => {
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(request => (isBroadcast(request) ? codeOnly(-25) : undefined))
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    await world.tick()
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'merge_refused' },
      actions: ['replan', 'cancel'],
    })
    world.assertRecipientGuarantees(undefined)
  })
})

/** Resolves when the keyring is about to sign input `input` of its `signing`-th signing, which then never finishes. */
function hangSigning(signing: number, input: number): Promise<void> {
  let signings = 0
  return new Promise(resolve => {
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      if (signings === signing && index === input) {
        resolve()
        return new Promise<void>(() => undefined)
      }
      return undefined
    }
  })
}

/** The keyring's `signing`-th signing waits before input `input` until `release` is called. */
function gateSigning(
  signing: number,
  input: number
): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  let arrived: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrived = resolve))
  let signings = 0
  world.keyring.beforeInput = async (_txid, index) => {
    if (index === 0) signings += 1
    if (signings === signing && index === input) {
      arrived()
      await gate
    }
  }
  return { reached, release }
}

/** A fresh world of 150 outputs of 100,000 bits, the one the test works in from here. */
function freshWorldWith150(): void {
  world = freshWorld()
  world.fund(150, 100_000)
}

/** In the current, funded world: a plan of `amount` whose merge went out and stayed unconfirmed for long. */
async function slowPlanOf(amount: number): Promise<QbitSendPlanView> {
  await world.open()
  world.explorer.acceptReplacements = true
  await world.startPlan({ target: { kind: 'amount', amount } })
  await world.tick(SLOW_MS)
  const view = (await world.plan())!
  expect(view).toMatchObject({ phase: 'waiting', slowMerge: true })
  return view
}

describe('a merge’s fee raised, then the payment’s', () => {
  /**
   * 221 of 300 outputs: two merges of 106, and a payment of 11 inputs whose
   * change can absorb a raise of a merge's fee and then of its own.
   */
  const TWO_MERGES_AMOUNT = 219_400_000

  /**
   * A plan of two merges whose first confirmed and whose second, slow, was
   * replaced by a raise of its fee: the payment is built again on the
   * replacement, whose output it spends first, as a plan spends the
   * outputs of the merges it builds.
   */
  async function secondMergeRaised() {
    world.fund(300, VALUE)
    await world.open()
    world.explorer.acceptReplacements = true
    await world.startPlan({ target: { kind: 'amount', amount: TWO_MERGES_AMOUNT } })
    const [first, second] = stored().steps
    world.mine([first!.txid])
    await world.tick()
    expect(world.storedStatuses()).toEqual(['confirmed', 'broadcast', 'signed'])
    await world.tick(SLOW_MS)
    const slow = (await world.plan())!
    expect(slow).toMatchObject({ phase: 'waiting', slowMerge: true })
    const review = await reviewRaise(slow, 'raise_merge_fee', 2)
    expect(review.merges).toHaveLength(1)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const raised = stored()
    const replacement = raised.steps[1]!
    expect(replacement).toMatchObject({ status: 'broadcast', replaces: { txid: second!.txid } })
    const payment = raised.steps.at(-1)!
    expect(payment.inputs.slice(0, 2).map(input => input.txid)).toEqual([
      replacement.txid,
      first!.txid,
    ])
    return { payment }
  }

  it('raises the payment’s fee over the same inputs in the same order, and pays once', async () => {
    const { payment } = await secondMergeRaised()
    // The replacement confirms, and the network refuses the payment for its fee.
    world.refuse.set(payment.txid, nodeRejection('mempool min fee not met'))
    world.mine()
    await world.tick()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['raise_payment_fee', 'continue', 'cancel'],
    })
    world.refuse.delete(payment.txid)

    const review = await reviewRaise(paused, 'raise_payment_fee', 3)
    expect(review.payment.txid).not.toBe(payment.txid)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    // Every version of the payment spends the same inputs, input by input.
    const raised = stored()
    expect(raised.steps.at(-1)!.inputs).toEqual(payment.inputs)
    expect(raised.earlierPayments).toEqual([
      expect.objectContaining({ txid: payment.txid, dispatch: 'refused' }),
    ])
    const done = await confirmUntilCompleted()
    expect(done).toMatchObject({ paymentTxid: review.payment.txid, amount: TWO_MERGES_AMOUNT })
    world.assertRecipientGuarantees(TWO_MERGES_AMOUNT)
    expect(world.pushed.filter(txid => txid === review.payment.txid)).toHaveLength(1)
  })

  it('replans after the payment built on the replacement is refused for good, and pays once', async () => {
    const { payment } = await secondMergeRaised()
    world.refuse.set(payment.txid, nodeRejection('non-mandatory-script-verify-flag'))
    world.mine()
    await world.tick()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue', 'replan', 'cancel'],
    })
    const review = await world.review({
      target: { kind: 'amount', amount: TWO_MERGES_AMOUNT },
      revise: { planId: paused.id, kind: 'replan' },
    })
    expect(review.amount).toBe(TWO_MERGES_AMOUNT)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const done = await confirmUntilCompleted()
    expect(done).toMatchObject({ paymentTxid: review.payment.txid, amount: TWO_MERGES_AMOUNT })
    expect(world.explorer.txs.has(payment.txid)).toBe(false)
    world.assertRecipientGuarantees(TWO_MERGES_AMOUNT)
  })
})
