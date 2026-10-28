import type { P2mrMessageProof } from '@qbit-oss/protocol'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { ChainType } from '../src/types'
import { QbitWallet } from '../src/wallets/QbitWallet'

const PROOF = {
  type: 'p2mr-message',
  address: 'qb1zaccount',
} as P2mrMessageProof

const createProvider = (overrides: Record<string, unknown> = {}) => ({
  getAccounts: vi.fn().mockResolvedValue(['qb1zaccount']),
  requestAccounts: vi.fn().mockResolvedValue(['qb1zaccount']),
  getPublicKey: vi.fn().mockResolvedValue('pubkey'),
  getBalance: vi.fn().mockResolvedValue({ confirmed: 0, unconfirmed: 0, total: 0 }),
  getNetwork: vi.fn().mockResolvedValue('mainnet'),
  switchNetwork: vi.fn().mockResolvedValue(undefined),
  getChain: vi.fn().mockResolvedValue(ChainType.QBIT_MAINNET),
  switchChain: vi.fn().mockResolvedValue(undefined),
  signMessage: vi.fn().mockResolvedValue(PROOF),
  verifyMessage: vi.fn().mockResolvedValue(true),
  signPsbt: vi.fn().mockResolvedValue('signed-psbt'),
  signPsbts: vi.fn().mockResolvedValue(['signed-psbt']),
  pushPsbt: vi.fn().mockResolvedValue('txid'),
  pushTx: vi.fn().mockResolvedValue('txid'),
  sendQbit: vi.fn().mockResolvedValue('txid'),
  disconnect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
  ...overrides,
})

