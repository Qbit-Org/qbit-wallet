import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bytesToHex, extractP2mrTransaction } from '@qbit-oss/protocol'
import { type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_STORE_KEY,
  QBIT_SEND_PLAN_STORE_VERSION,
  type QbitSendPlanPaidBy,
  type QbitSendPlanRecord,
} from '../src/services/qbitSendPlanStore'
import { qbitSendPlanPsbtFromHex } from '../src/utils/qbit-send-plan-psbt'
import { qbitSendPlanTermsDigest } from '../src/utils/qbit-send-plan-terms'
import { fakeTxid } from './qbit-fake-explorer'
import {
  CHAIN,
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

// A send plan completed by a transaction that is no version of its payment
// (#206, item 6). The plan's payment P left the wallet without a verdict,
// and the explorer then showed its inputs spent by T, which pays the
// recipient the amount: the plan completes with T (`paidBy`). P spends the
// same inputs and may still confirm instead of T, so the plan keeps looking
// it up until one of them has confirmed, and names the one that did, with
// its fee. The recipient is paid once either way.

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

function stored(): QbitSendPlanRecord {
  const record = qbitSendPlanStore.list()[0]
  if (!record) throw new Error('no plan stored')
  return record
}

const VALUE = 1_000_000
/** 121 of the 150 outputs: one merge of 106, and a payment of 16 inputs with change. */
const AMOUNT = 120_000_000
/** What the explorer reports as T's fee. */
const T_FEE = 3_000

/**
 * A plan whose merge confirmed and whose payment P went out without a
 * verdict (the gateway failed before the explorer took it), then, after a
 * restart, was missed for the whole grace and refused when sent again
 * (`refusal`, by default for a reason a wait would not change): paused, its
 * payment `signed` and its dispatch `unknown`, so P may still confirm.
 * Resolves to P's id, raw bytes and fee.
 */
async function paymentWithoutVerdict(
  refusal = nodeRejection('non-mandatory-script-verify-flag'),
  pausedFor = 'payment_refused'
): Promise<{ p: string; pRaw: string; pFee: number }> {
  world.fund(150, VALUE)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const p = plan.paymentTxid
  const payment = stored().steps.at(-1)!
  const pRaw = bytesToHex(extractP2mrTransaction(qbitSendPlanPsbtFromHex(payment.signedPsbtHex!)))
  world.mine()
  world.explorer.failures.push(request =>
    isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
  )
  await world.tick()
  world.explorer.failures.length = 0
  expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
  expect(world.explorer.txs.has(p)).toBe(false)
  await world.restart()
  world.refuse.set(p, refusal)
  await world.tick()
  await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
  world.refuse.delete(p)
  await world.unlock()
  expect(await world.plan()).toMatchObject({
    phase: 'paused',
    pause: { reason: pausedFor },
    paymentMayConfirm: true,
  })
  expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'signed', dispatch: 'unknown' })
  return { p, pRaw, pFee: payment.fee }
}

/**
 * A transaction no version of the payment is, pending: it spends every
 * input of the stored payment and pays the recipient the amount, and the
 * explorer reports `fee` as its fee. Resolves to its id.
 */
function payRecipientFromPaymentInputs(seed: number, fee: number): string {
  const inputs = stored().steps.at(-1)!.inputs
  return world.explorer.addTx({
    txid: fakeTxid(seed, 5),
    inputs: inputs.map(input => ({ txid: input.txid, vout: input.vout })),
    outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
    fee,
  }).txid
}

/** The issue's start: P with no verdict, then T found pending; the paused plan's tick completes it with T. */
async function completedWithAnother(): Promise<{
  p: string
  pRaw: string
  pFee: number
  t: string
}> {
  const { p, pRaw, pFee } = await paymentWithoutVerdict()
  const t = payRecipientFromPaymentInputs(9_990, T_FEE)
  await world.tick()
  expect(stored()).toMatchObject({
    phase: 'completed',
    paidBy: { txid: t, amount: AMOUNT, fee: T_FEE },
  })
  // P stays the stored payment, listed once, its bytes gone; T is shown.
  expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'broadcast', dispatch: 'unknown' })
  expect(stored().steps.at(-1)!.signedPsbtHex).toBeUndefined()
  expect(stored().earlierPayments).toBeUndefined()
  expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
  return { p, pRaw, pFee, t }
}

