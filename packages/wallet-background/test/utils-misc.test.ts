import { describe, expect, it, vi } from 'vitest'

import { amountToSatoshis } from '../src/utils/qbit-utils'
import { underline2Camelcase, wait } from '../src/utils'

describe('misc utils', () => {
  it('amountToSatoshis converts Qbit amounts accurately', () => {
    expect(amountToSatoshis('0.00000001')).toBe(1)
    expect(amountToSatoshis(0.12345678)).toBe(12345678)
  })

  it('underline2Camelcase converts snake_case to camelCase style', () => {
    expect(underline2Camelcase('wallet_background_service')).toBe('walletBackgroundService')
  })

  it('wait executes callback after delay', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()

    const p = wait(fn, 500)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    await p

    expect(fn).toHaveBeenCalledTimes(1)
  })
})
