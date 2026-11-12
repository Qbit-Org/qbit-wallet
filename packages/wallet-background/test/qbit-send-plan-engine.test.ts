import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hexToBytes, p2mrAddressFromPubkey } from '@qbit-oss/protocol'
import { toPsbtNetwork, transactionCore } from '@qbit/wallet-core'
import {
  KeyringType,
  type QbitSendPlanPrepareResult,
  type QbitSendPlanView,
} from '@qbit/wallet-shared'
import { AddressType, ChainType, NetworkType } from '@qbit/wallet-types'

import { keyringService, preferenceService, qbitSendGuardService } from '../src/services'
import { QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS } from '@qbit/keyring-service'

import {
  QBIT_SEND_PLAN_DRAFT_TTL_MS,
  QBIT_SEND_PLAN_TICK_MS,
  QBIT_SEND_PLAN_VIEW_REVISION_STRIDE,
} from '../src/services/qbitSendPlanEngine'
import {
  QBIT_RECENT_SPEND_GONE_GRACE_MS,
  type QbitSendGuardService,
} from '../src/services/qbitSendGuards'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
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
  anotherAccountsPlan,
  dappPsbtHex,
  inputsOfPsbt,
  isBroadcast,
  isLookup,
  newPlanGuard,
  nodeRejection,
  once,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// The engine's scenarios, over the harness in `qbit-send-plan-engine-harness`:
// the send guard and the plan store are the real services, the explorer a
// fake served over fetch, and the keyring a fake of the keyring service.
const lockState = vi.hoisted(() => ({ isUnlocked: true }))
// Each world, and each restart, gets a send guard of its own, as a new
// service worker does; the controller reaches it through this holder.
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
/** Every world of the running scenario. */
let worlds: World[] = []

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

/** A new world, with nothing in the guard and the keyring service answering for its keyring. */
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

afterEach(async () => {
  for (const each of worlds) each.assertGuarantees()
  worlds = []
  if (world?.wallet) world.engine.reset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a send plan, end to end', () => {
  it('pays an exact amount with change through one merge, once the merge confirmed', async () => {
    world.fund(150, 100_000)
    await world.open()

    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(review.merges).toHaveLength(1)
    expect(review.change).toBeGreaterThan(0)
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started).toMatchObject({ ok: true, plan: { phase: 'signing' } })
    await world.settle()

    // Every merge went out as it was signed; the payment is signed and waits.
    let plan = await world.plan()
    expect(plan).toMatchObject({ phase: 'waiting' })
    expect(plan!.steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    world.assertRecipientGuarantees(undefined)

    world.mine()
    await world.tick()
    plan = await world.plan()
    expect(plan).toMatchObject({ phase: 'completed', actions: ['dismiss'] })
    world.assertRecipientGuarantees(12_000_000)

    // To the bit: the review's figures are what the accepted transactions pay.
    const payment = world.tx(review.payment.txid)
    expect(world.feeOf(plan!.steps[0]!.txid)).toBe(review.merges[0]!.fee)
    expect(world.feeOf(payment.txid)).toBe(review.payment.fee)
    expect(review.totalFee).toBe(review.merges[0]!.fee + review.payment.fee)
    expect(payment.outputs.at(-1)).toMatchObject({ value: review.change })
  })
})

describe('a send plan, end to end (more shapes)', () => {
  it('sends everything through two merges, the recipient receiving exactly what the review said', async () => {
    world.fund(250, 100_000)
    await world.open()

    const review = await world.review({ target: { kind: 'everything' } })
    expect(review.merges).toHaveLength(2)
    expect(review.change).toBe(0)
    expect(review.signatureCount).toBe(250 + 2)
    expect(review.signatureBudget).toMatchObject({ required: 252, cached: 0 })
    expect(review.amount + review.totalFee + review.leftBehindSatoshis).toBe(250 * 100_000)
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started.ok).toBe(true)
    await world.settle()
    world.mine()
    await world.tick()

    const plan = await world.plan()
    expect(plan).toMatchObject({ phase: 'completed', amount: review.amount })
    world.assertRecipientGuarantees(review.amount)
    plan!.steps.slice(0, -1).forEach((step, index) => {
      expect(world.feeOf(step.txid)).toBe(review.merges[index]!.fee)
    })
    expect(world.feeOf(review.payment.txid)).toBe(review.payment.fee)
    expect(world.tx(review.payment.txid).outputs).toEqual([
      { address: RECIPIENT, script: RECIPIENT_SCRIPT, value: review.amount },
    ])
  })

  it('signs and sends four merges, then the payment', async () => {
    world.fund(430, 100_000)
    await world.open()

    const review = await world.review({ target: { kind: 'everything' } })
    expect(review.merges).toHaveLength(4)
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    expect(world.keyring.signed).toHaveLength(5)
    world.mine()
    await world.tick()

    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('waits for the last merge to confirm before the payment goes, whatever order they confirm in', async () => {
    world.fund(250, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    const [first, second] = plan.steps
    const firstInputs = (await world.plan())!.steps[0]!.inputCount
    expect(firstInputs).toBe(106)

    world.mine([second!.txid])
    await world.tick()
    let view = await world.plan()
    expect(view).toMatchObject({ phase: 'waiting' })
    expect(view!.steps.map(step => step.status)).toEqual(['broadcast', 'confirmed', 'signed'])
    world.assertRecipientGuarantees(undefined)

    await world.tick()
    world.mine([first!.txid])
    await world.tick()
    view = await world.plan()
    expect(view).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(view!.amount)
  })

  it('holds what the plan needs, lets go of a merge’s inputs once it confirmed, and of everything once the payment confirmed', async () => {
    const outpoints = world.fund(250, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    const held = await world.planHeld()
    // Every input of every step and output 0 of every merge.
    expect(held.size).toBe(250 + 2)
    expect(held.has(`${plan.steps[0]!.txid}:0`)).toBe(true)

    world.mine([plan.steps[0]!.txid])
    await world.tick()
    const narrowed = await world.planHeld()
    expect(narrowed.size).toBe(250 + 2 - 106)
    expect(outpoints.slice(0, 1).some(key => narrowed.has(key))).toBe(false)

    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    // The payment's inputs stay held until it confirms.
    expect((await world.planHeld()).size).toBe(40)
    world.mine()
    await world.tick()
    await world.plan()
    expect((await world.planHeld()).size).toBe(0)
  })
})

describe('pricing and refusals', () => {
  it('refuses an amount the balance cannot cover, with the largest it can send and what is unconfirmed', async () => {
    world.fund(150, 100_000)
    world.ownChange(150_000)
    await world.open()

    const result = await world.prepare({ target: { kind: 'amount', amount: 15_000_000 } })
    expect(result).toMatchObject({
      ok: false,
      reason: 'insufficient_balance',
      unconfirmedSatoshis: 150_000,
    })
    const maxSendable = (result as { maxSendable: number }).maxSendable
    expect(maxSendable).toBeGreaterThan(0)
    // The largest amount is a plan the wallet can make.
    const largest = await world.review({ target: { kind: 'amount', amount: maxSendable } })
    expect(largest.amount).toBe(maxSendable)
    const everything = await world.review({ target: { kind: 'everything' } })
    expect(everything.amount).toBe(maxSendable)
  })

  it('says not needed when one transaction carries the payment, with the largest it can send', async () => {
    world.fund(150, 100_000)
    await world.open()

    const small = await world.prepare({ target: { kind: 'amount', amount: 1_000_000 } })
    expect(small).toMatchObject({ ok: false, reason: 'not_needed' })
    expect((small as { maxSendable: number }).maxSendable).toBeGreaterThan(1_000_000)

    const fewer = freshWorld()
    world = fewer
    fewer.fund(100, 100_000)
    await fewer.open()
    expect(await fewer.prepare({ target: { kind: 'everything' } })).toMatchObject({
      ok: false,
      reason: 'not_needed',
    })
  })

  it('reports a plan already open, and outputs it cannot read', async () => {
    world.fund(150, 100_000)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(await world.prepare({ target: { kind: 'amount', amount: 12_000_000 } })).toMatchObject({
      ok: false,
      reason: 'plan_open',
    })

    const unreadable = freshWorld()
    world = unreadable
    unreadable.fund(150, 100_000)
    await unreadable.open()
    unreadable.explorer.failures.push(({ path }) =>
      path.startsWith('/address/') ? { status: 400, body: 'listing refused' } : undefined
    )
    expect(
      await unreadable.prepare({ target: { kind: 'amount', amount: 12_000_000 } })
    ).toMatchObject({ ok: false, reason: 'outputs_unavailable', maxSendable: 0 })
  })

  it('validates every field of the request at the boundary', async () => {
    world.fund(150, 100_000)
    await world.open()
    const amount = { kind: 'amount', amount: 12_000_000 }
    const mainnet = p2mrAddressFromPubkey(hexToBytes('44'.repeat(32)), 'mainnet')
    const notP2mr = transactionCore.payments.p2wpkh({
      hash: Buffer.alloc(20, 1),
      network: toPsbtNetwork(NetworkType.REGTEST),
    }).address!
    const refused: [string, Record<string, unknown>][] = [
      ['a fee rate that crossed the port as NaN', { target: amount, feeRate: null }],
      ['an infinite fee rate', { target: amount, feeRate: Infinity }],
      ['a negative fee rate', { target: amount, feeRate: -1 }],
      ['a fee rate below the relay floor', { target: amount, feeRate: 0.1 }],
      ['a fee rate above policy', { target: amount, feeRate: 10_001 }],
      ['an amount that crossed the port as NaN', { target: { kind: 'amount', amount: null } }],
      ['an infinite amount', { target: { kind: 'amount', amount: Infinity } }],
      ['a negative amount', { target: { kind: 'amount', amount: -5 } }],
      ['a fractional amount', { target: { kind: 'amount', amount: 12_000_000.5 } }],
      ['an amount below dust', { target: { kind: 'amount', amount: 1 } }],
      ['an unknown target', { target: { kind: 'most' } }],
      ['no target', { target: null }],
      ['an address of another network', { target: amount, to: mainnet }],
      ['an address that is not P2MR', { target: amount, to: notP2mr }],
      ['no address', { target: amount, to: null }],
      ['enableRBF that is not a boolean', { target: amount, enableRBF: null }],
      ['a memo that is not text', { target: amount, memo: 5 }],
      ['memos that are not text', { target: amount, memos: ['ok', 5] }],
      [
        'a merge fee raise of a plan that is not open',
        { target: amount, revise: { planId: 'a'.repeat(32), kind: 'raise_merge_fee' } },
      ],
      [
        'a payment fee raise of a plan that is not open',
        { target: amount, revise: { planId: 'a'.repeat(32), kind: 'raise_payment_fee' } },
      ],
      [
        'a revision of an unknown kind',
        { target: amount, revise: { planId: 'a'.repeat(32), kind: 'x' } },
      ],
    ]
    for (const [label, params] of refused) {
      await expect(world.prepare(params), label).rejects.toThrow()
    }
    await expect(world.wallet.prepareQbitSendPlan(null as never)).rejects.toThrow()
    // The boundaries themselves pass.
    expect(await world.prepare({ target: amount, feeRate: 0.25 })).toMatchObject({ ok: true })
    expect(await world.prepare({ target: amount, feeRate: 10_000 })).toMatchObject({
      ok: false,
      reason: 'insufficient_balance',
    })
  })

  it('starts the plan of an account whose P2MR key is recorded empty, signing with the account’s key as prepare did', async () => {
    world.fund(150, 100_000)
    await world.open()
    const emptyP2mrKey = { ...account, p2mr: { ...account.p2mr, pubkey: '' } }
    vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(emptyP2mrKey as never)
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(qbitSendPlanStore.list()[0]!.account.pubkey).toBe(account.pubkey)
    world.mine()
    await world.tick()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('refuses to start a draft that expired, or after a lock, and a start while locked', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    vi.setSystemTime(review.expiresAt + 1)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(await world.wallet.startQbitSendPlan('nope')).toEqual({
      ok: false,
      reason: 'draft_expired',
    })

    const again = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    world.keyring.unlock()
    lockState.isUnlocked = false
    expect(await world.wallet.startQbitSendPlan(again.draftId)).toEqual({
      ok: false,
      reason: 'locked',
    })
    lockState.isUnlocked = true
    await world.wallet.lockWallet()
    world.keyring.unlock()
    expect(await world.wallet.startQbitSendPlan(again.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(world.storedPlans()).toEqual([])
    expect((await world.reserved()).size).toBe(0)
  })
})

/** How many times the explorer was handed transaction `txid`. */
function broadcastsOf(txid: string): number {
  return world.explorer.accepted.filter(item => item.txid === txid).length
}

describe('failure rules', () => {
  async function oneMergePlan(): Promise<QbitSendPlanView> {
    world.fund(150, 100_000)
    await world.open()
    return world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
  }

  it('sends a merge proven not sent again, the same bytes a tick later, and goes on', async () => {
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? nodeRejection('mempool min fee not met') : undefined))
    )
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const merge = plan.steps[0]!.txid

    let view = await world.plan()
    expect(view!.steps.map(step => step.status)).toEqual(['planned', 'planned'])
    expect(view!.phase).toBe('signing')
    expect(broadcastsOf(merge)).toBe(0)

    await world.tick()
    view = await world.plan()
    expect(view!.steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    // The same transaction, signed once.
    expect(view!.steps[0]!.txid).toBe(merge)
    expect(world.keyring.signed.filter(txid => txid === merge)).toHaveLength(1)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('pauses merge_refused once the same merge keeps being refused, and outputs_spent when its inputs are gone', async () => {
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(request =>
      isBroadcast(request) ? nodeRejection('mempool min fee not met') : undefined
    )
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    await world.tick()
    await world.tick()
    const view = await world.plan()
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'merge_refused' },
      actions: ['replan', 'cancel'],
    })
    expect(view!.pause!.detail).toContain('mempool min fee not met')
    world.assertRecipientGuarantees(undefined)

    world = freshWorld()
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(request =>
      isBroadcast(request) ? nodeRejection('bad-txns-inputs-missingorspent') : undefined
    )
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    await world.tick()
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
    })
  })

  it('looks a merge whose outcome is unknown up, and records it once found, sending nothing again', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    world.explorer.failures.push(
      once(request =>
        isBroadcast(request)
          ? { status: 502, body: 'bad gateway', afterAccepting: true }
          : undefined
      ),
      request => (isLookup(request) ? { status: 400, body: 'lookup refused' } : undefined)
    )
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    if (!started.ok) throw new Error('not started')
    const plan = started.plan
    await world.settle()
    let view = await world.plan()
    expect(view!.steps.map(step => step.status)).toEqual(['unknown', 'signed'])
    expect(view!.phase).toBe('waiting')

    world.explorer.failures.length = 0
    await world.tick()
    view = await world.plan()
    expect(view!.steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    expect(broadcastsOf(plan.steps[0]!.txid)).toBe(1)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('sends a merge whose outcome was unknown again only once every lookup missed it for the grace period', async () => {
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(request =>
      isBroadcast(request) ? new TypeError('fetch failed') : undefined
    )
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const merge = plan.steps[0]!.txid
    expect((await world.plan())!.steps[0]!.status).toBe('unknown')

    world.explorer.failures.length = 0
    await world.tick()
    // Missed, but not for long enough: nothing is sent.
    expect((await world.plan())!.steps[0]!.status).toBe('unknown')
    expect(broadcastsOf(merge)).toBe(0)

    await world.tick(10 * 60_000)
    const view = await world.plan()
    expect(view!.steps[0]!.status).toBe('broadcast')
    expect(broadcastsOf(merge)).toBe(1)
    expect(world.keyring.signed.filter(txid => txid === merge)).toHaveLength(1)
  })

  it('counts a merge absent from the first miss of a run of misses, never from when it was last seen', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const merge = plan.steps[0]!.txid
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    // For twenty minutes no lookup of the merge has an answer.
    world.explorer.failures.push(request =>
      isLookup(request) && request.path.includes(merge)
        ? { status: 400, body: 'lookup refused' }
        : undefined
    )
    await world.tick(20 * 60_000)
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    // Then the lookups answer, and the merge has left the mempool. Last seen
    // twenty minutes ago, it is not absent at this first miss: the grace
    // runs from it.
    world.explorer.failures.length = 0
    world.explorer.removeTx(merge)
    await world.tick()
    for (let minute = 1; minute < 10; minute++) {
      await world.tick(60_000)
      expect(broadcastsOf(merge), `${minute} min into the run`).toBe(1)
    }
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    // Missed by every lookup for the whole grace: it goes out again from the
    // bytes in memory.
    await world.tick(60_000)
    expect(broadcastsOf(merge)).toBe(2)
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    expect(world.keyring.signed.filter(txid => txid === merge)).toHaveLength(1)
    world.assertRecipientGuarantees(12_000_000)
  })

  it('starts the grace again when a lookup finds the merge in the middle of a run of misses', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const merge = plan.steps[0]!.txid
    const miss = (request: { method: string; path: string }) =>
      isLookup(request) && request.path.includes(merge)
        ? { status: 404, body: 'not found' }
        : undefined
    world.explorer.failures.push(miss)
    await world.tick()
    await world.tick(6 * 60_000)
    // Found once, six minutes into the run: the run is over.
    world.explorer.failures.length = 0
    await world.tick()
    world.explorer.failures.push(miss)
    await world.tick(6 * 60_000)
    await world.tick()
    // Twelve minutes after the first miss, but six after the run began.
    expect(broadcastsOf(merge)).toBe(1)
    expect(world.pushed.filter(txid => txid === merge)).toHaveLength(1)
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    world.explorer.failures.length = 0
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('reconciles a lost answer on a merge and on the payment by lookup: nothing is signed or sent twice', async () => {
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? 'accept-then-fail' : undefined))
    )
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    expect((await world.plan())!.steps.map(step => step.status)).toEqual(['broadcast', 'signed'])

    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? 'accept-then-fail' : undefined))
    )
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    for (const step of plan.steps) {
      expect(world.keyring.signed.filter(txid => txid === step.txid)).toHaveLength(1)
      expect(broadcastsOf(step.txid)).toBe(1)
    }
    world.assertRecipientGuarantees(12_000_000)
  })

  it('holds the payment back while a merge it spends is reorganised out, and sends a merge gone for good again', async () => {
    world.fund(250, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    const [first, second] = plan.steps
    world.mine([first!.txid])
    await world.tick()
    expect((await world.plan())!.steps[0]!.status).toBe('confirmed')

    // A reorganisation puts the first merge back in the mempool.
    delete world.tx(first!.txid).height
    world.mine([second!.txid])
    await world.tick()
    let view = await world.plan()
    expect(view).toMatchObject({ phase: 'waiting' })
    expect(view!.steps.map(step => step.status)).toEqual(['broadcast', 'confirmed', 'signed'])
    world.assertRecipientGuarantees(undefined)

    // Then it leaves the mempool altogether: once proven absent it goes out
    // again, the same bytes, without the plan's hold on inputs it let go of.
    world.explorer.removeTx(first!.txid)
    await world.tick()
    await world.tick(10 * 60_000)
    view = await world.plan()
    expect(view!.steps[0]!.status).toBe('broadcast')
    expect(broadcastsOf(first!.txid)).toBe(2)
    world.assertRecipientGuarantees(undefined)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(view!.amount)
  })

  it('pauses outputs_spent when something other than the payment spends a merge output', async () => {
    const plan = await oneMergePlan()
    const merge = plan.steps[0]!.txid
    world.mine()
    world.explorer.addTx({
      txid: fakeTxid(999_999, 1),
      inputs: [{ txid: merge, vout: 0 }],
      outputs: [{ address: PAYER, script: PAYER_SCRIPT, value: 1_000 }],
    })
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: ['replan', 'cancel'],
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('pauses payment_fee_too_low on a fee refusal, and continue sends the same bytes again', async () => {
    const plan = await oneMergePlan()
    world.mine()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? nodeRejection('min relay fee not met') : undefined))
    )
    await world.tick()
    let view = await world.plan()
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_fee_too_low' },
      actions: ['raise_payment_fee', 'continue', 'cancel'],
    })
    expect(view!.steps.at(-1)!.status).toBe('signed')
    world.assertRecipientGuarantees(undefined)

    view = await world.wallet.continueQbitSendPlan(plan.id)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    expect(world.keyring.signed.filter(txid => txid === plan.paymentTxid)).toHaveLength(1)
    world.assertRecipientGuarantees(12_000_000)
  })

  it.each([['in the same session'], ['after a restart']])(
    'takes one miss of a confirmed merge on continue, after a pause longer than the grace, for nothing (%s)',
    async session => {
      const plan = await oneMergePlan()
      const merge = plan.steps[0]!.txid
      world.mine()
      world.explorer.failures.push(
        once(request => (isBroadcast(request) ? nodeRejection('min relay fee not met') : undefined))
      )
      await world.tick()
      expect(await world.plan()).toMatchObject({
        phase: 'paused',
        pause: { reason: 'payment_fee_too_low' },
      })
      if (session === 'after a restart') {
        await world.restart()
        world.keyring.unlock()
      }
      // Paused for longer than the grace: a paused plan looks up no merge
      // that has confirmed.
      await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS + 60_000)
      await world.plan()
      const signed = world.keyring.signed.length
      const counter = world.keyring.counter
      const pushed = world.pushed.filter(txid => txid === merge).length

      // Continue: the first lookup of the merge misses once.
      world.explorer.failures.push(
        once(request =>
          isLookup(request) && request.path.includes(merge)
            ? { status: 404, body: 'not found' }
            : undefined
        )
      )
      await world.wallet.continueQbitSendPlan(plan.id)
      await world.settle()
      expect(await world.plan()).toMatchObject({ phase: 'waiting' })
      expect(world.storedStatuses()).toEqual(['unknown', 'signed'])

      // The next lookup finds it confirmed, and the payment goes.
      await world.tick()
      expect(await world.plan()).toMatchObject({ phase: 'completed' })
      expect(world.keyring.signed).toHaveLength(signed)
      expect(world.keyring.counter).toBe(counter)
      expect(world.pushed.filter(txid => txid === merge)).toHaveLength(pushed)
      world.assertRecipientGuarantees(12_000_000)
    }
  )

  it('pauses payment_refused on any other refusal, offering continue and replan', async () => {
    await oneMergePlan()
    world.mine()
    world.explorer.failures.push(request =>
      isBroadcast(request) ? nodeRejection('non-mandatory-script-verify-flag (bad)') : undefined
    )
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue', 'replan', 'cancel'],
    })
    world.assertRecipientGuarantees(undefined)
  })

  it('reads the merges afresh immediately before the payment goes: one reorganised out within the tick holds it back until it confirms again', async () => {
    const plan = await oneMergePlan()
    const merge = plan.steps[0]!.txid
    world.mine()
    // The waiting step reads the merge confirmed; the block is reorganised
    // out right after, within the same tick, before the payment would go.
    const fetch = world.explorer.fetch.bind(world.explorer)
    let reorganised = false
    vi.spyOn(world.explorer, 'fetch').mockImplementation(async (input, init) => {
      const response = await fetch(input, init)
      if (!reorganised && String(input).includes(`/tx/${merge}`)) {
        reorganised = true
        delete world.tx(merge).height
      }
      return response
    })
    await world.tick()
    expect(reorganised).toBe(true)
    expect(world.explorer.accepted.map(tx => tx.txid)).not.toContain(plan.paymentTxid)
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    // Confirmed again, the merge lets the payment go.
    world.mine()
    for (let tick = 0; tick < 3 && (await world.plan())?.phase !== 'completed'; tick++) {
      await world.tick()
    }
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    expect(world.explorer.accepted.map(tx => tx.txid)).toContain(plan.paymentTxid)
    world.assertRecipientGuarantees(12_000_000)
  })

  it('goes back to waiting when the node refuses the payment for an unconfirmed parent', async () => {
    await oneMergePlan()
    world.mine()
    world.explorer.failures.push(
      once(request => (isBroadcast(request) ? nodeRejection('too-long-mempool-chain') : undefined))
    )
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    // Not sent again before the next tick.
    await world.plan()
    expect(world.explorer.requests.filter(isBroadcast)).toHaveLength(2)
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
  })

  it('keeps a payment whose outcome is unknown unknown, looks it up, and never rebuilds it', async () => {
    const plan = await oneMergePlan()
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
    let view = await world.plan()
    expect(view).toMatchObject({ phase: 'sending', actions: [] })
    expect(view!.steps.at(-1)!.status).toBe('unknown')
    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toMatchObject({
      phase: 'sending',
    })

    world.explorer.failures.length = 0
    await world.tick()
    view = await world.plan()
    expect(view).toMatchObject({ phase: 'completed' })
    expect(broadcastsOf(plan.paymentTxid)).toBe(1)
    expect(world.keyring.signed.filter(txid => txid === plan.paymentTxid)).toHaveLength(1)
    world.assertRecipientGuarantees(12_000_000)
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

/** The keyring's next preflight waits until `release`; `reached` resolves once it began. */
function gateNextPreflight(): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  let arrived: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrived = resolve))
  const preflight = world.keyring.preflightP2mrPsbtSigning
  vi.mocked(keyringService.preflightP2mrPsbtSigning).mockImplementationOnce((async (
    ...args: Parameters<typeof preflight>
  ) => {
    arrived()
    await gate
    return preflight(...args)
  }) as never)
  return { reached, release }
}