/**
 * P1, without a verdict, refused for its fee; its raise P2 refused outright,
 * so the plan pauses while P1 may still confirm; then T is found pending,
 * and the plan completes with it, P2 its payment and P1 an earlier one.
 * Resolves to P1's id, raw bytes and fee, P2's id and T's.
 */
async function completedOverEarlierVersion(): Promise<{
  p1: string
  p1Raw: string
  p1Fee: number
  p2: string
  t: string
}> {
  const { p: p1, pRaw: p1Raw } = await paymentWithoutVerdict(
    nodeRejection('mempool min fee not met'),
    'payment_fee_too_low'
  )
  const raise = await world.prepare({
    target: { kind: 'amount', amount: AMOUNT },
    feeRate: 2,
    revise: { planId: stored().id, kind: 'raise_payment_fee' },
  })
  if (!raise.ok) throw new Error(`raise refused: ${raise.reason}`)
  const p2 = raise.review.payment.txid
  world.refuse.set(p2, nodeRejection('non-mandatory-script-verify-flag'))
  expect(await world.wallet.startQbitSendPlan(raise.review.draftId)).toMatchObject({ ok: true })
  await world.settle()
  world.refuse.delete(p2)
  expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'payment_refused' } })
  expect(stored().steps.at(-1)).toMatchObject({ txid: p2, status: 'signed', dispatch: 'refused' })
  const p1Fee = stored().earlierPayments![0]!.fee
  expect(stored().earlierPayments).toEqual([
    expect.objectContaining({ txid: p1, dispatch: 'unknown' }),
  ])
  const t = payRecipientFromPaymentInputs(9_993, T_FEE)
  await world.tick()
  expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
  expect(stored().earlierPayments).toEqual([expect.objectContaining({ txid: p1 })])
  return { p1, p1Raw, p1Fee, p2, t }
}

/**
 * The explorer shows `txid`, a version of the payment, spending the
 * payment's inputs and paying the recipient the amount: confirmed at
 * `height`, or pending. Only an explorer out of step with the network shows
 * it beside T, which spends the same inputs.
 */
function explorerShowsPayment(txid: string, height?: number): void {
  const inputs = stored().steps.at(-1)!.inputs
  world.explorer.addTx({
    txid,
    inputs: inputs.map(input => ({ txid: input.txid, vout: input.vout })),
    outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
    ...(height !== undefined ? { height } : {}),
  })
}

/** P's bytes reach the network by another way after all, and a block confirms them. */
async function pMinedAnyway(pRaw: string): Promise<void> {
  const answer = await world.explorer.fetch('https://explorer.invalid/api/tx', {
    method: 'POST',
    body: pRaw,
  })
  expect(answer.status).toBe(200)
  world.mine()
}

/** The plan as a page is shown it once the read it makes has advanced the plan. */
async function settledView(): Promise<QbitSendPlanView> {
  await world.plan()
  return (await world.plan())!
}

/** Time passes beyond the last lookups, and a page reads the plan, which advances it. */
async function laterRead(): Promise<QbitSendPlanView> {
  await world.tick()
  return settledView()
}

/** The view names `payment` as the plan's payment, with its fee and status. */
function expectShows(
  view: QbitSendPlanView,
  payment: { txid: string; fee: number; status: string }
): void {
  expect(view).toMatchObject({ phase: 'completed', paymentTxid: payment.txid, amount: AMOUNT })
  expect(view.steps.at(-1)).toMatchObject({ kind: 'payment', ...payment })
  const record = stored()
  const merges = record.totalFee - record.steps.at(-1)!.fee
  expect(view.totalFee).toBe(merges + (record.paidFee ?? 0) + payment.fee)
}

