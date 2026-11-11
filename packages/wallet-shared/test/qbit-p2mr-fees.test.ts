import { describe, expect, it } from 'vitest'

import {
  QBIT_FALLBACK_FEE_RATE,
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  assertQbitFeeRateWithinPolicy,
  estimateQbitP2mrTransaction,
  isQbitFeeRateWithinPolicy,
  qbitFeeForVsize,
  qbitMaximumTotalFee,
  qbitP2mrInputsDominateFee,
} from '../src/utils/qbit-p2mr-fees'

const SINGLE_KEY = {
  inputCount: 1,
  outputScriptLengths: [34],
  leafScriptLength: 34,
  controlBlockLength: QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
}

describe('qbit P2MR transaction estimator', () => {
  it('counts every finalized witness byte at the Qbit scale factor', () => {
    // Without a rate the fee is priced at the 1 bit/vB fallback.
    expect(estimateQbitP2mrTransaction(SINGLE_KEY)).toEqual({
      vsize: 3817,
      fee: 3817,
      inputVsize: 3762,
    })

    expect(
      estimateQbitP2mrTransaction({
        ...SINGLE_KEY,
        outputScriptLengths: [34, 34],
      })
    ).toEqual({ vsize: 3860, fee: 3860, inputVsize: 3762 })
  })

  it('matches Core sizing for an explicit-hashtype single-key signature item', () => {
    // qbit Core's P2MR_V1_SINGLE_KEY_SPEND_SIZE uses the maximum 3,681-byte
    // signature item. Including the surrounding 1-in/1-out transaction yields
    // an exact finalized vsize of 3,818 bytes at WITNESS_SCALE_FACTOR=1.
    expect(
      estimateQbitP2mrTransaction({
        ...SINGLE_KEY,
        signatureItemLength: 3681,
        feeRate: 2.5,
      })
    ).toEqual({ vsize: 3818, fee: 9545, inputVsize: 3763 })
  })

  it('scales every input at full witness size and applies the relay fee floor', () => {
    // A rate of 0 is priced at the 0.25 bits/vB floor: 7,579 / 4 rounded up.
    expect(
      estimateQbitP2mrTransaction({
        ...SINGLE_KEY,
        inputCount: 2,
        feeRate: 0,
      })
    ).toEqual({ vsize: 7579, fee: 1895, inputVsize: 7524 })
    expect(
      estimateQbitP2mrTransaction({
        ...SINGLE_KEY,
        inputCount: 2,
        feeRate: 1,
      })
    ).toEqual({ vsize: 7579, fee: 7579, inputVsize: 7524 })
  })

  it('prices a one-input send at the relay floor at a quarter of 1 bit/vB', () => {
    expect(estimateQbitP2mrTransaction({ ...SINGLE_KEY, feeRate: 0.25 })).toEqual({
      vsize: 3817,
      fee: 955,
      inputVsize: 3762,
    })
  })

  it('uses one ceiling for exact maximum fees and input-dominance policy', () => {
    const estimate = estimateQbitP2mrTransaction({
      ...SINGLE_KEY,
      feeRate: QBIT_MAX_FEE_RATE,
    })

    expect(estimate.fee).toBe(qbitMaximumTotalFee(estimate.vsize))
    expect(estimate.fee).toBe(38_170_000)
    expect(qbitP2mrInputsDominateFee(estimate)).toBe(true)
    expect(
      qbitP2mrInputsDominateFee({
        inputVsize: 74,
        vsize: 100,
      })
    ).toBe(false)
  })

  it('rejects malformed size and fee inputs', () => {
    expect(() => estimateQbitP2mrTransaction({ ...SINGLE_KEY, inputCount: 0 })).toThrow(
      /inputCount/
    )
    expect(() => estimateQbitP2mrTransaction({ ...SINGLE_KEY, outputScriptLengths: [-1] })).toThrow(
      /outputScriptLengths/
    )
    expect(() => estimateQbitP2mrTransaction({ ...SINGLE_KEY, controlBlockLength: 0 })).toThrow(
      /controlBlockLength/
    )
    expect(() => estimateQbitP2mrTransaction({ ...SINGLE_KEY, feeRate: Number.NaN })).toThrow(
      /feeRate/
    )
    expect(() =>
      estimateQbitP2mrTransaction({
        ...SINGLE_KEY,
        feeRate: QBIT_MAX_FEE_RATE + 0.01,
      })
    ).toThrow(/feeRate/)
    expect(() => qbitMaximumTotalFee(Number.MAX_SAFE_INTEGER)).toThrow(/safe integer/)
  })
})

