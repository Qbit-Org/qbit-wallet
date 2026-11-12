/**
 * Seconds one signature takes in the wallet's service worker, measured on
 * the browser gate: the SLH-DSA signature itself and the two vault writes
 * that keep its counter (docs/pqc-counter-lifecycle.md).
 */
export const QBIT_SEND_PLAN_SECONDS_PER_SIGNATURE = 1.25

/** Seconds a transaction adds on top of its signatures: building, finalizing and broadcasting it. */
export const QBIT_SEND_PLAN_SECONDS_PER_TRANSACTION = 3

/**
 * How long signing a plan is expected to take, for the review and the send
 * screen. An estimate for a typical machine, not a promise: the progress
 * view measures the real pace once signing starts.
 */
export function estimateQbitSendPlanSigningSeconds(
  signatureCount: number,
  transactionCount: number
): number {
  if (!Number.isSafeInteger(signatureCount) || signatureCount < 0) {
    throw new RangeError('signatureCount must be a non-negative integer')
  }
  if (!Number.isSafeInteger(transactionCount) || transactionCount < 0) {
    throw new RangeError('transactionCount must be a non-negative integer')
  }
  return Math.ceil(
    signatureCount * QBIT_SEND_PLAN_SECONDS_PER_SIGNATURE +
      transactionCount * QBIT_SEND_PLAN_SECONDS_PER_TRANSACTION
  )
}
