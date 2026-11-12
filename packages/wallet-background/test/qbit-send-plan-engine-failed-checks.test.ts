import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bytesToHex, extractP2mrTransaction } from '@qbit-oss/protocol'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import { QBIT_SEND_PLAN_SLOW_MERGE_MS } from '../src/services/qbitSendPlanEngine'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
import { qbitSendPlanPsbtFromHex } from '../src/utils/qbit-send-plan-psbt'
import {
  CHAIN,
  T0,
  World,
  account,
  anotherAccountsPlan,
  isBroadcast,
  isLookup,
  newPlanGuard,
  nodeRejection,
  once,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A send plan that failed the checks of what its transactions are (#188):
// a step whose PSBT is not the transaction its record states, or a stored
// payment that is not the record's, pauses the plan `unreadable`. Such a
// plan stays so until its cancel ends it: nothing that advances, settles,
// pauses, continues, revises or restores a plan changes its pause, nothing
// of it is signed, sent or sent again, it shows nothing of what it states,
// and cancel is the one thing it offers.

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

const AMOUNT = 12_000_000

interface StoredDocument {
  version: number
  plans: Record<string, unknown>[]
}

function storedDocument(): StoredDocument {
  return JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
}

function writeDocument(document: StoredDocument): void {
  world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
}

/**
 * The stored plan `planId` failed a check of what its transactions are and
 * paused `unreadable`, as `signStep` and `stepSending` pause one, with
 * `others` stored beside it.
 */
function failChecks(planId: string, others: Record<string, unknown>[] = []): void {
  const document = storedDocument()
  const plan = document.plans.find(item => item['id'] === planId)!
  plan['phase'] = 'paused'
  plan['pause'] = { reason: 'unreadable', at: T0 }
  document.plans.push(...others)
  writeDocument(document)
}

/** The view of plan `planId` while it is paused unreadable: none of its figures, and its cancel. */
function standIn(planId: string) {
  return {
    id: planId,
    phase: 'paused',
    pause: { reason: 'unreadable' },
    recipient: '',
    amount: 0,
    totalFee: 0,
    steps: [],
    sent: false,
    paymentTxid: '',
    actions: ['cancel'],
  }
}

/** The stored record still says the plan failed its checks. */
function expectStoredUnreadable(planId: string): void {
  expect(qbitSendPlanStore.get(planId)).toMatchObject({
    phase: 'paused',
    pause: { reason: 'unreadable' },
  })
}

describe('a plan that failed its checks stays so until its cancel', () => {
  it('keeps it when the merge a raise replaced confirms instead of the replacement', async () => {
    // A plan whose merge stayed unconfirmed for long, raised: the
    // replacement is in the network, and the merge it replaced may still
    // confirm.
    world.fund(150, 1_000_000)
    await world.open()
    world.explorer.acceptReplacements = true
    await world.startPlan({ target: { kind: 'amount', amount: 120_000_000 } })
    await world.tick(QBIT_SEND_PLAN_SLOW_MERGE_MS + 60_000)
    const slow = (await world.plan())!
    expect(slow).toMatchObject({ phase: 'waiting', slowMerge: true })
    const [merge] = qbitSendPlanStore.get(slow.id)!.steps
    const original = world.tx(merge!.txid)
    const kept = {
      txid: original.txid,
      inputs: [...original.inputs],
      outputs: [...original.outputs],
    }
    const raise = await world.review({
      target: { kind: 'amount', amount: 120_000_000 },
      feeRate: 2,
      revise: { planId: slow.id, kind: 'raise_merge_fee' },
    })
    expect(await world.wallet.startQbitSendPlan(raise.draftId)).toMatchObject({ ok: true })
    await world.settle()
    const replacement = qbitSendPlanStore.get(slow.id)!.steps[0]!
    expect(replacement).toMatchObject({ status: 'broadcast', replaces: { txid: merge!.txid } })

    failChecks(slow.id)
    await world.restart()
    expect(await world.plan()).toMatchObject(standIn(slow.id))
    const pushed = world.pushed.length
    const signed = world.keyring.signed.length

    // A block mines the merge the raise replaced: the replacement leaves the
    // mempool, and would be void.
    world.explorer.removeTx(replacement.txid)
    world.explorer.addTx({ ...kept, height: ++world.explorer.tipHeight })
    await world.tick()
    await world.plan()
    await world.tick()
    await world.unlock()
    expect(await world.plan()).toMatchObject(standIn(slow.id))
    expectStoredUnreadable(slow.id)
    expect(world.pushed).toHaveLength(pushed)
    expect(world.keyring.signed).toHaveLength(signed)

    await expect(world.wallet.cancelQbitSendPlan(slow.id)).resolves.toBeNull()
    expect(world.storedPlans()).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps it when a restart finds another plan holding its outputs, and offers neither continue nor a revision', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const stored = qbitSendPlanStore.get(plan.id)!
    // A second plan, of another account, listing the same outputs.
    failChecks(plan.id, [anotherAccountsPlan(stored, '22'.repeat(32), 'c3'.repeat(16))])
    await world.restart()

    expect(await world.plan()).toMatchObject(standIn(plan.id))
    expectStoredUnreadable(plan.id)
    await world.unlock()
    await expect(world.wallet.continueQbitSendPlan(plan.id)).rejects.toThrow(
      'The Qbit send plan cannot continue now'
    )
    for (const kind of ['replan', 'raise_merge_fee', 'raise_payment_fee']) {
      await expect(
        world.prepare({
          target: { kind: 'amount', amount: AMOUNT },
          feeRate: 2,
          revise: { planId: plan.id, kind },
        })
      ).rejects.toThrow('The Qbit send plan does not offer this revision now')
    }

    // Another restart, and the merge confirms: nothing of it is signed or
    // goes out.
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    await world.restart()
    world.mine()
    await world.tick()
    await world.unlock()
    await world.tick()
    expect(await world.plan()).toMatchObject(standIn(plan.id))
    expectStoredUnreadable(plan.id)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    expect(world.pushed).not.toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps it when its payment is found in the network, and still offers its cancel', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    world.mine()
    // The payment's broadcast has no answer, the explorer having taken it,
    // and its lookups answer nothing yet.
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
    expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])

    failChecks(plan.id)
    await world.restart()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'unreadable' },
      recipient: '',
    })

    // The lookups answer again: the network holds the payment. The plan is
    // not completed from its record, which would show its figures; its
    // cancel is offered though its payment is in the network, since
    // nothing else ends a plan that failed its checks.
    world.explorer.failures.length = 0
    await world.tick()
    await world.tick()
    expectStoredUnreadable(plan.id)
    expect(await world.plan()).toMatchObject(standIn(plan.id))

    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toBeNull()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('keeps it, settling at once, when a version of its payment proven absent turns up mined', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    const signedHex = qbitSendPlanStore.get(plan.id)!.steps.at(-1)!.signedPsbtHex!
    const paymentRaw = bytesToHex(extractP2mrTransaction(qbitSendPlanPsbtFromHex(signedHex)))
    world.mine()
    // Every attempt of the payment's broadcast fails at the gateway, the
    // explorer never taking it; after a restart it is proven absent, sent
    // again, and refused for its fee.
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    await world.tick()
    world.explorer.failures.length = 0
    expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
    await world.restart()
    world.refuse.set(plan.paymentTxid, nodeRejection('mempool min fee not met'))
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    world.refuse.clear()
    expect(world.storedStatuses()).toEqual(['confirmed', 'signed'])
    expect(qbitSendPlanStore.get(plan.id)!.steps.at(-1)!.dispatch).toBe('unknown')

    failChecks(plan.id)
    await world.restart()
    expect(await world.plan()).toMatchObject(standIn(plan.id))

    // Its bytes reach the network by another way after all, and a block
    // confirms them.
    const answer = await world.explorer.fetch('https://explorer.invalid/api/tx', {
      method: 'POST',
      body: paymentRaw,
    })
    expect(answer.status).toBe(200)
    world.mine()
    await world.tick()
    // One read of the plan settles it at once: nothing is written, and the
    // advance does not go round again on what it cannot write.
    const revision = qbitSendPlanStore.get(plan.id)!.revision
    const reads = vi.spyOn(qbitSendPlanStore, 'get')
    await world.plan()
    expect(reads.mock.calls.length).toBeLessThan(200)
    reads.mockRestore()
    expect(qbitSendPlanStore.get(plan.id)!.revision).toBe(revision)
    expectStoredUnreadable(plan.id)
    expect(await world.plan()).toMatchObject(standIn(plan.id))

    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toBeNull()
    expect(world.storedPlans()).toEqual([])
    world.assertRecipientGuarantees(AMOUNT)
  })
})
