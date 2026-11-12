import { describe, expect, it } from 'vitest'

import type {
  QbitConsolidationBatch,
  QbitConsolidationBatchShape,
  QbitConsolidationRequest,
  QbitConsolidationStatus,
} from '../src/types/sign-tx'
import {
  qbitP2mrMaxStandardInputCount,
  type QbitP2mrSelectionShape,
} from '../src/utils/qbit-coin-selection'
import {
  QBIT_CONSOLIDATION_MIN_INPUTS,
  assertQbitConsolidationBatchSize,
  isQbitConsolidationBatchSize,
} from '../src/utils/qbit-consolidation'
import { estimateQbitP2mrTransaction } from '../src/utils/qbit-p2mr-fees'

// qbit Core's standard size: 106 single-key inputs to one output.
const MAX_INPUT_COUNT = 106

describe('consolidation batch size', () => {
  it('accepts every whole number from 2 to the maximum', () => {
    expect(QBIT_CONSOLIDATION_MIN_INPUTS).toBe(2)
    for (const size of [2, 3, 10, 25, 102, 105, MAX_INPUT_COUNT]) {
      expect(isQbitConsolidationBatchSize(size, MAX_INPUT_COUNT)).toBe(true)
      expect(() => assertQbitConsolidationBatchSize(size, MAX_INPUT_COUNT)).not.toThrow()
    }
  })

  it('refuses sizes out of range, fractions, non-finite numbers and non-numbers', () => {
    for (const value of [
      0,
      1,
      -2,
      MAX_INPUT_COUNT + 1,
      2.5,
      105.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '5',
      '106',
      '',
      null,
      undefined,
      true,
      {},
      [5],
      BigInt(5),
    ]) {
      expect(isQbitConsolidationBatchSize(value, MAX_INPUT_COUNT)).toBe(false)
      expect(() => assertQbitConsolidationBatchSize(value, MAX_INPUT_COUNT)).toThrow(RangeError)
      expect(() => assertQbitConsolidationBatchSize(value, MAX_INPUT_COUNT)).toThrow(
        'maxInputs must be a whole number from 2 to 106'
      )
    }
  })

  it('names the range of the account it checks against', () => {
    expect(isQbitConsolidationBatchSize(25, 24)).toBe(false)
    expect(() => assertQbitConsolidationBatchSize(25, 24)).toThrow(
      'maxInputs must be a whole number from 2 to 24'
    )
    expect(isQbitConsolidationBatchSize(2, 2)).toBe(true)
  })

  it('accepts nothing when the maximum allows no batch or is not a whole number', () => {
    for (const maxInputCount of [
      0,
      1,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      for (const size of [2, 3, 1_000]) {
        expect(isQbitConsolidationBatchSize(size, maxInputCount)).toBe(false)
        expect(() => assertQbitConsolidationBatchSize(size, maxInputCount)).toThrow(RangeError)
      }
    }
  })
})

// Compile-time checks. Vitest does not typecheck; `tsc` over this file
// does. A status's batch shape is a selection shape less its fee rate, and
// with an input count it is a full `estimateQbitP2mrTransaction` request.
const asSelectionShape = (
  shape: QbitConsolidationBatchShape
): Omit<QbitP2mrSelectionShape, 'feeRate'> => shape
const asEstimateParams = (
  shape: QbitConsolidationBatchShape,
  inputCount: number
): Parameters<typeof estimateQbitP2mrTransaction>[0] => ({ ...shape, inputCount })

describe('consolidation batch shape', () => {
  const status: Pick<QbitConsolidationStatus, 'maxInputCount' | 'batchShape'> = {
    maxInputCount: MAX_INPUT_COUNT,
    batchShape: { outputScriptLengths: [34], leafScriptLength: 34, controlBlockLength: 1 },
  }

  it('sizes the batch as the selection shape does', () => {
    expect(qbitP2mrMaxStandardInputCount(status.batchShape)).toBe(status.maxInputCount)
    expect(qbitP2mrMaxStandardInputCount(asSelectionShape(status.batchShape))).toBe(106)
  })

  it('prices a batch of a chosen size before one is prepared', () => {
    expect(
      estimateQbitP2mrTransaction({ ...asEstimateParams(status.batchShape, 25), feeRate: 2 })
    ).toEqual({
      vsize: 55 + 25 * 3_762,
      fee: 2 * (55 + 25 * 3_762),
      inputVsize: 25 * 3_762,
    })
    expect(
      estimateQbitP2mrTransaction({
        ...status.batchShape,
        inputCount: status.maxInputCount,
        feeRate: 1,
      })
    ).toMatchObject({ vsize: 398_827, fee: 398_827 })
    // At the 0.25 bits/vB relay floor a full batch costs a quarter, rounded up.
    expect(
      estimateQbitP2mrTransaction({
        ...status.batchShape,
        inputCount: status.maxInputCount,
        feeRate: 0.25,
      })
    ).toMatchObject({ vsize: 398_827, fee: 99_707 })
    expect(
      estimateQbitP2mrTransaction({ ...asEstimateParams(status.batchShape, 25), feeRate: 0.25 })
    ).toMatchObject({ vsize: 94_105, fee: 23_527 })
  })

  it('keeps the size a batch was prepared with for the next request', () => {
    const batch: QbitConsolidationBatch = {
      confirmedOutputCount: 640,
      outputLimit: 500,
      amount: 1_000_000,
      fundingOutputCounts: Array.from({ length: 25 }, () => 2),
      maxInputs: 25,
    }
    const next: QbitConsolidationRequest = {
      feeRate: 1,
      enableRBF: true,
      maxInputs: batch.maxInputs,
    }
    expect(() =>
      assertQbitConsolidationBatchSize(next.maxInputs, status.maxInputCount)
    ).not.toThrow()
  })
})
