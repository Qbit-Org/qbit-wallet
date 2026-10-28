import React, { ReactNode, useContext } from 'react'

import {
  Account,
  AddressFlagType,
  AddressSummary,
  Announcement,
  BiometricUnlockRecord,
  BiometricUnlockStatus,
  QbitBalance,
  QbitBalanceSummary,
  QbitBroadcastResult,
  QbitBroadcastStatusCheck,
  QbitConsolidationStatus,
  ConnectedSite,
  DecodedPsbt,
  DeriveAccountResult,
  DummyTxType,
  FeeSummary,
  LocalPsbtSummary,
  QbitFeeBumpEligibility,
  QbitRecoveryState,
  QbitRemoveKeyringOptions,
  QbitRestoreFloorScanSummary,
  QbitReceiveState,
  QbitRestoreReport,
  QbitSendBroadcastClaim,
  RateUsStatus,
  RegtestAccessStatus,
  SignPsbtOptions,
  SignedData,
  SignedMessage,
  StoredNotification,
  ToSignData,
  ToSignInput,
  ToSignMessage,
  ThemeMode,
  TxHistoryItem,
  UTXO,
  UTXO_Detail,
  QbitUtxoSnapshot,
  UnspentOutput,
  VersionDetail,
  WalletConfig,
  WalletKeyring,
  WebsiteSafetyResult,
} from '@qbit/wallet-shared'
import { AddressType, ChainType, NetworkType } from '@qbit/wallet-types'
import type { PendingApproval } from './ApprovalContext'

interface ContactBookItem {
  name: string
  address: string
  chain: ChainType
  isAlias: boolean
  isContact: boolean
  sortIndex?: number
}
type ContactBookStore = Record<string, ContactBookItem | undefined>

export type QbitDescriptorNetworkName = 'mainnet' | 'testnet4' | 'signet' | 'regtest'

export interface QbitP2mrDescriptorInfo {
  branch: 'external' | 'internal'
  change: 0 | 1
  path: string
  descriptor: string
  descriptorNoChecksum: string
}

export interface QbitP2mrDescriptorExport {
  network: QbitDescriptorNetworkName
  coinType: 0 | 1
  containsPrivateKeys: true
  external: QbitP2mrDescriptorInfo
  internal: QbitP2mrDescriptorInfo
  hkdf: {
    account: 0
    change: 0
  }
  coreProvenance: {
    repository: string
    commit: string
    source: string
  }
}

export interface WalletController {
  openapi: {
    [key: string]: (...params: any) => Promise<any>
  }
  // for development use only
  requestMethod: (...params: any) => Promise<any>

  setBackgroundInited(value: boolean): Promise<void>
  getBackgroundInited(): Promise<boolean>

  getDesc: () => string
  boot(password: string): Promise<void>
  isBooted(): Promise<boolean>

  /** The pending approval with the id that settles it, or undefined. */
  getApproval(): Promise<PendingApproval | undefined>
  /**
   * Settle the pending approval only while `approvalId` is its id; resolves
   * false, changing nothing, once another approval or none is pending.
   */
  resolveApproval(approvalId: string, data?: any, forceReject?: boolean): Promise<boolean>
  rejectApproval(
    approvalId: string,
    reason?: string,
    stay?: boolean,
    isInternal?: boolean
  ): Promise<boolean>
  /** Resolves the pending approval only if it is the provider's unlock request. */
  resolveUnlockApproval(): Promise<boolean>

  hasVault(): Promise<boolean>

  verifyPassword(password: string): Promise<boolean>
  changePassword: (password: string, newPassword: string) => Promise<void>

  unlock(password: string): Promise<void>
  isUnlocked(): Promise<boolean>

  lockWallet(): Promise<void>
  setPopupOpen(isOpen: boolean): void
  isReady(): Promise<boolean>

  getIsFirstOpen(): Promise<boolean>
  updateIsFirstOpen(): Promise<void>

  getAddressBalanceV2(address: string): Promise<QbitBalanceSummary>
  getAddressBalance(address: string): Promise<QbitBalance>
  getAddressCacheBalance(address: string): Promise<QbitBalance>
  getMultiAddressSummaries(addresses: string): Promise<AddressSummary[]>
  findActiveAddressGroups(
    groups: { type: number; address_arr: string[]; pubkey_arr: string[] }[]
  ): Promise<
    { type: number; address_arr: string[]; pubkey_arr: string[]; satoshis_arr: number[] }[]
  >

