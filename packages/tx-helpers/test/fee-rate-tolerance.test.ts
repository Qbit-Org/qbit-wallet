import { AddressType } from '@qbit/wallet-types'
import { describe, expect, it } from 'vitest'

import { expectFeeRate } from './utils'

const ecdsaAddressTypes = [
  AddressType.P2PKH,
  AddressType.P2WPKH,
  AddressType.P2SH_P2WPKH,
  AddressType.BIP44_P2WPKH,
]

describe('expectFeeRate', () => {
  it.each(ecdsaAddressTypes)(
    'accepts the inclusive ECDSA DER-size tolerance for address type %s',
    addressType => {
      expect(() => expectFeeRate(addressType, 9.9, 10)).not.toThrow()
      expect(() => expectFeeRate(addressType, 10.1, 10)).not.toThrow()
    }
  )

  it('rejects rates outside the ECDSA DER-size tolerance', () => {
    expect(() => expectFeeRate(AddressType.P2PKH, 9.89, 10)).toThrow()
    expect(() => expectFeeRate(AddressType.P2PKH, 10.11, 10)).toThrow()
  })
})
