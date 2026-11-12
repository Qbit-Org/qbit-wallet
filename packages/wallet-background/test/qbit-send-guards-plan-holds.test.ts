import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QbitSendBroadcastClaim } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  QBIT_WALLET_SEND_CLAIM_ORIGIN,
  QbitSendGuardService,
  QbitSendPlanHeldError,
  QbitSendPlanHold,
  QbitSendPlanHoldConflictError,
  type QbitOutpoint,
  type QbitSendPlanOutpoints,
} from '../src/services/qbitSendGuards'

const chain = ChainType.QBIT_REGTEST
const address = 'qbrt1zfunding'
const otherAddress = 'qbrt1zother'
const PLAN = 'a1'.repeat(16)
const OTHER_PLAN = 'b2'.repeat(16)

/** Output `vout` of the transaction whose txid is `byte` repeated. */
function outpoint(byte: string, vout = 0): QbitOutpoint {
  return { txid: byte.repeat(32), vout }
}

const key = (item: QbitOutpoint): string => `${item.txid}:${item.vout}`

// A plan with one merge: it spends three of the account's outputs, and its
// payment spends the merge's output 0 and one more output.
const MERGE_TXID = 'cc'.repeat(32)
const PAYMENT_TXID = 'dd'.repeat(32)
const MERGE_INPUTS = [outpoint('01'), outpoint('02', 1), outpoint('03')]
const MERGE_OUTPUT = { txid: MERGE_TXID, vout: 0 }
const PAYMENT_INPUTS = [MERGE_OUTPUT, outpoint('04')]
const PLAN_OUTPOINTS = [...MERGE_INPUTS, MERGE_OUTPUT, outpoint('04')]

function planOutpoints(
  overrides: Partial<QbitSendPlanOutpoints> = {},
  outpoints: readonly QbitOutpoint[] = PLAN_OUTPOINTS
): QbitSendPlanOutpoints {
  return { planId: PLAN, chain, address, outpoints, ...overrides }
}

function broadcastClaim(overrides: Partial<QbitSendBroadcastClaim> = {}): QbitSendBroadcastClaim {
  return {
    chain,
    address,
    origin: 'https://otc.example',
    txid: '11'.repeat(32),
    outpoints: [outpoint('01')],
    ...overrides,
  }
}

/** A wallet-owned claim as the wallet mints it for a send that replaces nothing. */
function walletClaim(overrides: Partial<QbitSendBroadcastClaim> = {}): QbitSendBroadcastClaim {
  return broadcastClaim({ origin: QBIT_WALLET_SEND_CLAIM_ORIGIN, replaces: null, ...overrides })
}

/** Rejects with a `QbitSendPlanHeldError` for `reason`. */
async function expectHeld(
  promise: Promise<unknown>,
  reason: QbitSendPlanHeldError['reason'] = 'held'
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(QbitSendPlanHeldError)
  expect((error as QbitSendPlanHeldError).reason).toBe(reason)
}

/** Rejects with a `QbitSendPlanHoldConflictError`; resolves to it. */
async function holdConflict(promise: Promise<unknown>): Promise<QbitSendPlanHoldConflictError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(QbitSendPlanHoldConflictError)
  return error as QbitSendPlanHoldConflictError
}

