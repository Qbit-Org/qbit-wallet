import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createP2mrPsbt, decodePsbt, hexToBytes, p2mrAddressFromPubkey } from '@qbit-oss/protocol'
import {
  BUS_EVENTS,
  BUS_METHODS,
  QBIT_SEND_PLAN_NOT_AS_SHOWN_CODE,
  type QbitSendPlanView,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { getUiControllerMethod } from '../src/controllers/ui-access'
import { preferenceService } from '../src/services'
import { QBIT_SEND_PLAN_VIEW_REVISION_STRIDE } from '../src/services/qbitSendPlanEngine'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
import {
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
} from '../src/utils/qbit-send-plan-psbt'
import { qbitSendPlanTermsDigest } from '../src/utils/qbit-send-plan-terms'
import { bgEventBus } from '../src/utils/eventBus'
import {
  CHAIN,
  FakePlanKeyring,
  PAYER,
  RECIPIENT,
  RECIPIENT_SCRIPT,
  T0,
  World,
  account,
  newPlanGuard,
  scriptOf,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// Continue approves the plan the page shows, never only the one stored
// (#206, item 1). The plan store is plain extension storage: a record
// replaced on disk under the plan's id, at any revision, is what the
// background holds after its next start. A page opened before that may
// still show the plan as it was. Continue carries the terms digest of the
// view it shows, and the background refuses it, before anything is
// authorised, written, held or signed, unless the plan stored then states
// exactly those terms; the page then reads the plan again and shows what is
// stored, and a Continue of that view goes on.

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
/** Another P2MR address on the plan's network, and its script. */
const OTHER = p2mrAddressFromPubkey(hexToBytes('55'.repeat(32)), 'regtest')
const OTHER_SCRIPT = scriptOf('55'.repeat(32))

interface StoredInput {
  txid: string
  vout: number
  satoshis: number
}

interface StoredStep {
  kind: 'merge' | 'payment'
  txid: string
  unsignedPsbtHex: string
  inputs: StoredInput[]
  vsize: number
  fee: number
  feeRate: number
  status: string
}

interface StoredPlan {
  id: string
  recipient: string
  amount: number
  change: number
  feeRate: number
  totalFee: number
  paidFee?: number
  revision: number
  steps: StoredStep[]
  [key: string]: unknown
}

function storedDocument(): { version: number; plans: StoredPlan[] } {
  return JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
}

function writeDocument(document: { version: number; plans: StoredPlan[] }): void {
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
}

function paymentOf(plan: StoredPlan): StoredStep {
  return plan.steps[plan.steps.length - 1]!
}

/**
 * The payment `step` built again as the engine builds it, over the same
 * inputs and sequence, with its outputs changed by `outputs`: what someone
 * who can write extension storage can put there. Returns its PSBT and id.
 */
function rebuiltPayment(
  step: StoredStep,
  outputs: (current: { value: number; script: string }[]) => { value: number; script: string }[]
): { unsignedPsbtHex: string; txid: string } {
  const keys = qbitSendPlanAccountKeys(account.p2mr.pubkey)
  const summary = decodePsbt(qbitSendPlanPsbtFromHex(step.unsignedPsbtHex))
  const changed = outputs(
    summary.outputs.map(output => ({
      value: Number(output.value),
      script: Buffer.from(output.scriptPubKey).toString('hex'),
    }))
  )
  const psbt = createP2mrPsbt({
    inputs: step.inputs.map((input, index) => ({
      prevout: { txid: hexToBytes(input.txid).reverse(), vout: input.vout },
      sequence: summary.inputs[index]!.sequence,
      witnessUtxo: { value: BigInt(input.satoshis), scriptPubKey: keys.scriptPubKey },
      leafScript: keys.leafScript,
      controlBlock: keys.controlBlock,
      merkleRoot: keys.leafHash,
    })),
    outputs: changed.map(output => ({
      value: BigInt(output.value),
      scriptPubKey: hexToBytes(output.script),
    })),
  })
  return { unsignedPsbtHex: qbitSendPlanPsbtHex(psbt), txid: FakePlanKeyring.txidOf(psbt) }
}

/** The stored plan pays `OTHER` instead, the same amount, with the same change and fee. */
function paysAnotherRecipient(plan: StoredPlan): void {
  const payment = paymentOf(plan)
  Object.assign(
    payment,
    rebuiltPayment(payment, outputs =>
      outputs.map(output =>
        output.script === RECIPIENT_SCRIPT ? { ...output, script: OTHER_SCRIPT } : output
      )
    )
  )
  plan.recipient = OTHER
}

/** The stored plan pays the recipient `more` bits more, out of its change; nothing else differs. */
function paysAnotherAmount(plan: StoredPlan, more: number): void {
  const payment = paymentOf(plan)
  const accountScript = account.p2mr.scriptPubKey
  Object.assign(
    payment,
    rebuiltPayment(payment, outputs =>
      outputs.map(output =>
        output.script === RECIPIENT_SCRIPT
          ? { ...output, value: output.value + more }
          : output.script === accountScript
            ? { ...output, value: output.value - more }
            : output
      )
    )
  )
  plan.amount += more
  plan.change -= more
}

/**
 * A plan of one merge and a payment for `amount`, started and stopped by a
 * lock before its first signature finished: nothing of it is signed.
 */
async function planStoppedBeforeSigning(amount = AMOUNT): Promise<string> {
  const review = await world.review({ target: { kind: 'amount', amount } })
  expect(review.merges).toHaveLength(1)
  world.keyring.beforeInput = (_txid, index) => {
    if (index === 3) void world.wallet.lockWallet()
  }
  const started = await world.wallet.startQbitSendPlan(review.draftId)
  expect(started.ok).toBe(true)
  await world.settle()
  world.keyring.beforeInput = undefined
  expect(world.storedStatuses()).toEqual(['planned', 'planned'])
  expect(world.keyring.signed).toEqual([])
  return (started as { plan: { id: string } }).plan.id
}

/**
 * A restart, an unlock, and what a page shows of plan `planId` then: paused
 * by the restart, Continue offered. The page keeps this view until it reads
 * the plan again.
 */
async function shownAfterRestart(planId: string): Promise<QbitSendPlanView> {
  await world.restart()
  await world.unlock()
  const view = (await world.plan())!
  expect(view).toMatchObject({ id: planId, phase: 'paused', pause: { reason: 'interrupted' } })
  expect(view.actions).toContain('continue')
  return view
}

/**
 * Someone who can write extension storage replaces the stored plan with
 * `change` applied, stored at `revision`, and the background starts again;
 * the wallet is unlocked again. The page still shows what it showed.
 */
async function replacedOnDiskThenRestarted(
  change: (plan: StoredPlan) => void,
  revision: number
): Promise<void> {
  const document = storedDocument()
  const plan = document.plans[0]!
  change(plan)
  plan.revision = revision
  writeDocument(document)
  await world.restart()
  await world.unlock()
}

/** The record revision a view was made from. */
function recordRevisionOf(view: QbitSendPlanView): number {
  return Math.floor(view.revision / QBIT_SEND_PLAN_VIEW_REVISION_STRIDE)
}

/** What the engine keeps of plan `planId` in this session that a continue sets. */
function sessionOf(planId: string): { authorised: boolean; approvalDue: boolean } | undefined {
  const sessions = (
    world.engine as unknown as {
      sessions: Map<string, { authorised: boolean; approvalDue: boolean }>
    }
  ).sessions
  return sessions.get(planId)
}

interface Snapshot {
  signed: number
  counter: number
  pushed: number
  document: string | undefined
  held: Set<string>
}

async function snapshot(): Promise<Snapshot> {
  return {
    signed: world.keyring.signed.length,
    counter: world.keyring.counter,
    pushed: world.pushed.length,
    document: world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY),
    held: await world.planHeld(),
  }
}

/**
 * Nothing was authorised, written, held or signed for plan `planId` since
 * `before`: no signature, no signature batch, no broadcast, the stored
 * document as it was, the same outputs held, and no authorisation to sign
 * or figures to approve left in the session.
 */
async function expectNothingDone(planId: string, before: Snapshot): Promise<void> {
  expect(world.keyring.signed).toHaveLength(before.signed)
  expect(world.keyring.counter).toBe(before.counter)
  expect(world.keyring.batches.size).toBe(0)
  expect(world.pushed).toHaveLength(before.pushed)
  expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(before.document)
  expect(await world.planHeld()).toEqual(before.held)
  expect(sessionOf(planId)?.authorised ?? false).toBe(false)
  expect(sessionOf(planId)?.approvalDue ?? false).toBe(false)
}

/** The refusal of a continue whose terms are not the stored plan's. */
const NOT_AS_SHOWN = { code: QBIT_SEND_PLAN_NOT_AS_SHOWN_CODE }

/** Blocks are mined until plan `planId` completes. */
async function completes(planId: string): Promise<QbitSendPlanView> {
  for (let block = 0; block < 4 && (await world.plan())?.phase !== 'completed'; block++) {
    world.mine()
    await world.tick()
  }
  const view = (await world.plan())!
  expect(view).toMatchObject({ id: planId, phase: 'completed' })
  return view
}

/** Every output the explorer ever accepted that pays `script`. */
function paidTo(script: string): { txid: string; value: number }[] {
  return world.explorer.accepted.flatMap(accepted =>
    accepted.outputs
      .filter(output => output.script === script)
      .map(output => ({ txid: accepted.txid, value: output.value }))
  )
}

/**
 * The refused continue, as a page holding `shown` makes it, and what
 * follows: nothing done, nothing done later either, and the plan read again
 * is the record stored, which a continue of that view goes on with.
 */
async function refusedThenContinuedAsStored(
  planId: string,
  shown: QbitSendPlanView
): Promise<QbitSendPlanView> {
  const before = await snapshot()
  const advances = vi.spyOn(world.engine, 'advance')
  await expect(world.wallet.continueQbitSendPlan(planId, shown.termsDigest!)).rejects.toMatchObject(
    NOT_AS_SHOWN
  )
  await world.settle()
  await expectNothingDone(planId, before)
  // Refused as it arrived: nothing of the plan was set in motion either.
  expect(advances).not.toHaveBeenCalled()
  advances.mockRestore()

  // Time passes: nothing signs by itself either.
  await world.tick()
  expect(world.keyring.signed).toHaveLength(before.signed)
  expect(world.pushed).toHaveLength(before.pushed)
  expect(sessionOf(planId)?.authorised ?? false).toBe(false)

  // The page reads the plan again: what is stored, from this run.
  const current = (await world.plan())!
  expect(current).toMatchObject({ id: planId, phase: 'paused', pause: { reason: 'interrupted' } })
  expect(current.actions).toContain('continue')
  expect(current.backgroundId).toEqual(expect.any(String))
  expect(current.backgroundId).not.toBe(shown.backgroundId)
  expect(current.termsDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(current.termsDigest).not.toBe(shown.termsDigest)

  // The user sees the stored figures and continues: that goes on.
  const continued = await world.wallet.continueQbitSendPlan(planId, current.termsDigest!)
  expect(continued).toMatchObject({ id: planId, phase: 'signing' })
  expect(sessionOf(planId)?.authorised).toBe(true)
  await world.settle()
  expect(world.keyring.signed.length).toBeGreaterThan(before.signed)
  return current
}

describe('a continue names the plan the page shows', () => {
  beforeEach(async () => {
    world.fund(150, 100_000)
    await world.open()
  })

  it('refuses the plan shown once the store holds another recipient at a lower revision after a restart, and goes on with what is stored once it is shown', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)
    expect(shown).toMatchObject({ recipient: RECIPIENT, amount: AMOUNT })
    expect(recordRevisionOf(shown)).toBeGreaterThan(2)

    await replacedOnDiskThenRestarted(paysAnotherRecipient, 1)
    const stored = qbitSendPlanStore.get(planId)!
    expect(stored).toMatchObject({ recipient: OTHER, amount: AMOUNT })
    // The background's view of it is older by revision than the one shown.
    expect(stored.revision * QBIT_SEND_PLAN_VIEW_REVISION_STRIDE).toBeLessThan(shown.revision)

    const current = await refusedThenContinuedAsStored(planId, shown)
    expect(current).toMatchObject({ recipient: OTHER, amount: AMOUNT })
    expect(current.revision).toBeLessThan(shown.revision)

    await completes(planId)
    // The user's continue of the stored figures paid what they stated, once.
    expect(paidTo(OTHER_SCRIPT)).toEqual([
      { txid: qbitSendPlanStore.get(planId)!.steps[1]!.txid, value: AMOUNT },
    ])
    world.assertRecipientGuarantees(undefined)
  })

  it('refuses the plan shown when the store holds another recipient at the very revision shown', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)

    // Stored one below, the restart's first write brings it to the
    // revision the page shows: a revision alone cannot tell them apart.
    await replacedOnDiskThenRestarted(paysAnotherRecipient, recordRevisionOf(shown) - 1)
    expect(qbitSendPlanStore.get(planId)).toMatchObject({
      recipient: OTHER,
      revision: recordRevisionOf(shown),
    })

    const current = await refusedThenContinuedAsStored(planId, shown)
    expect(current).toMatchObject({ recipient: OTHER, amount: AMOUNT })
    await completes(planId)
    expect(paidTo(OTHER_SCRIPT)).toHaveLength(1)
    world.assertRecipientGuarantees(undefined)
  })

  it('refuses the plan shown when only the amount stored differs', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)
    const more = 5_000

    await replacedOnDiskThenRestarted(
      plan => paysAnotherAmount(plan, more),
      recordRevisionOf(shown) - 1
    )
    const stored = qbitSendPlanStore.get(planId)!
    expect(stored).toMatchObject({
      recipient: RECIPIENT,
      amount: AMOUNT + more,
      feeRate: shown.feeRate,
      totalFee: shown.totalFee,
    })

    const current = await refusedThenContinuedAsStored(planId, shown)
    expect(current).toMatchObject({
      recipient: RECIPIENT,
      amount: AMOUNT + more,
      feeRate: shown.feeRate,
      totalFee: shown.totalFee,
    })
    // Continued as shown now: the user confirmed this payment.
    world.reviewed.set(stored.steps[1]!.txid, AMOUNT + more)
    await completes(planId)
    world.assertRecipientGuarantees(AMOUNT + more)
  })

  it('refuses the plan shown when only the total fee stored differs', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)

    // Fees an earlier version of the plan paid: a figure the screen shows
    // in the total fee and nothing checks, every transaction as it was.
    await replacedOnDiskThenRestarted(
      plan => {
        plan.paidFee = 250_000
      },
      recordRevisionOf(shown) - 1
    )

    const current = await refusedThenContinuedAsStored(planId, shown)
    expect(current).toMatchObject({
      recipient: RECIPIENT,
      amount: AMOUNT,
      feeRate: shown.feeRate,
      totalFee: shown.totalFee + 250_000,
      paymentTxid: shown.paymentTxid,
    })
    expect(current.steps.map(step => step.txid)).toEqual(shown.steps.map(step => step.txid))
    await completes(planId)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('refuses the plan shown when only the fee rate stored differs, every transaction the same', async () => {
    // An amount whose change would be 1,000 bits, below dust: the planner
    // folds it into the payment's fee, which then also covers that payment
    // at a slightly higher rate.
    const probe = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    const amount = AMOUNT + probe.change - 1_000
    const folded = await world.review({ target: { kind: 'amount', amount } })
    expect(folded).toMatchObject({ amount, change: 0, feeRate: 1 })
    const planId = await planStoppedBeforeSigning(amount)
    const shown = await shownAfterRestart(planId)
    const payment = qbitSendPlanStore.get(planId)!.steps[1]!
    const rate = Math.floor((payment.fee / payment.vsize) * 10_000) / 10_000
    expect(rate).toBeGreaterThan(1)

    await replacedOnDiskThenRestarted(
      plan => {
        plan.feeRate = rate
        paymentOf(plan).feeRate = rate
      },
      recordRevisionOf(shown) - 1
    )
    expect(qbitSendPlanStore.get(planId)).toMatchObject({ feeRate: rate, amount, change: 0 })

    const current = await refusedThenContinuedAsStored(planId, shown)
    expect(current).toMatchObject({
      recipient: RECIPIENT,
      amount,
      feeRate: rate,
      totalFee: shown.totalFee,
      paymentTxid: shown.paymentTxid,
    })
    expect(current.steps).toEqual(shown.steps)
    await completes(planId)
    world.assertRecipientGuarantees(amount)
  })

  it('checks the terms again in the write that resumes the plan, once another write changed them', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)
    // Another write lands while the continue's own is under way: the total
    // fee stored changes, and Continue is still offered.
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    const puts = vi
      .spyOn(qbitSendPlanStore, 'put')
      .mockImplementationOnce(async (record, revision) => {
        const current = qbitSendPlanStore.get(planId)!
        await put({ ...current, paidFee: 250_000 }, current.revision)
        return put(record, revision)
      })
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length

    await expect(
      world.wallet.continueQbitSendPlan(planId, shown.termsDigest!)
    ).rejects.toMatchObject(NOT_AS_SHOWN)
    puts.mockRestore()
    await world.settle()
    expect(qbitSendPlanStore.get(planId)).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      paidFee: 250_000,
    })
    expect(sessionOf(planId)?.authorised ?? false).toBe(false)
    expect(sessionOf(planId)?.approvalDue ?? false).toBe(false)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.keyring.batches.size).toBe(0)
    expect(world.pushed).toHaveLength(pushed)

    const current = (await world.plan())!
    expect(current.totalFee).toBe(shown.totalFee + 250_000)
    await world.wallet.continueQbitSendPlan(planId, current.termsDigest!)
    await world.settle()
    await completes(planId)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('goes on with the view shown before a restart when the plan stored is the same', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)

    await world.restart()
    await world.unlock()
    const current = (await world.plan())!
    expect(current.backgroundId).not.toBe(shown.backgroundId)
    expect(current.termsDigest).toBe(shown.termsDigest)

    await world.wallet.continueQbitSendPlan(planId, shown.termsDigest!)
    await world.settle()
    await completes(planId)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('goes on with an earlier view of the same plan within one run: progress is not a term', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)
    // The view moves on since: a lock takes Continue off, an unlock puts it
    // back.
    await world.wallet.lockWallet()
    expect((await world.plan())!.actions).not.toContain('continue')
    await world.unlock()
    const later = (await world.plan())!
    expect(later.revision).toBeGreaterThan(shown.revision)
    expect(later.termsDigest).toBe(shown.termsDigest)

    await world.wallet.continueQbitSendPlan(planId, shown.termsDigest!)
    await world.settle()
    await completes(planId)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('what a continue carries, as the UI port delivers it', () => {
  beforeEach(async () => {
    world.fund(150, 100_000)
    await world.open()
  })

  /** A page's call of `continueQbitSendPlan` with `params`, through the UI port's JSON. */
  async function continueOverThePort(params: unknown[]): Promise<unknown> {
    const method = getUiControllerMethod(world.wallet, 'continueQbitSendPlan')
    return method(...(JSON.parse(JSON.stringify(params)) as unknown[]))
  }

  it('refuses every value but the digest of the plan shown, before anything is done, then goes on with it', async () => {
    const planId = await planStoppedBeforeSigning()
    const shown = await shownAfterRestart(planId)
    const digest = shown.termsDigest!
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    const before = await snapshot()

    const malformed: [string, unknown[]][] = [
      ['missing', [planId]],
      ['undefined, which arrives as null', [planId, undefined]],
      ['null', [planId, null]],
      ['NaN, which arrives as null', [planId, Number.NaN]],
      ['Infinity, which arrives as null', [planId, Number.POSITIVE_INFINITY]],
      ['a float', [planId, 1.5]],
      ['a negative number', [planId, -1]],
      ['zero', [planId, 0]],
      ['a number beyond the safe range', [planId, Number.MAX_SAFE_INTEGER + 2]],
      ['the view revision', [planId, shown.revision]],
      ['a number as a string', [planId, String(shown.revision)]],
      ['an empty string', [planId, '']],
      ['an object', [planId, { termsDigest: digest }]],
      ['a list', [planId, [digest]]],
      ['a boolean', [planId, true]],
      ['one character short', [planId, digest.slice(1)]],
      ['one character long', [planId, `${digest}0`]],
      ['upper case', [planId, digest.toUpperCase()]],
      ['outside hex', [planId, `${digest.slice(0, 63)}g`]],
      ['padded', [planId, ` ${digest}`]],
    ]
    const advances = vi.spyOn(world.engine, 'advance')
    for (const [name, params] of malformed) {
      await expect(continueOverThePort(params), name).rejects.toThrow(/termsDigest/)
    }
    // Well formed, and not the plan's: refused as not shown.
    await expect(continueOverThePort([planId, '0'.repeat(64)])).rejects.toMatchObject(NOT_AS_SHOWN)
    await world.settle()
    await expectNothingDone(planId, before)
    expect(advances).not.toHaveBeenCalled()
    advances.mockRestore()

    await expect(continueOverThePort([planId, digest])).resolves.toMatchObject({
      id: planId,
      phase: 'signing',
    })
    await world.settle()
    await completes(planId)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('the view names the background that made it and the terms it states', () => {
  beforeEach(async () => {
    world.fund(150, 100_000)
    await world.open()
  })

  it('names a new run after each restart, and every change announced names the run', async () => {
    const planId = await planStoppedBeforeSigning()
    const first = (await world.plan())!
    expect(first.backgroundId).toMatch(/^[0-9a-f]{32}$/)
    expect(first.termsDigest).toMatch(/^[0-9a-f]{64}$/)

    vi.mocked(bgEventBus.emit).mockClear()
    await world.restart()
    await world.unlock()
    const second = (await world.plan())!
    expect(second.backgroundId).toMatch(/^[0-9a-f]{32}$/)
    expect(second.backgroundId).not.toBe(first.backgroundId)
    expect(second.termsDigest).toBe(first.termsDigest)

    const announced = vi
      .mocked(bgEventBus.emit)
      .mock.calls.filter(
        ([event, data]) =>
          event === BUS_EVENTS.broadcastToUI &&
          (data as { method?: string }).method === BUS_METHODS.QBIT_SEND_PLAN_CHANGED
      )
      .map(([, data]) => (data as { params: Record<string, unknown> }).params)
    expect(announced.length).toBeGreaterThan(0)
    for (const params of announced) {
      expect(params).toEqual({
        planId,
        revision: expect.any(Number),
        backgroundId: second.backgroundId,
      })
    }
    // The harness keeps recording what it always did.
    expect(world.events.at(-1)).toEqual({ planId, revision: expect.any(Number) })
    world.assertRecipientGuarantees(undefined)
  })

  it('states no terms for a plan that failed the checks of what its transactions are', async () => {
    const planId = await planStoppedBeforeSigning()
    const document = storedDocument()
    document.plans[0]!['phase'] = 'paused'
    document.plans[0]!['pause'] = { reason: 'unreadable', at: T0 }
    writeDocument(document)
    await world.restart()
    await world.unlock()
    const view = (await world.plan())!
    expect(view).toMatchObject({ id: planId, pause: { reason: 'unreadable' }, recipient: '' })
    expect(view.backgroundId).toMatch(/^[0-9a-f]{32}$/)
    expect(view.termsDigest).toBeUndefined()
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps the digest while the plan signs, waits and completes', async () => {
    const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started.ok).toBe(true)
    const first = (started as { plan: QbitSendPlanView }).plan
    await world.settle()
    const waiting = (await world.plan())!
    expect(waiting.phase).toBe('waiting')
    expect(waiting.termsDigest).toBe(first.termsDigest)
    // The digest is that of the figures the view itself states.
    expect(waiting.termsDigest).toBe(qbitSendPlanTermsDigest(waiting))
    world.mine()
    await world.tick()
    world.mine()
    await world.tick()
    const done = (await world.plan())!
    expect(done.phase).toBe('completed')
    expect(done.termsDigest).toBe(first.termsDigest)
    world.assertRecipientGuarantees(AMOUNT)
  })
})

describe('the terms digest', () => {
  const view: QbitSendPlanView = {
    id: 'ab'.repeat(16),
    chain: CHAIN,
    address: account.address,
    recipient: RECIPIENT,
    target: 'amount',
    amount: AMOUNT,
    change: 25_835,
    feeRate: 1,
    totalFee: 474_165,
    steps: [
      { kind: 'merge', txid: 'ef'.repeat(32), inputCount: 106, fee: 398_827, status: 'planned' },
      { kind: 'payment', txid: 'cd'.repeat(32), inputCount: 20, fee: 75_338, status: 'planned' },
    ],
    sent: false,
    phase: 'signing',
    actions: ['cancel'],
    signaturesDone: 0,
    signaturesTotal: 126,
    paymentTxid: 'cd'.repeat(32),
    createdAt: T0,
    updatedAt: T0,
    revision: 1_000_000,
  }
  const step = (index: number, change: Partial<QbitSendPlanView['steps'][number]>) => ({
    ...view,
    steps: view.steps.map((item, at) => (at === index ? { ...item, ...change } : item)),
  })

  it('changes with every term the view states', () => {
    const digests = [
      view,
      { ...view, id: '12'.repeat(16) },
      { ...view, chain: ChainType.QBIT_TESTNET4 },
      { ...view, address: PAYER },
      { ...view, recipient: OTHER },
      { ...view, target: 'everything' as const },
      { ...view, amount: AMOUNT + 1 },
      { ...view, change: 25_834 },
      { ...view, feeRate: 1.01 },
      { ...view, totalFee: 474_166 },
      { ...view, signaturesTotal: 127 },
      { ...view, paymentTxid: '12'.repeat(32) },
      { ...view, steps: view.steps.slice(1) },
      step(0, { kind: 'payment' }),
      step(0, { txid: '12'.repeat(32) }),
      step(0, { inputCount: 105 }),
      step(0, { fee: 398_828 }),
    ].map(qbitSendPlanTermsDigest)
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(digests).size).toBe(digests.length)
    world.assertRecipientGuarantees(undefined)
  })

  it('never changes with the plan’s progress', () => {
    const digest = qbitSendPlanTermsDigest(view)
    const progressed: QbitSendPlanView[] = [
      step(0, { status: 'broadcast' }),
      { ...view, phase: 'paused', pause: { reason: 'interrupted' }, actions: ['continue'] },
      { ...view, signing: { step: 0, signed: 50, total: 106 }, signaturesDone: 50 },
      { ...view, sent: true, paymentMayConfirm: true, slowMerge: true },
      { ...view, updatedAt: T0 + 1, revision: 2_000_003, backgroundId: '9'.repeat(32) },
    ]
    for (const each of progressed) expect(qbitSendPlanTermsDigest(each)).toBe(digest)
    world.assertRecipientGuarantees(undefined)
  })
})
