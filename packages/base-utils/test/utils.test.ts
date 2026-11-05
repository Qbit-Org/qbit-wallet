import { describe, expect, it } from 'vitest'

import { numUtils, paramsUtils, timeUtils } from '../src'

describe('numUtils', () => {
  it('converts between satoshis and amounts', () => {
    expect(numUtils.satoshisToAmount(150_000_000)).toBe('1.50000000')
    expect(numUtils.satoshisToAmount(1)).toBe('0.00000001')
    expect(numUtils.amountToSatoshis('0.00000001')).toBe(1)
    expect(numUtils.amountToSatoshis('1.5')).toBe(150_000_000)
  })
})

describe('paramsUtils.formatAmount', () => {
  it('drops a trailing point and keeps a positive amount', () => {
    expect(paramsUtils.formatAmount('1.')).toBe('1')
    expect(paramsUtils.formatAmount('0.5')).toBe('0.5')
    expect(paramsUtils.formatAmount(2)).toBe(2)
  })

  it('refuses a missing or negative amount', () => {
    expect(() => paramsUtils.formatAmount('')).toThrow('Amount is required')
    expect(() => paramsUtils.formatAmount(0)).toThrow('Amount is required')
    expect(() => paramsUtils.formatAmount('-1')).toThrow('Amount must be greater than 0')
    expect(() => paramsUtils.formatAmount(-1)).toThrow('Amount must be greater than 0')
  })
})

describe('timeUtils.sleep', () => {
  it('resolves after the delay', async () => {
    await expect(timeUtils.sleep(0)).resolves.toBeNull()
  })
})