/** Lookups of `txid` the explorer answered since request `from`. */
function lookupsOf(txid: string, from: number): number {
  return world.explorer.requests
    .slice(from)
    .filter(request => isLookup(request) && request.path.includes(txid)).length
}

/** The one transaction the explorer holds now that pays the recipient; fails on none or more. */
function expectRecipientPaidOnlyBy(txid: string): void {
  const payers = [...world.explorer.txs.values()]
    .filter(tx => tx.outputs.some(output => output.script === RECIPIENT_SCRIPT))
    .map(tx => tx.txid)
  expect(payers).toEqual([txid])
}

/** The outpoints the stored payment spends. */
function paymentInputKeys(): Set<string> {
  const payment = stored().steps.at(-1)!
  return new Set(payment.inputs.map(input => `${input.txid}:${input.vout}`))
}

describe('a plan completed by a transaction that is no version of its payment', () => {
  it('names its own payment, with its fee, once that confirms instead: P with no verdict, T found pending, then T gone and P confirmed', async () => {
    const { p, pRaw, pFee, t } = await completedWithAnother()
    expect(pFee).not.toBe(T_FEE)
    // T leaves the mempool, and P, which a node kept, is mined instead.
    world.explorer.removeTx(t)
    await pMinedAnyway(pRaw)
    const done = await laterRead()
    expectShows(done, { txid: p, fee: pFee, status: 'confirmed' })
    expect(done.actions).toEqual(['dismiss'])
    expect(stored().paidBy).toBeUndefined()
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    expect(stored().earlierPayments).toBeUndefined()
    // Confirmed, it holds nothing any more.
    expect(await world.planHeld()).toEqual(new Set())
    expectRecipientPaidOnlyBy(p)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('names T, with its fee, once T confirms, and looks its own payment up no more', async () => {
    const { p, t } = await completedWithAnother()
    // While neither has confirmed, the plan names T and watches P as well.
    let from = world.explorer.requests.length
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(lookupsOf(p, from)).toBeGreaterThan(0)
    expect(await world.planHeld()).toEqual(paymentInputKeys())

    world.mine([t])
    const done = await laterRead()
    expectShows(done, { txid: t, fee: T_FEE, status: 'confirmed' })
    expect(stored().paidBy).toEqual({ txid: t, amount: AMOUNT, fee: T_FEE })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    expect(await world.planHeld()).toEqual(new Set())
    // T confirmed is the payment for good: P is looked up no more, and
    // nothing of the plan changes.
    from = world.explorer.requests.length
    const revision = stored().revision
    for (let read = 0; read < 3; read++) await laterRead()
    expect(lookupsOf(p, from)).toBe(0)
    expect(stored().revision).toBe(revision)
    expectRecipientPaidOnlyBy(t)
    // Nothing the wallet broadcast paid the recipient: T did.
    world.assertRecipientGuarantees(undefined)
  })

  it('reads a plan completed with T as stored before it watched its own payment, and names that payment once it confirms', async () => {
    const { p, pRaw, pFee } = await paymentWithoutVerdict()
    const t = payRecipientFromPaymentInputs(9_990, T_FEE)
    // The completion as the engine stored it before it watched the payment:
    // the payment `broadcast` without its bytes and keeping its dispatch,
    // `paidBy` set, the pause gone, nothing added to `earlierPayments`.
    const paused = stored()
    const { pause: _pause, ...rest } = paused
    const payment = { ...paused.steps.at(-1)!, status: 'broadcast' as const }
    delete payment.signedPsbtHex
    const paidBy: QbitSendPlanPaidBy = { txid: t, amount: AMOUNT, fee: T_FEE }
    const earlier = {
      ...rest,
      steps: [...paused.steps.slice(0, -1), payment],
      phase: 'completed',
      paidBy,
      revision: paused.revision + 1,
      updatedAt: Date.now(),
    }
    world.storage.values.set(
      QBIT_SEND_PLAN_STORE_KEY,
      JSON.stringify({ version: QBIT_SEND_PLAN_STORE_VERSION, plans: [earlier] })
    )
    await world.restart()
    expect(qbitSendPlanStore.list()).toHaveLength(1)
    expect(stored()).toMatchObject({ phase: 'completed', paidBy })
    expect(stored().earlierPayments).toBeUndefined()
    expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(await world.planHeld()).toEqual(paymentInputKeys())

    world.explorer.removeTx(t)
    await pMinedAnyway(pRaw)
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'confirmed' })
    expect(stored().paidBy).toBeUndefined()
    expect(await world.planHeld()).toEqual(new Set())
    expectRecipientPaidOnlyBy(p)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('while T and its own payment are both gone, names T, keeps the inputs held and signs and sends nothing; names its payment once that confirms after all', async () => {
    const { p, pRaw, pFee, t } = await completedWithAnother()
    world.explorer.removeTx(t)
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    const revision = stored().revision
    // Missed for well over the grace, read after read.
    for (let read = 0; read < 3; read++) {
      await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
    }
    expect(stored().revision).toBe(revision)
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    expect(world.timers.scheduled).toBe(0)

    await pMinedAnyway(pRaw)
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'confirmed' })
    expect(await world.planHeld()).toEqual(new Set())
    expect(world.pushed).toHaveLength(pushed)
    expectRecipientPaidOnlyBy(p)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('names an earlier version of its payment, with its fee, once that confirms instead of T, having watched the payment as well', async () => {
    const { p1, p1Raw, p1Fee, p2, t } = await completedOverEarlierVersion()
    // While none has confirmed, the plan names T, and looks up P2, whose
    // bytes left the wallet, and P1.
    const from = world.explorer.requests.length
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(lookupsOf(p2, from)).toBeGreaterThan(0)
    expect(lookupsOf(p1, from)).toBeGreaterThan(0)

    world.explorer.removeTx(t)
    await pMinedAnyway(p1Raw)
    expectShows(await laterRead(), { txid: p1, fee: p1Fee, status: 'confirmed' })
    expect(stored().paidBy).toBeUndefined()
    expect(stored().earlierPayments).toBeUndefined()
    expect(await world.planHeld()).toEqual(new Set())
    expect(world.explorer.txs.has(p2)).toBe(false)
    expectRecipientPaidOnlyBy(p1)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('keeps naming T through a miss of T while an earlier version shows pending, then names T once it confirms, keeping and holding nothing', async () => {
    const { p1, t } = await completedOverEarlierVersion()
    const revision = stored().revision
    // The explorer answers out of order: one lookup of T misses it, while
    // P1, which a node still reports, shows pending.
    explorerShowsPayment(p1)
    let misses = 1
    world.explorer.failures.push(request => {
      if (request.path !== `/tx/${t}/status` || misses === 0) return undefined
      misses -= 1
      return { status: 404, body: 'Transaction not found' }
    })
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(misses).toBe(0)
    expect(stored().revision).toBe(revision)
    expect(stored().paidBy).toEqual({ txid: t, amount: AMOUNT, fee: T_FEE })

    // The explorer settles: P1 was never mined, and T is.
    world.explorer.removeTx(p1)
    world.mine([t])
    for (let tick = 0; tick < 4; tick++) await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'confirmed' })
    // Confirmed, T is the payment for good: the earlier versions go.
    expect(stored().earlierPayments).toBeUndefined()
    expect(await world.planHeld()).toEqual(new Set())
    expectRecipientPaidOnlyBy(t)
    world.assertRecipientGuarantees(undefined)
  })

  it('names its own payment when the explorer shows it confirmed while T still shows pending, and stays so once T confirms too', async () => {
    const { p, pFee, t } = await completedWithAnother()
    // A stale explorer: P in a block, T still in its mempool.
    explorerShowsPayment(p, ++world.explorer.tipHeight)
    expect(world.explorer.txs.get(t)?.height).toBeUndefined()
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'confirmed' })
    expect(stored().paidBy).toBeUndefined()
    expect(await world.planHeld()).toEqual(new Set())
    const revision = stored().revision
    world.mine([t])
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'confirmed' })
    expect(stored().revision).toBe(revision)
    world.assertRecipientGuarantees(undefined)
  })

  it('names T when the explorer shows T and its own payment both confirmed, and does not switch once T is gone from it', async () => {
    const { p, t } = await completedWithAnother()
    world.mine([t])
    explorerShowsPayment(p, world.explorer.tipHeight)
    const from = world.explorer.requests.length
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'confirmed' })
    expect(lookupsOf(p, from)).toBe(0)
    const revision = stored().revision
    world.explorer.removeTx(t)
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'confirmed' })
    expect(stored().revision).toBe(revision)
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })

  it('never looks up a payment whose bytes never left the wallet', async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const merge = stored().steps[0]!
    // Before the payment is sent, T spends the merge's output and pays the
    // recipient; the merge confirms, and T is pending.
    const t = world.explorer.addTx({
      txid: fakeTxid(9_992, 5),
      inputs: [{ txid: merge.txid, vout: 0 }],
      outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
      fee: T_FEE,
    }).txid
    world.mine([merge.txid])
    await world.tick()
    expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
    expect(stored().steps.at(-1)).toMatchObject({ status: 'broadcast' })
    expect(stored().steps.at(-1)!.dispatch).toBeUndefined()
    const from = world.explorer.requests.length
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    await laterRead()
    expect(lookupsOf(t, from)).toBeGreaterThan(0)
    expect(lookupsOf(plan.paymentTxid, from)).toBe(0)
    world.mine([t])
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'confirmed' })
    expect(lookupsOf(plan.paymentTxid, from)).toBe(0)
    expect(world.pushed).not.toContain(plan.paymentTxid)
    expectRecipientPaidOnlyBy(t)
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a completion with another transaction that comes after the payment confirmed', () => {
  it('changes nothing: confirmed, the payment is the payment for good', async () => {
    const { p, pRaw, pFee, t } = await completedWithAnother()
    world.explorer.removeTx(t)
    await pMinedAnyway(pRaw)
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'confirmed' })
    const before = stored()
    // A settle that read the plan before P confirmed, and T as the explorer
    // showed it then, completes the plan with T only now.
    const engine = world.engine as unknown as {
      completeWithPaidBy(
        planId: string,
        paidBy: QbitSendPlanPaidBy,
        state: 'pending' | 'confirmed'
      ): Promise<void>
    }
    await engine.completeWithPaidBy(before.id, { txid: t, amount: AMOUNT, fee: T_FEE }, 'pending')
    expect(stored()).toEqual(before)
    expectShows(await settledView(), { txid: p, fee: pFee, status: 'confirmed' })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('the terms the view of a plan completed by another transaction states', () => {
  it('are those of the transaction it names, T and then its own payment once that confirms instead', async () => {
    const { p, pRaw, pFee, t } = await completedWithAnother()
    const withT = await settledView()
    expectShows(withT, { txid: t, fee: T_FEE, status: 'broadcast' })
    // The digest the view carries is of what it shows, and is the one the
    // background compares a continue with (`QbitSendPlanView.termsDigest`).
    expect(withT.termsDigest).toBe(qbitSendPlanTermsDigest(withT))
    expect(world.shownTerms(withT.id)).toBe(withT.termsDigest)

    world.explorer.removeTx(t)
    await pMinedAnyway(pRaw)
    const withP = await laterRead()
    expectShows(withP, { txid: p, fee: pFee, status: 'confirmed' })
    expect(withP.termsDigest).toBe(qbitSendPlanTermsDigest(withP))
    expect(world.shownTerms(withP.id)).toBe(withP.termsDigest)
    expect(withP.termsDigest).not.toBe(withT.termsDigest)
    // Completed, it offers no continue under either.
    expect(withT.actions).not.toContain('continue')
    expect(withP.actions).not.toContain('continue')
    world.assertRecipientGuarantees(AMOUNT)
  })
})
