/** Size of a default-hashtype SLH-DSA signature witness item. */
export const QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES = 3680

/** A zero-depth P2MR control block contains only its leaf-version byte. */
export const QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES = 1

/** Effective qbit min-relay floor, in bits (satoshis) per virtual byte. */
export const QBIT_MIN_RELAY_FEE_RATE = 1

/** Wallet sanity ceiling for automatic and custom qbit fees, in bits/vB. */
export const QBIT_MAX_FEE_RATE = 10_000

/** Inputs materially dominate a P2MR transaction at or above this exact-size share. */
export const QBIT_P2MR_INPUT_DOMINANCE_RATIO = 0.75

export interface QbitP2mrTransactionEstimateParams {
  inputCount: number
  outputScriptLengths: readonly number[]
  leafScriptLength: number
  controlBlockLength: number
  /** Defaults to a 3,680-byte SIGHASH_DEFAULT signature item. */
  signatureItemLength?: number
  /** Rates below 1 sat/vB use the wallet's 1 sat/vB relay floor. */
  feeRate?: number
}

export interface QbitP2mrTransactionEstimate {
  vsize: number
  fee: number
  /** Exact finalized bytes attributable to input base data and witness stacks. */
  inputVsize: number
}

function assertSafeInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`)
  }
}

function compactSizeLength(value: number): number {
  assertSafeInteger('CompactSize value', value, 0)
  if (value < 0xfd) return 1
  if (value <= 0xffff) return 3
  if (value <= 0xffffffff) return 5
  return 9
}

/** Serialized length of one input's witness stack with items of these lengths. */
export function qbitWitnessStackLength(itemLengths: readonly number[]): number {
  return itemLengths.reduce(
    (sum, length) => sum + compactSizeLength(length) + length,
    compactSizeLength(itemLengths.length)
  )
}

export function isQbitFeeRateWithinPolicy(feeRate: unknown): feeRate is number {
  return (
    typeof feeRate === 'number' &&
    Number.isFinite(feeRate) &&
    feeRate >= QBIT_MIN_RELAY_FEE_RATE &&
    feeRate <= QBIT_MAX_FEE_RATE
  )
}

export function assertQbitFeeRateWithinPolicy(feeRate: unknown): asserts feeRate is number {
  if (!isQbitFeeRateWithinPolicy(feeRate)) {
    throw new RangeError(
      `feeRate must be between ${QBIT_MIN_RELAY_FEE_RATE} and ${QBIT_MAX_FEE_RATE} bits/vB`
    )
  }
}

export function qbitFeeForVsize(vsize: number, feeRate: number): number {
  assertSafeInteger('vsize', vsize, 1)
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > QBIT_MAX_FEE_RATE) {
    throw new RangeError(`feeRate must be a finite number between 0 and ${QBIT_MAX_FEE_RATE}`)
  }

  const fee = Math.ceil(vsize * Math.max(QBIT_MIN_RELAY_FEE_RATE, feeRate))
  if (!Number.isSafeInteger(fee)) {
    throw new RangeError('P2MR transaction fee exceeds the safe integer range')
  }
  return fee
}

export function qbitMaximumTotalFee(vsize: number): number {
  return qbitFeeForVsize(vsize, QBIT_MAX_FEE_RATE)
}

export function qbitP2mrInputsDominateFee(
  estimate: Pick<QbitP2mrTransactionEstimate, 'inputVsize' | 'vsize'>
): boolean {
  return estimate.inputVsize / estimate.vsize >= QBIT_P2MR_INPUT_DOMINANCE_RATIO
}

/**
 * Estimate the exact finalized size and fee of a single-key P2MR transaction.
 *
 * Qbit Core uses `WITNESS_SCALE_FACTOR = 1`, so finalized virtual size is the
 * full serialized BIP144 byte size.
 */
export function estimateQbitP2mrTransaction(
  params: QbitP2mrTransactionEstimateParams
): QbitP2mrTransactionEstimate {
  const {
    inputCount,
    outputScriptLengths,
    leafScriptLength,
    controlBlockLength,
    signatureItemLength = QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES,
    feeRate = 1,
  } = params

  assertSafeInteger('inputCount', inputCount, 1)
  if (outputScriptLengths.length === 0) {
    throw new RangeError('outputScriptLengths must contain at least one output')
  }
  outputScriptLengths.forEach((length, index) => {
    assertSafeInteger(`outputScriptLengths[${index}]`, length, 0)
  })
  assertSafeInteger('leafScriptLength', leafScriptLength, 0)
  assertSafeInteger('controlBlockLength', controlBlockLength, 1)
  assertSafeInteger('signatureItemLength', signatureItemLength, 1)
  const inputBaseBytes = 32 + 4 + compactSizeLength(0) + 4
  const witnessBytesPerInput = qbitWitnessStackLength([
    signatureItemLength,
    leafScriptLength,
    controlBlockLength,
  ])
  const outputBytes = outputScriptLengths.reduce(
    (sum, scriptLength) => sum + 8 + compactSizeLength(scriptLength) + scriptLength,
    0
  )
  const baseBytes =
    4 +
    compactSizeLength(inputCount) +
    inputCount * inputBaseBytes +
    compactSizeLength(outputScriptLengths.length) +
    outputBytes +
    4
  const witnessBytes = 2 + inputCount * witnessBytesPerInput
  const vsize = baseBytes + witnessBytes
  const inputVsize = inputCount * (inputBaseBytes + witnessBytesPerInput)

  if (!Number.isSafeInteger(vsize) || !Number.isSafeInteger(inputVsize)) {
    throw new RangeError('P2MR transaction estimate exceeds the safe integer range')
  }
  const fee = qbitFeeForVsize(vsize, feeRate)

  return { vsize, fee, inputVsize }
}
