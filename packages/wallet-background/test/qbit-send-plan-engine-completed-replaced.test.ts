import log from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import {
  QBIT_SEND_PLAN_SLOW_MERGE_MS,
  QBIT_SEND_PLAN_TICK_MS,
} from '../src/services/qbitSendPlanEngine'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_STORE_KEY,
  validateQbitSendPlanRecord,
  type QbitSendPlanRecord,
} from '../src/services/qbitSendPlanStore'
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
  newPlanGuard,
  nodeRejection,
  once,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A completed send plan whose named transaction disappears (#217). The plan
// completed with its own payment P, or with a transaction T that is no
// version of it (`paidBy`), and that transaction is then replaced, or drops
// out of the network. Once it is proven absent (the grace the engine gives
// every lookup that misses), what spends the payment's inputs decides: a
// transaction paying the recipient is named, with its fee; a spend
// elsewhere, or nothing at all, reopens the plan as paused. Nothing is sent
// again without the user, and the recipient is paid once.

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
      hasPersistedVault: vi.fn(async () => true),
      resetAllData: vi.fn(async () => undefined),
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
      getAutoLockTimeId: vi.fn(() => 3),
      getInitAlianNameStatus: vi.fn(() => true),
      getLockOnComputerLock: vi.fn(() => true),
      getLockOnWindowsClosed: vi.fn(() => true),
      resetAllData: vi.fn(async () => undefined),
    },
    qbitSendGuardService: guard,
    sessionService: { broadcastEvent: vi.fn() },
    contactBookService: { listAlias: vi.fn(() => []), resetAllData: vi.fn(async () => undefined) },
    permissionService: { resetAllData: vi.fn(async () => undefined) },
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
  rememberEveryTransaction(next)
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
  // The worlds of this test are let go of before they are checked, so that
  // a check that fails stays with this test.
  const ended = worlds
  worlds = []
  try {
    for (const each of ended) {
      each.assertGuarantees()
      assertRecipientPaidAtMostOnce(each)
    }
  } finally {
    everHeld.clear()
    if (world?.wallet) world.engine.reset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

/** A transaction as an explorer was given it. */
type HeldTransaction = Parameters<World['explorer']['addTx']>[0]

/**
 * By world, every transaction its explorer was ever given, by txid: one
 * that left the explorer can be sent again by whoever holds its bytes, and
 * come back.
 */
const everHeld = new Map<World, Map<string, HeldTransaction>>()

/** `each`'s explorer remembers every transaction it is given (`everHeld`). */
function rememberEveryTransaction(each: World): void {
  const held = new Map<string, HeldTransaction>()
  everHeld.set(each, held)
  const explorer = each.explorer
  const addTx = explorer.addTx.bind(explorer)
  explorer.addTx = tx => {
    const added = addTx(tx)
    // Given again without its inputs (an index that lags), it keeps those
    // it was given with first. Given without them first, a version of a
    // stored plan's payment spends what that payment spends; what anything
    // else spends stays unknown (see `possibleSecondPayments`).
    if (added.inputs.length > 0 || !held.has(added.txid)) {
      const inputs =
        added.inputs.length > 0
          ? added.inputs.map(input => ({ txid: input.txid, vout: input.vout }))
          : [...(versionInputs(each).get(added.txid) ?? [])]
      held.set(added.txid, {
        txid: added.txid,
        inputs,
        outputs: added.outputs.map(output => ({ ...output })),
        ...(added.fee !== undefined ? { fee: added.fee } : {}),
      })
    }
    return added
  }
}

/**
 * The recipient is paid at most once, whatever comes back:
 * - at most one transaction the explorer shows confirmed pays the
 *   recipient, whoever made it;
 * - no transaction paying the recipient that the wallet broadcast (the
 *   explorer accepted it) could confirm beside another that pays the
 *   recipient, of all the explorer was ever given (`everHeld`): two that
 *   share no input, neither of them dead, could both confirm. One is dead
 *   when one of its inputs is spent by a confirmed transaction other than
 *   itself, or is an output of a transaction not confirmed that is dead.
 * The harness's check (`assertRecipientGuarantees`) reads only the
 * broadcasts the explorer accepted, and what paid the recipient in the
 * payment's place is given to the explorer by the test.
 */
function assertRecipientPaidAtMostOnce(each: World): void {
  const explorer = each.explorer
  const confirmed = [...explorer.txs.values()].filter(
    tx => tx.height !== undefined && tx.outputs.some(output => output.script === RECIPIENT_SCRIPT)
  )
  expect(confirmed.map(tx => tx.txid).slice(1)).toEqual([])
  // One the explorer was only ever given without what it spends cannot be
  // checked, unless it is a version of a stored plan's payment, which spends
  // what that payment spends: a test gives what it spends.
  expect(possibleSecondPayments(each)).toEqual({ together: [], unknown: [] })
}

/**
 * By txid, what each version of a payment `each`'s store holds spends: the
 * payment's inputs, which every version spends.
 */
function versionInputs(each: World): Map<string, { txid: string; vout: number }[]> {
  const stored = each.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)
  const plans = stored ? ((JSON.parse(stored) as { plans?: QbitSendPlanRecord[] }).plans ?? []) : []
  const inputs = new Map<string, { txid: string; vout: number }[]>()
  for (const plan of plans) {
    const payment = plan.steps.at(-1)
    if (!payment) continue
    for (const txid of [payment.txid, ...(plan.earlierPayments ?? []).map(item => item.txid)]) {
      inputs.set(txid, payment.inputs)
    }
  }
  return inputs
}

/**
 * What `assertRecipientPaidAtMostOnce` finds: the pairs that could both pay
 * the recipient (`together`), and the transactions paying the recipient
 * that it cannot check (`unknown`).
 */
function possibleSecondPayments(each: World): { together: string[]; unknown: string[] } {
  const explorer = each.explorer
  const held = everHeld.get(each) ?? new Map<string, HeldTransaction>()
  const unknown = [...held.values()]
    .filter(
      tx => tx.inputs.length === 0 && tx.outputs.some(output => output.script === RECIPIENT_SCRIPT)
    )
    .map(tx => tx.txid)
  const key = (input: { txid: string; vout: number }): string => `${input.txid}:${input.vout}`
  const confirmedSpends = new Map<string, string>()
  for (const tx of explorer.txs.values()) {
    if (tx.height === undefined) continue
    for (const input of tx.inputs) confirmedSpends.set(key(input), tx.txid)
  }
  const deadness = new Map<string, boolean>()
  const dead = (txid: string): boolean => {
    const known = deadness.get(txid)
    if (known !== undefined) return known
    deadness.set(txid, false)
    const result = (held.get(txid)?.inputs ?? []).some(input => {
      const spender = confirmedSpends.get(key(input))
      if (spender !== undefined && spender !== txid) return true
      return (
        explorer.txs.get(input.txid)?.height === undefined &&
        held.has(input.txid) &&
        dead(input.txid)
      )
    })
    deadness.set(txid, result)
    return result
  }
  const payers = [...held.values()].filter(
    tx => tx.inputs.length > 0 && tx.outputs.some(output => output.script === RECIPIENT_SCRIPT)
  )
  const walletMade = new Set(explorer.accepted.map(accepted => accepted.txid))
  const found: string[] = []
  for (const [index, first] of payers.entries()) {
    const spent = new Set(first.inputs.map(key))
    for (const second of payers.slice(index + 1)) {
      if (!walletMade.has(first.txid) && !walletMade.has(second.txid)) continue
      if (second.inputs.some(input => spent.has(key(input)))) continue
      if (dead(first.txid) || dead(second.txid)) continue
      found.push(`${first.txid} and ${second.txid}`)
    }
  }
  return { together: found, unknown }
}

function stored(): QbitSendPlanRecord {
  const record = qbitSendPlanStore.list()[0]
  if (!record) throw new Error('no plan stored')
  return record
}

const VALUE = 1_000_000
/** 121 of the 150 outputs: one merge of 106, and a payment of 16 inputs with change. */
const AMOUNT = 120_000_000
/** What the explorer reports as the fees of transactions the wallet did not make. */
const T_FEE = 3_000
const T2_FEE = 7_000

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

/**
 * The named transaction has been missed for longer than the grace, and the
 * plan has been read often enough since to read the outspends of every
 * transaction whose outputs its payment spends (at most 8 a read).
 */
async function pastGrace(): Promise<QbitSendPlanView> {
  await laterRead()
  await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
  for (let read = 0; read < 3; read++) await laterRead()
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

/** The outpoints the stored payment spends. */
function paymentInputKeys(): Set<string> {
  const payment = stored().steps.at(-1)!
  return new Set(payment.inputs.map(input => `${input.txid}:${input.vout}`))
}

/** The explorer shows a transaction spending `inputs` and paying the recipient `amount`, pending. */
function payRecipient(
  seed: number,
  inputs: readonly { txid: string; vout: number }[],
  fee: number,
  amount = AMOUNT
): string {
  return world.explorer.addTx({
    txid: fakeTxid(seed, 5),
    inputs: inputs.map(input => ({ txid: input.txid, vout: input.vout })),
    outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: amount }],
    fee,
  }).txid
}

/** The explorer shows a transaction spending `inputs` and paying someone else, pending. */
function spendElsewhere(seed: number, inputs: readonly { txid: string; vout: number }[]): string {
  return world.explorer.addTx({
    txid: fakeTxid(seed, 6),
    inputs: inputs.map(input => ({ txid: input.txid, vout: input.vout })),
    outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: 500_000 }],
    fee: 1_000,
  }).txid
}

/** The explorer shows the plan's payment `txid`, which a node relayed, pending. */
function explorerShowsPayment(txid: string): void {
  const inputs = stored().steps.at(-1)!.inputs
  world.explorer.addTx({
    txid,
    inputs: inputs.map(input => ({ txid: input.txid, vout: input.vout })),
    outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
  })
}

/**
 * A plan completed with its own payment P, which the wallet broadcast and
 * the explorer accepted (pending). Resolves to P's id and fee.
 */
async function completedWithOwnPayment(): Promise<{ p: string; pFee: number }> {
  world.fund(150, VALUE)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  world.mine()
  await world.tick()
  expect(stored()).toMatchObject({ phase: 'completed' })
  expect(stored().steps.at(-1)).toMatchObject({
    txid: plan.paymentTxid,
    status: 'broadcast',
    dispatch: 'unknown',
  })
  expect(world.explorer.txs.has(plan.paymentTxid)).toBe(true)
  return { p: plan.paymentTxid, pFee: stored().steps.at(-1)!.fee }
}

/**
 * A plan completed with its own payment P, whose broadcast ended without a
 * verdict (the gateway failed before the explorer took it), and which the
 * explorer then showed pending (a node relayed it): the explorer has
 * accepted no broadcast of it. Resolves to P's id and fee.
 */
async function completedWithRelayedPayment(): Promise<{ p: string; pFee: number }> {
  world.fund(150, VALUE)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const p = plan.paymentTxid
  world.mine()
  world.explorer.failures.push(request =>
    isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
  )
  await world.tick()
  world.explorer.failures.length = 0
  expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
  explorerShowsPayment(p)
  await laterRead()
  expect(stored()).toMatchObject({ phase: 'completed' })
  expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'broadcast', dispatch: 'unknown' })
  expect(world.explorer.accepted.some(accepted => accepted.txid === p)).toBe(false)
  return { p, pFee: stored().steps.at(-1)!.fee }
}

/**
 * A plan completed with T before its payment ever left the wallet: T spends
 * the merge's output and pays the recipient the amount. Resolves to T's id
 * and the merge's output T spends.
 */
async function completedWithT(): Promise<{
  t: string
  mergeOutput: { txid: string; vout: number }
}> {
  world.fund(150, VALUE)
  await world.open()
  await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const merge = stored().steps[0]!
  const mergeOutput = { txid: merge.txid, vout: 0 }
  const t = payRecipient(9_990, [mergeOutput], T_FEE)
  world.mine([merge.txid])
  await world.tick()
  expect(stored()).toMatchObject({
    phase: 'completed',
    paidBy: { txid: t, amount: AMOUNT, fee: T_FEE },
  })
  expect(stored().steps.at(-1)!.dispatch).toBeUndefined()
  return { t, mergeOutput }
}

/** The plan completes with T, which spends the output of its merge while that is pending. */
async function completedOnPendingMerge(): Promise<{
  t: string
  merge: QbitSendPlanRecord['steps'][number]
}> {
  world.fund(150, VALUE)
  await world.open()
  await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const merge = stored().steps[0]!
  const t = payRecipient(10_640, [{ txid: merge.txid, vout: 0 }], T_FEE)
  await world.tick()
  expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
  expect(stored().steps[0]).toMatchObject({ status: 'broadcast' })
  return { t, merge }
}

/**
 * The merge and T leave the explorer, and one of the merge's inputs is
 * spent elsewhere by a transaction only pending. Resolves to that
 * transaction.
 */
function mergeUndone(t: string, merge: QbitSendPlanRecord['steps'][number]): string {
  world.explorer.removeTx(t)
  world.explorer.removeTx(merge.txid)
  return world.explorer.addTx({
    txid: fakeTxid(10_641, 6),
    inputs: [{ txid: merge.inputs[0]!.txid, vout: merge.inputs[0]!.vout }],
    outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: 500_000 }],
    fee: 1_000,
  }).txid
}

/**
 * `view`, and the plan for three reads more, is completed naming T and
 * offers dismiss alone: what spends T's input, or kills the merge whose
 * output T spends, is only pending, and can be evicted, which lets T's
 * signer send T again.
 */
