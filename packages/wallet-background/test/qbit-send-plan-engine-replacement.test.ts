import { beforeEach, describe, expect, it } from 'vitest'

import type { QbitSendBroadcastClaim } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import {
  QBIT_WALLET_SEND_CLAIM_ORIGIN,
  QbitSendGuardService,
  QbitSendPlanHeldError,
  QbitSendPlanHold,
  type QbitOutpoint,
} from '../src/services/qbitSendGuards'
import { qbitReplacementFeeAllowed } from '../src/utils/qbit-replacement-fee'
import type { QbitExplorerSpendCheck } from '../src/utils/qbit-explorer-spend-check'

// A send plan that raises a merge's fee replaces that merge in the network
// with one spending the same inputs. The guard admits the replacement only
// under the plan's own hold, as a fee bump's claim is admitted, and refuses
// anyone else's replacement of the plan's merge.

const chain = ChainType.QBIT_REGTEST
const address = 'qbrt1zfunding'
const PLAN = 'a1'.repeat(16)
const OTHER_PLAN = 'b2'.repeat(16)

function outpoint(byte: string, vout = 0): QbitOutpoint {
  return { txid: byte.repeat(32), vout }
}

// The merge the plan sent, and the replacement that raises its fee: the same
// inputs, a new id, one output each.
const MERGE_TXID = 'cc'.repeat(32)
const REPLACEMENT_TXID = 'ce'.repeat(32)
const INPUTS = [outpoint('01'), outpoint('02', 1), outpoint('03')]
const DIRECT = outpoint('04')
const REPLACEMENT = { replaces: MERGE_TXID, outputCount: 1 }

/** Rejects with a `QbitSendPlanHeldError` for `reason`. */
async function expectHeld(
  promise: Promise<unknown>,
  reason: QbitSendPlanHeldError['reason']
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(QbitSendPlanHeldError)
  expect((error as QbitSendPlanHeldError).reason).toBe(reason)
}

describe('the replacement rule the fee bump applies', () => {
  const original = { fee: 1_000, vsize: 1_000 }

  it('asks a higher fee, at a higher rate, higher by at least one bit a byte', () => {
    expect(qbitReplacementFeeAllowed(original, { fee: 2_000, vsize: 1_000 })).toBe(true)
    expect(qbitReplacementFeeAllowed(original, { fee: 1_999, vsize: 1_000 })).toBe(false)
    expect(qbitReplacementFeeAllowed(original, { fee: 1_000, vsize: 1_000 })).toBe(false)
    // A larger replacement must add a bit for each of its own bytes.
    expect(qbitReplacementFeeAllowed(original, { fee: 2_100, vsize: 1_100 })).toBe(true)
    expect(qbitReplacementFeeAllowed(original, { fee: 2_099, vsize: 1_100 })).toBe(false)
    // A higher fee at a lower rate is refused.
    expect(qbitReplacementFeeAllowed(original, { fee: 3_000, vsize: 3_001 })).toBe(false)
  })

  it('refuses a fee past the maximum total fee, or not a safe integer', () => {
    expect(qbitReplacementFeeAllowed(original, { fee: 10_000_000, vsize: 1_000 })).toBe(true)
    expect(qbitReplacementFeeAllowed(original, { fee: 10_000_001, vsize: 1_000 })).toBe(false)
    expect(qbitReplacementFeeAllowed(original, { fee: 2_000.5, vsize: 1_000 })).toBe(false)
    expect(qbitReplacementFeeAllowed(original, { fee: Number.NaN, vsize: 1_000 })).toBe(false)
  })
})

