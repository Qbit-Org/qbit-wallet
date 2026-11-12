import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import { keyringService, preferenceService } from '../src/services'
import { QBIT_RECENT_SPEND_GONE_GRACE_MS } from '../src/services/qbitSendGuards'
import qbitSendPlanStore from '../src/services/qbitSendPlanStore'

/** The fields of a stored step these tests read. */
type QbitSendPlanStepRecordLike = { txid: string; inputs: { txid: string; vout: number }[] }
import {
  CHAIN,
  T0,
  World,
  account,
  isBroadcast,
  newPlanGuard,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// Resetting the wallet stops its send plans before anything else is reset
// (#188): from then on nothing of a plan is signed, broadcast, written or
// held, so no payment leaves for a wallet being wiped, and nothing of a
// plan is left once the reset is over. A reset that fails leaves the plans
// as a restart does.

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
      resetAllData: vi.fn(async () => undefined),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      getAutoLockTimeId: vi.fn(() => 0),
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
  if (world?.wallet) {
    clearTimeout(world.wallet.timer)
    world.engine.reset()
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A call held until `release`; `reached` resolves once the call began. */
function held(): {
  reached: Promise<void>
  release: () => void
  arrive: () => void
  gate: Promise<void>
} {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  let arrive: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrive = resolve))
  return { reached, release, arrive, gate }
}

/**
 * A plan waiting with its payment signed and its merge confirmed: the next
 * advance sends the payment.
 */
async function paymentDue(): Promise<{ paymentTxid: string; pushed: number }> {
  world.fund(150, 100_000)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
  expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
  world.mine()
  return { paymentTxid: plan.paymentTxid, pushed: world.pushed.length }
}

/** Nothing of a plan is left: no record, stored or in memory, and no hold. */
async function expectNoPlanLeft(): Promise<void> {
  expect(world.storedPlans()).toEqual([])
  expect(qbitSendPlanStore.list()).toEqual([])
  expect((await world.planHeld()).size).toBe(0)
}