describe('restart', () => {
  it('pauses a plan found signing as interrupted, and continue finishes it', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(2, 50)
    await world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    world.keyring.beforeInput = undefined
    const signedBefore = world.keyring.signed.length

    // The restart left the wallet locked: Continue waits for the unlock.
    let view = await world.plan()
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      actions: ['cancel'],
    })
    expect(view!.steps.map(step => step.status)).toEqual(['broadcast', 'planned', 'planned'])
    await world.tick()
    expect(world.keyring.signed).toHaveLength(signedBefore)

    world.keyring.unlock()
    expect((await world.plan())!.actions).toEqual(['continue', 'cancel'])
    view = await world.wallet.continueQbitSendPlan(view!.id)
    await world.settle()
    view = await world.plan()
    expect(view).toMatchObject({ phase: 'waiting' })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('continues after a restart from the figures it finds, and a lock after that goes on by itself after the unlock', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(1, 60)
    void world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    world.keyring.beforeInput = undefined
    expect(world.keyring.counter).toBe(60)

    world.keyring.unlock()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ pause: { reason: 'interrupted' } })
    // Continue approves what is left as it stands: the merge cut short at 60
    // inputs needs all 106 again.
    let locked = false
    world.keyring.beforeInput = (_txid, index) => {
      if (!locked && index === 30) {
        locked = true
        void world.wallet.lockWallet()
      }
    }
    await world.wallet.continueQbitSendPlan(paused.id)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({ pause: { reason: 'locked' } })
    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.counter).toBe(60 + 30 + review.signatureCount)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('reconciles a merge whose broadcast had no verdict before the restart: signed again in full when it never left', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    world.hang = 'drop'
    void world.wallet.startQbitSendPlan(review.draftId)
    await vi.waitFor(() => expect(world.storedStatuses()[0]).toBe('unknown'))
    world.hang = undefined
    await world.restart()
    const counterBefore = world.keyring.counter

    world.keyring.unlock()
    const plan = (await world.plan())!
    expect(plan.steps.map(step => step.status)).toEqual(['unknown', 'planned', 'planned'])
    await world.wallet.continueQbitSendPlan(plan.id)
    await world.settle()
    expect(world.storedStatuses()).toEqual(['unknown', 'broadcast', 'signed'])
    // Missed for the grace period: absent, signed again and sent. The
    // key's signature cache keeps its 16 most recent signatures, the
    // payment's by then, so every input of the merge is signed again.
    await world.tick()
    await world.tick(10 * 60_000)
    expect(world.storedStatuses()).toEqual(['broadcast', 'broadcast', 'signed'])
    expect(world.keyring.counter - counterBefore).toBe(
      106 + plan.steps[1]!.inputCount + plan.steps[2]!.inputCount
    )
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('pauses locked, and signs again by itself after the unlock, a merge continue approved that is proven absent while locked', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    world.hang = 'drop'
    void world.wallet.startQbitSendPlan(review.draftId)
    await vi.waitFor(() => expect(world.storedStatuses()[0]).toBe('unknown'))
    world.hang = undefined
    await world.restart()

    world.keyring.unlock()
    const plan = (await world.plan())!
    await world.wallet.continueQbitSendPlan(plan.id)
    await world.settle()
    expect(world.storedStatuses()).toEqual(['unknown', 'broadcast', 'signed'])
    // The first miss, then the wallet locks; the misses go on for the
    // whole grace, and the merge, whose bytes went with the restart, is
    // proven absent while the wallet is locked.
    await world.tick()
    await world.wallet.lockWallet()
    expect(lockState.isUnlocked).toBe(false)
    await world.tick(10 * 60_000)
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'locked' },
      actions: ['cancel'],
    })
    expect(world.storedStatuses()).toEqual(['planned', 'broadcast', 'signed'])

    // The unlock carries it on as the user's continue approved it: signed
    // again and sent, with no second continue.
    const signed = world.keyring.signed.length
    await world.unlock()
    expect(world.keyring.signed).toHaveLength(signed + 1)
    expect(world.storedStatuses()).toEqual(['broadcast', 'broadcast', 'signed'])
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('finds a merge the explorer took before the restart, and sends nothing again', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    world.hang = 'accept'
    void world.wallet.startQbitSendPlan(review.draftId)
    await vi.waitFor(() => expect(world.explorer.accepted).toHaveLength(1))
    world.hang = undefined
    await world.restart()

    world.keyring.unlock()
    const plan = (await world.plan())!
    await world.wallet.continueQbitSendPlan(plan.id)
    await world.settle()
    await world.tick()
    expect(world.storedStatuses()).toEqual(['broadcast', 'broadcast', 'signed'])
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    expect(broadcastsOf(plan.steps[0]!.txid)).toBe(1)
    expect(world.keyring.signed.filter(txid => txid === plan.steps[0]!.txid)).toHaveLength(1)
    world.assertRecipientGuarantees(review.amount)
  })

  it('carries a waiting plan on after a restart with the wallet locked: the signed payment goes out', async () => {
    world.fund(150, 100_000)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    await world.restart()
    expect(lockState.isUnlocked).toBe(false)
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })

    world.mine()
    await world.tick()
    expect(lockState.isUnlocked).toBe(false)
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('sends the stored payment again, locked, once a broadcast cut by the restart is proven absent', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    world.hang = 'drop'
    await world.tick(QBIT_SEND_PLAN_TICK_MS, { settle: false })
    await vi.waitFor(() => expect(world.storedStatuses()).toEqual(['confirmed', 'unknown']))
    world.hang = undefined
    await world.restart()

    expect(await world.plan()).toMatchObject({ phase: 'sending', actions: [] })
    await world.tick()
    expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
    await world.tick(10 * 60_000)
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    expect(lockState.isUnlocked).toBe(false)
    expect(world.keyring.signed.filter(txid => txid === plan.paymentTxid)).toHaveLength(1)
    world.assertRecipientGuarantees(12_000_000)
  })

  it('shows a completed plan after a restart until it is dismissed, with nothing left held', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    await world.tick()
    const before = (await world.plan())!
    expect(before.phase).toBe('completed')
    world.mine()

    await world.restart()
    const after = (await world.plan())!
    expect(after).toMatchObject({ phase: 'completed', actions: ['dismiss'] })
    expect(after.revision).toBeGreaterThan(before.revision)
    await world.wallet.dismissQbitSendPlan(plan.id)
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(await world.plan()).toBeNull()
  })

  it('starts a new plan over a completed one that a page’s read writes while the start takes its hold', async () => {
    world.fund(150, 100_000)
    await world.open()
    const first = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ id: first.id, phase: 'completed' })
    expect(world.storedStatuses().at(-1)).toBe('broadcast')
    world.fund(150, 100_000)
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })

    // While the start takes the new plan's hold, the completed plan's
    // payment confirms and a page's read writes it so.
    const guard = guardHolder.guard as QbitSendGuardService
    const hold = guard.holdOutpointsForPlan.bind(guard)
    vi.spyOn(guard, 'holdOutpointsForPlan').mockImplementationOnce(async entry => {
      world.mine()
      vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
      await world.plan()
      return hold(entry)
    })
    const revision = qbitSendPlanStore.get(first.id)!.revision
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started).toMatchObject({ ok: true, plan: { phase: 'signing' } })
    expect(qbitSendPlanStore.get(first.id)).toBeUndefined()
    // It was removed at the revision the read wrote, after the start read it.
    expect(world.events).toContainEqual({
      planId: first.id,
      revision: (revision + 2) * QBIT_SEND_PLAN_VIEW_REVISION_STRIDE,
    })
    await world.settle()
    // The recipient is paid once per scenario (`assertGuarantees`): this
    // plan stops before its payment.
    expect(await world.plan()).toMatchObject({
      phase: 'waiting',
      paymentTxid: review.payment.txid,
    })
  })

  it('shows a stored document of another version as one unreadable plan, which cancel drops', async () => {
    world.fund(150, 100_000)
    world.storage.values.set(
      QBIT_SEND_PLAN_STORE_KEY,
      JSON.stringify({ version: 2, plans: [{ id: 'a1'.repeat(16) }] })
    )
    await world.open()

    const view = await world.plan()
    expect(view).toMatchObject({
      id: 'unreadable',
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
    expect(await world.prepare({ target: { kind: 'amount', amount: 12_000_000 } })).toMatchObject({
      ok: false,
      reason: 'plan_open',
    })
    await expect(world.wallet.cancelQbitSendPlan('unreadable')).resolves.toBeNull()
    expect(JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)).toEqual({
      version: 1,
      plans: [],
    })
    expect(await world.prepare({ target: { kind: 'amount', amount: 12_000_000 } })).toMatchObject({
      ok: true,
    })
  })
})

