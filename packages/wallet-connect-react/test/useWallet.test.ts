import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { useContext } from 'react'
import type { P2mrMessageProof } from '@qbit/wallet-connect'

import { useWallet } from '../src/WalletProvider'
import type { WalletContextType } from '../src/types'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useContext: vi.fn(),
  }
})

describe('useWallet', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('exposes the P2MR-only message contract', () => {
    const context = null as unknown as WalletContextType

    if (false) {
      expectTypeOf(context.signMessage('hello')).toEqualTypeOf<Promise<P2mrMessageProof>>()
      expectTypeOf(
        context.verifyMessage('qbit-address', 'hello', {} as P2mrMessageProof)
      ).toEqualTypeOf<Promise<boolean>>()
    }

    expect(true).toBe(true)
  })

  it('throws when context is empty', () => {
    vi.mocked(useContext).mockReturnValue({} as any)

    expect(() => useWallet()).toThrow('useWallet must be used within a WalletProvider')
  })

  it('returns context when available', () => {
    const context = {
      account: { address: 'bc1qabc', pubKey: 'pubkey' },
      wallet: { config: { type: 'qbit' } },
      isConnecting: false,
      isInitialized: true,
      connect: vi.fn(),
      disconnect: vi.fn(),
      signPsbt: vi.fn(),
      signPsbts: vi.fn(),
      signMessage: vi.fn(),
      verifyMessage: vi.fn(),
      supportedWallets: [],
    }

    vi.mocked(useContext).mockReturnValue(context as any)

    expect(useWallet()).toBe(context)
  })
})