  getAddressHistory: (params: {
    address: string
    start: number
    limit: number
    snapshotId?: string
    refreshSnapshotId?: string
  }) => Promise<{
    start: number
    total: number
    detail: TxHistoryItem[]
    snapshotId?: string
    scopeKey?: string
  }>
  getAddressCacheHistory: (address: string) => Promise<TxHistoryItem[]>
  getQbitTxLifecycleStatus(txid: string): Promise<{ state: 'confirmed' | 'pending' | 'gone' }>
  getQbitRawTransactionHex(txid: string): Promise<string>

  getLocale(): Promise<string>
  setLocale(locale: string): Promise<void>

  getCurrency(): Promise<string>
  setCurrency(currency: string): Promise<void>

  getPrivateKey(
    password: string,
    account: { address: string; type: string }
  ): Promise<{ hex: string; wif: string }>
  getMnemonics(
    password: string,
    keyring: WalletKeyring
  ): Promise<{
    hdPath: string
    mnemonic: string
    passphrase: string
  }>
  exportP2mrDescriptors(
    password: string,
    keyring?: WalletKeyring,
    network?: QbitDescriptorNetworkName
  ): Promise<QbitP2mrDescriptorExport>
  getPreMnemonics(): Promise<any>
  generatePreMnemonic(strength?: 128 | 256): Promise<string>
  removePreMnemonics(): void
  createKeyringWithMnemonics(
    mnemonic: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    accountCount: number,
    accountIndexDerivation?: boolean
  ): Promise<{ address: string; type: string }[]>
  createKeyringWithColdWallet(
    xpub: string,
    addressType: AddressType,
    alianName?: string,
    hdPath?: string,
    accountCount?: number
  ): Promise<WalletKeyring>

  deriveAccountsFromXpub(
    xpub: string,
    addressType: AddressType,
    hdPath?: string,
    accountCount?: number
  ): Promise<{ pubkey: string; address: string }[]>

  createTmpKeyringWithMnemonics(
    mnemonic: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    accountCount?: number,
    accountIndexDerivation?: boolean
  ): Promise<WalletKeyring>

  createTmpKeyringWithMnemonics2(
    mnemonic: string,
    passphrase: string,
    hdPaths: string[],
    addressTypes: AddressType[]
  ): Promise<WalletKeyring[]>

  restoreQbitKeyringWithFloors(
    mnemonic: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    options?: { gapLimit?: number; maxIndexes?: number }
  ): Promise<QbitRestoreReport>

  runQbitRestoreFloorScan(options?: { lookahead?: number }): Promise<QbitRestoreFloorScanSummary>

  getQbitRestoreFloorsPending(): Promise<boolean>

  getQbitConcurrentInstanceHint(): Promise<boolean>

  getQbitRecoveryState(keyringIndex?: number, anchorPubkey?: string): Promise<QbitRecoveryState>
  acknowledgeQbitRecoveryRisk(keyringIndex: number, anchorPubkey?: string): Promise<QbitRecoveryState>
  dismissQbitRecoveryWarning(keyringIndex: number, anchorPubkey?: string): Promise<QbitRecoveryState>
  confirmQbitRestoredFloorSigning(challengeId: string): Promise<void>
  releaseQbitRestoredFloorSigningChallenges(challengeIds: string[]): Promise<void>
  createQbitRecoveryMigrationWallet(data: {
    sourceKeyringIndex: number
    sourceAnchorPubkey?: string
    mnemonic: string
    hdPath: string
    passphrase: string
  }): Promise<QbitRecoveryState>
  beginQbitRecoveryMigrationToExistingDestination(data: {
    sourceKeyringIndex: number
    sourceAnchorPubkey?: string
  }): Promise<QbitRecoveryState>
  prepareQbitRecoveryMigration(
    sourceKeyringIndex: number,
    feeRate?: number,
    sourceAnchorPubkey?: string
  ): Promise<{ state: QbitRecoveryState; toSignDatas: ToSignData[] }>
  advanceQbitRecoveryMigration(
    sourceKeyringIndex: number,
    sourceAnchorPubkey?: string
  ): Promise<QbitRecoveryState>

  getQbitReceiveState(): Promise<QbitReceiveState>
  ensureQbitReceiveIntent(): Promise<QbitReceiveState>
  createQbitReceiveIntent(): Promise<QbitReceiveState>

  removeKeyring(keyring: WalletKeyring, options?: QbitRemoveKeyringOptions): Promise<WalletKeyring>
  deriveNewAccountFromMnemonic(
    keyring: WalletKeyring,
    alianName?: string
  ): Promise<DeriveAccountResult>
  getAccountsCount(): Promise<number>
  getAllAlianName: () => (ContactBookItem | undefined)[]
  getContactsByMap: () => ContactBookStore

  getCurrentAccount(): Promise<Account>
  getAccounts(): Promise<Account[]>
  getNextAlianName: (keyring: WalletKeyring) => Promise<string>