async function expectNamedWhileOnlyPending(t: string, view: QbitSendPlanView): Promise<void> {
  for (let read = 0; read <= 3; read++) {
    const shown = read === 0 ? view : await laterRead()
    expectShows(shown, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(shown.actions).toEqual(['dismiss'])
  }
}

describe('a completed plan whose named transaction is replaced by one paying the recipient', () => {
  it('case 1: completed with T, T replaced by T2: names T2 and its fee once T is proven absent, and holds nothing once T2 confirms', async () => {
    const { t, mergeOutput } = await completedWithT()
    world.explorer.removeTx(t)
    const t2 = payRecipient(9_991, [mergeOutput], T2_FEE)
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    // One miss proves nothing: T is still named.
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    const named = await pastGrace()
    expectShows(named, { txid: t2, fee: T2_FEE, status: 'broadcast' })
    expect(stored().paidBy).toEqual({ txid: t2, amount: AMOUNT, fee: T2_FEE })
    // While T2 has not confirmed, the payment's inputs stay held.
    expect(await world.planHeld()).toEqual(paymentInputKeys())

    world.mine([t2])
    const done = await laterRead()
    expectShows(done, { txid: t2, fee: T2_FEE, status: 'confirmed' })
    expect(done.actions).toEqual(['dismiss'])
    // Confirmed, it holds nothing, as a plan whose own payment confirmed.
    expect(await world.planHeld()).toEqual(new Set())
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    // Nothing the wallet broadcast paid the recipient: T2 did.
    world.assertRecipientGuarantees(undefined)
  })

  it('case 2: completed with its own payment P, P replaced by T: names T and its fee', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(p)
    const t = payRecipient(9_992, inputs, T_FEE)
    expect(pFee).not.toBe(T_FEE)
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'broadcast' })
    expectShows(await pastGrace(), { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(stored().paidBy).toEqual({ txid: t, amount: AMOUNT, fee: T_FEE })

    world.mine([t])
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'confirmed' })
    expect(await world.planHeld()).toEqual(new Set())
    // P paid the recipient as far as the explorer ever accepted, and only P.
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a completed plan whose named transaction is gone and nothing paying the recipient spends its inputs', () => {
  it('case 3, unspent: reopens as paused, sends nothing until the user continues, then sends the payment once', async () => {
    const { p } = await completedWithRelayedPayment()
    world.explorer.removeTx(p)
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    const reopened = await pastGrace()
    expect(reopened.phase).toBe('paused')
    const record = stored()
    expect(record.paidBy).toBeUndefined()
    expect(record.pause).toMatchObject({ reason: 'interrupted' })
    const payment = record.steps.at(-1)!
    // Its bytes went with the completion: the payment is to be signed again,
    // and it stays a payment that left the wallet and may still confirm.
    expect(payment).toMatchObject({ txid: p, status: 'planned', dispatch: 'unknown' })
    expect(payment.signedPsbtHex).toBeUndefined()
    expect(validateQbitSendPlanRecord(JSON.parse(JSON.stringify(record))).valid).toBe(true)
    // A version of the payment may still confirm: the same payment again is
    // the way on, and neither a replan nor a cancel is offered.
    expect(reopened.paymentMayConfirm).toBe(true)
    expect(reopened.actions).toEqual(['continue'])
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    // Nothing was signed or sent by the reopening, nor by later reads.
    for (let read = 0; read < 3; read++) await laterRead()
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    expect(stored().phase).toBe('paused')

    // The user continues: the same payment is signed again and sent once.
    const view = await world.wallet.continueQbitSendPlan(record.id, world.shownTerms(record.id))
    expect(view.phase).not.toBe('completed')
    await world.settle()
    await laterRead()
    expect(world.pushed.slice(pushed)).toEqual([p])
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('case 3, spent elsewhere: reopens paused outputs_spent, offering a replan and a cancel, the earlier versions forgotten; a cancel releases the holds', async () => {
    const { p1, p2 } = await completedOverEarlierVersion()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(p2)
    spendElsewhere(9_994, [inputs[0]!])
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    // The record the reopening writes forgets the versions in that very
    // write: no view of it, even before the next advance, offers to send one.
    const writes: Record<string, unknown>[] = []
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementation(async (written, readRevision) => {
      writes.push(JSON.parse(JSON.stringify(written)) as Record<string, unknown>)
      return put(written, readRevision)
    })
    const reopened = await pastGrace()
    const reopening = writes.find(written => written['phase'] === 'paused') as
      | QbitSendPlanRecord
      | undefined
    expect(reopening).toMatchObject({ pause: { reason: 'outputs_spent' } })
    expect(reopening!.earlierPayments).toBeUndefined()
    expect(reopening!.steps.at(-1)!.dispatch).toBeUndefined()
    expect(reopened).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(reopened.paymentMayConfirm).toBeUndefined()
    expect(reopened.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expect(reopened.actions).not.toContain('continue')
    const record = stored()
    expect(record.earlierPayments).toBeUndefined()
    expect(record.paidBy).toBeUndefined()
    expect(record.steps.at(-1)).toMatchObject({ txid: p2, status: 'planned' })
    expect(record.steps.at(-1)!.dispatch).toBeUndefined()
    expect(record.steps.at(-1)!.signedPsbtHex).toBeUndefined()
    expect(validateQbitSendPlanRecord(JSON.parse(JSON.stringify(record))).valid).toBe(true)
    expect(p1).not.toBe(p2)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    expect(await world.planHeld()).toEqual(paymentInputKeys())

    expect(await world.wallet.cancelQbitSendPlan(record.id)).toBeNull()
    expect(qbitSendPlanStore.list()).toEqual([])
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('a plan completed with T whose own payment left the wallet', () => {
  it('names its own payment, with its fee, once T is proven absent and the payment is found pending', async () => {
    const { p, pFee, t } = await completedWithAnother()
    world.explorer.removeTx(t)
    // The explorer finds P pending, its index of what spends outputs lagging.
    world.explorer.addTx({
      txid: p,
      inputs: [],
      outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
    })
    // Within the grace, T stays named.
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    // The advance that proves T absent names P, found pending.
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().paidBy).toBeUndefined()
    expectShows(await settledView(), { txid: p, fee: pFee, status: 'broadcast' })
    expect(stored().paidBy).toBeUndefined()
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    world.mine([p])
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'confirmed' })
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })
})

describe('with every page closed and the wallet locked', () => {
  it('ticks alone name the transaction that replaced the named one, and the timer stops once that has confirmed', async () => {
    const { t, mergeOutput } = await completedWithT()
    await world.keyring.setLocked()
    world.explorer.removeTx(t)
    const t2 = payRecipient(9_995, [mergeOutput], T2_FEE)
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    for (let tick = 0; tick < 3; tick++) await world.tick()
    expect(stored().paidBy).toEqual({ txid: t2, amount: AMOUNT, fee: T2_FEE })
    expect(world.timers.scheduled).toBe(1)
    world.mine([t2])
    await world.tick()
    expect(stored().steps.at(-1)).toMatchObject({ status: 'confirmed' })
    expect(await world.planHeld()).toEqual(new Set())
    expect(world.timers.scheduled).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('ticks alone reopen a plan whose payment is gone with its inputs unspent', async () => {
    const { p } = await completedWithRelayedPayment()
    await world.keyring.setLocked()
    world.explorer.removeTx(p)
    const pushed = world.pushed.length
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    for (let tick = 0; tick < 3; tick++) await world.tick()
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    expect(world.pushed).toHaveLength(pushed)
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * P1, without a verdict, refused for its fee; its raise P2 accepted: the
 * plan completes with P2, keeping P1, which may still confirm instead.
 * Resolves to both ids.
 */
async function completedOverEarlierVersion(): Promise<{ p1: string; p2: string }> {
  const { p: p1 } = await paymentWithoutVerdict(
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
  expect(await world.wallet.startQbitSendPlan(raise.review.draftId)).toMatchObject({ ok: true })
  await world.settle()
  await laterRead()
  expect(stored()).toMatchObject({ phase: 'completed' })
  expect(stored().steps.at(-1)).toMatchObject({ txid: p2, status: 'broadcast' })
  expect(stored().earlierPayments).toEqual([
    expect.objectContaining({ txid: p1, dispatch: 'unknown' }),
  ])
  return { p1, p2 }
}

/**
 * A plan whose merge confirmed and whose payment P went out without a
 * verdict, then, after a restart, was missed for the whole grace and
 * refused when sent again: paused, its payment `signed` and its dispatch
 * `unknown`, so P may still confirm. Resolves to P's id and fee.
 */
async function paymentWithoutVerdict(
  refusal = nodeRejection('non-mandatory-script-verify-flag'),
  pausedFor = 'payment_refused'
): Promise<{ p: string; pFee: number }> {
  world.fund(150, VALUE)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const p = plan.paymentTxid
  const payment = stored().steps.at(-1)!
  world.mine()
  world.explorer.failures.push(request =>
    isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
  )
  await world.tick()
  world.explorer.failures.length = 0
  expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
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
  return { p, pFee: payment.fee }
}

/** P with no verdict, then T found pending: the paused plan's tick completes it with T. */
async function completedWithAnother(): Promise<{ p: string; pFee: number; t: string }> {
  const { p, pFee } = await paymentWithoutVerdict()
  const t = payRecipient(9_996, stored().steps.at(-1)!.inputs, T_FEE)
  await world.tick()
  expect(stored()).toMatchObject({
    phase: 'completed',
    paidBy: { txid: t, amount: AMOUNT, fee: T_FEE },
  })
  expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'broadcast', dispatch: 'unknown' })
  return { p, pFee, t }
}

/** How many outspends reads the explorer answered since request `from`. */
function outspendsReads(from: number): number {
  return world.explorer.requests.slice(from).filter(request => request.path.endsWith('/outspends'))
    .length
}

/** Every request to `path` is refused (no answer the wallet can read) until `stop`. */
function refuseWhile(path: string): { stop: () => void } {
  let refusing = true
  world.explorer.failures.push(request =>
    refusing && request.path === path ? { status: 400, body: 'refused' } : undefined
  )
  return {
    stop: (): void => {
      refusing = false
    },
  }
}

/** Lookups of `txid` answer that it is gone until `stop`, whatever the explorer holds. */
function missWhile(txid: string): { stop: () => void; start: () => void } {
  let missing = true
  world.explorer.failures.push(request =>
    missing && request.path === `/tx/${txid}/status`
      ? { status: 404, body: 'Transaction not found' }
      : undefined
  )
  return {
    stop: (): void => {
      missing = false
    },
    start: (): void => {
      missing = true
    },
  }
}

describe('the grace before a completed plan takes its named transaction for gone', () => {
  it('one stale "gone" changes nothing and reads no outspends', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    // An explorer out of step shows T spending the inputs while P stands.
    payRecipient(10_000, stored().steps.at(-1)!.inputs, T_FEE)
    world.explorer.failures.push(
      once(request =>
        request.path === `/tx/${p}/status`
          ? { status: 404, body: 'Transaction not found' }
          : undefined
      )
    )
    const revision = stored().revision
    const from = world.explorer.requests.length
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'broadcast' })
    for (let read = 0; read < 3; read++) {
      await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
      expectShows(await settledView(), { txid: p, fee: pFee, status: 'broadcast' })
    }
    expect(stored().revision).toBe(revision)
    expect(outspendsReads(from)).toBe(0)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('"gone" then found again within the grace changes nothing: the grace counts again from the next miss', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const t = payRecipient(10_001, stored().steps.at(-1)!.inputs, T_FEE)
    const missed = missWhile(p)
    await laterRead()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS / 2)
    // Found again: that run of misses is over.
    missed.stop()
    await laterRead()
    missed.start()
    await laterRead()
    // Past the grace from the first miss, within it from the first of the new run.
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS * 0.6)
    expectShows(await settledView(), { txid: p, fee: pFee, status: 'broadcast' })
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS / 2)
    for (let read = 0; read < 2; read++) await laterRead()
    expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('a restart in the middle of a run of misses starts the grace again', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const t = payRecipient(10_002, stored().steps.at(-1)!.inputs, T_FEE)
    missWhile(p)
    await laterRead()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS * 0.6)
    await world.restart()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS * 0.6)
    // Twelve minutes since the first miss, six since the restart.
    expectShows(await settledView(), { txid: p, fee: pFee, status: 'broadcast' })
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS * 0.6)
    for (let read = 0; read < 2; read++) await laterRead()
    expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('reads the explorer does not answer', () => {
  it('a lookup of the named transaction without an answer changes nothing and starts no run of misses; the next tick goes on', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(p)
    const t = payRecipient(10_003, inputs, T_FEE)
    const refused = refuseWhile(`/tx/${p}/status`)
    const revision = stored().revision
    const from = world.explorer.requests.length
    await laterRead()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'broadcast' })
    expect(stored().revision).toBe(revision)
    expect(outspendsReads(from)).toBe(0)
    // Answered again: the grace counts from the first miss read now.
    refused.stop()
    expectShows(await laterRead(), { txid: p, fee: pFee, status: 'broadcast' })
    expectShows(await pastGrace(), { txid: t, fee: T_FEE, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('an outspends read without an answer changes nothing; the next tick goes on', async () => {
    const { p } = await completedWithRelayedPayment()
    const parent = stored().steps.at(-1)!.inputs.at(-1)!.txid
    world.explorer.removeTx(p)
    const refused = refuseWhile(`/tx/${parent}/outspends`)
    expect((await pastGrace()).phase).toBe('completed')
    for (let read = 0; read < 2; read++) await laterRead()
    expect(stored().phase).toBe('completed')
    refused.stop()
    for (let read = 0; read < 2; read++) await laterRead()
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    world.assertRecipientGuarantees(undefined)
  })

  it('a read of the spender without an answer changes nothing; the next tick goes on', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(p)
    const t = payRecipient(10_004, inputs, T_FEE)
    const refused = refuseWhile(`/tx/${t}`)
    expectShows(await pastGrace(), { txid: p, fee: pFee, status: 'broadcast' })
    refused.stop()
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('a lookup of the spender without an answer changes nothing; the next tick goes on', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(p)
    const t = payRecipient(10_005, inputs, T_FEE)
    const refused = refuseWhile(`/tx/${t}/status`)
    expectShows(await pastGrace(), { txid: p, fee: pFee, status: 'broadcast' })
    refused.stop()
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('the failure that #212 removed', () => {
  it('one stale "gone" switches nothing; a switch whose transaction then disappears leaves no wrong name and nothing held', async () => {
    const { p1, p2 } = await completedOverEarlierVersion()
    const p2Fee = stored().steps.at(-1)!.fee
    const p1Fee = stored().earlierPayments![0]!.fee
    // A stale explorer: P2 missed once, while P1 shows pending.
    explorerShowsPayment(p1)
    world.explorer.failures.push(
      once(request =>
        request.path === `/tx/${p2}/status`
          ? { status: 404, body: 'Transaction not found' }
          : undefined
      )
    )
    expectShows(await laterRead(), { txid: p2, fee: p2Fee, status: 'broadcast' })
    for (let read = 0; read < 3; read++) await laterRead()
    expectShows(await settledView(), { txid: p2, fee: p2Fee, status: 'broadcast' })

    // P2 really leaves the explorer for the grace: P1, pending, is named.
    world.explorer.removeTx(p2)
    expectShows(await pastGrace(), { txid: p1, fee: p1Fee, status: 'broadcast' })
    expect(stored().earlierPayments).toEqual([expect.objectContaining({ txid: p2 })])
    // P1 disappears in turn, and P2 turns out mined after all.
    world.explorer.removeTx(p1)
    world.explorer.addTx({
      txid: p2,
      inputs: stored()
        .steps.at(-1)!
        .inputs.map(input => ({ txid: input.txid, vout: input.vout })),
      outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
      height: ++world.explorer.tipHeight,
    })
    expectShows(await laterRead(), { txid: p2, fee: p2Fee, status: 'confirmed' })
    expect(stored().earlierPayments).toBeUndefined()
    expect(await world.planHeld()).toEqual(new Set())
    expect(world.timers.scheduled).toBe(0)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('the explorer load of a completed plan', () => {
  it('reads each transaction, each outspends and each spender at most once a tick, however many pages read the plan', async () => {
    const { p } = await completedWithOwnPayment()
    const inputs = stored().steps.at(-1)!.inputs
    const parents = new Set(inputs.map(input => input.txid))
    world.explorer.removeTx(p)
    // One input spent elsewhere, another by a transaction the explorer
    // cannot read: the plan cannot settle, and goes on reading.
    const s = spendElsewhere(10_010, [inputs[0]!])
    const u = spendElsewhere(10_011, [inputs[1]!])
    refuseWhile(`/tx/${u}`)
    await pastGrace()
    expect(stored().phase).toBe('completed')
    // A new tick: twenty page reads within it.
    vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
    const from = world.explorer.requests.length
    for (let read = 0; read < 20; read++) await world.plan()
    await world.settle()
    const requests = world.explorer.requests.slice(from).map(request => request.path)
    const counts = new Map<string, number>()
    for (const path of requests) counts.set(path, (counts.get(path) ?? 0) + 1)
    for (const [path, count] of counts) expect([path, count]).toEqual([path, 1])
    expect(counts.get(`/tx/${p}/status`)).toBe(1)
    expect(counts.get(`/tx/${s}/status`)).toBe(1)
    expect(counts.get(`/tx/${u}`)).toBe(1)
    expect(requests.filter(path => path.endsWith('/outspends'))).toHaveLength(parents.size)
    // The documented bound for a completed plan without earlier versions.
    expect(requests.length).toBeLessThanOrEqual(2 * 2 + 106 + 318)
    expect(stored().phase).toBe('completed')
    world.assertRecipientGuarantees(AMOUNT)
  })
})

/**
 * What the plan remembers of the last transaction made elsewhere that paid
 * the recipient in its payment's place.
 */
function lastPaidBy(): unknown {
  return stored().extra?.['lastPaidBy']
}

/** The entry of `txid`, which paid the amount with `fee`, as the plan remembers it. */
function remembered(txid: string, fee = T_FEE): unknown {
  return { txid, amount: AMOUNT, fee }
}

describe('a plan named by a transaction T that is no version of its payment, once T is proven absent', () => {
  it('remembers T, with what it paid and its fee, as the store reads them, across a restart', async () => {
    const { t } = await completedWithT()
    const entry = { txid: t, amount: AMOUNT, fee: T_FEE }
    expect(lastPaidBy()).toEqual(entry)
    const raw = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!) as {
      plans: unknown[]
    }
    expect(validateQbitSendPlanRecord(raw.plans[0]).valid).toBe(true)
    await world.restart()
    expect(lastPaidBy()).toEqual(entry)
    world.assertRecipientGuarantees(undefined)
  })

  it('with every input unspent, reopens as a payment that may still go through, remembering T: Continue only, and its own payment sent again conflicts with T', async () => {
    const { t } = await completedWithT()
    world.explorer.removeTx(t)
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    const reopened = await pastGrace()
    expect(reopened).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      paymentMayConfirm: true,
      actions: ['continue'],
    })
    expect(stored().paidBy).toBeUndefined()
    // Its own payment never left the wallet: nothing says it did.
    expect(stored().steps.at(-1)!.dispatch).toBeUndefined()
    expect(lastPaidBy()).toEqual(remembered(t))
    expect(validateQbitSendPlanRecord(JSON.parse(JSON.stringify(stored()))).valid).toBe(true)
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)

    // The user continues: its own payment, which spends the input T spent,
    // is signed and sent once.
    const id = stored().id
    await world.wallet.continueQbitSendPlan(id, world.shownTerms(id))
    await world.settle()
    await laterRead()
    const p = stored().steps.at(-1)!.txid
    expect(world.pushed.slice(pushed)).toEqual([p])
    expect(stored()).toMatchObject({ phase: 'completed' })
    world.mine([p])
    await laterRead()
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    expect(lastPaidBy()).toBeUndefined()
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('stays completed naming T, offering no second payment, when an input T was not seen spending is spent elsewhere; T back and confirmed is named for good', async () => {
    const { t, mergeOutput } = await completedWithT()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(t)
    // An input T was not seen spending, spent elsewhere: T may still come
    // back on the inputs it spends.
    spendElsewhere(10_020, [inputs[1]!])
    const revision = stored().revision
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    const view = await pastGrace()
    expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(view.actions).toEqual(['dismiss'])
    for (let read = 0; read < 3; read++) await laterRead()
    expect(stored().revision).toBe(revision)
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    expect(world.timers.scheduled).toBe(1)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    // T comes back, and confirms.
    expect(payRecipient(9_990, [mergeOutput], T_FEE)).toBe(t)
    world.mine([t])
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'confirmed' })
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })

  it('stays completed naming T, with dismiss, while the input T spends is spent by a transaction found confirmed and another input is unspent; reopens outputs_spent with a replan once every input is', async () => {
    const { t, mergeOutput } = await completedWithT()
    world.explorer.removeTx(t)
    world.mine([spendElsewhere(10_022, [mergeOutput])])
    const named = await pastGrace()
    expectShows(named, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(named.actions).toEqual(['dismiss'])
    expect(lastPaidBy()).toEqual(remembered(t))
    confirmedSpendOfTheRest(10_023, mergeOutput)
    const reopened = await pastGrace()
    expect(reopened).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(reopened.paymentMayConfirm).toBeUndefined()
    expect(reopened.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expect(lastPaidBy()).toBeUndefined()
    expect(await world.wallet.cancelQbitSendPlan(stored().id)).toBeNull()
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })

  it('stays completed naming T, offering dismiss alone, while what spends an input T was seen spending is only pending', async () => {
    const { t, mergeOutput } = await completedWithT()
    world.explorer.removeTx(t)
    spendElsewhere(10_022, [mergeOutput])
    await expectNamedWhileOnlyPending(t, await pastGrace())
    expect(lastPaidBy()).toEqual(remembered(t))
    world.assertRecipientGuarantees(undefined)
  })

  it('reopens outputs_spent once every input of the payment is spent by transactions that are not T, found confirmed', async () => {
    const { t } = await completedWithT()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(t)
    world.mine([spendElsewhere(10_021, inputs)])
    const reopened = await pastGrace()
    expect(reopened).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(reopened.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expect(stored().paidBy).toBeUndefined()
    expect(validateQbitSendPlanRecord(JSON.parse(JSON.stringify(stored()))).valid).toBe(true)
    expect(await world.wallet.cancelQbitSendPlan(stored().id)).toBeNull()
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })

  it('stays completed naming T, offering dismiss alone, while what spends every input of the payment is only pending', async () => {
    const { t } = await completedWithT()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(t)
    spendElsewhere(10_021, inputs)
    await expectNamedWhileOnlyPending(t, await pastGrace())
    expect(lastPaidBy()).toEqual(remembered(t))
    world.assertRecipientGuarantees(undefined)
  })

  it('reopening, holds again what the paused plan needs that the completed one let go of: the inputs of a merge not confirmed', async () => {
    // T spends the merge's output while the merge is pending.
    const { t, merge } = await completedOnPendingMerge()
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    const mergeInputs = merge.inputs.map(input => `${input.txid}:${input.vout}`)
    // T leaves the network while the merge stays pending, and nothing
    // spends an input of the payment: the plan reopens beside T.
    world.explorer.removeTx(t)
    expect(await pastGrace()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
    })
    expect(await world.planHeld()).toEqual(new Set([...mergeInputs, ...paymentInputKeys()]))
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a dismiss racing the reopening', () => {
  it('a dismiss that lands first leaves the plan dismissed, holding nothing', async () => {
    const { p } = await completedWithRelayedPayment()
    world.explorer.removeTx(p)
    const pushed = world.pushed.length
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    let dismissed: Promise<string> | undefined
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementation(async (record, readRevision) => {
      if (record.phase === 'paused' && dismissed === undefined) {
        dismissed = world.wallet.dismissQbitSendPlan(record.id).then(
          () => 'dismissed',
          (error: unknown) => String(error)
        )
        await dismissed
      }
      return put(record, readRevision)
    })
    await pastGrace()
    expect(await dismissed).toBe('dismissed')
    expect(qbitSendPlanStore.list()).toEqual([])
    expect(await world.planHeld()).toEqual(new Set())
    expect(world.pushed).toHaveLength(pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('a reopening that lands first leaves the plan reopened, and the dismiss refused', async () => {
    const { p } = await completedWithRelayedPayment()
    world.explorer.removeTx(p)
    const planId = stored().id
    const remove = qbitSendPlanStore.delete.bind(qbitSendPlanStore)
    let reopenedFirst = false
    vi.spyOn(qbitSendPlanStore, 'delete').mockImplementation(async (id, readRevision) => {
      if (!reopenedFirst) {
        reopenedFirst = true
        // The dismiss read the plan completed; the reopening writes before its delete.
        await pastGrace()
        expect(stored().phase).toBe('paused')
      }
      return remove(id, readRevision)
    })
    const dismissed = await world.wallet.dismissQbitSendPlan(planId).then(
      () => 'dismissed',
      (error: unknown) => (error as Error).message
    )
    expect(reopenedFirst).toBe(true)
    expect(dismissed).toBe('Only a completed Qbit send plan can be dismissed')
    expect(stored()).toMatchObject({
      id: planId,
      phase: 'paused',
      pause: { reason: 'interrupted' },
    })
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    world.assertRecipientGuarantees(undefined)
  })
})

describe('what the reopening leaves alone', () => {
  /** The engine's reopening, as a stale decision would make it on `record`. */
  function reopenOn(record: QbitSendPlanRecord, named: string): Promise<boolean> {
    const engine = world.engine as unknown as {
      reopenCompleted(
        record: QbitSendPlanRecord,
        named: string,
        reason: 'outputs_spent' | 'interrupted'
      ): Promise<boolean>
    }
    return engine.reopenCompleted(record, named, 'interrupted')
  }

  /** `record` as a completed plan named by its payment, as a decision read it before it changed. */
  function asCompleted(record: QbitSendPlanRecord): QbitSendPlanRecord {
    const payment = { ...record.steps.at(-1)!, status: 'broadcast' as const }
    delete payment.signedPsbtHex
    const { pause: _pause, ...rest } = record
    return { ...rest, phase: 'completed', steps: [...record.steps.slice(0, -1), payment] }
  }

  it('a cancelling plan: a reopening decided on it as completed writes nothing and holds nothing more', async () => {
    world.fund(150, VALUE)
    await world.open()
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    world.explorer.failures.length = 0
    expect(world.storedStatuses()[0]).toBe('unknown')
    expect(await world.wallet.cancelQbitSendPlan(plan.id)).toMatchObject({ phase: 'cancelling' })
    const before = stored()
    const held = await world.planHeld()
    expect(await reopenOn(asCompleted(before), plan.paymentTxid)).toBe(false)
    expect(stored()).toEqual(before)
    expect(await world.planHeld()).toEqual(held)
    world.assertRecipientGuarantees(undefined)
  })

  it('a plan that failed its checks: a reopening decided on it as completed writes nothing and holds nothing more', async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!) as {
      plans: Record<string, unknown>[]
    }
    document.plans[0]!['phase'] = 'paused'
    document.plans[0]!['pause'] = { reason: 'unreadable', at: T0 }
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await world.restart()
    await world.plan()
    const before = stored()
    expect(before).toMatchObject({ phase: 'paused', pause: { reason: 'unreadable' } })
    const held = await world.planHeld()
    expect(await reopenOn(asCompleted(before), plan.paymentTxid)).toBe(false)
    expect(stored()).toEqual(before)
    expect(await world.planHeld()).toEqual(held)
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a reopened plan across a restart', () => {
  it('passes the store check, and a restart restores it as a paused plan with its holds, Continue offered once unlocked', async () => {
    const { p } = await completedWithRelayedPayment()
    world.explorer.removeTx(p)
    await pastGrace()
    const before = stored()
    expect(before).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    const raw = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!) as {
      plans: unknown[]
    }
    expect(validateQbitSendPlanRecord(raw.plans[0]).valid).toBe(true)
    await world.restart()
    expect(stored()).toMatchObject({
      id: before.id,
      phase: 'paused',
      pause: { reason: 'interrupted' },
    })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'planned', dispatch: 'unknown' })
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    // Locked after the restart: nothing is offered until the user unlocks.
    expect(await settledView()).toMatchObject({
      phase: 'paused',
      paymentMayConfirm: true,
      actions: [],
    })
    await world.unlock()
    expect((await settledView()).actions).toEqual(['continue'])
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * The stored plan's entry of the last transaction made elsewhere that paid
 * in its payment's place replaced by `entry` (none removes it, as for a plan
 * completed before it was remembered), a restart, and an unlock.
 */
async function rememberedAs(entry: unknown): Promise<void> {
  const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!) as {
    plans: { extra?: Record<string, unknown> }[]
  }
  const plan = document.plans[0]!
  plan.extra = { ...(plan.extra ?? {}) }
  if (entry === undefined) delete plan.extra['lastPaidBy']
  else plan.extra['lastPaidBy'] = entry
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
  await world.restart()
  // Unlocked, so that what a view offers is what the plan offers.
  await world.unlock()
  expect(qbitSendPlanStore.list()).toHaveLength(1)
}

/** An entry of the last transaction made elsewhere that cannot be read: the shape the plan kept before. */
const UNREADABLE = [{ txid: 'ab'.repeat(32), inputs: [`${'cd'.repeat(32)}:0`] }]

/** A plan completed with T, T then proven absent with every input unspent: reopened, remembering T. */
async function reopenedBesideT(): Promise<{
  t: string
  mergeOutput: { txid: string; vout: number }
}> {
  const completed = await completedWithT()
  world.explorer.removeTx(completed.t)
  expect(await pastGrace()).toMatchObject({
    phase: 'paused',
    pause: { reason: 'interrupted' },
    paymentMayConfirm: true,
    actions: ['continue'],
  })
  return completed
}

describe('a plan reopened beside T, which may still confirm', () => {
  it('completes with T again once T is found again', async () => {
    const { t, mergeOutput } = await reopenedBesideT()
    const pushed = world.pushed.length
    expect(payRecipient(9_990, [mergeOutput], T_FEE)).toBe(t)
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(stored().paidBy).toEqual({ txid: t, amount: AMOUNT, fee: T_FEE })
    world.mine([t])
    expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'confirmed' })
    expect(await world.planHeld()).toEqual(new Set())
    expect(world.pushed).toHaveLength(pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('is completed naming T again, with dismiss, when an input is spent elsewhere; once every input is spent by a transaction found confirmed, it reopens outputs_spent with a replan and a cancel', async () => {
    const { t } = await reopenedBesideT()
    const inputs = stored().steps.at(-1)!.inputs
    const pushed = world.pushed.length
    const first = spendElsewhere(10_040, [inputs[1]!])
    for (let read = 0; read < 2; read++) await laterRead()
    // Its own payment cannot confirm any more, and T may: the plan is the
    // completed plan named by T that the same facts give from a completed
    // plan, offering no second payment, and dismiss.
    const named = await settledView()
    expectShows(named, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(named.actions).toEqual(['dismiss'])
    expect(stored().paidBy).toEqual({ txid: t, amount: AMOUNT, fee: T_FEE })
    expect(stored().steps.at(-1)!.signedPsbtHex).toBeUndefined()
    expect(validateQbitSendPlanRecord(JSON.parse(JSON.stringify(stored()))).valid).toBe(true)
    expect(lastPaidBy()).toEqual(remembered(t))
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    await expect(world.wallet.cancelQbitSendPlan(stored().id)).resolves.toMatchObject({
      phase: 'completed',
    })
    expect(qbitSendPlanStore.list()).toHaveLength(1)

    // Every input spent by a transaction found confirmed: the rule is met,
    // once T's new name has had its grace.
    world.mine([first])
    confirmedSpendOfTheRest(10_041, inputs[1]!)
    const dead = await pastGrace()
    expect(dead).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(dead.paymentMayConfirm).toBeUndefined()
    expect(dead.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expect(lastPaidBy()).toBeUndefined()
    expect(world.pushed).toHaveLength(pushed)
    expect(await world.wallet.cancelQbitSendPlan(stored().id)).toBeNull()
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })

  it('is completed naming T again, with dismiss alone, while what spends an input T was seen spending is only pending', async () => {
    const { t, mergeOutput } = await reopenedBesideT()
    const pushed = world.pushed.length
    spendElsewhere(10_043, [mergeOutput])
    for (let read = 0; read < 2; read++) await laterRead()
    await expectNamedWhileOnlyPending(t, await settledView())
    // And once the grace of its new name has passed.
    await expectNamedWhileOnlyPending(t, await pastGrace())
    expect(lastPaidBy()).toEqual(remembered(t))
    expect(world.pushed).toHaveLength(pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('reads each outspends at most once a tick however many pages read it, while it waits beside an entry it cannot read', async () => {
    await reopenedBesideT()
    await rememberedAs(UNREADABLE)
    const inputs = stored().steps.at(-1)!.inputs
    spendElsewhere(10_042, [inputs[1]!])
    for (let read = 0; read < 2; read++) await laterRead()
    expect(await settledView()).toMatchObject({ phase: 'paused', actions: [] })
    vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
    const from = world.explorer.requests.length
    for (let read = 0; read < 20; read++) await world.plan()
    await world.settle()
    const counts = new Map<string, number>()
    for (const { path } of world.explorer.requests.slice(from)) {
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    for (const [path, count] of counts) expect([path, count]).toEqual([path, 1])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('what the plan remembers of T, as stored before it was kept or changed on disk', () => {
  it('a plan completed with T before it was remembered has that by its paidBy: reopened with its inputs unspent it writes it, Continue only; an input spent names T again; every input spent by a confirmed transaction lets it go', async () => {
    const { t } = await completedWithT()
    await rememberedAs(undefined)
    expect(lastPaidBy()).toBeUndefined()
    world.explorer.removeTx(t)
    const reopened = await pastGrace()
    expect(reopened).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    expect(reopened.actions).toEqual(['continue'])
    expect(lastPaidBy()).toEqual(remembered(t))
    const inputs = stored().steps.at(-1)!.inputs
    const first = spendElsewhere(10_050, [inputs[0]!])
    for (let read = 0; read < 2; read++) await laterRead()
    const named = await settledView()
    expectShows(named, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(named.actions).toEqual(['dismiss'])
    world.mine([first])
    confirmedSpendOfTheRest(10_051, inputs[0]!)
    const dead = await pastGrace()
    expect(dead).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(dead.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expect(lastPaidBy()).toBeUndefined()
    world.assertRecipientGuarantees(undefined)
  })

  it('a plan completed with T before it was remembered stays completed naming T, offering dismiss alone, while what spends every input is only pending', async () => {
    const { t } = await completedWithT()
    const inputs = stored().steps.at(-1)!.inputs
    await rememberedAs(undefined)
    world.explorer.removeTx(t)
    spendElsewhere(10_050, inputs)
    await expectNamedWhileOnlyPending(t, await pastGrace())
    world.assertRecipientGuarantees(undefined)
  })

  it.each([
    ['a word', 'T'],
    ['the list kept before', UNREADABLE],
    ['a txid not of its form', { txid: 'T', amount: AMOUNT, fee: T_FEE }],
    ['the payment itself', 'payment'],
    ['an amount or a fee that is no whole number', { txid: 'ab'.repeat(32), amount: 0, fee: 0.5 }],
  ])(
    'an entry with %s keeps the state and names nothing: no replan and no cancel until every input is spent by a confirmed transaction',
    async (_label, entry) => {
      const { t } = await reopenedBesideT()
      const inputs = stored().steps.at(-1)!.inputs
      const payment = stored().steps.at(-1)!.txid
      const damaged = entry === 'payment' ? { txid: payment, amount: AMOUNT, fee: T_FEE } : entry
      await rememberedAs(damaged)
      expect(await settledView()).toMatchObject({
        phase: 'paused',
        pause: { reason: 'interrupted' },
        paymentMayConfirm: true,
        actions: ['continue'],
      })
      // Its own payment cannot go any more: nothing is named from the entry,
      // and nothing is offered.
      spendElsewhere(10_052, [inputs[1]!])
      for (let read = 0; read < 3; read++) await laterRead()
      const stuck = await settledView()
      expect(stuck).toMatchObject({
        phase: 'paused',
        pause: { reason: 'outputs_spent' },
        actions: [],
      })
      expect(stored().paidBy).toBeUndefined()
      expect(lastPaidBy()).toEqual(damaged)
      // T comes back: it is named, and remembered again.
      expect(payRecipient(9_990, [inputs[0]!], T_FEE)).toBe(t)
      for (let read = 0; read < 3; read++) await laterRead()
      expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
      expect(lastPaidBy()).toEqual(remembered(t))
      world.assertRecipientGuarantees(undefined)
    }
  )

  it.each([
    ['a word', 'T'],
    ['the list kept before', UNREADABLE],
  ])(
    'an entry with %s, paused with its own payment unable to go, is let go of once every input is spent by a confirmed transaction',
    async (_label, entry) => {
      await reopenedBesideT()
      const inputs = stored().steps.at(-1)!.inputs
      await rememberedAs(entry)
      const first = spendElsewhere(10_053, [inputs[1]!])
      for (let read = 0; read < 3; read++) await laterRead()
      expect(await settledView()).toMatchObject({ phase: 'paused', actions: [] })
      // Every other input spent by a confirmed transaction, that one only
      // pending: nothing is offered yet.
      confirmedSpendOfTheRest(10_054, inputs[1]!)
      for (let read = 0; read < 3; read++) await laterRead()
      expect(await settledView()).toMatchObject({ phase: 'paused', actions: [] })
      world.mine([first])
      for (let read = 0; read < 3; read++) await laterRead()
      const released = await settledView()
      expect(released).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
      expect(released.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
      expect(lastPaidBy()).toBeUndefined()
      world.assertRecipientGuarantees(undefined)
    }
  )
})

describe('a reopened plan is ended by what ends any plan', () => {
  it('a wallet removal ends a plan reopened as a payment that may still go through, as one that may have paid', async () => {
    const { p } = await completedWithRelayedPayment()
    world.explorer.removeTx(p)
    const reopened = await pastGrace()
    // No cancel and no replan while the payment may still confirm.
    expect(reopened.actions).not.toContain('cancel')
    expect(reopened.actions).not.toContain('replan')
    const ending = await world.engine.endPlansOf([{ chain: CHAIN, address: account.address }])
    await world.settle()
    expect(ending).toMatchObject({ ended: [reopened.id], mayHaveBeenSent: [reopened.id] })
    expect(qbitSendPlanStore.list()).toEqual([])
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })

  it('a wallet removal ends a plan reopened beside T, as one that may have paid', async () => {
    await reopenedBesideT()
    const id = stored().id
    const ending = await world.engine.endPlansOf([{ chain: CHAIN, address: account.address }])
    await world.settle()
    expect(ending).toMatchObject({ ended: [id], mayHaveBeenSent: [id] })
    expect(qbitSendPlanStore.list()).toEqual([])
    expect(await world.planHeld()).toEqual(new Set())
    world.assertRecipientGuarantees(undefined)
  })

  it('a wallet reset ends a reopened plan, holding nothing', async () => {
    const { p } = await completedWithRelayedPayment()
    world.explorer.removeTx(p)
    expect((await pastGrace()).phase).toBe('paused')
    await world.wallet.resetAllData()
    await world.settle()
    expect(qbitSendPlanStore.list()).toEqual([])
    expect(await world.planHeld()).toEqual(new Set())
    await world.tick()
    expect(await world.plan()).toBeNull()
    world.assertRecipientGuarantees(undefined)
  })
})

describe('what decides once the named transaction is proven absent', () => {
  it('counts no outspends read before the current run of misses: a spender that came since is found', async () => {
    const { p } = await completedWithOwnPayment()
    const inputs = stored().steps.at(-1)!.inputs
    // A first run of misses, past the grace: one advance reads the first
    // eight of the sixteen transactions the payment spends from, nothing
    // spending their outputs.
    world.explorer.removeTx(p)
    await laterRead()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expect(stored().phase).toBe('completed')
    // P is found again, which ends that run; then it is gone again, and a
    // transaction paying the recipient spends an input those reads covered.
    explorerShowsPayment(p)
    await laterRead()
    world.explorer.removeTx(p)
    const t = payRecipient(10_060, [inputs[0]!], T_FEE)
    await laterRead()
    // Proven absent again: this advance reads the other eight; the first
    // eight were read in the earlier run, and decide nothing.
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expect(stored().phase).toBe('completed')
    expect(stored().paidBy).toBeUndefined()
    for (let read = 0; read < 2; read++) await laterRead()
    expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('revisions beside T', () => {
  it('a raise of the payment fee remembers T, and with it no replan and no cancel', async () => {
    const { t } = await reopenedBesideT()
    const id = stored().id
    const p = stored().steps.at(-1)!.txid
    world.refuse.set(p, nodeRejection('mempool min fee not met'))
    await world.wallet.continueQbitSendPlan(id, world.shownTerms(id))
    await world.settle()
    await laterRead()
    world.refuse.delete(p)
    const refused = await settledView()
    expect(refused).toMatchObject({ phase: 'paused', pause: { reason: 'payment_fee_too_low' } })
    expect(refused.actions).toContain('raise_payment_fee')
    expect(refused.actions).not.toContain('cancel')
    expect(refused.actions).not.toContain('replan')
    const raise = await world.prepare({
      target: { kind: 'amount', amount: AMOUNT },
      feeRate: 2,
      revise: { planId: id, kind: 'raise_payment_fee' },
    })
    if (!raise.ok) throw new Error(`raise refused: ${raise.reason}`)
    world.refuse.set(raise.review.payment.txid, nodeRejection('non-mandatory-script-verify-flag'))
    expect(await world.wallet.startQbitSendPlan(raise.review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    await laterRead()
    const raised = await settledView()
    expect(raised).toMatchObject({ phase: 'paused', paymentTxid: raise.review.payment.txid })
    expect(lastPaidBy()).toEqual(remembered(t))
    expect(raised.actions).not.toContain('cancel')
    expect(raised.actions).not.toContain('replan')
    world.assertRecipientGuarantees(undefined)
  })

  it('offers no raise of a slow merge fee beside T, which would build the payment on other inputs', async () => {
    world.fund(150, VALUE)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const merge = stored().steps[0]!
    const t = payRecipient(10_070, [{ txid: merge.txid, vout: 0 }], T_FEE)
    await world.tick()
    expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
    world.explorer.removeTx(t)
    expect(await pastGrace()).toMatchObject({ phase: 'paused', paymentMayConfirm: true })
    expect(stored().steps[0]).toMatchObject({ status: 'broadcast' })
    // The merge stays unconfirmed for long.
    await world.tick(QBIT_SEND_PLAN_SLOW_MERGE_MS)
    const slow = await laterRead()
    expect(slow.actions).not.toContain('raise_merge_fee')
    expect(slow.actions).toEqual(['continue'])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a version of the payment found pending by its lookup alone', () => {
  it('is named at the advance that proves the named one absent', async () => {
    const { p1, p2 } = await completedOverEarlierVersion()
    const p1Fee = stored().earlierPayments![0]!.fee
    // The explorer finds P1 pending, its index of what spends outputs lagging.
    world.explorer.addTx({
      txid: p1,
      inputs: [],
      outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
    })
    world.explorer.removeTx(p2)
    await laterRead()
    expect(stored().steps.at(-1)!.txid).toBe(p2)
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().steps.at(-1)!.txid).toBe(p1)
    expectShows(await settledView(), { txid: p1, fee: p1Fee, status: 'broadcast' })
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('the explorer load of a reopened plan', () => {
  it('looks a spender up at most once a tick while the explorer cannot tell what it is, however many pages read the plan', async () => {
    await reopenedBesideT()
    const inputs = stored().steps.at(-1)!.inputs
    // A transaction paying the recipient spends an input, and the explorer
    // lists it as the spender while its lookup says it is gone.
    const t2 = payRecipient(10_090, [inputs[1]!], T2_FEE)
    missWhile(t2)
    for (let read = 0; read < 2; read++) await laterRead()
    expect(stored().phase).toBe('paused')
    vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
    const from = world.explorer.requests.length
    for (let read = 0; read < 20; read++) await world.plan()
    await world.settle()
    const counts = new Map<string, number>()
    for (const { path } of world.explorer.requests.slice(from)) {
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    expect(counts.get(`/tx/${t2}/status`)).toBe(1)
    for (const [path, count] of counts) expect([path, count]).toEqual([path, 1])
    expect(stored().phase).toBe('paused')
    world.assertRecipientGuarantees(undefined)
  })
})

/** Every transaction the explorer has confirmed that pays the recipient. */
function confirmedRecipientPayers(): string[] {
  return [...world.explorer.txs.values()]
    .filter(
      tx => tx.height !== undefined && tx.outputs.some(output => output.script === RECIPIENT_SCRIPT)
    )
    .map(tx => tx.txid)
}

/** `txid` as the explorer holds it, to add it again once its signer sends it again. */
function copyOf(txid: string): Parameters<typeof world.explorer.addTx>[0] {
  const tx = world.explorer.txs.get(txid)!
  return {
    txid: tx.txid,
    inputs: [...tx.inputs],
    outputs: [...tx.outputs],
    ...(tx.fee !== undefined ? { fee: tx.fee } : {}),
  }
}

/**
 * The user replans with new funds when the view offers it, so that the
 * replan's payment need not spend what T spends: resolves to whether a
 * replan started.
 */
async function replanIfOffered(view: QbitSendPlanView): Promise<boolean> {
  if (!view.actions.includes('replan')) return false
  world.fund(1, 400_000_000)
  const replan = await world.prepare({
    target: { kind: 'amount', amount: view.amount },
    revise: { planId: view.id, kind: 'replan' },
  })
  if (!replan.ok) return false
  const started = await world.wallet.startQbitSendPlan(replan.review.draftId)
  await world.settle()
  for (let read = 0; read < 3; read++) await laterRead()
  return started.ok
}

/** Every input of the payment but `besides` spent by one transaction paying someone else, confirmed. */
function confirmedSpendOfTheRest(
  seed: number,
  ...besides: { txid: string; vout: number }[]
): string {
  const s = spendElsewhere(
    seed,
    stored()
      .steps.at(-1)!
      .inputs.filter(
        input => !besides.some(other => other.txid === input.txid && other.vout === input.vout)
      )
  )
  world.mine([s])
  return s
}

/** The input of the payment other than `input`, read in the same round of reads. */
function otherInput(input: { txid: string; vout: number }): { txid: string; vout: number } {
  return stored()
    .steps.at(-1)!
    .inputs.find(candidate => !(candidate.txid === input.txid && candidate.vout === input.vout))!
}

/** Completed with T, T proven absent: reopened beside T, the user continues, and P is found pending. */
async function continuedBesideT(): Promise<{
  t: string
  tCopy: Parameters<typeof world.explorer.addTx>[0]
  mergeOutput: { txid: string; vout: number }
  p: string
}> {
  const { t, mergeOutput } = await completedWithT()
  const tCopy = copyOf(t)
  world.explorer.removeTx(t)
  expect(await pastGrace()).toMatchObject({ phase: 'paused', actions: ['continue'] })
  const id = stored().id
  await world.wallet.continueQbitSendPlan(id, world.shownTerms(id))
  await world.settle()
  await laterRead()
  const p = stored().steps.at(-1)!.txid
  expect(stored()).toMatchObject({ phase: 'completed' })
  expect(stored().paidBy).toBeUndefined()
  // Found only pending, P can be evicted: T stays remembered.
  expect(lastPaidBy()).toEqual(remembered(t))
  return { t, tCopy, mergeOutput, p }
}

describe('F1: what paid in the payment place is remembered while the transaction the plan names has not confirmed', () => {
  it('V1: continued beside T, completed with its own payment P, P evicted, an input T was not seen spending spent elsewhere: no replan, T named again, and the recipient is paid once', async () => {
    const { t, tCopy, mergeOutput, p } = await continuedBesideT()
    world.explorer.removeTx(p)
    spendElsewhere(10_500, [otherInput(mergeOutput)])
    const view = await pastGrace()
    expect(view.actions).not.toContain('replan')
    expect(view.actions).not.toContain('cancel')
    expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(await replanIfOffered(view)).toBe(false)
    // T's signer sends it again, and it confirms.
    world.explorer.addTx(tCopy)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('V1b: P evicted with every input unspent reopens remembering T; an input T was not seen spending then spent elsewhere names T again, never offering a replan', async () => {
    const { t, tCopy, mergeOutput, p } = await continuedBesideT()
    world.explorer.removeTx(p)
    const reopened = await pastGrace()
    expect(reopened).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      actions: ['continue'],
    })
    expect(lastPaidBy()).toEqual(remembered(t))
    spendElsewhere(10_600, [otherInput(mergeOutput)])
    for (let read = 0; read < 2; read++) await laterRead()
    const later = await settledView()
    expectShows(later, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(later.actions).toEqual(['dismiss'])
    expect(await replanIfOffered(later)).toBe(false)
    world.explorer.addTx(tCopy)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('named by T, then by its own payment found pending in what spends the inputs, remembers T; that payment evicted and an input T was not seen spending spent, T is named again', async () => {
    const { t, mergeOutput } = await completedWithT()
    const tCopy = copyOf(t)
    const p = stored().steps.at(-1)!.txid
    world.explorer.removeTx(t)
    // The explorer shows its own payment pending, spending every input.
    explorerShowsPayment(p)
    expect(await pastGrace()).toMatchObject({ phase: 'completed', paymentTxid: p })
    expect(stored().paidBy).toBeUndefined()
    expect(lastPaidBy()).toEqual(remembered(t))
    world.explorer.removeTx(p)
    spendElsewhere(10_610, [otherInput(mergeOutput)])
    const view = await pastGrace()
    expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(view.actions).toEqual(['dismiss'])
    expect(await replanIfOffered(view)).toBe(false)
    world.explorer.addTx(tCopy)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(undefined)
  })

  it('named by T, then by an earlier version of its payment found pending, remembers T; that version evicted and an input T was not seen spending spent, T is named again', async () => {
    const { p1, t, spent } = await completedWithTOverEarlierVersion()
    const tCopy = copyOf(t)
    world.explorer.removeTx(t)
    world.explorer.addTx({
      txid: p1,
      inputs: [],
      outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
    })
    expect(await pastGrace()).toMatchObject({ phase: 'completed', paymentTxid: p1 })
    expect(lastPaidBy()).toEqual(remembered(t))
    world.explorer.removeTx(p1)
    spendElsewhere(10_621, [otherInput(spent)])
    const view = await pastGrace()
    expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(await replanIfOffered(view)).toBe(false)
    world.explorer.addTx(tCopy)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(undefined)
  })

  it('names T2, the last, when another transaction paying the recipient replaces T on its input: T2 undone by a confirmed spend of its other input, T may come back, and no replan is offered', async () => {
    const { t, mergeOutput } = await completedWithT()
    const tCopy = copyOf(t)
    const b = otherInput(mergeOutput)
    world.explorer.removeTx(t)
    // T2 replaces T on its input, and spends another input too.
    const t2 = payRecipient(10_630, [mergeOutput, b], T2_FEE)
    expectShows(await pastGrace(), { txid: t2, fee: T2_FEE, status: 'broadcast' })
    expect(lastPaidBy()).toEqual(remembered(t2, T2_FEE))
    // T2 is undone by a spend of its other input, which confirms; T's input
    // is free again, and not every input is spent.
    world.explorer.removeTx(t2)
    world.mine([spendElsewhere(10_631, [b])])
    const view = await pastGrace()
    expect(view.actions).not.toContain('replan')
    expectShows(view, { txid: t2, fee: T2_FEE, status: 'broadcast' })
    expect(await replanIfOffered(view)).toBe(false)
    world.explorer.addTx(tCopy)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * A plan completed with its own payment P while its merge is recorded
 * pending, and no transaction made elsewhere ever paid: P went out without
 * a verdict; a reorganisation took the merge out of its block; P, missed
 * for the whole grace, waited for the merge again; then another node
 * relayed P, which the plan found pending. Resolves to P and the merge.
 */
async function completedOverReorganisedMerge(): Promise<{
  p: string
  merge: QbitSendPlanRecord['steps'][number]
}> {
  world.fund(150, VALUE)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  const p = plan.paymentTxid
  const merge = stored().steps[0]!
  world.mine()
  world.explorer.failures.push(request =>
    isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
  )
  await world.tick()
  world.explorer.failures.length = 0
  expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
  delete world.explorer.txs.get(merge.txid)!.height
  await pastGrace()
  expect(stored()).toMatchObject({ phase: 'waiting' })
  expect(world.storedStatuses()).toEqual(['broadcast', 'unknown'])
  explorerShowsPayment(p)
  await laterRead()
  expect(stored()).toMatchObject({ phase: 'completed' })
  expect(world.storedStatuses()).toEqual(['broadcast', 'broadcast'])
  expect(stored().paidBy).toBeUndefined()
  expect(lastPaidBy()).toBeUndefined()
  return { p, merge }
}

/**
 * The next request for `path` waits, unanswered, until `release`; it is then
 * answered as the explorer stands. `arrived(during)` settles once that
 * request is made, and fails, naming `path`, if `during` settles first: the
 * request was never made while it ran.
 */
function holdNext(path: string): {
  arrived: (during: Promise<unknown>) => Promise<void>
  release: () => void
} {
  const explorer = world.explorer
  const fetch = explorer.fetch
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let arrive!: () => void
  const requested = new Promise<'requested'>(resolve => {
    arrive = (): void => resolve('requested')
  })
  let made = false
  explorer.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    if (!made && url.pathname.replace(/^\/api/, '') === path) {
      made = true
      explorer.fetch = fetch
      arrive()
      await gate
    }
    return fetch(input, init)
  }
  return {
    arrived: async (during: Promise<unknown>): Promise<void> => {
      const settled = during.then(
        () => 'settled' as const,
        () => 'settled' as const
      )
      if ((await Promise.race([requested, settled])) === 'settled' && !made) {
        explorer.fetch = fetch
        throw new Error(`${path} was never requested`)
      }
    },
    release,
  }
}

describe('a payment found confirmed after a transaction made elsewhere was named', () => {
  it('a raise prepared while the tick completes the plan with X, the prepare then finding the payment P confirmed: P is the name, for good, and the recipient is paid once', async () => {
    const { p } = await paymentWithoutVerdict(
      nodeRejection('mempool min fee not met'),
      'payment_fee_too_low'
    )
    expect((await world.plan())!.actions).toContain('raise_payment_fee')
    const inputs = stored().steps.at(-1)!.inputs
    // A tick looks P up and reads half of the transactions the payment
    // spends from; the prepare's own lookup of P is then held.
    const from = world.explorer.requests.length
    await world.tick()
    const read = new Set(
      world.explorer.requests
        .slice(from)
        .filter(request => request.path.endsWith('/outspends'))
        .map(request => request.path.split('/')[2])
    )
    const unread = inputs.find(input => !read.has(input.txid))!
    expect(unread).toBeDefined()
    const held = holdNext(`/tx/${p}/status`)
    const preparing = world.prepare({
      target: { kind: 'amount', amount: AMOUNT },
      feeRate: 2,
      revise: { planId: stored().id, kind: 'raise_payment_fee' },
    })
    await held.arrived(preparing)
    // Meanwhile X, made elsewhere, pays the recipient from an input the
    // tick has not read yet, and a page's read completes the plan with it.
    const x = payRecipient(10_670, [unread], T_FEE)
    await world.plan()
    await world.settle()
    expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: x } })
    // Then P confirms, and X is gone with it; the held lookup answers.
    world.explorer.removeTx(x)
    explorerShowsPayment(p)
    world.mine([p])
    held.release()
    await expect(preparing).rejects.toThrow('does not offer this revision now')
    const record = stored()
    expect(validateQbitSendPlanRecord(JSON.parse(JSON.stringify(record))).valid).toBe(true)
    expect(record.steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    expect(record.paidBy).toBeUndefined()
    const view = await settledView()
    expect(view).toMatchObject({ phase: 'completed', paymentTxid: p, actions: ['dismiss'] })
    expect(view.steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    expectNoSecondPayment()
  })
})

/**
 * What then spends the inputs of a merge the record does not show confirmed,
 * once the explorer no longer holds it: `apply` makes it and resolves to a
 * transaction to confirm at the end, if any.
 */
const MERGE_DROPS: readonly {
  name: string
  apply: (merge: QbitSendPlanRecord['steps'][number]) => string | undefined
}[] = [
  { name: 'dropped, its inputs unspent', apply: () => undefined },
  {
    name: 'one of its inputs spent by a confirmed transaction paying someone else',
    apply: merge => {
      world.mine([spendElsewhere(10_730, [merge.inputs[0]!])])
      return undefined
    },
  },
  {
    name: 'one of its inputs spent by a confirmed transaction paying the recipient the amount',
    apply: merge => {
      world.mine([payRecipient(10_731, [merge.inputs[0]!], T_FEE)])
      return undefined
    },
  },
  {
    name: 'killed by two confirmed transactions, one paying someone else on its first input and one paying the recipient on its second',
    apply: merge => {
      world.mine([
        spendElsewhere(10_732, [merge.inputs[0]!]),
        payRecipient(10_733, [merge.inputs[1]!], T_FEE),
      ])
      return undefined
    },
  },
  {
    name: 'killed by two confirmed transactions, one paying the recipient on its first input and one paying someone else on its second',
    apply: merge => {
      world.mine([
        payRecipient(10_734, [merge.inputs[0]!], T_FEE),
        spendElsewhere(10_735, [merge.inputs[1]!]),
      ])
      return undefined
    },
  },
  {
    name: 'with a transaction paying the recipient on its first input only pending, and its second spent by a confirmed transaction paying someone else; the pending one confirms at the end',
    apply: merge => {
      const pending = payRecipient(10_736, [merge.inputs[0]!], T_FEE)
      world.mine([spendElsewhere(10_737, [merge.inputs[1]!])])
      return pending
    },
  },
]

/** Completed plans that spend the output of a merge the record does not show confirmed. */
const DROPPED_MERGE_PLANS: readonly {
  name: string
  setUp: () => Promise<{
    named: string
    fee: number
    merge: QbitSendPlanRecord['steps'][number]
  }>
}[] = [
  {
    name: 'completed with T on its pending merge (the state set), every other input spent by a confirmed transaction',
    setUp: async () => {
      const { t, merge } = await completedOnPendingMerge()
      confirmedSpendOfTheRest(10_720, { txid: merge.txid, vout: 0 })
      return { named: t, fee: T_FEE, merge }
    },
  },
  {
    name: 'completed with its own payment P found while its merge was pending again (no state)',
    setUp: async () => {
      const { p, merge } = await completedOverReorganisedMerge()
      return { named: p, fee: stored().steps.at(-1)!.fee, merge }
    },
  },
]

/**
 * Each case: the plan named `named`; that transaction and the merge leave
 * the explorer, and `drop` makes what then spends the merge's inputs. The
 * plan is read past the grace and three times more (twice more after a
 * pending payer confirms), a replan taken wherever one is offered (none
 * is), and the case ends with the come-back check (`expectNoSecondPayment`):
 * every transaction the explorer was ever given comes back unless one it
 * holds spends an input of it, so the merge and the named transaction come
 * back only where nothing spent the merge's inputs, and whatever can then
 * confirm does.
 */
describe('a merge the payment spends from, never shown confirmed, dropped: the known limit', () => {
  it('its outspends never answered, twenty reads in one tick request each path at most once, the merge outspends among them', async () => {
    const { t, merge } = await completedOnPendingMerge()
    world.explorer.removeTx(t)
    world.explorer.removeTx(merge.txid)
    await pastGrace()
    for (let read = 0; read < 3; read++) await laterRead()
    expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
    vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
    const from = world.explorer.requests.length
    for (let read = 0; read < 20; read++) await world.plan()
    await world.settle()
    const counts = new Map<string, number>()
    for (const { path } of world.explorer.requests.slice(from)) {
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    for (const [path, count] of counts) expect([path, count]).toEqual([path, 1])
    // The explorer does not hold the merge: its outspends read fails, once.
    expect(counts.get(`/tx/${merge.txid}/outspends`)).toBe(1)
    expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
    expectNoSecondPayment()
  })

  it.each(DROPPED_MERGE_PLANS.map(plan => [plan.name, plan] as const))(
    '%s, what it names and the merge gone: while the merge output is undecided, the plan writes nothing and holds what a completed plan holds, the payment inputs',
    async (_plan, plan) => {
      const { named, merge } = await plan.setUp()
      expect(await world.planHeld()).toEqual(paymentInputKeys())
      const put = vi.spyOn(qbitSendPlanStore, 'put')
      world.explorer.removeTx(named)
      world.explorer.removeTx(merge.txid)
      await pastGrace()
      for (let read = 0; read < 3; read++) await laterRead()
      expect(put).not.toHaveBeenCalled()
      expect(await world.planHeld()).toEqual(paymentInputKeys())
      expect(stored()).toMatchObject({ phase: 'completed' })
      expectNoSecondPayment()
    }
  )

  it.each(
    DROPPED_MERGE_PLANS.flatMap(plan =>
      MERGE_DROPS.map(drop => [plan.name, drop.name, plan, drop] as const)
    )
  )(
    '%s; the merge %s: what it names gone, it stays completed naming that, with dismiss, never a replan or a cancel, and the recipient is paid once',
    async (_plan, _drop, plan, drop) => {
      const { named, fee, merge } = await plan.setUp()
      world.explorer.removeTx(named)
      world.explorer.removeTx(merge.txid)
      const later = drop.apply(merge)
      const views: QbitSendPlanView[] = []
      const replans: boolean[] = []
      const look = async (view: QbitSendPlanView): Promise<void> => {
        views.push(view)
        replans.push(await replanIfOffered(view))
      }
      await look(await pastGrace())
      for (let read = 0; read < 3; read++) await look(await laterRead())
      if (later !== undefined) {
        world.mine([later])
        for (let read = 0; read < 2; read++) await look(await laterRead())
      }
      expectNoSecondPayment()
      expect(replans).toEqual(replans.map(() => false))
      for (const view of views) {
        expectShows(view, { txid: named, fee, status: 'broadcast' })
        expect(view.actions).toEqual(['dismiss'])
      }
    }
  )
})

describe('the payment found confirmed is the payment for good', () => {
  it('a late answer pending from a prepare, after a tick found the payment P confirmed, leaves P confirmed', async () => {
    const { p } = await paymentWithoutVerdict(
      nodeRejection('mempool min fee not met'),
      'payment_fee_too_low'
    )
    // Another node relays P. The prepare's lookup reads P unconfirmed, and
    // its read of P itself, which confirms P is held, is answered late.
    explorerShowsPayment(p)
    const held = holdNext(`/tx/${p}`)
    const preparing = world.prepare({
      target: { kind: 'amount', amount: AMOUNT },
      feeRate: 2,
      revise: { planId: stored().id, kind: 'raise_payment_fee' },
    })
    await held.arrived(preparing)
    // Meanwhile P confirms, and a tick finds it so.
    world.mine([p])
    await world.tick()
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    held.release()
    await expect(preparing).rejects.toThrow('does not offer this revision now')
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    const view = await settledView()
    expect(view).toMatchObject({ phase: 'completed', paymentTxid: p, actions: ['dismiss'] })
    expect(view.steps.at(-1)).toMatchObject({ txid: p, status: 'confirmed' })
    expectNoSecondPayment()
  })

  it('found confirmed by its lookup, the payment P2 keeps no earlier version, as when the completed plan watches it confirm', async () => {
    const { p: p1 } = await paymentWithoutVerdict(
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
    // P2 goes out without a verdict too; after a restart it is missed for
    // the whole grace and refused when sent again: paused, P2 and P1 both
    // versions that may still confirm.
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    expect(await world.wallet.startQbitSendPlan(raise.review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    world.explorer.failures.length = 0
    await world.restart()
    world.refuse.set(p2, nodeRejection('non-mandatory-script-verify-flag'))
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    world.refuse.delete(p2)
    await world.unlock()
    expect(stored()).toMatchObject({ phase: 'paused' })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p2, dispatch: 'unknown' })
    expect(stored().earlierPayments).toEqual([expect.objectContaining({ txid: p1 })])
    // Another node relayed P2, and it confirmed: the paused plan's lookup of
    // its payment finds it so.
    explorerShowsPayment(p2)
    world.mine([p2])
    await laterRead()
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p2, status: 'confirmed' })
    expect(stored().earlierPayments).toBeUndefined()
    expect(await settledView()).toMatchObject({ phase: 'completed', paymentTxid: p2 })
    expectNoSecondPayment()
  })
})

describe('item 4: one state for a plan whose own payment cannot go and whose T may', () => {
  it('one stale spend moves a plan paused beside T to completed naming T once; leaving that needs T missed for a whole new grace and every input read anew', async () => {
    const { t, mergeOutput } = await reopenedBesideT()
    const s = spendElsewhere(10_650, [otherInput(mergeOutput)])
    for (let read = 0; read < 2; read++) await laterRead()
    expectShows(await settledView(), { txid: t, fee: T_FEE, status: 'broadcast' })
    // The spend was stale: it is gone, and every input is unspent again.
    world.explorer.removeTx(s)
    for (let read = 0; read < 3; read++) {
      await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS / 4)
      await settledView()
      expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
    }
    // A whole grace past T's new name, read anew in full: paused beside T again.
    expect(await pastGrace()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      actions: ['continue'],
    })
    expect(lastPaidBy()).toEqual(remembered(t))
    world.assertRecipientGuarantees(undefined)
  })
})

describe('item 7: holds a reopening took', () => {
  it('are let go of when the store refuses the reopening write', async () => {
    const { t, merge } = await completedOnPendingMerge()
    const mergeInputs = merge.inputs.map(input => `${input.txid}:${input.vout}`)
    // T leaves the network while the merge stays pending, and nothing
    // spends an input of the payment: the plan reopens beside T.
    world.explorer.removeTx(t)
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    let refused = 0
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementation(async (record, readRevision) => {
      if (record.phase === 'paused' && refused === 0) {
        refused += 1
        throw new Error('storage refused the write')
      }
      return put(record, readRevision)
    })
    await laterRead()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    for (let read = 0; read < 4 && refused === 0; read++) await world.plan()
    expect(refused).toBe(1)
    expect(stored().phase).toBe('completed')
    expect(await world.planHeld()).toEqual(paymentInputKeys())
    // The next advance reopens, and holds what the paused plan needs.
    for (let read = 0; read < 2; read++) await laterRead()
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    expect(await world.planHeld()).toEqual(new Set([...mergeInputs, ...paymentInputKeys()]))
    world.assertRecipientGuarantees(undefined)
  })
})

describe('item 8: what the verifier found unpinned', () => {
  it('a merge found unable to confirm while sending (no input named) leaves what the plan remembers of T alone', async () => {
    const { t } = await reopenedBesideT()
    const engine = world.engine as unknown as {
      forgetPaymentVersions(planId: string, spent?: ReadonlySet<string>): Promise<void>
    }
    await engine.forgetPaymentVersions(stored().id)
    expect(lastPaidBy()).toEqual(remembered(t))
    expect((await settledView()).actions).toEqual(['continue'])
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * Every transaction the explorer was ever given and holds no longer is sent
 * again by whoever holds it, in the order first given, as far as it does not
 * conflict with what the explorer holds (`everHeld`).
 */
function everyoneComesBack(): void {
  const spent = new Set<string>()
  for (const tx of world.explorer.txs.values()) {
    for (const input of tx.inputs) spent.add(`${input.txid}:${input.vout}`)
  }
  for (const tx of [...(everHeld.get(world)?.values() ?? [])]) {
    const keys = tx.inputs.map(input => `${input.txid}:${input.vout}`)
    if (world.explorer.txs.has(tx.txid) || keys.length === 0) continue
    if (keys.some(key => spent.has(key))) continue
    world.explorer.addTx({ ...tx, inputs: [...tx.inputs], outputs: [...tx.outputs] })
    for (const key of keys) spent.add(key)
  }
}

/** An input of the payment that is none of `others`. */
function inputBesides(...others: { txid: string; vout: number }[]): { txid: string; vout: number } {
  return stored()
    .steps.at(-1)!
    .inputs.find(
      input => !others.some(other => other.txid === input.txid && other.vout === input.vout)
    )!
}

describe('R2-F1: T is dead only once what spends its input is found confirmed', () => {
  it('R2-A1, paused: beside T, its input spent by a transaction found only pending, nothing is offered but dismiss; that one evicted and T sent again, the recipient is paid once', async () => {
    const { t, mergeOutput } = await reopenedBesideT()
    const s = spendElsewhere(10_700, [mergeOutput])
    for (let read = 0; read < 3; read++) await laterRead()
    const view = await settledView()
    expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(view.actions).toEqual(['dismiss'])
    expect(await replanIfOffered(view)).toBe(false)
    world.explorer.removeTx(s)
    expect(payRecipient(9_990, [mergeOutput], T_FEE)).toBe(t)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(undefined)
  })

  it('R2-A1, completed: named by T, T evicted, its input spent by a transaction found only pending: nothing reopens; that one evicted and T sent again, the recipient is paid once', async () => {
    const { t, mergeOutput } = await completedWithT()
    world.explorer.removeTx(t)
    const s = spendElsewhere(10_701, [mergeOutput])
    const view = await pastGrace()
    expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(view.actions).toEqual(['dismiss'])
    expect(await replanIfOffered(view)).toBe(false)
    world.explorer.removeTx(s)
    expect(payRecipient(9_990, [mergeOutput], T_FEE)).toBe(t)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(undefined)
  })

  it('R2-A2: T, its own payment P, then T2 on two inputs, each evicted in turn, and what spends their inputs found only pending and evicted in turn: no step offers a replan or a cancel, and with all of it back the recipient is paid once', async () => {
    const { t, mergeOutput } = await completedWithT()
    const id = stored().id
    const offered: string[][] = []
    /** The plan read past a grace; the user replans wherever that is offered. */
    const settled = async (): Promise<void> => {
      const view = await pastGrace()
      offered.push(view.actions)
      expect(await replanIfOffered(view)).toBe(false)
    }
    // T evicted, every input unspent: paused beside T, and the user continues.
    world.explorer.removeTx(t)
    await settled()
    await world.wallet.continueQbitSendPlan(id, world.shownTerms(id))
    await world.settle()
    await laterRead()
    const p = stored().steps.at(-1)!.txid
    expect(world.explorer.accepted.some(accepted => accepted.txid === p)).toBe(true)
    // P evicted; T2 spends T's input and another, B.
    const b = otherInput(mergeOutput)
    const x = inputBesides(mergeOutput, b)
    world.explorer.removeTx(p)
    const t2 = payRecipient(10_710, [mergeOutput, b], T2_FEE)
    await settled()
    // T2 evicted; X spent by S1, then B by S2, both only pending.
    world.explorer.removeTx(t2)
    const s1 = spendElsewhere(10_711, [x])
    await settled()
    const s2 = spendElsewhere(10_712, [b])
    await settled()
    // Both evicted; X spent by S3, which goes; then T's input by S4, only
    // pending, which goes too.
    world.explorer.removeTx(s1)
    world.explorer.removeTx(s2)
    await settled()
    const s3 = spendElsewhere(10_713, [x])
    for (let read = 0; read < 3; read++) await laterRead()
    offered.push((await settledView()).actions)
    world.explorer.removeTx(s3)
    const s4 = spendElsewhere(10_714, [mergeOutput])
    await settled()
    world.explorer.removeTx(s4)
    await settled()
    expect(
      offered.filter(actions => actions.includes('replan') || actions.includes('cancel'))
    ).toEqual([])
    everyoneComesBack()
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toHaveLength(1)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('R2-A6: T on the output of its merge, the merge killed by a transaction found only pending: nothing reopens; that one evicted and the merge and T back, the recipient is paid once', async () => {
    const { t, merge } = await completedOnPendingMerge()
    const tCopy = copyOf(t)
    const mergeCopy = copyOf(merge.txid)
    const killer = mergeUndone(t, merge)
    const view = await pastGrace()
    expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(view.actions).toEqual(['dismiss'])
    expect(await replanIfOffered(view)).toBe(false)
    world.explorer.removeTx(killer)
    world.explorer.addTx(mergeCopy)
    world.explorer.addTx(tCopy)
    world.mine()
    await laterRead()
    expect(confirmedRecipientPayers()).toEqual([t])
    world.assertRecipientGuarantees(undefined)
  })
})

/** What a plan of 124 outputs pays: one merge of 106, and a payment of 19 more and the merge's output. */
const CHAIN_AMOUNT = 124_000_000

/**
 * A plan of `CHAIN_AMOUNT` from an account one transaction funds, so that
 * every advance reads what spends each input of the payment, whatever the
 * order of reads. Resolves to its merge and the payment's inputs that are
 * not the merge's output.
 */
async function startedFromOneFunding(): Promise<{
  merge: QbitSendPlanRecord['steps'][number]
  own: { txid: string; vout: number }[]
}> {
  world.explorer.addTx({
    txid: fakeTxid(10_719, 7),
    inputs: [{ txid: fakeTxid(10_719, 9_000_000), vout: 0 }],
    outputs: Array.from({ length: 150 }, () => ({
      address: account.address,
      script: account.p2mr.scriptPubKey,
      value: VALUE,
    })),
    height: 100,
  })
  await world.open()
  await world.startPlan({ target: { kind: 'amount', amount: CHAIN_AMOUNT } })
  const merge = stored().steps[0]!
  const own = stored()
    .steps.at(-1)!
    .inputs.filter(input => input.txid !== merge.txid)
  return { merge, own }
}

describe('R2-F5: what the verifier found unpinned in round 2', () => {
  it('N11: a paused plan that cannot name T again goes round no more on a spend of the input of T found only pending: it reads that spend again at a later advance', async () => {
    const { mergeOutput } = await reopenedBesideT()
    await rememberedAs(UNREADABLE)
    spendElsewhere(10_780, [mergeOutput])
    for (let read = 0; read < 2; read++) await laterRead()
    expect(await settledView()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: [],
    })
    expect(lastPaidBy()).toEqual(UNREADABLE)
    const get = vi.spyOn(qbitSendPlanStore, 'get')
    await laterRead()
    // A read advances the plan a few times, each reading it a few times
    // (some twenty in all); going round again on a spend that changed nothing
    // would read it some two thousand times.
    expect(get.mock.calls.length).toBeLessThan(100)
    expect(lastPaidBy()).toEqual(UNREADABLE)
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * Every transaction the explorer was ever given and holds no longer comes
 * back, those paying the recipient first, unless an input of it is taken by
 * one the explorer holds; then whatever can confirm does, conflicts settled
 * first come, first served. Resolves to the transactions paying the
 * recipient that confirmed, and those of them the wallet made; then the
 * explorer is left as it was, for the check after the test.
 */
function comeBackAndMine(): { confirmed: string[]; wallet: string[] } {
  const explorer = world.explorer
  const before = new Map([...explorer.txs.values()].map(tx => [tx.txid, tx.height]))
  const tip = explorer.tipHeight
  const held = everHeld.get(world) ?? new Map<string, HeldTransaction>()
  const key = (input: { txid: string; vout: number }): string => `${input.txid}:${input.vout}`
  const pays = (tx: HeldTransaction): boolean =>
    tx.outputs.some(output => output.script === RECIPIENT_SCRIPT)
  const taken = new Set<string>()
  for (const tx of explorer.txs.values()) for (const input of tx.inputs) taken.add(key(input))
  const order = [...held.values()].sort((a, b) => Number(pays(b)) - Number(pays(a)))
  for (let pass = 0; pass < 4; pass++) {
    for (const tx of order) {
      if (explorer.txs.has(tx.txid) || tx.inputs.length === 0) continue
      if (tx.inputs.some(input => taken.has(key(input)) || !explorer.txs.has(input.txid))) continue
      explorer.addTx({ ...tx, inputs: [...tx.inputs], outputs: [...tx.outputs] })
      for (const input of tx.inputs) taken.add(key(input))
    }
  }
  const spent = new Set<string>()
  for (const tx of explorer.txs.values()) {
    if (tx.height !== undefined) for (const input of tx.inputs) spent.add(key(input))
  }
  const height = ++explorer.tipHeight
  for (let pass = 0; pass < 6; pass++) {
    for (const tx of explorer.txs.values()) {
      if (tx.height !== undefined) continue
      if (tx.inputs.some(input => spent.has(key(input)))) continue
      if (tx.inputs.some(input => explorer.txs.get(input.txid)?.height === undefined)) continue
      tx.height = height
      for (const input of tx.inputs) spent.add(key(input))
    }
  }
  const walletMade = new Set(explorer.accepted.map(accepted => accepted.txid))
  const confirmed = [...explorer.txs.values()]
    .filter(tx => tx.height !== undefined && pays(tx))
    .map(tx => tx.txid)
  for (const tx of [...explorer.txs.values()]) {
    if (!before.has(tx.txid)) {
      explorer.removeTx(tx.txid)
      continue
    }
    const was = before.get(tx.txid)
    if (was === undefined) delete tx.height
    else tx.height = was
  }
  explorer.tipHeight = tip
  return { confirmed, wallet: confirmed.filter(txid => walletMade.has(txid)) }
}

/** With everything back and mined, no payment the wallet made confirms beside another paying the recipient. */
function expectNoSecondPayment(): void {
  const { confirmed, wallet } = comeBackAndMine()
  expect({ confirmed, wallet: wallet.length > 0 && confirmed.length > 1 }).toEqual({
    confirmed,
    wallet: false,
  })
}

describe('the rule: a replan or a cancel only once every input is spent by a confirmed transaction', () => {
  it.each([
    ['unspent', 'the input T spends'],
    ['unspent', 'an input T does not spend'],
    ['spent by a transaction only pending', 'the input T spends'],
    ['spent by a transaction only pending', 'an input T does not spend'],
  ] as const)(
    'one input %s (%s), every other spent by a confirmed transaction: dismiss alone, for graces on end; once it is spent by a confirmed transaction too, a replan and a cancel',
    async (state, which) => {
      const { t, mergeOutput } = await completedWithT()
      const last = which === 'the input T spends' ? mergeOutput : otherInput(mergeOutput)
      world.explorer.removeTx(t)
      confirmedSpendOfTheRest(10_950, last)
      const pending = state === 'unspent' ? undefined : spendElsewhere(10_951, [last])
      for (let round = 0; round < 3; round++) {
        const view = await pastGrace()
        expectShows(view, { txid: t, fee: T_FEE, status: 'broadcast' })
        expect(view.actions).toEqual(['dismiss'])
        expect(await replanIfOffered(view)).toBe(false)
      }
      world.mine([pending ?? spendElsewhere(10_952, [last])])
      const released = await pastGrace()
      expect(released).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
      expect(released.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
      expect(lastPaidBy()).toBeUndefined()
      expect(await replanIfOffered(released)).toBe(true)
      expectNoSecondPayment()
    }
  )

  it('named by its own payment, sent by a Continue beside T and then evicted, an input spent elsewhere: the plan is named by T again, remembered, and lets it go only once every input is spent by a confirmed transaction', async () => {
    const { t, p } = await continuedBesideT()
    expect(lastPaidBy()).toEqual(remembered(t))
    world.explorer.removeTx(p)
    const inputs = stored().steps.at(-1)!.inputs
    const first = spendElsewhere(10_960, [inputs[1]!])
    const renamed = await pastGrace()
    expectShows(renamed, { txid: t, fee: T_FEE, status: 'broadcast' })
    expect(renamed.actions).toEqual(['dismiss'])
    expect(lastPaidBy()).toEqual(remembered(t))
    world.mine([first])
    confirmedSpendOfTheRest(10_961, inputs[1]!)
    const released = await pastGrace()
    expect(released).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    // Offered, not taken: the harness counts its own payment, which can no
    // longer confirm, among the wallet's broadcasts.
    expect(released.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expect(lastPaidBy()).toBeUndefined()
    expectNoSecondPayment()
  })
})

describe('the fourth verification: what the per-payer rules let through, under the one rule', () => {
  it('H1: seventeen payers in turn on inputs of their own, the first sent again and named, the first sixteen inputs spent by confirmed transactions: no replan while the seventeenth input is unspent', async () => {
    const { merge, own } = await startedFromOneFunding()
    const payer = (index: number): string =>
      payRecipient(15_000 + index, [own[index]!], T_FEE, CHAIN_AMOUNT)
    let named = payer(0)
    world.mine([merge.txid])
    await world.tick()
    for (let index = 1; index <= 16; index++) {
      world.explorer.removeTx(named)
      named = payer(index)
      await pastGrace()
    }
    world.explorer.removeTx(named)
    const first = payer(0)
    expect((await pastGrace()).paymentTxid).toBe(first)
    world.explorer.removeTx(first)
    world.mine(own.slice(0, 16).map((input, index) => spendElsewhere(15_100 + index, [input])))
    const view = await pastGrace()
    expect(view).toMatchObject({ phase: 'completed', actions: ['dismiss'] })
    expect(await replanIfOffered(view)).toBe(false)
    expectNoSecondPayment()
  })

  it('C1: N on T input and B, first seen on T input alone, found again through B, undone by a confirmed spend of B', async () => {
    const { t, mergeOutput } = await completedWithT()
    const b = otherInput(mergeOutput)
    world.explorer.removeTx(t)
    const unreadB = refuseWhile(`/tx/${b.txid}/outspends`)
    const n = payRecipient(10_840, [mergeOutput, b], T2_FEE)
    await pastGrace()
    unreadB.stop()
    world.explorer.removeTx(n)
    await pastGrace()
    const unreadA = refuseWhile(`/tx/${mergeOutput.txid}/outspends`)
    payRecipient(10_840, [mergeOutput, b], T2_FEE)
    for (let read = 0; read < 3; read++) await laterRead()
    unreadA.stop()
    world.explorer.removeTx(n)
    world.mine([spendElsewhere(10_841, [b])])
    const view = await pastGrace()
    expect(await replanIfOffered(view)).toBe(false)
    expectNoSecondPayment()
  })

  it('C2: seventeen payers on inputs of their own, the first sixteen inputs spent by confirmed transactions, an eighteenth named and undone', async () => {
    const { merge, own } = await startedFromOneFunding()
    const payer = (index: number): string =>
      payRecipient(10_850 + index, [own[index]!], T_FEE, CHAIN_AMOUNT)
    let named = payer(0)
    world.mine([merge.txid])
    await world.tick()
    for (let index = 1; index <= 16; index++) {
      world.explorer.removeTx(named)
      named = payer(index)
      await pastGrace()
    }
    world.mine(own.slice(0, 16).map((input, index) => spendElsewhere(10_870 + index, [input])))
    world.explorer.removeTx(named)
    named = payer(17)
    await pastGrace()
    world.explorer.removeTx(named)
    world.mine([spendElsewhere(10_890, [own[17]!])])
    const view = await pastGrace()
    expect(await replanIfOffered(view)).toBe(false)
    expectNoSecondPayment()
  })

  it.each(['version', 'own payment'] as const)(
    'C3, its %s: named by T, then by a %s found pending, which is evicted; an input spent elsewhere',
    async which => {
      const made =
        which === 'version'
          ? await completedWithTOverEarlierVersion()
          : await completedWithAnother().then(({ p, t }) => ({ t, p1: p, spent: undefined }))
      const t = made.t
      const pending = made.p1
      const tCopy = copyOf(t)
      await rememberedAs(undefined)
      world.explorer.removeTx(t)
      const inputs = stored().steps.at(-1)!.inputs
      world.explorer.addTx({
        txid: pending,
        inputs: inputs.map(input => ({ txid: input.txid, vout: input.vout })),
        outputs: [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }],
      })
      await pastGrace()
      world.explorer.removeTx(pending)
      const s = spendElsewhere(10_920, [
        made.spent ? otherInput(made.spent) : stored().steps.at(-1)!.inputs[0]!,
      ])
      const view = await pastGrace()
      expect(view).toMatchObject({ phase: 'completed', actions: ['dismiss'] })
      expect(await replanIfOffered(view)).toBe(false)
      world.explorer.removeTx(s)
      world.explorer.addTx(tCopy)
      expectNoSecondPayment()
    }
  )

  it('B2: a plan completed with T before it was remembered, then T2 and T3 named, an input spent by a confirmed transaction: dismiss alone, never a replan', async () => {
    const { t, mergeOutput } = await completedWithT()
    await rememberedAs(undefined)
    const b = otherInput(mergeOutput)
    const offered: string[] = []
    world.explorer.removeTx(t)
    const t2 = payRecipient(13_950, [b], T2_FEE)
    offered.push(...(await pastGrace()).actions)
    world.explorer.removeTx(t2)
    const t3 = payRecipient(13_951, [inputBesides(mergeOutput, b)], T2_FEE + 1)
    offered.push(...(await pastGrace()).actions)
    world.explorer.removeTx(t3)
    world.mine([spendElsewhere(13_952, [b])])
    const view = await pastGrace()
    offered.push(...view.actions)
    expect(offered.filter(action => action === 'replan' || action === 'cancel')).toEqual([])
    expect(await replanIfOffered(view)).toBe(false)
    expectNoSecondPayment()
  })

  it('B4: N on two inputs, seen on one; N undone by a confirmed spend of the other: completed with dismiss by design, never a replan while an input is not spent by a confirmed transaction', async () => {
    world.fund(150, VALUE)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const merge = stored().steps[0]!
    const mergeOutput = { txid: merge.txid, vout: 0 }
    const b = otherInput(mergeOutput)
    const unreadB = refuseWhile(`/tx/${b.txid}/outspends`)
    const n = payRecipient(13_900, [mergeOutput, b], T_FEE)
    world.mine([merge.txid])
    await world.tick()
    for (let read = 0; read < 3; read++) await laterRead()
    unreadB.stop()
    expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: n } })
    world.explorer.removeTx(n)
    world.mine([spendElsewhere(13_901, [b])])
    for (let round = 0; round < 6; round++) {
      const view = await pastGrace()
      expect(view).toMatchObject({ phase: 'completed', paymentTxid: n, actions: ['dismiss'] })
    }
    expectNoSecondPayment()
  })
})

type Letter = 'A' | 'B' | 'C'
const SPECS: Record<string, Letter[]> = {
  A: ['A'],
  "A'": ['A'],
  AB: ['A', 'B'],
  B: ['B'],
  ABC: ['A', 'B', 'C'],
  BC: ['B', 'C'],
}
/**
 * Chains of three payers after T on A, every pattern of what two payers
 * share in turn: equal (A, A'), nested (A in AB in ABC, B in BC),
 * overlapping (AB and BC) and disjoint (A and B, A and BC).
 */
const CHAINS: [string, string, string][] = [
  ["A'", 'AB', 'ABC'],
  ['ABC', 'AB', "A'"],
  ['B', 'BC', 'A'],
  ['AB', 'BC', 'B'],
  ["A'", 'B', 'BC'],
  ['BC', "A'", 'AB'],
  ['ABC', 'B', "A'"],
  ['AB', "A'", 'BC'],
]
const ENDS: { name: string; confirmed: Letter[]; pending: Letter[] }[] = [
  { name: 'B confirmed', confirmed: ['B'], pending: [] },
  { name: 'A confirmed', confirmed: ['A'], pending: [] },
  { name: 'C confirmed, A pending', confirmed: ['C'], pending: ['A'] },
]

describe('the fourth verification battery, a part of it: three payers in turn, then spends, a replan wherever offered, and everything back', () => {
  for (const variant of ['plain', 'each first seen on part of its inputs', 'no entry'] as const) {
    for (const chain of CHAINS) {
      for (const end of ENDS) {
        it(`${variant}: ${chain.join(' > ')} | ${end.name}`, async () => {
          const { t, mergeOutput } = await completedWithT()
          if (variant === 'no entry') await rememberedAs(undefined)
          const b = otherInput(mergeOutput)
          const c = inputBesides(mergeOutput, b)
          const of = (letter: Letter): { txid: string; vout: number } =>
            letter === 'A' ? mergeOutput : letter === 'B' ? b : c
          let current = t
          let seed = 14_000
          for (const name of chain) {
            const on = SPECS[name]!
            world.explorer.removeTx(current)
            const unread =
              variant === 'each first seen on part of its inputs' && on.length > 1
                ? refuseWhile(`/tx/${of(on.at(-1)!).txid}/outspends`)
                : undefined
            current = payRecipient(seed++, on.map(of), T_FEE + seed)
            const view = await pastGrace()
            unread?.stop()
            expect(await replanIfOffered(view)).toBe(false)
          }
          world.explorer.removeTx(current)
          const pendings = end.pending.map(letter => spendElsewhere(seed++, [of(letter)]))
          world.mine(end.confirmed.map(letter => spendElsewhere(seed++, [of(letter)])))
          const view = await pastGrace()
          expect(await replanIfOffered(view)).toBe(false)
          for (const pending of pendings) world.explorer.removeTx(pending)
          expectNoSecondPayment()
        })
      }
    }
  }
})

describe('a plan whose own payment its merge leaves void or refused, after a transaction made elsewhere paid', () => {
  /**
   * A plan whose merge M1 is slow, its fee raised (M2 replaces M1), both
   * left in the network. Resolves to M1, its copy and M2.
   */
  async function raisedMerge(): Promise<{
    m1: string
    m1Copy: Parameters<typeof world.explorer.addTx>[0]
    m2: string
  }> {
    world.fund(150, VALUE)
    await world.open()
    world.explorer.acceptReplacements = true
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const m1 = stored().steps[0]!.txid
    const m1Copy = copyOf(m1)
    await world.plan()
    await world.tick(QBIT_SEND_PLAN_SLOW_MERGE_MS + 60_000)
    const slow = (await world.plan())!
    const raise = await world.prepare({
      target: { kind: 'amount', amount: AMOUNT },
      feeRate: 2,
      revise: { planId: slow.id, kind: 'raise_merge_fee' },
    })
    if (!raise.ok) throw new Error(`raise refused: ${raise.reason}`)
    expect(await world.wallet.startQbitSendPlan(raise.review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    for (let read = 0; read < 3; read++) await laterRead()
    const m2 = stored().steps[0]!.txid
    expect(stored().steps[0]!.replaces?.txid).toBe(m1)
    // The earlier version is still in the network beside its replacement.
    world.explorer.addTx(m1Copy)
    return { m1, m1Copy, m2 }
  }

  /** Every broadcast refused for its fee, not for its inputs. */
  function refusedForTheFee(): void {
    world.explorer.failures.push(request =>
      isBroadcast(request) ? nodeRejection('mempool min fee not met') : undefined
    )
  }

  it('R5-A7: a raised merge whose earlier version confirms instead, after a reopening beside T: completed naming T again, with dismiss, never a replan or a cancel', async () => {
    const { m1, m2 } = await raisedMerge()
    // T on the replacement's output, while it is pending.
    const t = payRecipient(16_500, [{ txid: m2, vout: 0 }], T_FEE)
    for (let read = 0; read < 3; read++) await laterRead()
    expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
    world.explorer.removeTx(t)
    const offered = [...(await pastGrace()).actions]
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    // The earlier version confirms instead of the replacement: the payment
    // is void.
    const put = vi.spyOn(qbitSendPlanStore, 'put')
    world.explorer.removeTx(m2)
    world.mine([m1])
    let view = await pastGrace()
    expect(put.mock.calls.some(([record]) => record.pause?.reason === 'merge_refused')).toBe(true)
    offered.push(...view.actions)
    for (let round = 0; round < 3; round++) {
      view = await pastGrace()
      offered.push(...view.actions)
    }
    expect(view).toMatchObject({ phase: 'completed', paymentTxid: t, actions: ['dismiss'] })
    expect(offered.filter(action => action === 'replan' || action === 'cancel')).toEqual([])
    expect(lastPaidBy()).toEqual(remembered(t))
    expectNoSecondPayment()
  })

  it('a merge sent again after a Continue beside T and refused for its fee, not its inputs: completed naming T again, with dismiss, never a replan or a cancel', async () => {
    const { t, merge } = await completedOnPendingMerge()
    world.explorer.removeTx(t)
    const offered = [...(await pastGrace()).actions]
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    // The merge leaves the network; sent again, it is refused for its fee.
    world.explorer.removeTx(merge.txid)
    refusedForTheFee()
    const id = stored().id
    const put = vi.spyOn(qbitSendPlanStore, 'put')
    await world.wallet.continueQbitSendPlan(id, world.shownTerms(id))
    await world.settle()
    let view = await pastGrace()
    expect(put.mock.calls.some(([record]) => record.pause?.reason === 'merge_refused')).toBe(true)
    offered.push(...view.actions)
    for (let round = 0; round < 3; round++) {
      view = await pastGrace()
      offered.push(...view.actions)
    }
    expect(view).toMatchObject({ phase: 'completed', paymentTxid: t, actions: ['dismiss'] })
    expect(offered.filter(action => action === 'replan' || action === 'cancel')).toEqual([])
    expect(lastPaidBy()).toEqual(remembered(t))
    world.explorer.failures.length = 0
    expectNoSecondPayment()
  })

  it('with an entry it cannot read, a merge refused for its fee after a Continue names nothing and offers nothing, and stays so once that merge is killed by a confirmed spend and every other input is spent by a confirmed transaction: the known limit, never a replan or a cancel', async () => {
    const { t, merge } = await completedOnPendingMerge()
    world.explorer.removeTx(t)
    await pastGrace()
    await rememberedAs(UNREADABLE)
    world.explorer.removeTx(merge.txid)
    refusedForTheFee()
    const id = stored().id
    await world.wallet.continueQbitSendPlan(id, world.shownTerms(id))
    await world.settle()
    for (let round = 0; round < 2; round++) await pastGrace()
    expect(await settledView()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'merge_refused' },
      actions: [],
    })
    expect(lastPaidBy()).toEqual(UNREADABLE)
    world.explorer.failures.length = 0
    // The merge killed by a confirmed spend of its input, and every other
    // input of the payment spent by a confirmed transaction. The merge's
    // output is not read so while the explorer does not hold the merge: the
    // plan keeps what it remembers, and offers nothing.
    world.mine([spendElsewhere(16_510, [merge.inputs[0]!])])
    confirmedSpendOfTheRest(16_511, { txid: merge.txid, vout: 0 })
    const replans: boolean[] = []
    const offered: string[] = []
    // Long enough for a read of what spends the merge's 106 inputs, 8 a
    // tick, to come round to the spend of its first input, were it made.
    for (let read = 0; read < 20; read++) {
      const view = await laterRead()
      offered.push(...view.actions)
      replans.push(await replanIfOffered(view))
    }
    expectNoSecondPayment()
    expect(replans).toEqual(replans.map(() => false))
    expect(offered.filter(action => action === 'replan' || action === 'cancel')).toEqual([])
    expect(await settledView()).toMatchObject({ phase: 'paused', actions: [] })
    expect(lastPaidBy()).toEqual(UNREADABLE)
  })

  it('without one, a raised merge whose earlier version confirms instead offers a replan and a cancel, as at the base', async () => {
    const { m1, m2 } = await raisedMerge()
    world.explorer.removeTx(m2)
    world.mine([m1])
    for (let read = 0; read < 3; read++) await laterRead()
    const view = await settledView()
    expect(view).toMatchObject({ phase: 'paused', pause: { reason: 'merge_refused' } })
    expect(view.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expect(lastPaidBy()).toBeUndefined()
  })

  it('without one, a merge refused for its fee, not its inputs, offers a replan and a cancel, as at the base', async () => {
    world.fund(150, VALUE)
    await world.open()
    refusedForTheFee()
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    for (let read = 0; read < 3; read++) await laterRead()
    const view = await settledView()
    expect(view).toMatchObject({ phase: 'paused', pause: { reason: 'merge_refused' } })
    expect(view.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    world.explorer.failures.length = 0
  })
})

describe('a revision prepared beside a transaction made elsewhere that pays the recipient', () => {
  /**
   * A plan completed with its own payment P, P evicted and its second input
   * spent elsewhere: reopened `outputs_spent`, with a replan and a cancel.
   * Then X, made elsewhere, pays the recipient from its first input, which
   * a prepare reads first. Resolves to X and the plan's id.
   */
  async function replanOfferedBesideX(): Promise<{ x: string; id: string }> {
    const { p } = await completedWithOwnPayment()
    const inputs = stored().steps.at(-1)!.inputs
    world.explorer.removeTx(p)
    spendElsewhere(16_600, [inputs[1]!])
    const reopened = await pastGrace()
    expect(reopened).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(reopened.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    const x = payRecipient(16_601, [inputs[0]!], T_FEE)
    // Other outputs for a replan to pay from.
    world.fund(1, 400_000_000)
    return { x, id: reopened.id }
  }

  function prepareReplan(id: string): ReturnType<typeof world.prepare> {
    return world.prepare({
      target: { kind: 'amount', amount: AMOUNT },
      revise: { planId: id, kind: 'replan' },
    })
  }

  it.each([
    ['X looked up and missed', (x: string) => missWhile(x)],
    ['X looked up without an answer', (x: string) => refuseWhile(`/tx/${x}/status`)],
    ['X read without an answer', (x: string) => refuseWhile(`/tx/${x}`)],
  ] as const)(
    'a second prepare in the same tick, after %s, asks afresh: X is found, the plan completes with it, and neither review can start',
    async (_label, fail) => {
      const { x, id } = await replanOfferedBesideX()
      // The first prepare cannot tell what X is: as at the base, it reviews
      // the replan.
      const failing = fail(x)
      const first = await prepareReplan(id)
      expect(first.ok).toBe(true)
      failing.stop()
      // The second, within the same tick, asks afresh.
      await expect(prepareReplan(id)).rejects.toThrow('does not offer this revision now')
      expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: x } })
      if (first.ok) {
        expect(await world.wallet.startQbitSendPlan(first.review.draftId)).toMatchObject({
          ok: false,
        })
      }
      expectNoSecondPayment()
    }
  )
})

describe('the check that the recipient is paid at most once', () => {
  it('cannot check one paying the recipient given without what it spends, unless it is a version of a stored plan payment, which spends what that payment spends', async () => {
    const { mergeOutput } = await completedWithT()
    const payment = stored().steps.at(-1)!
    const paying = [{ address: RECIPIENT, script: RECIPIENT_SCRIPT, value: AMOUNT }]
    world.explorer.addTx({ txid: payment.txid, inputs: [], outputs: paying })
    // Given with what it spends, then again without (an index that lags):
    // it keeps what it was first given.
    const known = fakeTxid(10_911, 5)
    world.explorer.addTx({ txid: known, inputs: [mergeOutput], outputs: paying })
    world.explorer.addTx({ txid: known, inputs: [], outputs: paying })
    const unknown = world.explorer.addTx({ txid: fakeTxid(10_910, 5), inputs: [], outputs: paying })
    expect(possibleSecondPayments(world)).toEqual({ together: [], unknown: [unknown.txid] })
    expect(() => assertRecipientPaidAtMostOnce(world)).toThrow()
    // Forgotten, so that the check after this test passes.
    everHeld.get(world)!.delete(unknown.txid)
    world.explorer.removeTx(unknown.txid)
  })
})

/**
 * P1, without a verdict, refused for its fee; its raise P2 refused outright;
 * then T, spending one input of the payment and paying the recipient, found
 * pending: the plan completes with T, P2 its payment and P1 an earlier one.
 */
async function completedWithTOverEarlierVersion(): Promise<{
  p1: string
  t: string
  spent: { txid: string; vout: number }
}> {
  const { p: p1 } = await paymentWithoutVerdict(
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
  const spent = stored().steps.at(-1)!.inputs[0]!
  const t = payRecipient(10_620, [spent], T_FEE)
  for (let read = 0; read < 3 && stored().phase !== 'completed'; read++) await laterRead()
  expect(stored()).toMatchObject({ phase: 'completed', paidBy: { txid: t } })
  expect(stored().earlierPayments).toEqual([expect.objectContaining({ txid: p1 })])
  expect(lastPaidBy()).toEqual(remembered(t))
  return { p1, t, spent }
}

/**
 * From now on the explorer contradicts itself: it shows X spending each
 * input of the stored payment that P spends as it holds them (`inPlaceOfP`),
 * or every input, whatever spends it (`every`), and serves X as a
 * transaction paying someone else, found `status`, that spends only
 * `listed` (none by default), its inputs written as `writeInput` writes
 * them. P, the payment, it does not find at all, whatever is asked of it.
 * What it holds stays as it was, the truth, which it tells again once
 * `stop` is called.
 */
function lieThatXSpendsThePayment(
  p: string,
  {
    inputs = 'inPlaceOfP',
    status = 'confirmed',
    listed = [],
    writeInput = input => input,
  }: {
    inputs?: 'inPlaceOfP' | 'every'
    status?: 'confirmed' | 'pending'
    listed?: readonly { txid: string; vout: number }[]
    writeInput?: (input: Record<string, unknown>) => Record<string, unknown>
  } = {}
): { x: string; stop: () => void } {
  const x = fakeTxid(10_950, 3)
  const explorer = world.explorer
  const payment = paymentInputKeys()
  const json = (body: unknown): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify(body),
  })
  const served = () =>
    explorer.esploraTx({
      txid: x,
      inputs: listed.map(input => ({ txid: input.txid, vout: input.vout })),
      outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: 500_000 }],
      coinbase: false,
      fee: 1_000,
      order: 0,
      ...(status === 'confirmed' ? { height: explorer.tipHeight } : {}),
    })
  let lying = true
  explorer.failures.push(({ method, path }) => {
    if (!lying || method !== 'GET') return undefined
    if (path === `/tx/${p}` || path.startsWith(`/tx/${p}/`)) {
      return { status: 404, body: 'Transaction not found' }
    }
    if (path === `/tx/${x}`) {
      const tx = served()
      return json({ ...tx, vin: tx.vin.map(input => writeInput({ ...input })) })
    }
    if (path === `/tx/${x}/status`) return json(served().status)
    const parent = /^\/tx\/([0-9a-f]{64})\/outspends$/.exec(path)?.[1]
    const tx = parent === undefined ? undefined : explorer.txs.get(parent)
    if (!tx) return undefined
    return json(
      tx.outputs.map((_, vout) => {
        const spender = explorer.spenderOf(tx.txid, vout)
        if (spender?.txid === p || (inputs === 'every' && payment.has(`${tx.txid}:${vout}`))) {
          return { spent: true, txid: x, vin: 0 }
        }
        return spender ? { spent: true, txid: spender.txid, vin: 0 } : { spent: false }
      })
    )
  })
  return {
    x,
    stop: (): void => {
      lying = false
    },
  }
}

/**
 * Until `stop`, the explorer serves transaction `txid`, which it holds,
 * without its inputs; everything else, what spends what included, it
 * answers as it holds it.
 */
function servedWithoutInputs(txid: string): { stop: () => void } {
  let lying = true
  world.explorer.failures.push(({ method, path }) => {
    if (!lying || method !== 'GET' || path !== `/tx/${txid}`) return undefined
    const tx = world.explorer.esploraTx(world.explorer.txs.get(txid)!)
    return { status: 200, body: JSON.stringify({ ...tx, vin: [] }) }
  })
  return {
    stop: (): void => {
      lying = false
    },
  }
}

describe('a spender the explorer names that does not spend what it is named for tells nothing', () => {
  it.each(['confirmed', 'pending'] as const)(
    'completed with P: P hidden and X, %s, named for its inputs, listing none, it stays completed naming P, and P is paid once',
    async status => {
      const { p, pFee } = await completedWithOwnPayment()
      const lie = lieThatXSpendsThePayment(p, { status })
      const view = await pastGrace()
      expectShows(view, { txid: p, fee: pFee, status: 'broadcast' })
      expect(view.actions).toEqual(['dismiss'])
      for (let read = 0; read < 3; read++) expect((await laterRead()).actions).toEqual(['dismiss'])
      expect(stored().steps.at(-1)).toMatchObject({ txid: p, dispatch: 'unknown' })
      // The explorer tells the truth again: P is found, pending, and confirms.
      lie.stop()
      expectShows(await laterRead(), { txid: p, fee: pFee, status: 'broadcast' })
      expectNoSecondPayment()
      world.assertRecipientGuarantees(AMOUNT)
    }
  )

  it('completed with P: X listing only one of the inputs it is named for counts for none of them', async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const first = stored().steps.at(-1)!.inputs[0]!
    const lie = lieThatXSpendsThePayment(p, { listed: [first] })
    const view = await pastGrace()
    expectShows(view, { txid: p, fee: pFee, status: 'broadcast' })
    expect(view.actions).toEqual(['dismiss'])
    lie.stop()
    expectNoSecondPayment()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it("completed with P: X whose read gives an input's output index as text is no answer", async () => {
    const { p, pFee } = await completedWithOwnPayment()
    const lie = lieThatXSpendsThePayment(p, {
      listed: stored().steps.at(-1)!.inputs,
      writeInput: input => ({ ...input, vout: String(input['vout']) }),
    })
    const view = await pastGrace()
    expectShows(view, { txid: p, fee: pFee, status: 'broadcast' })
    expect(view.actions).toEqual(['dismiss'])
    lie.stop()
    expectNoSecondPayment()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('completed with P, P replaced by X paying someone else: X is identified though the explorer writes the txids of its inputs in upper case', async () => {
    const { p } = await completedWithOwnPayment()
    world.explorer.removeTx(p)
    const x = spendElsewhere(10_951, [stored().steps.at(-1)!.inputs[0]!])
    world.explorer.failures.push(({ method, path }) => {
      if (method !== 'GET' || path !== `/tx/${x}`) return undefined
      const tx = world.explorer.esploraTx(world.explorer.txs.get(x)!)
      const vin = tx.vin.map(input => ({ ...input, txid: input.txid.toUpperCase() }))
      return { status: 200, body: JSON.stringify({ ...tx, vin }) }
    })
    const view = await pastGrace()
    expect(view).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(view.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expectNoSecondPayment()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('a payment refused for missing inputs while the explorer relayed it: the plan does not pause outputs_spent, and sends P again once the explorer tells the truth', async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const p = plan.paymentTxid
    const lie = lieThatXSpendsThePayment(p)
    let refusing = true
    world.explorer.failures.push(request =>
      refusing && isBroadcast(request)
        ? { ...nodeRejection('bad-txns-inputs-missingorspent'), afterAccepting: true }
        : undefined
    )
    world.mine()
    await world.tick()
    for (let read = 0; read < 3; read++) {
      const view = await laterRead()
      expect(view.phase).toBe('waiting')
      expect(view.actions).toEqual(['cancel'])
    }
    expect(world.explorer.accepted.map(accepted => accepted.txid)).toContain(p)
    lie.stop()
    refusing = false
    const pushed = world.pushed.length
    await laterRead()
    // Sent again, once, and taken: the explorer already held it, so it is
    // no new acceptance.
    expect(world.pushed.slice(pushed)).toEqual([p])
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'broadcast' })
    expectNoSecondPayment()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('a paused plan whose payment may confirm keeps it, and offers no replan', async () => {
    const { p } = await paymentWithoutVerdict(
      nodeRejection('mempool min fee not met'),
      'payment_fee_too_low'
    )
    const lie = lieThatXSpendsThePayment(p, { inputs: 'every' })
    for (let read = 0; read < 4; read++) {
      const view = await laterRead()
      expect(view).toMatchObject({
        phase: 'paused',
        pause: { reason: 'payment_fee_too_low' },
        paymentMayConfirm: true,
      })
      expect(view.actions).not.toContain('replan')
    }
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, dispatch: 'unknown' })
    // P, which went out without a verdict, is in the network.
    lie.stop()
    explorerShowsPayment(p)
    expectNoSecondPayment()
    world.assertRecipientGuarantees(undefined)
  })

  it("a raise's prepare does not pause the plan outputs_spent, and the raise is prepared", async () => {
    const { p } = await paymentWithoutVerdict(
      nodeRejection('mempool min fee not met'),
      'payment_fee_too_low'
    )
    const lie = lieThatXSpendsThePayment(p, { inputs: 'every' })
    const raise = await world.prepare({
      target: { kind: 'amount', amount: AMOUNT },
      feeRate: 2,
      revise: { planId: stored().id, kind: 'raise_payment_fee' },
    })
    expect(raise.ok).toBe(true)
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'payment_fee_too_low' } })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, dispatch: 'unknown' })
    lie.stop()
    explorerShowsPayment(p)
    expectNoSecondPayment()
    world.assertRecipientGuarantees(undefined)
  })

  it("a waiting plan does not pause outputs_spent for X named for its merge's output, and pays once its merge confirms", async () => {
    world.fund(150, VALUE)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const p = plan.paymentTxid
    expect(stored().phase).toBe('waiting')
    const lie = lieThatXSpendsThePayment(p, { inputs: 'every' })
    for (let read = 0; read < 3; read++) {
      const view = await laterRead()
      expect(view.phase).toBe('waiting')
      expect(view.actions).toEqual(['cancel'])
    }
    lie.stop()
    world.mine()
    await laterRead()
    expect(stored()).toMatchObject({ phase: 'completed' })
    expect(stored().steps.at(-1)).toMatchObject({ txid: p, status: 'broadcast' })
    expectNoSecondPayment()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('a waiting plan whose merge output T spends, T read without that input: T is read again each tick, and once read with it, the plan completes with T', async () => {
    world.fund(150, VALUE)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const merge = stored().steps[0]!
    const t = payRecipient(10_952, [{ txid: merge.txid, vout: 0 }], T_FEE)
    const lie = servedWithoutInputs(t)
    const from = world.explorer.requests.length
    for (let read = 0; read < 3; read++) {
      const view = await laterRead()
      expect(view.phase).toBe('waiting')
      expect(view.actions).toEqual(['cancel'])
    }
    const reads = world.explorer.requests.slice(from).filter(request => request.path === `/tx/${t}`)
    lie.stop()
    await laterRead()
    expect(stored()).toMatchObject({
      phase: 'completed',
      paidBy: { txid: t, amount: AMOUNT, fee: T_FEE },
    })
    expect(stored().steps[0]).toMatchObject({ status: 'broadcast' })
    // Read again a tick later, as a read without an answer is, and no sooner.
    expect(reads).toHaveLength(3)
    expectNoSecondPayment()
    world.assertRecipientGuarantees(undefined)
  })

  it('a raise prepared in the tick in which X was read without the input it spends reads X again at once: read with it, X counts, and the plan pauses outputs_spent', async () => {
    await paymentWithoutVerdict(nodeRejection('mempool min fee not met'), 'payment_fee_too_low')
    const x = spendElsewhere(10_953, [stored().steps.at(-1)!.inputs[0]!])
    const lie = servedWithoutInputs(x)
    for (let read = 0; read < 2; read++) {
      expect(await laterRead()).toMatchObject({
        phase: 'paused',
        pause: { reason: 'payment_fee_too_low' },
        paymentMayConfirm: true,
      })
    }
    expect(world.explorer.requests.some(request => request.path === `/tx/${x}`)).toBe(true)
    lie.stop()
    // The user's request, in the same tick, reads X again at once.
    await expect(
      world.prepare({
        target: { kind: 'amount', amount: AMOUNT },
        feeRate: 2,
        revise: { planId: stored().id, kind: 'raise_payment_fee' },
      })
    ).rejects.toThrow('does not offer this revision now')
    expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'outputs_spent' } })
    expect(stored().steps.at(-1)!.dispatch).toBeUndefined()
    const view = await settledView()
    expect(view.paymentMayConfirm).toBeUndefined()
    expect(view.actions).toEqual(expect.arrayContaining(['replan', 'cancel']))
    expectNoSecondPayment()
    world.assertRecipientGuarantees(undefined)
  })
})

/**
 * `count` confirmed outputs paying the account, `value` bits each, two to a
 * transaction, so that half of them are its output 1.
 */
function fundInPairs(count: number, value: number): void {
  for (let index = 0; index < count / 2; index++) {
    world.explorer.addTx({
      txid: fakeTxid(11_000 + index, 7),
      inputs: [{ txid: fakeTxid(11_000 + index, 9_000_000), vout: 0 }],
      outputs: [0, 1].map(() => ({
        address: account.address,
        script: account.p2mr.scriptPubKey,
        value,
      })),
      height: 100 + index,
    })
  }
}

/**
 * Until `stop`, the explorer answers for what spends the outputs of `txid`
 * with an entry for its output 0 alone, as a lagging or faulty one may.
 */
function outspendsCutShort(txid: string): { stop: () => void } {
  let cutting = true
  world.explorer.failures.push(({ method, path }) => {
    if (!cutting || method !== 'GET' || path !== `/tx/${txid}/outspends`) return undefined
    const spender = world.explorer.spenderOf(txid, 0)
    const entry = spender ? { spent: true, txid: spender.txid, vin: 0 } : { spent: false }
    return { status: 200, body: JSON.stringify([entry]) }
  })
  return {
    stop: (): void => {
      cutting = false
    },
  }
}

describe('an outspends answer with no entry for the output a payment input spends', () => {
  it.each([
    ['nothing else spends an input', false],
    ['X spends another input, paying someone else', true],
  ] as const)(
    'completed with P, P replaced by T paying the recipient from that output, %s: the input is undecided and the plan stays as it is, then names T once the answer is whole',
    async (_, elsewhere) => {
      fundInPairs(150, VALUE)
      await world.open()
      const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
      world.mine()
      await world.tick()
      const p = plan.paymentTxid
      expect(stored()).toMatchObject({ phase: 'completed' })
      const pFee = stored().steps.at(-1)!.fee
      const inputs = stored().steps.at(-1)!.inputs
      const hidden = inputs.find(input => input.vout === 1)!
      expect(hidden).toBeDefined()
      world.explorer.removeTx(p)
      const t = payRecipient(10_970, [hidden], T_FEE)
      if (elsewhere) spendElsewhere(10_971, [inputs.find(input => input.txid !== hidden.txid)!])
      const cut = outspendsCutShort(hidden.txid)
      const view = await pastGrace()
      expectShows(view, { txid: p, fee: pFee, status: 'broadcast' })
      expect(view.actions).toEqual(['dismiss'])
      for (let read = 0; read < 3; read++) expect((await laterRead()).actions).toEqual(['dismiss'])
      cut.stop()
      expectShows(await laterRead(), { txid: t, fee: T_FEE, status: 'broadcast' })
      expect(stored().paidBy).toEqual({ txid: t, amount: AMOUNT, fee: T_FEE })
      expectNoSecondPayment()
      world.assertRecipientGuarantees(AMOUNT)
    }
  )
})

/**
 * Until `stop`, the explorer serves transaction `txid`, which it holds, with
 * `fee` as its fee, or with none when `fee` is undefined.
 */
function servedWithFee(txid: string, fee: unknown): { stop: () => void } {
  let serving = true
  world.explorer.failures.push(({ method, path }) => {
    if (!serving || method !== 'GET' || path !== `/tx/${txid}`) return undefined
    const tx: Record<string, unknown> = world.explorer.esploraTx(world.explorer.txs.get(txid)!)
    if (fee === undefined) delete tx['fee']
    else tx['fee'] = fee
    return { status: 200, body: JSON.stringify(tx) }
  })
  return {
    stop: (): void => {
      serving = false
    },
  }
}

describe('a spender paying the recipient with a fee the store refuses', () => {
  it.each([
    ['null', null],
    ['a fraction', 1.5],
    ['negative', -1],
    ['missing', undefined],
  ] as const)(
    'a waiting plan whose merge output T spends, T served with its fee %s: no advance fails, and the plan completes with T once T is served with a fee the store takes',
    async (_, fee) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
      world.fund(150, VALUE)
      await world.open()
      await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
      const merge = stored().steps[0]!
      const t = payRecipient(10_972, [{ txid: merge.txid, vout: 0 }], T_FEE)
      const served = servedWithFee(t, fee)
      for (let read = 0; read < 3; read++) {
        const view = await laterRead()
        expect(view.phase).toBe('waiting')
        expect(view.actions).toEqual(['cancel'])
      }
      const failed = (): unknown[][] =>
        warn.mock.calls.filter(call => String(call[0]).includes('advance failed'))
      expect(failed()).toEqual([])
      served.stop()
      await laterRead()
      expect(stored()).toMatchObject({
        phase: 'completed',
        paidBy: { txid: t, amount: AMOUNT, fee: T_FEE },
      })
      expect(failed()).toEqual([])
      expectNoSecondPayment()
      world.assertRecipientGuarantees(undefined)
    }
  )
})
