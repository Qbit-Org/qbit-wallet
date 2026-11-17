import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'

import {
  contactBookService,
  keyringService,
  permissionService,
  preferenceService,
} from '../src/services'
import { QBIT_SEND_PLAN_TICK_MS } from '../src/services/qbitSendPlanEngine'
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
  newPlanGuard,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A wallet reset that fails partway (#206). A stored signed payment needs no
// key to be broadcast, so once the keyring reset has erased the keys no
// stored plan goes on again, whichever step after it fails: the plans are
// erased next, and the engine goes on only over a store known to hold none.
// A keyring reset that fails leaves the plans as a restart does: whether its
// keys are gone is what storage holds, which is what a restart reads, and
// while that cannot be read the plans stay stopped.

const lockState = vi.hoisted(() => ({ isUnlocked: true }))
/**
 * The keyring service's vault: `kept` in memory (`hasVault`), `stored` in
 * storage (`hasPersistedVault`, what a restart reads). A keyring reset that
 * succeeds erases both, storage first. `unreadable` makes the storage read
 * fail; `unanswerable` makes `hasVault` throw, as a keyring that never
 * loaded does.
 */
const vault = vi.hoisted(() => ({
  kept: true,
  stored: true,
  unreadable: false,
  unanswerable: false,
}))
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
      hasVault: vi.fn(() => {
        if (vault.unanswerable) throw new TypeError('the keyring service has not loaded')
        return vault.kept
      }),
      hasPersistedVault: vi.fn(async () => {
        if (vault.unreadable) throw new Error('storage read failed')
        return vault.stored
      }),
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
      // As the keyring service's reset: the vault is gone, from storage and
      // then from memory, and the wallet reads locked, once its writes are
      // done.
      resetAllData: vi.fn(async () => {
        vault.stored = false
        vault.kept = false
        lockState.isUnlocked = false
      }),
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

const AMOUNT = 12_000_000
/** What a plan of the wallet set up after the reset pays: told apart from `AMOUNT`. */
const NEW_AMOUNT = 22_000_000

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
  Object.assign(vault, { kept: true, stored: true, unreadable: false, unanswerable: false })
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

/**
 * A plan with its merge in the network, unconfirmed, and its payment signed
 * and stored: a plan that goes on broadcasts the payment, which needs no
 * key, once the merge confirms.
 */
async function signedPaymentWaiting(): Promise<{ paymentTxid: string }> {
  world.fund(150, 100_000)
  await world.open()
  const plan = await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
  expect(world.storedStatuses()).toEqual(['broadcast', 'signed'])
  return { paymentTxid: plan.paymentTxid }
}

/** The keyring reset erases the keys, and from then on every storage write fails until `recover`. */
function storageFailsOnceKeysAreGone(): { recover: () => void } {
  const set = world.storage.set.bind(world.storage)
  let failing = false
  world.storage.set = async (key, value) => {
    if (failing) throw new Error('storage write failed')
    return set(key, value)
  }
  vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
    vault.stored = false
    vault.kept = false
    lockState.isUnlocked = false
    failing = true
  })
  return { recover: () => (failing = false) }
}

/** Each step of the reset after the keyring reset, failing once. */
const LATER_STEPS: [string, string, () => void][] = [
  [
    'the send guard',
    'guard reset failed',
    () => {
      vi.spyOn(guardHolder.guard as QbitSendGuardService, 'resetAllData').mockRejectedValueOnce(
        new Error('guard reset failed')
      )
    },
  ],
  [
    'the plan store',
    'storage write failed',
    () => {
      // The keyring reset writes nothing to this storage: the next write is
      // the plan store's erase.
      vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
        vault.stored = false
        vault.kept = false
        lockState.isUnlocked = false
        world.storage.failNextSet = new Error('storage write failed')
      })
    },
  ],
  [
    'the preferences',
    'preference reset failed',
    () => {
      vi.mocked(preferenceService.resetAllData).mockRejectedValueOnce(
        new Error('preference reset failed')
      )
    },
  ],
  [
    'the permissions',
    'permission reset failed',
    () => {
      vi.mocked(permissionService.resetAllData).mockRejectedValueOnce(
        new Error('permission reset failed')
      )
    },
  ],
  [
    'the contacts',
    'contact reset failed',
    () => {
      vi.mocked(contactBookService.resetAllData).mockRejectedValueOnce(
        new Error('contact reset failed')
      )
    },
  ],
]

