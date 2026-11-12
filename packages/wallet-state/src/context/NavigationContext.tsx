import {
  Account,
  QbitBroadcastFailure,
  QbitRetainedBroadcast,
  QbitSendPlanReview,
  ToSignData,
  WalletKeyring,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import React, { useContext } from 'react'

import type { QbitSendPlanRevised } from '../utils/qbit-send-plan'

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
  MineTabScreen: undefined
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

  ExportMnemonicsScreen: { keyring: WalletKeyring }
  ExportPrivateKeyScreen: {
    account: Account
  }
  ReceiveScreen: undefined
  HistoryScreen: undefined
  KeyringOrAccountScreen: undefined
  AddKeyringScreen: undefined
  ImportHDWalletScreen: {
    comeFrom?: string
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

  ScanScreen: {
    from?: string
  }

  // Transactions
  TxCreateScreen: undefined
  QbitConsolidationScreen: {
    /**
     * The batch size to open at: the size of the batch that just went out
     * (`QbitConsolidationBatch.maxInputs`), so the next batch keeps it, or
     * the size the screen kept here for Back from the confirm screen. The
     * screen checks it against the account's maximum, since route state can
     * outlive an update or a change of the maximum, and opens at the
     * maximum when it is missing or out of range.
     */
    maxInputs?: number
    /**
     * The account `maxInputs` was chosen for, by network and address: the
     * screen opens at the maximum for any other. Without them, the size is
     * for the account the screen opens for.
     */
    chain?: ChainType
    address?: string
  }

  TxConfirmScreen: {
    toSignData: ToSignData
  }
  /**
   * The one review of a send plan (#188) before it is confirmed. Route state
   * outlives the draft it names and can come from an earlier version, so the
   * screen checks the review before showing or confirming it.
   */
  QbitSendPlanReviewScreen: {
    review: QbitSendPlanReview
    /** For a revision: the plan it revises, as the progress screen showed it. */
    revised?: QbitSendPlanRevised
  }
  /** The progress of the current account's open send plan, read from the background. */
  QbitSendPlanScreen: undefined
  TxSuccessScreen: {
    txid: string
    /** The transaction was a consolidation batch; the screen offers the next one. */
    consolidation?: boolean
    /** That batch's size, which the next batch is offered at; missing for a batch that recorded none. */
    consolidationMaxInputs?: number
    /** The payment of this completed send plan: leaving the screen removes the plan from the home screen. */
    sendPlanId?: string
  }
  TxFailScreen: {
    result: QbitBroadcastFailure
    /**
     * Exact signed payload kept in memory for a byte-identical retry. Route
     * state is the only place it lives; it must never reach Redux or storage.
     */
    retained?: QbitRetainedBroadcast
    /**
     * The transaction is a consolidation batch: a retry or status check that
     * ends on the success screen hands this and `consolidationMaxInputs` on
     * to it, as `TxSuccessScreen` takes them.
     */
    consolidation?: boolean
    /** That batch's size; missing for a batch that recorded none. */
    consolidationMaxInputs?: number
  }
}

export type RouteTypes = keyof RouteParamList

// A route whose params are all optional opens without any, as with an empty
// object: its screen reads missing route state as `{}`.
type NavigateArgs<T extends RouteTypes> = RouteParamList[T] extends undefined
  ? [screenName: T]
  : Partial<RouteParamList[T]> extends RouteParamList[T]
    ? [screenName: T, params?: RouteParamList[T]]
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