describe('lock', () => {
  it('pauses on a lock in the middle of a merge, signs nothing locked, and goes on by itself after an unlock in the same session', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      if (signings === 1 && index === 30) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined

    let view = await world.plan()
    expect(view).toMatchObject({
      phase: 'paused',
      pause: { reason: 'locked' },
      actions: ['cancel'],
    })
    expect(world.keyring.counter).toBe(30)
    await world.tick()
    expect(world.keyring.counter).toBe(30)

    await world.unlock()
    view = await world.plan()
    expect(view).toMatchObject({ phase: 'waiting' })
    // The merge is signed again from its first input, and the cache, which
    // keeps the key's 16 most recent signatures, serves none of the 30
    // made before the lock: they are made again.
    expect(world.keyring.counter).toBe(review.signatureCount + 30)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('goes on by itself after an unlock whatever the cache serves: within its first 16 inputs nothing is signed twice', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    world.keyring.beforeInput = (_txid, index) => {
      if (world.keyring.signed.length === 0 && index === 12) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({ pause: { reason: 'locked' } })

    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    // The 12 signatures made before the lock came from the cache.
    expect(world.keyring.counter).toBe(review.signatureCount)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('goes on by itself when the lock came between an input’s counter unit and its signature', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    world.keyring.afterReserve = (_txid, index) => {
      if (world.keyring.signed.length === 0 && index === 40) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.afterReserve = undefined
    expect(await world.plan()).toMatchObject({ pause: { reason: 'locked' } })
    // 40 signatures, and the unit of the 41st that the lock cut off.
    expect(world.keyring.counter).toBe(41)

    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.counter).toBe(review.signatureCount + 41)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('waits for continue after an unlock when another request signed with the key in between', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    world.keyring.beforeInput = (_txid, index) => {
      if (world.keyring.signed.length === 0 && index === 30) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined

    // Unlocked, and a website's request signs once before the plan goes on.
    // The lock stopped the plan's signing before its next input took a
    // unit, so that one unit is another request's.
    world.keyring.unlock()
    world.keyring.signElsewhere(1)
    world.engine.onUnlock()
    await world.settle()
    const view = (await world.plan())!
    expect(view).toMatchObject({
      phase: 'paused',
      pause: {
        reason: 'interrupted',
        detail: 'The signature budget changed since the plan was approved',
      },
      actions: ['continue', 'cancel'],
    })
    expect(world.keyring.counter).toBe(31)

    // Continue approves the figures as they are now.
    await world.wallet.continueQbitSendPlan(view.id)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.counter).toBe(review.signatureCount + 31)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('pauses locked, signing nothing, when the wallet locks while the signature batch reopens, and goes on after the unlock', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    // A lock cuts the first merge's signing short at its 30th input.
    let locked = false
    world.keyring.beforeInput = (_txid, index) => {
      if (!locked && index === 30) {
        locked = true
        void world.wallet.lockWallet()
      }
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({ pause: { reason: 'locked' } })
    const signed = world.keyring.signed.length
    const counter = world.keyring.counter

    // The unlock sets the signing going again, which reopens a batch; the
    // wallet locks again while the batch's first preflight waits.
    const preflight = gateNextPreflight()
    world.keyring.unlock()
    world.engine.onUnlock()
    await preflight.reached
    await world.wallet.lockWallet()
    preflight.release()
    await world.settle()
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.keyring.counter).toBe(counter)
    expect(world.keyring.batches.size).toBe(0)
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })

    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('never counts the signatures done back across a lock and unlock', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const counts: number[] = []
    const record = async (): Promise<void> => {
      counts.push((await world.wallet.getQbitSendPlan())!.signaturesDone)
    }
    let locked = false
    world.keyring.beforeInput = async (_txid, index) => {
      // Read while the first merge signs, the second time from its first input.
      if (index % 10 === 0) await record()
      if (!locked && index === 50) {
        locked = true
        void world.wallet.lockWallet()
      }
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    await record()
    expect(counts.at(-1)).toBe(50)
    await world.unlock()
    world.keyring.beforeInput = undefined
    await record()
    expect(counts.at(-1)).toBe(review.signatureCount)
    // Every read during the second signing of the merge still showed 50 or
    // more, never the 0 to 49 it signed again.
    expect(counts.every((count, index) => index === 0 || count >= counts[index - 1]!)).toBe(true)
    expect(counts.filter(count => count === 50).length).toBeGreaterThan(1)
  })

  it('pauses on a lock while the payment is signed, and goes on after the unlock', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      if (signings === 2 && index === 5) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })
    expect(world.storedStatuses()).toEqual(['broadcast', 'planned'])

    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.counter).toBe(review.signatureCount)
  })

  it('needs no unlock once the payment is signed: a lock while waiting changes nothing', async () => {
    world.fund(150, 100_000)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    await world.wallet.lockWallet()
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  /**
   * A plan paused for `reason` with the wallet locked, set up as the user
   * would meet it: after a restart that cut its signing short
   * (`interrupted`), refused by the network in the session that started
   * it and the wallet locked since (`payment_refused`, `payment_fee_too_low`),
   * or stored with a version of its payment that may still confirm and the
   * browser restarted (`merge_refused`, `outputs_spent`, where Continue is
   * what it offers). Resolves to its id and the amount it pays.
   */
  async function pausedWhileLocked(reason: string): Promise<{ planId: string; amount: number }> {
    if (reason === 'interrupted') {
      world.fund(250, 100_000)
      await world.open()
      const review = await world.review({ target: { kind: 'everything' } })
      world.keyring.beforeInput = (_txid, index) => {
        if (index === 3) void world.wallet.lockWallet()
      }
      await world.wallet.startQbitSendPlan(review.draftId)
      await world.settle()
      world.keyring.beforeInput = undefined
      await world.restart()
      return { planId: world.storedPlans()[0]!.id, amount: review.amount }
    }
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    if (reason === 'payment_refused' || reason === 'payment_fee_too_low') {
      const refusal =
        reason === 'payment_refused' ? 'non-mandatory-script-verify-flag' : 'min relay fee not met'
      world.explorer.failures.push(
        once(request => (isBroadcast(request) ? nodeRejection(refusal) : undefined))
      )
      await world.tick()
      expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason } })
      await world.wallet.lockWallet()
      await world.settle()
      return { planId: plan.id, amount: 12_000_000 }
    }
    const base = qbitSendPlanStore.list()[0]!
    const [merge, payment] = base.steps
    const record = {
      ...base,
      phase: 'paused',
      pause: { reason, at: Date.now() },
      steps: [
        { ...merge!, status: 'confirmed' },
        { ...payment!, status: 'signed', dispatch: 'unknown' },
      ],
    }
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify({ version: 1, plans: [record] }))
    await world.restart()
    return { planId: plan.id, amount: 12_000_000 }
  }

  it.each(['interrupted', 'payment_refused', 'payment_fee_too_low', 'merge_refused', 'outputs_spent'])(
    'offers and accepts continue only while the wallet is unlocked (%s): one while locked changes nothing, and the unlock signs and sends nothing until one made while unlocked',
    async reason => {
      const { planId, amount } = await pausedWhileLocked(reason)
      const locked = (await world.plan())!
      expect(locked).toMatchObject({ id: planId, phase: 'paused', pause: { reason } })
      expect(locked.actions).not.toContain('continue')

      const revision = qbitSendPlanStore.get(planId)!.revision
      const released = vi.mocked(keyringService.releaseP2mrPsbtSigningBatches).mock.calls.length
      const signed = world.keyring.signed.length
      const pushed = world.pushed.length
      await expect(world.wallet.continueQbitSendPlan(planId)).rejects.toThrow(
        'cannot continue while the wallet is locked'
      )
      await world.settle()
      expect(qbitSendPlanStore.get(planId)!.revision).toBe(revision)
      expect(vi.mocked(keyringService.releaseP2mrPsbtSigningBatches).mock.calls).toHaveLength(released)

      // The unlock authorises nothing: the plan waits for the user.
      await world.unlock()
      await world.tick()
      const unlocked = (await world.plan())!
      expect(unlocked).toMatchObject({ phase: 'paused', pause: { reason } })
      expect(unlocked.actions).toContain('continue')
      expect(world.keyring.signed).toHaveLength(signed)
      expect(world.pushed).toHaveLength(pushed)

      // A continue made while unlocked carries the plan on, to the payment.
      await world.wallet.continueQbitSendPlan(planId)
      await world.settle()
      for (let block = 0; block < 4 && (await world.plan())?.phase !== 'completed'; block++) {
        world.mine()
        await world.tick()
      }
      expect(await world.plan()).toMatchObject({ phase: 'completed' })
      world.assertRecipientGuarantees(amount)
    }
  )

  it('keeps a continue made while unlocked whose figures a lock kept from being read: the unlock reads them and signs on', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 3) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    await world.restart()
    await world.unlock()
    const view = (await world.plan())!
    expect(view).toMatchObject({ pause: { reason: 'interrupted' } })
    // The wallet locks right after the continue is written, before its
    // next advance reads the figures it approved.
    const continued = world.wallet.continueQbitSendPlan(view.id)
    await world.wallet.lockWallet()
    await continued
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })
    const signed = world.keyring.signed.length
    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.signed.length).toBeGreaterThan(signed)
  })
})

/**
 * The keyring service locks the wallet on its own, as it does when an
 * address-type change cannot be rolled back (`setLocked`, which emits
 * `lock`), and the change fails: no `lockWallet` call.
 */
async function addressTypeChangeLocks(): Promise<void> {
  vi.spyOn(world.wallet, 'getCurrentKeyring').mockResolvedValue({
    type: KeyringType.HdKeyring,
    index: 0,
    accounts: [account],
  } as never)
  Object.assign(keyringService, {
    changeAddressType: vi.fn(async () => {
      await keyringService.setLocked()
      throw new Error('Address-type rollback failed')
    }),
  })
  await expect(world.wallet.changeAddressType(AddressType.P2MR)).rejects.toThrow(
    'Address-type rollback failed'
  )
  expect(lockState.isUnlocked).toBe(false)
}

describe('every lock reaches the plans once', () => {
  it('drops a draft at a lock the keyring makes on its own: a start after the next unlock answers draft_expired', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const onLock = vi.spyOn(world.engine, 'onLock')
    await addressTypeChangeLocks()
    expect(onLock).toHaveBeenCalledTimes(1)
    await world.unlock()
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
  })

  it('stops a signing at a lock the keyring makes on its own, before the next signature', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const onLock = vi.spyOn(world.engine, 'onLock')
    let locked = false
    let counterAtLock = 0
    // The keyring locks itself between two signatures of the first merge.
    world.keyring.beforeInput = async (_txid, index) => {
      if (index === 3 && !locked) {
        locked = true
        await addressTypeChangeLocks()
        counterAtLock = world.keyring.counter
      }
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(locked).toBe(true)
    expect(onLock).toHaveBeenCalledTimes(1)
    expect(world.keyring.counter).toBe(counterAtLock)
    expect(world.explorer.accepted).toEqual([])
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })
    // Authorised in this session, the signing goes on by itself after the unlock.
    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    world.assertRecipientGuarantees(undefined)
  })

  it('reaches the plans once on the ordinary lock and on the auto-lock, not again from the keyring’s event', async () => {
    world.fund(150, 100_000)
    await world.open()
    const onLock = vi.spyOn(world.engine, 'onLock')
    await world.wallet.lockWallet()
    expect(onLock).toHaveBeenCalledTimes(1)
    await world.unlock()
    const wallet = world.wallet as unknown as { autoLock(): Promise<void> }
    await wallet.autoLock()
    expect(lockState.isUnlocked).toBe(false)
    expect(onLock).toHaveBeenCalledTimes(2)
  })
})

/** Assert what every cancel and completion leaves: nothing held, nothing stored but a completed plan, the rest spendable. */
async function assertNothingLeftHeld(): Promise<void> {
  expect((await world.planHeld()).size).toBe(0)
  for (const plan of world.storedPlans()) expect(plan.phase).toBe('completed')
  const send = await world.wallet.createSendAllQbitPsbt({ to: PAYER, feeRate: 1 })
  expect(inputsOfPsbt(send.psbtHex).length).toBeGreaterThan(0)
}

describe('nothing else spends what a plan holds (guarantee 6)', () => {
  async function openPlan(): Promise<{ plan: QbitSendPlanView; held: Set<string> }> {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    return { plan, held: await world.planHeld() }
  }

  it('keeps an ordinary send, a send-all and a consolidation batch off the plan’s outputs', async () => {
    const { held } = await openPlan()
    expect(held.size).toBeGreaterThan(100)
    const send = await world.wallet.createSendQbitPsbt({ to: PAYER, amount: 500_000, feeRate: 1 })
    expect(inputsOfPsbt(send.psbtHex).filter(key => held.has(key))).toEqual([])
    const all = await world.wallet.createSendAllQbitPsbt({ to: PAYER, feeRate: 1 })
    expect(inputsOfPsbt(all.psbtHex).filter(key => held.has(key))).toEqual([])
    const batch = await world.wallet
      .createQbitConsolidationPsbt({ feeRate: 1 })
      .catch(error => error)
    if (batch instanceof Error) {
      expect(batch.message).toBeTruthy()
    } else {
      expect(inputsOfPsbt(batch.psbtHex).filter(key => held.has(key))).toEqual([])
    }
    // The recovery migration reads the same reservations, and its signing
    // passes the same check.
    const reserved = await world.reserved()
    expect([...held].every(key => reserved.has(key))).toBe(true)
    const [txid, vout] = [...held][0]!.split(':')
    await expect(
      qbitSendGuardService.runWithNoOverlap(
        CHAIN,
        [{ txid: txid!, vout: Number(vout) }],
        async () => 'signed'
      )
    ).rejects.toThrow('held by an open send plan')
  })

  it('refuses a website’s send and sign requests over the plan’s outputs, and a fee bump of its merge', async () => {
    const { plan } = await openPlan()
    const merge = world.storedPlans()[0]!.steps[0]!
    const inputs = inputsOfPsbt(merge.unsignedPsbtHex)
    const [txid, vout] = inputs[0]!.split(':')
    await expect(
      world.wallet.openQbitProviderSendRequest({
        chain: CHAIN,
        address: account.address,
        origin: 'https://dapp.example',
        txid: 'ab'.repeat(32),
        outpoints: [{ txid: txid!, vout: Number(vout) }],
      })
    ).rejects.toThrow('held by an open send plan')
    await expect(
      world.wallet.prepareQbitProviderPsbt(merge.unsignedPsbtHex, {} as never)
    ).rejects.toThrow('held by an open send plan')
    await expect(qbitSendGuardService.hasDependentSpend(CHAIN, plan.steps[0]!.txid)).resolves.toBe(
      true
    )
    const bump = await world.wallet
      .getQbitFeeBumpEligibility(plan.steps[0]!.txid)
      .catch(error => error)
    expect(bump instanceof Error ? true : bump.eligible).not.toBe(true)
  })

  it('refuses to start a plan over outputs a pending ordinary send claimed', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    // An ordinary send signs over the largest output, which the plan's draft
    // spends too, and keeps its claim while it waits for its broadcast.
    const send = await world.wallet.createSendQbitPsbt({ to: PAYER, amount: 50_000, feeRate: 1 })
    const signed = await world.wallet.signPsbtV2(send)
    expect(signed.qbitSendBroadcastClaim).toBeDefined()
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'outputs_changed',
    })
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
  })
})

