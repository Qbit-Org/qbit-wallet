import { QBIT_P2MR_DUST } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import { describe, expect, it } from 'vitest'
import { getUtxoDust } from '../src'

describe('getUtxoDust', () => {
  it('uses the shared qbit Core P2MR dust threshold', () => {
    expect(getUtxoDust(AddressType.P2MR)).toBe(QBIT_P2MR_DUST)
  })

  it('preserves classical address dust thresholds', () => {
    expect(getUtxoDust(AddressType.P2WPKH)).toBe(294)
    expect(getUtxoDust(AddressType.P2TR)).toBe(330)
    expect(getUtxoDust(AddressType.P2PKH)).toBe(546)
  })
})
