import { AddressType } from '@qbit/wallet-types'
import { expect } from 'vitest'

/**
 * For ECDSA address types, the DER signature length is not fixed.
 */
export function expectFeeRate(addressType: AddressType, feeRateA: number, feeRateB: number) {
  if (
    addressType === AddressType.P2PKH ||
    addressType === AddressType.P2WPKH ||
    addressType === AddressType.P2SH_P2WPKH ||
    addressType === AddressType.BIP44_P2WPKH
  ) {
    expect(feeRateA).lte(feeRateB * 1.01)
    expect(feeRateA).gte(feeRateB * 0.99)
  } else {
    expect(feeRateA).eq(feeRateB)
  }
}