/** What left the wallet, and what the explorer accepted, so far. */
function sentSoFar(): { pushed: number; accepted: number } {
  return { pushed: world.pushed.length, accepted: world.explorer.accepted.length }
}

/**
 * The merge confirms, then time passes over every timer and a page reads
 * the plan at each step: nothing leaves the wallet, the explorer accepts
 * nothing, and no page is shown a plan.
 */
async function expectNothingGoesOn(
  before: { pushed: number; accepted: number },
  paymentTxid: string
): Promise<void> {
  world.mine()
  const shown: unknown[] = []
  for (const ms of [
    QBIT_SEND_PLAN_TICK_MS,
    QBIT_SEND_PLAN_TICK_MS,
    QBIT_RECENT_SPEND_GONE_GRACE_MS,
    60 * 60_000,
  ]) {
    await world.tick(ms)
    shown.push(await world.plan())
    await flush()
  }
  expect(world.pushed.slice(before.pushed)).toEqual([])
  expect(world.pushed).not.toContain(paymentTxid)
  expect(world.explorer.accepted.slice(before.accepted)).toEqual([])
  expect(shown).toEqual([null, null, null, null])
}

/** Nothing of a plan is left: no record, stored or in memory, and no hold. */
async function expectNoPlanLeft(): Promise<void> {
  expect(world.storedPlans()).toEqual([])
  expect(qbitSendPlanStore.list()).toEqual([])
  expect(qbitSendPlanStore.unreadable()).toEqual({ plans: [] })
  expect((await world.planHeld()).size).toBe(0)
}

/** The next write of the plan store waits until `open`, then lands, or fails with the error given. */
function holdNextPlanStoreWrite(): { reached: Promise<void>; open: (failure?: Error) => void } {
  const set = world.storage.set.bind(world.storage)
  let open: (failure?: Error) => void = () => undefined
  const opened = new Promise<Error | undefined>(resolve => (open = resolve))
  let arrive: () => void = () => undefined
  const reached = new Promise<void>(resolve => (arrive = resolve))
  let held = false
  world.storage.set = async (key, value) => {
    if (key === QBIT_SEND_PLAN_STORE_KEY && !held) {
      held = true
      arrive()
      const failure = await opened
      if (failure) throw failure
    }
    return set(key, value)
  }
  return { reached, open }
}

/** Work the engine started off a timer, which `settle` does not wait for, has ended. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setTimeout(resolve, 0))
  await world.settle()
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
 * A wallet is set up again after the reset (the same seed restored, here,
 * so the same account) and unlocked, and pays `NEW_AMOUNT` with a plan of
 * its own, which completes: the engine works for it.
 */
async function newWalletPlanCompletes(): Promise<void> {
  vault.stored = true
  vault.kept = true
  await world.unlock()
  // Enough that the amount needs merges whether or not the erased plan's
  // merge confirmed: its output alone pays half of it.
  world.fund(250, 100_000)
  await world.startPlan({ target: { kind: 'amount', amount: NEW_AMOUNT } })
  await completes()
  world.assertRecipientGuarantees(NEW_AMOUNT)
}