/**
 * The next write of the plan store whose document `matches` waits until
 * `release`; `reached` resolves once it is held. Every later write of the
 * store queues behind it, as behind any write still in flight.
 */
function holdStoreWrite(matches: (document: { plans: { steps: { status: string }[] }[] }) => boolean): {
  reached: Promise<void>
  release: () => void
} {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  let arrived: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrived = resolve))
  const set = world.storage.set.bind(world.storage)
  let held = false
  vi.spyOn(world.storage, 'set').mockImplementation(async (key, value) => {
    if (!held && key === QBIT_SEND_PLAN_STORE_KEY && matches(value as never)) {
      held = true
      arrived()
      await gate
    }
    return set(key, value)
  })
  return { reached, release }
}

describe('a cancel and a merge being sent', () => {
  const firstMergeUnknown = (document: { plans: { steps: { status: string }[] }[] }): boolean =>
    document.plans[0]?.steps[0]?.status === 'unknown'

  it('sends nothing of a merge whose write-ahead a cancel lands in: the plan cancels, and lets go once the merge is proven absent', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const writeAhead = holdStoreWrite(firstMergeUnknown)
    await world.wallet.startQbitSendPlan(review.draftId)
    await writeAhead.reached
    // The merge is signed and being written ahead as `unknown` when the user cancels.
    const cancelled = world.wallet.cancelQbitSendPlan(world.storedPlanId()!)
    writeAhead.release()
    await expect(cancelled).resolves.toMatchObject({ phase: 'cancelling' })
    await world.settle()
    expect(world.explorer.accepted).toEqual([])
    // Proven absent once its misses last the grace, the merge holds nothing more.
    await world.tick()
    await world.tick(10 * 60_000)
    expect(world.explorer.accepted).toEqual([])
    expect(world.storedPlans()).toEqual([])
    await assertNothingLeftHeld()
    world.assertRecipientGuarantees(undefined)
  })

  it('sends nothing when the cancel lands before the merge is written ahead: it is never marked', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    let cancelled: Promise<unknown> | undefined
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 105 && !cancelled) {
        cancelled = world.wallet.cancelQbitSendPlan(world.storedPlanId()!)
      }
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    await expect(cancelled).resolves.toBeNull()
    expect(world.explorer.accepted).toEqual([])
    expect(world.storedPlans()).toEqual([])
    await assertNothingLeftHeld()
    world.assertRecipientGuarantees(undefined)
  })

  it('lets a merge whose broadcast is under way go, and the cancel waits for it to be found', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    let release: () => void = () => undefined
    world.gate = new Promise(resolve => (release = resolve))
    await world.wallet.startQbitSendPlan(review.draftId)
    // The explorer has taken the merge; the answer is still on its way.
    await vi.waitFor(() => expect(world.explorer.accepted).toHaveLength(1))
    const merge = qbitSendPlanStore.list()[0]!.steps[0]!
    const cancelled = world.wallet.cancelQbitSendPlan(world.storedPlanId()!)
    world.gate = undefined
    release()
    await expect(cancelled).resolves.toMatchObject({ phase: 'cancelling' })
    await world.settle()
    await world.tick()
    expect(world.explorer.accepted.map(tx => tx.txid)).toEqual([merge.txid])
    expect(world.storedPlans()).toEqual([])
    world.mine()
    await world.tick()
    await assertNothingLeftHeld()
    world.assertRecipientGuarantees(undefined)
  })
})

describe('cancel', () => {
  it('cancels while the first merge is signed: nothing was sent, everything is let go of', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    let cancelled: Promise<unknown> | undefined
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 10 && !cancelled)
        cancelled = world.wallet.cancelQbitSendPlan(world.storedPlanId()!)
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    await expect(cancelled).resolves.toBeNull()
    world.keyring.beforeInput = undefined
    expect(world.explorer.accepted).toEqual([])
    expect(world.storedPlans()).toEqual([])
    expect(await world.plan()).toBeNull()
    await assertNothingLeftHeld()
    world.assertRecipientGuarantees(undefined)
  })

  it('signs nothing once the plan is cancelled while the signing a continue authorised gets under way', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(2, 50)
    await world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    world.keyring.beforeInput = undefined
    world.keyring.unlock()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ pause: { reason: 'interrupted' } })
    const signed = world.keyring.signed.length
    const counter = world.keyring.counter

    // The continue's figures are read before anything is signed, and the
    // first preflight of that read waits while the user cancels.
    const preflight = gateNextPreflight()
    await world.wallet.continueQbitSendPlan(paused.id)
    await preflight.reached
    // The advance under way, which goes on after the cancel forgets the
    // plan, and which the engine's idle no longer waits for.
    const running = world.engine.advance(paused.id)
    await expect(world.wallet.cancelQbitSendPlan(paused.id)).resolves.toBeNull()
    preflight.release()
    await running
    await world.settle()
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.keyring.counter).toBe(counter)
    expect(world.keyring.batches.size).toBe(0)
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    // The merge sent before the restart stays the account's own output.
    world.mine()
    await world.tick()
    await assertNothingLeftHeld()
    world.assertRecipientGuarantees(undefined)
  })

  it('cancels after the merges went out: they stay as the account’s own outputs, and nothing stays held', async () => {
    world.fund(250, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toBeNull()
    world.mine()
    await world.tick()
    expect(world.storedPlans()).toEqual([])
    await assertNothingLeftHeld()
    const all = await world.wallet.createSendAllQbitPsbt({ to: PAYER, feeRate: 1 })
    expect(inputsOfPsbt(all.psbtHex)).toContain(`${plan.steps[0]!.txid}:0`)
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps the inputs of a merge whose outcome is unknown held until it is proven absent', async () => {
    world.fund(150, 100_000)
    await world.open()
    world.explorer.failures.push(request =>
      isBroadcast(request) ? new TypeError('fetch failed') : undefined
    )
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.explorer.failures.length = 0
    const cancelled = await world.wallet.cancelQbitSendPlan(plan.id)
    expect(cancelled).toMatchObject({ phase: 'cancelling', actions: [] })
    expect((await world.planHeld()).size).toBe(106)
    expect(world.storedPlans()[0]!.steps.at(-1)).not.toHaveProperty('signedPsbtHex')

    await world.tick()
    expect((await world.planHeld()).size).toBe(106)
    await world.tick(10 * 60_000)
    expect(world.storedPlans()).toEqual([])
    await assertNothingLeftHeld()
  })

  it('lets go of a cancelled merge found in the network, and gives up after the backstop when lookups never answer', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    world.explorer.failures.push(
      once(request =>
        isBroadcast(request)
          ? { status: 502, body: 'bad gateway', afterAccepting: true }
          : undefined
      ),
      request => (isLookup(request) ? { status: 400, body: 'lookup refused' } : undefined)
    )
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    if (!started.ok) throw new Error('not started')
    expect(await world.wallet.cancelQbitSendPlan(started.plan.id)).toMatchObject({
      phase: 'cancelling',
    })
    await world.tick()
    expect(world.storedPlans()).toHaveLength(1)
    await world.tick(24 * 60 * 60_000)
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
  })

  it('refuses to cancel once the payment may be in the network', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    await world.tick()
    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toMatchObject({
      phase: 'completed',
      actions: ['dismiss'],
    })
    world.mine()
    await world.wallet.dismissQbitSendPlan(plan.id)
    await assertNothingLeftHeld()
    expect(world.timers.scheduled).toBe(0)
  })
})

describe('state: one advance at a time, the newest state wins, revisions only grow', () => {
  it('coalesces advances that race: every transaction is signed and sent once', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    if (!started.ok) throw new Error('not started')
    await Promise.all([
      world.engine.advance(started.plan.id),
      world.engine.advance(started.plan.id),
      world.wallet.getQbitSendPlan(),
      world.tick(0),
    ])
    await world.settle()
    expect(new Set(world.keyring.signed).size).toBe(world.keyring.signed.length)
    expect(world.keyring.signed).toHaveLength(3)
    expect(new Set(world.explorer.accepted.map(item => item.txid)).size).toBe(2)
  })

  it('starts a draft once when two starts of it race, keeping what the plan holds', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const [first, second] = await Promise.allSettled([
      world.wallet.startQbitSendPlan(review.draftId),
      world.wallet.startQbitSendPlan(review.draftId),
    ])
    expect(first).toMatchObject({ status: 'fulfilled', value: { ok: true } })
    expect(second).toEqual(first)
    await world.settle()
    const [stored] = qbitSendPlanStore.list()
    expect(qbitSendPlanStore.list()).toHaveLength(1)
    // Every input the plan spends is held, and an ordinary send stays off them.
    const held = await world.planHeld()
    const inputs = stored!.steps.flatMap(step =>
      step.inputs.map(input => `${input.txid}:${input.vout}`)
    )
    expect(inputs.every(key => held.has(key))).toBe(true)
    const send = await world.wallet.createSendAllQbitPsbt({ to: PAYER, feeRate: 1 })
    expect(inputsOfPsbt(send.psbtHex).some(key => inputs.includes(key))).toBe(false)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  /** Holds each signature batch the keyring is asked to open until the test lets it go, in order. */
  function holdBatchOpenings(): { opened: number; release: (index: number) => void } {
    const open = world.keyring.openP2mrPsbtSigningBatch
    const gates: (() => void)[] = []
    const held = {
      opened: 0,
      release: (index: number) => gates[index]!(),
    }
    vi.mocked(keyringService.openP2mrPsbtSigningBatch).mockImplementation((async (
      ...args: Parameters<typeof open>
    ) => {
      held.opened += 1
      await new Promise<void>(resolve => gates.push(resolve))
      return open(...args)
    }) as never)
    return held
  }

  for (const finishing of ['first', 'last'] as const) {
    it(`keeps the newest of two overlapping prepares, the earlier finishing ${finishing}, and lets go of the other’s batch and challenge`, async () => {
      world.keyring.restoredFloor = true
      world.fund(250, 100_000)
      await world.open()
      const held = holdBatchOpenings()
      const earlier = world.prepare({ target: { kind: 'everything' } })
      await vi.waitFor(() => expect(held.opened).toBe(1))
      const later = world.prepare({ target: { kind: 'everything' } })
      await vi.waitFor(() => expect(held.opened).toBe(2))
      let first: QbitSendPlanPrepareResult
      let second: QbitSendPlanPrepareResult
      if (finishing === 'first') {
        held.release(0)
        first = await earlier
        held.release(1)
        second = await later
      } else {
        held.release(1)
        second = await later
        held.release(0)
        first = await earlier
      }
      if (!first.ok || !second.ok) throw new Error('prepare refused')
      // One batch and one challenge: the newest review's.
      expect(world.keyring.batches.size).toBe(1)
      expect([...world.keyring.challenges.keys()]).toEqual([
        second.review.signatureBudget.restoredFloorRisk!.challengeId,
      ])
      expect(await world.wallet.startQbitSendPlan(first.review.draftId)).toEqual({
        ok: false,
        reason: 'draft_expired',
      })
      await world.wallet.confirmQbitRestoredFloorSigning(
        second.review.signatureBudget.restoredFloorRisk!.challengeId
      )
      expect(await world.wallet.startQbitSendPlan(second.review.draftId)).toMatchObject({
        ok: true,
      })
      await world.settle()
      expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    })
  }

  it('gives a second start of a draft the first one’s outcome while the first waits for its first signature', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    // The first signature waits, and with it the first start, which took
    // the draft out of the drafts kept.
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let arrived: () => void = () => undefined
    const signing = new Promise<void>(resolve => (arrived = resolve))
    const sign = world.keyring.signP2mrPsbtWithCounter
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementationOnce((async (
      ...args: Parameters<typeof sign>
    ) => {
      arrived()
      await gate
      return sign(...args)
    }) as never)
    const first = world.wallet.startQbitSendPlan(review.draftId)
    await signing
    const second = world.wallet.startQbitSendPlan(review.draftId)
    release()
    const [one, two] = await Promise.all([first, second])
    expect(one).toMatchObject({ ok: true })
    expect(two).toEqual(one)
    await world.settle()
    expect(world.storedPlans()).toHaveLength(1)
    expect(world.keyring.signed.filter(txid => txid === review.payment.txid)).toHaveLength(1)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('refuses a prepare while a start of the account runs, and the start goes on with its draft', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    // The start's write waits.
    const set = world.storage.set.bind(world.storage)
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let waiting = false
    world.storage.set = async (key, value) => {
      if (!waiting) {
        waiting = true
        await gate
      }
      return set(key, value)
    }
    const started = world.wallet.startQbitSendPlan(review.draftId)
    await vi.waitFor(() => expect(waiting).toBe(true))
    expect(await world.prepare({ target: { kind: 'everything' } })).toMatchObject({
      ok: false,
      reason: 'plan_open',
    })
    release()
    expect(await started).toMatchObject({ ok: true })
    await world.settle()
    // Signed through on the batch its review opened.
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.batches.size).toBe(0)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('lets a prepare under way win over a start of the draft it replaces', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const held = holdBatchOpenings()
    const next = world.prepare({ target: { kind: 'everything' } })
    await vi.waitFor(() => expect(held.opened).toBe(1))
    // The new prepare let go of the reviewed draft as it began.
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    held.release(0)
    const result = await next
    if (!result.ok) throw new Error('prepare refused')
    expect(world.keyring.batches.size).toBe(1)
    vi.mocked(keyringService.openP2mrPsbtSigningBatch).mockImplementation(
      world.keyring.openP2mrPsbtSigningBatch as never
    )
    expect(await world.wallet.startQbitSendPlan(result.review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
  })

  it('carries a continue through when a page’s read advances the plan while the continue writes it', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(2, 50)
    void world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    world.keyring.beforeInput = undefined
    world.keyring.unlock()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ pause: { reason: 'interrupted' } })
    // A page reads the plan the moment the continue's write lands, before
    // the continue has gone further.
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementationOnce(async (record, revision) => {
      const written = await put(record, revision)
      await world.wallet.getQbitSendPlan()
      await world.settle()
      return written
    })
    await world.wallet.continueQbitSendPlan(paused.id)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('carries a continue through when another page’s continue, finding nothing to continue, ends while the first writes', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(2, 50)
    void world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    world.keyring.beforeInput = undefined
    world.keyring.unlock()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ pause: { reason: 'interrupted' } })
    // The first continue's write lands; another page's continue then finds
    // the plan resumed and ends, and a page reads the plan, all before the
    // first continue has gone further.
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    let second: Promise<unknown> | undefined
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementationOnce(async (record, revision) => {
      const written = await put(record, revision)
      second = world.wallet.continueQbitSendPlan(paused.id).catch(error => error)
      await second
      await world.wallet.getQbitSendPlan()
      await world.settle()
      return written
    })
    await world.wallet.continueQbitSendPlan(paused.id)
    expect(await second).toMatchObject({ message: 'The Qbit send plan cannot continue now' })
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('settles continue and cancel racing on one consistent end', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(2, 20)
    await world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    world.keyring.beforeInput = undefined
    world.keyring.unlock()
    const plan = (await world.plan())!
    const outcomes = await Promise.allSettled([
      world.wallet.continueQbitSendPlan(plan.id),
      world.wallet.cancelQbitSendPlan(plan.id),
    ])
    await world.settle()
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled' })
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it('never lets a stale unit of work overwrite a newer write', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    let release: () => void = () => undefined
    world.gate = new Promise(resolve => (release = resolve))
    void world.wallet.startQbitSendPlan(review.draftId)
    await vi.waitFor(() => expect(world.explorer.accepted).toHaveLength(1))
    // While the merge's verdict is on its way, something else writes a newer
    // revision of the plan.
    const stored = qbitSendPlanStore.list()[0]!
    expect(stored.steps[0]!.status).toBe('unknown')
    await qbitSendPlanStore.put(
      { ...stored, phase: 'paused', pause: { reason: 'interrupted', at: Date.now() } },
      stored.revision
    )
    world.gate = undefined
    release()
    await world.settle()
    // The verdict is applied to the newer revision, which stays paused: the
    // write it was decided on is not written over.
    const after = qbitSendPlanStore.get(stored.id)!
    expect(after.phase).toBe('paused')
    expect(after.steps[0]!.status).toBe('broadcast')
    expect(after.revision).toBe(stored.revision + 2)
  })

  it('raises the revision with every visible change, signing progress included, and across a restart', async () => {
    world.fund(250, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    const revisions = world.events
      .filter(event => event.planId === plan.id)
      .map(event => event.revision)
    expect(revisions.length).toBeGreaterThan(250)
    revisions.slice(1).forEach((revision, index) => {
      expect(revision).toBeGreaterThan(revisions[index]!)
    })
    const shown = (await world.plan())!.revision
    expect(shown).toBeGreaterThanOrEqual(revisions.at(-1)!)
    const progress = world.events.length

    await world.restart()
    const after = (await world.plan())!
    expect(after.revision).toBeGreaterThan(shown)
    expect(after.revision % QBIT_SEND_PLAN_VIEW_REVISION_STRIDE).toBe(0)
    expect(world.events.length).toBeGreaterThan(progress)
    // Views carry no transaction bytes.
    expect(JSON.stringify(after)).not.toMatch(/70736274ff/)
  })

  it('leaves a plan a start is writing to that start when a page reads it in between', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    // The page's read lands once the new record is stored and before the
    // start has authorised its signing.
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    let read: { view: QbitSendPlanView | null } | undefined
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementation(async (record, readRevision) => {
      const written = await put(record, readRevision)
      if (readRevision === null && !read) read = { view: await world.wallet.getQbitSendPlan() }
      return written
    })
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started).toMatchObject({ ok: true })
    expect(read?.view).toMatchObject({ phase: 'signing' })
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.signed).toHaveLength(2)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })
})

