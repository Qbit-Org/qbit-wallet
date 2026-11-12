import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createP2mrPsbt, decodePsbt, hexToBytes } from '@qbit-oss/protocol'
import { QBIT_P2MR_DUST } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
import {
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
} from '../src/utils/qbit-send-plan-psbt'
import {
  CHAIN,
  FakePlanKeyring,
  T0,
  World,
  account,
  newPlanGuard,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A stored plan whose transactions pay more fee than the wallet's own
// pricing gives them (#188): the plan store is plain extension storage, so
// a record can be changed on disk, and a changed record must never get a
// transaction signed that the planner would not have priced so.

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
  outputValue?: number
  status: string
  signedPsbtHex?: string
}

interface StoredPlan {
  id: string
  amount: number
  change: number
  totalFee: number
  steps: StoredStep[]
  [key: string]: unknown
}

/**
 * `psbtHex` built again as the engine builds a step: the same inputs (each
 * the account's output, `inputs` giving their outpoints and values) and
 * sequence, and its outputs' scripts with the values `outputValues` gives.
 */
function rebuiltPsbt(
  psbtHex: string,
  inputs: readonly StoredInput[],
  outputValues: readonly number[]
): string {
  const keys = qbitSendPlanAccountKeys(account.p2mr.pubkey)
  const summary = decodePsbt(qbitSendPlanPsbtFromHex(psbtHex))
  const sequence = summary.inputs[0]!.sequence
  return qbitSendPlanPsbtHex(
    createP2mrPsbt({
      inputs: inputs.map(input => ({
        prevout: { txid: hexToBytes(input.txid).reverse(), vout: input.vout },
        sequence,
        witnessUtxo: { value: BigInt(input.satoshis), scriptPubKey: keys.scriptPubKey },
        leafScript: keys.leafScript,
        controlBlock: keys.controlBlock,
        merkleRoot: keys.leafHash,
      })),
      outputs: summary.outputs.map((output, index) => ({
        value: BigInt(outputValues[index] ?? Number(output.value)),
        scriptPubKey: output.scriptPubKey,
      })),
    })
  )
}

const txidOfHex = (psbtHex: string): string =>
  FakePlanKeyring.txidOf(qbitSendPlanPsbtFromHex(psbtHex))

function storedDocument(): { version: number; plans: StoredPlan[] } {
  return JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
}

function writeDocument(document: { version: number; plans: StoredPlan[] }): void {
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
}

/**
 * Change the stored plan on disk as someone who can write extension storage
 * could: its first merge pays only dust back and the rest of its inputs as
 * fee. The record keeps every rule but the price of its fees: the merge's
 * inputs are its output and its fee, the payment spends the merge's new
 * output, and to pay the same amount with the same change and fee the
 * payment claims its last direct input holds more by as much. Returns the
 * changed merge's txid and what it burns.
 */
function burnMergeOnDisk(): { mergeTxid: string; burned: number } {
  const document = storedDocument()
  const plan = document.plans[0]!
  const merge = plan.steps[0]!
  const payment = plan.steps[plan.steps.length - 1]!
  const burned = merge.outputValue! - QBIT_P2MR_DUST
  merge.unsignedPsbtHex = rebuiltPsbt(merge.unsignedPsbtHex, merge.inputs, [QBIT_P2MR_DUST])
  const oldMergeTxid = merge.txid
  merge.txid = txidOfHex(merge.unsignedPsbtHex)
  merge.outputValue = QBIT_P2MR_DUST
  merge.fee += burned
  plan.totalFee += burned
  payment.inputs = payment.inputs.map(input =>
    input.txid === oldMergeTxid ? { ...input, txid: merge.txid, satoshis: QBIT_P2MR_DUST } : input
  )
  const last = payment.inputs[payment.inputs.length - 1]!
  payment.inputs[payment.inputs.length - 1] = { ...last, satoshis: last.satoshis + burned }
  payment.unsignedPsbtHex = rebuiltPsbt(payment.unsignedPsbtHex, payment.inputs, [])
  payment.txid = txidOfHex(payment.unsignedPsbtHex)
  writeDocument(document)
  return { mergeTxid: merge.txid, burned }
}

/**
 * Change the stored plan's payment on disk: it returns `burned` less change
 * and pays that much more fee, the recipient, the amount and every merge as
 * they were. Returns the changed payment's txid.
 */
function burnChangeOnDisk(burned: number): string {
  const document = storedDocument()
  const plan = document.plans[0]!
  const payment = plan.steps[plan.steps.length - 1]!
  const outputs = decodePsbt(qbitSendPlanPsbtFromHex(payment.unsignedPsbtHex)).outputs
  const changeIndex = outputs.length - 1
  const values = outputs.map(output => Number(output.value))
  values[changeIndex] = plan.change - burned
  payment.unsignedPsbtHex = rebuiltPsbt(payment.unsignedPsbtHex, payment.inputs, values)
  payment.txid = txidOfHex(payment.unsignedPsbtHex)
  payment.fee += burned
  plan.change -= burned
  plan.totalFee += burned
  writeDocument(document)
  return payment.txid
}

/**
 * A plan of one merge and a payment with change, started and stopped by a
 * lock before its first signature finished: nothing of it is signed.
 */
