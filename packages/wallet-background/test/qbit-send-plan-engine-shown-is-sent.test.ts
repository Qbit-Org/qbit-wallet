import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PQC_SIGNATURE_BYTES,
  createP2mrPsbt,
  decodePsbt,
  finalizeP2mrPsbt,
  hexToBytes,
  signP2mrPsbt,
} from '@qbit-oss/protocol'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore, {
  QBIT_SEND_PLAN_STORE_KEY,
  type QbitSendPlanRecord,
} from '../src/services/qbitSendPlanStore'
import {
  qbitSendPlanAccountKeys,
  qbitSendPlanPsbtFromHex,
  qbitSendPlanPsbtHex,
  qbitSendPlanSigningKeys,
} from '../src/utils/qbit-send-plan-psbt'
import {
  CHAIN,
  FakePlanKeyring,
  PAYER,
  PAYER_SCRIPT,
  RECIPIENT_SCRIPT,
  T0,
  World,
  account,
  isBroadcast,
  newPlanGuard,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// What a stored plan shows is what it sends (#188): the store is plain
// extension storage, so a record can be changed on disk, and a changed
// record must never show one recipient or amount while its stored signed
// payment pays another. The store checks every transaction a record holds
// against what the record states when it reads or writes it, and the engine
// checks the stored payment again immediately before it broadcasts it.

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

interface StoredStep {
  kind: 'merge' | 'payment'
  txid: string
  unsignedPsbtHex: string
  inputs: { txid: string; vout: number; satoshis: number }[]
  status: string
  signedPsbtHex?: string
}

interface StoredPlan {
  id: string
  phase?: string
  pause?: { reason: string; at: number }
  recipient: string
  amount: number
  change: number
  steps: StoredStep[]
  [key: string]: unknown
}

function storedDocument(): { version: number; plans: StoredPlan[] } {
  return JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
}

function writeDocument(document: { version: number; plans: StoredPlan[] }): void {
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
}

/** What a record changed on disk moves from the amount to the change. */
const MOVED = 10_000

const txidOfHex = (psbtHex: string): string =>
  FakePlanKeyring.txidOf(qbitSendPlanPsbtFromHex(psbtHex))

/**
 * An unsigned PSBT spending the inputs of `psbtHex` (each the account's
 * output, `inputs` giving their values) as it does, to `outputs`.
 */
function paying(
  psbtHex: string,
  inputs: StoredStep['inputs'],
  outputs: readonly { value: number; script: string }[]
): string {
  const keys = qbitSendPlanAccountKeys(account.p2mr.pubkey)
  const summary = decodePsbt(qbitSendPlanPsbtFromHex(psbtHex))
  return qbitSendPlanPsbtHex(
    createP2mrPsbt({
      inputs: inputs.map((input, index) => ({
        prevout: { txid: hexToBytes(input.txid).reverse(), vout: input.vout },
        sequence: summary.inputs[index]!.sequence,
        witnessUtxo: { value: BigInt(input.satoshis), scriptPubKey: keys.scriptPubKey },
        leafScript: keys.leafScript,
        controlBlock: keys.controlBlock,
        merkleRoot: keys.leafHash,
      })),
      outputs: outputs.map(output => ({
        value: BigInt(output.value),
        scriptPubKey: hexToBytes(output.script),
      })),
    })
  )
}

/** `psbtHex` signed with placeholder signatures and finalized, as the fake keyring signs. */
function signedHex(psbtHex: string): string {
  const psbt = qbitSendPlanPsbtFromHex(psbtHex)
  const keys = qbitSendPlanSigningKeys(psbt, qbitSendPlanAccountKeys(account.p2mr.pubkey))
  const signed = signP2mrPsbt({
    psbt,
    keys,
    sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
  }).psbt
  return qbitSendPlanPsbtHex(finalizeP2mrPsbt(signed))
}

/**
 * A plan of one merge and a payment with change, signed through: the merge
 * sent and waiting for its confirmation, the payment signed and stored.
 */
async function planWaitingWithSignedPayment(): Promise<{
  planId: string
  paymentTxid: string
  amount: number
}> {
  world.fund(150, 100_000)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
  expect(plan.change).toBeGreaterThan(MOVED)
  expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
  expect(qbitSendPlanStore.get(plan.id)!.phase).toBe('waiting')
  return { planId: plan.id, paymentTxid: plan.paymentTxid, amount: plan.amount }
}

/** The merges confirm, and time passes: a plan whose record holds goes on to send its payment. */
async function confirmAndWait(): Promise<void> {
  for (let block = 0; block < 3; block++) {
    world.mine()
    await world.tick()
  }
}

describe('a stored plan shows what it sends', () => {
  it('never broadcasts the signed payment of a plan whose recipient and amount were changed on disk, the change moved to match', async () => {
    const { planId, paymentTxid } = await planWaitingWithSignedPayment()
    // The record now shows another recipient, paid `MOVED` bits less, the
    // change as much more: every total still adds up, and the signed
    // payment, which pays the reviewed recipient the reviewed amount, is as
    // it was.
    const document = storedDocument()
    const plan = document.plans[0]!
    plan.recipient = PAYER
    plan.amount -= MOVED
    plan.change += MOVED
    writeDocument(document)

    await world.restart()

    // What it would show is not what it would send: it is unreadable, offers
    // only its cancel, and shows no recipient or amount.
    expect(await world.plan()).toMatchObject({
      id: planId,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
      recipient: '',
      amount: 0,
    })
    expect((await world.planHeld()).size).toBe(0)
    await confirmAndWait()
    expect(world.pushed).not.toContain(paymentTxid)
    world.assertRecipientGuarantees(undefined)

    await world.unlock()
    await expect(world.wallet.cancelQbitSendPlan(planId)).resolves.toBeNull()
    expect(world.storedPlans()).toEqual([])
  })

  it('never broadcasts signed bytes of another transaction than the payment its record states, under that transaction’s id', async () => {
    const { planId, paymentTxid } = await planWaitingWithSignedPayment()
    // The stored signed payment and its id are swapped for those of another
    // transaction over the same inputs, which returns the change to someone
    // else; the record's figures and its unsigned payment are as they were.
    const document = storedDocument()
    const plan = document.plans[0]!
    const payment = plan.steps[plan.steps.length - 1]!
    const other = paying(payment.unsignedPsbtHex, payment.inputs, [
      { value: plan.amount, script: RECIPIENT_SCRIPT },
      { value: plan.change, script: PAYER_SCRIPT },
    ])
    const otherTxid = txidOfHex(other)
    payment.txid = otherTxid
    payment.signedPsbtHex = signedHex(other)
    writeDocument(document)

    await world.restart()

    expect(await world.plan()).toMatchObject({
      id: planId,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
    await confirmAndWait()
    expect(world.pushed).not.toContain(otherTxid)
    expect(world.pushed).not.toContain(paymentTxid)
    world.assertRecipientGuarantees(undefined)
  })

  it('checks the stored payment again immediately before it is broadcast, and never broadcasts one that is not the record’s', async () => {
    const { planId, paymentTxid } = await planWaitingWithSignedPayment()
    // A record in memory that shows another amount than its signed payment
    // pays, the change moved to match, as only a record that never passed
    // the store's checks could: the store refuses to read or write one.
    const read = qbitSendPlanStore.get.bind(qbitSendPlanStore)
    vi.spyOn(qbitSendPlanStore, 'get').mockImplementation((id: string) => {
      const record = read(id)
      if (!record || record.phase !== 'sending') return record
      return Object.freeze({
        ...record,
        amount: record.amount - MOVED,
        change: record.change + MOVED,
      }) as QbitSendPlanRecord
    })

    await confirmAndWait()

    expect(world.pushed).not.toContain(paymentTxid)
    expect(world.storedStatuses()).toEqual(['confirmed', 'signed'])
    world.assertRecipientGuarantees(undefined)
    vi.mocked(qbitSendPlanStore.get).mockRestore()
    expect(qbitSendPlanStore.get(planId)).toMatchObject({ steps: [{}, { status: 'signed' }] })
  })

  it('shows a plan that failed its checks as unreadable, with none of its figures, through its cancel', async () => {
    world.fund(250, 100_000)
    await world.open()
    // The merges' broadcasts have no verdict, the explorer never having
    // taken them, so the plan's cancel will wait for them.
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    world.explorer.failures.length = 0
    expect(
      world
        .storedStatuses()
        .slice(0, -1)
        .every(status => status === 'unknown')
    ).toBe(true)
    // The plan failed a check of what its transactions are and paused
    // unreadable (as `signStep` and `stepSending` pause one).
    const document = storedDocument()
    document.plans[0]!.phase = 'paused'
    document.plans[0]!.pause = { reason: 'unreadable', at: T0 }
    writeDocument(document)
    await world.restart()

    const standIn = {
      id: plan.id,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      recipient: '',
      amount: 0,
      change: 0,
      feeRate: 0,
      totalFee: 0,
      steps: [],
      sent: false,
      signaturesDone: 0,
      signaturesTotal: 0,
      paymentTxid: '',
    }
    expect(await world.plan()).toMatchObject({ ...standIn, actions: ['cancel'] })

    await world.unlock()
    const cancelled = await world.wallet.cancelQbitSendPlan(plan.id)
    expect(qbitSendPlanStore.get(plan.id)).toMatchObject({
      phase: 'cancelling',
      pause: { reason: 'unreadable' },
    })
    // While it cancels it still shows nothing of what it states, and offers
    // nothing more.
    expect(cancelled).toMatchObject({ ...standIn, actions: [] })
    expect(await world.plan()).toMatchObject({ ...standIn, actions: [] })

    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    await world.tick()
    expect(await world.plan()).toBeNull()
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('broadcasts the stored payment of a record that holds, paying exactly what it shows', async () => {
    const { amount } = await planWaitingWithSignedPayment()
    await world.restart()
    await confirmAndWait()
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount })
    world.assertRecipientGuarantees(amount)
  })
})