describe('replan', () => {
  /**
   * 250 outputs of distinct values (output `index` holds 100,000 + index),
   * a plan of `target` through two merges, and the second merge refused
   * until the plan pauses `merge_refused`.
   */
  async function refusedSecondMerge(target: Record<string, unknown>, count = 250) {
    const outpoints = world.fund(count, index => 100_000 + index)
    await world.open()
    // Ranked by value, the second merge spends the 107th to 212th largest.
    world.refuseSpending.add(outpoints[count - 150]!)
    const plan = await world.startPlan({ target })
    await world.tick()
    await world.tick()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'merge_refused' } })
    expect(paused.steps.map(step => step.status)).toEqual(['broadcast', 'planned', 'planned'])
    world.refuseSpending.clear()
    return { plan, paused }
  }

  it('replans an amount after merge_refused: the same amount, new fees, and what the sent merge paid', async () => {
    const amount = 22_000_000
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount })
    world.mine([plan.steps[0]!.txid])
    await world.plan()
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    expect(review).toMatchObject({
      amount,
      paidFee: plan.steps[0]!.fee,
      revises: { planId: plan.id },
    })
    expect(review.totalFee).toBe(
      review.paidFee +
        review.payment.fee +
        review.merges.reduce((total, merge) => total + merge.fee, 0)
    )
    expect(review.previousAmount).toBeUndefined()
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started).toMatchObject({ ok: true, plan: { id: plan.id, phase: 'signing' } })
    await world.settle()
    world.mine()
    await world.tick()
    const done = (await world.plan())!
    expect(done).toMatchObject({ id: plan.id, phase: 'completed', totalFee: review.totalFee })
    world.assertRecipientGuarantees(amount)
    expect(world.feeOf(review.payment.txid)).toBe(review.payment.fee)
    world.mine()
    await world.tick()
    await world.plan()
    await assertNothingLeftHeld()
  })

  it('keeps a carried merge, and the hold on its inputs, through one miss long after it was last seen', async () => {
    const amount = 22_000_000
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount }, 400)
    const carried = plan.steps[0]!.txid
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const inputs = qbitSendPlanStore
      .get(plan.id)!
      .carried!.filter(item => item.txid === carried)
      .flatMap(item => item.inputs.map(input => `${input.txid}:${input.vout}`))
    expect(inputs).toHaveLength(106)
    expect([...(await world.planHeld())]).toEqual(expect.arrayContaining(inputs))

    // Nothing advances the plan for longer than the grace; then the first
    // lookup of the carried merge misses it once.
    world.explorer.failures.push(
      once(request =>
        isLookup(request) && request.path.includes(carried)
          ? { status: 404, body: 'not found' }
          : undefined
      )
    )
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS + QBIT_SEND_PLAN_TICK_MS)
    expect(qbitSendPlanStore.get(plan.id)!.carried?.map(item => item.txid)).toEqual([carried])
    expect([...(await world.planHeld())]).toEqual(expect.arrayContaining(inputs))
    expect([...(await world.reserved())]).toEqual(expect.arrayContaining(inputs))
    await world.tick()
    expect(qbitSendPlanStore.get(plan.id)!.carried?.map(item => item.txid)).toEqual([carried])

    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(amount)
  })

  it('takes a carried merge’s fee off what the plan paid once it is proven absent, and says nothing was sent', async () => {
    const amount = 22_000_000
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount }, 400)
    const carried = plan.steps[0]!
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    expect(review.paidFee).toBe(carried.fee)
    // The replan stops on a lock before its first signature ends: nothing
    // of it is sent.
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 3) void world.wallet.lockWallet()
    }
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    world.keyring.beforeInput = undefined
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'locked' }, sent: true })
    expect(paused.steps.every(step => step.status === 'planned')).toBe(true)
    const stepFees = paused.steps.reduce((total, step) => total + step.fee, 0)
    expect(paused.totalFee).toBe(stepFees + carried.fee)

    // The carried merge leaves the network and every lookup misses it for
    // the whole grace: proven absent, it never paid its fee.
    world.explorer.removeTx(carried.txid)
    vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
    await world.plan()
    vi.setSystemTime(Date.now() + QBIT_RECENT_SPEND_GONE_GRACE_MS)
    await world.plan()
    const after = (await world.plan())!
    expect(qbitSendPlanStore.get(plan.id)!.carried).toEqual([])
    expect(qbitSendPlanStore.get(plan.id)!.paidFee).toBeUndefined()
    expect(after).toMatchObject({ phase: 'paused', sent: false, totalFee: stepFees })

    // Cancelled now, nothing of it was ever in the network.
    await world.unlock()
    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toBeNull()
    expect((await world.planHeld()).size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  /** The send guard of the running world, whose methods a scenario can wrap. */
  const guard = (): QbitSendGuardService => guardHolder.guard as QbitSendGuardService

  /**
   * Another page's cancel lands at `when` of a replan's swap: after its
   * first hold change, or before it. Resolves once the cancel has.
   */
  function cancelDuringSwap(planId: string, when: 'after' | 'before'): Promise<unknown> {
    const replace = guard().replacePlanOutpoints.bind(guard())
    let cancelled: (value: unknown) => void = () => undefined
    const done = new Promise<unknown>(resolve => (cancelled = resolve))
    vi.spyOn(guard(), 'replacePlanOutpoints').mockImplementationOnce(async entry => {
      if (when === 'before') {
        cancelled(await world.wallet.cancelQbitSendPlan(planId))
        return replace(entry)
      }
      const hold = await replace(entry)
      cancelled(await world.wallet.cancelQbitSendPlan(planId))
      return hold
    })
    return done
  }

  /** The outpoints the stored plan needs held while it cancels: the inputs of what is unknown. */
  function heldWhileCancelling(planId: string): Set<string> {
    const record = qbitSendPlanStore.get(planId)!
    expect(record.phase).toBe('cancelling')
    return new Set(
      [
        ...record.steps.slice(0, -1).filter(step => step.status === 'unknown'),
        ...(record.carried ?? []).filter(item => item.status === 'unknown'),
      ].flatMap(item => item.inputs.map(input => `${input.txid}:${input.vout}`))
    )
  }

  it('holds only what the cancelled plan needs when a cancel lands during a replan’s swap', async () => {
    const amount = 22_000_000
    const outpoints = world.fund(400, index => 100_000 + index)
    await world.open()
    world.refuseSpending.add(outpoints[250]!)
    // The first merge's broadcast has no verdict, and it never reached the
    // explorer: it stays unknown while the second merge is refused.
    let lost = true
    world.explorer.failures.push(request =>
      lost && isBroadcast(request) ? new TypeError('fetch failed') : undefined
    )
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0 && ++signings === 2) lost = false
    }
    const plan = await world.startPlan({ target: { kind: 'amount', amount } })
    await world.tick()
    await world.tick()
    world.keyring.beforeInput = undefined
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'merge_refused' } })
    expect(world.storedStatuses()).toEqual(['unknown', 'planned', 'planned'])
    world.refuseSpending.clear()
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })

    const cancelled = cancelDuringSwap(plan.id, 'after')
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(await cancelled).toMatchObject({ phase: 'cancelling' })
    await world.settle()
    // The cancel stands over the plan the replan would have replaced, and
    // the plan holds what the cancelled plan needs: the inputs of the merge
    // whose outcome is unknown, nothing of the replan, no merge output, no
    // payment input.
    const stored = qbitSendPlanStore.get(plan.id)!
    expect(stored.steps.map(step => step.txid)).toEqual(plan.steps.map(step => step.txid))
    expect(await world.planHeld()).toEqual(heldWhileCancelling(plan.id))
    expect(world.keyring.batches.size).toBe(0)
    world.assertRecipientGuarantees(undefined)
  })

  it.each([['after'], ['before']] as const)(
    'answers draft_expired, holding nothing, when a cancel deletes the plan %s a replan’s first hold change',
    async when => {
      const amount = 22_000_000
      const { plan } = await refusedSecondMerge({ kind: 'amount', amount }, 400)
      const review = await world.review({
        target: { kind: 'amount', amount },
        revise: { planId: plan.id, kind: 'replan' },
      })
      const cancelled = cancelDuringSwap(plan.id, when)
      expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
        ok: false,
        reason: 'draft_expired',
      })
      expect(await cancelled).toBeNull()
      await world.settle()
      expect(world.storedPlans()).toEqual([])
      expect((await world.planHeld()).size).toBe(0)
      expect(world.keyring.batches.size).toBe(0)
      expect(world.keyring.challenges.size).toBe(0)
      world.assertRecipientGuarantees(undefined)
    }
  )

  it('answers draft_expired, with nothing held or batched, when a cancel deletes the plan the replan wrote before it is handed over', async () => {
    const amount = 22_000_000
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount }, 400)
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    const pushed = world.pushed.length
    const put = qbitSendPlanStore.put.bind(qbitSendPlanStore)
    let cancelled: unknown
    vi.spyOn(qbitSendPlanStore, 'put').mockImplementationOnce(async (record, revision) => {
      const written = await put(record, revision)
      cancelled = await world.wallet.cancelQbitSendPlan(plan.id)
      return written
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
    expect(world.pushed).toHaveLength(pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('narrows a replan’s holds to the stored plan’s when its draft expired while its start wrote it', async () => {
    const amount = 22_000_000
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount })
    world.mine([plan.steps[0]!.txid])
    await world.plan()
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
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
    // An ordinary key's replan goes on without its draft, under the same
    // approval.
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({
      ok: true,
      plan: { id: plan.id },
    })
    world.storage.set = set
    await world.settle()
    expect(world.keyring.signed).toContain(review.payment.txid)
    // What it holds is what its stored record needs, as a restart holds it.
    const held = await world.planHeld()
    await world.restart()
    expect(await world.planHeld()).toEqual(held)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ id: plan.id, phase: 'completed' })
    world.assertRecipientGuarantees(amount)
  })

  it('counts nothing of a replan as signed before it signs, a merge the replaced plan had signed under the same id included', async () => {
    // A plan of one merge, the 106 largest outputs, which the network
    // refuses until the plan pauses: the merge was signed in full.
    const count = 250
    const outpoints = world.fund(count, index => 100_000 + index)
    await world.open()
    world.refuseSpending.add(outpoints[count - 1]!)
    const amount = 12_000_000
    const plan = await world.startPlan({ target: { kind: 'amount', amount } })
    await world.tick()
    await world.tick()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'merge_refused' } })
    expect(paused.steps.map(step => step.status)).toEqual(['planned', 'planned'])
    expect(paused.signaturesDone).toBe(paused.steps[0]!.inputCount)
    world.refuseSpending.clear()
    const signedBefore = paused.steps[0]!
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    // The replan's first signing stops at its first input.
    const reached = hangSigning(1, 0)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await reached
    const view = (await world.wallet.getQbitSendPlan())!
    // The same merge, under the same id, signed again from its first input.
    expect(view.steps[0]).toMatchObject({ txid: signedBefore.txid, status: 'planned' })
    expect(view.signing).toMatchObject({ step: 0, signed: 0 })
    expect(view.signaturesDone).toBe(0)
  })

  it('looks the sent merges up before it plans a replan, so a merge that confirmed meanwhile is spent as confirmed', async () => {
    const amount = 22_000_000
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount })
    // The merge sent confirms while nothing advances the plan: the record
    // still has it as sent, the explorer lists its output as confirmed.
    world.mine([plan.steps[0]!.txid])
    expect(world.storedStatuses()[0]).toBe('broadcast')
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    expect(review.paidFee).toBe(plan.steps[0]!.fee)
    expect(world.storedStatuses()[0]).toBe('confirmed')
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started).toMatchObject({ ok: true })
    await world.settle()
    expect(qbitSendPlanStore.get(plan.id)!.carried ?? []).toEqual([])
    for (let block = 0; block < 3 && (await world.plan())?.phase !== 'completed'; block++) {
      world.mine()
      await world.tick()
    }
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount })
    world.assertRecipientGuarantees(amount)
  })

  it('replans everything after merge_refused, stating the amount it replaces', async () => {
    const { plan } = await refusedSecondMerge({ kind: 'everything' })
    world.mine([plan.steps[0]!.txid])
    await world.plan()
    // At a new fee rate: the merge already sent keeps the fee it paid.
    const review = await world.review({
      target: { kind: 'everything' },
      feeRate: 2,
      revise: { planId: plan.id, kind: 'replan' },
    })
    expect(review.previousAmount).toBe(plan.amount)
    expect(review.paidFee).toBe(plan.steps[0]!.fee)
    expect(review.amount).toBeLessThan(plan.amount)
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount: review.amount })
    world.assertRecipientGuarantees(review.amount)
  })

  it('carries a sent merge that has not confirmed, keeping its inputs held, and says wait when the plan needs its funds', async () => {
    const amount = 22_000_000
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount }, 400)
    // The first merge is still unconfirmed: its funds are not available.
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: plan.id, kind: 'replan' },
    })
    const firstInputs = inputsOfPsbt(world.storedPlans()[0]!.steps[0]!.unsignedPsbtHex)
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    const stored = qbitSendPlanStore.get(plan.id)!
    expect(stored.carried).toMatchObject([{ txid: plan.steps[0]!.txid, status: 'broadcast' }])
    const held = await world.planHeld()
    expect(firstInputs.every(key => held.has(key))).toBe(true)

    world.mine()
    await world.tick()
    expect(qbitSendPlanStore.get(plan.id)!.carried ?? []).toEqual([])
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(amount)

    // An amount that needs the unconfirmed merge's funds is refused until it confirms.
    world = freshWorld()
    const outpoints = world.fund(250, index => 100_000 + index)
    await world.open()
    world.refuseSpending.add(outpoints[100]!)
    const big = await world.startPlan({ target: { kind: 'amount', amount } })
    await world.tick()
    await world.tick()
    world.refuseSpending.clear()
    const refused = await world.prepare({
      target: { kind: 'amount', amount },
      revise: { planId: big.id, kind: 'replan' },
    })
    expect(refused).toMatchObject({ ok: false, reason: 'insufficient_balance' })
    expect((refused as { unconfirmedSatoshis: number }).unconfirmedSatoshis).toBeGreaterThan(
      10_000_000
    )
  })

  it('refuses a replan that names another memo or replaceability, or another target', async () => {
    const { plan } = await refusedSecondMerge({ kind: 'amount', amount: 22_000_000 })
    const revise = { planId: plan.id, kind: 'replan' }
    await expect(
      world.prepare({ target: { kind: 'amount', amount: 22_000_000 }, revise, memo: 'other' })
    ).rejects.toThrow('memo')
    await expect(
      world.prepare({ target: { kind: 'amount', amount: 22_000_000 }, revise, enableRBF: false })
    ).rejects.toThrow('replaceability')
    await expect(
      world.prepare({ target: { kind: 'amount', amount: 21_000_000 }, revise })
    ).rejects.toThrow('same target')
    await expect(world.prepare({ target: { kind: 'everything' }, revise })).rejects.toThrow(
      'same target'
    )
  })

  it('offers, prepares and starts no replan once the payment may be in the network', async () => {
    const amount = 12_000_000
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount } })
    world.mine()
    world.explorer.failures.push(
      once(request =>
        isBroadcast(request) ? nodeRejection('non-mandatory-script-verify-flag (bad)') : undefined
      )
    )
    await world.tick()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'payment_refused' },
      actions: ['continue', 'replan', 'cancel'],
    })
    const revise = { planId: plan.id, kind: 'replan' }
    const stale = await world.review({ target: { kind: 'amount', amount }, revise })

    // Sent again, the payment's answer is lost and its lookups fail.
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
    await world.wallet.continueQbitSendPlan(plan.id)
    await world.settle()
    expect(world.storedStatuses().at(-1)).toBe('unknown')
    // Whatever pauses the plan then, a replan would stop tracking that payment.
    const stored = qbitSendPlanStore.get(plan.id)!
    await qbitSendPlanStore.put(
      { ...stored, phase: 'paused', pause: { reason: 'outputs_spent', at: Date.now() } },
      stored.revision
    )
    expect(await world.wallet.getQbitSendPlan()).toMatchObject({
      pause: { reason: 'outputs_spent' },
      actions: [],
    })
    await expect(world.prepare({ target: { kind: 'amount', amount }, revise })).rejects.toThrow(
      'payment may be in the network'
    )
    expect(await world.wallet.startQbitSendPlan(stale.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(qbitSendPlanStore.get(plan.id)!.steps.at(-1)).toMatchObject({
      txid: plan.paymentTxid,
      status: 'unknown',
    })
    world.assertRecipientGuarantees(amount)
  })

  /**
   * A restored-floor key's plan paused `merge_refused` with its first merge
   * sent, and a replan of it reviewed, whose challenge the page has not
   * confirmed.
   */
  async function unconfirmedReplan(amount: number) {
    world.keyring.restoredFloor = true
    const count = 400
    const outpoints = world.fund(count, index => 100_000 + index)
    await world.open()
    world.refuseSpending.add(outpoints[count - 150]!)
    const first = await world.review({ target: { kind: 'amount', amount } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      first.signatureBudget.restoredFloorRisk!.challengeId
    )
    expect(await world.wallet.startQbitSendPlan(first.draftId)).toMatchObject({ ok: true })
    await world.settle()
    await world.tick()
    await world.tick()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'merge_refused' } })
    expect(paused.steps.map(step => step.status)).toEqual(['broadcast', 'planned', 'planned'])
    world.refuseSpending.clear()
    const stored = qbitSendPlanStore.get(paused.id)!
    const held = await world.planHeld()
    expect(held.has(`${stored.steps[0]!.txid}:0`)).toBe(true)
    const review = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId: paused.id, kind: 'replan' },
    })
    expect(review.signatureBudget.restoredFloorRisk).toBeDefined()
    return { paused, stored, held, review }
  }

  it('ends a replan’s review when its challenge expires, leaving the plan as it was', async () => {
    const { paused, stored, held, review } = await unconfirmedReplan(22_000_000)
    const challengeId = review.signatureBudget.restoredFloorRisk!.challengeId
    expect(review.expiresAt).toBeLessThanOrEqual(
      world.keyring.challenges.get(challengeId)!.expiresAt
    )
    expect(review.expiresAt).toBeLessThan(Date.now() + QBIT_SEND_PLAN_DRAFT_TTL_MS)
    vi.setSystemTime(review.expiresAt + 1)
    world.timers.runDue()
    expect(world.keyring.challenges.has(challengeId)).toBe(false)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    await world.settle()
    expect(qbitSendPlanStore.get(paused.id)!.steps).toEqual(stored.steps)
    expect(await world.planHeld()).toEqual(held)
  })

  it('writes the plan back as it was when a replan’s challenge is not confirmed, and starts the same draft once it is', async () => {
    const amount = 22_000_000
    const { paused, stored, held, review } = await unconfirmedReplan(amount)
    const refused = await world.wallet.startQbitSendPlan(review.draftId).catch(error => error)
    expect(refused).toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
    await world.settle()

    // The plan it would have replaced is back as it was: its record (a newer
    // revision of the same content), its holds and its pause.
    const after = qbitSendPlanStore.get(paused.id)!
    expect(after.revision).toBeGreaterThan(stored.revision)
    const content = (record: typeof after) => {
      const { revision: _revision, updatedAt: _updatedAt, ...rest } = record
      return rest
    }
    expect(content(after)).toEqual(content(stored))
    expect(await world.planHeld()).toEqual(held)
    const view = (await world.plan())!
    expect(view).toMatchObject({
      id: paused.id,
      phase: 'paused',
      pause: { reason: 'merge_refused' },
      actions: ['replan', 'cancel'],
    })
    expect(view.revision).toBeGreaterThan(paused.revision)
    expect(world.keyring.signed.filter(txid => txid === review.payment.txid)).toEqual([])

    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    for (let block = 0; block < 4 && (await world.plan())?.phase !== 'completed'; block++) {
      world.mine()
      await world.tick()
    }
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount })
    world.assertRecipientGuarantees(amount)
  })

  it('keeps the replan stored and unauthorised, holding what it needs, when the plan it replaced cannot be written back', async () => {
    const { paused, stored, review } = await unconfirmedReplan(22_000_000)
    // The swap's write goes through; the write that would undo it fails.
    const set = world.storage.set.bind(world.storage)
    let writes = 0
    world.storage.set = async (key, value) => {
      writes += 1
      if (writes === 2) throw new Error('QUOTA_BYTES quota exceeded')
      return set(key, value)
    }
    const signed = world.keyring.signed.length
    const refused = await world.wallet.startQbitSendPlan(review.draftId).catch(error => error)
    expect(refused).toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
    await world.settle()
    // The replan is what is stored, and it waits for the user.
    expect(world.storedPlans()).toMatchObject([{ id: paused.id, phase: 'paused' }])
    expect(qbitSendPlanStore.get(paused.id)!.steps.at(-1)!.txid).toBe(review.payment.txid)
    expect(await world.plan()).toMatchObject({ pause: { reason: 'interrupted' } })
    expect(world.keyring.signed).toHaveLength(signed)
    // The draft went with the plan it was for.
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    // No undo is possible any more: the replan holds what it needs, the
    // inputs of the merge it carries included, as a restart holds it, and
    // nothing of the plan it replaced besides, such as the carried merge's
    // output, which that plan's payment spent and the replan does not.
    const now = await world.planHeld()
    const carried = stored.steps[0]!
    expect(carried.inputs.every(input => now.has(`${input.txid}:${input.vout}`))).toBe(true)
    expect(now.has(`${carried.txid}:0`)).toBe(false)
    await world.restart()
    expect(await world.planHeld()).toEqual(now)
  })

  it('writes the plan back as it was when a lock cuts a replan’s first signature short, the start writing nothing in between', async () => {
    const { paused, stored, held, review } = await unconfirmedReplan(22_000_000)
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    // The wallet locks while the first signature waits to begin, the
    // page's challenge already taken for it.
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let arrive: () => void = () => undefined
    const reached = new Promise<void>(resolve => (arrive = resolve))
    const sign = world.keyring.signP2mrPsbtWithCounter
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementationOnce((async (
      ...args: Parameters<typeof sign>
    ) => {
      arrive()
      await gate
      return sign(...args)
    }) as never)
    const signed = world.keyring.signed.length
    const writes: string[] = []
    const set = world.storage.set.bind(world.storage)
    world.storage.set = async (key, value) => {
      const document = value as { plans: { phase: string; pause?: { reason: string } }[] }
      writes.push(`${document.plans[0]?.phase}:${document.plans[0]?.pause?.reason ?? ''}`)
      return set(key, value)
    }
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.wallet.lockWallet()
    release()
    expect(await starting).toEqual({ ok: false, reason: 'draft_expired' })
    await world.settle()

    // The replan was never paused for the lock: the one write after the
    // swap's is the plan it replaced, written back as it was.
    expect(writes).toEqual(['signing:', 'paused:merge_refused'])
    const after = qbitSendPlanStore.get(paused.id)!
    const content = (record: typeof after) => {
      const { revision: _revision, updatedAt: _updatedAt, ...rest } = record
      return rest
    }
    expect(content(after)).toEqual(content(stored))
    expect(await world.planHeld()).toEqual(held)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.keyring.challenges.size).toBe(0)
    await world.unlock()
    expect(await world.plan()).toMatchObject({
      id: paused.id,
      phase: 'paused',
      pause: { reason: 'merge_refused' },
      actions: ['replan', 'cancel'],
    })
    world.assertRecipientGuarantees(undefined)
  })
})