describe('a wallet reset while a send plan is open', () => {
  it('broadcasts nothing while the vault is written, whatever the timer or a page does meanwhile', async () => {
    const due = await paymentDue()
    const writes = held()
    vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
      writes.arrive()
      await writes.gate
    })
    const resetting = world.wallet.resetAllData()
    await writes.reached
    // The engine's timer comes, and a page reads the plan.
    await world.tick()
    const read = await world.wallet.getQbitSendPlan()
    await world.settle()
    writes.release()
    await resetting

    expect(world.pushed).toHaveLength(due.pushed)
    expect(read).toBeNull()
    await expectNoPlanLeft()
    // Nothing goes later either.
    await world.tick()
    expect(world.pushed).toHaveLength(due.pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('broadcasts nothing when the reset comes while a tick writes the payment ahead of its broadcast', async () => {
    const due = await paymentDue()
    const set = world.storage.set.bind(world.storage)
    const ahead = held()
    let waiting = false
    world.storage.set = async (key, value) => {
      const document = value as { plans: { steps: { status: string }[] }[] }
      if (!waiting && document.plans[0]?.steps.at(-1)?.status === 'unknown') {
        waiting = true
        ahead.arrive()
        await ahead.gate
      }
      return set(key, value)
    }
    const ticking = world.tick()
    await ahead.reached
    // The keyring service's writes wait: the guard and the store are reset
    // only after them, so nothing of the reset has reached the plan yet.
    const writes = held()
    vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
      writes.arrive()
      await writes.gate
    })
    const resetting = world.wallet.resetAllData()
    ahead.release()
    // The tick's pass is over, whatever it did with the payment.
    await ticking
    writes.release()
    await resetting

    expect(world.pushed).toHaveLength(due.pushed)
    expect(world.pushed).not.toContain(due.paymentTxid)
    await expectNoPlanLeft()
    await world.tick()
    expect(world.pushed).toHaveLength(due.pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('stops a start under way: it answers draft_expired and nothing of it is left', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const set = world.storage.set.bind(world.storage)
    const write = held()
    let waiting = false
    world.storage.set = async (key, value) => {
      if (!waiting) {
        waiting = true
        write.arrive()
        await write.gate
      }
      return set(key, value)
    }
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await write.reached
    const resetting = world.wallet.resetAllData()
    write.release()
    await resetting

    expect(await starting).toEqual({ ok: false, reason: 'draft_expired' })
    await expectNoPlanLeft()
    await world.tick()
    expect(world.keyring.signed).toEqual([])
    expect(world.pushed).toEqual([])
  })

  it('ends a plan a version of whose payment may still confirm, which nothing else ends: no record or hold is left', async () => {
    const due = await paymentDue()
    // The payment's broadcast has no verdict; after a restart it is proven
    // absent and its resend is refused, so it may still confirm, and no
    // cancel is offered.
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    await world.tick()
    world.explorer.failures.length = 0
    await world.restart()
    world.refuse.set(due.paymentTxid, {
      status: 400,
      body: 'sendrawtransaction RPC error: {"code":-26,"message":"non-mandatory-script-verify-flag"}',
    })
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    await world.unlock()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'payment_refused' } })
    expect(paused.actions).not.toContain('cancel')
    expect((await world.planHeld()).size).toBeGreaterThan(0)

    await world.wallet.resetAllData()
    await expectNoPlanLeft()
    await world.tick()
    expect(await world.plan()).toBeNull()
  })

  /**
   * A reset whose keyring reset fails, with the plan's guard and its record
   * of recent spends left as they were: the plan is held again from its
   * record, as at start-up.
   */
  async function failedReset(): Promise<void> {
    vi.mocked(keyringService.resetAllData).mockRejectedValueOnce(new Error('reset failed'))
    await expect(world.wallet.resetAllData()).rejects.toThrow('reset failed')
  }

  /** Blocks confirm what is in the network until the plan completes. */
  async function completes(): Promise<void> {
    for (let block = 0; block < 4 && (await world.plan())?.phase !== 'completed'; block++) {
      world.mine()
      await world.tick()
    }
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
  }

  /**
   * A plan of two merges, the first confirmed and the second still in the
   * network: its hold no longer has the first merge's inputs, which that
   * merge's broadcast recorded as spent.
   */
  async function oneOfTwoMergesConfirmed(): Promise<{
    firstMerge: QbitSendPlanStepRecordLike
    amount: number
  }> {
    world.fund(250, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    expect(world.storedStatuses()).toEqual(['broadcast', 'broadcast', 'signed'])
    const firstMerge = qbitSendPlanStore.list()[0]!.steps[0]!
    world.mine([firstMerge.txid])
    await world.tick()
    expect(world.storedStatuses()).toEqual(['confirmed', 'broadcast', 'signed'])
    const held = await world.planHeld()
    expect(firstMerge.inputs.some(input => held.has(`${input.txid}:${input.vout}`))).toBe(false)
    return { firstMerge, amount: plan.amount }
  }

  it('goes on after a failed reset with its merge in the network unconfirmed, and completes', async () => {
    world.fund(150, 100_000)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    await failedReset()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    await completes()
    world.assertRecipientGuarantees(12_000_000)
  })

  it('goes on after a failed reset with a merge confirmed, whose inputs its own broadcast recorded as spent, and completes', async () => {
    const { amount } = await oneOfTwoMergesConfirmed()
    await failedReset()
    await world.tick()
    // Nothing but the plan spent its outputs: no pause for them.
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    await completes()
    world.assertRecipientGuarantees(amount)
  })

  it('still pauses outputs_spent after a failed reset for an output another transaction is recorded as spending', async () => {
    const { firstMerge } = await oneOfTwoMergesConfirmed()
    // Another transaction is recorded as spending an input of the first merge.
    const guard = guardHolder.guard as unknown as {
      recordSpendNow(chain: ChainType, spender: string, outpoints: unknown[], address: string): void
    }
    const input = firstMerge.inputs[0]!
    guard.recordSpendNow(CHAIN, 'f0'.repeat(32), [{ txid: input.txid, vout: input.vout }], account.address)
    await failedReset()
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: ['replan', 'cancel'],
    })
  })

  /** How many signings hold the controller's auto-lock now. */
  const autoLockHolds = (): number =>
    (world.wallet as unknown as { signingsHoldingAutoLock(): number }).signingsHoldingAutoLock()

  /** The auto-lock's time starts and runs out, and its timer fires. */
  async function autoLockFallsDue(): Promise<void> {
    const wallet = world.wallet as unknown as {
      _resetTimeout(): void
      autoLockDueAt: number
      autoLock(): Promise<void>
    }
    wallet._resetTimeout()
    vi.setSystemTime(wallet.autoLockDueAt + 1)
    await wallet.autoLock()
  }

  it.each([
    ['ensureHold', 'succeeds'],
    ['ensureHold', 'fails'],
    ['reconcileReplaced', 'succeeds'],
    ['reconcileReplaced', 'fails'],
  ])(
    'leaves no auto-lock hold when a reset comes while a signing run waits in %s before its next signature, and the auto-lock locks when due (the reset %s)',
    async (method, outcome) => {
      world.fund(250, 100_000)
      await world.open()
      const review = await world.review({ target: { kind: 'everything' } })
      // The run that is to sign the second merge waits in `method`, after the
      // first merge was sent, while the wallet is reset.
      const waiting = held()
      const engine = world.engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      const original = engine[method]!.bind(world.engine)
      let gated = false
      vi.spyOn(engine, method).mockImplementation(async (...args: unknown[]) => {
        const record = args[0] as { steps: { txid: string; status: string }[] }
        const [first, second] = record.steps
        const atSecondMerge =
          first!.status !== 'planned' &&
          second!.status === 'planned' &&
          (method === 'ensureHold' || (args[2] as { txid: string }).txid === second!.txid)
        if (!gated && atSecondMerge) {
          gated = true
          waiting.arrive()
          await waiting.gate
        }
        return original(...args)
      })
      await world.wallet.startQbitSendPlan(review.draftId)
      await waiting.reached
      const planId = world.storedPlanId()!
      const run = (world.engine as unknown as { sessions: Map<string, { running?: Promise<void> }> })
        .sessions.get(planId)!.running
      expect(autoLockHolds()).toBe(1)

      vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
        if (outcome === 'fails') throw new Error('reset failed')
      })
      // The reset halts the plans at once and waits for the run, which goes
      // on with the wallet still unlocked.
      const resetting = world.wallet.resetAllData()
      waiting.release()
      await run
      if (outcome === 'fails') await expect(resetting).rejects.toThrow('reset failed')
      else await resetting
      await world.settle()
      expect(autoLockHolds()).toBe(0)
      expect(lockState.isUnlocked).toBe(true)
      await autoLockFallsDue()
      expect(lockState.isUnlocked).toBe(false)
    }
  )

  it('leaves the plan as a restart does when the reset fails: held, and going on', async () => {
    const due = await paymentDue()
    const held = await world.planHeld()
    expect(held.size).toBeGreaterThan(0)
    vi.mocked(keyringService.resetAllData).mockRejectedValueOnce(new Error('reset failed'))

    await expect(world.wallet.resetAllData()).rejects.toThrow('reset failed')

    expect(await world.planHeld()).toEqual(held)
    await world.tick()
    expect(world.pushed).toContain(due.paymentTxid)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })
})
