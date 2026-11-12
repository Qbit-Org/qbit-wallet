import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hexToBytes, p2mrAddressFromPubkey } from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { keyringService, preferenceService } from '../src/services'
import {
  QBIT_RECENT_SPEND_GONE_GRACE_MS,
  type QbitSendGuardService,
} from '../src/services/qbitSendGuards'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
import {
  CHAIN,
  T0,
  World,
  account,
  isBroadcast,
  isLookup,
  newPlanGuard,
  once,
  p2mrAccount,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// Removing a wallet ends the send plans of the accounts it held (#188): no
// screen can show or cancel a plan of an account that is gone, so the
// removal ends them as a cancel would. Nothing more is signed or broadcast
// for them, the stored signed payment goes, holds are let go of under the
// cancel rules, and the record goes once nothing of it is in doubt; a plan
// whose payment may already be in the network cannot be un-sent, and its
// record and holds go all the same.

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
      // What a wallet removal reads and does (see `removeWalletOnTestnet`).
      getAllDisplayedKeyrings: vi.fn(async () => []),
      getQbitRecoveryVaultState: vi.fn(async () => undefined),
      createTmpKeyring: vi.fn(),
      removeKeyring: vi.fn(),
    },
    preferenceService: {
      getCurrentAccount: vi.fn(),
      getAddressFlag: vi.fn(() => 0),
      getChainType: vi.fn(() => ChainType.QBIT_REGTEST),
      getAutoLockTimeId: vi.fn(() => 0),
      getInitAlianNameStatus: vi.fn(() => true),
      getLockOnComputerLock: vi.fn(() => true),
      getLockOnWindowsClosed: vi.fn(() => true),
      getAccountAlianName: vi.fn((_key: string, name?: string) => name),
      getKeyringAlianName: vi.fn(() => 'Wallet'),
      getKeyringColor: vi.fn(() => undefined),
      getCurrentKeyringIndex: vi.fn(() => 1),
      removeKeyringAlianName: vi.fn(),
      removeKeyringColor: vi.fn(),
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

/** What a wallet removal hands the engine: the removed accounts, by network and address. */
const REMOVED = [{ chain: CHAIN, address: account.address }]

async function endPlansOfRemovedWallet() {
  const outcome = await world.engine.endPlansOf(REMOVED)
  await world.settle()
  return outcome
}

describe('a removed wallet’s send plans', () => {
  it('stops a plan mid-signing: nothing more is signed or sent, and nothing of it is left', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let reached!: () => void
    const reachedInput = new Promise<void>(resolve => (reached = resolve))
    world.keyring.beforeInput = async (_txid, index) => {
      if (index !== 50) return
      reached()
      await held
    }
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started.ok).toBe(true)
    await reachedInput
    const ending = world.engine.endPlansOf(REMOVED)
    release()
    const outcome = await ending
    await world.settle()
    world.keyring.beforeInput = undefined

    expect(outcome).toEqual({
      ended: [(started as { plan: { id: string } }).plan.id],
      mayHaveBeenSent: [],
    })
    expect(world.keyring.signed).toEqual([])
    expect(world.pushed).toEqual([])
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(world.keyring.batches.size).toBe(0)
    await world.tick()
    expect(world.keyring.signed).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('ends a plan waiting with its payment signed: the signed payment goes and is never broadcast', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])

    expect(await endPlansOfRemovedWallet()).toEqual({ ended: [plan.id], mayHaveBeenSent: [] })
    expect(world.storedPlans()).toEqual([])
    expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).not.toContain('signedPsbtHex')
    expect((await world.planHeld()).size).toBe(0)
    for (let block = 0; block < 3; block++) {
      world.mine()
      await world.tick()
    }
    expect(world.pushed).not.toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(undefined)
  })

  it('removes a plan whose payment was broadcast, holds and all, and says it may have paid', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })

    expect(await endPlansOfRemovedWallet()).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [plan.id],
    })
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(12_000_000)
  })

  it('removes a plan whose payment’s outcome is unknown, and says it may have paid', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
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
    expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])

    expect(await endPlansOfRemovedWallet()).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [plan.id],
    })
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
  })

  it('removes a plan a version of whose payment may still confirm, though proven absent, and says it may have paid', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    // The payment's broadcast has no verdict, the explorer never having
    // taken it; after a restart it is missed for the whole grace, proven
    // absent, and its resend is refused. A node may hold it all the same.
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    await world.tick()
    world.explorer.failures.length = 0
    await world.restart()
    world.refuse.set(plan.paymentTxid, {
      status: 400,
      body: 'sendrawtransaction RPC error: {"code":-26,"message":"non-mandatory-script-verify-flag"}',
    })
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    expect(world.storedStatuses()).toEqual(['confirmed', 'signed'])
    expect(qbitSendPlanStore.get(plan.id)!.steps.at(-1)!.dispatch).toBe('unknown')

    expect(await endPlansOfRemovedWallet()).toEqual({
      ended: [plan.id],
      mayHaveBeenSent: [plan.id],
    })
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('cancels a plan with a merge of unknown outcome until that merge is proven absent, signing nothing meanwhile', async () => {
    world.fund(250, 100_000)
    await world.open()
    // The merges' broadcasts have no verdict, the explorer never having
    // taken them.
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    world.explorer.failures.length = 0
    const statuses = world.storedStatuses()
    expect(statuses[0]).toBe('unknown')
    const signedBefore = world.keyring.signed.length

    expect(await endPlansOfRemovedWallet()).toEqual({ ended: [plan.id], mayHaveBeenSent: [] })
    const cancelling = qbitSendPlanStore.get(plan.id)!
    expect(cancelling.phase).toBe('cancelling')
    expect(cancelling.steps.at(-1)!.signedPsbtHex).toBeUndefined()
    // Only the inputs of the merges whose outcome is unknown stay held.
    const unknownInputs = cancelling.steps
      .filter(step => step.status === 'unknown')
      .flatMap(step => step.inputs.map(input => `${input.txid}:${input.vout}`))
    expect(unknownInputs.length).toBeGreaterThan(0)
    expect([...(await world.planHeld())].sort()).toEqual([...unknownInputs].sort())

    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    await world.tick()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(world.keyring.signed).toHaveLength(signedBefore)
    world.assertRecipientGuarantees(undefined)
  })

  it('leaves the plans of other accounts and networks as they are, and drops an unreadable entry of the removed account', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(
      await world.engine.endPlansOf([
        { chain: CHAIN, address: 'qbrt1zsomeoneelse' },
        { chain: ChainType.QBIT_TESTNET4, address: account.address },
      ])
    ).toEqual({ ended: [], mayHaveBeenSent: [] })
    expect(qbitSendPlanStore.get(plan.id)).toBeDefined()

    // The account's plan, unreadable to this version, goes with the wallet.
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    document.plans[0].futureField = true
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await world.restart()
    expect(await world.plan()).toMatchObject({ pause: { reason: 'unreadable' } })
    expect(await endPlansOfRemovedWallet()).toEqual({ ended: [], mayHaveBeenSent: [] })
    expect(world.storedPlans()).toEqual([])
    expect(await world.plan()).toBeNull()
  })
})

