import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainType } from '@qbit/wallet-types'
import { keyringService, preferenceService } from '../src/services'
import { QBIT_SEND_PLAN_SLOW_MERGE_MS } from '../src/services/qbitSendPlanEngine'
import qbitSendPlanStore from '../src/services/qbitSendPlanStore'
import { qbitSendPlanAccountKeys } from '../src/utils/qbit-send-plan-psbt'
import { fakeTxid } from './qbit-fake-explorer'
import {
  CHAIN,
  T0,
  World,
  account,
  newPlanGuard,
  p2mrAccount,
  watchPlanAnnouncements,
  wirePlanKeyring,
} from './qbit-send-plan-engine-harness'

// A send plan checks the inputs of each transaction before it signs it
// (#210): every merge, the payment and each version a fee raise builds. An
// input spending an output of one of the plan's own steps is checked against
// the transaction the plan stored for that step; every other input's funding
// transaction is read from the explorer, riding out its server errors.

/** Every check of a step's inputs (`checkQbitSpendInputs`), with the lookups it made. */
const spendChecks = vi.hoisted(() => ({
  calls: [] as {
    inputs: { txid: string; vout: number; satoshis: number }[]
    own: ReadonlyMap<string, unknown> | undefined
    rideOut: boolean
    lookups: string[]
  }[],
  requests: (): { path: string }[] => [],
}))
vi.mock('../src/utils/qbit-api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/qbit-api')>()
  return {
    ...actual,
    checkQbitSpendInputs: async (...args: Parameters<typeof actual.checkQbitSpendInputs>) => {
      const before = spendChecks.requests().length
      try {
        return await actual.checkQbitSpendInputs(...args)
      } finally {
        spendChecks.calls.push({
          inputs: args[2].map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis })),
          own: args[3]?.ownTransactions,
          rideOut: args[3]?.rideOutServerErrors === true,
          lookups: spendChecks
            .requests()
            .slice(before)
            .map(({ path }) => path)
            .filter(path => /^\/tx\/[0-9a-f]{64}$/.test(path))
            .map(path => path.slice(4)),
        })
      }
    },
  }
})

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

/** 121 of 150 outputs of a million bits: one merge of 106, and a payment of 16 inputs with change. */
const VALUE = 1_000_000
const AMOUNT = 120_000_000

let world: World

function freshWorld(): World {
  newPlanGuard(guardHolder)
  lockState.isUnlocked = true
  const next = new World(lockState, () => newPlanGuard(guardHolder))
  wirePlanKeyring(next)
  return next
}

/** The stored plan, as the engine last wrote it. */
function stored() {
  const record = qbitSendPlanStore.list()[0]
  if (!record) throw new Error('no plan stored')
  return record
}

/** Every transaction signed, in order, with the checks made before its first input. */
function watchSignings(): { txid: string; checksBefore: number }[] {
  const signings: { txid: string; checksBefore: number }[] = []
  world.keyring.beforeInput = (txid, index) => {
    if (index === 0) signings.push({ txid, checksBefore: spendChecks.calls.length })
  }
  return signings
}

/**
 * Hold every lookup of a transaction funding the account from now on;
 * `arrived` once one has, and `release` lets them all go.
 */
function holdFundingLookups(funded: ReadonlySet<string>) {
  const fetch = world.explorer.fetch
  let open: () => void = () => undefined
  const gate = new Promise<void>(resolve => (open = resolve))
  let arrive: () => void = () => undefined
  const arrived = new Promise<void>(resolve => (arrive = resolve))
  world.explorer.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    const path = url.pathname.replace(/^\/api/, '')
    if (/^\/tx\/[0-9a-f]{64}$/.test(path) && funded.has(path.slice(4))) {
      arrive()
      await gate
    }
    return fetch(input, init)
  }
  return {
    arrived,
    release: () => {
      world.explorer.fetch = fetch
      open()
    },
  }
}

const fundingTxids = (outpoints: readonly string[]) =>
  new Set(outpoints.map(outpoint => outpoint.split(':')[0]!))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.clearAllMocks()
  spendChecks.calls.length = 0
  lockState.isUnlocked = true
  vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(account as never)
  vi.mocked(preferenceService.getChainType).mockReturnValue(CHAIN)
  world = freshWorld()
  spendChecks.requests = () => world.explorer.requests
  watchPlanAnnouncements(() => world)
})

