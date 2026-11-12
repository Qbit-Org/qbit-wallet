import React, { ReactNode, useContext } from 'react'

import {
  Account,
  AddressFlagType,
  AddressSummary,
  BiometricUnlockRecord,
  BiometricUnlockStatus,
  QbitBalance,
  QbitBalanceSummary,
  QbitBroadcastResult,
  QbitBroadcastStatusCheck,
  QbitConsolidationRequest,
  QbitConsolidationStatus,
  ConnectedSite,
  DecodedPsbt,
  DecodePsbtOptions,
  DeriveAccountResult,
  DummyTxType,
  FeeSummary,
  LocalPsbtBatchReview,
  LocalPsbtSummary,
  QbitFeeBumpEligibility,
  QbitRecoveryDeferredSource,
  QbitRecoveryState,
  QbitRemoveKeyringOptions,
  QbitResetWalletOptions,
  QbitSigningOptions,
  QbitRestoreFloorScanSummary,
  QbitReceiveState,
  QbitRestoreReport,
  QbitSendBroadcastClaim,
  QbitSendPlanPrepareParams,
  QbitSendPlanPrepareResult,
  QbitSendPlanStartResult,
  QbitSendPlanView,
  RateUsStatus,
  RegtestAccessStatus,
  SignPsbtOptions,
  SignedData,
  SignedMessage,
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
  WalletColorKey,
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
  // for development use only
  requestMethod: (...params: any) => Promise<any>

  setBackgroundInited(value: boolean): Promise<void>
  /** Whether background start-up is still running, has finished, or has stopped and why. */
  getBackgroundStartupStatus(): Promise<
    | { state: 'starting' }
    | { state: 'ready' }
    | { state: 'failed'; reason: 'stored-settings-unreadable' | 'unknown' }
  >

  getDesc: () => string
  /**
   * Sets the password when no wallet is set up yet. Rejects with
   * WALLET_RESET_INCOMPLETE, setting no password, when a reset that erased
   * the keys still owes the clearing of the rest and that fails again, and
   * with WALLET_RESET_OUTCOME_UNKNOWN after a reset of unknown outcome, until
   * the background starts again.
   */
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
  /**
   * Rejects with WALLET_RESET_OUTCOME_UNKNOWN after a reset of unknown
   * outcome, until the background starts again; the password stays as it is.
   */
  changePassword: (password: string, newPassword: string) => Promise<void>

  /**
   * Rejects with WALLET_LOCKED_DURING_UNLOCK when a lock comes in while it
   * runs, and with WALLET_RESET_OUTCOME_UNKNOWN, whatever the password, after
   * a reset of unknown outcome, until the background starts again.
   */
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
  ): Promise<{
    state: QbitRecoveryState
    toSignDatas: ToSignData[]
    deferredSources?: QbitRecoveryDeferredSource[]
  }>
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

  /** `options.progressId` asks for this signing's progress (QBIT_SIGNING_PROGRESS events). */
  signPsbtV2(toSignData: ToSignData, options?: QbitSigningOptions): Promise<SignedData>
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
    /** The account `qbitUtxos` were read for; the background refuses any but the selected one. */
    qbitUtxoAddress: string
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
    /** The account `qbitUtxos` were read for; the background refuses any but the selected one. */
    qbitUtxoAddress: string
    feeRate: number
    enableRBF?: boolean
    memo?: string
    memos?: string[]
  }): Promise<ToSignData>

  /** Where the current account stands against the explorer's listing limit. */
  getQbitConsolidationStatus(): Promise<QbitConsolidationStatus>
  /**
   * The next consolidation batch of an account over the explorer's listing
   * limit: its largest confirmed outputs, at most `maxInputs` of them (the
   * account's maximum when omitted), sent whole to its own address.
   */
  createQbitConsolidationPsbt(data: QbitConsolidationRequest): Promise<ToSignData>

  /**
   * Price a send plan for review: the merges and the payment of an amount
   * one transaction cannot carry (#188). An expected refusal is a result
   * with `ok: false`, never a rejection.
   */
  prepareQbitSendPlan(params: QbitSendPlanPrepareParams): Promise<QbitSendPlanPrepareResult>
  /** Confirm the reviewed draft: the background persists the plan and runs it. */
  startQbitSendPlan(draftId: string): Promise<QbitSendPlanStartResult>
  /** The current account's open plan on the active network, or null. */
  getQbitSendPlan(): Promise<QbitSendPlanView | null>
  /** Carry on with the plan as confirmed: sign what is left, or send again. */
  continueQbitSendPlan(planId: string): Promise<QbitSendPlanView>
  /** Cancel the plan; null once nothing of it is left to settle. */
  cancelQbitSendPlan(planId: string): Promise<QbitSendPlanView | null>
  /** Remove a finished plan from the home screen. */
  dismissQbitSendPlan(planId: string): Promise<void>

  pushTx(rawtx: string): Promise<string>
  broadcastQbitTx(
    txData: string,
    qbitSendBroadcastClaim?: QbitSendBroadcastClaim,
    expectedChain?: ChainType,
    expectedTxid?: string,
    retryOfUnknownOutcome?: boolean
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
  /**
   * Hand the send claim behind a broadcast left on an unknown outcome back
   * to the background, which keeps its inputs reserved as recently spent
   * until it learns whether the transaction reached the network.
   */
  abandonQbitSendBroadcastClaim(qbitSendBroadcastClaim: QbitSendBroadcastClaim): Promise<void>

  getQbitUtxos(): Promise<UnspentOutput[]>
  /**
   * The spendable outputs together with the network they were loaded on.
   * With `readId`, `abandonQbitUtxoSnapshot(readId)` stops waiting for it.
   */
  getQbitUtxoSnapshot(readId?: string): Promise<QbitUtxoSnapshot>
  /** Stop waiting for that read; a walk nothing waits for any more stops. */
  abandonQbitUtxoSnapshot(readId: string): Promise<void>

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
  changeKeyring(keyring: WalletKeyring, accountIndex?: number): Promise<void>
  getAllAddresses(keyring: WalletKeyring, index: number): Promise<string[]>

  setKeyringAlianName(keyring: WalletKeyring, name: string): Promise<WalletKeyring>
  /**
   * Set a wallet's color to a palette key (WALLET_COLOR_KEYS). Rejects a
   * color that is not a palette key and a wallet that is not in use, storing
   * nothing; resolves with the wallet, with the new color.
   */
  setKeyringColor(keyring: WalletKeyring, color: WalletColorKey): Promise<WalletKeyring>
  changeAddressType(addressType: AddressType): Promise<void>

  setAccountAlianName(account: Account, name: string): Promise<Account>
  getFeeSummary(): Promise<FeeSummary>
  getLowFeeSummary(): Promise<FeeSummary>
  setEditingKeyring(keyringIndex: number): Promise<void>
  getEditingKeyring(): Promise<WalletKeyring>

  setEditingAccount(account: Account): Promise<void>
  getEditingAccount(): Promise<Account>

  decodePsbt(psbtHex: string, website: string, options?: DecodePsbtOptions): Promise<DecodedPsbt>
  analyzeLocalPsbts(toSignDatas: ToSignData[]): Promise<LocalPsbtSummary>
  signLocalBatchPsbt(
    toSignData: ToSignData,
    review: LocalPsbtBatchReview,
    options?: QbitSigningOptions
  ): Promise<SignedData>

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

  // Biometric (WebAuthn PRF) unlock
  getBiometricUnlockStatus(): Promise<BiometricUnlockStatus>
  saveBiometricUnlockRecord(record: BiometricUnlockRecord, password: string): Promise<void>
  getBiometricUnlockRecord(): Promise<BiometricUnlockRecord | null>
  clearBiometricUnlock(): Promise<void>

  setAutoLockTimeId(timeId: number): Promise<void>
  getAutoLockTimeId(): Promise<number>
  getLockOnComputerLock(): Promise<boolean>
  setLockOnComputerLock(enabled: boolean): Promise<void>
  getLockOnWindowsClosed(): Promise<boolean>
  setLockOnWindowsClosed(enabled: boolean): Promise<void>

  getDeveloperMode(): Promise<boolean>
  setDeveloperMode(developerMode: boolean): Promise<void>

  getThemeMode(): Promise<ThemeMode>
  setThemeMode(themeMode: ThemeMode): Promise<void>

  getContactByAddress(address: string): Promise<ContactBookItem | undefined>
  getContactByAddressAndChain(
    address: string,
    chain: ChainType
  ): Promise<ContactBookItem | undefined>
  addContact(data: Omit<ContactBookItem, 'isAlias'> & { isAlias?: boolean }): Promise<void>
  updateContact(data: Omit<ContactBookItem, 'isAlias'> & { isAlias?: boolean }): Promise<void>
  removeContact(address: string, chain?: ChainType): Promise<void>
  replaceContact(
    address: string,
    chain: ChainType,
    data: Omit<ContactBookItem, 'isAlias'> & { isAlias?: boolean }
  ): Promise<void>
  listContacts(): Promise<ContactBookItem[]>
  saveContactsOrder(contacts: ContactBookItem[]): Promise<void>

  setLastActiveTime(): void

  getOpenInSidePanel(): Promise<boolean>
  setOpenInSidePanel(openInSidePanel: boolean): Promise<void>

  /**
   * Erases every wallet, the password and the stored wallet data, after the
   * background has checked `password`. Rejects with
   * QBIT_RECOVERY_REMOVAL_ACK_REQUIRED (reasons in `data.reasons`) until the
   * recovery risks are acknowledged in `options`, with
   * WALLET_RESET_NOT_LAST_WALLET when `options.lastWalletKey` no longer names
   * the last usable wallet, with WALLET_RESET_INCOMPLETE when the wallets are
   * gone but other stored data is still to be cleared, and with
   * WALLET_RESET_OUTCOME_UNKNOWN when storage failed while the keys were
   * being erased. Any other rejection from the background means nothing was
   * erased; a request that never reached it, or whose answer was lost, says
   * nothing either way. Every open wallet page is told of a reset with
   * BUS_METHODS.WALLET_RESET.
   */
  resetWallet(password: string, options?: QbitResetWalletOptions): Promise<void>

  /**
   * The identity of what is set up in this browser: an opaque random string
   * that stays the same through locks, unlocks, password changes, additions,
   * removals and background restarts, and is different after a reset. Null
   * while nothing is booted. Readable while locked. A page compares it after
   * its connection to the background comes back, to learn whether what it
   * shows is still what the background holds.
   */
  getWalletId(): Promise<string | null>

  getGuideReaded(): Promise<boolean>
  setGuideReaded(): Promise<void>

  getRateUsStatus(): Promise<RateUsStatus>

  setHasRated(hasRated: boolean): Promise<void>
  setRatePromptDismissedAt(timestamp: number | null): Promise<void>
  setHasShownSecondPrompt(hasShown: boolean): Promise<void>
  resetRateUsStatus(): Promise<void>

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
