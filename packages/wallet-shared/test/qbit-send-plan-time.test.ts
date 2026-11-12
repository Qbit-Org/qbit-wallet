import { estimateQbitSendPlanSigningSeconds } from '../src/utils/qbit-send-plan-time'

describe('estimateQbitSendPlanSigningSeconds', () => {
  it('prices every signature and every transaction', () => {
    // 500 outputs sent whole: four merges of 106 and a payment of 80 inputs.
    expect(estimateQbitSendPlanSigningSeconds(504, 5)).toBe(645)
    expect(estimateQbitSendPlanSigningSeconds(0, 0)).toBe(0)
    expect(estimateQbitSendPlanSigningSeconds(1, 1)).toBe(5)
  })

  it('refuses counts that are not non-negative integers', () => {
    for (const bad of [NaN, Infinity, -1, 1.5, null, undefined, '3']) {
      expect(() => estimateQbitSendPlanSigningSeconds(bad as number, 1)).toThrow(RangeError)
      expect(() => estimateQbitSendPlanSigningSeconds(1, bad as number)).toThrow(RangeError)
    }
  })
})
