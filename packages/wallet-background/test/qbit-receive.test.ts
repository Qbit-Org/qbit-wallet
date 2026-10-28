import { describe, expect, it } from 'vitest'

import {
  QBIT_RECEIVE_GAP_LIMIT,
  planQbitReceiveIntent,
  type QbitReceiveAllocationAddress,
} from '../src/utils/qbit-receive'

function address(
  index: number,
  options: Partial<Omit<QbitReceiveAllocationAddress, 'index'>> = {}
): QbitReceiveAllocationAddress {
  return {
    index,
    issued: false,
    used: false,
    exhausted: false,
    ...options,
  }
}

describe('qbit receive gap planner', () => {
  it('adopts an existing unused index before activating another derivation', () => {
    expect(planQbitReceiveIntent([address(0)])).toMatchObject({
      nextIntent: { index: 0, activatesIndex: false },
    })
  })

  it('never selects used or exhausted addresses', () => {
    expect(
      planQbitReceiveIntent([
        address(0, { used: true }),
        address(1, { exhausted: true }),
        address(2),
      ])
    ).toMatchObject({ nextIntent: { index: 2, activatesIndex: false } })
  })

  it('stops after twenty unused intents when no activity has been observed', () => {
    const issued = Array.from({ length: QBIT_RECEIVE_GAP_LIMIT }, (_, index) =>
      address(index, { issued: true })
    )
    expect(planQbitReceiveIntent(issued)).toMatchObject({
      highestUsedIndex: -1,
      trailingUnusedCount: 20,
      remainingIntentCapacity: 0,
      nextIntent: null,
    })
  })

  it('advances the discoverable window when activity is observed', () => {
    const addresses = Array.from({ length: QBIT_RECEIVE_GAP_LIMIT }, (_, index) =>
      address(index, { issued: true, used: index === 0 })
    )
    expect(planQbitReceiveIntent(addresses)).toMatchObject({
      highestUsedIndex: 0,
      trailingUnusedCount: 19,
      remainingIntentCapacity: 1,
      nextIntent: { index: 20, activatesIndex: true },
    })
  })

  it('uses restored gaps below the highest active index without widening the trailing gap', () => {
    expect(
      planQbitReceiveIntent([address(0, { used: true }), address(1), address(2, { used: true })])
    ).toMatchObject({
      highestUsedIndex: 2,
      nextIntent: { index: 1, activatesIndex: false },
    })
  })
})
