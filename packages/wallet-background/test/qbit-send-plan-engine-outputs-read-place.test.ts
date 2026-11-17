import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { preferenceService } from '../src/services'
import {
  QBIT_SEND_PLAN_SLOW_MERGE_MS,
  type QbitSendPlanEngineHost,
} from '../src/services/qbitSendPlanEngine'
import {
  CHAIN,
  T0,
  World,
  account,
  newPlanGuard,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A send plan's read of the account's outputs takes its place among the
// wallet's clears of what it keeps for the balance when the plan is asked
// for it, before the lookups a revision waits for: a lock and an unlock
// while those run leave that read keeping nothing, however late it starts.
// The account here has more outputs than the explorer lists, so its outputs
// are read from its history, and the balance takes its split only from such
// a read kept since.

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.clearAllMocks()
  lockState.isUnlocked = true
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
  vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
  newPlanGuard(guardHolder)
  world = new World(lockState, () => newPlanGuard(guardHolder))
  wirePlanKeyring(world)
  watchPlanAnnouncements(() => world)
})

afterEach(() => {
  world.assertGuarantees()
  if (world.wallet) world.engine.reset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * A plan of 120,000,000 bits over 150 outputs of a million (one merge of
 * 106, then the payment), its merge sent and still unconfirmed long enough
 * to offer a raise of its fee. Then the account is paid as many times again
 * as the explorer lists outputs, so that its outputs are read from history.
 */
async function slowPlanPastListingLimit(): Promise<QbitSendPlanView> {
  world.fund(150, 1_000_000)
  await world.open()
  world.explorer.acceptReplacements = true
  await world.startPlan({ target: { kind: 'amount', amount: 120_000_000 } })
  await world.tick(QBIT_SEND_PLAN_SLOW_MERGE_MS + 60_000)
  const view = (await world.plan())!
  expect(view).toMatchObject({ phase: 'waiting', slowMerge: true })
  world.fund(world.explorer.utxoLimit, 10_000)
  return view
}

/** A raise of the fee of the plan's merge, as the plan screen asks for one. */
function raiseMergeFee(view: QbitSendPlanView) {
  return world.prepare({
    target: { kind: 'amount', amount: view.amount },
    feeRate: 2,
    revise: { planId: view.id, kind: 'raise_merge_fee' },
  })
}

/** The account's balance, past the explorer's limit: split only from a read kept since. */
const balance = () => world.wallet.getAddressBalanceV2(account.address)

/** What the plans read through, the wallet's own. */
const plansHost = () => (world.engine as unknown as { host: QbitSendPlanEngineHost }).host

describe('a send plan’s read of outputs, placed among the wallet’s clears when it is asked for', () => {
  it('reads a raise’s outputs under the place it took when asked, and keeps that read for the balance', async () => {
    const view = await slowPlanPastListingLimit()
    const host = plansHost()
    const begun = vi.spyOn(host, 'beginOutputsRead')
    const reads = vi.spyOn(host, 'spendableOutputs')
    await expect(balance()).resolves.toMatchObject({
      availableBalance: null,
      utxoLimitExceeded: true,
    })

    const raised = await raiseMergeFee(view)

    expect(raised.ok).toBe(true)
    expect(begun).toHaveBeenCalledTimes(1)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(reads.mock.calls[0]![3]).toBe(begun.mock.results[0]!.value)
    // Nothing was cleared since it was asked: its read of the history is
    // kept, and the balance takes its split from it.
    const after = await balance()
    expect(after.utxoLimitExceeded).toBe(true)
    expect(after.availableBalance).toEqual(expect.any(Number))
  })

  it('keeps nothing of the read of a raise asked for before a lock and an unlock during its lookups', async () => {
    const view = await slowPlanPastListingLimit()
    const host = plansHost()
    const lookUp = host.lifecycle.bind(host)
    let lookups = 0
    vi.spyOn(host, 'lifecycle').mockImplementation(async (chain, txid) => {
      if (lookups++ === 0) {
        // The wallet locks, and is unlocked again, while the raise looks
        // its merge up before it reads the outputs.
        await world.wallet.lockWallet()
        await world.unlock()
      }
      return lookUp(chain, txid)
    })
    const reads = vi.spyOn(host, 'spendableOutputs')

    await raiseMergeFee(view)

    expect(lookups).toBeGreaterThan(0)
    expect(world.wallet.isUnlocked()).toBe(true)
    // It read every output from the history after the unlock...
    expect(reads).toHaveBeenCalledTimes(1)
    const outputs = await reads.mock.results[0]!.value
    expect(outputs.length).toBeGreaterThan(world.explorer.utxoLimit)
    // ...and keeps none of them for the balance.
    await expect(balance()).resolves.toMatchObject({
      availableBalance: null,
      utxoLimitExceeded: true,
    })
  })
})