describe('restored-floor keys', () => {
  it('ends a review when the restored-floor challenge it carries expires, with its draft, batch and challenge', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const challengeId = review.signatureBudget.restoredFloorRisk!.challengeId
    // The review states the earlier end: the challenge's, not the draft's.
    const challengeEnd = world.keyring.challenges.get(challengeId)!.expiresAt
    expect(review.expiresAt).toBe(T0 + QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS)
    expect(review.expiresAt).toBeLessThanOrEqual(challengeEnd)
    expect(review.expiresAt).toBeLessThan(T0 + QBIT_SEND_PLAN_DRAFT_TTL_MS)

    // Then the draft goes, and its batch and challenge with it: Confirm
    // could only fail from here on, so the page reviews again.
    vi.setSystemTime(review.expiresAt + 1)
    world.timers.runDue()
    expect(world.keyring.batches.size).toBe(0)
    expect(world.keyring.challenges.size).toBe(0)
    await expect(world.wallet.confirmQbitRestoredFloorSigning(challengeId)).rejects.toMatchObject({
      code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED',
    })
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
    expect(world.storedPlans()).toEqual([])

    const again = await world.review({ target: { kind: 'everything' } })
    expect(again.expiresAt).toBe(Date.now() + QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS)
    await world.wallet.confirmQbitRestoredFloorSigning(
      again.signatureBudget.restoredFloorRisk!.challengeId
    )
    expect(await world.wallet.startQbitSendPlan(again.draftId)).toMatchObject({ ok: true })
  })

  it('keeps a review that carries no challenge for the draft’s own life', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    expect(review.signatureBudget.restoredFloorRisk).toBeUndefined()
    expect(review.expiresAt).toBe(T0 + QBIT_SEND_PLAN_DRAFT_TTL_MS)
    vi.setSystemTime(T0 + QBIT_RESTORED_FLOOR_CHALLENGE_TTL_MS + 1)
    world.timers.runDue()
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
  })

  it('signs a plan through on the page’s one confirmation, the engine confirming each later challenge just before its signature', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const challengeId = review.signatureBudget.restoredFloorRisk!.challengeId
    // Every other challenge of the preparation is released at once.
    expect([...world.keyring.challenges.keys()]).toEqual([challengeId])
    let mostAtOnce = 0
    world.keyring.beforeInput = () => {
      mostAtOnce = Math.max(mostAtOnce, world.keyring.challenges.size)
    }
    await world.wallet.confirmQbitRestoredFloorSigning(challengeId)
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    expect(started.ok).toBe(true)
    await world.settle()
    expect(world.keyring.signed).toHaveLength(3)
    expect(world.keyring.confirmations).toHaveLength(3)
    expect(world.keyring.confirmations[0]).toBe(challengeId)
    expect(mostAtOnce).toBeLessThanOrEqual(1)
    expect(world.keyring.challenges.size).toBe(0)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
  })

  it('refuses to start, with the keyring’s code, until the page confirmed the challenge, and keeps the draft', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })

    const refused = await world.wallet.startQbitSendPlan(review.draftId).catch(error => error)
    expect(refused).toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
    await world.settle()
    expect(world.keyring.signed).toEqual([])
    expect(world.keyring.confirmations).toEqual([])
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)

    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const second = await world.wallet.startQbitSendPlan(review.draftId)
    expect(second).toMatchObject({ ok: true })
    await world.settle()
    expect(world.keyring.signed).toHaveLength(3)
  })

  it('reports the keyring’s refusal when undoing the start cannot delete the plan, and deletes it on a later advance', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    // Storage refuses every write from the first signature on, until the
    // test lets it write again.
    const set = world.storage.set.bind(world.storage)
    let failing = false
    world.storage.set = async (key, value) => {
      if (failing) throw new Error('QUOTA_BYTES quota exceeded')
      return set(key, value)
    }
    const sign = world.keyring.signP2mrPsbtWithCounter
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(((
      ...args: Parameters<typeof sign>
    ) => {
      failing = true
      return sign(...args)
    }) as never)
    const refused = await world.wallet.startQbitSendPlan(review.draftId).catch(error => error)
    expect(refused).toMatchObject({ code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED' })
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation(sign as never)
    await world.settle()
    await world.tick()
    // Still stored, nothing signed, and still holding what it held.
    expect(world.storedPlans()).toHaveLength(1)
    expect(world.keyring.signed).toEqual([])
    expect((await world.planHeld()).size).toBeGreaterThan(0)

    // Once storage writes again, the next advance deletes it, then lets go
    // of its holds.
    failing = false
    await world.tick()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toMatchObject({ ok: true })
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
  })

  it('starts a draft again under a plan id of its own, so no page sees a revision go back', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    await world.wallet.startQbitSendPlan(review.draftId).catch(error => error)
    await world.settle()
    const undone = world.events.map(event => event.planId)
    expect(undone.length).toBeGreaterThan(0)

    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const second = await world.wallet.startQbitSendPlan(review.draftId)
    if (!second.ok) throw new Error('not started')
    expect(undone).not.toContain(second.plan.id)
    await world.settle()
    // Of each plan id, every announcement passes the one before it.
    const byPlan = new Map<string, number[]>()
    for (const { planId, revision } of world.events) {
      byPlan.set(planId, [...(byPlan.get(planId) ?? []), revision])
    }
    for (const revisions of byPlan.values()) {
      revisions.slice(1).forEach((revision, index) => {
        expect(revision).toBeGreaterThan(revisions[index]!)
      })
    }
    expect(await world.plan()).toMatchObject({ id: second.plan.id, phase: 'waiting' })
  })

  it('confirms and signs nothing after a restart until the user continues', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const reached = hangSigning(2, 10)
    await world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await world.restart()
    world.keyring.beforeInput = undefined
    world.keyring.unlock()
    const confirmed = world.keyring.confirmations.length
    const signed = world.keyring.signed.length
    await world.tick()
    await world.tick()
    const plan = (await world.plan())!
    expect(plan).toMatchObject({ phase: 'paused', pause: { reason: 'interrupted' } })
    expect(world.keyring.confirmations).toHaveLength(confirmed)
    expect(world.keyring.signed).toHaveLength(signed)

    await world.wallet.continueQbitSendPlan(plan.id)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.confirmations.length).toBe(confirmed + 2)
  })

  it('leaves no confirmed challenge behind when the wallet locks in the middle of the plan', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    let signings = 0
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 0) signings += 1
      if (signings === 2 && index === 40) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })
    expect(world.keyring.challenges.size).toBe(0)

    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.challenges.size).toBe(0)
  })
})

