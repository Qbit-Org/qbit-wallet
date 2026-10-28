import React, { type ReactNode } from 'react'
import { configureStore } from '@reduxjs/toolkit'
import { vi } from 'vitest'
import { Provider } from 'react-redux'
import { KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import accounts from '../../src/reducers/accounts'
import global from '../../src/reducers/global'
import keyrings from '../../src/reducers/keyrings'
import settings from '../../src/reducers/settings'
import transactions from '../../src/reducers/transactions'
import ui from '../../src/reducers/ui'
import { accountActions } from '../../src/reducers/accounts'
import { keyringsActions } from '../../src/reducers/keyrings'
import { ApprovalContext } from '../../src/context/ApprovalContext'
import { NavigationContext, type NavigationContextType } from '../../src/context/NavigationContext'
import { ToolsContext, type ToolsContextType } from '../../src/context/ToolsContext'
import { WalletProvider } from '../../src/context/WalletContext'

export function createTestStore() {
  const store = configureStore({
    reducer: {
      accounts,
      transactions,
      settings,
      global,
      keyrings,
      ui,
    },
  })

  const currentAccount = {
    type: KeyringType.HdKeyring,
    address: 'qb1ztestaccount',
    brandName: 'Qbit',
    alianName: 'Account 1',
    displayBrandName: 'Qbit',
    index: 0,
    balance: 0,
    pubkey: '02abc123',
    key: 'account-1',
    flag: 0,
  }

  store.dispatch(accountActions.setCurrent(currentAccount))
  store.dispatch(
    keyringsActions.setCurrent({
      key: 'keyring-1',
      index: 0,
      type: KeyringType.HdKeyring,
      addressType: AddressType.P2TR,
      accounts: [currentAccount],
      alianName: 'HD Wallet #1',
      hdPath: '',
    })
  )

  return store
}

export function createWalletMock() {
  const feeSummary = {
    list: [
      { title: 'slow', desc: 'slow', feeRate: 1 },
      { title: 'avg', desc: 'avg', feeRate: 5 },
      { title: 'fast', desc: 'fast', feeRate: 10 },
    ],
  }

  return {
    getEnableRBF: vi.fn().mockResolvedValue(false),
    setEnableRBF: vi.fn().mockResolvedValue(undefined),
    getQbitUtxos: vi.fn().mockResolvedValue([]),
    getQbitUtxoSnapshot: vi.fn().mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos: [] }),
    getFeeSummary: vi.fn().mockResolvedValue(feeSummary),
    getLowFeeSummary: vi.fn().mockResolvedValue(feeSummary),
    getAcceptLowFeeMode: vi.fn().mockResolvedValue(true),
    createSendAllQbitPsbt: vi.fn(),
    createSendQbitPsbt: vi.fn(),
    createSendQbitOffsetPsbt: vi.fn(),
  }
}

export function createToolsMock(): ToolsContextType {
  return {
    toast: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastWarning: vi.fn(),
    showLoading: vi.fn(),
    showTip: vi.fn(),
    copyToClipboard: vi.fn(),
    openUrl: vi.fn(),
  }
}

export function createNavigationMock(routeState: any = {}): NavigationContextType {
  return {
    navigate: vi.fn(),
    replace: vi.fn(),
    poptotop: vi.fn(),
    goBack: vi.fn(),
    navToTab: vi.fn(),
    navToTest: vi.fn(),
    navToLock: vi.fn(),
    navToWelcome: vi.fn(),
    getRouteState: vi.fn(() => routeState) as any,
    navToUtxoTools: vi.fn(),
    navToUrl: vi.fn(),
    navToExplorerTx: vi.fn(),
    navToExplorerAddress: vi.fn(),
    navToMarketPlace: vi.fn(),
    openExtensionInTab: vi.fn(),
    navToRootHome: vi.fn(),
  }
}

export function createHookTestHarness({
  wallet = createWalletMock(),
  routeState = {},
  navigation = createNavigationMock(routeState),
  tools = createToolsMock(),
}: {
  wallet?: ReturnType<typeof createWalletMock>
  routeState?: any
  navigation?: NavigationContextType
  tools?: ToolsContextType
} = {}) {
  const store = createTestStore()
  const approval = {
    getApproval: vi.fn().mockResolvedValue(undefined),
    resolveApproval: vi.fn().mockResolvedValue(undefined),
    rejectApproval: vi.fn().mockResolvedValue(undefined),
  }

  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(
      Provider,
      { store },
      React.createElement(
        WalletProvider,
        { wallet: wallet as any },
        React.createElement(
          NavigationContext.Provider,
          { value: navigation },
          React.createElement(
            ToolsContext.Provider,
            { value: tools },
            React.createElement(ApprovalContext.Provider, { value: approval }, children)
          )
        )
      )
    )

  return { store, wrapper, wallet, navigation, tools, approval }
}