describe('a plan’s replacement of its own merge', () => {
  let service: QbitSendGuardService
  let hold: QbitSendPlanHold

  /** Hold the plan's outpoints, with `merge`'s output 0 as the merge that may still confirm. */
  async function holdPlan(planId = PLAN, merge = MERGE_TXID): Promise<QbitSendPlanHold> {
    return service.holdOutpointsForPlan({
      planId,
      chain,
      address,
      outpoints: [...INPUTS, { txid: merge, vout: 0 }, { txid: REPLACEMENT_TXID, vout: 0 }, DIRECT],
    })
  }

  /** The merge went out under the plan's hold: the guard records its inputs as spent by it. */
  async function sendMerge(): Promise<void> {
    await service.broadcastIfAllowed(chain, MERGE_TXID, INPUTS, async () => 'sent', undefined, hold)
  }

  beforeEach(async () => {
    service = new QbitSendGuardService()
    service.init()
    hold = await holdPlan()
    await sendMerge()
  })

  it('goes out under the plan’s hold, taking the merge’s inputs over, checked on the explorer as a fee bump is', async () => {
    const checks: QbitExplorerSpendCheck[] = []
    await expect(
      service.broadcastIfAllowed(
        chain,
        REPLACEMENT_TXID,
        INPUTS,
        async check => {
          checks.push(check)
          return 'sent'
        },
        undefined,
        hold,
        REPLACEMENT
      )
    ).resolves.toBe('sent')
    expect(checks).toEqual([{ replaces: { txid: MERGE_TXID, outputCount: 1 } }])
  })

  it('is refused as a conflict when it does not name the merge it replaces', async () => {
    await expect(
      service.broadcastIfAllowed(
        chain,
        REPLACEMENT_TXID,
        INPUTS,
        async () => 'sent',
        undefined,
        hold
      )
    ).rejects.toThrow('recent broadcast already spent')
  })

  it('is refused without the plan’s hold, under another plan’s hold, and under a look-alike', async () => {
    const send = (planHold: QbitSendPlanHold | undefined) =>
      service.broadcastIfAllowed(
        chain,
        REPLACEMENT_TXID,
        INPUTS,
        async () => 'sent',
        undefined,
        planHold,
        REPLACEMENT
      )
    await expect(send(undefined)).rejects.toThrow('only under its plan')
    const other = await service.holdOutpointsForPlan({
      planId: OTHER_PLAN,
      chain,
      address,
      outpoints: [outpoint('09')],
    })
    await expectHeld(send(other), 'held')
    await expectHeld(send(new QbitSendPlanHold(PLAN)), 'inactive')
    await expectHeld(send({ planId: PLAN } as unknown as QbitSendPlanHold), 'inactive')
    // Nor does the replacement go out with a claim.
    const claim: QbitSendBroadcastClaim = {
      chain,
      address,
      origin: QBIT_WALLET_SEND_CLAIM_ORIGIN,
      txid: REPLACEMENT_TXID,
      outpoints: INPUTS,
      replaces: MERGE_TXID,
      replacedOutputCount: 1,
    }
    await expect(
      service.broadcastIfAllowed(
        chain,
        REPLACEMENT_TXID,
        INPUTS,
        async () => 'sent',
        claim,
        hold,
        REPLACEMENT
      )
    ).rejects.toThrow('not a claim')
  })

  it('is refused for a transaction whose outputs the plan does not hold', async () => {
    await expectHeld(
      service.broadcastIfAllowed(
        chain,
        REPLACEMENT_TXID,
        INPUTS,
        async () => 'sent',
        undefined,
        hold,
        { replaces: 'ee'.repeat(32), outputCount: 1 }
      ),
      'not_held'
    )
    await expectHeld(
      service.broadcastIfAllowed(
        chain,
        REPLACEMENT_TXID,
        INPUTS,
        async () => 'sent',
        undefined,
        hold,
        { replaces: MERGE_TXID, outputCount: 2 }
      ),
      'not_held'
    )
  })

  it('refuses a malformed replacement before anything is queued', async () => {
    for (const malformed of [
      { replaces: 'xyz', outputCount: 1 },
      { replaces: MERGE_TXID, outputCount: 0 },
      { replaces: MERGE_TXID, outputCount: 1.5 },
      { replaces: REPLACEMENT_TXID, outputCount: 1 },
    ]) {
      await expect(
        service.broadcastIfAllowed(
          chain,
          REPLACEMENT_TXID,
          INPUTS,
          async () => 'sent',
          undefined,
          hold,
          malformed
        )
      ).rejects.toThrow('invalid Qbit send plan replacement')
    }
  })

  it('is refused while anything but the plan spends an output of the merge it replaces', async () => {
    // Something else, held under another plan for the sake of the test,
    // spends the merge's output: replacing the merge would evict it.
    const fresh = new QbitSendGuardService()
    fresh.init()
    service = fresh
    hold = await service.holdOutpointsForPlan({
      planId: PLAN,
      chain,
      address,
      outpoints: [...INPUTS, { txid: MERGE_TXID, vout: 0 }],
    })
    await service.restorePlanHolds([
      { planId: OTHER_PLAN, chain, address, outpoints: [{ txid: MERGE_TXID, vout: 0 }] },
    ])
    await expect(
      service.broadcastIfAllowed(
        chain,
        REPLACEMENT_TXID,
        INPUTS,
        async () => 'sent',
        undefined,
        hold,
        REPLACEMENT
      )
    ).rejects.toThrow('later payment depends')
  })

  it('is signed under the same rule: admitted under the plan’s hold, refused without it', async () => {
    await expect(
      service.assertNoOverlap(chain, INPUTS, REPLACEMENT_TXID, hold, REPLACEMENT)
    ).resolves.toBeUndefined()
    await expect(service.assertNoOverlap(chain, INPUTS, REPLACEMENT_TXID, hold)).rejects.toThrow(
      'recent broadcast already spent'
    )
    await expect(
      service.assertNoOverlap(chain, INPUTS, REPLACEMENT_TXID, undefined, REPLACEMENT)
    ).rejects.toThrow('only under its plan')
    await expectHeld(
      service.assertNoOverlap(
        chain,
        INPUTS,
        REPLACEMENT_TXID,
        new QbitSendPlanHold(PLAN),
        REPLACEMENT
      ),
      'inactive'
    )
  })

  it('leaves a page no way to bump the plan’s merge: its claim and its broadcast are refused', async () => {
    const bump: QbitSendBroadcastClaim = {
      chain,
      address,
      origin: QBIT_WALLET_SEND_CLAIM_ORIGIN,
      txid: 'ef'.repeat(32),
      outpoints: INPUTS,
      replaces: MERGE_TXID,
      replacedOutputCount: 1,
    }
    await expectHeld(
      service.runWithBroadcastClaim(bump, async () => 'signed'),
      'held'
    )
    await expectHeld(
      service.broadcastIfAllowed(chain, bump.txid, INPUTS, async () => 'sent'),
      'held'
    )
    // The plan holds the merge's output, which the plan's payment spends.
    await expect(service.hasDependentSpend(chain, MERGE_TXID)).resolves.toBe(true)
    await expect(service.hasDependentSpend(chain, REPLACEMENT_TXID)).resolves.toBe(true)
  })
})