describe('a start that stops before its first signature (restored-floor keys)', () => {
  /**
   * A restored-floor key's reviewed plan, its challenge confirmed (an
   * ordinary key's, with `restoredFloor` false), and `during` run while
   * start writes it.
   */
  async function confirmedReview(
    during: () => Promise<void> | void,
    { restoredFloor = true }: { restoredFloor?: boolean } = {}
  ) {
    world.keyring.restoredFloor = restoredFloor
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    if (restoredFloor) {
      await world.wallet.confirmQbitRestoredFloorSigning(
        review.signatureBudget.restoredFloorRisk!.challengeId
      )
    }
    const set = world.storage.set.bind(world.storage)
    let first = true
    world.storage.set = async (key, value) => {
      if (first) {
        first = false
        await during()
      }
      return set(key, value)
    }
    return review
  }

  /** Start `draftId`; resolves to its result, failing the test if start never returns. */
  async function startReturning(draftId: string) {
    let returned = false
    const started = world.wallet.startQbitSendPlan(draftId).then(result => {
      returned = true
      return result
    })
    await world.settle()
    await vi.waitFor(() => expect(returned).toBe(true))
    return started
  }

  /** What a start that was undone must leave: no plan, nothing held, signed or confirmed by the engine. */
  async function assertStartUndone(review: { draftId: string }, confirmations: string[]) {
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(world.keyring.signed).toEqual([])
    expect(world.keyring.confirmations).toEqual(confirmations)
    expect(world.keyring.batches.size).toBe(0)
    expect(world.keyring.challenges.size).toBe(0)
    expect(await world.wallet.startQbitSendPlan(review.draftId)).toEqual({
      ok: false,
      reason: 'draft_expired',
    })
  }

  it('undoes a restored-floor start the wallet locked under: its draft and the confirmed challenge went before the first signature could check it', async () => {
    const review = await confirmedReview(() => world.wallet.lockWallet())
    const challengeId = review.signatureBudget.restoredFloorRisk!.challengeId
    expect(await startReturning(review.draftId)).toEqual({ ok: false, reason: 'draft_expired' })
    await assertStartUndone(review, [challengeId])
    // Nothing is left to go on after the unlock.
    await world.unlock()
    await world.tick()
    expect(await world.plan()).toBeNull()
    await assertStartUndone(review, [challengeId])
    world.assertRecipientGuarantees(undefined)
  })

  it('undoes a restored-floor start whose draft expired while the start wrote it, letting go of its batch and challenge', async () => {
    let expiresAt = 0
    const review = await confirmedReview(() => {
      vi.setSystemTime(expiresAt + 1)
      world.timers.runDue()
    })
    expiresAt = review.expiresAt
    const challengeId = review.signatureBudget.restoredFloorRisk!.challengeId
    expect(await startReturning(review.draftId)).toEqual({ ok: false, reason: 'draft_expired' })
    await assertStartUndone(review, [challengeId])
    await world.tick()
    expect(world.keyring.signed).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it('undoes a restored-floor start when a lock lets go of the page’s challenge before the first signature checked it', async () => {
    const review = await confirmedReview(() => undefined)
    const challengeId = review.signatureBudget.restoredFloorRisk!.challengeId
    // The wallet locks once the plan is stored and set going, just before
    // its first signature.
    const guard = guardHolder.guard as QbitSendGuardService
    const assertNoOverlap = guard.assertNoOverlap.bind(guard)
    vi.spyOn(guard, 'assertNoOverlap').mockImplementationOnce(async (...args) => {
      await world.wallet.lockWallet()
      return assertNoOverlap(...args)
    })
    expect(await startReturning(review.draftId)).toEqual({ ok: false, reason: 'draft_expired' })
    await world.unlock()
    await world.tick()
    expect(await world.plan()).toBeNull()
    await assertStartUndone(review, [challengeId])
    world.assertRecipientGuarantees(undefined)
  })

  it('returns an ordinary key’s start the wallet locked under, and the plan goes on after the unlock', async () => {
    const review = await confirmedReview(() => world.wallet.lockWallet(), { restoredFloor: false })
    // The lock let go of the draft and its batch: the plan pauses, and
    // opens a batch of its own after the unlock.
    expect(await startReturning(review.draftId)).toMatchObject({ ok: true })
    expect(await world.plan()).toMatchObject({ phase: 'paused', pause: { reason: 'locked' } })
    expect(world.keyring.signed).toEqual([])

    await world.unlock()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('returns a start whose network changed under it, and signs once the network is back', async () => {
    const review = await confirmedReview(() => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    })
    const started = await startReturning(review.draftId)
    expect(started).toMatchObject({ ok: true, plan: { phase: 'signing' } })
    expect(world.keyring.signed).toEqual([])

    vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('returns a start whose plan was cancelled before its first signature', async () => {
    world.keyring.restoredFloor = true
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    // The first signature waits; meanwhile another page cancels the plan.
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    const sign = world.keyring.signP2mrPsbtWithCounter
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementation((async (
      ...args: Parameters<typeof sign>
    ) => {
      await gate
      return sign(...args)
    }) as never)
    let returned = false
    const started = world.wallet.startQbitSendPlan(review.draftId).then(result => {
      returned = true
      return result
    })
    await vi.waitFor(() => expect(world.storedPlans()).toHaveLength(1))
    const planId = world.storedPlans()[0]!.id
    await expect(world.wallet.cancelQbitSendPlan(planId)).resolves.toBeNull()
    await vi.waitFor(() => expect(returned).toBe(true))
    expect(await started).toMatchObject({ ok: true })
    release()
    await world.settle()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(world.keyring.signed).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })
})

describe('a cancel that lands during a revision’s first signature (restored-floor keys)', () => {
  // A revision's start waits for its first signature, made under the
  // challenge the page confirmed. Another page's cancel stops that signing
  // and writes the plan cancelling; the start, finding its challenge gone,
  // would undo itself: an undo writes back the plan the revision replaced
  // only over the very record the start wrote, so the cancel stands.

  /** The keyring's next signing waits until `release`; `reached` resolves once it was asked for. */
  function holdNextSigning(): { reached: Promise<void>; release: () => void } {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let arrive: () => void = () => undefined
    const reached = new Promise<void>(resolve => (arrive = resolve))
    const sign = world.keyring.signP2mrPsbtWithCounter
    vi.mocked(keyringService.signP2mrPsbtWithCounter).mockImplementationOnce((async (
      ...args: Parameters<typeof sign>
    ) => {
      arrive()
      await gate
      return sign(...args)
    }) as never)
    return { reached, release }
  }

  /**
   * Start `draftId`, its challenge confirmed, and cancel plan `planId` from
   * another page while the start's first signature waits; then let the
   * signing go on.
   */
  async function cancelDuringFirstSignature(
    review: { draftId: string; signatureBudget: { restoredFloorRisk?: { challengeId: string } } },
    planId: string
  ) {
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const signing = holdNextSigning()
    const starting = world.wallet.startQbitSendPlan(review.draftId)
    await signing.reached
    const cancelled = await world.wallet.cancelQbitSendPlan(planId)
    signing.release()
    const started = await starting
    await world.settle()
    return { started, cancelled }
  }

  /** The outpoint keys of what a cancelling plan's carried merges spend. */
  function carriedInputs(planId: string): string[] {
    return (qbitSendPlanStore.get(planId)!.carried ?? [])
      .flatMap(item => item.inputs.map(input => `${input.txid}:${input.vout}`))
      .sort()
  }

  it('keeps the cancel of a replan carrying a merge of unknown outcome: the plan it replaced is not written back', async () => {
    world.keyring.restoredFloor = true
    const amount = 22_000_000
    const outpoints = world.fund(400, index => 100_000 + index)
    await world.open()
    // Ranked by value, the first merge spends the 106 largest outputs and
    // the second the next 106: the first goes out without a verdict, the
    // explorer never taking it, and the second is refused every time.
    world.refuseSpending.add(outpoints[250]!)
    world.explorer.failures.push(request =>
      isBroadcast(request) ? { status: 502, body: 'bad gateway', afterAccepting: false } : undefined
    )
    const review = await world.review({ target: { kind: 'amount', amount } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    if (!started.ok) throw new Error('not started')
    await world.settle()
    await world.tick()
    await world.tick()
    world.explorer.failures.length = 0
    world.refuseSpending.clear()
    const planId = started.plan.id
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'merge_refused' },
    })
    expect(world.storedStatuses()).toEqual(['unknown', 'planned', 'planned'])
    const replaced = qbitSendPlanStore.get(planId)!

    const replan = await world.review({
      target: { kind: 'amount', amount },
      revise: { planId, kind: 'replan' },
    })
    expect(replan.signatureBudget.restoredFloorRisk).toBeDefined()
    const signed = world.keyring.signed.length
    const pushed = world.pushed.length
    const { started: outcome, cancelled } = await cancelDuringFirstSignature(replan, planId)

    expect(cancelled).toMatchObject({ id: planId, phase: 'cancelling' })
    expect(outcome).toEqual({ ok: false, reason: 'draft_expired' })
    const cancelling = qbitSendPlanStore.get(planId)!
    expect(cancelling.phase).toBe('cancelling')
    expect(cancelling.steps.map(step => step.txid)).not.toEqual(
      replaced.steps.map(step => step.txid)
    )
    expect(cancelling.carried).toEqual([
      expect.objectContaining({ txid: replaced.steps[0]!.txid, status: 'unknown' }),
    ])
    // The cancel's holds: the inputs of the carried merge, nothing else.
    expect([...(await world.planHeld())].sort()).toEqual(carriedInputs(planId))
    expect(world.keyring.challenges.size).toBe(0)
    expect(world.keyring.batches.size).toBe(0)

    // The carried merge is proven absent: the plan is gone.
    await world.tick()
    await world.tick(QBIT_RECENT_SPEND_GONE_GRACE_MS)
    await world.tick()
    expect(world.storedPlans()).toEqual([])
    expect((await world.planHeld()).size).toBe(0)
    expect(world.keyring.signed).toHaveLength(signed)
    expect(world.pushed).toHaveLength(pushed)
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps the cancel of a raise carrying a merge of unknown outcome: the plan it replaced does not go on to pay', async () => {
    world.keyring.restoredFloor = true
    const amount = 120_000_000
    const funded = world.fund(150, 1_000_000)
    await world.open()
    world.explorer.acceptReplacements = true
    const review = await world.review({ target: { kind: 'amount', amount } })
    await world.wallet.confirmQbitRestoredFloorSigning(
      review.signatureBudget.restoredFloorRisk!.challengeId
    )
    const started = await world.wallet.startQbitSendPlan(review.draftId)
    if (!started.ok) throw new Error('not started')
    await world.settle()
    const planId = started.plan.id
    expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
    // The merge stays unconfirmed for long.
    await world.tick(31 * 60_000)
    // The plan carries a merge an earlier version of it sent, whose outcome
    // is unknown and which the explorer never answers for.
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    const spent = new Set(
      (document.plans[0].steps as { inputs: { txid: string; vout: number }[] }[]).flatMap(step =>
        step.inputs.map(input => `${input.txid}:${input.vout}`)
      )
    )
    const free = funded.find(outpoint => !spent.has(outpoint))!
    const [freeTxid, freeVout] = free.split(':')
    const carried = fakeTxid(9_996, 5)
    document.plans[0].carried = [
      {
        txid: carried,
        inputs: [{ txid: freeTxid, vout: Number(freeVout), satoshis: 1_000_000 }],
        fee: 10_000,
        status: 'unknown',
      },
    ]
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    world.explorer.failures.push(request =>
      isLookup(request) && request.path.includes(carried)
        ? { status: 400, body: 'lookup refused' }
        : undefined
    )
    await world.restart()
    await world.unlock()
    expect(await world.plan()).toMatchObject({
      phase: 'waiting',
      actions: ['raise_merge_fee', 'cancel'],
    })

    const prepared = await world.prepare({
      target: { kind: 'amount', amount },
      feeRate: 2,
      revise: { planId, kind: 'raise_merge_fee' },
    })
    if (!prepared.ok) throw new Error(`raise refused: ${prepared.reason}`)
    expect(prepared.review.signatureBudget.restoredFloorRisk).toBeDefined()
    const signed = world.keyring.signed.length
    const { started: outcome, cancelled } = await cancelDuringFirstSignature(
      prepared.review,
      planId
    )

    expect(cancelled).toMatchObject({ id: planId, phase: 'cancelling' })
    expect(outcome).toEqual({ ok: false, reason: 'draft_expired' })
    expect(qbitSendPlanStore.get(planId)!.phase).toBe('cancelling')
    expect([...(await world.planHeld())].sort()).toEqual(carriedInputs(planId))
    // The merge confirms: the plan the raise replaced, had it been written
    // back, would send its signed payment now.
    world.mine()
    await world.tick()
    await world.tick()
    expect(qbitSendPlanStore.get(planId)?.phase).toBe('cancelling')
    expect(world.pushed).not.toContain(started.plan.paymentTxid)
    expect(world.keyring.signed).toHaveLength(signed)
    world.assertRecipientGuarantees(undefined)
  })
})

describe('the auto-lock and the popup while a plan signs', () => {
  it('holds an auto-lock that falls due for the plan’s ceiling, survives the popup closing, and locks at once on the lock button', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(1, 50)
    void world.wallet.startQbitSendPlan(review.draftId)
    await reached
    const wallet = world.wallet as unknown as { autoLockDueAt: number | undefined }

    // The popup closes: the plan's signing belongs to no page.
    await world.wallet.onUiPortDisconnected('popup-1')
    wallet.autoLockDueAt = Date.now() - 1
    await expect(world.wallet.lockIfAutoLockOverdue()).resolves.toBe(false)
    expect(lockState.isUnlocked).toBe(true)

    // Past the ceiling (ten minutes, and twice the estimated signing time),
    // the auto-lock locks after all.
    vi.setSystemTime(Date.now() + 10 * 60_000 + 2 * review.estimatedSigningSeconds * 1000 + 1)
    await expect(world.wallet.lockIfAutoLockOverdue()).resolves.toBe(true)
    expect(lockState.isUnlocked).toBe(false)
  })

  it('locks at once on a system lock while the plan signs', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    const reached = hangSigning(1, 50)
    void world.wallet.startQbitSendPlan(review.draftId)
    await reached
    await expect(world.wallet.lockOnSystemEvent('computer-locked')).resolves.toBe(true)
    expect(lockState.isUnlocked).toBe(false)
  })
})

describe('a website’s signing and a plan', () => {
  const providerContext = {
    origin: 'https://dapp.example',
    account: account.address,
    chain: CHAIN,
    network: 'regtest' as const,
  }

  it('refuses a plan’s hold over inputs a website’s signing took, even one taken while that signing ran', async () => {
    const outpoints = world.fund(150, index => 100_000 + index)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    const largest = outpoints[149]!
    const toSign = await world.wallet.prepareQbitProviderPsbt(
      dappPsbtHex([largest], 100_149),
      {} as never
    )
    toSign.providerContext = providerContext

    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let reached: () => void = () => undefined
    const signing = new Promise<void>(resolve => (reached = resolve))
    world.keyring.beforeInput = async (_txid, index) => {
      if (index === 0) {
        reached()
        await gate
      }
    }
    const signed = world.wallet.signPsbtV2(toSign)
    await signing
    // The plan starts while the website's signature is being made.
    const started = world.wallet.startQbitSendPlan(review.draftId)
    release()
    await expect(signed).resolves.toMatchObject({ psbtHex: expect.any(String) })
    await expect(started).resolves.toEqual({ ok: false, reason: 'outputs_changed' })
    world.keyring.beforeInput = undefined
    expect(world.storedPlans()).toEqual([])
  })

  /** A website has the account sign a transaction spending `outpoints`, and never broadcasts it. */
  async function signedForWebsite(outpoints: string[], value: number): Promise<void> {
    const toSign = await world.wallet.prepareQbitProviderPsbt(
      dappPsbtHex(outpoints, value),
      {} as never
    )
    toSign.providerContext = providerContext
    await expect(world.wallet.signPsbtV2(toSign)).resolves.toMatchObject({
      psbtHex: expect.any(String),
    })
  }

  it('prepares a plan without an output a website had signed and never sent, and starts it', async () => {
    const outpoints = world.fund(150, index => 100_000 + index)
    await world.open()
    const largest = outpoints[149]!
    await signedForWebsite([largest], 100_149)

    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    await expect(world.wallet.startQbitSendPlan(review.draftId)).resolves.toMatchObject({
      ok: true,
    })
    const spent = qbitSendPlanStore
      .list()[0]!
      .steps.flatMap(step => step.inputs.map(input => `${input.txid}:${input.vout}`))
    expect(spent).not.toContain(largest)
    await world.settle()
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })

  it('refuses an amount only an output a website had signed could pay, with the largest it can send without it', async () => {
    const outpoints = world.fund(150, index => 100_000 + index)
    await world.open()
    const all = (await world.review({ target: { kind: 'everything' } })).amount
    await signedForWebsite([outpoints[149]!], 100_149)

    // Everything the plan can send now leaves that output out: its value,
    // less the fee its input (3,762 bytes) would have cost at 1 bit a byte.
    const everything = await world.review({ target: { kind: 'everything' } })
    expect(all - everything.amount).toBe(100_149 - 3_762)
    // The amount the whole balance paid before is refused before anything
    // is reserved, never started and refused at every start.
    await expect(world.prepare({ target: { kind: 'amount', amount: all } })).resolves.toEqual({
      ok: false,
      reason: 'insufficient_balance',
      maxSendable: everything.amount,
      unconfirmedSatoshis: 0,
    })
    const again = await world.review({ target: { kind: 'everything' } })
    await expect(world.wallet.startQbitSendPlan(again.draftId)).resolves.toMatchObject({
      ok: true,
    })
    await world.settle()
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed', amount: everything.amount })
    world.assertRecipientGuarantees(everything.amount)
  })

  it('refuses a website’s signing over what a plan holds', async () => {
    const outpoints = world.fund(150, index => 100_000 + index)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const held = await world.planHeld()
    const inPlan = outpoints.filter(key => held.has(key)).slice(0, 1)
    await expect(
      world.wallet.prepareQbitProviderPsbt(dappPsbtHex(inPlan, 100_000), {} as never)
    ).rejects.toThrow('held by an open send plan')
  })
})

describe('start-up', () => {
  it('pauses outputs_spent, held in full, a stored plan whose outputs another stored plan holds too', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const stored = qbitSendPlanStore.get(plan.id)!
    // A second plan, of another account, listing the same outputs.
    const other = anotherAccountsPlan(stored, '22'.repeat(32), 'c3'.repeat(16))
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    document.plans.push(other)
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await world.restart()

    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
    })
    expect((await world.planHeld()).size).toBeGreaterThan(100)
    world.mine()
    await world.tick()
    world.assertRecipientGuarantees(undefined)
  })

  it('holds at start exactly what a restart restores', async () => {
    world.fund(250, 100_000)
    await world.open()
    await world.startPlan({ target: { kind: 'everything' } })
    const stored = qbitSendPlanStore.list()[0]!
    const listed = new Set(
      qbitSendPlanStore.planHolds()[0]!.outpoints.map(({ txid, vout }) => `${txid}:${vout}`)
    )
    // Every input of every step, once: the merges' outputs are the payment's inputs.
    expect(listed.size).toBe(stored.steps.reduce((total, step) => total + step.inputs.length, 0))
    expect(await world.planHeld()).toEqual(listed)
    await world.restart()
    expect(await world.planHeld()).toEqual(listed)
  })

  it('goes on with a plan paused by a lock once the wallet’s own unlock completes', async () => {
    world.fund(150, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: 12_000_000 } })
    world.keyring.beforeInput = (_txid, index) => {
      if (index === 3) void world.wallet.lockWallet()
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    expect(await world.plan()).toMatchObject({ pause: { reason: 'locked' } })

    vi.mocked(keyringService.submitPassword).mockImplementation((async (
      _password: string,
      options: { beforeUnlock?: () => Promise<void> }
    ) => {
      await options.beforeUnlock?.()
      world.keyring.unlock()
    }) as never)
    vi.spyOn(world.wallet, 'getCurrentKeyring').mockResolvedValue(null)
    await world.wallet.unlock('password')
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
  })
})

