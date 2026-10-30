import { afterEach, describe, expect, it, vi } from 'vitest'

import { WalletProvider } from '../src/WalletProvider'
import { ChainType, WalletType } from '@qbit/wallet-connect'
import type { BaseWallet, WalletListenerParams } from '@qbit/wallet-connect'
import type { WalletModalProps, WalletProviderConfig } from '../src/types'

const hookState = {
  effects: [] as Array<() => void | (() => void)>,
  states: [] as unknown[],
  stateSetters: [] as Array<(value: unknown) => void>,
  stateIndex: 0,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
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
    // Refs persist across renders, as in React.
    useRef: (initialValue?: unknown) => {
      const index = hookState.refIndex
      hookState.refIndex += 1
      hookState.refs[index] ??= { current: initialValue }
      return hookState.refs[index]
    },
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
  hookState.refs = []
  hookState.refIndex = 0
  hookState.contextValue = undefined
}

// WalletProvider's useState order: wallet, account, isInitialized, isConnecting.
function connectedWalletState() {
  return hookState.states[0]
}

function accountState() {
  return hookState.states[1]
}

function isConnectingState() {
  return hookState.states[3]
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
    requestAccount: vi.fn().mockResolvedValue({
      address: 'bc1qaccount',
      pubKey: 'pubkey',
    }),
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

// Renders the provider once, as React would on a state change. The hook
// indexes restart, and the effects it registers are collected but not run.
function renderProvider(props: Omit<WalletProviderConfig, 'chainType'> & { children: null }) {
  hookState.stateIndex = 0
  hookState.refIndex = 0
  hookState.effects = []
  WalletProvider({ chainType: ChainType.QBIT_MAINNET, ...props })
}

// WalletProvider's effects in order: the init effect, then the effect that
// attaches the wallet listeners.
function attachListeners(wallet: BaseWallet) {
  vi.mocked(wallet.addListener).mockClear()
  hookState.effects[1]!()
  expect(wallet.addListener).toHaveBeenCalledTimes(1)
}

// Renders the provider, connects the wallet through the modal, then renders
// again and attaches the wallet listeners.
async function renderConnectedProvider(options: {
  disconnectOnNetworkChange?: boolean
  wallet: BaseWallet
  renderModal?: (props: WalletModalProps) => null
}) {
  resetHooks()
  let modal: WalletModalProps | undefined
  const render = () =>
    renderProvider({
      wallets: [options.wallet],
      disconnectOnNetworkChange: options.disconnectOnNetworkChange,
      validateAddress: () => true,
      children: null,
      renderModal: props => {
        modal = props
        return options.renderModal?.(props) ?? null
      },
    })

  render()
  await modal?.onSelectWallet(options.wallet)
  render()
  attachListeners(options.wallet)
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

  it('clears only local state on network change when explicitly enabled', async () => {
    const { wallet, getListener } = createWallet()

    await renderConnectedProvider({ wallet, disconnectOnNetworkChange: true })

    await getListener()?.onNetworkChange()

    expect(connectedWalletState()).toBeUndefined()
    // Revoking the page's grant is the wallet's decision, not an event handler's.
    expect(wallet.disconnect).not.toHaveBeenCalled()
  })

  it('does not let the account sent after a network change restore a connection it cleared', async () => {
    const { wallet, getListener } = createWallet()

    await renderConnectedProvider({ wallet, disconnectOnNetworkChange: true })

    // The wallet sends the account after the network events, and it can reach
    // the old listeners before React removes them.
    await getListener()?.onNetworkChange('mainnet')
    await getListener()?.onAccountChange(['bc1qaccount'])

    expect(accountState()).toBeUndefined()
    expect(connectedWalletState()).toBeUndefined()
    expect(wallet.getAccount).not.toHaveBeenCalled()
  })

  it('listens again when the same wallet reconnects before the listeners are re-attached', async () => {
    const { wallet, getListener } = createWallet()
    let modal: WalletModalProps | undefined

    await renderConnectedProvider({
      wallet,
      renderModal: props => {
        modal = props
        return null
      },
    })

    // The clear and the reconnect can land in one React render, which leaves
    // the wallet state unchanged and the original listeners attached.
    getListener()?.onDisconnect?.({ code: 4900 })
    await modal?.onSelectWallet(wallet)
    vi.mocked(wallet.getAccount).mockResolvedValueOnce({
      address: 'bc1qnext',
      pubKey: 'pubkey',
    })
    await getListener()?.onAccountChange(['bc1qnext'])

    expect(accountState()).toEqual({ address: 'bc1qnext', pubKey: 'pubkey' })
  })

  it('listens to a wallet reconnected automatically when the page loads', async () => {
    const { wallet, getListener } = createWallet()
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => WalletType.Qbit, setItem: vi.fn() })
    try {
      resetHooks()
      const render = () =>
        renderProvider({ wallets: [wallet], validateAddress: () => true, children: null })

      // The first render runs init, which reconnects the stored wallet.
      render()
      hookState.effects.forEach(effect => effect())
      await vi.waitFor(() => expect(connectedWalletState()).toBe(wallet))
      // The wallet changed, so React re-runs only the listener effect.
      render()
      attachListeners(wallet)

      vi.mocked(wallet.getAccount).mockResolvedValueOnce({ address: 'bc1qnext', pubKey: 'pubkey' })
      await getListener()?.onAccountChange(['bc1qnext'])

      expect(accountState()).toEqual({ address: 'bc1qnext', pubKey: 'pubkey' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the wallet connected when account is temporarily unavailable during change events', async () => {
    const { wallet, getListener } = createWallet()
    vi.mocked(wallet.getAccount).mockResolvedValue(undefined)

    await renderConnectedProvider({ wallet })
    hookState.stateSetters[1]?.({ address: 'bc1qaccount', pubKey: 'pubkey' })

    await getListener()?.onAccountChange()

    // No usable account, for example on a chain this page is not set up for:
    // the account is cleared but the wallet stays connected and listening.
    expect(accountState()).toBeUndefined()
    expect(connectedWalletState()).toBe(wallet)
    expect(wallet.disconnect).not.toHaveBeenCalled()
  })

  it('clears the account but keeps listening when accountsChanged reports no accounts', async () => {
    const { wallet, getListener } = createWallet()

    await renderConnectedProvider({ wallet })
    hookState.stateSetters[1]?.({ address: 'bc1qaccount', pubKey: 'pubkey' })

    // Also sent when the wallet moves to a chain this page has no grant for.
    await getListener()?.onAccountChange([])

    expect(accountState()).toBeUndefined()
    expect(connectedWalletState()).toBe(wallet)
    expect(wallet.removeListener).not.toHaveBeenCalled()
    expect(wallet.disconnect).not.toHaveBeenCalled()

    // The wallet sends the account again once it is readable.
    await getListener()?.onAccountChange(['bc1qaccount'])

    expect(accountState()).toEqual({ address: 'bc1qaccount', pubKey: 'pubkey' })
  })

  it('clears the connection without revoking when the wallet reports a revocation', async () => {
    const { wallet, getListener } = createWallet()

    await renderConnectedProvider({ wallet })

    await getListener()?.onAccountChange([])
    getListener()?.onDisconnect?.({ code: 4900 })

    expect(connectedWalletState()).toBeUndefined()
    expect(wallet.disconnect).not.toHaveBeenCalled()

    // An event still reaching the old listeners does not reconnect the page.
    await getListener()?.onAccountChange(['bc1qaccount'])

    expect(accountState()).toBeUndefined()
    expect(wallet.getAccount).not.toHaveBeenCalled()
  })

  it('does not let an older refresh undo a connection made through the modal', async () => {
    const { wallet, getListener } = createWallet()
    let finishRefresh!: (account: undefined) => void
    vi.mocked(wallet.getAccount).mockReturnValueOnce(
      new Promise(resolve => {
        finishRefresh = resolve
      })
    )
    vi.mocked(wallet.requestAccount).mockResolvedValue({
      address: 'bc1qconnected',
      pubKey: 'pubkey',
    })
    let modal: WalletModalProps | undefined

    await renderConnectedProvider({
      wallet,
      renderModal: props => {
        modal = props
        return null
      },
    })

    const staleRefresh = getListener()?.onNetworkChange('mainnet')
    await modal?.onSelectWallet(wallet)
    expect(accountState()).toEqual({ address: 'bc1qconnected', pubKey: 'pubkey' })
    expect(isConnectingState()).toBe(true)
    finishRefresh(undefined)
    await staleRefresh

    expect(accountState()).toEqual({ address: 'bc1qconnected', pubKey: 'pubkey' })
    expect(isConnectingState()).toBe(false)
  })

  it('stays connecting until the last overlapping refresh settles', async () => {
    const { wallet, getListener } = createWallet()
    const finishers: Array<(account: { address: string; pubKey: string }) => void> = []
    vi.mocked(wallet.getAccount).mockImplementation(
      () =>
        new Promise(resolve => {
          finishers.push(resolve)
        })
    )

    await renderConnectedProvider({ wallet })

    const first = getListener()?.onNetworkChange('mainnet')
    const second = getListener()?.onAccountChange(['bc1qaccount'])
    finishers[0]!({ address: 'bc1qaccount', pubKey: 'pubkey' })
    await first
    expect(isConnectingState()).toBe(true)
    finishers[1]!({ address: 'bc1qaccount', pubKey: 'pubkey' })
    await second

    expect(isConnectingState()).toBe(false)
    expect(accountState()).toEqual({ address: 'bc1qaccount', pubKey: 'pubkey' })
  })

  it('does not let a refresh for an older event restore an account a newer event cleared', async () => {
    const { wallet, getListener } = createWallet()
    let finishRefresh!: (account: { address: string; pubKey: string }) => void
    vi.mocked(wallet.getAccount).mockReturnValueOnce(
      new Promise(resolve => {
        finishRefresh = resolve
      })
    )

    await renderConnectedProvider({ wallet })

    const staleRefresh = getListener()?.onNetworkChange('mainnet')
    expect(isConnectingState()).toBe(true)
    await getListener()?.onAccountChange([])
    finishRefresh({ address: 'bc1qstale', pubKey: 'pubkey' })
    await staleRefresh

    expect(accountState()).toBeUndefined()
    expect(isConnectingState()).toBe(false)
  })

  it('keeps the connection when refreshing the account fails', async () => {
    const { wallet, getListener } = createWallet()
    vi.mocked(wallet.getAccount).mockRejectedValue(new Error('wallet locked'))

    await renderConnectedProvider({ wallet })

    await getListener()?.onAccountChange(['bc1qaccount'])
    await getListener()?.onNetworkChange()

    expect(connectedWalletState()).toBe(wallet)
    expect(wallet.disconnect).not.toHaveBeenCalled()
  })

  it('revokes the grant when the page explicitly disconnects', async () => {
    const { wallet } = createWallet()

    const context = await renderConnectedProvider({ wallet })

    await context?.disconnect()

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
