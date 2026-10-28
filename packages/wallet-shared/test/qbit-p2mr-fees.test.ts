import { describe, expect, it } from 'vitest'

import {
  QBIT_MAX_FEE_RATE,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  estimateQbitP2mrTransaction,
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
    expect(
      estimateQbitP2mrTransaction({
        ...SINGLE_KEY,
        inputCount: 2,
        feeRate: 0,
      })
    ).toEqual({ vsize: 7579, fee: 7579, inputVsize: 7524 })
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
