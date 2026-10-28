import { describe, expect, it, vi } from 'vitest'

import {
  ChainType,
  getChainFlags,
} from '../src/types'
import {
  hexToBase64,
  isP2MRAddress,
  isSupportedAddressType,
  sleep,
} from '../src/utils'

describe('utils and types', () => {
  it('getChainFlags returns exact flags for each chain type', () => {
    expect(getChainFlags(ChainType.QBIT_MAINNET)).toEqual({
      isQbitMainnet: true,
      isQbitTestnet4: false,
      isQbitRegtest: false,
    })

    expect(getChainFlags(ChainType.QBIT_TESTNET4)).toEqual({
      isQbitMainnet: false,
      isQbitTestnet4: true,
      isQbitRegtest: false,
    })

    expect(getChainFlags(ChainType.QBIT_REGTEST)).toEqual({
      isQbitMainnet: false,
      isQbitTestnet4: false,
      isQbitRegtest: true,
    })
  })

  it('hexToBase64 converts hex payload correctly', () => {
    expect(hexToBase64('48656c6c6f')).toBe('SGVsbG8=')
  })

  it('address type helpers detect qbit P2MR formats', () => {
    expect(isP2MRAddress('qb1zabc')).toBe(true)
    expect(isP2MRAddress('tq1zabc')).toBe(true)
    expect(isP2MRAddress('qbrt1zabc')).toBe(true)
    expect(isP2MRAddress('qb1pabc')).toBe(false)

    expect(isSupportedAddressType('qbrt1zabc')).toBe(true)
    expect(isSupportedAddressType('1invalid')).toBe(false)
  })

  it('sleep resolves after timeout', async () => {
    vi.useFakeTimers()
    const done = vi.fn()

    const p = sleep(300).then(done)
    expect(done).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    await p

    expect(done).toHaveBeenCalledTimes(1)
  })
})
