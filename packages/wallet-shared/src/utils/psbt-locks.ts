/** The sequence of a final input. When every input is final, nLockTime is not enforced. */
export const SEQUENCE_FINAL = 0xffffffff

/** BIP68: an input whose sequence has this bit set has no relative lock. */
const SEQUENCE_LOCKTIME_DISABLE_FLAG = 0x80000000
/** BIP68: with this bit set, a relative lock counts units of median time; otherwise blocks. */
const SEQUENCE_LOCKTIME_TYPE_FLAG = 0x00400000
const SEQUENCE_LOCKTIME_MASK = 0x0000ffff
/** BIP68: seconds in one unit of a time-based relative lock. */
const SEQUENCE_LOCKTIME_GRANULARITY_SECONDS = 512

/** An input of a transaction, with its sequence when it is known. */
interface SequencedInput {
  sequence?: number
}

/**
 * A BIP68 relative lock on one input: the transaction can be mined only once
 * the coin the input spends has that many confirmations, or is that old by the
 * network's median time.
 */
export interface RelativeLock {
  /** The input's index. */
  input: number
  /** Counted in confirmations, or in seconds of median time. */
  type: 'blocks' | 'time'
  /** Confirmations, or seconds (a multiple of 512). Never 0, which holds nothing back. */
  value: number
}

/**
 * Whether a transaction's nLockTime holds it back: it does unless it is 0 or
 * every input is final. An input whose sequence is unknown is not final.
 */
export function isPsbtLocktimeEnforced(
  locktime: number,
  inputs: readonly SequencedInput[]
): boolean {
  return locktime !== 0 && !inputs.every(input => input.sequence === SEQUENCE_FINAL)
}

/**
 * The BIP68 relative locks a transaction's inputs set, in input order. Nodes
 * enforce them from version 2, the version read as a uint32 as qbit Core reads
 * it. An input sets none when its sequence is unknown, has the disable bit set,
 * or locks for 0.
 */
export function psbtRelativeLocks(
  version: number,
  inputs: readonly SequencedInput[]
): RelativeLock[] {
  if (version >>> 0 < 2) return []
  return inputs.flatMap(({ sequence }, input): RelativeLock[] => {
    if (sequence === undefined || (sequence & SEQUENCE_LOCKTIME_DISABLE_FLAG) !== 0) return []
    const units = sequence & SEQUENCE_LOCKTIME_MASK
    if (units === 0) return []
    if ((sequence & SEQUENCE_LOCKTIME_TYPE_FLAG) === 0) {
      return [{ input, type: 'blocks', value: units }]
    }
    return [{ input, type: 'time', value: units * SEQUENCE_LOCKTIME_GRANULARITY_SECONDS }]
  })
}