/** A call held until `release`; `reached` resolves once the call began. */
interface Held {
  reached: Promise<void>
  release: () => void
}

function held(): Held & { arrive: () => void; gate: Promise<void> } {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  let arrive: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrive = resolve))
  return { reached, release, arrive, gate }
}

/** The next write to storage waits until `release`. */
function holdNextWrite(): Held {
  const call = held()
  const set = world.storage.set.bind(world.storage)
  let first = true
  world.storage.set = async (key, value) => {
    if (first) {
      first = false
      call.arrive()
      await call.gate
    }
    return set(key, value)
  }
  return call
}

/** The send guard's next plan hold waits until `release`. */
function holdNextPlanHold(): Held {
  const call = held()
  const guard = guardHolder.guard as QbitSendGuardService
  const hold = guard.holdOutpointsForPlan.bind(guard)
  vi.spyOn(guard, 'holdOutpointsForPlan').mockImplementationOnce(async entry => {
    call.arrive()
    await call.gate
    return hold(entry)
  })
  return call
}

/** The keyring's next `name` call waits until `release`. */
function holdNextKeyringCall(
  name: 'preflightP2mrPsbtSigning' | 'signP2mrPsbtWithCounter'
): Held {
  const call = held()
  const real = world.keyring[name] as (...args: unknown[]) => Promise<unknown>
  vi.mocked(keyringService[name]).mockImplementationOnce((async (...args: unknown[]) => {
    call.arrive()
    await call.gate
    return real(...args)
  }) as never)
  return call
}