async function planStoppedBeforeSigning(amount = 12_000_000): Promise<string> {
  world.fund(150, 100_000)
  await world.open()
  const review = await world.review({ target: { kind: 'amount', amount } })
  expect(review.merges).toHaveLength(1)
  expect(review.change).toBeGreaterThan(QBIT_P2MR_DUST)
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

/** After a restart and an unlock, the user presses Continue, and time passes. */
async function restartAndContinue(planId: string): Promise<void> {
  await world.restart()
  await world.unlock()
  await world.plan()
  await world.wallet.continueQbitSendPlan(planId).catch(() => undefined)
  await world.settle()
  world.mine()
  await world.tick()
  world.mine()
  await world.tick()
}

describe('a stored plan whose fees are not the wallet’s own', () => {
  it('signs and sends nothing of a merge whose fee was raised on disk, its output lowered to match', async () => {
    const planId = await planStoppedBeforeSigning()
    const { mergeTxid, burned } = burnMergeOnDisk()
    expect(burned).toBeGreaterThan(10_000_000)

    await restartAndContinue(planId)

    expect(world.pushed).not.toContain(mergeTxid)
    expect(world.keyring.signed).toEqual([])
    // Read as no plan the wallet made: shown unreadable, with only cancel.
    expect(await world.plan()).toMatchObject({
      id: planId,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
    await expect(world.wallet.cancelQbitSendPlan(planId)).resolves.toBeNull()
    expect(await world.plan()).toBeNull()
    expect((await world.planHeld()).size).toBe(0)
  })

  it('signs and sends nothing of a payment whose fee was raised on disk, its change lowered to match', async () => {
    const planId = await planStoppedBeforeSigning()
    const plan = qbitSendPlanStore.get(planId)!
    const burned = plan.change - QBIT_P2MR_DUST
    const paymentTxid = burnChangeOnDisk(burned)

    await restartAndContinue(planId)

    expect(world.pushed).not.toContain(paymentTxid)
    expect(world.keyring.signed).not.toContain(paymentTxid)
    expect(await world.plan()).toMatchObject({
      id: planId,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
  })

  it('reads a plan whose merge PSBT is not the transaction its record states as unreadable at once, holding nothing and signing nothing', async () => {
    const planId = await planStoppedBeforeSigning()
    // Only the PSBT changes: it pays the merge's output a million bits
    // less, which the record's figures do not say.
    const document = storedDocument()
    const merge = document.plans[0]!.steps[0]!
    merge.unsignedPsbtHex = rebuiltPsbt(merge.unsignedPsbtHex, merge.inputs, [
      merge.outputValue! - 1_000_000,
    ])
    const tampered = txidOfHex(merge.unsignedPsbtHex)
    writeDocument(document)

    // Read as no plan the wallet made as soon as it is loaded, before any
    // Continue: it holds nothing and offers only its cancel.
    await world.restart()
    await world.unlock()
    expect(await world.plan()).toMatchObject({
      id: planId,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
      sent: false,
    })
    expect((await world.planHeld()).size).toBe(0)
    await expect(world.wallet.continueQbitSendPlan(planId)).rejects.toThrow('not open')
    world.mine()
    await world.tick()
    world.mine()
    await world.tick()

    expect(world.keyring.signed).toEqual([])
    expect(world.pushed).toEqual([])
    expect(world.pushed).not.toContain(tampered)
    // Cancel lets go of everything: nothing of the plan was sent.
    await expect(world.wallet.cancelQbitSendPlan(planId)).resolves.toBeNull()
    expect(await world.plan()).toBeNull()
    expect((await world.planHeld()).size).toBe(0)
  })

  it('reads a plan whose payment PSBT pays more fee than its record as unreadable at once: nothing of it is signed or sent', async () => {
    const planId = await planStoppedBeforeSigning()
    const document = storedDocument()
    const plan = document.plans[0]!
    const payment = plan.steps[plan.steps.length - 1]!
    const outputs = decodePsbt(qbitSendPlanPsbtFromHex(payment.unsignedPsbtHex)).outputs
    const values = outputs.map(output => Number(output.value))
    values[values.length - 1] = plan.change - 1_000
    payment.unsignedPsbtHex = rebuiltPsbt(payment.unsignedPsbtHex, payment.inputs, values)
    writeDocument(document)

    await restartAndContinue(planId)

    // The record is checked whole when it is read: its merge, which matches
    // the record, is not signed or sent either.
    expect(world.keyring.signed).toEqual([])
    expect(world.pushed).toEqual([])
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
      sent: false,
    })
    world.assertRecipientGuarantees(undefined)
  })
})

describe('plans the wallet priced itself', () => {
  it('signs and completes an amount whose remainder is folded into the fee, with a memo, at a fractional rate', async () => {
    world.fund(150, 100_000)
    await world.open()
    const feeRate = 1.37
    const everything = await world.review({ target: { kind: 'everything' }, feeRate, memo: 'r4' })
    const amount = everything.amount - 1
    const review = await world.review({ target: { kind: 'amount', amount }, feeRate, memo: 'r4' })
    expect(review.change).toBe(0)
    expect(review.payment.fee).toBe(everything.payment.fee + 1)
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started.ok).toBe(true)
    await world.settle()
    for (let block = 0; block < 3 && (await world.plan())?.phase !== 'completed'; block++) {
      world.mine()
      await world.tick()
    }
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount })
    world.assertRecipientGuarantees(amount)
  })

  it('signs and completes everything at the relay floor, a rate below one bit a byte', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' }, feeRate: 0.25 })
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started.ok).toBe(true)
    await world.settle()
    for (let block = 0; block < 3 && (await world.plan())?.phase !== 'completed'; block++) {
      world.mine()
      await world.tick()
    }
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount: review.amount })
    world.assertRecipientGuarantees(review.amount)
  })
})