describe('a wallet reset that fails after the keys are erased', () => {
  it.each(LATER_STEPS)(
    'sends nothing of a stored plan when %s fails, as its merge confirms, over every timer and page read',
    async (_step, message, fail) => {
      const { paymentTxid } = await signedPaymentWaiting()
      const before = sentSoFar()
      fail()

      await expect(world.wallet.resetAllData()).rejects.toThrow(message)

      await expectNothingGoesOn(before, paymentTxid)
      await expectNoPlanLeft()
      world.assertRecipientGuarantees(undefined)
    }
  )

  it.each(LATER_STEPS)(
    'completes the reset tried again after %s failed, leaves nothing of a plan, and works for a wallet set up since',
    async (_step, message, fail) => {
      const { paymentTxid } = await signedPaymentWaiting()
      const before = sentSoFar()
      fail()
      await expect(world.wallet.resetAllData()).rejects.toThrow(message)

      // Tried again at once: the second halt finds nothing under way.
      await world.wallet.resetAllData()

      await expectNoPlanLeft()
      expect(world.pushed.slice(before.pushed)).toEqual([])
      await newWalletPlanCompletes()
      expect(world.pushed).not.toContain(paymentTxid)
    }
  )

  it('keeps the plans stopped while their erase keeps failing, and erases them at a tick once storage writes again', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    const storage = storageFailsOnceKeysAreGone()
    const stored = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)

    await expect(world.wallet.resetAllData()).rejects.toThrow('storage write failed')

    // Every tick tries the erase again, and fails: nothing goes on, and the
    // stored plan is left exactly as it was.
    await expectNothingGoesOn(before, paymentTxid)
    expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(stored)
    expect(world.storedPlans()).toHaveLength(1)
    // No plan begins for the account meanwhile.
    await expect(world.prepare({ target: { kind: 'amount', amount: 1_000_000 } })).rejects.toThrow()

    storage.recover()
    await world.tick()
    await flush()

    await expectNoPlanLeft()
    expect(world.pushed.slice(before.pushed)).toEqual([])
    await newWalletPlanCompletes()
    expect(world.pushed).not.toContain(paymentTxid)
  })

  it('stops the plans when the keyring reset fails after the vault is gone', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
      vault.stored = false
      vault.kept = false
      lockState.isUnlocked = false
      throw new Error('keyring reset failed late')
    })

    await expect(world.wallet.resetAllData()).rejects.toThrow('keyring reset failed late')

    await expectNothingGoesOn(before, paymentTxid)
    await expectNoPlanLeft()
    world.assertRecipientGuarantees(undefined)
  })

  it('keeps the plans stopped when a wallet is set up again before the erase of the stored plans fails', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
      lockState.isUnlocked = false
      world.storage.failNextSet = new Error('storage write failed')
      // Another window sets up a wallet while the reset goes on: by the time
      // the plans would go on, a vault is kept again.
      vault.kept = true
    })

    await expect(world.wallet.resetAllData()).rejects.toThrow('storage write failed')

    await expectNothingGoesOn(before, paymentTxid)
    await expectNoPlanLeft()
    world.assertRecipientGuarantees(undefined)
  })

  it('erases the stored plans and lets go of their holds before the preferences are reset', async () => {
    await signedPaymentWaiting()
    let atPreferences: { stored: number; held: number } | undefined
    vi.mocked(preferenceService.resetAllData).mockImplementationOnce(async () => {
      atPreferences = { stored: world.storedPlans().length, held: (await world.planHeld()).size }
      throw new Error('preference reset failed')
    })

    await expect(world.wallet.resetAllData()).rejects.toThrow('preference reset failed')

    expect(atPreferences).toEqual({ stored: 0, held: 0 })
    // Nothing is left at once, before any tick.
    await expectNoPlanLeft()
  })

  it('goes on once when a retry of the erase falls due while a reset tried again is under way', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    LATER_STEPS[1]![2]()
    await expect(world.wallet.resetAllData()).rejects.toThrow('storage write failed')
    const goOn = vi.spyOn(world.engine as never, 'goOn' as never)

    // A tick tries the erase again, and its write waits.
    const retry = holdNextPlanStoreWrite()
    await world.tick(QBIT_SEND_PLAN_TICK_MS, { settle: false })
    await retry.reached
    // The reset is tried again meanwhile; it waits at the preferences.
    let preferencesReset: () => void = () => undefined
    vi.mocked(preferenceService.resetAllData).mockImplementationOnce(
      () => new Promise<void>(resolve => (preferencesReset = resolve))
    )
    const again = world.wallet.resetAllData()
    await flush()
    // The retry's write fails while that reset is under way, and the next
    // tick comes before it is over.
    retry.open(new Error('storage write failed'))
    await flush()
    const late = holdNextPlanStoreWrite()
    await world.tick(QBIT_SEND_PLAN_TICK_MS, { settle: false })
    await flush()
    preferencesReset()
    await again
    late.open()
    await flush()

    expect(goOn).toHaveBeenCalledTimes(1)
    await expectNoPlanLeft()
    expect(world.pushed.slice(before.pushed)).toEqual([])
    await newWalletPlanCompletes()
    expect(world.pushed).not.toContain(paymentTxid)
  })

  it('goes on once when a retry erases the stored plans while a reset tried again is under way', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    LATER_STEPS[1]![2]()
    await expect(world.wallet.resetAllData()).rejects.toThrow('storage write failed')
    const goOn = vi.spyOn(world.engine as never, 'goOn' as never)

    const retry = holdNextPlanStoreWrite()
    await world.tick(QBIT_SEND_PLAN_TICK_MS, { settle: false })
    await retry.reached
    let preferencesReset: () => void = () => undefined
    vi.mocked(preferenceService.resetAllData).mockImplementationOnce(
      () => new Promise<void>(resolve => (preferencesReset = resolve))
    )
    const again = world.wallet.resetAllData()
    await flush()
    // The retry's erase lands while that reset is under way: the reset goes
    // on at its own end, and the retry does not.
    retry.open()
    await flush()
    expect(goOn).not.toHaveBeenCalled()
    preferencesReset()
    await again
    await flush()

    expect(goOn).toHaveBeenCalledTimes(1)
    await expectNoPlanLeft()
    expect(world.pushed.slice(before.pushed)).toEqual([])
    await newWalletPlanCompletes()
    expect(world.pushed).not.toContain(paymentTxid)
  })
})