afterEach(() => {
  if (world?.wallet) world.engine.reset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a send plan checks each transaction’s inputs before it signs it (#210)', () => {
  it('checks every input of each step before the keyring signs it, reading every one that is not the plan’s own', async () => {
    world.fund(150, VALUE)
    await world.open()
    const signings = watchSignings()

    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })

    const steps = stored().steps
    expect(steps.map(step => step.kind)).toEqual(['merge', 'payment'])
    expect(signings.map(signing => signing.txid)).toEqual(steps.map(step => step.txid))
    steps.forEach((step, index) => {
      // The check made just before the step's first signature is of its inputs.
      const check = spendChecks.calls[signings[index]!.checksBefore - 1]!
      expect(check.inputs).toEqual(
        step.inputs.map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis }))
      )
      expect(check.rideOut).toBe(true)
    })
    const [merge, payment] = steps as [(typeof steps)[0], (typeof steps)[0]]
    const mergeCheck = spendChecks.calls[signings[0]!.checksBefore - 1]!
    const paymentCheck = spendChecks.calls[signings[1]!.checksBefore - 1]!
    // The merge's 106 inputs, each funding transaction read.
    expect(new Set(mergeCheck.lookups)).toEqual(new Set(merge.inputs.map(input => input.txid)))
    // The payment's spend of the merge is checked against the merge the plan
    // stored, with no lookup; its other inputs are read.
    expect(paymentCheck.own?.has(merge.txid)).toBe(true)
    expect(paymentCheck.lookups).not.toContain(merge.txid)
    expect(new Set(paymentCheck.lookups)).toEqual(
      new Set(payment.inputs.filter(input => input.txid !== merge.txid).map(input => input.txid))
    )
  })

  it('pauses, naming the cause, and signs nothing, when an input of a merge fails its check', async () => {
    const funded = fundingTxids(world.fund(150, VALUE))
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    // The explorer's transactions now disagree with the outputs it listed.
    for (const txid of funded) world.explorer.txs.get(txid)!.outputs[0]!.value = VALUE - 1

    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()

    // Paused with the cause, which the plan's screen names in full; the
    // technical detail is the check's own account of it.
    expect(stored()).toMatchObject({
      phase: 'paused',
      pause: {
        reason: 'input_check_mismatch',
        detail: expect.stringContaining('failed its check (mismatch)'),
      },
    })
    expect((await world.plan())!.actions).toContain('continue')
    expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    expect(world.keyring.signed).toEqual([])
    // What a failed signing lets go of, as for any other: the batch.
    expect(world.keyring.batches.size).toBe(0)
  })

  it('rides out server errors on the lookups of the funding transactions', async () => {
    const funded = fundingTxids(world.fund(150, VALUE))
    await world.open()
    const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
    // Every funding transaction's first three lookups answer 502: the
    // client's own attempts, and then one the check rides out.
    const attempts = new Map<string, number>()
    world.explorer.failures.push(({ path }) => {
      const txid = path.slice(4)
      if (!/^\/tx\/[0-9a-f]{64}$/.test(path) || !funded.has(txid)) return undefined
      const attempt = (attempts.get(txid) ?? 0) + 1
      attempts.set(txid, attempt)
      return attempt <= 3 ? { status: 502, body: 'bad gateway' } : undefined
    })

    await world.wallet.startQbitSendPlan(review.draftId)
    await world.settle()

    expect(world.keyring.signed).toHaveLength(2)
    const spent = stored().steps[0]!.inputs[0]!.txid
    // The plan's one pass before its first signature rode out three 502s
    // (four attempts); the merge's own check read it once more.
    expect(attempts.get(spent)).toBe(5)
  })

  describe('what allowed a step’s signing holds still once its check returns', () => {
    it.each([
      [
        'the wallet locks',
        async () => {
          await world.wallet.lockWallet()
        },
      ],
      [
        'the wallet leaves the plan’s network',
        async () => {
          vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
        },
      ],
      [
        'the plan is cancelled',
        async () => {
          await world.wallet.cancelQbitSendPlan(stored().id)
        },
      ],
    ])(
      'reaches neither the preflight nor the keyring when %s while the check reads',
      async (_, during) => {
        const funded = fundingTxids(world.fund(150, VALUE))
        await world.open()
        const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
        const preflights = vi.mocked(keyringService.preflightP2mrPsbtSigning).mock.calls.length
        const held = holdFundingLookups(funded)

        const started = world.wallet.startQbitSendPlan(review.draftId)
        await held.arrived
        await during()
        held.release()
        await started
        await world.settle()

        expect(vi.mocked(keyringService.preflightP2mrPsbtSigning).mock.calls).toHaveLength(
          preflights
        )
        expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
      }
    )

    it('keeps the check and the signature its own account’s when another account is selected meanwhile', async () => {
      const funded = fundingTxids(world.fund(150, VALUE))
      await world.open()
      const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
      const held = holdFundingLookups(funded)

      const started = world.wallet.startQbitSendPlan(review.draftId)
      await held.arrived
      vi.mocked(preferenceService.getCurrentAccount).mockReturnValue(
        p2mrAccount('22'.repeat(32)) as never
      )
      held.release()
      await started
      await world.settle()

      // A plan signs for the account it was started for, whichever is shown.
      expect(
        vi.mocked(keyringService.signP2mrPsbtWithCounter).mock.calls.map(([address]) => address)
      ).toEqual([account.address, account.address])
    })
  })

  describe('one pass over every input the plan spends, before its first signature', () => {
    /** 300 outputs of a million bits, and an amount that needs two merges and a payment. */
    const TWO_MERGES = 250_000_000

    /** Every input of `steps` that spends no output of the plan's own merges. */
    const outsideInputs = (steps: ReturnType<typeof stored>['steps']) => {
      const own = new Set(steps.filter(step => step.kind === 'merge').map(step => step.txid))
      return steps
        .flatMap(step => step.inputs)
        .filter(input => !own.has(input.txid))
        .map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis }))
    }

    it('reads every input of every step in it, then each step’s own before its signature', async () => {
      world.fund(300, VALUE)
      await world.open()
      const signings = watchSignings()

      await world.startPlan({ target: { kind: 'amount', amount: TWO_MERGES } })

      const steps = stored().steps
      expect(steps.filter(step => step.kind === 'merge').length).toBeGreaterThanOrEqual(2)
      // The first check of all, made before any signature, is the pass.
      expect(signings[0]!.checksBefore).toBe(2)
      const pass = spendChecks.calls[0]!
      const sort = (inputs: { txid: string; vout: number }[]) =>
        inputs.map(input => `${input.txid}:${input.vout}`).sort()
      expect(sort(pass.inputs)).toEqual(sort(outsideInputs(steps)))
      expect(pass.rideOut).toBe(true)
      // Each funding transaction once in it, the plan's own merges never.
      expect(new Set(pass.lookups).size).toBe(pass.lookups.length)
      // Each step's own check still precedes its signature.
      steps.forEach((step, index) => {
        expect(spendChecks.calls[signings[index]!.checksBefore - 1]!.inputs).toEqual(
          step.inputs.map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis }))
        )
      })
    })

    it('pauses with the cause and signs nothing when an input of a later step fails it', async () => {
      const funded = fundingTxids(world.fund(300, VALUE))
      await world.open()
      const review = await world.review({ target: { kind: 'amount', amount: TWO_MERGES } })
      const held = holdFundingLookups(funded)

      const started = world.wallet.startQbitSendPlan(review.draftId)
      await held.arrived
      // The plan is stored and its pass is reading: an input of its last
      // step now disagrees with the explorer.
      const steps = stored().steps
      const last = outsideInputs([steps.at(-1)!]).at(-1)!
      expect(steps[0]!.inputs.some(input => input.txid === last.txid)).toBe(false)
      world.explorer.txs.get(last.txid)!.outputs[last.vout]!.value = last.satoshis - 1
      held.release()
      await started
      await world.settle()

      expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'input_check_mismatch' } })
      expect(world.keyring.signed).toEqual([])
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
      expect(world.pushed).toEqual([])
    })

    it('ends the pass at once when the plan is cancelled while its lookups never answer', async () => {
      const funded = fundingTxids(world.fund(150, VALUE))
      await world.open()
      const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
      const held = holdFundingLookups(funded)
      const started = world.wallet.startQbitSendPlan(review.draftId)
      await held.arrived
      const checksBefore = spendChecks.calls.length

      await world.wallet.cancelQbitSendPlan(stored().id)
      let ended = false
      for (let wait = 0; wait < 100 && !ended; wait += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
        ended = spendChecks.calls.length > checksBefore
      }
      held.release()
      await started.catch(() => undefined)
      await world.settle()

      expect(ended).toBe(true)
      expect(keyringService.signP2mrPsbtWithCounter).not.toHaveBeenCalled()
    })

    it('reads nothing for a step whose signing cannot go on: the wallet left the plan’s network as it began', async () => {
      world.fund(300, VALUE)
      await world.open()
      const review = await world.review({ target: { kind: 'amount', amount: TWO_MERGES } })
      // Once the first merge has been signed, the wallet moves to another
      // network just as the next step is let sign (`maySign` answered yes):
      // after the run's own check of the network, before the step's reads.
      const engine = world.engine as any
      const maySign = engine.maySign.bind(engine)
      let switchedAt: number | undefined
      engine.maySign = async (...args: unknown[]) => {
        const may = await maySign(...args)
        if (may && switchedAt === undefined && world.keyring.signed.length === 1) {
          vi.mocked(preferenceService.getChainType).mockReturnValue(ChainType.QBIT_TESTNET4)
          switchedAt = world.explorer.requests.length
        }
        return may
      }

      await world.wallet.startQbitSendPlan(review.draftId)
      await world.settle()

      expect(switchedAt).toBeDefined()
      const second = stored().steps[1]!
      const read = world.explorer.requests
        .slice(switchedAt)
        .filter(({ path }) => second.inputs.some(input => path === `/tx/${input.txid}`))
      expect(read).toEqual([])
      expect(world.keyring.signed).toHaveLength(1)
    })
  })

  describe('a plan whose input is gone, its replan, and what its pass leaves out', () => {
    it('offers a replan when an input’s transaction is gone, and checks what the replan newly selects, and only that, before it signs any of it', async () => {
      const funded = fundingTxids(world.fund(150, VALUE))
      await world.open()
      const review = await world.review({ target: { kind: 'amount', amount: AMOUNT } })
      // The plan's pass reads every input; then, as the merge is signed, the
      // transaction behind one of the payment's own inputs goes away
      // (replaced or dropped while unconfirmed), and comes back no more.
      const firstSteps = () => stored().steps
      world.keyring.beforeInput = (txid, index) => {
        const [merge, payment] = firstSteps()
        if (txid === merge!.txid && index === 0) {
          const direct = payment!.inputs.find(input => input.txid !== merge!.txid)!
          world.explorer.removeTx(direct.txid)
        }
      }
      await world.wallet.startQbitSendPlan(review.draftId)
      await world.settle()
      world.keyring.beforeInput = undefined

      const paused = (await world.plan())!
      expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'input_check_not_found' } })
      expect(paused.actions).toEqual(expect.arrayContaining(['continue', 'replan', 'cancel']))
      expect(world.keyring.signed).toHaveLength(1)
      const checkedBefore = new Set(
        firstSteps().flatMap(step => step.inputs.map(input => `${input.txid}:${input.vout}`))
      )

      // Larger outputs arrive; the replan reads the outputs as they are now
      // and takes some. One of them disagrees with the explorer.
      const fresh = fundingTxids(world.fund(60, 2 * VALUE))
      const replan = await world.review({
        target: { kind: 'amount', amount: AMOUNT },
        revise: { planId: paused.id, kind: 'replan' },
      })
      const checksBefore = spendChecks.calls.length
      const held = holdFundingLookups(new Set([...funded, ...fresh]))
      const restarted = world.wallet.startQbitSendPlan(replan.draftId)
      await held.arrived
      const selected = stored()
        .steps.filter(step => step.status === 'planned')
        .flatMap(step => step.inputs)
        .filter(input => fresh.has(input.txid))
      expect(selected.length).toBeGreaterThan(0)
      const bad = selected.at(-1)!
      world.explorer.txs.get(bad.txid)!.outputs[bad.vout]!.value = bad.satoshis - 1
      held.release()
      await restarted
      await world.settle()

      // The replan's one pass read what it newly selected, and nothing the
      // plan had checked before; a mismatch among them signed nothing more.
      const pass = spendChecks.calls[checksBefore]!
      const covered = new Set(pass.inputs.map(input => `${input.txid}:${input.vout}`))
      for (const input of selected) expect(covered.has(`${input.txid}:${input.vout}`)).toBe(true)
      for (const key of covered) expect(checkedBefore.has(key)).toBe(false)
      expect(stored()).toMatchObject({ phase: 'paused', pause: { reason: 'input_check_mismatch' } })
      expect(world.keyring.signed).toHaveLength(1)
    })

    it('reads again, in a replan’s pass, an input that passed the plan’s pass and then failed its own step’s check, before signing anything of the replan', async () => {
      // 150 outputs of one value each, the lowest the payment's last: one
      // merge of the highest 106, and a payment of the other 44 and the
      // merge's output.
      world.fund(150, index => VALUE + index * 1_000)
      await world.open()
      const review = await world.review({ target: { kind: 'everything' } })
      let gone: { txid: string; vout: number } | undefined
      // The plan's pass reads every input; then, as the merge is signed, the
      // explorer stops serving the transaction of the payment's smallest own
      // input, though its listing still lists the output.
      world.keyring.beforeInput = (txid, index) => {
        const [merge, payment] = stored().steps
        if (txid !== merge!.txid || index !== 0 || gone) return
        gone = payment!.inputs
          .filter(input => input.txid !== merge!.txid)
          .reduce((smallest, input) => (input.satoshis < smallest.satoshis ? input : smallest))
        const path = `/tx/${gone.txid}`
        world.explorer.failures.push(request =>
          request.path === path ? { status: 404, body: 'Transaction not found' } : undefined
        )
      }
      await world.wallet.startQbitSendPlan(review.draftId)
      await world.settle()
      world.keyring.beforeInput = undefined

      const paused = (await world.plan())!
      expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'input_check_not_found' } })
      expect(world.keyring.signed).toHaveLength(1)
      const sent = [...world.pushed]
      const spends = (step: { inputs: { txid: string; vout: number }[] }) =>
        step.inputs.some(input => input.txid === gone!.txid && input.vout === gone!.vout)

      // More outputs arrive, worth more than the old ones: the replan merges
      // them first, and pays with what is left, the listed output whose
      // transaction is gone among it.
      world.fund(100, 2 * VALUE)
      const replan = await world.review({
        target: { kind: 'everything' },
        revise: { planId: paused.id, kind: 'replan' },
      })
      const checksBefore = spendChecks.calls.length
      await world.wallet.startQbitSendPlan(replan.draftId)
      await world.settle()

      // Nothing of the replan was signed or sent: its pass read that input
      // again, and stopped there.
      expect(world.keyring.signed).toHaveLength(1)
      expect(world.pushed).toEqual(sent)
      expect(stored()).toMatchObject({
        phase: 'paused',
        pause: { reason: 'input_check_not_found' },
      })
      expect(spends(spendChecks.calls[checksBefore]!)).toBe(true)
      // The replan spends it again, in its payment, after a merge of its own.
      const replanned = stored().steps.filter(step => !sent.includes(step.txid))
      expect(replanned.map(step => step.kind)).toEqual(['merge', 'payment'])
      expect(replanned.findIndex(spends)).toBe(1)
    })

    it('reads again, in the next pass, every output of a funding transaction a step found gone, not only the one its failure named', async () => {
      // 150 outputs, and a transaction paying the account twice, its two the
      // smallest: one merge of the highest 106, and a payment of the other
      // 46, both outputs of that transaction among them, and the merge's.
      world.fund(150, index => VALUE + 10_000 + index * 1_000)
      const shared = fakeTxid(1, 77)
      world.explorer.addTx({
        txid: shared,
        inputs: [{ txid: fakeTxid(2, 77), vout: 0 }],
        outputs: [0, 1].map(vout => ({
          address: account.address,
          script: account.p2mr.scriptPubKey,
          value: VALUE + vout * 1_000,
        })),
        height: 300,
      })
      await world.open()
      const review = await world.review({ target: { kind: 'everything' } })
      // The plan's pass reads every input; then, as the merge is signed, the
      // explorer stops serving that transaction, though its listing still
      // lists both outputs.
      world.keyring.beforeInput = (txid, index) => {
        if (txid !== stored().steps[0]!.txid || index !== 0) return
        world.keyring.beforeInput = undefined
        world.explorer.failures.push(request =>
          request.path === `/tx/${shared}`
            ? { status: 404, body: 'Transaction not found' }
            : undefined
        )
      }
      await world.wallet.startQbitSendPlan(review.draftId)
      await world.settle()

      const paused = (await world.plan())!
      expect(paused).toMatchObject({ phase: 'paused', pause: { reason: 'input_check_not_found' } })
      expect(world.keyring.signed).toHaveLength(1)
      const outputsOf = (inputs: readonly { txid: string; vout: number }[]) =>
        inputs
          .filter(input => input.txid === shared)
          .map(input => input.vout)
          .sort()
      expect(outputsOf(stored().steps.at(-1)!.inputs)).toEqual([0, 1])

      // Continue: its one pass, the first check after it, reads both outputs
      // of the transaction again, the one the failure did not name as well,
      // and nothing else of the payment, all checked and kept; and stops
      // there again.
      const checksBefore = spendChecks.calls.length
      await world.wallet.continueQbitSendPlan(paused.id, world.shownTerms(paused.id))
      await world.settle()

      const pass = spendChecks.calls[checksBefore]!
      expect(pass.inputs.map(input => `${input.txid}:${input.vout}`).sort()).toEqual([
        `${shared}:0`,
        `${shared}:1`,
      ])
      expect(stored()).toMatchObject({
        phase: 'paused',
        pause: { reason: 'input_check_not_found' },
      })
      expect(world.keyring.signed).toHaveLength(1)
    })

    it('leaves out of its one pass a void merge, which is never signed', async () => {
      world.fund(300, VALUE)
      await world.open()
      await world.startPlan({ target: { kind: 'amount', amount: 250_000_000 } })
      const record = stored()
      // The same plan with every step still to sign, its first merge a
      // replacement whose replaced version confirmed instead.
      const voided = {
        ...record,
        steps: record.steps.map((step, index) => ({
          ...step,
          status: 'planned' as const,
          ...(index === 0
            ? { replaces: { txid: 'ab'.repeat(32), fee: 1_000, confirmed: true } }
            : {}),
        })),
      }
      const engine = world.engine as any
      const session = engine.session(record.id)
      session.checkedInputs.clear()
      const asked: { txid: string; vout: number }[][] = []
      engine.host.checkSpendInputs = async (_chain: unknown, _address: unknown, inputs: any[]) => {
        asked.push(inputs)
      }

      await engine.checkPlanInputs(
        voided,
        session,
        new AbortController(),
        qbitSendPlanAccountKeys(record.account.pubkey),
        new Map()
      )

      const read = new Set(asked.flat().map(input => `${input.txid}:${input.vout}`))
      expect(record.steps[0]!.inputs.some(input => read.has(`${input.txid}:${input.vout}`))).toBe(
        false
      )
      expect(record.steps[1]!.inputs.every(input => read.has(`${input.txid}:${input.vout}`))).toBe(
        true
      )
    })
  })

  it('checks the inputs of the version a fee raise builds before it signs it', async () => {
    world.fund(150, VALUE)
    await world.open()
    world.explorer.acceptReplacements = true
    await world.startPlan({ target: { kind: 'amount', amount: AMOUNT } })
    await world.tick(QBIT_SEND_PLAN_SLOW_MERGE_MS + 60_000)
    const view = (await world.plan())!
    const raised = await world.prepare({
      target: { kind: 'amount', amount: AMOUNT },
      feeRate: 2,
      revise: { planId: view.id, kind: 'raise_merge_fee' },
    })
    if (!raised.ok) throw new Error(`raise refused: ${raised.reason}`)
    const signings = watchSignings()
    const planInputs = stored().steps.flatMap(step => step.inputs)
    const checksAtRaise = spendChecks.calls.length

    await world.wallet.startQbitSendPlan(raised.review.draftId)
    await world.settle()

    const replacement = stored().steps[0]!
    expect(replacement.replaces).toBeDefined()
    const signing = signings.find(each => each.txid === replacement.txid)!
    expect(spendChecks.calls[signing.checksBefore - 1]!.inputs).toEqual(
      replacement.inputs.map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis }))
    )
    // A raise takes no input the plan did not have: it rebuilds the same
    // merges and payment over the same inputs, which the plan's first pass
    // checked, so its own signing makes no pass, only each step's check.
    const before = new Set(planInputs.map(input => `${input.txid}:${input.vout}`))
    const merges = new Set(
      stored()
        .steps.filter(step => step.kind === 'merge')
        .map(step => step.txid)
    )
    for (const input of stored().steps.flatMap(step => step.inputs)) {
      if (!merges.has(input.txid)) expect(before.has(`${input.txid}:${input.vout}`)).toBe(true)
    }
    for (const call of spendChecks.calls.slice(checksAtRaise)) {
      expect(
        stored().steps.some(
          step =>
            JSON.stringify(
              step.inputs.map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis }))
            ) === JSON.stringify(call.inputs)
        )
      ).toBe(true)
    }
  })
})
