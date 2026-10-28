import { ErrorCodes, WalletError } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { describe, expect, it } from 'vitest'

import { chainTypeToCanonicalNetwork } from '../src/shared/utils/deriveContextHash'

describe('chainTypeToCanonicalNetwork', () => {
  it('maps mainnet', () => {
    expect(chainTypeToCanonicalNetwork(ChainType.QBIT_MAINNET)).toBe('qbit-mainnet')
  })

  it('maps testnet4', () => {
    expect(chainTypeToCanonicalNetwork(ChainType.QBIT_TESTNET4)).toBe('qbit-testnet4')
  })

  it('maps regtest', () => {
    expect(chainTypeToCanonicalNetwork(ChainType.QBIT_REGTEST)).toBe('qbit-regtest')
  })

  it('throws for unknown chain', () => {
    expect(() => chainTypeToCanonicalNetwork('NOT_A_CHAIN' as ChainType)).toThrow(WalletError)
  })

  it('thrown error has code 4901 and identifies the chain', () => {
    try {
      chainTypeToCanonicalNetwork('NOT_A_CHAIN' as ChainType)
      throw new Error('did not throw')
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError)
      expect((e as WalletError).code).toBe(ErrorCodes.UNSUPPORTED_NETWORK)
      expect((e as Error).message).toContain('NOT_A_CHAIN')
    }
  })
})