describe('a start after a reset that erased the keys and not the stored plans', () => {
  it('erases the plans before anything holds or advances them, and sends nothing of them', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    LATER_STEPS[1]![2]()
    await expect(world.wallet.resetAllData()).rejects.toThrow('storage write failed')
    expect(world.storedPlans()).toHaveLength(1)

    // The service worker restarts before anything erased them: no vault.
    await world.restart()

    await expectNoPlanLeft()
    await expectNothingGoesOn(before, paymentTxid)
    await expectNoPlanLeft()
    world.assertRecipientGuarantees(undefined)
    await newWalletPlanCompletes()
    expect(world.pushed).not.toContain(paymentTxid)
  })

  it('keeps them stopped when the erase at the start fails too, and erases them once storage writes again', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    const storage = storageFailsOnceKeysAreGone()
    await expect(world.wallet.resetAllData()).rejects.toThrow('storage write failed')

    await world.restart()

    expect(world.storedPlans()).toHaveLength(1)
    expect((await world.planHeld()).size).toBe(0)
    await expectNothingGoesOn(before, paymentTxid)
    expect(world.storedPlans()).toHaveLength(1)
    expect((await world.planHeld()).size).toBe(0)

    storage.recover()
    await world.tick()
    await flush()

    await expectNoPlanLeft()
    await newWalletPlanCompletes()
    expect(world.pushed).not.toContain(paymentTxid)
  })

  it('holds and advances the stored plans as before when the wallet keeps its keys', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const held = await world.planHeld()

    await world.restart()

    expect(world.storedPlans()).toHaveLength(1)
    expect(await world.planHeld()).toEqual(held)
    world.mine()
    await world.tick()
    expect(world.pushed).toContain(paymentTxid)
    await completes()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('holds and advances the stored plans as before at a start whose keyring cannot say whether it keeps a vault', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const held = await world.planHeld()
    vault.unanswerable = true

    await world.restart()

    expect(world.storedPlans()).toHaveLength(1)
    expect(await world.planHeld()).toEqual(held)
    vault.unanswerable = false
    world.mine()
    await world.tick()
    expect(world.pushed).toContain(paymentTxid)
    await completes()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it.each([
    ['a document this version cannot read', (plan: object) => ({ version: 2, plans: [plan] })],
    [
      'an entry this version cannot read',
      (plan: object) => ({ version: 1, plans: [{ ...plan, steps: 'unreadable' }] }),
    ],
  ])(
    'erases at a start with no vault %s, which may hold a signed payment',
    async (_what, unreadable) => {
      await signedPaymentWaiting()
      const [plan] = world.storedPlans()
      world.storage.values.set(QBIT_SEND_PLAN_STORE_KEY, JSON.stringify(unreadable(plan!)))
      vault.stored = false
      vault.kept = false

      await world.restart()

      expect(JSON.parse(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)!)).toEqual({
        version: 1,
        plans: [],
      })
      await expectNoPlanLeft()
    }
  )
})