describe('QbitSendGuardService plan holds (#188)', () => {
  let service: QbitSendGuardService

  const reserved = (forAddress = address): Promise<Set<string>> =>
    service.getReservedOutpointKeys(chain, forAddress)

  beforeEach(() => {
    service = new QbitSendGuardService()
    service.init()
  })

  describe('taking a hold', () => {
    it("holds the plan's inputs and its merge's future output, and lists them as reserved", async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())

      expect(hold).toBeInstanceOf(QbitSendPlanHold)
      expect(hold.planId).toBe(PLAN)
      expect(Object.isFrozen(hold)).toBe(true)
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
      // Reserved for the plan's account only, and only on its network.
      await expect(reserved(otherAddress)).resolves.toEqual(new Set())
      await expect(
        service.getReservedOutpointKeys(ChainType.QBIT_TESTNET4, address)
      ).resolves.toEqual(new Set())
      await expect(
        service.assertNoOverlap(ChainType.QBIT_TESTNET4, MERGE_INPUTS)
      ).resolves.toBeUndefined()
    })

    it('changes nothing when the same hold is taken again, and refuses another for the plan', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())

      // The same outpoints in another order are the same hold.
      await expect(
        service.holdOutpointsForPlan(planOutpoints({}, [...PLAN_OUTPOINTS].reverse()))
      ).resolves.toBe(hold)
      await expect(service.holdOutpointsForPlan(planOutpoints({}, MERGE_INPUTS))).rejects.toThrow(
        'already holds other outputs'
      )
      await expect(
        service.holdOutpointsForPlan(planOutpoints({ address: otherAddress }))
      ).rejects.toThrow('already holds other outputs')
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
    })

    /**
     * Each kind of hold a plan's hold is refused on, over `contested`: its
     * kind, how it is taken, and the plan holding it for a plan's.
     */
    const heldElsewhere = (
      contested: QbitOutpoint,
      holderAddress = address
    ): [string, () => Promise<unknown>, string][] => [
      [
        'broadcast_claim',
        () =>
          service.runWithBroadcastClaim(
            walletClaim({ address: holderAddress, outpoints: [contested] }),
            async () => 'signed'
          ),
        '',
      ],
      [
        'external_signing_lock',
        () =>
          service.acquireExternalSigningLock({
            purpose: 'sign',
            chain,
            address: holderAddress,
            origin: 'https://otc.example',
            entries: [{ txid: '11'.repeat(32), outpoints: [contested] }],
          }),
        '',
      ],
      [
        'recent_spend',
        () => service.broadcastIfAllowed(chain, '11'.repeat(32), [contested], async () => 'sent'),
        '',
      ],
      [
        'provider_send_request',
        () =>
          service.openProviderSendRequest(
            broadcastClaim({ address: holderAddress, outpoints: [contested] })
          ),
        '',
      ],
      [
        'provider_signing',
        () => service.recordProviderSigning(chain, '11'.repeat(32), [contested]),
        '',
      ],
      [
        'plan_hold',
        () =>
          service.holdOutpointsForPlan(
            planOutpoints({ planId: OTHER_PLAN, address: holderAddress }, [contested])
          ),
        OTHER_PLAN,
      ],
    ]

    it('holds nothing at all when any one outpoint is held by something else', async () => {
      const contested = outpoint('03')
      for (const [kind, holdElsewhere, holder] of heldElsewhere(contested)) {
        service.init()
        await holdElsewhere()
        const before = await reserved()

        const error = await holdConflict(service.holdOutpointsForPlan(planOutpoints()))

        expect(error.planId).toBe(PLAN)
        expect(error.conflicts).toEqual([
          holder
            ? { outpoint: key(contested), kind, planId: holder }
            : kind === 'recent_spend'
              ? // A recent spend names the transaction recorded as spending it.
                { outpoint: key(contested), kind, spender: '11'.repeat(32) }
              : { outpoint: key(contested), kind },
        ])
        // Nothing of the plan is held: every other outpoint is as free as before.
        await expect(reserved()).resolves.toEqual(before)
        for (const free of PLAN_OUTPOINTS.filter(item => key(item) !== key(contested))) {
          await expect(service.assertNoOverlap(chain, [free])).resolves.toBeUndefined()
        }
        await expect(service.releasePlanOutpoints(PLAN)).resolves.toBe(false)
      }
    })

    it('lists for a plan every outpoint its hold would be refused on, a dapp’s signing and request included', async () => {
      const contested = outpoint('03')
      for (const holderAddress of [address, otherAddress]) {
        for (const [kind, holdElsewhere] of heldElsewhere(contested, holderAddress)) {
          const label = `${kind} under ${holderAddress}`
          service.init()
          await holdElsewhere()
          const unavailable = await service.getPlanUnavailableOutpointKeys(chain, address)
          expect(unavailable.has(key(contested)), label).toBe(true)
          // Never less than what an ordinary send of the account leaves alone.
          for (const reservedKey of await reserved()) {
            expect(unavailable.has(reservedKey), label).toBe(true)
          }
          // A plan prepared from the rest takes its hold.
          await expect(
            service.holdOutpointsForPlan(
              planOutpoints(
                {},
                PLAN_OUTPOINTS.filter(item => !unavailable.has(key(item)))
              )
            ),
            label
          ).resolves.toBeInstanceOf(QbitSendPlanHold)
          // Only this network's.
          await expect(
            service.getPlanUnavailableOutpointKeys(ChainType.QBIT_TESTNET4, address),
            label
          ).resolves.toEqual(new Set())
        }
      }
      // A dapp's signing and an open provider request reserve nothing for an
      // ordinary send: only a plan's hold is refused on them.
      service.init()
      await service.recordProviderSigning(chain, '11'.repeat(32), [outpoint('01')])
      await service.openProviderSendRequest(broadcastClaim({ outpoints: [outpoint('02', 1)] }))
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(service.getPlanUnavailableOutpointKeys(chain, address)).resolves.toEqual(
        new Set([key(outpoint('01')), key(outpoint('02', 1))])
      )
    })

    it('leaves out of what a plan may not spend only what the named plan holds', async () => {
      await service.holdOutpointsForPlan(planOutpoints({}, [outpoint('01')]))
      await service.holdOutpointsForPlan(planOutpoints({ planId: OTHER_PLAN }, [outpoint('02', 1)]))
      await service.recordProviderSigning(chain, '11'.repeat(32), [outpoint('03')])
      await expect(service.getPlanUnavailableOutpointKeys(chain, address, PLAN)).resolves.toEqual(
        new Set([key(outpoint('02', 1)), key(outpoint('03'))])
      )
      await expect(service.getPlanUnavailableOutpointKeys(chain, address)).resolves.toEqual(
        new Set([key(outpoint('01')), key(outpoint('02', 1)), key(outpoint('03'))])
      )
    })

    it('counts only the inputs a dapp signing was recorded with, and keeps them when it is recorded again', async () => {
      // Recorded by its txid alone, a signing tells nothing about its inputs.
      await service.recordProviderSigning(chain, '11'.repeat(32))
      await expect(
        service.holdOutpointsForPlan(planOutpoints({}, [outpoint('01')]))
      ).resolves.toBeInstanceOf(QbitSendPlanHold)
      await service.releasePlanOutpoints(PLAN)

      await service.recordProviderSigning(chain, '22'.repeat(32), [outpoint('02', 1)])
      await service.recordProviderSigning(chain, '22'.repeat(32))
      const error = await holdConflict(service.holdOutpointsForPlan(planOutpoints()))
      expect(error.conflicts).toEqual([
        { outpoint: key(outpoint('02', 1)), kind: 'provider_signing' },
      ])
      await expect(
        service.recordProviderSigning(chain, '33'.repeat(32), [{ txid: 'zz', vout: 0 }])
      ).rejects.toThrow('invalid Qbit transaction inputs')
    })

    it('refuses a malformed hold', async () => {
      for (const malformed of [
        planOutpoints({ planId: PLAN.toUpperCase() }),
        planOutpoints({ planId: PLAN.slice(1) }),
        planOutpoints({ planId: `${PLAN}0` }),
        planOutpoints({ chain: 'NOT_A_CHAIN' as ChainType }),
        planOutpoints({ address: '' }),
        planOutpoints({}, []),
        planOutpoints({}, [outpoint('01'), outpoint('01')]),
        planOutpoints({}, [{ txid: 'CC'.repeat(32), vout: 0 }]),
        planOutpoints({}, [{ txid: MERGE_TXID, vout: -1 }]),
        planOutpoints({}, [{ txid: MERGE_TXID, vout: 0.5 }]),
        planOutpoints({}, [{ txid: MERGE_TXID, vout: Number.NaN }]),
        // What a NaN becomes once it crossed a JSON port.
        planOutpoints({}, [{ txid: MERGE_TXID, vout: null as unknown as number }]),
        { ...planOutpoints(), outpoints: undefined as unknown as QbitOutpoint[] },
        null as unknown as QbitSendPlanOutpoints,
      ]) {
        await expect(service.holdOutpointsForPlan(malformed)).rejects.toThrow(
          'invalid Qbit send plan hold'
        )
        await expect(service.replacePlanOutpoints(malformed)).rejects.toThrow(
          'invalid Qbit send plan hold'
        )
      }
      await expect(reserved()).resolves.toEqual(new Set())
    })

    it('waits its turn on the queue: a broadcast running when the hold is asked for decides first', async () => {
      let finish: (() => void) | undefined
      const broadcasting = service.broadcastIfAllowed(
        chain,
        '11'.repeat(32),
        [outpoint('01')],
        () =>
          new Promise<string>(resolve => {
            finish = () => resolve('sent')
          })
      )
      const holding = service.holdOutpointsForPlan(planOutpoints())
      let holdSettled = false
      holding.then(
        () => (holdSettled = true),
        () => (holdSettled = true)
      )
      while (!finish) await Promise.resolve()
      for (let tick = 0; tick < 10; tick++) await Promise.resolve()
      expect(holdSettled).toBe(false)
      finish()
      await expect(broadcasting).resolves.toBe('sent')

      const error = await holdConflict(holding)
      expect(error.conflicts).toEqual([
        { outpoint: key(outpoint('01')), kind: 'recent_spend', spender: '11'.repeat(32) },
      ])
    })
  })

  describe('replacing a hold', () => {
    it('swaps what the plan holds in one step, under the same hold', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())
      // A revised plan: the merge spends 01 and 05 and pays a new txid.
      const revised = [outpoint('01'), outpoint('05'), outpoint('ee'), outpoint('04')]

      await expect(service.replacePlanOutpoints(planOutpoints({}, revised))).resolves.toBe(hold)

      await expect(reserved()).resolves.toEqual(new Set(revised.map(key)))
      await expect(
        service.assertNoOverlap(chain, [outpoint('02', 1), outpoint('03'), MERGE_OUTPUT])
      ).resolves.toBeUndefined()
      await expectHeld(service.assertNoOverlap(chain, [outpoint('05')]))
      await expect(
        service.assertNoOverlap(chain, revised, undefined, hold)
      ).resolves.toBeUndefined()
      // Replacing with what it holds changes nothing.
      await expect(service.replacePlanOutpoints(planOutpoints({}, revised))).resolves.toBe(hold)
    })

    it('keeps the old set when anything new is held by something else', async () => {
      await service.holdOutpointsForPlan(planOutpoints())
      await service.runWithBroadcastClaim(
        walletClaim({ outpoints: [outpoint('06')] }),
        async () => 'signed'
      )
      await service.holdOutpointsForPlan(planOutpoints({ planId: OTHER_PLAN }, [outpoint('07')]))

      const error = await holdConflict(
        service.replacePlanOutpoints(
          planOutpoints({}, [...MERGE_INPUTS, outpoint('05'), outpoint('06'), outpoint('07')])
        )
      )

      expect(error.conflicts).toEqual([
        { outpoint: key(outpoint('06')), kind: 'broadcast_claim' },
        { outpoint: key(outpoint('07')), kind: 'plan_hold', planId: OTHER_PLAN },
      ])
      await expect(reserved()).resolves.toEqual(
        new Set([...PLAN_OUTPOINTS, outpoint('06'), outpoint('07')].map(key))
      )
      // Neither the old set's outpoints nor the free new one changed hands.
      await expectHeld(service.assertNoOverlap(chain, [MERGE_OUTPUT]))
      await expect(service.assertNoOverlap(chain, [outpoint('05')])).resolves.toBeUndefined()
    })

    it("keeps outpoints the plan holds even while the plan's own claim spends them", async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())
      const mergeClaim = walletClaim({ txid: MERGE_TXID, outpoints: MERGE_INPUTS })
      await service.runWithBroadcastClaim(mergeClaim, async () => 'signed', undefined, hold)

      await expect(
        service.replacePlanOutpoints(planOutpoints({}, [...MERGE_INPUTS, MERGE_OUTPUT]))
      ).resolves.toBe(hold)
    })

    it('refuses to replace what no plan holds, or a hold of another account', async () => {
      await expectHeld(service.replacePlanOutpoints(planOutpoints()), 'inactive')
      await service.holdOutpointsForPlan(planOutpoints())
      await expect(
        service.replacePlanOutpoints(planOutpoints({ address: otherAddress }))
      ).rejects.toThrow('outputs of another account')
      await expect(
        service.replacePlanOutpoints(planOutpoints({ chain: ChainType.QBIT_TESTNET4 }))
      ).rejects.toThrow('outputs of another account')
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
    })
  })

  describe('releasing a hold', () => {
    it('lets go of everything, or of a named subset, and ignores what it does not hold', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())

      // A cancel that keeps the inputs of a merge whose outcome is unknown.
      await expect(
        service.releasePlanOutpoints(PLAN, [MERGE_OUTPUT, outpoint('04'), outpoint('99')])
      ).resolves.toBe(true)
      await expect(reserved()).resolves.toEqual(new Set(MERGE_INPUTS.map(key)))
      await expect(
        service.assertNoOverlap(chain, [MERGE_OUTPUT, outpoint('04')])
      ).resolves.toBeUndefined()
      await expect(service.releasePlanOutpoints(PLAN, [outpoint('99')])).resolves.toBe(false)
      await expect(service.releasePlanOutpoints(PLAN, [])).resolves.toBe(false)
      await expect(
        service.assertNoOverlap(chain, MERGE_INPUTS, undefined, hold)
      ).resolves.toBeUndefined()

      await expect(service.releasePlanOutpoints(PLAN)).resolves.toBe(true)
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(service.assertNoOverlap(chain, MERGE_INPUTS)).resolves.toBeUndefined()
      // The hold of a plan that holds nothing lifts nothing, and a plan
      // holding nothing has nothing to let go of.
      await expectHeld(service.assertNoOverlap(chain, MERGE_INPUTS, undefined, hold), 'inactive')
      await expect(service.releasePlanOutpoints(PLAN)).resolves.toBe(false)
      await expect(service.releasePlanOutpoints(OTHER_PLAN)).resolves.toBe(false)
    })

    it('ends the hold once a subset release leaves the plan holding nothing', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints({}, [outpoint('01')]))
      await expect(service.releasePlanOutpoints(PLAN, [outpoint('01')])).resolves.toBe(true)

      await expectHeld(
        service.assertNoOverlap(chain, [outpoint('01')], undefined, hold),
        'inactive'
      )
      // A hold taken again is a new one; the old one stays dead.
      const again = await service.holdOutpointsForPlan(planOutpoints({}, [outpoint('01')]))
      expect(again).not.toBe(hold)
      await expectHeld(
        service.assertNoOverlap(chain, [outpoint('01')], undefined, hold),
        'inactive'
      )
      await expect(
        service.assertNoOverlap(chain, [outpoint('01')], undefined, again)
      ).resolves.toBeUndefined()
    })

    it('refuses a malformed subset and keeps the hold', async () => {
      await service.holdOutpointsForPlan(planOutpoints())
      for (const malformed of [
        [{ txid: 'cc', vout: 0 }],
        [{ txid: MERGE_TXID, vout: -1 }],
        'not a list' as unknown as QbitOutpoint[],
      ]) {
        await expect(service.releasePlanOutpoints(PLAN, malformed)).rejects.toThrow(
          'invalid Qbit send plan hold'
        )
      }
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
    })
  })

  describe('restoring holds', () => {
    it('restores several plans, each under its own hold', async () => {
      const restoration = await service.restorePlanHolds([
        planOutpoints(),
        planOutpoints({ planId: OTHER_PLAN, address: otherAddress }, [outpoint('08')]),
      ])

      expect(restoration.conflicts).toEqual([])
      expect(restoration.invalid).toEqual([])
      expect([...restoration.holds.keys()]).toEqual([PLAN, OTHER_PLAN])
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
      await expect(reserved(otherAddress)).resolves.toEqual(new Set([key(outpoint('08'))]))
      await expect(
        service.assertNoOverlap(chain, MERGE_INPUTS, undefined, restoration.holds.get(PLAN))
      ).resolves.toBeUndefined()
      // Another plan's hold lifts nothing of this one.
      await expectHeld(
        service.assertNoOverlap(chain, MERGE_INPUTS, undefined, restoration.holds.get(OTHER_PLAN))
      )
      await expectHeld(
        service.assertNoOverlap(
          chain,
          [outpoint('05')],
          undefined,
          restoration.holds.get(OTHER_PLAN)
        ),
        'not_held'
      )
    })

    it('holds both plans in full when they overlap, and reports the overlap under each', async () => {
      const shared = outpoint('03')
      const restoration = await service.restorePlanHolds([
        planOutpoints(),
        planOutpoints({ planId: OTHER_PLAN }, [shared, outpoint('09')]),
      ])

      expect(restoration.conflicts).toEqual([
        {
          planId: OTHER_PLAN,
          conflicts: [{ outpoint: key(shared), kind: 'plan_hold', planId: PLAN }],
        },
        {
          planId: PLAN,
          conflicts: [{ outpoint: key(shared), kind: 'plan_hold', planId: OTHER_PLAN }],
        },
      ])
      await expect(reserved()).resolves.toEqual(
        new Set([...PLAN_OUTPOINTS, outpoint('09')].map(key))
      )
      const hold = restoration.holds.get(PLAN)
      const otherHold = restoration.holds.get(OTHER_PLAN)
      // Neither plan can spend the shared outpoint until one lets go of it;
      // each can spend the rest of its own.
      await expectHeld(service.assertNoOverlap(chain, [shared], undefined, hold))
      await expectHeld(service.assertNoOverlap(chain, [shared], undefined, otherHold))
      await expectHeld(service.assertNoOverlap(chain, [shared]))
      await expect(
        service.assertNoOverlap(chain, [outpoint('01')], undefined, hold)
      ).resolves.toBeUndefined()
      await service.releasePlanOutpoints(OTHER_PLAN)
      await expect(
        service.assertNoOverlap(chain, [shared], undefined, hold)
      ).resolves.toBeUndefined()
    })

    it('reports a plan restored over something held meanwhile, and holds it all the same', async () => {
      const claim = walletClaim({ outpoints: [outpoint('02', 1)] })
      await service.runWithBroadcastClaim(claim, async () => 'signed')

      const restoration = await service.restorePlanHolds([planOutpoints()])

      expect(restoration.conflicts).toEqual([
        {
          planId: PLAN,
          conflicts: [{ outpoint: key(outpoint('02', 1)), kind: 'broadcast_claim' }],
        },
      ])
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
      // The claim's bytes cannot go out over the plan's hold, nor can the
      // plan spend what the claim holds.
      const broadcast = vi.fn(async () => claim.txid)
      await expectHeld(
        service.broadcastIfAllowed(chain, claim.txid, claim.outpoints, broadcast, claim)
      )
      expect(broadcast).not.toHaveBeenCalled()
      await expect(
        service.assertNoOverlap(chain, MERGE_INPUTS, undefined, restoration.holds.get(PLAN))
      ).rejects.toThrow('claimed by an approved send')
    })

    it('reports malformed records and restores the rest', async () => {
      const restoration = await service.restorePlanHolds([
        planOutpoints({ planId: 'not-a-plan-id' }),
        planOutpoints(),
        planOutpoints({ planId: OTHER_PLAN }, []),
        null as unknown as QbitSendPlanOutpoints,
      ])

      expect(restoration.invalid).toEqual([
        { index: 0, planId: 'not-a-plan-id' },
        { index: 2, planId: OTHER_PLAN },
        { index: 3 },
      ])
      expect([...restoration.holds.keys()]).toEqual([PLAN])
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
      await expect(
        service.restorePlanHolds('not a list' as unknown as QbitSendPlanOutpoints[])
      ).resolves.toEqual({ holds: new Map(), conflicts: [], invalid: [] })
    })

    it('adds to what a plan holds already, under the same hold, and never moves it to another account', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints({}, MERGE_INPUTS))

      const restoration = await service.restorePlanHolds([
        planOutpoints(),
        planOutpoints({ address: otherAddress }, [outpoint('08')]),
      ])

      expect(restoration.holds.get(PLAN)).toBe(hold)
      expect(restoration.invalid).toEqual([{ index: 1, planId: PLAN }])
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
      await expect(reserved(otherAddress)).resolves.toEqual(new Set())
    })
  })

  describe('every entry point that admits a spend', () => {
    let hold: QbitSendPlanHold
    let otherHold: QbitSendPlanHold

    beforeEach(async () => {
      hold = await service.holdOutpointsForPlan(planOutpoints())
      otherHold = await service.holdOutpointsForPlan(
        planOutpoints({ planId: OTHER_PLAN, address: otherAddress }, [outpoint('0a')])
      )
    })

    /**
     * Holds that are not this plan's: another plan's, a released one, and
     * look-alikes of this plan's that the guard never minted.
     */
    async function foreignHolds(): Promise<[QbitSendPlanHold, QbitSendPlanHeldError['reason']][]> {
      const released = await service.holdOutpointsForPlan(
        planOutpoints({ planId: 'c3'.repeat(16) }, [outpoint('0b')])
      )
      await service.releasePlanOutpoints('c3'.repeat(16))
      return [
        [otherHold, 'held'],
        [released, 'inactive'],
        [new QbitSendPlanHold(PLAN), 'inactive'],
        [{ planId: PLAN } as unknown as QbitSendPlanHold, 'inactive'],
        [JSON.parse(JSON.stringify(hold)) as QbitSendPlanHold, 'inactive'],
        [structuredClone(hold), 'inactive'],
        [PLAN as unknown as QbitSendPlanHold, 'inactive'],
      ]
    }

    it('runWithNoOverlap and assertNoOverlap: only the plan holding every input may sign over it', async () => {
      const operation = vi.fn(async () => 'signed')
      await expectHeld(service.runWithNoOverlap(chain, MERGE_INPUTS, operation, MERGE_TXID))
      await expectHeld(service.assertNoOverlap(chain, MERGE_INPUTS, MERGE_TXID))
      for (const [foreign, reason] of await foreignHolds()) {
        await expectHeld(
          service.runWithNoOverlap(chain, MERGE_INPUTS, operation, MERGE_TXID, foreign),
          reason
        )
      }
      expect(operation).not.toHaveBeenCalled()

      await expect(
        service.runWithNoOverlap(chain, MERGE_INPUTS, operation, MERGE_TXID, hold)
      ).resolves.toBe('signed')
      await expect(
        service.assertNoOverlap(chain, PAYMENT_INPUTS, PAYMENT_TXID, hold)
      ).resolves.toBeUndefined()
      // A step spends only what its plan holds.
      await expectHeld(
        service.assertNoOverlap(chain, [...MERGE_INPUTS, outpoint('05')], MERGE_TXID, hold),
        'not_held'
      )
      await expectHeld(
        service.assertNoOverlap(ChainType.QBIT_TESTNET4, MERGE_INPUTS, MERGE_TXID, hold),
        'not_held'
      )
      // Whatever is not held signs as before, and a hold does not lift the
      // guard's other reservations.
      await expect(service.assertNoOverlap(chain, [outpoint('05')])).resolves.toBeUndefined()
      // A hold that crossed a JSON port as null is no hold presented.
      await expect(
        service.assertNoOverlap(chain, [outpoint('05')], undefined, null as never)
      ).resolves.toBeUndefined()
    })

    it('runWithBroadcastClaim: refuses a claim over a held input unless its plan presents its hold', async () => {
      const claim = walletClaim({ txid: MERGE_TXID, outpoints: MERGE_INPUTS })
      const operation = vi.fn(async () => 'signed')
      await expectHeld(service.runWithBroadcastClaim(claim, operation, 'tab:1'))
      for (const [foreign, reason] of await foreignHolds()) {
        await expectHeld(service.runWithBroadcastClaim(claim, operation, 'tab:1', foreign), reason)
      }
      expect(operation).not.toHaveBeenCalled()

      await expect(service.runWithBroadcastClaim(claim, operation, undefined, hold)).resolves.toBe(
        'signed'
      )
      await expect(service.assertNoOverlap(chain, MERGE_INPUTS, undefined, hold)).rejects.toThrow(
        'claimed by an approved send'
      )
    })

    it('broadcastIfAllowed without a claim (a provider push, the recovery migration): refuses a held input unless its plan presents its hold', async () => {
      const broadcast = vi.fn(async () => MERGE_TXID)
      await expectHeld(service.broadcastIfAllowed(chain, MERGE_TXID, MERGE_INPUTS, broadcast))
      for (const [foreign, reason] of await foreignHolds()) {
        await expectHeld(
          service.broadcastIfAllowed(
            chain,
            MERGE_TXID,
            MERGE_INPUTS,
            broadcast,
            undefined,
            foreign
          ),
          reason
        )
      }
      expect(broadcast).not.toHaveBeenCalled()

      await expect(
        service.broadcastIfAllowed(chain, MERGE_TXID, MERGE_INPUTS, broadcast, undefined, hold)
      ).resolves.toBe(MERGE_TXID)
      expect(broadcast).toHaveBeenCalledTimes(1)
      // Handed nothing to check on the explorer: it is no fee bump.
      expect(broadcast).toHaveBeenCalledWith({})
    })

    it('broadcastIfAllowed with a claim: refuses the exact held claim unless its plan presents its hold', async () => {
      const claim = walletClaim({ txid: MERGE_TXID, outpoints: MERGE_INPUTS })
      await service.runWithBroadcastClaim(claim, async () => 'signed', undefined, hold)
      const broadcast = vi.fn(async () => MERGE_TXID)

      await expectHeld(
        service.broadcastIfAllowed(chain, MERGE_TXID, MERGE_INPUTS, broadcast, claim)
      )
      await expectHeld(
        service.broadcastIfAllowed(chain, MERGE_TXID, MERGE_INPUTS, broadcast, claim, otherHold)
      )
      expect(broadcast).not.toHaveBeenCalled()

      await expect(
        service.broadcastIfAllowed(chain, MERGE_TXID, MERGE_INPUTS, broadcast, claim, hold)
      ).resolves.toBe(MERGE_TXID)
      // Consumed, as any claim its broadcast consumes.
      await expect(service.releaseBroadcastClaim(claim)).resolves.toBe(false)
    })

    it('acquireExternalSigningLock: refuses a lock over a held input', async () => {
      await expectHeld(
        service.acquireExternalSigningLock({
          purpose: 'sign',
          chain,
          address,
          origin: 'https://otc.example',
          entries: [{ txid: '11'.repeat(32), outpoints: [outpoint('02', 1)] }],
        })
      )
      await expect(reserved()).resolves.toEqual(new Set(PLAN_OUTPOINTS.map(key)))
    })

    it('openProviderSendRequest and runWithProviderBroadcastClaim: refuse a website request over a held input', async () => {
      await expectHeld(
        service.openProviderSendRequest(broadcastClaim({ outpoints: [outpoint('02', 1)] }))
      )

      // A request opened before a plan was restored over its input cannot
      // register its claim afterwards.
      service.init()
      const claim = broadcastClaim({ outpoints: [outpoint('02', 1)] })
      await service.openProviderSendRequest(claim)
      const restoration = await service.restorePlanHolds([planOutpoints()])
      expect(restoration.conflicts[0]?.conflicts).toEqual([
        { outpoint: key(outpoint('02', 1)), kind: 'provider_send_request' },
      ])
      const operation = vi.fn(async () => 'signed')
      await expectHeld(service.runWithProviderBroadcastClaim(claim, operation))
      expect(operation).not.toHaveBeenCalled()
    })

    it('promoteExternalSigningLockToBroadcastClaim: refuses to promote a lock over a held input', async () => {
      service.init()
      const claim = broadcastClaim({ outpoints: [outpoint('02', 1)] })
      await service.openProviderSendRequest(claim)
      const lock = await service.acquireExternalSigningLock({
        purpose: 'send',
        chain,
        address,
        origin: claim.origin,
        entries: [{ txid: claim.txid, outpoints: claim.outpoints }],
      })
      const restoration = await service.restorePlanHolds([planOutpoints()])
      expect(restoration.conflicts[0]?.conflicts.map(conflict => conflict.kind)).toEqual([
        'external_signing_lock',
        'provider_send_request',
      ])

      await expectHeld(service.promoteExternalSigningLockToBroadcastClaim(lock, claim))
      // Still the lock, never a claim.
      await expect(service.releaseExternalSigningLock(lock)).resolves.toBe(true)
      await expect(service.releaseBroadcastClaim(claim)).resolves.toBe(false)
    })

    it("restoreBroadcastClaim: refuses to restore a page's claim over a held input", async () => {
      const claim = walletClaim({ outpoints: [outpoint('02', 1)] })
      await expect(service.restoreBroadcastClaim(claim, address, 'tab:1')).resolves.toBe('refused')
      await expect(service.releaseBroadcastClaim(claim)).resolves.toBe(false)
    })

    it("refuses an ordinary fee bump of the plan's merge, and lets the plan replace its own merge", async () => {
      // The merge went out under the plan's hold.
      await service.broadcastIfAllowed(
        chain,
        MERGE_TXID,
        MERGE_INPUTS,
        async () => MERGE_TXID,
        undefined,
        hold
      )
      await expect(service.hasDependentSpend(chain, MERGE_TXID)).resolves.toBe(true)
      await expect(service.hasDependentSpend(chain, MERGE_TXID.toUpperCase())).resolves.toBe(true)
      await expect(service.hasDependentSpend(ChainType.QBIT_TESTNET4, MERGE_TXID)).resolves.toBe(
        false
      )
      await expect(service.hasDependentSpend(chain, PAYMENT_TXID)).resolves.toBe(false)

      const bump = walletClaim({
        txid: 'ef'.repeat(32),
        outpoints: MERGE_INPUTS,
        replaces: MERGE_TXID,
        replacedOutputCount: 1,
      })
      const operation = vi.fn(async () => 'signed')
      // Without the hold: its inputs are held.
      await expectHeld(service.runWithBroadcastClaim(bump, operation, 'tab:1'))
      // A bump over inputs no plan holds is refused all the same: the plan
      // spends the merge's output with its payment.
      const unheldBump = { ...bump, outpoints: [outpoint('05')] }
      await expect(service.runWithBroadcastClaim(unheldBump, operation, 'tab:1')).rejects.toThrow(
        'later payment depends on the transaction this fee bump replaces'
      )
      expect(operation).not.toHaveBeenCalled()

      // The plan replaces its own merge: it holds the new merge's output
      // as well while the old one may still confirm.
      await service.replacePlanOutpoints(
        planOutpoints({}, [...PLAN_OUTPOINTS, { txid: 'ef'.repeat(32), vout: 0 }])
      )
      await expect(service.runWithBroadcastClaim(bump, operation, undefined, hold)).resolves.toBe(
        'signed'
      )
      const broadcast = vi.fn(async () => bump.txid)
      await expect(
        service.broadcastIfAllowed(chain, bump.txid, bump.outpoints, broadcast, bump, hold)
      ).resolves.toBe(bump.txid)
      // Its broadcast still checks the explorer for what spends the merge.
      expect(broadcast).toHaveBeenCalledWith({ replaces: { txid: MERGE_TXID, outputCount: 1 } })
      // Once the plan lets go, nothing of the wallet's depends on the old merge.
      await service.releasePlanOutpoints(PLAN)
      await expect(service.hasDependentSpend(chain, MERGE_TXID)).resolves.toBe(false)
    })

    it("restores no page's fee bump of the plan's merge, whatever inputs it names", async () => {
      // What a page kept from before a restart: a bump of the merge over
      // inputs no plan holds. The plan spends the merge's output with its
      // payment, so the bump would evict it.
      const bump = walletClaim({
        txid: 'ef'.repeat(32),
        outpoints: [outpoint('05')],
        replaces: MERGE_TXID,
        replacedOutputCount: 1,
      })
      await expect(service.restoreBroadcastClaim(bump, address, 'tab:1')).resolves.toBe('refused')
      await expect(service.releaseBroadcastClaim(bump)).resolves.toBe(false)

      await service.releasePlanOutpoints(PLAN)
      await expect(service.restoreBroadcastClaim(bump, address, 'tab:1')).resolves.toBe('restored')
    })

    it('never records an undispatched retry over an input a plan holds', async () => {
      await service.recordInconclusiveBroadcast(
        chain,
        '11'.repeat(32),
        [outpoint('02', 1), outpoint('05')],
        walletClaim({ outpoints: [outpoint('02', 1), outpoint('05')] }),
        false
      )
      await service.releasePlanOutpoints(PLAN)

      await expect(reserved()).resolves.toEqual(new Set([key(outpoint('05'))]))
    })
  })

  describe('what a fee bump’s assessment reads', () => {
    it('lists what the plans hold on a network, under any account, exactly what a bump’s claim is refused for', async () => {
      await service.holdOutpointsForPlan(planOutpoints())
      await service.holdOutpointsForPlan(
        planOutpoints({ planId: OTHER_PLAN, address: otherAddress }, [outpoint('0a')])
      )
      await service.holdOutpointsForPlan(
        planOutpoints({ planId: 'c3'.repeat(16), chain: ChainType.QBIT_TESTNET4 }, [outpoint('0b')])
      )
      const listed = await service.getPlanHeldOutpointKeys(chain)
      expect(listed).toEqual(new Set([...PLAN_OUTPOINTS, outpoint('0a')].map(key)))
      // A bump presents no plan's hold: its claim over any of them is refused
      // as held, and over an output no plan holds it is admitted.
      const bumpOver = (spent: QbitOutpoint) =>
        walletClaim({
          txid: 'e5'.repeat(32),
          outpoints: [spent],
          replaces: 'e6'.repeat(32),
          replacedOutputCount: 2,
        })
      for (const spent of [...PLAN_OUTPOINTS, outpoint('0a')]) {
        await expectHeld(service.runWithBroadcastClaim(bumpOver(spent), async () => 'signed'))
      }
      await expect(
        service.runWithBroadcastClaim(bumpOver(outpoint('0b')), async () => 'signed')
      ).resolves.toBe('signed')
      // The list is a copy: what it is changed into holds nothing.
      listed.add(key(outpoint('0c')))
      expect((await service.getPlanHeldOutpointKeys(chain)).has(key(outpoint('0c')))).toBe(false)
      // Once a plan lets go, its outputs are no longer listed.
      await service.releasePlanOutpoints(PLAN)
      expect(await service.getPlanHeldOutpointKeys(chain)).toEqual(new Set([key(outpoint('0a'))]))
    })
  })

  describe("a plan step's broadcast", () => {
    it('keeps the inputs of an accepted step reserved as recently spent once the hold is released', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())
      await service.broadcastIfAllowed(
        chain,
        MERGE_TXID,
        MERGE_INPUTS,
        async () => MERGE_TXID,
        undefined,
        hold
      )
      // A rebroadcast of the same step passes.
      await expect(
        service.broadcastIfAllowed(
          chain,
          MERGE_TXID,
          MERGE_INPUTS,
          async () => 'again',
          undefined,
          hold
        )
      ).resolves.toBe('again')

      await service.releasePlanOutpoints(PLAN)

      // Filed under the plan's account, as the account's own send.
      await expect(reserved()).resolves.toEqual(new Set(MERGE_INPUTS.map(key)))
      await expect(reserved(otherAddress)).resolves.toEqual(new Set())
      await expect(service.assertNoOverlap(chain, [outpoint('01')])).rejects.toThrow(
        'recent broadcast already spent'
      )
      await expect(
        service.assertNoOverlap(chain, MERGE_INPUTS, MERGE_TXID)
      ).resolves.toBeUndefined()
    })

    it('keeps the inputs of a step whose outcome is unknown reserved once the hold is released', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())
      const lost = new Error('socket hang up')
      await expect(
        service.broadcastIfAllowed(
          chain,
          MERGE_TXID,
          MERGE_INPUTS,
          async () => {
            throw lost
          },
          undefined,
          hold
        )
      ).rejects.toBe(lost)
      // What the wallet's broadcast path records for an inconclusive dispatch.
      await service.recordInconclusiveBroadcast(chain, MERGE_TXID, MERGE_INPUTS)

      await service.releasePlanOutpoints(PLAN)

      await expect(reserved()).resolves.toEqual(new Set(MERGE_INPUTS.map(key)))
      await expect(service.hasUnknownBroadcastOutcome(chain, MERGE_TXID)).resolves.toBe(true)
      await expect(service.assertNoOverlap(chain, [outpoint('03')])).rejects.toThrow(
        'recent broadcast already spent'
      )
    })
  })

  describe('lifetime', () => {
    it('forgets every hold on reset and on reinitialization, and only then', async () => {
      const hold = await service.holdOutpointsForPlan(planOutpoints())
      await service.resetAllData()
      await expect(reserved()).resolves.toEqual(new Set())
      await expectHeld(service.assertNoOverlap(chain, MERGE_INPUTS, undefined, hold), 'inactive')

      await service.holdOutpointsForPlan(planOutpoints())
      service.init()
      await expect(reserved()).resolves.toEqual(new Set())
      await expect(service.assertNoOverlap(chain, MERGE_INPUTS)).resolves.toBeUndefined()
    })
  })
})
