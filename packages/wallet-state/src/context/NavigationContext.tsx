import {
  Account,
  QbitBroadcastFailure,
  QbitRetainedBroadcast,
  ToSignData,
  WalletKeyring,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import React, { useContext } from 'react'

export type RouteParamList = {
  WelcomeScreen: undefined
  UnlockScreen: {
    autoUnlockByFace: boolean
  }
  CreatePasswordScreen: {
    isNewAccount?: boolean
    fromColdWallet?: boolean
  }

  MainScreen: undefined

  // tabs
  WalletTabScreen: undefined
  AppTabScreen: undefined
  TabMainScreen: undefined
  DiscoverTabScreen: undefined
  SettingsTabScreen: undefined

  // WALLET
  CreateHDWalletScreen: {
    restoreTiTle?: boolean
    topTitle?: boolean
    finalButton?: string
    existingMnemonic?: string
    isBackupFlow?: boolean

    isImport?: boolean
    comeFrom?: string
    fromUnlock?: boolean
    goBack?: boolean
  }
  CreateWatchWalletScreen: undefined
  CreateReadonlyWalletScreen: undefined
  CreateColdWalletScreen: {
    fromUnlock?: boolean
  }

  EditWalletNameScreen: {
    keyring: WalletKeyring
  }
  ExportMnemonicsScreen: { keyring: WalletKeyring }
  ExportPrivateKeyScreen: {
    account: Account
  }
  SwitchAccountScreen: undefined
  ReceiveScreen: undefined
  HistoryScreen: undefined
  KeyringOrAccountScreen: undefined
  AddKeyringScreen: undefined
  ImportHDWalletScreen: {
    comeFrom?: string
  }
  CreateAccountScreen: {
    keyringKey?: string
  }
  EditAccountNameScreen: {
    account: Account
  }
  KeyringDetailScreen: {
    keyringKey?: string
  }

  // Settings
  ConnectedSitesScreen: undefined
  NetworkTypeScreen: undefined
  AddressTypeScreen: undefined
  AdvancedScreen: undefined
  ContactsScreen: {
    returnWithNetwork?: ChainType
    lastEditedContactAddress?: string
  }
  EditContactScreen: {
    address?: string
    chain?: string
    selectedNetworkFilter: string
  }
  AboutUsScreen: undefined
  LanguageScreen: undefined
  AppearanceScreen: undefined
  ChangePasswordScreen: undefined
  ModuleAssets: undefined
  NotificationListScreen: undefined

  ScanScreen: {
    from?: string
  }

  // Transactions
  TxCreateScreen: undefined
  QbitConsolidationScreen: undefined

  TxConfirmScreen: {
    toSignData: ToSignData
  }
  TxSuccessScreen: {
    txid: string
    /** The transaction was a consolidation batch; the screen offers the next one. */
    consolidation?: boolean
  }
  TxFailScreen: {
    result: QbitBroadcastFailure
    /**
     * Exact signed payload kept in memory for a byte-identical retry. Route
     * state is the only place it lives; it must never reach Redux or storage.
     */
    retained?: QbitRetainedBroadcast
  }
}

export type RouteTypes = keyof RouteParamList

type NavigateArgs<T extends RouteTypes> = RouteParamList[T] extends undefined
  ? [screenName: T]
  : [screenName: T, params: RouteParamList[T]]

export interface NavigationContextType {
  navigate<T extends RouteTypes>(...args: NavigateArgs<T>): void

  replace<T extends RouteTypes>(...args: NavigateArgs<T>): void

  poptotop: () => void
  goBack: () => void
  navToTab: () => void
  navToTest: () => void
  navToLock: (params?: any) => void
  navToWelcome: () => void

  getRouteState<T extends RouteTypes>(): RouteParamList[T]

  navToUtxoTools: () => void
  navToUrl: (url: string, externalBrowser?: boolean) => void

  navToExplorerTx: (txid: string) => void
  navToExplorerAddress: (address: string) => void

  navToMarketPlace: () => void

  openExtensionInTab?: () => void // in extension only
  navToRootHome: () => void // in extension only
}

const initContext = {
  navigate: () => {},
  poptotop: () => {},
  goBack: () => {},
  replace: () => {},
  navToTab: () => {},
  navToTest: () => {},
  navToLock: () => {},
  navToWelcome: () => {},

  getRouteState<T>(): T {
    // todo
    return undefined as T
  },

  navToUtxoTools: () => {},

  navToUrl: (url: string, externalBrowser?: boolean) => {},
  navToExplorerTx: (txid: string) => {},
  navToExplorerAddress: (address: string) => {},

  navToMarketPlace: () => {},

  // in extension only
  openExtensionInTab: () => {},
  navToRootHome: () => {},
}

export const NavigationContext = React.createContext<NavigationContextType>(initContext)

export function useNavigation() {
  const ctx = useContext(NavigationContext)
  return ctx
}