  getCurrentKeyringAccounts(): Promise<Account[]>

  signPsbtV2(toSignData: ToSignData): Promise<SignedData>
  /**
   * Reserve the inputs of a P2MR send the wallet built but an external or
   * cold-wallet signer signed, before its bytes reach the confirm screen.
   * Refuses bytes for any other transaction; resolves the signed result with
   * the identity and wallet-owned claim signPsbtV2 attaches to a local send.
   */
  reserveExternallySignedQbitSend(toSignData: ToSignData, signedTxData: string): Promise<SignedData>

  signMessage(params: ToSignMessage): Promise<SignedMessage>

  createSendQbitPsbt(data: {
    to: string
    amount: number
    qbitUtxos: UnspentOutput[]
    /** The network `qbitUtxos` were loaded on; the background refuses any other. */
    qbitUtxoChain: ChainType
    feeRate: number
    enableRBF?: boolean
    memo?: string
    memos?: string[]
  }): Promise<ToSignData>

  getQbitFeeBumpEligibility(txid: string): Promise<QbitFeeBumpEligibility>
  createBumpFeeQbitPsbt(data: { txid: string; feeRate?: number }): Promise<ToSignData>

  createSendAllQbitPsbt(data: {
    to: string
    qbitUtxos: UnspentOutput[]
    /** The network `qbitUtxos` were loaded on; the background refuses any other. */
    qbitUtxoChain: ChainType
    feeRate: number
    enableRBF?: boolean
    memo?: string
    memos?: string[]
  }): Promise<ToSignData>

  /** Where the current account stands against the explorer's listing limit. */
  getQbitConsolidationStatus(): Promise<QbitConsolidationStatus>
  /**
   * The next consolidation batch of an account over the explorer's listing
   * limit: its largest confirmed outputs, sent whole to its own address.
   */
  createQbitConsolidationPsbt(data: { feeRate?: number; enableRBF?: boolean }): Promise<ToSignData>

  pushTx(rawtx: string): Promise<string>
  broadcastQbitTx(
    txData: string,
    qbitSendBroadcastClaim?: QbitSendBroadcastClaim,
    expectedChain?: ChainType,
    expectedTxid?: string
  ): Promise<QbitBroadcastResult>
  checkQbitBroadcastStatus(
    txid: string,
    chain?: ChainType,
    qbitSendBroadcastClaim?: QbitSendBroadcastClaim
  ): Promise<QbitBroadcastStatusCheck>
  /**
   * Release the send claim behind a broadcast the user has abandoned. The
   * background releases nothing unless chain, address, origin, txid, and
   * inputs all identify an active claim; resolves false otherwise.
   */
  releaseQbitSendBroadcastClaim(qbitSendBroadcastClaim: QbitSendBroadcastClaim): Promise<boolean>

  getQbitUtxos(): Promise<UnspentOutput[]>
  /** The spendable outputs together with the network they were loaded on. */
  getQbitUtxoSnapshot(): Promise<QbitUtxoSnapshot>

  getNetworkType(): Promise<NetworkType>
  setNetworkType(type: NetworkType): Promise<void>

  getChainType(): Promise<ChainType>
  setChainType(type: ChainType): Promise<void>

  // Local regtest capability (background-owned). The UI only reads status,
  // records the acknowledgement after its own permission gesture, retries
  // verification, or disables; it never passes a "granted" flag.
  getRegtestAccessStatus(): Promise<RegtestAccessStatus>
  verifyRegtestAccess(): Promise<RegtestAccessStatus>
  acknowledgeRegtestAccess(): Promise<RegtestAccessStatus>
  disableRegtestAccess(): Promise<RegtestAccessStatus>

  getConnectedSites(): Promise<ConnectedSite[]>
  removeConnectedSite(origin: string): Promise<void>
  getCurrentConnectedSite(id: string): Promise<ConnectedSite>
  updateConnectSite(origin: string, data: Partial<ConnectedSite>): Promise<void>

  getCurrentKeyring(): Promise<WalletKeyring>
  getKeyrings(): Promise<WalletKeyring[]>
  getTotalKeyringCount(): Promise<number>
  changeKeyring(keyring: WalletKeyring, accountIndex?: number): Promise<void>
  getAllAddresses(keyring: WalletKeyring, index: number): Promise<string[]>

  setKeyringAlianName(keyring: WalletKeyring, name: string): Promise<WalletKeyring>
  changeAddressType(addressType: AddressType): Promise<void>

  setAccountAlianName(account: Account, name: string): Promise<Account>
  getFeeSummary(): Promise<FeeSummary>
  getLowFeeSummary(): Promise<FeeSummary>
  setEditingKeyring(keyringIndex: number): Promise<void>
  getEditingKeyring(): Promise<WalletKeyring>