/** The engine's private state, as far as these tests read it. */
function engineState(): {
  sessions: Map<string, { authorised: boolean }>
  drafts: Map<string, unknown>
} {
  return world.engine as unknown as {
    sessions: Map<string, { authorised: boolean }>
    drafts: Map<string, unknown>
  }
}

/**
 * Nothing of the removed account's plans is left, read at once, with
 * nothing awaited: no record, stored or in memory, no hold, no batch, no
 * challenge, no draft and no session authorised to sign.
 */
function expectNothingLeftNow(): void {
  expect(qbitSendPlanStore.list()).toEqual([])
  expect(world.storedPlans()).toEqual([])
  const holds = (
    guardHolder.guard as unknown as { planHolds: Map<string, { outpoints: Set<string> }> }
  ).planHolds
  expect([...holds.values()].flatMap(hold => [...hold.outpoints])).toEqual([])
  expect(world.keyring.batches.size).toBe(0)
  expect(world.keyring.challenges.size).toBe(0)
  expect(engineState().drafts.size).toBe(0)
  expect(
    [...engineState().sessions].filter(([, session]) => session.authorised).map(([id]) => id)
  ).toEqual([])
}

/** And so it stays: time passes, blocks come, and nothing of the plan is signed or sent. */
async function expectNothingLeftAfterwards(signedBefore = 0): Promise<void> {
  await world.settle()
  for (let block = 0; block < 2; block++) {
    world.mine()
    await world.tick()
  }
  expectNothingLeftNow()
  expect((await world.planHeld()).size).toBe(0)
  expect(world.keyring.signed).toHaveLength(signedBefore)
  world.assertRecipientGuarantees(undefined)
}

describe('a wallet removed while work for its account is under way', () => {
  it('refuses a start whose first write it overtakes: draft_expired, and nothing the start wrote survives', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const write = holdNextWrite()
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await write.reached
    const ending = world.engine.endPlansOf(REMOVED)
    write.release()
    const outcome = await ending

    expectNothingLeftNow()
    expect(await starting).toEqual({ ok: false, reason: 'draft_expired' })
    expect(outcome.mayHaveBeenSent).toEqual([])
    await expectNothingLeftAfterwards()
    expect(world.pushed).toEqual([])
  })

  it('refuses a start it overtakes between the start’s hold and its write: nothing is written or held', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const hold = holdNextPlanHold()
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await hold.reached
    const ending = world.engine.endPlansOf(REMOVED)
    hold.release()
    expect(await ending).toEqual({ ended: [], mayHaveBeenSent: [] })

    expectNothingLeftNow()
    expect(await starting).toEqual({ ok: false, reason: 'draft_expired' })
    await expectNothingLeftAfterwards()
    expect(world.pushed).toEqual([])
  })

  it('refuses a replan whose swap it overtakes: draft_expired, and the plan ends with nothing of either version left', async () => {
    const amount = 22_000_000
    const outpoints = world.fund(250, index => 100_000 + index)
    await world.open()
    // Ranked by value, the second merge spends the 107th to 212th largest.
    world.refuseSpending.add(outpoints[100]!)
    const plan = await world.startPlan({ target: { kind: 'amount', amount } })
    await world.tick()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'merge_refused' } })
    world.refuseSpending.clear()
    world.mine([plan.steps[0]!.txid])
    await world.plan()
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    const signedBefore = world.keyring.signed.length
    const pushedBefore = world.pushed.length
    const write = holdNextWrite()
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await write.reached
    const ending = world.engine.endPlansOf(REMOVED)
    write.release()
    const outcome = await ending

    expectNothingLeftNow()
    expect(await starting).toEqual({ ok: false, reason: 'draft_expired' })
    expect(outcome).toEqual({ ended: [plan.id], mayHaveBeenSent: [] })
    await expectNothingLeftAfterwards(signedBefore)
    expect(world.pushed).toHaveLength(pushedBefore)
  })

  it('refuses a continue whose write it overtakes, and nothing of the plan is left', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    document.plans[0].phase = 'paused'
    document.plans[0].pause = { reason: 'interrupted', at: Date.now() }
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await world.restart()
    await world.unlock()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      actions: ['continue', 'cancel'],
    })
    const signedBefore = world.keyring.signed.length
    const pushedBefore = world.pushed.length
    const write = holdNextWrite()
    const continuing = world.wallet.continueQbitSendPlan(plan.id)
    await write.reached
    const ending = world.engine.endPlansOf(REMOVED)
    write.release()
    const outcome = await ending

    expectNothingLeftNow()
    await expect(continuing).rejects.toThrow('The Qbit send plan is not open')
    expect(outcome).toEqual({ ended: [plan.id], mayHaveBeenSent: [] })
    await expectNothingLeftAfterwards(signedBefore)
    expect(world.pushed).toHaveLength(pushedBefore)
  })

  it('refuses a restored-floor start waiting for its first signature’s checks: draft_expired, and nothing is signed', async () => {
    world.keyring.restoredFloor = true
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const signing = holdNextKeyringCall('signP2mrPsbtWithCounter')
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await signing.reached
    const ending = world.engine.endPlansOf(REMOVED)
    signing.release()
    await ending

    expectNothingLeftNow()
    expect(await starting).toEqual({ ok: false, reason: 'draft_expired' })
    expect(world.keyring.counter).toBe(0)
    await expectNothingLeftAfterwards()
    expect(world.pushed).toEqual([])
  })

  it('keeps no draft of a prepare under way, and leaves no batch or challenge of it', async () => {
    world.keyring.restoredFloor = true
    world.fund(150, 100_000)
    await world.open()
    const preflight = holdNextKeyringCall('preflightP2mrPsbtSigning')
    const preparing = world.prepare({ target: { kind: 'amount', amount: 12_000_000 } })
    await preflight.reached
    const ending = world.engine.endPlansOf(REMOVED)
    preflight.release()
    await ending

    await expect(preparing).rejects.toThrow('Qbit send plans need an account this wallet signs for')
    expectNothingLeftNow()
    await expectNothingLeftAfterwards()
  })
})

