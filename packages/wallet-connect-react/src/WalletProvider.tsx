'use client'

import type { BaseWallet, P2mrMessageProof } from '@qbit/wallet-connect'
import { isSupportedAddressType } from '@qbit/wallet-connect'
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ConnectedAccount,
  WalletContextType,
  WalletModalProps,
  WalletProviderConfig,
} from './types'

const DEFAULT_STORAGE_KEY = 'wallet_connected_type'

/**
 * Create wallet context with empty defaults
 */
const WalletContext = createContext<WalletContextType>({} as WalletContextType)

/**
 * Hook to access wallet context
 * Must be used within WalletProvider
 */
export function useWallet(): WalletContextType {
  const context = useContext(WalletContext)
  if (!context || Object.keys(context).length === 0) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}

/**
 * Default modal component (headless - just renders nothing)
 * Override with renderModal prop to provide custom UI
 */
function DefaultModal(_props: WalletModalProps): React.ReactNode {
  return null
}

/**
 * WalletProvider component
 * Manages wallet connection state and provides context to children
 */
export function WalletProvider({
  chainType,
  wallets,
  storageKey = DEFAULT_STORAGE_KEY,
  translator,
  notifier,
  onUserInitialize,
  onConnectError,
  onAccountChange,
  disconnectOnNetworkChange = false,
  validateAddress = isSupportedAddressType,
  disableAutoConnect = false,
  disableConnect = false,
  children,
  renderModal = DefaultModal,
}: WalletProviderConfig): React.ReactElement {
  // Initialize wallets with config
  const supportedWallets = useMemo(() => {
    wallets.forEach(w => {
      w.setChainType(chainType)
      if (translator) w.setTranslator(translator)
      if (notifier) w.setNotifier(notifier)
    })
    return wallets
  }, [wallets, chainType, translator, notifier])

  const [wallet, setWallet] = useState<BaseWallet>()
  const [account, setAccount] = useState<ConnectedAccount>()
  const [isInitialized, setIsInitialized] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [connectingWallet, setConnectingWallet] = useState<BaseWallet>()
  const [canceledConnect, setCanceledConnect] = useState(false)
  // Each wallet event supersedes any account refresh still in flight, so a
  // slow refresh for an older event cannot restore an account that a newer
  // event cleared. A ref, because listeners re-subscribe on every new callback.
  const latestWalletEvent = useRef(0)
  // Account refreshes and modal connects in flight; isConnecting clears when
  // the last of them settles.
  const connectionWorkInFlight = useRef(0)
  // The connected wallet, updated as soon as a connection is made or cleared.
  // Listeners stay attached until React re-runs the listener effect, and
  // events reaching them in that window, such as the account the wallet sends
  // after a network change, must not bring a cleared connection back.
  const activeWallet = useRef<BaseWallet>()

  /**
   * Clear connection state
   */
  const clearConnection = useCallback(() => {
    activeWallet.current = undefined
    latestWalletEvent.current += 1
    setAccount(undefined)
    setWallet(undefined)
    if (typeof window !== 'undefined') {
      localStorage.setItem(storageKey, '')
    }
  }, [storageKey])

  /**
   * Make `connected` the connected wallet. It supersedes any account refresh
   * started before this connection.
   */
  const commitConnection = useCallback(
    (connected: BaseWallet, connectedAccount: ConnectedAccount) => {
      activeWallet.current = connected
      latestWalletEvent.current += 1
      setAccount(connectedAccount)
      setWallet(connected)
    },
    []
  )

  /**
   * Disconnect from wallet
   */
  const disconnect = useCallback(async (): Promise<void> => {
    clearConnection()
    if (wallet) {
      await wallet.disconnect()
    }
  }, [clearConnection, wallet])

  const loadConnectedAccount = useCallback(
    async (connectedWallet: BaseWallet): Promise<ConnectedAccount | undefined> => {
      const acc = await connectedWallet.getAccount()
      if (!acc || !validateAddress(acc.address)) {
        return undefined
      }

      let extendedData: Record<string, unknown> = {}
      if (onUserInitialize) {
        extendedData = await onUserInitialize(acc)
      }

      return { ...acc, ...extendedData }
    },
    [validateAddress, onUserInitialize]
  )

  /**
   * Initialize wallets on mount
   */
  useEffect(() => {
    async function init() {
      if (typeof window === 'undefined') return

      const connectedWalletType = localStorage.getItem(storageKey)

      // Initialize all wallets
      await Promise.all(
        supportedWallets.map(async w => {
          await w.init()

          // Auto-reconnect if previously connected and not disabled
          if (!disableAutoConnect && connectedWalletType === w.config.type) {
            if (disableConnect) {
              clearConnection()
              return
            }

            try {
              const connectedAccount = await loadConnectedAccount(w)
              if (connectedAccount) {
                commitConnection(w, connectedAccount)
                onAccountChange?.(connectedAccount)
              } else {
                clearConnection()
              }
            } catch {
              clearConnection()
            }
          }
        })
      )

      setIsInitialized(true)
    }

    init()
  }, [
    supportedWallets,
    storageKey,
    disableAutoConnect,
    disableConnect,
    onAccountChange,
    clearConnection,
    commitConnection,
    loadConnectedAccount,
  ])

  /**
   * Set up wallet event listeners
   */
  useEffect(() => {
    if (!wallet) return

    // Wallet events never call disconnect(): that revokes the page's grant in
    // the wallet and is only for an explicit user action.
    const handleConnectionRefresh = async () => {
      const event = ++latestWalletEvent.current
      connectionWorkInFlight.current += 1
      setIsConnecting(true)

      try {
        const connectedAccount = await loadConnectedAccount(wallet)
        if (event !== latestWalletEvent.current || activeWallet.current !== wallet) return
        if (connectedAccount) {
          setAccount(connectedAccount)
          onAccountChange?.(connectedAccount)
        } else {
          // No account this page can use right now; keep listening for one.
          setAccount(undefined)
        }
      } catch {
        // Keep the current state while the account is temporarily unavailable.
      } finally {
        connectionWorkInFlight.current -= 1
        if (connectionWorkInFlight.current === 0) setIsConnecting(false)
      }
    }

    // An empty account list means this page can read no account right now,
    // for example while the wallet is on a chain it has no grant for. Keep
    // listening: the wallet sends the account again when it becomes readable.
    const handleAccountChange = async (accounts?: unknown) => {
      if (Array.isArray(accounts) && accounts.length === 0) {
        latestWalletEvent.current += 1
        setAccount(undefined)
        return
      }

      await handleConnectionRefresh()
    }

    const handleNetworkChange = async () => {
      if (disconnectOnNetworkChange) {
        clearConnection()
        return
      }

      await handleConnectionRefresh()
    }

    // The wallet revoked this page's grant.
    const handleDisconnect = () => {
      clearConnection()
    }

    // Events that reach these listeners after this wallet stopped being the
    // connected one are ignored.
    const whileConnected =
      <Args extends unknown[]>(handler: (...args: Args) => unknown) =>
      (...args: Args) =>
        activeWallet.current === wallet ? handler(...args) : undefined

    const listeners = {
      onAccountChange: whileConnected(handleAccountChange),
      onNetworkChange: whileConnected(handleNetworkChange),
      onDisconnect: whileConnected(handleDisconnect),
    }
    wallet.addListener(listeners)

    return () => {
      wallet.removeListener(listeners)
    }
  }, [wallet, disconnectOnNetworkChange, loadConnectedAccount, onAccountChange, clearConnection])

  /**
   * Handle wallet selection
   */
  const handleSelectWallet = useCallback(
    async (selectedWallet: BaseWallet) => {
      if (disableConnect) {
        onConnectError?.(new Error('Connection disabled'))
        return
      }

      connectionWorkInFlight.current += 1
      try {
        setConnectingWallet(selectedWallet)
        setIsConnecting(true)
        setCanceledConnect(false)

        const acc = await selectedWallet.requestAccount()
        if (acc && !canceledConnect) {
          if (!validateAddress(acc.address)) {
            onConnectError?.(new Error('Unsupported address type'))
            return
          }

          let extendedData: Record<string, unknown> = {}
          if (onUserInitialize) {
            extendedData = await onUserInitialize(acc)
          }

          const connectedAccount: ConnectedAccount = { ...acc, ...extendedData }
          commitConnection(selectedWallet, connectedAccount)

          if (typeof window !== 'undefined') {
            localStorage.setItem(storageKey, selectedWallet.config.type)
          }

          setIsModalVisible(false)
          onAccountChange?.(connectedAccount)
        }
      } catch (error) {
        onConnectError?.(error)
      } finally {
        setConnectingWallet(undefined)
        connectionWorkInFlight.current -= 1
        if (connectionWorkInFlight.current === 0) setIsConnecting(false)
      }
    },
    [
      disableConnect,
      canceledConnect,
      validateAddress,
      onUserInitialize,
      onConnectError,
      onAccountChange,
      storageKey,
      commitConnection,
    ]
  )

  /**
   * Sign single PSBT
   */
  const signPsbt = useCallback(
    async (psbt: string) => {
      if (!wallet) {
        throw new Error('Wallet not connected')
      }
      return wallet.signPsbt(psbt)
    },
    [wallet]
  )

  /**
   * Sign multiple PSBTs
   */
  const signPsbts = useCallback(
    async (params: { psbt: string }[]) => {
      if (!wallet) {
        throw new Error('Wallet not connected')
      }
      return wallet.signPsbts(params)
    },
    [wallet]
  )

  /**
   * Sign message
   */
  const signMessage = useCallback(
    async (message: string): Promise<P2mrMessageProof> => {
      if (!wallet) {
        throw new Error('Wallet not connected')
      }
      return wallet.signMessage(message)
    },
    [wallet]
  )

  const verifyMessage = useCallback(
    async (address: string, message: string, proof: P2mrMessageProof): Promise<boolean> => {
      if (!wallet) {
        throw new Error('Wallet not connected')
      }
      return wallet.verifyMessage(address, message, proof)
    },
    [wallet]
  )

  /**
   * Open connect modal
   */
  const connect = useCallback(() => {
    setIsModalVisible(true)
  }, [])

  /**
   * Cancel connection
   */
  const handleCancel = useCallback(() => {
    setCanceledConnect(true)
    setConnectingWallet(undefined)
  }, [])

  /**
   * Close modal
   */
  const handleCloseModal = useCallback(() => {
    setIsModalVisible(false)
    handleCancel()
  }, [handleCancel])

  const contextValue: WalletContextType = useMemo(
    () => ({
      account,
      wallet,
      isConnecting,
      isInitialized,
      connect,
      disconnect,
      signPsbt,
      signPsbts,
      signMessage,
      verifyMessage,
      supportedWallets,
    }),
    [
      account,
      wallet,
      isConnecting,
      isInitialized,
      connect,
      disconnect,
      signPsbt,
      signPsbts,
      signMessage,
      verifyMessage,
      supportedWallets,
    ]
  )

  const modalProps: WalletModalProps = {
    visible: isModalVisible,
    onClose: handleCloseModal,
    wallets: supportedWallets,
    connectingWallet,
    isInitialized,
    onSelectWallet: handleSelectWallet,
    onCancel: handleCancel,
  }

  return (
    <WalletContext.Provider value={contextValue}>
      {children}
      {renderModal(modalProps)}
    </WalletContext.Provider>
  )
}