  setEditingAccount(account: Account): Promise<void>
  getEditingAccount(): Promise<Account>

  decodePsbt(psbtHex: string, website: string): Promise<DecodedPsbt>
  analyzeLocalPsbts(toSignDatas: ToSignData[]): Promise<LocalPsbtSummary>

  expireUICachedData(address: string): Promise<void>

  getWalletConfig(): Promise<WalletConfig>

  getSkippedVersion(): Promise<string>
  setSkippedVersion(version: string): Promise<void>

  checkWebsite(website: string): Promise<WebsiteSafetyResult>

  formatOptionsToSignInputs(psbtHex: string, options?: SignPsbtOptions): Promise<ToSignInput[]>

  getAddressSummary(address: string): Promise<AddressSummary>

  getShowSafeNotice(): Promise<boolean>
  setShowSafeNotice(show: boolean): Promise<void>

  // address flag
  addAddressFlag(account: Account, flag: AddressFlagType): Promise<Account>
  removeAddressFlag(account: Account, flag: AddressFlagType): Promise<Account>

  getVersionDetail(version: string): Promise<VersionDetail>

  getEnableSignData(): Promise<boolean>
  setEnableSignData(enable: boolean): Promise<void>

  // Biometric (WebAuthn PRF) unlock
  getBiometricUnlockStatus(): Promise<BiometricUnlockStatus>
  saveBiometricUnlockRecord(record: BiometricUnlockRecord, password: string): Promise<void>
  getBiometricUnlockRecord(): Promise<BiometricUnlockRecord | null>
  clearBiometricUnlock(): Promise<void>

  setAutoLockTimeId(timeId: number): Promise<void>
  getAutoLockTimeId(): Promise<number>

  getDeveloperMode(): Promise<boolean>
  setDeveloperMode(developerMode: boolean): Promise<void>

  getThemeMode(): Promise<ThemeMode>
  setThemeMode(themeMode: ThemeMode): Promise<void>

  getBlockActiveInfo(): Promise<{ allTransactions: number; allAddrs: number }>

  getContactByAddress(address: string): Promise<ContactBookItem | undefined>
  getContactByAddressAndChain(
    address: string,
    chain: ChainType
  ): Promise<ContactBookItem | undefined>
  updateContact(data: ContactBookItem): Promise<void>
  removeContact(address: string, chain?: ChainType): Promise<void>
  listContacts(): Promise<ContactBookItem[]>
  saveContactsOrder(contacts: ContactBookItem[]): Promise<void>

  setLastActiveTime(): void

  getOpenInSidePanel(): Promise<boolean>
  setOpenInSidePanel(openInSidePanel: boolean): Promise<void>

  resetAllData(): Promise<void>

  getGuideReaded(): Promise<boolean>
  setGuideReaded(): Promise<void>

  getRateUsStatus(): Promise<RateUsStatus>

  setHasRated(hasRated: boolean): Promise<void>
  setRatePromptDismissedAt(timestamp: number | null): Promise<void>
  setHasShownSecondPrompt(hasShown: boolean): Promise<void>
  resetRateUsStatus(): Promise<void>
  getAnnouncements(
    cursor: number,
    size: number
  ): Promise<{
    hasMore: boolean
    list: Announcement[]
  }>

  getNotifications(): Promise<StoredNotification[]>
  readNotification(id: string): Promise<void>
  readAllNotifications(): Promise<void>
  deleteNotification(id: string): Promise<void>
  getNotificationUnreadCount(): Promise<number>

  getAcceptLowFeeMode(): Promise<boolean>
  setAcceptLowFeeMode(accept: boolean): Promise<void>
  getEnableRBF(): Promise<boolean>
  setEnableRBF(enableRBF: boolean): Promise<void>

  createTmpKeyringWithPublicKey(publicKey: string, addressType: AddressType): Promise<WalletKeyring>

  createKeyringWithPublicKey(data: string, addressType: AddressType): Promise<void>

  createTmpKeyringWithAddress(address: string): Promise<WalletKeyring>

  createKeyringWithAddress(address: string): Promise<void>

  createDummyPsbt(params: { txType: DummyTxType }): Promise<ToSignData>
}

const WalletContext = React.createContext<{
  wallet: WalletController
} | null>(null)

const WalletProvider = ({
  children,
  wallet,
}: {
  children?: ReactNode
  wallet: WalletController
}) => <WalletContext.Provider value={{ wallet }}>{children}</WalletContext.Provider>

const useWallet = () => {
  const { wallet } = useContext(WalletContext) as {
    wallet: WalletController
  }

  return wallet
}

export { WalletProvider, useWallet }
