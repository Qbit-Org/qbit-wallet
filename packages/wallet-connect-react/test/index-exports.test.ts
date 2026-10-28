import { describe, expect, it } from 'vitest'

import {
  ChainTypeEnum,
  WalletTypeEnum,
  isP2MRAddress,
  isSupportedAddressType,
} from '../src'
import {
  ChainType,
  WalletType,
  isP2MRAddress as coreIsP2MRAddress,
  isSupportedAddressType as coreIsSupportedAddressType,
} from '@qbit/wallet-connect'

describe('index re-exports', () => {
  it('re-exports chain and wallet enums from core package', () => {
    expect(ChainTypeEnum).toBe(ChainType)
    expect(WalletTypeEnum).toBe(WalletType)
  })

  it('re-exports address helper functions from core package', () => {
    expect(isP2MRAddress).toBe(coreIsP2MRAddress)
    expect(isSupportedAddressType).toBe(coreIsSupportedAddressType)

    expect(isP2MRAddress('qbrt1zabc')).toBe(true)
    expect(isSupportedAddressType('qbrt1zabc')).toBe(true)
    expect(isSupportedAddressType('1invalid')).toBe(false)
  })
})
