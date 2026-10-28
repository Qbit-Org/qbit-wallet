import { afterEach, describe, expect, it, vi } from 'vitest'

import { WalletProvider } from '../src/WalletProvider'
import { ChainType, WalletType } from '@qbit/wallet-connect'
import type { BaseWallet, WalletListenerParams } from '@qbit/wallet-connect'

const hookState = {
  effects: [] as Array<() => void | (() => void)>,
  states: [] as unknown[],
  stateSetters: [] as Array<(value: unknown) => void>,
  stateIndex: 0,
  contextValue: undefined as Record<string, any> | undefined,
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useMemo: (factory: () => unknown) => {
      const value = factory()
      if (
        value &&
        typeof value === 'object' &&
        'supportedWallets' in value &&
        'signMessage' in value
      ) {
        hookState.contextValue = value as Record<string, any>
      }
      return value
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      hookState.effects.push(effect)
    },
    useState: (initialValue?: unknown) => {
      const index = hookState.stateIndex
      hookState.stateIndex += 1

      if (hookState.states.length <= index) {
        hookState.states[index] = initialValue
      }

      const setter = (value: unknown) => {
        hookState.states[index] = value
      }
      hookState.stateSetters[index] = setter

      return [hookState.states[index], setter]
    },
  }
})

function resetHooks() {
  hookState.effects = []
  hookState.states = []
  hookState.stateSetters = []
  hookState.stateIndex = 0
  hookState.contextValue = undefined
}

function createWallet() {
  let listener: WalletListenerParams | undefined
  const wallet = {
    installed: true,
    config: {
      name: 'Test Wallet',
      icon: '',
      type: WalletType.Qbit,
      supportChain: [ChainType.QBIT_MAINNET],
    },
    init: vi.fn().mockResolvedValue(undefined),
    setChainType: vi.fn(),
    setTranslator: vi.fn(),
    setNotifier: vi.fn(),
    requestAccount: vi.fn(),
    getAccount: vi.fn().mockResolvedValue({
      address: 'bc1qaccount',
      pubKey: 'pubkey',
    }),
    addListener: vi.fn((params: WalletListenerParams) => {
      listener = params
    }),
    removeListener: vi.fn(),
    getBalance: vi.fn(),
    signPsbt: vi.fn(),
    signPsbts: vi.fn(),
    signMessage: vi.fn(),
    verifyMessage: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as BaseWallet

  return {
    wallet,
    getListener: () => listener,
  }
}

async function renderConnectedProvider(options: {
  disconnectOnNetworkChange?: boolean
  wallet: BaseWallet
}) {
  resetHooks()

  WalletProvider({
    chainType: ChainType.QBIT_MAINNET,
    wallets: [options.wallet],
    disconnectOnNetworkChange: options.disconnectOnNetworkChange,
    validateAddress: () => true,
    children: null,
  })

  hookState.stateSetters[0]?.(options.wallet)
  hookState.stateIndex = 0
  hookState.effects = []

  WalletProvider({
    chainType: ChainType.QBIT_MAINNET,
    wallets: [options.wallet],
    disconnectOnNetworkChange: options.disconnectOnNetworkChange,
    validateAddress: () => true,
    children: null,
  })

  hookState.effects.forEach(effect => effect())
  return hookState.contextValue
}

describe('WalletProvider network change handling', () => {
  afterEach(() => {
    resetHooks()
    vi.clearAllMocks()
  })

  it('keeps the wallet connected on network change by default', async () => {
    const { wallet, getListener } = createWallet()

    await renderConnectedProvider({ wallet })

    await getListener()?.onNetworkChange()

    expect(wallet.disconnect).not.toHaveBeenCalled()
  })

  it('disconnects on network change when explicitly enabled', async () => {
    const { wallet, getListener } = createWallet()

    await renderConnectedProvider({ wallet, disconnectOnNetworkChange: true })

    await getListener()?.onNetworkChange()

    expect(wallet.disconnect).toHaveBeenCalledTimes(1)
  })

  it('keeps the wallet connected when account is temporarily unavailable during change events', async () => {
    const { wallet, getListener } = createWallet()
    vi.mocked(wallet.getAccount).mockResolvedValue(undefined)

    await renderConnectedProvider({ wallet })

    await getListener()?.onAccountChange()

    expect(wallet.disconnect).not.toHaveBeenCalled()
  })

  it('disconnects when accountsChanged explicitly reports no accounts', async () => {
    const { wallet, getListener } = createWallet()

    await renderConnectedProvider({ wallet })

    await getListener()?.onAccountChange([])

    expect(wallet.disconnect).toHaveBeenCalledTimes(1)
  })

  it('exposes only canonical P2MR signing and verification through context', async () => {
    const { wallet } = createWallet()
    const proof = { type: 'p2mr-message' } as any
    vi.mocked(wallet.signMessage).mockResolvedValue(proof)
    vi.mocked(wallet.verifyMessage).mockResolvedValue(true)

    const context = await renderConnectedProvider({ wallet })

    await expect(context?.signMessage('hello')).resolves.toBe(proof)
    await expect(context?.verifyMessage('qbit-address', 'hello', proof)).resolves.toBe(true)
    expect(wallet.signMessage).toHaveBeenCalledWith('hello')
    expect(wallet.verifyMessage).toHaveBeenCalledWith('qbit-address', 'hello', proof)
    expect(context).not.toHaveProperty('signP2mrMessage')
    expect(context).not.toHaveProperty('verifyP2mrMessage')
  })

  it('does not accept caller-selected PSBT signing inputs', async () => {
    const { wallet } = createWallet()
    vi.mocked(wallet.signPsbt).mockResolvedValue('signed')
    vi.mocked(wallet.signPsbts).mockResolvedValue(['signed-a', 'signed-b'])

    const context = await renderConnectedProvider({ wallet })

    await expect(context?.signPsbt('psbt-a')).resolves.toBe('signed')
    await expect(context?.signPsbts([{ psbt: 'psbt-a' }, { psbt: 'psbt-b' }])).resolves.toEqual([
      'signed-a',
      'signed-b',
    ])
    expect(wallet.signPsbt).toHaveBeenCalledWith('psbt-a')
    expect(wallet.signPsbts).toHaveBeenCalledWith([{ psbt: 'psbt-a' }, { psbt: 'psbt-b' }])
  })
})