describe('qbit fee rate policy', () => {
  const MESSAGE = 'feeRate must be between 0.25 and 10000 bits/vB'

  it("is qbit Core's relay floor, 250 sat/kvB, up to the wallet's ceiling", () => {
    expect(QBIT_MIN_RELAY_FEE_RATE).toBe(0.25)
    expect(QBIT_MAX_FEE_RATE).toBe(10_000)
    for (const feeRate of [0.25, 0.26, 0.5, 0.99, 1, 2.5, 9_999.99, 10_000]) {
      expect(isQbitFeeRateWithinPolicy(feeRate)).toBe(true)
      expect(() => assertQbitFeeRateWithinPolicy(feeRate)).not.toThrow()
    }
  })

  it('refuses rates below the floor, above the ceiling, non-finite numbers and non-numbers', () => {
    for (const feeRate of [
      0.24,
      0.2499,
      0.249_999_999,
      0,
      -0,
      -0.25,
      -1,
      10_000.01,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '0.25',
      '1',
      null,
      undefined,
      true,
      {},
      [1],
    ]) {
      expect(isQbitFeeRateWithinPolicy(feeRate)).toBe(false)
      expect(() => assertQbitFeeRateWithinPolicy(feeRate)).toThrow(RangeError)
      expect(() => assertQbitFeeRateWithinPolicy(feeRate)).toThrow(MESSAGE)
    }
  })

  it('falls back to 1 bit/vB without an estimate, a rate within the policy', () => {
    expect(QBIT_FALLBACK_FEE_RATE).toBe(1)
    expect(isQbitFeeRateWithinPolicy(QBIT_FALLBACK_FEE_RATE)).toBe(true)
    expect(QBIT_FALLBACK_FEE_RATE).toBeGreaterThan(QBIT_MIN_RELAY_FEE_RATE)
  })
})

describe('qbitFeeForVsize', () => {
  it('rounds the fee up, as qbit Core does', () => {
    // A one-input send: 3,817 vB at 0.25 bits/vB is 954.25 bits.
    expect(qbitFeeForVsize(3817, 0.25)).toBe(955)
    // An exact multiple needs no rounding.
    expect(qbitFeeForVsize(4000, 0.25)).toBe(1000)
    expect(qbitFeeForVsize(3817, 1)).toBe(3817)
    expect(qbitFeeForVsize(1, 0.25)).toBe(1)
  })

  it('raises a rate below the floor to it', () => {
    for (const feeRate of [0, 0.1, 0.24, 0.2499]) {
      expect(qbitFeeForVsize(3817, feeRate)).toBe(955)
      expect(qbitFeeForVsize(4000, feeRate)).toBe(1000)
    }
  })

  it('charges at the floor exactly what the node requires', () => {
    // qbit Core: a fee of at least 250 sat/kvB times the size, rounded up.
    const required = (vsize: number) => Number((BigInt(vsize) * 250n + 999n) / 1000n)
    const sizes = [
      ...Array.from({ length: 4_000 }, (_, index) => index + 1),
      3_817, 3_860, 7_579, 7_622, 11_341, 398_827, 398_870, 399_999, 400_000,
    ]
    for (const vsize of sizes) {
      expect(qbitFeeForVsize(vsize, QBIT_MIN_RELAY_FEE_RATE)).toBe(required(vsize))
    }
  })

  it('never charges less than the node requires at a rate in sat/kvB', () => {
    for (const satPerKvB of [250, 268, 270, 333, 500, 750, 999, 1_000, 1_001]) {
      const feeRate = satPerKvB / 1_000
      for (let vsize = 1; vsize <= 4_000; vsize++) {
        const required = Number((BigInt(vsize) * BigInt(satPerKvB) + 999n) / 1000n)
        const fee = qbitFeeForVsize(vsize, feeRate)
        // Floating point can add one bit, never take one away.
        expect(fee - required === 0 || fee - required === 1).toBe(true)
      }
    }
  })
})
