/** A consolidation batch merges outputs, so it spends at least two. */
export const QBIT_CONSOLIDATION_MIN_INPUTS = 2

/**
 * Whether `value` is a batch size a consolidation accepts: a whole number of
 * inputs from `QBIT_CONSOLIDATION_MIN_INPUTS` to `maxInputCount`, the most
 * one batch of the account carries (`QbitConsolidationStatus.maxInputCount`).
 * Strings, fractions and non-finite numbers are refused, and so is every
 * value when `maxInputCount` is not a whole number. The background's request
 * check and the consolidation screen share this one rule.
 */
export function isQbitConsolidationBatchSize(
  value: unknown,
  maxInputCount: number
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Number.isSafeInteger(maxInputCount) &&
    value >= QBIT_CONSOLIDATION_MIN_INPUTS &&
    value <= maxInputCount
  )
}

/** Throws a `RangeError` naming the accepted range unless `isQbitConsolidationBatchSize`. */
export function assertQbitConsolidationBatchSize(
  value: unknown,
  maxInputCount: number
): asserts value is number {
  if (!isQbitConsolidationBatchSize(value, maxInputCount)) {
    throw new RangeError(
      `maxInputs must be a whole number from ${QBIT_CONSOLIDATION_MIN_INPUTS} to ${maxInputCount}`
    )
  }
}
