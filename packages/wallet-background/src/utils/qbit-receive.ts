export const QBIT_RECEIVE_GAP_LIMIT = 20

export interface QbitReceiveAllocationAddress {
  index: number
  issued: boolean
  used: boolean
  exhausted: boolean
}

export interface QbitReceiveIntentPlan {
  index: number
  activatesIndex: boolean
}

export interface QbitReceiveGapPlan {
  highestUsedIndex: number
  trailingUnusedCount: number
  remainingIntentCapacity: number
  nextIntent: QbitReceiveIntentPlan | null
}

/**
 * Pick the lowest never-issued, unused, non-exhausted index that remains
 * discoverable by a standard trailing gap scan. Existing active indexes from
 * another network are reusable as derivation slots, but still count against
 * this network's gap once they are issued here.
 */
export function planQbitReceiveIntent(
  addresses: readonly QbitReceiveAllocationAddress[],
  gapLimit = QBIT_RECEIVE_GAP_LIMIT
): QbitReceiveGapPlan {
  if (!Number.isInteger(gapLimit) || gapLimit < 1) {
    throw new Error('qbit receive gap limit must be a positive integer')
  }

  const highestUsedIndex = addresses.reduce(
    (highest, address) => (address.used ? Math.max(highest, address.index) : highest),
    -1
  )
  const highestIssuedIndex = addresses.reduce(
    (highest, address) => (address.issued ? Math.max(highest, address.index) : highest),
    -1
  )
  const trailingUnusedCount = Math.max(0, highestIssuedIndex - highestUsedIndex)
  const remainingIntentCapacity = Math.max(0, gapLimit - trailingUnusedCount)
  const lastDiscoverableIndex = highestUsedIndex + gapLimit
  const sorted = [...addresses].sort((left, right) => left.index - right.index)
  const existing = sorted.find(
    address =>
      !address.issued &&
      !address.used &&
      !address.exhausted &&
      address.index <= lastDiscoverableIndex
  )
  if (existing) {
    return {
      highestUsedIndex,
      trailingUnusedCount,
      remainingIntentCapacity,
      nextIntent: { index: existing.index, activatesIndex: false },
    }
  }

  const activeIndexes = new Set(sorted.map(address => address.index))
  let nextIndex = 0
  while (activeIndexes.has(nextIndex)) nextIndex += 1
  return {
    highestUsedIndex,
    trailingUnusedCount,
    remainingIntentCapacity,
    nextIntent:
      nextIndex <= lastDiscoverableIndex ? { index: nextIndex, activatesIndex: true } : null,
  }
}