describe('a wallet reset whose keyring reset fails', () => {
  it('leaves the plans as a restart does: held, and going on to completion', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const held = await world.planHeld()
    vi.mocked(keyringService.resetAllData).mockRejectedValueOnce(new Error('reset failed'))

    await expect(world.wallet.resetAllData()).rejects.toThrow('reset failed')

    expect(vault.kept).toBe(true)
    expect(await world.planHeld()).toEqual(held)
    world.mine()
    await world.tick()
    expect(world.pushed).toContain(paymentTxid)
    await completes()
    world.assertRecipientGuarantees(AMOUNT)
  })

  it('sends nothing when it fails after erasing the stored vault, which memory still holds, and the plans end erased as at a restart', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
      // The erased state is stored, and the next write fails: memory, still
      // unlocked, keeps the vault.
      vault.stored = false
      throw new Error('cached keys write failed')
    })

    await expect(world.wallet.resetAllData()).rejects.toThrow('cached keys write failed')

    expect({ kept: vault.kept, unlocked: lockState.isUnlocked }).toEqual({
      kept: true,
      unlocked: true,
    })
    await expectNothingGoesOn(before, paymentTxid)
    await expectNoPlanLeft()
    // A restart over that storage keeps nothing either.
    vault.kept = vault.stored
    await world.restart()
    await expectNoPlanLeft()
    expect(world.pushed.slice(before.pushed)).toEqual([])
    world.assertRecipientGuarantees(undefined)
  })

  it.each([
    ['still holds the vault', true],
    ['holds no vault', false],
  ])(
    'keeps the plans stopped while storage cannot be read, and settles at a tick once it can and %s',
    async (_holds, stored) => {
      const { paymentTxid } = await signedPaymentWaiting()
      const before = sentSoFar()
      const held = await world.planHeld()
      vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
        vault.stored = stored
        vault.unreadable = true
        throw new Error('keyring reset failed')
      })
      await expect(world.wallet.resetAllData()).rejects.toThrow('keyring reset failed')
      const document = world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)

      // Whether the keys are gone is not known: the plans stay as they are,
      // stored and held, and nothing of them goes on.
      await expectNothingGoesOn(before, paymentTxid)
      expect(world.storage.values.get(QBIT_SEND_PLAN_STORE_KEY)).toBe(document)
      expect(await world.planHeld()).toEqual(held)

      vault.unreadable = false
      await world.tick()
      await flush()

      if (stored) {
        // As after a restart: the plan goes on, and its payment goes out.
        expect(world.pushed).toContain(paymentTxid)
        await completes()
        world.assertRecipientGuarantees(AMOUNT)
      } else {
        await expectNoPlanLeft()
        expect(world.pushed.slice(before.pushed)).toEqual([])
        world.assertRecipientGuarantees(undefined)
      }
    }
  )

  it('is settled by the next reset while storage cannot be read: it completes, leaves nothing, and plans work for a wallet set up since', async () => {
    const { paymentTxid } = await signedPaymentWaiting()
    const before = sentSoFar()
    vi.mocked(keyringService.resetAllData).mockImplementationOnce(async () => {
      vault.stored = false
      vault.unreadable = true
      throw new Error('keyring reset failed')
    })
    await expect(world.wallet.resetAllData()).rejects.toThrow('keyring reset failed')

    await world.wallet.resetAllData()

    await expectNoPlanLeft()
    expect(world.pushed.slice(before.pushed)).toEqual([])
    await newWalletPlanCompletes()
    expect(world.pushed).not.toContain(paymentTxid)
  })
})