describe('a plan whose payment may be in the network', () => {
  /**
   * A plan whose payment's broadcast had no answer, the explorer having
   * taken it or not, and whose lookups find nothing yet.
   */
  async function paymentUnknown(accepted: boolean): Promise<QbitSendPlanView> {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    world.explorer.failures.push(
      once(request =>
        isBroadcast(request)
          ? { status: 502, body: 'bad gateway', afterAccepting: accepted }
          : undefined
      ),
      request =>
        isLookup(request) && request.path.includes(plan.paymentTxid)
          ? { status: 400, body: 'lookup refused' }
          : undefined
    )
    await world.tick()
    expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
    return plan
  }

  /** Restart with a second stored plan, of another account, listing the same outputs. */
  async function restartWithConflict(): Promise<void> {
    const stored = qbitSendPlanStore.list()[0]!
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    document.plans.push(anotherAccountsPlan(stored, '22'.repeat(32), 'c3'.repeat(16)))
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await world.restart()
  }

  it('completes a plan paused at start-up once its payment is found, whatever it was paused for', async () => {
    const plan = await paymentUnknown(true)
    await restartWithConflict()
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: [],
    })
    // The lookups answer again: the network took the payment, and the plan
    // is complete with the popup closed.
    world.explorer.failures.length = 0
    await world.tick()
    const view = (await world.plan())!
    expect(view).toMatchObject({ id: plan.id, phase: 'completed', actions: ['dismiss'] })
    world.mine()
    await world.tick()
    await world.plan()
    expect(world.storedStatuses()).toEqual(['confirmed', 'confirmed'])
    world.assertRecipientGuarantees(12_000_000)
  })

  it('keeps looking a paused plan’s payment up with the popup closed, and offers its actions once it is proven not sent', async () => {
    await paymentUnknown(false)
    await restartWithConflict()
    world.explorer.failures.length = 0
    const paused = (await world.plan())!
    expect(paused).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: [],
    })
    // Nothing to offer while the payment may be in the network, but the
    // engine's timer goes on looking it up: the first miss starts the
    // grace, and a run of misses that lasts it proves the payment not sent.
    expect(world.timers.scheduled).toBe(1)
    await world.tick()
    expect(world.storedStatuses()).toEqual(['confirmed', 'unknown'])
    await world.tick(10 * 60_000)
    expect(world.storedStatuses()).toEqual(['confirmed', 'signed'])
    // Proven absent, it is not counted as sent; but its broadcast had no
    // verdict, so a node may hold it and it may still confirm: no replan
    // from other outputs is offered while it can, nor a cancel, which would
    // stop tracking it. Continue sends the same payment again, offered once
    // the wallet, locked since the restart, is unlocked.
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: [],
    })
    await world.unlock()
    expect(await world.plan()).toMatchObject({
      phase: 'paused',
      pause: { reason: 'outputs_spent' },
      actions: ['continue'],
    })
    expect(qbitSendPlanStore.list()[0]!.steps.at(-1)!.dispatch).toBe('unknown')
    world.assertRecipientGuarantees(undefined)
  })

  it('leaves no open plan with nothing to offer and nothing to wait for', async () => {
    world.fund(150, 100_000)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const base = qbitSendPlanStore.list()[0]!
    expect(base.steps.map(step => step.status)).toEqual(['broadcast', 'signed'])
    const reasons = [
      'locked',
      'interrupted',
      'merge_refused',
      'outputs_spent',
      'payment_fee_too_low',
      'payment_refused',
    ]
    const states: {
      phase: string
      reason?: string
      merge: string
      payment: string
      dispatch?: 'refused' | 'unknown' | undefined
    }[] = []
    for (const merge of ['broadcast', 'confirmed', 'unknown']) {
      for (const payment of ['signed', 'unknown']) {
        // What became of the payment's bytes: never sent, every broadcast
        // refused, or one without a verdict (a version that may still
        // confirm, though the payment itself is proven absent).
        for (const dispatch of [undefined, 'refused', 'unknown'] as const) {
          if (payment === 'unknown' && dispatch !== 'unknown') continue
          for (const phase of ['signing', 'waiting', 'sending'])
            states.push({ phase, merge, payment, dispatch })
          for (const reason of reasons) {
            states.push({ phase: 'paused', reason, merge, payment, dispatch })
          }
        }
      }
      states.push({ phase: 'cancelling', merge, payment: 'planned' })
    }
    for (const state of states) {
      const label = JSON.stringify(state)
      const [merge, payment] = base.steps
      const record = {
        ...base,
        phase: state.phase,
        steps: [
          { ...merge!, status: state.merge },
          state.payment === 'planned'
            ? (() => {
                const { signedPsbtHex: _bytes, ...rest } = payment!
                return { ...rest, status: 'planned' }
              })()
            : {
                ...payment!,
                status: state.payment,
                ...(state.dispatch ? { dispatch: state.dispatch } : {}),
              },
        ],
        ...(state.reason ? { pause: { reason: state.reason, at: Date.now() } } : {}),
        ...(state.phase === 'cancelling' ? { extra: { cancelledAt: Date.now() } } : {}),
      }
      if (!state.reason) delete (record as { pause?: unknown }).pause
      world.storage.values.set(
        QBIT_SEND_PLAN_STORE_KEY,
        JSON.stringify({ version: 1, plans: [record] })
      )
      await world.restart()
      await world.unlock()
      const view = await world.plan()
      if (view === null) continue
      // Never a cancel while the payment, or a version of it, may still
      // confirm: one would stop tracking it, and free its inputs.
      const stored = qbitSendPlanStore.get(view.id)
      // The view says a version may still confirm exactly while one whose
      // bytes left without a verdict is kept and the plan has not completed.
      if (stored) {
        const unknownVersion =
          stored.steps.at(-1)!.dispatch === 'unknown' ||
          (stored.earlierPayments ?? []).some(version => version.dispatch === 'unknown')
        expect(world.engine.viewOf(stored).paymentMayConfirm, label).toBe(
          stored.phase !== 'completed' && unknownVersion ? true : undefined
        )
      }
      if (stored && stored.phase !== 'completed' && stored.phase !== 'cancelling') {
        const last = stored.steps.at(-1)!
        if (last.dispatch === 'unknown' || last.status === 'unknown') {
          const shown = world.engine.viewOf(stored)
          expect(shown.actions, label).not.toContain('cancel')
          expect(shown.sent, label).toBe(true)
          await world.wallet.cancelQbitSendPlan(view.id)
          await world.settle()
          expect(qbitSendPlanStore.get(view.id)?.phase, label).not.toBe('cancelling')
          expect(qbitSendPlanStore.get(view.id), label).toBeDefined()
        }
      }
      const advancing = ['signing', 'waiting', 'sending', 'cancelling'].includes(view.phase)
      if (view.actions.length > 0 || advancing) continue
      // Paused with nothing to offer: only while its payment may be in the
      // network, which the engine keeps looking up until it is found or
      // proven not sent.
      expect(view.phase, label).toBe('paused')
      expect(state.payment, label).toBe('unknown')
      expect(world.timers.scheduled, label).toBe(1)
      await world.tick(10 * 60_000)
      const later = (await world.plan())!
      expect(later.actions.length > 0 || later.phase === 'completed', label).toBe(true)
    }
  })
})

describe('unreadable stored plans', () => {
  it('shows a stored plan this version cannot read to its account as paused unreadable, and cancel drops it alone', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    // A field this version does not know makes the record unreadable.
    document.plans[0].futureField = true
    document.plans.push({ id: 'd4'.repeat(16), chain: CHAIN, account: { address: 'qbrt1zother' } })
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await world.restart()

    const view = await world.plan()
    expect(view).toMatchObject({
      id: plan.id,
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
    // What it would hold cannot be read, so it holds nothing.
    expect((await world.planHeld()).size).toBe(0)
    expect(await world.prepare({ target: { kind: 'amount', amount: 12_000_000 } })).toMatchObject({
      ok: false,
      reason: 'plan_open',
    })
    await expect(world.wallet.cancelQbitSendPlan(plan.id)).resolves.toBeNull()
    const kept = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    expect(kept.plans.map((item: { id: string }) => item.id)).toEqual(['d4'.repeat(16)])
    expect(await world.plan()).toBeNull()
  })
})

describe('unreadable stored plans without a readable id', () => {
  it('drops only the entry shown to the account on its cancel, not other accounts’ or networks’', async () => {
    world.fund(150, 100_000)
    await world.open()
    await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    const document = JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)
    // This version rejects the plan's id; its network and account read.
    document.plans[0].id = 'Z'.repeat(32)
    const otherAccount = { chain: CHAIN, account: { address: 'qbrt1zother' } }
    const otherNetwork = { chain: ChainType.QBIT_TESTNET4, account: { address: account.address } }
    document.plans.push(otherAccount, otherNetwork)
    world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(document))
    await world.restart()

    const view = await world.plan()
    expect(view).toMatchObject({
      id: 'unreadable',
      phase: 'paused',
      pause: { reason: 'unreadable' },
      actions: ['cancel'],
    })
    await expect(world.wallet.cancelQbitSendPlan('unreadable')).resolves.toBeNull()
    expect(JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!).plans).toEqual([
      otherAccount,
      otherNetwork,
    ])
    expect(await world.plan()).toBeNull()
    // The other network's account still sees its own.
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    expect(await world.wallet.getQbitSendPlan()).toMatchObject({ pause: { reason: 'unreadable' } })
  })
})

describe('explorer load', () => {
  /** How many times each transaction was read, by kind of read, in `requests`. */
  function readsByTransaction(requests: readonly { path: string }[]) {
    const reads = new Map<string, { lifecycle: number; outspends: number }>()
    for (const { path } of requests) {
      const match = path.match(/^\/tx\/([0-9a-f]{64})\/(status|outspends)$/)
      if (!match) continue
      const counts = reads.get(match[1]!) ?? { lifecycle: 0, outspends: 0 }
      if (match[2] === 'status') counts.lifecycle += 1
      else counts.outspends += 1
      reads.set(match[1]!, counts)
    }
    return reads
  }

  it('reads each transaction at most once a tick, however often pages read the plan', async () => {
    world.fund(1000, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'everything' } })
    const merges = plan.steps.length - 1
    expect(merges).toBeGreaterThan(8)
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    const from = world.explorer.requests.length
    // Two pages read every 5 s for a minute.
    for (let read = 0; read < 12; read++) {
      vi.setSystemTime(Date.now() + 5_000)
      await Promise.all([world.wallet.getQbitSendPlan(), world.wallet.getQbitSendPlan()])
      await world.settle()
    }
    const requests = world.explorer.requests.slice(from)
    const reads = readsByTransaction(requests)
    expect(reads.size).toBeGreaterThan(0)
    for (const counts of reads.values()) {
      expect(counts.lifecycle).toBeLessThanOrEqual(4)
      expect(counts.outspends).toBeLessThanOrEqual(4)
    }
    // At most two requests a lifecycle read and one an outspends read, for
    // every merge and the payment, four times in the minute.
    expect(requests.length).toBeLessThanOrEqual(4 * (2 * (merges + 1) + merges))
  })
})

describe('networks', () => {
  it('stops signing before the next signature when the wallet leaves the plan’s network, holds no auto-lock there, and signs on when it is back', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    let switched = false
    world.keyring.beforeInput = (_txid, index) => {
      if (!switched && index === 30) {
        switched = true
        vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
      }
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    // Thirty-one signatures: the one under way when the network changed,
    // and none after it.
    expect(world.keyring.counter).toBe(31)
    expect(world.keyring.signed).toEqual([])
    expect(world.storedStatuses()).toEqual(['planned', 'planned', 'planned'])
    expect(world.keyring.batches.size).toBe(0)
    await world.tick()
    expect(world.keyring.counter).toBe(31)
    // Nothing signs, so an auto-lock that falls due locks.
    const wallet = world.wallet as unknown as { autoLockDueAt: number | undefined }
    wallet.autoLockDueAt = Date.now() - 1
    await expect(world.wallet.lockIfAutoLockOverdue()).resolves.toBe(true)
    expect(lockState.isUnlocked).toBe(false)
    await world.unlock()

    vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    // The merge was signed again from its first input.
    expect(world.keyring.counter).toBe(31 + review.signatureCount)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('waits for continue when the key signed once elsewhere after the plan’s signing stopped for another network', async () => {
    world.fund(250, 100_000)
    await world.open()
    const review = await world.review({ target: { kind: 'everything' } })
    let switched = false
    world.keyring.beforeInput = (_txid, index) => {
      if (!switched && index === 30) {
        switched = true
        vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
      }
    }
    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()
    world.keyring.beforeInput = undefined
    // Stopped before its next input: 31 units, each with its signature.
    expect(world.keyring.counter).toBe(31)
    // The same key signs once on the other network.
    world.keyring.signElsewhere(1)

    vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
    await world.tick()
    const view = (await world.plan())!
    expect(view).toMatchObject({
      phase: 'paused',
      pause: {
        reason: 'interrupted',
        detail: 'The signature budget changed since the plan was approved',
      },
      actions: ['continue', 'cancel'],
    })
    expect(world.keyring.counter).toBe(32)
    await world.wallet.continueQbitSendPlan(view.id)
    await world.settle()
    expect(await world.plan()).toMatchObject({ phase: 'waiting' })
    expect(world.keyring.counter).toBe(32 + review.signatureCount)
    world.mine()
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(review.amount)
  })

  it('leaves a plan of another network untouched until that network is active again', async () => {
    world.fund(150, 100_000)
    await world.open()
    const plan = await world.startPlan({ target: { kind: 'amount', amount: 12_000_000 } })
    world.mine()
    const stored = qbitSendPlanStore.get(plan.id)!
    vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
    await world.tick()
    await world.tick()
    expect(qbitSendPlanStore.get(plan.id)!.revision).toBe(stored.revision)
    expect(await world.wallet.getQbitSendPlan()).toBeNull()
    world.assertRecipientGuarantees(undefined)

    vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
    await world.tick()
    expect(await world.plan()).toMatchObject({ phase: 'completed' })
    world.assertRecipientGuarantees(12_000_000)
  })
})
