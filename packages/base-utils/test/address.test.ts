import { describe, expect, it } from 'vitest'
import { isAddressLikelyValid } from '../src/address'

describe('addressUtils', () => {
  it('valid address', async () => {
    const allAddresses = [
      'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw',
      'tq1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0szskx4y',
      'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny',
    ]
    for (const address of allAddresses) {
      const result = isAddressLikelyValid(address)
      if (!result) {
        throw new Error(`Address validation failed: ${address}`)
      }
      expect(result).toBe(true)
    }
  })

  it('invalid address', async () => {
    const allAddresses = [
      'qb1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw',
      'qbit:not-an-address',
      '1JRtSjhQqt2qCRYN7jtqNUwTgn7uwagUpc',
    ]
    for (const address of allAddresses) {
      const result = isAddressLikelyValid(address) == false
      if (!result) {
        throw new Error(`Address validation failed: ${address}`)
      }
      expect(result).toBe(true)
    }
  })
})