describe('a wallet removed while a broadcast of its plan is under way', () => {
  it('sends nothing more once the removal began: the payment written ahead is never broadcast', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    world.mine()
    // The next advance finds the merge confirmed, moves to sending, and
    // writes the payment ahead of its broadcast: that write waits.
    const set = world.storage.set.bind(world.storage)
    const call = held()
    let waiting = false
    world.storage.set = async (key, value) => {
      const document = value as { plans: { steps: { status: string }[] }[] }
      if (!waiting && document.plans[0]?.steps.at(-1)?.status === 'unknown') {
        waiting = true
        call.arrive()
        await call.gate
      }
      return set(key, value)
    }
    const ticking = world.tick()
    await call.reached
    const ending = world.engine.endPlansOf(REMOVED)
    call.release()
    const outcome = await ending
    await ticking

    // Written ahead, the payment counts as possibly sent, and goes with the
    // plan; its bytes never left.
    expect(outcome).toEqual({ ended: [plan.id], mayHaveBeenSent: [plan.id] })
    expect(world.pushed).not.toContain(plan.paymentTxid)
    expectNothingLeftNow()
    await expectNothingLeftAfterwards(world.keyring.signed.length)
    expect(world.pushed).not.toContain(plan.paymentTxid)
  })
})

describe('a wallet removed on testnet4 while work for its mainnet account is under way', () => {
  // A wallet's key differs between the derivation paths: mainnet's (coin type
  // 0), where its plan is started, and the test networks' (coin type 1),
  // where the wallet is listed once a page switched to testnet4.
  const MAINNET_PATH = "m/87'/0'/0'/0"
  const TEST_PATH = "m/87'/1'/0'/0"
  const MAINNET_OWNER = p2mrAccount('55'.repeat(32), 'mainnet')
  /** The mainnet account of the wallet that stays, which the removed wallet does not hold. */
  const OTHER_MAINNET_OWNER = p2mrAccount('88'.repeat(32), 'mainnet')
  const MAINNET_RECIPIENT = p2mrAddressFromPubkey(hexToBytes('44'.repeat(32)), 'mainnet')
  const PHRASE = 'the phrase of the wallet removed'
  const OTHER_PHRASE = 'the phrase of the wallet that stays'

  /** The keyrings the keyring service keeps: the wallet removed in slot 0, another in slot 1. */
  const slots = (keyringService as unknown as { keyrings: unknown[] }).keyrings

  /** An account's key on the test networks' path, as the keyring service lists it. */
  function listedKey(pubkeyHex: string) {
    const pubkey = hexToBytes(pubkeyHex)
    return {
      ...p2mrAccount(pubkeyHex).p2mr,
      path: `${TEST_PATH}/0`,
      addresses: {
        mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
        testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
        signet: p2mrAddressFromPubkey(pubkey, 'signet'),
        regtest: p2mrAddressFromPubkey(pubkey, 'regtest'),
      },
    }
  }

  function wallet(mnemonic: string, listedPubkey: string) {
    return {
      type: KeyringType.QbitHdKeyring,
      mnemonic,
      passphrase: '',
      activeIndexes: [0],
      hdPath: TEST_PATH,
      listedPubkey,
    }
  }

  beforeEach(() => {
    slots.length = 0
    slots.push(wallet(PHRASE, '66'.repeat(32)), wallet(OTHER_PHRASE, '77'.repeat(32)))
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockImplementation((async () =>
      slots.map((slot, index) => {
        const { type, listedPubkey } = slot as { type: string; listedPubkey?: string }
        return {
          type,
          index,
          addressType: AddressType.P2MR,
          keyring: { hdPath: TEST_PATH },
          accounts: listedPubkey
            ? [{ pubkey: listedPubkey, brandName: type, keyring: listedKey(listedPubkey) }]
            : [],
        }
      })) as never)
    // The removed wallet's key on mainnet's path, derived from its phrase.
    vi.mocked(keyringService.createTmpKeyring).mockImplementation(((
      _type: string,
      options: { mnemonic?: string; hdPath?: string; activeIndexes?: number[] }
    ) => ({
      getQbitAccounts: async () =>
        options.mnemonic === PHRASE &&
        options.hdPath === MAINNET_PATH &&
        options.activeIndexes?.join() === '0'
          ? [{ pubkey: MAINNET_OWNER.pubkey, addresses: { mainnet: MAINNET_OWNER.address } }]
          : [],
    })) as never)
    vi.mocked(keyringService.removeKeyring).mockImplementation((async (
      index: number,
      options?: { beforeRemove?: () => Promise<void> }
    ) => {
      await options?.beforeRemove?.()
      slots[index] = { type: KeyringType.Empty }
    }) as never)
  })

  afterEach(() => {
    slots.length = 0
  })

  /** A world whose account is `owner` on mainnet (by default the removed wallet's), mainnet active. */
  function mainnetWorld(owner = MAINNET_OWNER): World {
    if (world?.wallet) world.engine.reset()
    newGuard()
    lockState.isUnlocked = true
    const next = new World(lockState, newGuard, owner, ChainType.QBIT_MAINNET)
    worlds.push(next)
    wirePlanKeyring(next)
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(owner as never)
    return next
  }

  /** The removed wallet's accounts on mainnet's path cannot be derived, this once. */
  function derivationFailsOnce(): void {
    vi.mocked(keyringService.createTmpKeyring).mockImplementationOnce(() => {
      throw new Error('derivation failed')
    })
  }

  /** Whatever the removal finds on mainnet, what is stored there, held and armed stays as it was. */
  async function expectRefusedWithNothingChanged(removal: Promise<unknown>): Promise<void> {
    const records = qbitSendPlanStore.list()
    const held = await world.planHeld()
    const scheduled = world.timers.scheduled
    const endPlansOf = vi.spyOn(world.engine, 'endPlansOf')
    await expect(removal).rejects.toThrow('could not be derived')
    await world.settle()
    expect(slots[0]).toMatchObject({ type: KeyringType.QbitHdKeyring, mnemonic: PHRASE })
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()
    expect(endPlansOf).not.toHaveBeenCalled()
    expect(qbitSendPlanStore.list()).toEqual(records)
    expect(await world.planHeld()).toEqual(held)
    expect(world.timers.scheduled).toBe(scheduled)
    endPlansOf.mockRestore()
  }

  /**
   * Another page switches to testnet4 and removes the wallet there, while
   * the wallet in slot 1 is current. Resolves to the accounts the removal
   * hands the engine once the engine began ending their plans, and to the
   * removal itself.
   */
  async function removeWalletOnTestnet(): Promise<{
    accounts: Promise<{ chain: ChainType; address: string }[]>
    removal: Promise<unknown>
  }> {
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    const [listed] = JSON.parse(JSON.stringify(await world.wallet.getKeyrings()))
    const engine = world.engine
    const endPlansOf = engine.endPlansOf.bind(engine)
    const accounts = new Promise<{ chain: ChainType; address: string }[]>(resolve => {
      vi.spyOn(engine, 'endPlansOf').mockImplementationOnce(removed => {
        const ending = endPlansOf(removed)
        resolve([...removed])
        return ending
      })
    })
    return { accounts, removal: world.wallet.removeKeyring(listed) }
  }

  it.each([
    ['its first write', () => holdNextWrite()],
    ['its hold', () => holdNextPlanHold()],
  ])(
    'refuses a mainnet start awaiting %s: draft_expired, and nothing of it is left',
    async (_awaiting, holdNext) => {
      world = mainnetWorld()
      world.fund(150, 100_000)
      await world.open()
      const review = await world.review({
        to: MAINNET_RECIPIENT,
        target: { kind: 'amount', amount: 12_000_000 },
      })
      const call = holdNext()
      const starting = world.wallet.startQbitSendPlan(review.draftId)
      await call.reached
      const { accounts, removal } = await removeWalletOnTestnet()
      const removed = await accounts
      call.release()
      await removal

      expect(await starting).toEqual({ ok: false, reason: 'draft_expired' })
      expect(slots[0]).toEqual({ type: KeyringType.Empty })
      expectNothingLeftNow()
      expect(removed).toContainEqual({
        chain: ChainType.QBIT_MAINNET,
        address: MAINNET_OWNER.address,
      })
      await expectNothingLeftAfterwards()
      expect(world.pushed).toEqual([])
    }
  )

  it('goes on as before when the derivation on the other path fails and nothing of a plan is on its networks', async () => {
    world = mainnetWorld()
    world.fund(150, 100_000)
    await world.open()
    derivationFailsOnce()
    const { accounts, removal } = await removeWalletOnTestnet()
    const removed = await accounts
    await removal
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    // The test networks' accounts, which it lists, were named; mainnet's could not be.
    expect(removed.some(item => item.chain === ChainType.QBIT_MAINNET)).toBe(false)
    expect(removed.some(item => item.chain === ChainType.QBIT_TESTNET4)).toBe(true)
    expectNothingLeftNow()
  })

  it('refuses a removal whose derivation on the other path fails while the removed wallet’s plan is there, and a retry ends it', async () => {
    world = mainnetWorld()
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({
      to: MAINNET_RECIPIENT,
      target: { kind: 'amount', amount: 12_000_000 },
    })
    expect((await world.planHeld()).size).toBeGreaterThan(0)
    derivationFailsOnce()
    await expectRefusedWithNothingChanged((await removeWalletOnTestnet()).removal)

    // The retry derives the key, and ends the plan as a removal does.
    const retry = await removeWalletOnTestnet()
    const removed = await retry.accounts
    await retry.removal
    expect(removed).toContainEqual({ chain: ChainType.QBIT_MAINNET, address: plan.address })
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    expectNothingLeftNow()
    await expectNothingLeftAfterwards(world.keyring.signed.length)
  })

  it('refuses a removal whose derivation on the other path fails while another wallet’s plan is there, and a retry leaves that plan as it is', async () => {
    // The plan is the staying wallet's, on an account the removed wallet does not hold.
    world = mainnetWorld(OTHER_MAINNET_OWNER)
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({
      to: MAINNET_RECIPIENT,
      target: { kind: 'amount', amount: 12_000_000 },
    })
    derivationFailsOnce()
    await expectRefusedWithNothingChanged((await removeWalletOnTestnet()).removal)

    const record = qbitSendPlanStore.get(plan.id)!
    const held = await world.planHeld()
    const retry = await removeWalletOnTestnet()
    const removed = await retry.accounts
    await retry.removal
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    expect(removed).not.toContainEqual({ chain: ChainType.QBIT_MAINNET, address: plan.address })
    expect(qbitSendPlanStore.get(plan.id)).toEqual(record)
    expect(await world.planHeld()).toEqual(held)
    // Back on mainnet, the staying wallet's plan goes on to its payment.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('refuses a removal whose derivation on the other path fails while an entry the store cannot read is there', async () => {
    world = mainnetWorld()
    world.fund(150, 100_000)
    await world.open()
    world.storage.values.set(
      QBIT_SEND_PLAN_STORE_KEY,
      JSON.stringify({
        version: 1,
        plans: [{ id: 'd4'.repeat(16), chain: ChainType.QBIT_MAINNET, account: { address: 'qb1zsomeone' } }],
      })
    )
    await world.restart()
    expect(qbitSendPlanStore.unreadable().plans).toHaveLength(1)
    derivationFailsOnce()
    await expectRefusedWithNothingChanged((await removeWalletOnTestnet()).removal)
    expect(qbitSendPlanStore.unreadable().plans).toHaveLength(1)
  })

  it('refuses a removal whose derivation on the other path fails while a start is under way there', async () => {
    world = mainnetWorld()
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({
      to: MAINNET_RECIPIENT,
      target: { kind: 'amount', amount: 12_000_000 },
    })
    const write = holdNextWrite()
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await write.reached
    derivationFailsOnce()
    const { removal } = await removeWalletOnTestnet()
    await expect(removal).rejects.toThrow('could not be derived')
    expect(slots[0]).toMatchObject({ type: KeyringType.QbitHdKeyring, mnemonic: PHRASE })
    expect(keyringService.removeKeyring).not.toHaveBeenCalled()
    // The start goes on as if no removal had been asked for.
    write.release()
    expect(await starting).toMatchObject({ ok: true })
    await world.settle()
    expect(qbitSendPlanStore.list()).toHaveLength(1)
  })

  it('drops a mainnet draft and its batch, and no start of its review starts anything', async () => {
    world = mainnetWorld()
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({
      to: MAINNET_RECIPIENT,
      target: { kind: 'amount', amount: 12_000_000 },
    })
    expect(engineState().drafts.size).toBe(1)
    const { accounts, removal } = await removeWalletOnTestnet()
    await accounts
    await removal

    expectNothingLeftNow()
    // Not even with the account selected on mainnet again, as it would be
    // once the wallet's phrase is restored.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_MAINNET)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    await expectNothingLeftAfterwards()
  })

  it('keeps no draft of a mainnet prepare under way, and leaves no batch of it', async () => {
    world = mainnetWorld()
    world.fund(150, 100_000)
    await world.open()
    const preflight = holdNextKeyringCall('preflightP2mrPsbtSigning')
    const preparing = world.prepare({
      to: MAINNET_RECIPIENT,
      target: { kind: 'amount', amount: 12_000_000 },
    })
    await preflight.reached
    const { accounts, removal } = await removeWalletOnTestnet()
    await accounts
    preflight.release()
    await removal

    await expect(preparing).rejects.toThrow('Qbit send plans need an account this wallet signs for')
    expectNothingLeftNow()
    await expectNothingLeftAfterwards()
  })
})