describe('QbitWallet', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    ;(globalThis as any).window = {}
  })

  it('exposes structured P2MR message signing and verification types', () => {
    const wallet = new QbitWallet()

    if (false) {
      expectTypeOf(wallet.signMessage('hello')).toEqualTypeOf<Promise<P2mrMessageProof>>()
      expectTypeOf(wallet.verifyMessage('qb1zaccount', 'hello', PROOF)).toEqualTypeOf<
        Promise<boolean>
      >()
    }

    expect('signP2mrMessage' in wallet).toBe(false)
    expect('verifyP2mrMessage' in wallet).toBe(false)
  })

  it('detects only the complete canonical window.qbit provider', async () => {
    ;(globalThis as any).window.qbit = createProvider()
    const wallet = new QbitWallet()

    await wallet.init()

    expect(wallet.installed).toBe(true)
  })

  it('does not trust the removed alias or fall back after window.qbit spoofing', async () => {
    vi.useFakeTimers()
    const aliasProvider = createProvider()
    ;(globalThis as any).window.qbit = { requestAccounts: vi.fn() }
    ;(globalThis as any).window.qbit_wallet = aliasProvider
    const wallet = new QbitWallet()

    const initializing = wallet.init()
    await vi.runAllTimersAsync()
    await initializing

    expect(wallet.installed).toBe(false)
    expect(aliasProvider.requestAccounts).not.toHaveBeenCalled()
  })

  describe('connecting a dapp set up for another chain', () => {
    const ADDRESSES: Record<string, string> = {
      [ChainType.QBIT_MAINNET]: 'qb1zaccount',
      [ChainType.QBIT_TESTNET4]: 'tq1zaccount',
      [ChainType.QBIT_REGTEST]: 'qbrt1zaccount',
    }

    // The wallet's side, as the provider exposes it: requestAccounts grants
    // the origin on the active chain, switchChain needs that grant (4100
    // without it) and moves it to the new chain.
    function createWalletProvider(activeChain: ChainType) {
      const calls: string[] = []
      const wallet = { chain: activeChain, grant: undefined as ChainType | undefined }
      const provider = createProvider({
        requestAccounts: vi.fn(async () => {
          calls.push('requestAccounts')
          wallet.grant = wallet.chain
          return [ADDRESSES[wallet.chain]]
        }),
        getAccounts: vi.fn(async () =>
          wallet.grant === wallet.chain ? [ADDRESSES[wallet.chain]] : []
        ),
        getChain: vi.fn(async () => wallet.chain),
        getPublicKey: vi.fn(async () => `pubkey-${wallet.chain}`),
        switchChain: vi.fn(async (chain: ChainType) => {
          calls.push(`switchChain ${chain}`)
          if (wallet.grant !== wallet.chain) {
            throw { code: 4100, message: 'Origin is not connected to the active Qbit chain' }
          }
          wallet.chain = chain
          wallet.grant = chain
        }),
      })
      ;(globalThis as any).window.qbit = provider
      return { provider, calls, wallet }
    }

    function createConnectingWallet(chain: ChainType) {
      const wallet = new QbitWallet()
      wallet.installed = true
      wallet.setChainType(chain)
      return wallet
    }

    it('connects first and then switches to the configured chain', async () => {
      const { calls } = createWalletProvider(ChainType.QBIT_TESTNET4)

      await expect(
        createConnectingWallet(ChainType.QBIT_MAINNET).requestAccount()
      ).resolves.toEqual({
        address: 'qb1zaccount',
        pubKey: `pubkey-${ChainType.QBIT_MAINNET}`,
      })
      expect(calls).toEqual(['requestAccounts', `switchChain ${ChainType.QBIT_MAINNET}`])
    })

    it('does not switch when the wallet is already on the configured chain', async () => {
      const { provider, calls } = createWalletProvider(ChainType.QBIT_MAINNET)

      await expect(
        createConnectingWallet(ChainType.QBIT_MAINNET).requestAccount()
      ).resolves.toEqual({
        address: 'qb1zaccount',
        pubKey: `pubkey-${ChainType.QBIT_MAINNET}`,
      })
      expect(calls).toEqual(['requestAccounts'])
      expect(provider.switchChain).not.toHaveBeenCalled()
    })

    it('connects again and retries once when switchChain answers 4100', async () => {
      const { provider, calls, wallet } = createWalletProvider(ChainType.QBIT_TESTNET4)
      // The wallet moves to regtest between the grant and the switch, so the
      // grant no longer covers the active chain.
      const requestAccounts = provider.requestAccounts.getMockImplementation()!
      provider.requestAccounts.mockImplementationOnce(async () => {
        const accounts = await requestAccounts()
        wallet.chain = ChainType.QBIT_REGTEST
        return accounts
      })

      await expect(
        createConnectingWallet(ChainType.QBIT_MAINNET).requestAccount()
      ).resolves.toEqual({
        address: 'qb1zaccount',
        pubKey: `pubkey-${ChainType.QBIT_MAINNET}`,
      })
      expect(calls).toEqual([
        'requestAccounts',
        `switchChain ${ChainType.QBIT_MAINNET}`,
        'requestAccounts',
        `switchChain ${ChainType.QBIT_MAINNET}`,
      ])
    })

    it('passes on any other switch error without connecting again', async () => {
      const { provider, calls } = createWalletProvider(ChainType.QBIT_TESTNET4)
      provider.switchChain.mockRejectedValueOnce({
        code: 4001,
        message: 'User rejected the request',
      })

      await expect(
        createConnectingWallet(ChainType.QBIT_MAINNET).requestAccount()
      ).rejects.toMatchObject({
        code: 4001,
      })
      expect(calls).toEqual(['requestAccounts'])
      expect(provider.requestAccounts).toHaveBeenCalledOnce()
    })

    it('returns no account when the wallet left the configured chain after the switch', async () => {
      const { provider, wallet } = createWalletProvider(ChainType.QBIT_TESTNET4)
      const switchChain = provider.switchChain.getMockImplementation()!
      provider.switchChain.mockImplementationOnce(async (chain: ChainType) => {
        await switchChain(chain)
        wallet.chain = ChainType.QBIT_REGTEST
      })

      await expect(
        createConnectingWallet(ChainType.QBIT_MAINNET).requestAccount()
      ).resolves.toBeUndefined()
    })
  })

  it('returns an already connected account on the active chain', async () => {
    const provider = createProvider()
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()
    wallet.installed = true

    await expect(wallet.getAccount()).resolves.toEqual({
      address: 'qb1zaccount',
      pubKey: 'pubkey',
    })
  })

  it('binds single and batch PSBT options to the selected chain', async () => {
    const provider = createProvider()
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()
    wallet.setChainType(ChainType.QBIT_MAINNET)

    await expect(wallet.signPsbt('psbt-hex')).resolves.toBe('signed-psbt')
    expect(provider.signPsbt).toHaveBeenCalledWith('psbt-hex', {
      chain: ChainType.QBIT_MAINNET,
      autoFinalized: false,
    })

    await wallet.signPsbts([{ psbt: 'one' }, { psbt: 'two' }])
    expect(provider.signPsbts).toHaveBeenCalledWith(
      ['one', 'two'],
      [
        { chain: ChainType.QBIT_MAINNET, autoFinalized: false },
        { chain: ChainType.QBIT_MAINNET, autoFinalized: false },
      ]
    )
  })

  it('waits for a chain switch before canonical message signing', async () => {
    let completeSwitch: (() => void) | undefined
    let observeSwitch!: () => void
    const switchStarted = new Promise<void>(resolve => {
      observeSwitch = resolve
    })
    const provider = createProvider({
      getChain: vi.fn().mockResolvedValue(ChainType.QBIT_TESTNET4),
      switchChain: vi.fn(() => {
        observeSwitch()
        return new Promise<void>(resolve => {
          completeSwitch = resolve
        })
      }),
    })
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()
    wallet.setChainType(ChainType.QBIT_MAINNET)

    const signing = wallet.signMessage('hello')
    await switchStarted
    expect(provider.signMessage).not.toHaveBeenCalled()
    completeSwitch?.()

    await expect(signing).resolves.toBe(PROOF)
    expect(provider.signMessage).toHaveBeenCalledWith('hello')
  })

  it('rejects a non-P2MR message result', async () => {
    const provider = createProvider({ signMessage: vi.fn().mockResolvedValue('not-a-proof') })
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()

    await expect(wallet.signMessage('hello')).rejects.toThrow(
      'Wallet returned an invalid P2MR message proof'
    )
  })

  it('forwards standalone verification without a connection or chain switch', async () => {
    const provider = createProvider()
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()

    await expect(wallet.verifyMessage('qb1zaccount', 'hello', PROOF)).resolves.toBe(true)
    expect(provider.verifyMessage).toHaveBeenCalledWith('qb1zaccount', 'hello', PROOF)
    expect(provider.getChain).not.toHaveBeenCalled()
  })

  it('subscribes to and removes all four canonical events', () => {
    const provider = createProvider()
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()
    const listeners = {
      onAccountChange: vi.fn(),
      onNetworkChange: vi.fn(),
      onChainChange: vi.fn(),
      onDisconnect: vi.fn(),
    }

    wallet.addListener(listeners)
    wallet.removeListener(listeners)

    expect(provider.on.mock.calls.map(([event]) => event)).toEqual([
      'accountsChanged',
      'networkChanged',
      'chainChanged',
      'disconnect',
    ])
    expect(provider.removeListener.mock.calls.map(([event]) => event)).toEqual([
      'accountsChanged',
      'networkChanged',
      'chainChanged',
      'disconnect',
    ])
  })

  it('passes an empty account list to the listener without revoking the grant', async () => {
    const provider = createProvider()
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()
    const onAccountChange = vi.fn()

    wallet.addListener({ onAccountChange, onNetworkChange: vi.fn() })
    const [, accountsChanged] = provider.on.mock.calls.find(
      ([event]) => event === 'accountsChanged'
    )!
    await accountsChanged([])

    expect(onAccountChange).toHaveBeenCalledWith([])
    expect(provider.disconnect).not.toHaveBeenCalled()
  })

  it('awaits provider permission revocation', async () => {
    let finishDisconnect: (() => void) | undefined
    const provider = createProvider({
      disconnect: vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishDisconnect = resolve
          })
      ),
    })
    ;(globalThis as any).window.qbit = provider
    const wallet = new QbitWallet()

    const disconnecting = wallet.disconnect()
    expect(provider.disconnect).toHaveBeenCalledTimes(1)
    finishDisconnect?.()
    await expect(disconnecting).resolves.toBeUndefined()
  })

  it('reports canonical methods as unavailable when no valid provider exists', async () => {
    const wallet = new QbitWallet()

    await expect(wallet.signMessage('hello')).rejects.toThrow('Wallet not connected')
    await expect(wallet.verifyMessage('qb1zaccount', 'hello', PROOF)).rejects.toThrow(
      'Wallet not connected'
    )
    await expect(wallet.disconnect()).rejects.toThrow('Wallet not connected')
  })
})