describe('a removed wallet that holds an address another wallet holds too', () => {
  // A plan belongs to the wallet that signs for its account. A watch wallet
  // can hold the very address a wallet of the user signs for (it is added
  // by address, and only wallets of one type are checked for duplicates):
  // removing it ends no plan, and removing the signing wallet ends the plan
  // whatever watch wallet stays; an account another wallet that signs for
  // it still holds keeps its plans.
  const TEST_PATH = "m/87'/1'/0'/0"

  /** The keyrings the keyring service keeps, by slot. */
  const slots = (keyringService as unknown as { keyrings: unknown[] }).keyrings

  /** An account's key as the keyring service lists it on the test networks' path. */
  function listedKey(pubkeyHex: string) {
    const pubkey = hexToBytes(pubkeyHex)
    return {
      ...p2mrAccount(pubkeyHex).p2mr,
      path: `${TEST_PATH}/0`,
      addresses: {
        mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
        testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
        signet: p2mrAddressFromPubkey(pubkey, 'signet'),
        regtest: p2mrAddressFromPubkey(pubkey, 'regtest'),
      },
    }
  }

  function signingWallet(listedPubkey: string) {
    return {
      type: KeyringType.QbitHdKeyring,
      mnemonic: `the phrase of the wallet of ${listedPubkey.slice(0, 4)}`,
      passphrase: '',
      activeIndexes: [0],
      hdPath: TEST_PATH,
      listedPubkey,
    }
  }

  /**
   * Slot 0: the wallet that signs for the plan's account; slot 1: a watch
   * wallet holding the account's address; slot 2: the current wallet,
   * listing `currentPubkey`.
   */
  function wallets(currentPubkey = '77'.repeat(32)): void {
    slots.length = 0
    slots.push(
      signingWallet(account.pubkey),
      { type: KeyringType.WatchAddressKeyring, watched: account.address },
      signingWallet(currentPubkey)
    )
  }

  beforeEach(() => {
    wallets()
    vi.mocked(preferenceService.getCurrentKeyringIndex).mockReturnValue(2)
    vi.mocked(keyringService.getAllDisplayedKeyrings).mockImplementation((async () =>
      slots.map((slot, index) => {
        const { type, listedPubkey, watched } = slot as {
          type: string
          listedPubkey?: string
          watched?: string
        }
        if (type === KeyringType.WatchAddressKeyring) {
          return {
            type,
            index,
            addressType: AddressType.P2MR,
            keyring: {},
            accounts: [{ pubkey: watched, brandName: type }],
          }
        }
        return {
          type,
          index,
          addressType: AddressType.P2MR,
          keyring: { hdPath: TEST_PATH },
          accounts: listedPubkey
            ? [{ pubkey: listedPubkey, brandName: type, keyring: listedKey(listedPubkey) }]
            : [],
        }
      })) as never)
    // No account of these wallets on mainnet's path matters here.
    vi.mocked(keyringService.createTmpKeyring).mockImplementation((() => ({
      getQbitAccounts: async () => [],
    })) as never)
    vi.mocked(keyringService.removeKeyring).mockImplementation((async (
      index: number,
      options?: { beforeRemove?: () => Promise<void> }
    ) => {
      await options?.beforeRemove?.()
      slots[index] = { type: KeyringType.Empty }
    }) as never)
  })

  afterEach(() => {
    slots.length = 0
  })

  /** Remove the wallet in slot `index`, as a page lists it. */
  async function removeWallet(index: number): Promise<void> {
    const listed = JSON.parse(JSON.stringify(await world.wallet.getKeyrings())) as {
      index: number
    }[]
    const wallet = listed.find(item => item.index === index)
    if (!wallet) throw new Error(`no wallet in slot ${index}`)
    await world.wallet.removeKeyring(wallet as never)
    await world.settle()
  }

  /** A plan of the account, waiting for its merge with its payment signed. */
  async function waitingPlan() {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    return plan
  }

  it('leaves the plan untouched when the watch wallet goes, and ends it with the wallet that signs for it', async () => {
    const plan = await waitingPlan()
    const record = qbitSendPlanStore.get(plan.id)!
    const held = await world.planHeld()
    expect(held.size).toBeGreaterThan(0)
    expect(engineState().sessions.get(plan.id)?.authorised).toBe(true)

    await removeWallet(1)
    expect(slots[1]).toEqual({ type: KeyringType.Empty })
    expect(qbitSendPlanStore.get(plan.id)).toEqual(record)
    expect(await world.planHeld()).toEqual(held)
    expect(engineState().sessions.get(plan.id)?.authorised).toBe(true)

    await removeWallet(0)
    expectNothingLeftNow()
    world.mine()
    await world.tick()
    expect(world.pushed).not.toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(undefined)
  })

  it('ends the plan with the wallet that signs for it while a watch wallet of its address stays', async () => {
    const plan = await waitingPlan()
    await removeWallet(0)
    expect(slots[1]).toMatchObject({ type: KeyringType.WatchAddressKeyring })
    expectNothingLeftNow()
    world.mine()
    await world.tick()
    expect(world.pushed).not.toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps the plan of an account another wallet that signs for it still holds', async () => {
    // The current wallet lists the plan's account too.
    wallets(account.pubkey)
    const plan = await waitingPlan()
    const record = qbitSendPlanStore.get(plan.id)!
    const held = await world.planHeld()
    await removeWallet(0)
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    expect(qbitSendPlanStore.get(plan.id)).toEqual(record)
    expect(await world.planHeld()).toEqual(held)
    expect(engineState().sessions.get(plan.id)?.authorised).toBe(true)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('goes on when the accounts of a wallet that stays cannot be derived where nothing of a plan is, keeping the plan it lists', async () => {
    wallets(account.pubkey)
    const plan = await waitingPlan()
    const record = qbitSendPlanStore.get(plan.id)!
    const held = await world.planHeld()
    // The removed wallet's accounts on the other path are derived; those of
    // the wallet that stays and lists its key cannot be. Nothing of a plan
    // is on that path's networks: the removal goes on.
    vi.mocked(keyringService.createTmpKeyring)
      .mockImplementationOnce((() => ({ getQbitAccounts: async () => [] })) as never)
      .mockImplementationOnce(() => {
        throw new Error('derivation failed')
      })
    await removeWallet(0)
    expect(slots[0]).toEqual({ type: KeyringType.Empty })
    expect(qbitSendPlanStore.get(plan.id)).toEqual(record)
    expect(await world.planHeld()).toEqual(held)
    expect(engineState().sessions.get(plan.id)?.authorised).toBe(true)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })
})
