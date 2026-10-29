import bitcore from 'bitcore-lib'

import { QbitApiError, type EsploraAddressStats, type EsploraTx } from '@qbit-oss/api'
import { getWebsiteSafetyWarning } from '@qbit/phishing-detect'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  QbitProtocolError,
  buildControlBlock,
  bytesToHex as qbitBytesToHex,
  createP2mrMessageProof,
  createP2mrPsbt,
  decodeP2mrAddress,
  decodePsbt as decodeQbitPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes as qbitHexToBytes,
  outputScriptToAddress,
  qbitDataSigPqcHash,
  qbitWalletMessageHash,
  p2mrLeafHash,
  p2mrScriptPubKey as qbitP2mrScriptPubKey,
  parsePsbt as parseQbitPsbt,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  type P2mrMessageProof,
  type P2mrSigningKey,
  type P2mrSpentOutput,
  type P2mrTransaction,
  type P2mrTransactionOutput,
  type Psbt as QbitPsbt,
} from '@qbit-oss/protocol'
import { ColdWalletKeyring } from '@qbit/keyring-service'
import type {
  QbitRecoveryMigrationPlanVault,
  QbitRecoveryMigrationVault,
  QbitRecoveryNetworkVaultState,
  QbitRecoveryVaultState,
} from '@qbit/keyring-service/qbit-hd-keyring'
import { DisplayedKeyring, Keyring, KeyringType, ToSignInput } from '@qbit/keyring-service/types'
import * as txHelpers from '@qbit/tx-helpers'
import { UnspentOutput, signMessageOfBIP322Simple } from '@qbit/tx-helpers'
import {
  addressToScriptPk,
  transactionCore,
  eccManager,
  getAddressType,
  isValidAddress,
  publicKeyToAddress,
  scriptPkToAddress,
  toPsbtNetwork,
  toXOnly,
} from '@qbit/wallet-core'
import {
  Account,
  AccountSignMethod,
  AddressUserToSignInput,
  BUS_EVENTS,
  BUS_METHODS,
  type BiometricUnlockRecord,
  type BiometricUnlockStatus,
  QbitBalance,
  CHAINS_MAP,
  ConnectedSite,
  DecodedPsbt,
  DeriveAccountResult,
  DummyTxType,
  ErrorCodes,
  type FeeSummary,
  LocalPsbtSummary,
  PsbtActionDetailType,
  PsbtActionInfo,
  PsbtActionType,
  QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES,
  QBIT_P2MR_DUST,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  QbitFeeBumpDetails,
  QbitFeeBumpEligibility,
  QbitFeeBumpUnavailableReason,
  QbitExternalSigningLock,
  QbitExternalSigningLockPurpose,
  QbitProviderApprovalContext,
  QbitProviderSignPsbtOptions,
  QbitReceiveAddressState,
  QbitReceiveNetworkName,
  QbitReceiveState,
  QbitRecoveryDeferredSource,
  QbitRecoveryMigrationSigningData,
  QbitRecoveryRemovalReason,
  QbitRecoveryState,
  QbitRemoveKeyringOptions,
  QbitP2mrSigningKeyInput,
  type QbitBroadcastFailure,
  type QbitConsolidationBatch,
  type QbitConsolidationStatus,
  type QbitBroadcastIdentity,
  type QbitBroadcastLookup,
  type QbitBroadcastResult,
  type QbitBroadcastStatusCheck,
  type QbitRestoreFloorSourceRecord,
  type QbitUtxoSnapshot,
  QbitSendBroadcastClaim,
  PublicKeyUserToSignInput,
  RateUsStatus,
  RiskType,
  SESSION_EVENTS,
  SignMessageType,
  SignPsbtOptions,
  SignedData,
  SignedMessage,
  ThemeMode,
  ToSignData,
  ToSignMessage,
  TxHistoryItem,
  UTXO,
  WalletError,
  WalletKeyring,
  type WebsiteSafetyResult,
  assertQbitFeeRateWithinPolicy,
  bgI18n,
  createUnverifiedWebsiteResult,
  estimateQbitP2mrTransaction,
  getAccountCapabilities,
  getLockTimeInfo,
  getQbitHdPathForChainType,
  isQbitAccountOutput,
  isQbitFeeRateWithinPolicy,
  isQbitStandardTxSize,
  normalizeChainType,
  qbitMaximumTotalFee,
  qbitBroadcastErrorMessage,
  qbitP2mrInputFee,
  qbitP2mrInputsDominateFee,
  qbitP2mrMaxStandardInputCount,
  qbitWitnessStackLength,
  sanitizeQbitBroadcastDetail,
  selectQbitP2mrSendAllCoins,
  selectQbitP2mrSendCoins,
  sortQbitCoinsByValue,
  t,
} from '@qbit/wallet-shared'
import { AddressType, ChainType, NetworkType } from '@qbit/wallet-types'
import {
  biometricUnlockService,
  contactBookService,
  keyringService,
  notificationService,
  permissionService,
  phishingDetectService,
  preferenceService,
  qbitSendGuardService,
  sessionService,
  walletApiService,
} from '../services'
import { getChainInfo } from '../shared/utils'
import { chainTypeToCanonicalNetwork } from '../shared/utils/deriveContextHash'
import { bgEventBus } from '../utils/eventBus'
import { decodeOpReturnScript } from '../utils/decode-op-return'
import { summarizeQbitPsbtSpend } from '../utils/qbit-psbt-spend-summary'
import { assertQbitP2mrSigningLeafRecord } from '../utils/qbit-p2mr-signing-leaf'
import {
  QBIT_MIN_RELAY_FEE_RATE,
  psbtReviewOptions,
  qbitWalletOwnership,
  type DecodePsbtOptions,
  type LocalPsbtBatchReview,
  type QbitWalletOwnership,
} from '@qbit/wallet-shared'
import { psbtFromString } from '../utils/psbt-utils'
import {
  QBIT_BROADCAST_ABSENCE_PROBES,
  QBIT_BROADCAST_ABSENCE_PROBE_DELAY_MS,
  QBIT_BROADCAST_DEADLINE_MS,
  QBIT_BROADCAST_MIN_PASS_MS,
  QBIT_BROADCAST_RESEND_DELAYS_MS,
  QBIT_BROADCAST_RESEND_WINDOW_MS,
  QBIT_BROADCAST_STATUS_CHECK_DEADLINE_MS,
  QBIT_LIFECYCLE_TX_READ_DEADLINE_MS,
  QbitBroadcastResponseMismatchError,
  classifyQbitBroadcastError,
  isQbitBroadcastResendable,
  isQbitTxSizeBroadcastRejection,
  qbitBroadcastProbeDelay,
  type QbitBroadcastErrorClassification,
} from '../utils/qbit-broadcast'
import {
  assertQbitStatsFloorBelowWarningThreshold,
  classifyQbitProtectedAssetCoverage,
  continueQbitAddressOutputScan,
  createQbitAddressOutputScan,
  DEFAULT_QBIT_RESTORE_GAP_LIMIT,
  DEFAULT_QBIT_RESTORE_MAX_INDEXES,
  discoverQbitActiveIndexes,
  findActiveQbitAddressGroups,
  findQbitSpentOutpoints,
  getQbitAccountHistory,
  getQbitAddressOutputCounts,
  getQbitAddressUtxos,
  getQbitAddressUtxosClassifiedPastLimit,
  getQbitAddressSummaries,
  getQbitRawTransaction,
  getQbitRawTransactionHex,
  getQbitSpendableBalanceV2,
  getQbitTxSpenders,
  isQbitChainType,
  isQbitCoinbaseMature,
  isQbitHistoryOverReadLimit,
  isQbitSnapshotUnstableError,
  MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES,
  observeQbitPqcSignatureActivity,
  observeQbitPqcSpentOutpoints,
  probeQbitAccountHistoryAncestry,
  probeQbitAccountHistoryRevision,
  qbitAddressHasUnconfirmedSpends,
  qbitAddressOutputCounts,
  QBIT_EXPLORER_DEFAULT_UTXO_LIMIT,
  QBIT_FEE_QUOTE_TTL_MS,
  qbitBalanceToWalletBalance,
  qbitFeeSummaryFromTiers,
  qbitStatsSnapshot,
  qbitStatsToAddressSummary,
  qbitUnavailableFeeSummary,
  QbitUtxoHistoryTooLargeError,
  QbitWalletEsploraClient,
  QbitWalletMempoolClient,
  qbitReadOutput,
  readQbitAddressUtxos,
  type QbitAccountHistoryRevision,
  type QbitAddressOutputScan,
  type QbitClassifiedUtxos,
  type QbitReadOutput,
  type QbitHistoryOutputCandidate,
  type QbitPqcHistoryClient,
  type QbitPqcSignatureActivity,
  type QbitProtectedAssetCoverage,
  type QbitRestoreDiscovery,
  type QbitWalletApiClient,
} from '../utils/qbit-api'
import {
  isQbitFeeBumpCopyableOutput,
  qbitP2mrTransactionSignedBy,
  qbitRawP2mrTransaction,
  type QbitRawP2mrTransaction,
} from '../utils/qbit-fee-bump'
import {
  QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS,
  QbitExplorerOperation,
} from '../utils/qbit-explorer-fetch'
import {
  QBIT_FEE_BUMP_ASSESSMENT_DEADLINE_MS,
  assertNoExplorerDependentSpend,
} from '../utils/qbit-fee-bump-recheck'
import {
  QBIT_RECEIVE_GAP_LIMIT,
  planQbitReceiveIntent,
  type QbitReceiveAllocationAddress,
} from '../utils/qbit-receive'
import { QbitLatestAnswers, QbitReplaceableReads } from '../utils/qbit-shared-reads'

import { paramsUtils } from '@qbit/base-utils'
import {
  ADDRESS_TYPES,
  AddressFlagType,
  BRAND_ALIAN_TYPE_TEXT,
  KEYRING_TYPES,
  NETWORK_TYPES,
} from '@qbit/wallet-shared'
import log from 'loglevel'
import approvalService from 'src/services/approval'
// Imported by module path rather than through '../services' so the capability
// stays independently mockable and existing service mocks are unaffected.
import regtestAccessService, {
  type RegtestAccessAckStore,
  type RegtestAccessAdapter,
} from '../services/regtestAccess'
import type { RegtestFetch } from '../utils/regtest-service-verification'
import type { RegtestAccessStatus } from '@qbit/wallet-shared'
import { ContactBookItem } from '../services/contactBook'
import {
  QBIT_WALLET_SEND_CLAIM_ORIGIN,
  QbitSendBroadcastClaimInactiveError,
  type QbitExternalSigningLockIdentity,
  type QbitOutpoint,
  type QbitProviderSendRequest,
  type QbitSendClaimOwner,
  type QbitSendClaimVerdict,
} from '../services/qbitSendGuards'
import BaseController from './base'

/**
 * Exact finalized vsize of a single-key P2MR PSBT (every input spends the
 * same leaf), sized from its first leaf script. Only for PSBTs the wallet
 * built: a review sizes a PSBT with `qbitPsbtReviewVsize`.
 */
function qbitP2mrFinalizedVsize(summary: ReturnType<typeof decodeQbitPsbt>): number {
  const firstLeafScript = summary.inputs.find(input => input.leafScripts.length > 0)?.leafScripts[0]
  return estimateQbitP2mrTransaction({
    inputCount: summary.inputs.length,
    outputScriptLengths: summary.outputs.map(output => output.scriptPubKey.length),
    leafScriptLength: firstLeafScript?.script.length ?? 34,
    controlBlockLength: firstLeafScript?.controlBlock.length ?? 1,
  }).vsize
}

/**
 * Witness of a single-key spend through a zero-depth leaf, the smallest a
 * signed v1 `pk` or `multi_a` leaf finalizes to.
 */
const QBIT_P2MR_SINGLE_KEY_WITNESS_BYTES = qbitWitnessStackLength([
  QBIT_P2MR_DEFAULT_SIGNATURE_ITEM_BYTES,
  34,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
])

/**
 * Finalized vsize a PSBT review rates its fee by. The website supplies every
 * leaf record and final witness of its PSBT, and a signature commits to
 * neither the control block it is revealed with nor the witness of another
 * input, so the transaction broadcast need not carry the witnesses the PSBT
 * lists (#59). Each input is therefore sized as a single-key spend through a
 * zero-depth leaf, or by its final witness when that is smaller, so the leaf
 * records and witnesses the PSBT lists cannot lower the rate shown. An input
 * that finally spends with a smaller witness than a single-key spend still
 * can, until a fee check that does not depend on this size is added (#59).
 */
function qbitPsbtReviewVsize(psbt: QbitPsbt, summary: ReturnType<typeof decodeQbitPsbt>): number {
  const singleKeyVsize = estimateQbitP2mrTransaction({
    inputCount: summary.inputs.length,
    outputScriptLengths: summary.outputs.map(output => output.scriptPubKey.length),
    leafScriptLength: 34,
    controlBlockLength: QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  }).vsize
  return summary.inputs.reduce((vsize, input, inputIndex) => {
    if (!input.finalized) return vsize
    const finalWitness = psbt.inputs[inputIndex]!.find(
      entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS
    )!.value
    return vsize + Math.min(0, finalWitness.length - QBIT_P2MR_SINGLE_KEY_WITNESS_BYTES)
  }, singleKeyVsize)
}

/**
 * A consolidation walk and the inputs of the batches built from it, which
 * stay out of later batches while a claim or recent spend holds them.
 */
type QbitConsolidationScanEntry = {
  scan: QbitAddressOutputScan
  handedOut: Map<string, QbitHistoryOutputCandidate>
  usedAt: number
  /** Operations in a row that failed on this scan. */
  failures: number
}

type CorruptedWalletKeyring = WalletKeyring & {
  isCorrupted: true
  corruptedReason: string
}

type QbitApiSurface = 'esplora' | 'mempool-qbit'

type QbitFeeQuoteCacheEntry = {
  fetchedAt: number
  summary: FeeSummary
}

/** What a PSBT review is relative to; see `readQbitPsbtReviewContext`. */
type QbitPsbtReviewContext = {
  chain: ChainType
  networkType: NetworkType
  account: Account
  wallet: QbitWalletOwnership
  feeSummary: FeeSummary | undefined
}

export interface WalletControllerOptions {
  now?: () => number
}

type QbitReceiveIntentLedger = {
  currentIndex: number | null
  issuedIndexes: number[]
  usedIndexes: number[]
}

type QbitReceiveControllerContext = {
  network: QbitReceiveNetworkName
  keyring: WalletKeyring
  anchor: Account
  ledger: QbitReceiveIntentLedger
  addresses: QbitReceiveAddressState[]
  activityStatus: QbitReceiveState['activityStatus']
  floorsPending: boolean
  concurrentInstanceHint: boolean
}

type QbitHistoryScope = {
  chainType: ChainType
  scopeKey: string
  addresses: string[]
  addressFingerprint: string
}

type QbitHistorySnapshot = QbitHistoryScope & {
  id: string
  createdAt: number
  fullScanAt: number
  revision: QbitAccountHistoryRevision
  list: readonly TxHistoryItem[]
}

export type WalletKeyringWithStatus = WalletKeyring | CorruptedWalletKeyring

export type AccountAsset = {
  name: string
  symbol: string
  amount: string
  value: string
}

export function canDeriveAddressFromPublicKey(
  pubkey: string,
  addressType: AddressType,
  networkType: NetworkType
) {
  if (addressType === AddressType.P2MR) {
    return /^[0-9a-fA-F]{64}$/.test(pubkey)
  }
  try {
    return Boolean(publicKeyToAddress(pubkey, addressType, networkType))
  } catch (e) {
    return false
  }
}

function chainTypeToQbitNetworkName(chainType: ChainType): 'mainnet' | 'testnet4' | 'regtest' {
  if (chainType === ChainType.QBIT_MAINNET) return 'mainnet'
  if (chainType === ChainType.QBIT_REGTEST) return 'regtest'
  return 'testnet4'
}

const QBIT_CHAIN_TYPES = [
  ChainType.QBIT_MAINNET,
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
] as const

function qbitChainTypesSharingHdPath(chainType: ChainType): readonly ChainType[] {
  const hdPath = getQbitHdPathForChainType(chainType)
  return QBIT_CHAIN_TYPES.filter(candidate => getQbitHdPathForChainType(candidate) === hdPath)
}

function inferQbitApiSurface(endpoint: string): QbitApiSurface {
  try {
    const pathname = new URL(endpoint).pathname.replace(/\/+$/, '')
    return pathname.endsWith('/api/v1') ? 'mempool-qbit' : 'esplora'
  } catch (e) {
    return endpoint.replace(/\/+$/, '').endsWith('/api/v1') ? 'mempool-qbit' : 'esplora'
  }
}

function cloneFeeSummary(summary: FeeSummary): FeeSummary {
  return {
    list: summary.list.map(item => ({ ...item })),
    ...(summary.quote ? { quote: { ...summary.quote } } : {}),
  }
}

function resolveHdPathForAddressType(
  addressType: AddressType,
  hdPath: string,
  chainType: ChainType
): string {
  return addressType === AddressType.P2MR ? getQbitHdPathForChainType(chainType) : hdPath
}

function assertCanCreateSigningRequest(account: Account | null | undefined) {
  if (!getAccountCapabilities(account).canCreateSigningRequest) {
    throw new Error(t('not_supported'))
  }
}

function assertCanCreateQbitP2mrSend(account: Account | null | undefined) {
  const signMethod = getAccountCapabilities(account).signMethod
  if (
    !account?.p2mr ||
    (signMethod !== AccountSignMethod.Local && signMethod !== AccountSignMethod.External)
  ) {
    throw new Error(t('not_supported'))
  }
}

function assertValidP2mrMessage(message: string) {
  if (!message || message.trim().length === 0 || message.length > 10000) {
    throw new Error('Invalid message length')
  }
}

const ORIGIN_DISCONNECTED = {
  code: 4900,
  message: 'The origin was disconnected from Qbit Wallet.',
} as const
const QBIT_P2MR_NON_RBF_SEQUENCE = 0xffffffff
const QBIT_P2MR_RBF_SEQUENCE = 0xfffffffd
const QBIT_RECENT_SPEND_PROBE_WAIT_MS = 2_000
const QBIT_HISTORY_SNAPSHOT_TTL_MS = 5 * 60_000
const QBIT_HISTORY_SNAPSHOT_LIMIT = 8
const QBIT_HISTORY_PERSISTED_CACHE_LIMIT = 20
const QBIT_RECOVERY_MIGRATION_RELAY_FEE_RATE = 1
const QBIT_RECOVERY_MIGRATION_PREFLIGHT_BATCH_SIZE = 64
// History pages one consolidation batch may read. An active miner's newest
// ~1,000 coinbase outputs are immature, so a first batch may have to read
// past them: 40 Esplora pages, 20 of the 50-row pages the production
// mempool-qbit serves. 64 leaves room for the 106 mature outputs after them.
const QBIT_CONSOLIDATION_PAGES_PER_BATCH = 64
// The deadline of one batch's Prepare, which covers the screen until it
// answers: every read it makes once it has the account's scan (pages,
// outspends, the tip). A page may take the whole large-read ceiling, sized
// for a 40 MB page at about 1 Mbit/s, so the deadline is that ceiling and a
// minute for the small reads around it: every Prepare can finish at least
// one such page. A batch it cuts short keeps what its walk read, and the
// next Prepare reads on from there.
export const QBIT_CONSOLIDATION_BATCH_DEADLINE_MS = QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS + 60_000
// A consolidation scan stops reading once it holds this many candidates.
const QBIT_CONSOLIDATION_MAX_CANDIDATES = 10_000
// Rounds of outspends checks one batch makes while its choices keep turning out spent.
const QBIT_CONSOLIDATION_VERIFY_ROUNDS = 4
// A consolidation scan unused for this long starts over from the newest history.
const QBIT_CONSOLIDATION_SCAN_TTL_MS = 30 * 60_000
// Batches in a row that may fail on one scan before it starts over: a failure
// the explorer cannot tell from an outage (a bare 500) must not pin it.
const QBIT_CONSOLIDATION_SCAN_FAILURE_LIMIT = 2
// Built consolidation batches whose funding output counts signing remembers.
const QBIT_CONSOLIDATION_BATCH_RECORD_LIMIT = 32

/**
 * An explorer failure that a later attempt may not hit: a network error, a
 * timeout, rate limiting or a server error. Anything else (a rejected cursor,
 * a transaction gone after a reorg, a malformed answer) repeats on retry.
 */
function isQbitTransientApiError(error: unknown): boolean {
  return (
    error instanceof QbitApiError &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'rate_limit' ||
      (error.kind === 'http' && error.status !== undefined && error.status >= 500))
  )
}

/**
 * How far an address's history had got when its statistics were read: its
 * transactions in all, then its confirmed ones. Payments only add to the
 * first and confirmations only to the second, so statistics that rank
 * higher are newer; an eviction or a lagging node's answer ranks lower or
 * the same. Undefined for statistics without counts to rank.
 */
type QbitHistoryProgress = readonly [all: number, confirmed: number]

function qbitHistoryProgress(stats: EsploraAddressStats): QbitHistoryProgress | undefined {
  const confirmed = stats?.chain_stats?.tx_count
  const pending = stats?.mempool_stats?.tx_count
  if (
    !Number.isSafeInteger(confirmed) ||
    !Number.isSafeInteger(pending) ||
    !Number.isSafeInteger(confirmed + pending) ||
    confirmed < 0 ||
    pending < 0
  ) {
    return undefined
  }
  return [confirmed + pending, confirmed]
}

function isLaterQbitHistoryProgress(
  candidate: QbitHistoryProgress,
  running: QbitHistoryProgress
): boolean {
  return candidate[0] > running[0] || (candidate[0] === running[0] && candidate[1] > running[1])
}

// Per-address stability retries for restore floor scans. Mempool churn is
// re-observed on the bounded 1/2/4/8 s back-off (which crosses electrs' 10 s
// response-cache window like the history loader). A tip advance during one
// address's window instead waits out the settle floor before the address is
// observed again from scratch: the explorer's tip route and its address index
// are updated independently, and 10 s covers an electrs 5 s block poll plus
// indexing so the retry does not read the address before the block is in it.
const QBIT_FLOOR_SCAN_STABILITY_RETRIES = {
  stabilityRetries: 4,
  retryBaseDelayMs: 1_000,
  tipAdvanceSettleMs: 10_000,
}

type QbitRecoveryMigrationPreparation = {
  state: QbitRecoveryState
  toSignDatas: ToSignData[]
  /**
   * The sources this pass read but could not plan. Absent when it returned
   * before reading them (plans still in flight, or already migrated).
   */
  deferredSources?: QbitRecoveryDeferredSource[]
}

type QbitFeeBumpPlan = {
  account: Account
  /** The original as its raw bytes and the account's signatures over them prove it. */
  original: P2mrTransaction
  spentOutputs: P2mrSpentOutput[]
  outputs: P2mrTransactionOutput[]
  details: QbitFeeBumpDetails
}

type QbitFeeBumpAssessment =
  | { eligible: true; plan: QbitFeeBumpPlan }
  | { eligible: false; reason: QbitFeeBumpUnavailableReason }

function isSafeSatoshiValue(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function isHexByteString(value: unknown, expectedBytes?: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(value) &&
    (expectedBytes === undefined || value.length === expectedBytes * 2)
  )
}

function isPsbtHex(data: string): boolean {
  return /^70736274ff/i.test(data)
}

function qbitPsbtToHex(psbt: QbitPsbt): string {
  return qbitBytesToHex(serializePsbt(psbt))
}

function qbitPsbtFromHex(psbtHex: string): QbitPsbt {
  return parseQbitPsbt(qbitHexToBytes(psbtHex))
}

function qbitTxidToInternalBytes(txid: string): Uint8Array {
  const bytes = qbitHexToBytes(txid)
  if (bytes.length !== 32) {
    throw new Error(`Invalid qbit txid: ${txid}`)
  }
  return new Uint8Array(bytes).reverse()
}

function qbitInternalBytesToTxid(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    return qbitBytesToHex(bytes)
  }
  return qbitBytesToHex(new Uint8Array(bytes).reverse())
}

function qbitPsbtOutpoints(psbt: QbitPsbt): QbitOutpoint[] {
  return psbtUnsignedTransaction(psbt).inputs.map(input => ({
    txid: qbitInternalBytesToTxid(input.prevout.txid),
    vout: input.prevout.vout,
  }))
}

function qbitPsbtTxid(psbt: QbitPsbt): string {
  const unsignedTransaction = psbt.global.find(
    entry => entry.key.length === 1 && entry.key[0] === 0
  )?.value
  if (!unsignedTransaction) throw new Error('invalid prepared Qbit send PSBT')
  return Buffer.from(transactionCore.crypto.hash256(Buffer.from(unsignedTransaction)))
    .reverse()
    .toString('hex')
}

/**
 * Fix the network and expected txid of a P2MR transaction the wallet has just
 * built. Its inputs were selected on `chain` and exist nowhere else, and the
 * txid depends only on the inputs and outputs, so both are known here, before
 * approval or signing. The identity travels with the request: signing
 * validates against it instead of the network selected at signing time, and
 * the send flow binds the first broadcast and every retry to it.
 */
function qbitBroadcastIdentityOf(psbt: QbitPsbt, chain: ChainType): QbitBroadcastIdentity {
  return { chain, txid: qbitPsbtTxid(psbt) }
}

/**
 * What a signer hands back, a finalized PSBT or a raw transaction, parsed
 * into the bytes a broadcast sends and the txid and inputs they commit to.
 * Throws for anything that is not a broadcastable P2MR transaction.
 */
function qbitSignedTransaction(txData: string): {
  rawtx: string
  txid: string
  outpoints: QbitOutpoint[]
} {
  let rawtx = txData
  if (isPsbtHex(txData)) {
    const finalized = finalizeP2mrPsbt(qbitPsbtFromHex(txData))
    rawtx = qbitBytesToHex(extractP2mrTransaction(finalized))
  }
  const transaction = transactionCore.Transaction.fromHex(rawtx)
  const txid = transaction.getId()
  const outpoints = transaction.ins.map(input => ({
    txid: Buffer.from(input.hash).reverse().toString('hex'),
    vout: input.index,
  }))
  return { rawtx, txid, outpoints }
}

/**
 * The transaction a UI broadcast is bound to, known before its bytes are
 * parsed: the txid the caller expects (the identity fixed when the wallet
 * built the request), else the one its send claim names. Only a well-formed
 * txid is reported, and never the bytes' own, so a verdict cannot name a
 * transaction the caller did not approve.
 */
function qbitBoundBroadcastTxid(
  expectedTxid: string | null | undefined,
  claim: QbitSendBroadcastClaim | undefined
): string | undefined {
  for (const candidate of [expectedTxid, claim?.txid]) {
    const normalized = typeof candidate === 'string' ? candidate.trim().toLowerCase() : ''
    if (/^[0-9a-f]{64}$/.test(normalized)) return normalized
  }
  return undefined
}

function sameQbitOutpoints(
  left: readonly QbitOutpoint[],
  right: readonly QbitOutpoint[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (outpoint, index) =>
        outpoint.txid === right[index]?.txid && outpoint.vout === right[index]?.vout
    )
  )
}

function transactionPsbtOutpoints(psbt: transactionCore.Psbt): QbitOutpoint[] {
  return psbt.txInputs.map(input => ({
    txid: Buffer.from(input.hash).reverse().toString('hex'),
    vout: input.index,
  }))
}

function qbitSigningKeysFromSerializable(
  keys: readonly QbitP2mrSigningKeyInput[]
): P2mrSigningKey[] {
  return keys.map(key => {
    const signingKey: P2mrSigningKey = {
      inputIndex: key.inputIndex,
      pubkey: qbitHexToBytes(key.publicKey),
      leafHash: qbitHexToBytes(key.leafHash),
    }
    if (key.hashType !== undefined) {
      signingKey.hashType = key.hashType
    }
    return signingKey
  })
}

/**
 * Whether a provider PSBT is finalized after signing. The account signs only
 * its own inputs, so finalizing completes the transaction only when those
 * signatures leave every input finalizable: the plans are signed with a
 * placeholder and run through the same finalize and extract the signed PSBT
 * will, before approval and before any signature counter moves. Without
 * `autoFinalized` the PSBT is finalized exactly then, and otherwise comes
 * back signed but unfinalized for the other signers; an explicit `true` the
 * wallet cannot meet is refused, rather than failing after the signature.
 */
function qbitProviderPsbtAutoFinalized(
  psbt: QbitPsbt,
  keys: readonly P2mrSigningKey[],
  requested: boolean | undefined
): boolean {
  if (requested === false) return false
  try {
    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES),
    })
    extractP2mrTransaction(finalizeP2mrPsbt(signed))
    return true
  } catch (error) {
    if (!(error instanceof QbitProtocolError)) throw error
    if (requested !== true) return false
    throw new WalletError(
      ErrorCodes.INVALID_PARAMS,
      `autoFinalized needs a PSBT this wallet can finalize after signing: ${error.message}`
    )
  }
}

function isHexBytesText(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)
}

function qbitMemoOutputs(memo?: string, memos?: string[]): P2mrTransactionOutput[] {
  const chunks = memo ? [memo] : memos || []
  if (chunks.length === 0) {
    return []
  }

  const data = chunks.map(chunk =>
    isHexBytesText(chunk) ? Buffer.from(chunk, 'hex') : Buffer.from(chunk)
  )
  const output = transactionCore.payments.embed({ data }).output
  if (!output) {
    throw new Error('Invalid qbit memo')
  }

  return [
    {
      value: 0n,
      scriptPubKey: output,
    },
  ]
}

/**
 * Log-safe error summary for regtest fallback paths: type and code only, so
 * addresses, transactions, key material or local-service bodies can never end
 * up in logs through an error message.
 */
function summarizeError(error: unknown): { name?: string; code?: number } {
  if (typeof error !== 'object' || error === null) {
    return {}
  }
  const { name, code } = error as { name?: unknown; code?: unknown }
  return {
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof code === 'number' ? { code } : {}),
  }
}

/**
 * How many addresses' latest output reads each API client keeps, the most
 * recently used first; switching through more over-limit accounts reads
 * the oldest one's outputs again.
 */
const QBIT_LATEST_UTXO_READS_PER_CLIENT = 4

/**
 * Whether the recovery sweep may spend `utxo` from `account`: a positive
 * amount, and the account's own (`isQbitAccountOutput`).
 */
function isQbitRecoverySweepInput(account: Account, utxo: UnspentOutput): boolean {
  return (
    Number.isSafeInteger(utxo.satoshis) &&
    utxo.satoshis > 0 &&
    isQbitAccountOutput(utxo, account.p2mr?.scriptPubKey)
  )
}

export class WalletController extends BaseController {
  timer: any = null
  private readonly qbitApiClients = new Map<string, QbitWalletApiClient>()
  /**
   * The history walk behind each account's consolidation, by network and
   * address, and the queue that runs one batch selection per walk at a time.
   * In memory only, like the send guards: after a restart the walk starts
   * again from the top, which costs requests and nothing else, since each
   * batch is checked unspent and against the guards before it is built.
   */
  private readonly qbitConsolidationScans = new Map<string, QbitConsolidationScanEntry>()
  private readonly qbitConsolidationQueues = new Map<string, Promise<void>>()
  /**
   * The funding output counts of the consolidation batches built here, by
   * txid, so signing re-checks a batch's inputs even when the request it is
   * handed has lost its `qbitConsolidation` details.
   */
  private readonly qbitConsolidationBatches = new Map<string, number[]>()
  private readonly qbitFeeQuoteCache = new Map<string, QbitFeeQuoteCacheEntry>()
  private readonly qbitFeeQuoteRefreshes = new Map<string, Promise<FeeSummary>>()
  private readonly now: () => number
  private readonly qbitHistorySnapshots = new Map<string, QbitHistorySnapshot>()
  private qbitHistorySnapshotSequence = 0
  private chainStateChangeTail: Promise<void> = Promise.resolve()

  constructor(options: WalletControllerOptions = {}) {
    super()
    this.now = options.now ?? Date.now
  }

  private backgroundInited = false
  private backgroundStartupFailure: 'stored-settings-unreadable' | 'unknown' | undefined

  setBackgroundInited = async (value: boolean) => {
    this.backgroundInited = value
  }
  getBackgroundInited = async () => {
    return this.backgroundInited
  }
  /**
   * Record why start-up stopped. Start-up runs once per worker start, so the
   * failure stands until the worker restarts.
   */
  setBackgroundStartupFailed = async (reason: 'stored-settings-unreadable' | 'unknown') => {
    this.backgroundStartupFailure = reason
  }
  /**
   * Whether start-up is still running, has finished, or has stopped and why,
   * so the UI can tell "not ready yet" from "will not be ready".
   */
  getBackgroundStartupStatus = async (): Promise<
    | { state: 'starting' }
    | { state: 'ready' }
    | { state: 'failed'; reason: 'stored-settings-unreadable' | 'unknown' }
  > => {
    if (this.backgroundInited) return { state: 'ready' }
    if (this.backgroundStartupFailure) {
      return { state: 'failed', reason: this.backgroundStartupFailure }
    }
    return { state: 'starting' }
  }

  async init(adapters?: any): Promise<void> {
    console.log('[WalletController] Initialized')
  }

  protected override onInitialize(): Promise<void> {
    return Promise.resolve()
  }

  protected override onCleanup(): Promise<void> {
    return Promise.resolve()
  }

  private getQbitApiEndpoint(chainType = this.getChainType()): {
    endpoint: string
    apiSurface: QbitApiSurface
  } {
    const chain = CHAINS_MAP[chainType]
    const endpoint = chain?.endpoints[0]
    if (!endpoint) {
      throw new Error(`No qbit API endpoint configured for ${chainType}`)
    }
    const apiSurface = chain.qbitApiSurface ?? inferQbitApiSurface(endpoint)
    return { endpoint, apiSurface }
  }

  private getQbitApiClient(chainType = this.getChainType()): QbitWalletApiClient {
    const { endpoint, apiSurface } = this.getQbitApiEndpoint(chainType)
    const key = this.getQbitFeeQuoteCacheKey(chainType, apiSurface, endpoint)
    let client = this.qbitApiClients.get(key)
    if (!client) {
      client =
        apiSurface === 'mempool-qbit'
          ? new QbitWalletMempoolClient({ baseUrl: endpoint })
          : new QbitWalletEsploraClient({ baseUrl: endpoint })
      this.qbitApiClients.set(key, client)
    }
    return client
  }

  private getQbitFeeQuoteCacheKey(
    chainType: ChainType,
    apiSurface: QbitApiSurface,
    endpoint: string
  ): string {
    return `${chainType}:${apiSurface}:${endpoint}`
  }

  private isQbitChain() {
    return isQbitChainType(this.getChainType())
  }

  /**
   * Drop the outputs a send must not select: the ones a claim or an
   * external signing lock holds, and the ones a recent broadcast spent,
   * which the explorer (or the UI's cached copy of its list) can keep
   * listing after the node took the spend. The spenders of those recent
   * spends that are due a probe are looked up first, so an input whose
   * spender has confirmed or is gone is not held back any longer than that.
   */
  private async excludeGuardedQbitUtxos(
    chain: ChainType,
    address: string,
    utxos: readonly UnspentOutput[]
  ): Promise<UnspentOutput[]> {
    await this.settleQbitRecentSpends(chain, address)
    const reserved = await qbitSendGuardService.getReservedOutpointKeys(
      chain,
      address
    )
    return utxos.filter(utxo => !reserved.has(`${utxo.txid.toLowerCase()}:${utxo.vout}`))
  }

  /**
   * Probe the lifecycle of each recent spender due a check and report what
   * was found. A probe that fails keeps the inputs reserved; the guard's
   * expiry is the only other way out. The caller waits at most
   * `qbitRecentSpendProbeWaitMs` for the probes: one still running then
   * settles later, and until it does its inputs stay reserved, which is
   * the safe side.
   *
   * With `guardWaitMs` (a balance read) the caller waits at most that long
   * for the guard to hand out the spenders: a broadcast can hold the
   * guard's queue for as long as the explorer takes to answer it. Those
   * spenders are probed once the guard hands them out, and settle later.
   */
  private async settleQbitRecentSpends(
    chain: ChainType,
    address: string,
    guardWaitMs?: number
  ): Promise<void> {
    const taken = qbitSendGuardService.takeRecentSpendersToProbe(chain, address)
    const probeAll = (probes: Awaited<typeof taken>): Promise<unknown> =>
      Promise.all(
        probes.map(async probe => {
          let lifecycle: { state: 'confirmed' | 'pending' | 'gone' }
          try {
            lifecycle = await this.qbitTxLifecycleStatusOn(chain, probe.txid)
          } catch {
            return
          }
          await qbitSendGuardService.settleRecentSpendProbe(chain, probe, lifecycle.state)
        })
      ).catch(() => undefined)
    const probes =
      guardWaitMs === undefined ? await taken : await this.qbitGuardReadWithin(taken, guardWaitMs)
    if (probes === undefined) {
      void taken.then(probeAll, () => undefined)
      return
    }
    if (probes.length === 0) return
    const settled = probeAll(probes)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      settled,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.qbitRecentSpendProbeWaitMs)
      }),
    ])
    clearTimeout(timer)
  }

  /**
   * `read`, a send guard read just queued, or `undefined` when the guard
   * has not answered it within `waitMs`. A read queued behind a broadcast
   * is not waited for, and its late answer is dropped.
   */
  private async qbitGuardReadWithin<T>(read: Promise<T>, waitMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read,
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), waitMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** How long a UTXO read waits for recent-spend probes; see `settleQbitRecentSpends`. */
  qbitRecentSpendProbeWaitMs = QBIT_RECENT_SPEND_PROBE_WAIT_MS

  /**
   * How long a balance read waits for the send guard, each time it queues a
   * read there, before it reports the split as unknown; see
   * `getAddressBalanceV2`.
   */
  qbitBalanceGuardWaitMs = 1_000

  private runWithNoQbitInputConflict<T>(
    chain: ChainType,
    outpoints: readonly QbitOutpoint[],
    operation: () => Promise<T>,
    txid?: string
  ): Promise<T> {
    if (txid === undefined) {
      return qbitSendGuardService.runWithNoOverlap(chain, outpoints, operation)
    }
    return qbitSendGuardService.runWithNoOverlap(chain, outpoints, operation, txid)
  }

  private validatedQbitSendBroadcastClaim(
    psbt: QbitPsbt,
    claim: QbitSendBroadcastClaim,
    providerContext: QbitProviderApprovalContext | undefined,
    signerAddress: string | undefined
  ): QbitSendBroadcastClaim {
    const chain = this.getChainType()
    const outpoints = qbitPsbtOutpoints(psbt)
    const txid = qbitPsbtTxid(psbt)
    if (
      !isQbitChainType(chain) ||
      !providerContext ||
      claim.chain !== chain ||
      providerContext.chain !== chain ||
      !claim.address ||
      claim.address !== signerAddress ||
      !claim.origin ||
      claim.origin !== providerContext.origin ||
      claim.txid !== txid ||
      !sameQbitOutpoints(claim.outpoints, outpoints)
    ) {
      throw new Error('invalid Qbit send broadcast claim')
    }
    return {
      chain,
      address: claim.address,
      origin: claim.origin,
      txid,
      outpoints,
    }
  }

  /**
   * The network and expected txid a P2MR signing request is bound to. A
   * request the wallet built carries the identity fixed at creation: its
   * inputs were selected on that network and exist nowhere else, so the
   * request is refused, before any one-time signature is consumed, when the
   * txid no longer matches the PSBT or the wallet has since switched to
   * another network. A request without one (the recovery migration path binds
   * its network through its reviewed plan instead) is bound to the active
   * network, as before. The UI keeps the result next to the signed bytes so
   * a broadcast whose answer is lost can still be probed and retried on that
   * network without signing again.
   */
  private validatedQbitBroadcastIdentity(
    psbt: QbitPsbt,
    requested: QbitBroadcastIdentity | undefined
  ): QbitBroadcastIdentity {
    const chain = this.getChainType()
    const txid = qbitPsbtTxid(psbt)
    if (!requested) return { chain, txid }
    if (!isQbitChainType(requested.chain) || requested.txid !== txid) {
      throw new Error('invalid Qbit broadcast identity')
    }
    if (requested.chain !== chain) {
      throw new Error('Qbit network changed since the transaction was created')
    }
    return { chain: requested.chain, txid }
  }

  /**
   * The account a P2MR request the wallet built belongs to is the one whose
   * key its signing entries name: every builder stamps them with the P2MR
   * public key of the account it selected inputs for, and the address a
   * claim is filed under derives from that key. The selected account is one
   * background-wide value that another window can change at any time. Local
   * signing is bound to it by the keyring, which refuses an entry that does
   * not name the selected account's key before any signature is spent; an
   * externally signed send is bound to it here, since nothing else on that
   * path reads the key, and a claim filed under another account's address
   * would escape the reservation filter of the account the inputs belong
   * to. Selecting the building account again accepts the same request.
   */
  private assertQbitSigningKeysOfAccount(
    account: Account,
    keys: readonly QbitP2mrSigningKeyInput[]
  ): void {
    const pubkey = (account.p2mr?.pubkey ?? account.pubkey).toLowerCase()
    if (
      keys.some(key => typeof key.publicKey !== 'string' || key.publicKey.toLowerCase() !== pubkey)
    ) {
      throw new Error('Qbit account changed since the transaction was created')
    }
  }

  /**
   * The reservation behind a send the wallet built for its own confirm
   * screen. A provider send arrives with the claim minted at approval; a
   * wallet-owned send carried none, yet its signed bytes are retained for
   * retry in exactly the same way after an ambiguous broadcast, so its
   * inputs stayed visible to every other send flow until the network showed
   * them spent, and a second transaction could be signed over them while
   * the first was still retryable. The claim is minted here from the PSBT
   * and the validated identity and registered atomically with the overlap
   * check at signing; the broadcast consumes it, as does a lookup that
   * proves acceptance, and the recovery screen releases it only when
   * the user abandons a proven not_sent verdict. It carries an origin no
   * dapp session can present, so the provider surfaces that release claims
   * by session origin cannot touch it. A provider signing request hands its
   * bytes back to the dapp, which broadcasts claim-less through pushTx, and
   * a recovery migration broadcasts through its own plan, so neither gets
   * one.
   */
  private walletQbitSendBroadcastClaim(
    psbt: QbitPsbt,
    identity: QbitBroadcastIdentity,
    toSignData: ToSignData,
    address: string
  ): QbitSendBroadcastClaim | undefined {
    if (toSignData.providerContext || toSignData.qbitRecoveryMigration) return
    if (!isQbitChainType(identity.chain)) return
    return {
      chain: identity.chain as QbitSendBroadcastClaim['chain'],
      address,
      origin: QBIT_WALLET_SEND_CLAIM_ORIGIN,
      txid: identity.txid,
      outpoints: qbitPsbtOutpoints(psbt),
      // A fee bump spends its original's inputs on purpose; the guard lets
      // only the claim naming that original take them over, and refuses it
      // while a later payment spends the original. The page keeps the claim
      // with the bytes, so a retry after a restart is checked the same way.
      replaces: toSignData.feeBump ? toSignData.feeBump.originalTxid : null,
      ...(toSignData.feeBump
        ? { replacedOutputCount: toSignData.feeBump.originalOutputCount }
        : {}),
    }
  }

  /**
   * Reserve the inputs of a send the wallet built but does not sign itself.
   * An external (readonly) or cold-wallet account signs outside the wallet
   * and hands back bytes the UI cannot parse, so signPsbtV2 never runs for
   * it and the claim minted there for a locally signed send did not exist:
   * after an ambiguous broadcast the inputs stayed visible to every other
   * send flow while the exact signed bytes remained retryable. The signer
   * flow calls this with the returned bytes before they reach the confirm
   * screen. The request is validated as local signing validates it (a P2MR
   * send the wallet built for the selected account, whose creation identity
   * still holds on the active network), the bytes must be the transaction
   * that identity names, and the claim is registered atomically with the
   * overlap check; from there the send is retained, broadcast, proven, and
   * released exactly like a locally signed one. Bytes for another
   * transaction register nothing.
   *
   * The window between building the request and pasting or scanning the
   * signature stays unreserved: nothing in the wallet observes the signer
   * screen being abandoned or the popup closing, and a lock that outlived
   * its request would refuse every later send over those inputs until the
   * background restarts. During that window another window can select a
   * different account, which the keyring would catch for a local signer and
   * nothing here would: the returned bytes still pass the txid check, and
   * the claim would be filed under the address now selected, where the
   * building account's reservation filter never looks. The request's signing
   * keys therefore have to name the selected account. A provider request is
   * not accepted here: the background locks its inputs at approval and
   * promotes that lock itself.
   */
  reserveExternallySignedQbitSend = async (
    toSignData: ToSignData,
    signedTxData: string
  ): Promise<SignedData> => {
    // Before the first await: the port this reservation is handed back to.
    const uiPort = this.callingUiPort
    const account = preferenceService.getCurrentAccount()
    const signMethod = getAccountCapabilities(account).signMethod
    if (
      !account ||
      (signMethod !== AccountSignMethod.External && signMethod !== AccountSignMethod.ColdWallet)
    ) {
      throw new Error('invalid externally signed Qbit send')
    }
    if (
      !toSignData?.qbitP2mrSigningKeys?.length ||
      toSignData.providerContext ||
      toSignData.qbitRecoveryMigration ||
      toSignData.qbitSendBroadcastClaim ||
      toSignData.qbitExternalSigningLock ||
      typeof signedTxData !== 'string'
    ) {
      throw new Error('invalid externally signed Qbit send')
    }
    this.assertQbitSigningKeysOfAccount(account, toSignData.qbitP2mrSigningKeys)

    const psbt = qbitPsbtFromHex(toSignData.psbtHex)
    const identity = this.validatedQbitBroadcastIdentity(psbt, toSignData.qbitBroadcastIdentity)
    if (qbitSignedTransaction(signedTxData).txid.toLowerCase() !== identity.txid) {
      throw new Error('signed transaction does not match the approved transaction')
    }
    const claim = this.walletQbitSendBroadcastClaim(psbt, identity, toSignData, account.address)
    if (!claim) throw new Error('invalid externally signed Qbit send')
    return qbitSendGuardService.runWithBroadcastClaim(
      claim,
      async () => ({
        psbtHex: signedTxData,
        qbitBroadcastIdentity: identity,
        qbitSendBroadcastClaim: {
          ...claim,
          outpoints: claim.outpoints.map(outpoint => ({ ...outpoint })),
        },
      }),
      uiPort
    )
  }

  createQbitSendBroadcastClaim = (
    psbtHex: string,
    providerContext: QbitProviderApprovalContext
  ): QbitSendBroadcastClaim => {
    const psbt = qbitPsbtFromHex(psbtHex)
    const account = preferenceService.getCurrentAccount()
    const claim: QbitSendBroadcastClaim = {
      chain: this.getChainType() as QbitSendBroadcastClaim['chain'],
      address: account?.address || '',
      origin: providerContext.origin,
      txid: qbitPsbtTxid(psbt),
      outpoints: qbitPsbtOutpoints(psbt),
    }
    return this.validatedQbitSendBroadcastClaim(psbt, claim, providerContext, account?.address)
  }

  acquireExternalQbitSigningLock = async (
    toSignDatas: readonly ToSignData[],
    purpose: QbitExternalSigningLockPurpose
  ): Promise<QbitExternalSigningLock | undefined> => {
    const account = preferenceService.getCurrentAccount()
    if (getAccountCapabilities(account).signMethod !== AccountSignMethod.External) return
    if (!account || toSignDatas.length === 0) {
      throw new Error('invalid external Qbit signing request')
    }

    const chain = this.getChainType()
    if (!isQbitChainType(chain)) throw new Error('invalid external Qbit signing request')
    const contexts = toSignDatas.map(toSignData => toSignData.providerContext)
    const origin = contexts[0]?.origin
    if (
      !origin ||
      contexts.some(context => context?.chain !== chain || context.origin !== origin)
    ) {
      throw new Error('invalid external Qbit signing request')
    }

    let entries: QbitExternalSigningLockIdentity['entries']
    if (purpose === 'send') {
      const toSignData = toSignDatas[0]
      if (toSignDatas.length !== 1 || !toSignData?.qbitSendBroadcastClaim) {
        throw new Error('invalid external Qbit send signing request')
      }
      const psbt = qbitPsbtFromHex(toSignData.psbtHex)
      const claim = this.validatedQbitSendBroadcastClaim(
        psbt,
        toSignData.qbitSendBroadcastClaim,
        toSignData.providerContext,
        account.address
      )
      entries = [{ txid: claim.txid, outpoints: claim.outpoints }]
    } else {
      if (
        toSignDatas.some(
          toSignData => toSignData.qbitSendBroadcastClaim || !toSignData.qbitP2mrSigningKeys?.length
        )
      ) {
        throw new Error('invalid external Qbit signing request')
      }
      entries = toSignDatas.map(toSignData => {
        const psbt = qbitPsbtFromHex(toSignData.psbtHex)
        return { txid: qbitPsbtTxid(psbt), outpoints: qbitPsbtOutpoints(psbt) }
      })
    }

    return qbitSendGuardService.acquireExternalSigningLock({
      purpose,
      chain,
      address: account.address,
      origin,
      entries,
    })
  }

  promoteExternalQbitSendBroadcastClaim = async ({
    psbtHex,
    claim,
    lock,
    providerContext,
  }: {
    psbtHex: string
    claim: QbitSendBroadcastClaim
    lock: QbitExternalSigningLock
    providerContext: QbitProviderApprovalContext | undefined
  }): Promise<void> => {
    const account = preferenceService.getCurrentAccount()
    if (!account || getAccountCapabilities(account).signMethod !== AccountSignMethod.External) {
      throw new Error('invalid external Qbit signing request')
    }
    const validatedClaim = this.validatedQbitSendBroadcastClaim(
      qbitPsbtFromHex(psbtHex),
      claim,
      providerContext,
      account.address
    )
    await qbitSendGuardService.promoteExternalSigningLockToBroadcastClaim(
      lock,
      validatedClaim
    )
  }

  releaseQbitSendBroadcastClaim = (claim: QbitSendBroadcastClaim): Promise<boolean> =>
    qbitSendGuardService.releaseBroadcastClaim(claim)

  /**
   * Open the provider sendQbit request whose approval carries `claim`,
   * before the approval is shown. Signing that approval registers the claim
   * under this request, and only while it is open; see
   * `settleQbitProviderSendRequest`.
   */
  openQbitProviderSendRequest = (claim: QbitSendBroadcastClaim): Promise<QbitProviderSendRequest> =>
    qbitSendGuardService.openProviderSendRequest(claim)

  /**
   * Close a provider sendQbit request, successful or not, and decide the
   * claim its approval registered, if it is still held. No page holds a
   * provider send's bytes to retry or abandon them, and the request can fail
   * after signing without any answer from its approval (the user rejected
   * it, or its window closed), so a claim left held would reserve the
   * inputs until the background restarts. `spent` when the request
   * succeeded or its broadcast's outcome is unknown: the claim goes, but its
   * inputs stay reserved as recently spent by its transaction until a
   * lifecycle probe finds it confirmed or gone. Otherwise the claim is
   * released. Only this request's claim is touched.
   */
  settleQbitProviderSendRequest = (
    request: QbitProviderSendRequest,
    spent: boolean
  ): Promise<void> => qbitSendGuardService.settleProviderSendRequest(request, spent)

  /**
   * The UI port the call now executing arrived on, for that call's
   * synchronous prefix only: `runForUiPort` sets it around the call and
   * restores it as soon as the call returns its promise. A method that
   * mints or broadcasts a wallet-owned send claim reads it as its first
   * statement, before any await, so the claim can be tied to the page that
   * holds its signed bytes. Undefined for calls that do not come through a
   * UI port (tests, internal callers), which then own nothing.
   */
  private callingUiPort: QbitSendClaimOwner | undefined

  /**
   * Run one UI request on behalf of the port it arrived on. The messaging
   * layer wraps every controller call from a popup, tab, side panel or
   * notification page in this; see `callingUiPort`.
   */
  runForUiPort = <T>(uiPort: QbitSendClaimOwner, call: () => T): T => {
    const previous = this.callingUiPort
    this.callingUiPort = uiPort
    try {
      return call()
    } finally {
      this.callingUiPort = previous
    }
  }

  /**
   * A UI port disconnected: the popup, tab or side panel closed, or the
   * page navigated away. Any wallet-owned send claim that port was holding
   * lost its signed bytes with the page, so the guard releases the ones no
   * broadcast is still deciding. A claim the guard consumed (its broadcast
   * was accepted, whether or not the answer reached the page) is already
   * gone, and one whose last broadcast was inconclusive keeps its inputs
   * reserved as recently spent until a lifecycle probe settles it.
   */
  onUiPortDisconnected = (uiPort: QbitSendClaimOwner): Promise<void> => {
    this.abandonQbitUtxoSnapshotsOf(uiPort)
    return qbitSendGuardService.releaseClaimsOwnedBy(uiPort)
  }

  /**
   * The calling page dropped the signed bytes behind a wallet-owned send
   * claim without a proven verdict (the recovery screen was left on an
   * unknown outcome) while its UI port stays open. The guard decides the
   * claim as it would on that port's disconnect, so it does not hold the
   * inputs until the page closes: an inconclusive one keeps them reserved
   * as recently spent until a lifecycle probe settles its transaction, and
   * one whose bytes never reached the network is released. Only the port
   * that owns the claim can abandon it.
   */
  abandonQbitSendBroadcastClaim = (claim: QbitSendBroadcastClaim): Promise<void> =>
    qbitSendGuardService.abandonBroadcastClaim(claim, this.callingUiPort)

  releaseExternalQbitSigningLock = (lock: QbitExternalSigningLock): Promise<boolean> =>
    qbitSendGuardService.releaseExternalSigningLock(lock)

  completeExternalQbitSigningLock = async (lock: QbitExternalSigningLock): Promise<void> => {
    const account = preferenceService.getCurrentAccount()
    if (
      !account ||
      getAccountCapabilities(account).signMethod !== AccountSignMethod.External ||
      account.address !== lock.address ||
      !(await qbitSendGuardService.releaseExternalSigningLock(lock))
    ) {
      throw new Error('external Qbit signing lock is not active')
    }
  }

  getDesc = () => {
    return 'desc_test'
  }

  /* wallet */
  boot = (password: string) => keyringService.boot(password)
  isBooted = async () => keyringService.isBooted()

  /** The pending approval's data and the id a window passes back to settle it. */
  getApproval = async () => {
    return approvalService.getApproval()
  }
  /** Settle the approval only while `id` is still the pending one's id (#311). */
  resolveApproval = approvalService.resolveApproval
  rejectApproval = approvalService.rejectApproval

  /**
   * Settles rpcFlow's unlock request ({ lock: true }) once the keyring is
   * unlocked, and nothing else. The check and the resolve run without an
   * await in between, so an unlock can never approve a Connect or SwitchChain
   * request that replaced the unlock request (#267). Returns whether it
   * resolved.
   */
  resolveUnlockApproval = async (): Promise<boolean> => {
    if (!keyringService.memStore.getState().isUnlocked) return false
    const approval = approvalService.getApproval()
    if (!approval || !('lock' in approval.data) || approval.data.lock !== true) return false
    return approvalService.resolveApproval(approval.id)
  }

  hasVault = () => keyringService.hasVault()
  verifyPassword = (password: string) => keyringService.verifyPassword(password)
  changePassword = (password: string, newPassword: string) =>
    keyringService.changePassword(password, newPassword)

  initAlianNames = async () => {
    preferenceService.changeInitAlianNameStatus()
  }

  isReady = () => {
    return true
  }

  private enqueueChainStateChange = <T>(operation: () => Promise<T>): Promise<T> => {
    const queuedOperation = this.chainStateChangeTail.then(operation)
    this.chainStateChangeTail = queuedOperation.then(
      () => undefined,
      () => undefined
    )
    return queuedOperation
  }

  unlock = (password: string): Promise<void> =>
    this.enqueueChainStateChange(() => this.performUnlock(password))

  private performUnlock = async (password: string): Promise<void> => {
    const alianNameInited = preferenceService.getInitAlianNameStatus()
    const alianNames = contactBookService.listAlias()
    let deferredAccountChange: Account | undefined
    await keyringService.submitPassword(password, {
      beforeUnlock: async () => {
        const hdPathChanged = await keyringService.syncQbitHdPath(
          getQbitHdPathForChainType(this.getChainType())
        )

        const keyring = await this.getCurrentKeyring()
        const currentAccount = preferenceService.getCurrentAccount()
        const preferredAccountIndex = currentAccount?.index ?? 0
        const selectedAccountIndex = keyring?.accounts[preferredAccountIndex]
          ? preferredAccountIndex
          : 0
        const selectedAccount = keyring?.accounts[selectedAccountIndex]
        const qbitAccountChanged =
          keyring?.type === KeyringType.QbitHdKeyring &&
          selectedAccount !== undefined &&
          (selectedAccount.pubkey !== currentAccount?.pubkey ||
            selectedAccount.address !== currentAccount?.address)

        if (keyring && selectedAccount && (hdPathChanged || qbitAccountChanged)) {
          await this.changeKeyring(keyring, selectedAccountIndex, {
            broadcastAccountChange: false,
          })
          deferredAccountChange = selectedAccount
        }
      },
    })
    sessionService.broadcastEvent(SESSION_EVENTS.unlock)
    if (deferredAccountChange) {
      this.publishAccountChange(deferredAccountChange)
    }
    if (!alianNameInited && alianNames.length === 0) {
      this.initAlianNames()
    }

    this._resetTimeout()
    this.kickPendingQbitRestoreFloorScan()
  }

  /**
   * Crash recovery: if a restore was interrupted before its floor scan
   * finished, the affected keyring is still sign-locked. Retry the scan in the
   * background after unlock; the gate lifts only when a scan completes.
   */
  private kickPendingQbitRestoreFloorScan = (): void => {
    void this.enqueueChainStateChange(async () => {
      try {
        if (!this.isQbitChain()) return
        if (!(await this.getQbitRestoreFloorsPending())) return
        const summary = await this.performQbitRestoreFloorScan()
        if (summary.possibleConcurrentInstance) {
          // The hazard is latched on the keyring (pqcConcurrentInstanceHint)
          // by the scan itself; surface it in logs too since no report UI is
          // open on this path. F3 renders the persisted hint.
          log.warn(
            'deferred qbit restore floor scan detected activity beyond known indexes',
            summary.gapIndexesWithActivity
          )
        }
      } catch (error) {
        log.warn('deferred qbit restore floor scan failed; signing stays locked', error)
      }
    })
  }

  isUnlocked = () => {
    return keyringService.memStore.getState().isUnlocked
  }

  lockWallet = async () => {
    // A locked wallet keeps no account's outputs in memory, not even while
    // the lock waits or if it fails. setLocked marks the wallet locked at
    // once, before it waits, so nothing is kept after this clear: not from
    // a read that started before it, nor while locked (`qbitAccountUtxosOn`).
    this.qbitLatestUtxoReads.clear()
    await keyringService.setLocked()
    // Locking keeps every grant, so it must not look like a revocation: no
    // accountsChanged [] here. Pages never see the internal lock event.
    sessionService.broadcastEvent(SESSION_EVENTS.lock)
    bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.LOCKED,
      params: {},
    })
  }

  setPopupOpen = (isOpen: boolean) => {
    preferenceService.setPopupOpen(isOpen)
  }

  getAddressBalance = async (address: string) => {
    const data = qbitBalanceToWalletBalance(
      await this.getQbitApiClient().getAddressBalance(address)
    )
    preferenceService.updateAddressBalance(address, data)
    return data
  }

  getAddressBalanceV2 = async (address: string) => {
    const chainType = this.getChainType()
    const currentAccount = preferenceService.getCurrentAccount()
    const p2mrScriptPubKey =
      currentAccount?.address === address ? currentAccount.p2mr?.scriptPubKey : undefined
    // Available is what a send may select, so the outputs the send screen
    // holds back (a claim, an external signing lock or a recent broadcast
    // reserves them; see `excludeGuardedQbitUtxos`) are unavailable here
    // too. The spenders due a probe are looked up while the outputs are
    // listed, and the reservations are read once both are done. The probes
    // never reject.
    //
    // A broadcast holds the guard's queue until the explorer answers it,
    // which can take a minute, so each wait for the guard lasts at most
    // `qbitBalanceGuardWaitMs`. Past that, without the reservations, the
    // split is unknown.
    //
    // Past the explorer's limit the outputs come from the latest output read
    // for this address on this network (see `getQbitUtxoSnapshot`), and only
    // while the statistics still read as they did for it.
    let reservedUnknown = false
    const probed = this.settleQbitRecentSpends(chainType, address, this.qbitBalanceGuardWaitMs)
    const client = this.getQbitApiClient(chainType)
    // Looked up as the statistics are compared, so a read that completes
    // while this balance read runs counts already.
    const readOutputs = (stats: string) => {
      const latest = this.qbitLatestUtxoReads.latest(client, address)
      if (latest?.stats !== stats) return undefined
      return {
        outputs: latest.utxos,
        ...(latest.matureAt !== undefined ? { matureAt: latest.matureAt } : {}),
        ...(latest.matureFrom !== undefined ? { matureFrom: latest.matureFrom } : {}),
      }
    }
    const data = await getQbitSpendableBalanceV2(
      client,
      address,
      p2mrScriptPubKey,
      async () => {
        await probed
        const reserved = await this.qbitGuardReadWithin(
          qbitSendGuardService.getReservedOutpointKeys(chainType, address),
          this.qbitBalanceGuardWaitMs
        )
        if (reserved !== undefined) return reserved
        reservedUnknown = true
        return new Set<string>()
      },
      readOutputs
    )
    if (reservedUnknown) {
      // Shown as `--`, as past the explorer's UTXO limit: the total is
      // measured, and nothing counts as available until a read has the
      // reservations again. An address past the limit keeps
      // `utxoLimitExceeded`, as its total comes from the statistics.
      return {
        availableBalance: null,
        unavailableBalance: Math.max(0, data.totalBalance),
        totalBalance: data.totalBalance,
        immatureBalance: null,
        pendingBalance: null,
        ...(data.utxoLimitExceeded ? { utxoLimitExceeded: true } : {}),
        chainType,
      }
    }
    return { ...data, chainType }
  }

  getMultiAddressSummaries = async (addresses: string) => {
    return getQbitAddressSummaries(this.getQbitApiClient(), addresses)
  }

  findActiveAddressGroups = (
    groups: { type: number; address_arr: string[]; pubkey_arr: string[] }[]
  ) => {
    return findActiveQbitAddressGroups(this.getQbitApiClient(), groups)
  }

  getAddressCacheBalance = (address: string | undefined): QbitBalance => {
    const defaultBalance: QbitBalance = {
      confirm_amount: '0',
      pending_amount: '0',
      amount: '0',
    }
    if (!address) return defaultBalance
    return preferenceService.getAddressBalance(address) || defaultBalance
  }

  private getQbitHistoryScope = async (requestedAddress: string): Promise<QbitHistoryScope> => {
    const chainType = this.getChainType()
    if (!isQbitChainType(chainType)) {
      throw new Error(t('not_supported'))
    }
    const network = chainTypeToQbitNetworkName(chainType)
    const keyring = await this.getCurrentKeyring()
    if (
      this.getChainType() !== chainType ||
      !keyring ||
      keyring.type !== KeyringType.QbitHdKeyring
    ) {
      throw new Error('Qbit history account changed while resolving its addresses')
    }
    const anchorPubkey = keyring.accounts[0]?.pubkey
    if (!isHexByteString(anchorPubkey, 32)) {
      throw new Error('Qbit history account is missing its stable public identity')
    }

    const indexedAddresses = keyring.accounts.map(account => {
      const address = account.p2mr?.addresses[network]
      const index = account.p2mr?.hkdf.index
      if (!address || !Number.isSafeInteger(index) || (index ?? -1) < 0) {
        throw new Error('Qbit history account contains incomplete address metadata')
      }
      return { address, index: index! }
    })
    indexedAddresses.sort(
      (left, right) => left.index - right.index || left.address.localeCompare(right.address)
    )
    const normalizedAddresses = new Set<string>()
    const addresses = indexedAddresses.map(item => {
      const normalized = item.address.toLowerCase()
      if (normalizedAddresses.has(normalized)) {
        throw new Error(`Qbit history account contains duplicate address ${item.address}`)
      }
      normalizedAddresses.add(normalized)
      return item.address
    })
    if (!requestedAddress || !normalizedAddresses.has(requestedAddress.toLowerCase())) {
      throw new Error('Requested Qbit history address is outside the selected account')
    }

    return {
      chainType,
      scopeKey: `qbit:${chainType}:${anchorPubkey.toLowerCase()}`,
      addresses,
      addressFingerprint: JSON.stringify(addresses.map(address => address.toLowerCase())),
    }
  }

  private assertQbitHistoryScopeStillActive = async (expected: QbitHistoryScope): Promise<void> => {
    const currentAddress = preferenceService.getCurrentAccount()?.address
    if (!currentAddress) {
      throw new Error('Qbit history account changed while loading')
    }
    const current = await this.getQbitHistoryScope(currentAddress)
    if (
      current.chainType !== expected.chainType ||
      current.scopeKey !== expected.scopeKey ||
      current.addressFingerprint !== expected.addressFingerprint
    ) {
      throw new Error('Qbit history account or network changed while loading')
    }
  }

  private pruneQbitHistorySnapshots = (now = Date.now()): void => {
    for (const [id, snapshot] of this.qbitHistorySnapshots) {
      if (now - snapshot.createdAt > QBIT_HISTORY_SNAPSHOT_TTL_MS) {
        this.qbitHistorySnapshots.delete(id)
      }
    }
    while (this.qbitHistorySnapshots.size > QBIT_HISTORY_SNAPSHOT_LIMIT) {
      const oldestId = this.qbitHistorySnapshots.keys().next().value
      if (typeof oldestId !== 'string') break
      this.qbitHistorySnapshots.delete(oldestId)
    }
  }

  getAddressHistory = async (params: {
    address: string
    start: number
    limit: number
    snapshotId?: string
    refreshSnapshotId?: string
  }) => {
    if (this.isQbitChain()) {
      if (
        !Number.isSafeInteger(params.start) ||
        params.start < 0 ||
        !Number.isSafeInteger(params.limit) ||
        params.limit < 0
      ) {
        throw new Error('Invalid Qbit history page')
      }
      // Later pages must read from one pinned immutable snapshot; paging
      // without one would full-scan the account per chunk and return rows
      // that need not match the session's page-one data.
      if (params.start !== 0 && !params.snapshotId) {
        throw new Error('Qbit history pages beyond the first require a pinned snapshot')
      }
      const scope = await this.getQbitHistoryScope(params.address)
      this.pruneQbitHistorySnapshots()

      let snapshot: QbitHistorySnapshot | undefined
      if (params.snapshotId) {
        const cached = this.qbitHistorySnapshots.get(params.snapshotId)
        if (
          !cached ||
          cached.scopeKey !== scope.scopeKey ||
          cached.chainType !== scope.chainType ||
          cached.addressFingerprint !== scope.addressFingerprint
        ) {
          throw new Error('Qbit history snapshot is stale or belongs to another account')
        }
        snapshot = cached
      } else {
        let reusable: QbitHistorySnapshot | undefined
        if (params.start === 0 && params.refreshSnapshotId) {
          const cached = this.qbitHistorySnapshots.get(params.refreshSnapshotId)
          if (
            cached &&
            cached.scopeKey === scope.scopeKey &&
            cached.chainType === scope.chainType &&
            cached.addressFingerprint === scope.addressFingerprint &&
            Date.now() - cached.fullScanAt < QBIT_HISTORY_SNAPSHOT_TTL_MS
          ) {
            reusable = cached
          }
        }

        if (reusable) {
          let probeDeferred = false
          let cachedConfirmedHistoryActive = false
          let cachedMempoolMembershipActive = false
          try {
            const client = this.getQbitApiClient(scope.chainType)
            probeDeferred = scope.addresses.length > MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES
            let revision: QbitAccountHistoryRevision
            if (probeDeferred) {
              const ancestry = await probeQbitAccountHistoryAncestry(
                client,
                reusable.revision,
                scope.addresses,
                reusable.list.filter(item => item.confirmations === 0).map(item => item.txid)
              )
              revision = ancestry.revision
              cachedConfirmedHistoryActive = ancestry.cachedConfirmedHistoryActive
              cachedMempoolMembershipActive = ancestry.cachedMempoolMembershipActive
            } else {
              revision = await probeQbitAccountHistoryRevision(client, scope.addresses)
            }
            await this.assertQbitHistoryScopeStillActive(scope)
            // A reorg can drop the refreshed tip below a cached confirmed
            // height. Reusing the cached list would clamp the reverted
            // transaction to one confirmation, so fall through to a full scan.
            const tipCoversCachedHeights = reusable.list.every(
              item => item.height <= 0 || item.height <= revision.tipHeight
            )
            if (
              (probeDeferred
                ? cachedConfirmedHistoryActive && cachedMempoolMembershipActive
                : revision.activityFingerprint === reusable.revision.activityFingerprint) &&
              tipCoversCachedHeights &&
              Date.now() - reusable.fullScanAt < QBIT_HISTORY_SNAPSHOT_TTL_MS
            ) {
              const id = `qbit-history-${++this.qbitHistorySnapshotSequence}`
              snapshot = {
                ...scope,
                id,
                createdAt: Date.now(),
                fullScanAt: reusable.fullScanAt,
                revision,
                list: reusable.list.map(item => {
                  const confirmations =
                    item.height > 0 ? Math.max(1, revision.tipHeight - item.height + 1) : 0
                  return confirmations === item.confirmations ? item : { ...item, confirmations }
                }),
              }
            }
          } catch (error) {
            if (probeDeferred) throw error
            // An invalid or unstable lightweight probe fails closed to the
            // existing complete, stability-checked account scan below.
          }
        }

        if (!snapshot) {
          const data = await getQbitAccountHistory(
            this.getQbitApiClient(scope.chainType),
            scope.addresses,
            { start: 0, limit: Number.MAX_SAFE_INTEGER },
            // Bounded scans at 0/1/3/7/15s cross electrs' 10s response-cache window.
            { stabilityRetries: 4, retryBaseDelayMs: 1_000 }
          )
          await this.assertQbitHistoryScopeStillActive(scope)
          const id = `qbit-history-${++this.qbitHistorySnapshotSequence}`
          const createdAt = Date.now()
          snapshot = {
            ...scope,
            id,
            createdAt,
            fullScanAt: createdAt,
            revision: data.revision,
            list: data.detail,
          }
        }

        this.qbitHistorySnapshots.set(snapshot.id, snapshot)
        this.pruneQbitHistorySnapshots(snapshot.createdAt)
        preferenceService.updateAddressHistory(
          scope.scopeKey,
          snapshot.list.slice(0, QBIT_HISTORY_PERSISTED_CACHE_LIMIT)
        )
      }

      if (!snapshot) {
        throw new Error('Qbit history snapshot was not created')
      }
      return {
        start: params.start,
        total: snapshot.list.length,
        detail: snapshot.list.slice(params.start, params.start + params.limit),
        snapshotId: snapshot.id,
        scopeKey: snapshot.scopeKey,
      }
    }
    throw new Error(t('not_supported'))
  }

  getAddressCacheHistory = async (address: string | undefined): Promise<TxHistoryItem[]> => {
    if (!address) return []
    if (this.isQbitChain()) {
      const scope = await this.getQbitHistoryScope(address)
      return preferenceService.getAddressHistory(scope.scopeKey)
    }
    return preferenceService.getAddressHistory(address)
  }

  getQbitRawTransactionHex = async (txid: string): Promise<string> => {
    const chainType = this.getChainType()
    if (!isQbitChainType(chainType)) {
      throw new Error(t('not_supported'))
    }
    const hex = await getQbitRawTransactionHex(this.getQbitApiClient(chainType), txid)
    if (this.getChainType() !== chainType) {
      throw new Error('Qbit network changed while loading raw transaction data')
    }
    return hex
  }

  /**
   * Probe a transaction's live status for history lifecycle checks. Returns
   * 'gone' when the node no longer knows the tx (evicted/replaced), so callers
   * can distinguish replaced from confirmed-beyond-the-page.
   */
  getQbitTxLifecycleStatus = async (
    txid: string
  ): Promise<{ state: 'confirmed' | 'pending' | 'gone' }> => {
    if (!this.isQbitChain()) {
      throw new Error(t('not_supported'))
    }
    return this.qbitTxLifecycleStatusOn(this.getChainType(), txid)
  }

  /**
   * The same lookup bound to an explicit network. Both requests go through a
   * client resolved from the captured chain, never from whatever network the
   * wallet is on by the time the second request runs, so a switch mid-lookup
   * cannot answer for another chain. Both run under `operation`'s deadline,
   * when the lookup is part of one (a broadcast, a status check).
   */
  private async qbitTxLifecycleStatusOn(
    chain: ChainType,
    txid: string,
    operation: QbitExplorerOperation = new QbitExplorerOperation()
  ): Promise<{ state: 'confirmed' | 'pending' | 'gone' }> {
    try {
      const client = this.getQbitApiClient(chain)
      const status = await client.getTxStatus(txid, operation.read())
      if (status.confirmed) return { state: 'confirmed' }

      // electrs-qbit can retain an evicted transaction's unconfirmed status
      // after RBF even though its full transaction lookup is already gone.
      // Require both live endpoints to agree before reporting pending. Only
      // its existence counts, so the whole transaction, a large-body read,
      // gets a short budget: past it the lookup fails, which is unknown.
      await client.getTx(txid, operation.read(QBIT_LIFECYCLE_TX_READ_DEADLINE_MS))
      return { state: 'pending' }
    } catch (error) {
      if (error instanceof QbitApiError && error.kind === 'not_found' && error.status === 404) {
        return { state: 'gone' }
      }
      throw error
    }
  }

  getExternalLinkAck = () => {
    preferenceService.getExternalLinkAck()
  }

  setExternalLinkAck = ack => {
    preferenceService.setExternalLinkAck(ack)
  }

  getLocale = () => {
    return preferenceService.getLocale()
  }

  setLocale = async (locale: string) => {
    preferenceService.setLocale(locale)
    await bgI18n.changeLanguage(locale)
    bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.LOCALE_CHANGED,
      params: locale,
    })
  }

  getCurrency = () => {
    return preferenceService.getCurrency()
  }

  setCurrency = (currency: string) => {
    preferenceService.setCurrency(currency)
  }

  /* keyrings */

  resetAllData = async () => {
    await keyringService.resetAllData()
    await preferenceService.resetAllData()
    await qbitSendGuardService.resetAllData()
    await permissionService.resetAllData()
    await contactBookService.resetAllData()
    await walletApiService.resetAllData()

    this._resetTimeout()
  }

  getPrivateKey = async (password: string, { pubkey, type }: { pubkey: string; type: string }) => {
    const isValidPassword = await this.verifyPassword(password)
    if (!isValidPassword) {
      throw new Error(t('password_error'))
    }
    if (type !== KeyringType.HdKeyring && type !== KeyringType.SimpleKeyring) {
      throw new Error(t('not_supported'))
    }
    const keyring = await keyringService.getKeyringForAccount(pubkey, type)
    if (!keyring) return null
    const privateKey = await keyring.exportAccount(pubkey)
    const networkType = this.getNetworkType()
    const network = toPsbtNetwork(networkType)
    const hex = privateKey
    const wif = eccManager.eccPair
      .fromPrivateKey(Buffer.from(privateKey, 'hex'), { network })
      .toWIF()
    return {
      hex,
      wif,
    }
  }

  getMnemonics = async (password: string, keyring: WalletKeyring) => {
    const isValidPassword = await this.verifyPassword(password)
    if (!isValidPassword) {
      throw new Error(t('password_error'))
    }
    const originKeyring = keyringService.keyrings[keyring.index]!
    const serialized = await originKeyring.serialize()
    return {
      mnemonic: serialized.mnemonic,
      hdPath: serialized.hdPath,
      passphrase: serialized.passphrase,
    }
  }

  exportP2mrDescriptors = async (
    password: string,
    keyring?: WalletKeyring,
    network?: 'mainnet' | 'testnet4' | 'signet' | 'regtest'
  ) => {
    const isValidPassword = await this.verifyPassword(password)
    if (!isValidPassword) {
      throw new Error(t('password_error'))
    }

    const walletKeyring = keyring || (await this.getCurrentKeyring())
    if (
      !walletKeyring ||
      walletKeyring.type !== KeyringType.QbitHdKeyring ||
      walletKeyring.addressType !== AddressType.P2MR
    ) {
      throw new Error(t('not_supported'))
    }

    const originKeyring = keyringService.keyrings[walletKeyring.index]!
    if (!originKeyring.exportP2mrDescriptors) {
      throw new Error(t('not_supported'))
    }

    return originKeyring.exportP2mrDescriptors(
      network || chainTypeToQbitNetworkName(this.getChainType())
    )
  }

  getPreMnemonics = () => keyringService.getPreMnemonics()
  generatePreMnemonic = async (strength?: 128 | 256) => {
    return await keyringService.generatePreMnemonic(strength)
  }
  removePreMnemonics = () => keyringService.removePreMnemonics()
  createKeyringWithMnemonics = async (
    mnemonic: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    accountCount: number,
    accountIndexDerivation = false,
    options?: { pqcFloorsPending?: boolean }
  ) => {
    hdPath = resolveHdPathForAddressType(addressType, hdPath, this.getChainType())
    const originKeyring = await keyringService.createKeyringWithMnemonics(
      mnemonic,
      hdPath,
      passphrase,
      addressType,
      accountCount,
      accountIndexDerivation,
      options
    )
    keyringService.removePreMnemonics()

    const displayedKeyring = await keyringService.displayForKeyring(
      originKeyring,
      addressType,
      keyringService.keyrings.length - 1
    )
    const keyring = this.displayedKeyringToWalletKeyring(
      displayedKeyring,
      keyringService.keyrings.length - 1
    )

    await this.changeKeyring(keyring)

    preferenceService.setShowSafeNotice(true)
  }

  createTmpKeyringWithMnemonics = async (
    mnemonic: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    accountCount = 1,
    accountIndexDerivation = false
  ) => {
    hdPath = resolveHdPathForAddressType(addressType, hdPath, this.getChainType())
    const activeIndexes: number[] = []
    for (let i = 0; i < accountCount; i++) {
      activeIndexes.push(i)
    }
    const originKeyring = keyringService.createTmpKeyring(
      addressType === AddressType.P2MR ? KeyringType.QbitHdKeyring : KeyringType.HdKeyring,
      {
        mnemonic,
        activeIndexes,
        hdPath,
        passphrase,
        accountIndexDerivation,
      }
    )
    const displayedKeyring = await keyringService.displayForKeyring(originKeyring, addressType, -1)
    return this.displayedKeyringToWalletKeyring(displayedKeyring, -1, false)
  }

  createTmpKeyringWithMnemonics2 = async (
    mnemonic: string,
    passphrase: string,
    hdPaths: string[],
    addressTypes: AddressType[]
  ) => {
    const keyrings: WalletKeyring[] = []
    const activeIndexes: number[] = [0]
    let originKeyring
    let originKeyringType: string | undefined
    for (let i = 0; i < hdPaths.length; i++) {
      const addressType = addressTypes[i]!
      const hdPath = resolveHdPathForAddressType(addressType, hdPaths[i]!, this.getChainType())
      const keyringType =
        addressType === AddressType.P2MR ? KeyringType.QbitHdKeyring : KeyringType.HdKeyring
      if (!originKeyring || originKeyringType !== keyringType) {
        originKeyring = await keyringService.createTmpKeyring(keyringType, {
          mnemonic,
          activeIndexes,
          hdPath,
          passphrase,
        })
        originKeyringType = keyringType
      } else {
        originKeyring.changeHdPath(hdPath)
      }
      const displayedKeyring = await keyringService.displayForKeyring(
        originKeyring,
        addressType,
        -1
      )
      const keyring = this.displayedKeyringToWalletKeyring(displayedKeyring, -1, false)
      keyrings.push(keyring)
    }
    return keyrings
  }

  private observeQbitAccountActivityForNetwork = (
    client: QbitPqcHistoryClient,
    qbitNetwork: 'mainnet' | 'testnet4' | 'regtest'
  ) => {
    return async (account: {
      index?: number
      addresses?: Record<string, string>
      scriptPubKey?: string
    }): Promise<QbitPqcSignatureActivity> => {
      const address = account.addresses?.[qbitNetwork]
      if (!address || !account.scriptPubKey) {
        throw new Error(`qbit account is missing a ${qbitNetwork} address or script`)
      }
      const activity = await observeQbitPqcSignatureActivity(
        client,
        address,
        account.scriptPubKey,
        QBIT_FLOOR_SCAN_STABILITY_RETRIES
      )
      if (activity.floorSource === 'address-stats') {
        log.warn(
          `qbit restore floor for account ${account.index} on ${qbitNetwork} read from address statistics: its history is too long to enumerate`
        )
      }
      return activity
    }
  }

  private observeQbitAccountActivityForNetworks = (
    networks: readonly {
      client: QbitPqcHistoryClient
      name: 'mainnet' | 'testnet4' | 'regtest'
      required: boolean
    }[]
  ) => {
    const observers = networks.map(({ client, name, required }) => ({
      name,
      required,
      observe: this.observeQbitAccountActivityForNetwork(client, name),
      unavailable: false,
    }))
    return async (account: {
      index?: number
      addresses?: Record<string, string>
      scriptPubKey?: string
    }): Promise<QbitPqcSignatureActivity> => {
      const activity = (
        await Promise.all(
          observers.map(async observer => {
            if (observer.unavailable) return undefined
            try {
              return await observer.observe(account)
            } catch (error) {
              if (observer.required) throw error
              observer.unavailable = true
              log.warn(
                `optional ${observer.name} qbit restore history is unavailable; continuing with the active network`,
                error
              )
              return undefined
            }
          })
        )
      ).filter((observation): observation is QbitPqcSignatureActivity => observation !== undefined)
      const observedSignatures = activity.reduce(
        (total, observation) => total + observation.observedSignatures,
        0
      )
      if (!Number.isSafeInteger(observedSignatures)) {
        throw new Error('qbit signature activity exceeds the safe counter range')
      }
      const floorSource = activity.some(observation => observation.floorSource === 'address-stats')
        ? 'address-stats'
        : 'history'
      // The sum is the floor the keyring applies, so statistics floors that
      // each stay below the warning threshold must not reach it together.
      if (floorSource === 'address-stats') {
        assertQbitStatsFloorBelowWarningThreshold(
          observedSignatures,
          `qbit account ${account.index} floors summed across networks`
        )
      }
      return {
        // Testnet4 and regtest share a derivation path and therefore a PQC
        // counter. Summing is conservative if the same spend appears on both
        // chains: over-advancing a counter is safe, while under-advancing is not.
        observedSignatures,
        hasActivity: activity.some(observation => observation.hasActivity),
        floorSource,
      }
    }
  }

  /**
   * Reconstruct PQC signature-counter floors for every Qbit keyring still
   * gated by a pending restore. Clears the signing gate on success; on failure
   * the gate stays closed and the caller may retry.
   */
  runQbitRestoreFloorScan = (options?: { lookahead?: number }) =>
    this.enqueueChainStateChange(() => this.performQbitRestoreFloorScan(options))

  /**
   * Same-HD-path Qbit networks whose histories may inform a restore floor
   * scan. The scan sends every derived address and script to each listed
   * endpoint, so the local regtest sibling joins only when the loopback
   * capability (browser permission, acknowledgement and verified service
   * identity) is available right now — the same gate every entry into regtest
   * passes. Without it, a Testnet4 restore would hand wallet identifiers to
   * whatever is listening on the loopback port and let that service influence
   * the observed floor. Regtest as the *active* chain already passed the gate
   * on entry and stays the required observer.
   */
  private resolveQbitRestoreFloorScanChainTypes = async (
    chainType: ChainType
  ): Promise<readonly ChainType[]> => {
    const candidates = qbitChainTypesSharingHdPath(chainType)
    if (
      chainType === ChainType.QBIT_REGTEST ||
      !candidates.includes(ChainType.QBIT_REGTEST) ||
      !regtestAccessService.isSupported()
    ) {
      return candidates
    }
    let available = false
    try {
      available = (await regtestAccessService.refresh({ verify: true })).state === 'available'
    } catch (error) {
      log.warn(
        '[WalletController] Regtest capability check failed; omitting regtest history from the floor scan',
        summarizeError(error)
      )
    }
    return available
      ? candidates
      : candidates.filter(candidate => candidate !== ChainType.QBIT_REGTEST)
  }

  private performQbitRestoreFloorScan = async (options?: { lookahead?: number }) => {
    if (!this.isQbitChain()) {
      throw new Error(t('not_supported'))
    }
    const chainType = this.getChainType()
    const qbitNetwork = chainTypeToQbitNetworkName(chainType)
    const networks = (await this.resolveQbitRestoreFloorScanChainTypes(chainType)).map(
      candidate => ({
        client: this.getQbitApiClient(candidate) as unknown as QbitPqcHistoryClient,
        name: chainTypeToQbitNetworkName(candidate),
        // The active chain is authoritative for completing this restore.
        // Same-path sibling histories improve the floor when reachable, but a
        // local development endpoint must not permanently gate a production
        // Testnet4 restore.
        required: candidate === chainType,
      })
    )
    const observe = this.observeQbitAccountActivityForNetworks(networks)

    const pendingKeyrings = keyringService.keyrings.filter(
      keyring => keyring.type === KeyringType.QbitHdKeyring && keyring.pqcFloorsPending === true
    )
    const scans: {
      floors: { observedCounter: number; counterProvenance: string }[]
      floorSources: QbitRestoreFloorSourceRecord[]
      gapIndexesWithActivity: number[]
      possibleConcurrentInstance: boolean
    }[] = []
    const failures: unknown[] = []
    for (const keyring of pendingKeyrings) {
      const [firstAccount] = await keyring.getAccounts()
      if (!firstAccount) continue
      try {
        scans.push(
          await keyringService.restorePqcSignatureCounterFloors(
            firstAccount,
            observe,
            options?.lookahead === undefined ? undefined : { lookahead: options.lookahead }
          )
        )
      } catch (error) {
        // Isolate per-keyring failures so one unreachable history cannot keep
        // every other pending keyring sign-locked; the failed keyring's gate
        // stays closed and the aggregate error below preserves retry semantics.
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      const first = failures[0]
      throw first instanceof Error
        ? first
        : new Error(`qbit restore floor scan failed for ${failures.length} keyring(s)`)
    }

    const floors = scans.flatMap(scan => scan.floors)
    return {
      network: qbitNetwork,
      keyringsScanned: scans.length,
      accountsScanned: floors.length,
      totalObservedSignatures: floors.reduce((sum, floor) => sum + floor.observedCounter, 0),
      restoredFloorCount: floors.filter(floor => floor.counterProvenance === 'restored-floor')
        .length,
      floorSources: scans.flatMap(scan => scan.floorSources),
      gapIndexesWithActivity: [...new Set(scans.flatMap(scan => scan.gapIndexesWithActivity))],
      possibleConcurrentInstance: scans.some(scan => scan.possibleConcurrentInstance),
    }
  }

  /** True while any Qbit keyring refuses to sign pending restore floor reconstruction. */
  getQbitRestoreFloorsPending = async (): Promise<boolean> => {
    return keyringService.keyrings.some(
      keyring => keyring.type === KeyringType.QbitHdKeyring && keyring.pqcFloorsPending === true
    )
  }

  /**
   * True when any floor scan has ever observed activity beyond a Qbit
   * keyring's known indexes — the persisted two-live-wallets hazard hint,
   * latched even when the scan completed on a deferred (unlock/chain-switch)
   * path with no restore report open.
   */
  getQbitConcurrentInstanceHint = async (): Promise<boolean> => {
    return keyringService.keyrings.some(
      keyring =>
        keyring.type === KeyringType.QbitHdKeyring && keyring.pqcConcurrentInstanceHint === true
    )
  }

  // The migration screen captures its source wallet when the user navigates
  // to it and keeps calling in with that numeric index for as long as it
  // stays mounted, while keyring removal compacts indexes underneath it. Map
  // the anchor identity captured at navigation back to a current index when
  // an operation starts instead of trusting the captured slot; callers that
  // pass no identity keep the index-only behavior.
  private resolveQbitRecoverySourceIndex = async (
    sourceKeyringIndex: number,
    sourceAnchorPubkey?: string
  ): Promise<number> => {
    if (!sourceAnchorPubkey) return sourceKeyringIndex
    const match = (await this.getKeyrings()).find(
      keyring =>
        keyring.type === KeyringType.QbitHdKeyring &&
        keyring.accounts[0]?.pubkey?.toLowerCase() === sourceAnchorPubkey.toLowerCase()
    )
    if (!match) {
      throw new Error('Qbit recovery keyring is unavailable')
    }
    return match.index
  }

  private getQbitKeyringByIndex = async (keyringIndex: number): Promise<WalletKeyring> => {
    const keyring = (await this.getKeyrings()).find(candidate => candidate.index === keyringIndex)
    if (
      !keyring ||
      keyring.type !== KeyringType.QbitHdKeyring ||
      keyring.addressType !== AddressType.P2MR ||
      !keyring.accounts[0]?.p2mr
    ) {
      throw new Error('Qbit recovery keyring is unavailable')
    }
    return keyring
  }

  getQbitRecoveryState = async (
    keyringIndex?: number,
    anchorPubkey?: string
  ): Promise<QbitRecoveryState> => {
    const keyring =
      keyringIndex === undefined
        ? await this.getCurrentKeyring()
        : await this.getQbitKeyringByIndex(
            await this.resolveQbitRecoverySourceIndex(keyringIndex, anchorPubkey)
          )
    const anchor = keyring?.accounts[0]
    if (!keyring || keyring.type !== KeyringType.QbitHdKeyring || !anchor?.p2mr) {
      return {
        status: 'clean',
        acknowledgement: 'accepted',
        counterConfidence: 'local',
        knownOnChainSignatures: 0,
      }
    }
    return keyringService.getQbitRecoveryState(
      anchor.address,
      chainTypeToQbitNetworkName(this.getChainType())
    )
  }

  acknowledgeQbitRecoveryRisk = async (
    keyringIndex: number,
    anchorPubkey?: string
  ): Promise<QbitRecoveryState> => {
    const keyring = await this.getQbitKeyringByIndex(
      await this.resolveQbitRecoverySourceIndex(keyringIndex, anchorPubkey)
    )
    const state = await keyringService.acknowledgeQbitRecoveryRisk(
      keyring.accounts[0]!.address,
      chainTypeToQbitNetworkName(this.getChainType())
    )
    bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.ACCOUNTS_CHANGED,
      params: await this.getCurrentAccount(),
    })
    return state
  }

  dismissQbitRecoveryWarning = async (
    keyringIndex: number,
    anchorPubkey?: string
  ): Promise<QbitRecoveryState> => {
    const keyring = await this.getQbitKeyringByIndex(
      await this.resolveQbitRecoverySourceIndex(keyringIndex, anchorPubkey)
    )
    const state = await keyringService.dismissQbitRecoveryWarning(
      keyring.accounts[0]!.address,
      chainTypeToQbitNetworkName(this.getChainType())
    )
    bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.ACCOUNTS_CHANGED,
      params: await this.getCurrentAccount(),
    })
    return state
  }

  confirmQbitRestoredFloorSigning = (challengeId: string): Promise<void> =>
    keyringService.confirmQbitRestoredFloorSigning(challengeId)

  releaseQbitRestoredFloorSigningChallenges = (challengeIds: readonly string[]): void =>
    keyringService.releaseQbitRestoredFloorSigningChallenges(challengeIds)

  createQbitRecoveryMigrationWallet = (data: {
    sourceKeyringIndex: number
    sourceAnchorPubkey?: string
    mnemonic: string
    hdPath: string
    passphrase: string
  }): Promise<QbitRecoveryState> =>
    this.enqueueChainStateChange(() => this.performCreateQbitRecoveryMigrationWallet(data))

  private performCreateQbitRecoveryMigrationWallet = async ({
    sourceKeyringIndex: requestedSourceIndex,
    sourceAnchorPubkey,
    mnemonic,
    hdPath,
    passphrase,
  }: {
    sourceKeyringIndex: number
    sourceAnchorPubkey?: string
    mnemonic: string
    hdPath: string
    passphrase: string
  }): Promise<QbitRecoveryState> => {
    if (!this.isQbitChain()) throw new Error(t('not_supported'))
    const sourceKeyringIndex = await this.resolveQbitRecoverySourceIndex(
      requestedSourceIndex,
      sourceAnchorPubkey
    )
    const source = await this.getQbitKeyringByIndex(sourceKeyringIndex)
    const sourceAccountIndex = Math.max(
      0,
      source.accounts.findIndex(
        account => account.address === preferenceService.getCurrentAccount()?.address
      )
    )
    // The caller only reaches this path after the user backed up and
    // confirmed this mnemonic, so it must become the destination wallet.
    // Reusing a prior network's destination instead would silently discard
    // a seed the user now believes holds the migrated funds; that reuse is
    // its own explicit flow (beginQbitRecoveryMigrationToExistingDestination).
    await keyringService.createQbitMigrationKeyring({
      sourceAddress: source.accounts[0]!.address,
      mnemonic,
      hdPath: resolveHdPathForAddressType(AddressType.P2MR, hdPath, this.getChainType()),
      passphrase,
      network: chainTypeToQbitNetworkName(this.getChainType()),
    })
    keyringService.removePreMnemonics()

    // Creating the destination must not silently move the active account away
    // from the recovered source before its migration review is complete.
    const refreshedSource = await this.getQbitKeyringByIndex(sourceKeyringIndex)
    await this.changeKeyring(refreshedSource, sourceAccountIndex)
    return this.getQbitRecoveryState(sourceKeyringIndex)
  }

  beginQbitRecoveryMigrationToExistingDestination = (data: {
    sourceKeyringIndex: number
    sourceAnchorPubkey?: string
  }): Promise<QbitRecoveryState> =>
    this.enqueueChainStateChange(() =>
      this.performBeginQbitRecoveryMigrationToExistingDestination(data)
    )

  private performBeginQbitRecoveryMigrationToExistingDestination = async ({
    sourceKeyringIndex: requestedSourceIndex,
    sourceAnchorPubkey,
  }: {
    sourceKeyringIndex: number
    sourceAnchorPubkey?: string
  }): Promise<QbitRecoveryState> => {
    if (!this.isQbitChain()) throw new Error(t('not_supported'))
    const sourceKeyringIndex = await this.resolveQbitRecoverySourceIndex(
      requestedSourceIndex,
      sourceAnchorPubkey
    )
    const source = await this.getQbitKeyringByIndex(sourceKeyringIndex)
    const existingDestination = await this.resolveExistingQbitRecoveryDestination(source)
    if (!existingDestination) {
      // The recorded destination no longer resolves (e.g. deleted); the
      // caller falls back to the fresh-wallet path. The code distinguishes
      // this deliberate signal from transient begin failures, which must not
      // route the UI into the fresh-seed flow.
      throw new WalletError(
        ErrorCodes.QBIT_RECOVERY_DESTINATION_UNAVAILABLE,
        'Qbit recovery migration destination is unavailable'
      )
    }
    await keyringService.beginQbitRecoveryMigrationToExistingDestination({
      sourceAddress: source.accounts[0]!.address,
      network: chainTypeToQbitNetworkName(this.getChainType()),
      destinationPubkey: existingDestination.anchor.pubkey,
      destinationAddress: existingDestination.anchor.address,
    })
    return this.getQbitRecoveryState(sourceKeyringIndex)
  }

  /**
   * Locate the destination wallet a prior network's migration recorded, by
   * anchor identity rather than stored index (re-deriving under the recorded
   * network's coin type when the active chain differs). Returns undefined
   * when no other network recorded a destination, or the recorded wallet no
   * longer exists or is not a healthy non-restored Qbit wallet — the caller
   * then falls back to creating a fresh destination.
   */
  private resolveExistingQbitRecoveryDestination = async (
    source: WalletKeyring
  ): Promise<{ keyring: WalletKeyring; anchor: Account } | undefined> => {
    const sourceAnchor = source.accounts[0]
    if (!sourceAnchor) return undefined
    const state = await keyringService.getQbitRecoveryVaultState(sourceAnchor.address)
    if (!state?.networks) return undefined
    const activeNetwork = chainTypeToQbitNetworkName(this.getChainType())
    const currentKeyrings = await this.getKeyrings()
    for (const network of Object.keys(state.networks) as (keyof typeof state.networks)[]) {
      const migration = network === activeNetwork ? undefined : state.networks[network]?.migration
      if (!migration) continue
      let destinationIndex: number | undefined
      try {
        destinationIndex = await this.resolveQbitMigrationDestinationIndex(
          migration,
          currentKeyrings
        )
      } catch {
        continue
      }
      if (destinationIndex === undefined || destinationIndex === source.index) continue
      const destination = currentKeyrings.find(candidate => candidate.index === destinationIndex)
      const destinationAnchor = destination?.accounts[0]
      const raw = keyringService.keyrings[destinationIndex]
      if (
        !destination ||
        destination.type !== KeyringType.QbitHdKeyring ||
        !destinationAnchor?.p2mr ||
        !raw ||
        raw.pqcRestoredFromMnemonic === true ||
        raw.pqcFloorsPending === true ||
        raw.getQbitRecoveryState?.() !== undefined
      ) {
        continue
      }
      return { keyring: destination, anchor: destinationAnchor }
    }
    return undefined
  }

  private assertQbitRecoveryMigrationPlanIntent = (
    account: Account,
    plan: QbitRecoveryMigrationPlanVault
  ) => {
    if (!account.p2mr) {
      throw new Error('Qbit recovery migration account is unavailable')
    }
    const psbt = qbitPsbtFromHex(plan.psbtHex)
    const decoded = decodeQbitPsbt(psbt)
    const expectedSourceScript = account.p2mr.scriptPubKey.toLowerCase()
    const expectedDestinationScript = qbitBytesToHex(
      addressToScriptPk(plan.destinationAddress, this.getNetworkType())
    )
    const fee = Number(decoded.fee)
    const valid =
      decoded.inputs.length > 0 &&
      decoded.inputs.every(
        input =>
          input.sequence === QBIT_P2MR_RBF_SEQUENCE &&
          input.witnessUtxo !== undefined &&
          qbitBytesToHex(input.witnessUtxo.scriptPubKey) === expectedSourceScript
      ) &&
      decoded.outputs.length === 1 &&
      qbitBytesToHex(decoded.outputs[0]!.scriptPubKey) === expectedDestinationScript &&
      Number(decoded.outputs[0]!.value) === plan.amount &&
      Number.isSafeInteger(fee) &&
      fee === plan.fee
    if (!valid) {
      throw new Error('Qbit recovery migration transaction does not match the reviewed intent')
    }
    return { psbt, decoded }
  }

  /**
   * Trust derivation, not the vault record: the plan's pay-to address must be
   * the destination keyring's own account at the plan's destination index
   * (version-1 consolidated plans implicitly paid the anchor, index 0), derived
   * for the migration's network right now.
   */
  private assertQbitRecoveryMigrationPlanDestination = async (
    migration: QbitRecoveryMigrationVault,
    plan: QbitRecoveryMigrationPlanVault,
    destinationKeyringIndex: number
  ): Promise<void> => {
    const destinationIndex = plan.destinationIndex ?? 0
    const destinationRaw = keyringService.keyrings[destinationKeyringIndex]
    const derived = await destinationRaw?.getQbitReceiveAccount?.(destinationIndex)
    const expectedPubkey = (plan.destinationPubkey ?? migration.destinationPubkey).toLowerCase()
    if (
      !derived ||
      derived.pubkey?.toLowerCase() !== expectedPubkey ||
      derived.addresses?.[migration.network] !== plan.destinationAddress
    ) {
      throw new Error('Qbit recovery migration destination does not match its derivation')
    }
  }

  /** Derivation index of a displayed P2MR account, from its recorded path. */
  private qbitP2mrDerivationIndex(account: Account): number {
    const segment = account.p2mr?.path?.split('/').pop()
    const index =
      segment !== undefined && /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : NaN
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('Qbit recovery migration account is unavailable')
    }
    return index
  }

  private qbitRecoveryMigrationToSignData = async (
    sourceKeyring: WalletKeyring,
    state: QbitRecoveryNetworkVaultState,
    plan: QbitRecoveryMigrationPlanVault,
    destinationKeyringIndex: number
  ): Promise<ToSignData> => {
    const migration = state.migration
    const account = sourceKeyring.accounts.find(
      candidate =>
        candidate.address === plan.sourceAddress &&
        candidate.pubkey.toLowerCase() === plan.sourcePubkey.toLowerCase()
    )
    if (!migration || !account?.p2mr) {
      throw new Error('Qbit recovery migration account is unavailable')
    }
    await this.assertQbitRecoveryMigrationPlanDestination(migration, plan, destinationKeyringIndex)
    const { psbt, decoded } = this.assertQbitRecoveryMigrationPlanIntent(account, plan)
    const inputCount = decoded.inputs.length
    const leafHash = qbitBytesToHex(
      p2mrLeafHash(P2MR_LEAF_VERSION_V1, qbitHexToBytes(account.p2mr.leafScript))
    )
    const qbitP2mrSigningKeys = Array.from({ length: inputCount }, (_value, inputIndex) => ({
      inputIndex,
      publicKey: account.pubkey,
      leafHash,
    }))
    const signatureBudget = await keyringService.preflightP2mrPsbtSigning(
      account.address,
      {
        psbt,
        keys: qbitSigningKeysFromSerializable(qbitP2mrSigningKeys),
      },
      // The migration screen re-preflights every prepared plan on each poll;
      // scoping reuse to the plan keeps polling from minting challenges to
      // capacity while still giving unrelated requests their own challenge.
      { reuseScope: `qbit-recovery-migration:${plan.id}` }
    )
    const qbitRecoveryMigration: QbitRecoveryMigrationSigningData = {
      sourceKeyringIndex: sourceKeyring.index,
      destinationKeyringIndex,
      network: migration.network,
      planId: plan.id,
      sourceAddress: plan.sourceAddress,
      destinationAddress: plan.destinationAddress,
      ...(plan.destinationIndex !== undefined
        ? { destinationIndex: plan.destinationIndex }
        : {}),
    }
    return {
      psbtHex: plan.psbtHex,
      toSignInputs: qbitP2mrSigningKeys.map(key => ({
        index: key.inputIndex,
        publicKey: key.publicKey,
      })),
      qbitP2mrSigningKeys,
      signatureBudget,
      autoFinalized: true,
      estimatedFee: plan.fee,
      qbitRecoveryMigration,
      action: {
        name: t('qbit_recovery_migration_action'),
        description: t('qbit_recovery_migration_consequence'),
        details: [
          {
            label: t('to'),
            value: plan.destinationAddress,
            type: PsbtActionDetailType.ADDRESS,
          },
          {
            label: t('amount'),
            value: plan.amount,
            type: PsbtActionDetailType.SATOSHIS,
          },
          {
            label: t('network_fee'),
            value: plan.fee,
            type: PsbtActionDetailType.SATOSHIS,
          },
        ],
        type: PsbtActionType.CUSTOM,
      },
    }
  }

  private loadQbitRecoveryMigration = async (sourceKeyringIndex: number) => {
    const sourceKeyring = await this.getQbitKeyringByIndex(sourceKeyringIndex)
    const anchor = sourceKeyring.accounts[0]!
    const network = chainTypeToQbitNetworkName(this.getChainType())
    const vaultState = (await keyringService.getQbitRecoveryVaultState(
      anchor.address
    )) as QbitRecoveryVaultState
    const state = vaultState?.networks?.[network] as QbitRecoveryNetworkVaultState
    if (!state?.migration || (state.status !== 'migrating' && state.status !== 'migrated')) {
      throw new Error('Qbit recovery migration is unavailable')
    }
    // The record's key is authoritative, but the inner network field must
    // agree before any plan built for another chain can be touched.
    if (state.migration.network !== network) {
      throw new Error('Qbit recovery migration is unavailable')
    }
    const publicState = await keyringService.getQbitRecoveryState(anchor.address, network)
    const destinationKeyringIndex = publicState.migration?.destinationKeyringIndex
    if (destinationKeyringIndex === undefined) {
      throw new Error('Fresh Qbit migration wallet is unavailable')
    }
    const destination = await this.getQbitKeyringByIndex(destinationKeyringIndex)
    if (
      !destination.accounts.some(
        account =>
          account.address === state.migration!.destinationAddress &&
          account.pubkey.toLowerCase() === state.migration!.destinationPubkey.toLowerCase()
      )
    ) {
      throw new Error('Fresh Qbit migration wallet is unavailable')
    }
    return { sourceKeyring, anchor, network, state, destination, destinationKeyringIndex }
  }

  // Kept as an instance seam so migration safety logic stays testable against
  // simulated protected coverage; production coverage always comes from the
  // chain-verified classifier, never from an unsupported asset endpoint.
  private getQbitProtectedAssetCoverage = async (
    outpoints: readonly QbitOutpoint[]
  ): Promise<QbitProtectedAssetCoverage> =>
    classifyQbitProtectedAssetCoverage(this.getQbitApiClient(this.getChainType()), outpoints)

  private toQbitRecoveryUnspentOutputs(account: Account, utxos: readonly UTXO[]): UnspentOutput[] {
    return utxos.map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      scriptPk: utxo.scriptPk,
      addressType: utxo.addressType,
      pubkey: account.pubkey,
    }))
  }

  /**
   * Inputs for one source account's sweep plans, in batches that each fit one
   * standard transaction. The inputs fill the fewest batches that hold them,
   * spread so the batches are even in value as well as in size. Inputs worth
   * no more than the fee they add are left out. A batch too small to pay a
   * dust output is dropped and its inputs fill any room left in the others,
   * or form full batches of their own; whatever cannot pay a dust output
   * stays in the source for a later pass.
   */
  private selectQbitRecoverySweepBatches(
    account: Account,
    utxos: readonly UnspentOutput[],
    destinationAddress: string,
    feeRate: number
  ): UnspentOutput[][] {
    if (!account.p2mr || utxos.length === 0) return []
    if (!utxos.every(utxo => isQbitRecoverySweepInput(account, utxo))) {
      throw new Error('Qbit recovery migration UTXO data is invalid')
    }

    const shape = {
      outputScriptLengths: [addressToScriptPk(destinationAddress, this.getNetworkType()).length],
      leafScriptLength: qbitHexToBytes(account.p2mr.leafScript).length,
      controlBlockLength: buildControlBlock(P2MR_LEAF_VERSION_V1, []).length,
      feeRate,
    }
    const inputFee = qbitP2mrInputFee(shape)
    const worthSweeping = sortQbitCoinsByValue(utxos).filter(utxo => utxo.satoshis > inputFee)
    const maxInputCount = qbitP2mrMaxStandardInputCount(shape)
    if (worthSweeping.length === 0 || maxInputCount === 0) return []
    const batchCount = Math.ceil(worthSweeping.length / maxInputCount)
    const batches = Array.from({ length: batchCount }, () => ({
      utxos: [] as UnspentOutput[],
      net: 0,
    }))
    // Each input, largest first, joins the batch with room whose value so far
    // is lowest, so a run of small outputs is spread over batches that can pay
    // a dust output instead of being grouped into one that cannot.
    for (const utxo of worthSweeping) {
      const target = batches
        .filter(batch => batch.utxos.length < maxInputCount)
        .reduce((lowest, batch) => (batch.net < lowest.net ? batch : lowest))
      target.utxos.push(utxo)
      target.net += utxo.satoshis - inputFee
    }
    const paysDust = (batch: readonly UnspentOutput[]) => {
      const totalInput = batch.reduce((sum, utxo) => sum + utxo.satoshis, 0)
      if (!Number.isSafeInteger(totalInput)) {
        throw new Error('Qbit recovery migration balance is invalid')
      }
      const { fee } = estimateQbitP2mrTransaction({ ...shape, inputCount: batch.length })
      return totalInput - fee >= QBIT_P2MR_DUST
    }
    const kept = batches.map(batch => batch.utxos).filter(paysDust)
    // Each input adds more than its fee, so a dropped batch's inputs still
    // raise the output of any kept batch with room. Those that do not fit
    // are grouped largest first into full batches; these shrink in value, so
    // once one cannot pay a dust output none after it can.
    const spare = sortQbitCoinsByValue(
      batches
        .map(batch => batch.utxos)
        .filter(batch => !kept.includes(batch))
        .flat()
    )
    let next = 0
    for (; next < spare.length; next += 1) {
      const target = kept.find(batch => batch.length < maxInputCount)
      if (!target) break
      target.push(spare[next]!)
    }
    for (; next < spare.length; next += maxInputCount) {
      const batch = spare.slice(next, next + maxInputCount)
      if (!paysDust(batch)) break
      kept.push(batch)
    }
    return kept
  }

  /**
   * A recovery source's classified outputs, or why they are unknown: the
   * explorer will not list them, and their history is too long to read them
   * from, or, with `deferIncompleteHistory`, could not be read in full
   * through the read's own retries. Such a source is never planned or counted
   * as swept, so its funds keep the migration open. A history too long may
   * consolidate meanwhile (#344); one not read in full is read again by the
   * next pass. Any other failure still fails the pass.
   */
  private readQbitRecoverySourceUtxos = async (
    client: QbitWalletApiClient,
    address: string,
    { deferIncompleteHistory }: { deferIncompleteHistory: boolean }
  ): Promise<QbitClassifiedUtxos | QbitRecoveryDeferredSource> => {
    try {
      return await getQbitAddressUtxosClassifiedPastLimit(client, address)
    } catch (error) {
      if (error instanceof QbitUtxoHistoryTooLargeError) {
        return { address, reason: 'history_too_large', maxTransactions: error.maxTransactions }
      }
      // Only the history read, past the listing limit, fails this way.
      if (deferIncompleteHistory && isQbitSnapshotUnstableError(error)) {
        return { address, reason: 'history_incomplete' }
      }
      throw error
    }
  }

  /**
   * Whether a plan's transaction fits the standard weight once signed. Every
   * plan input is a single-key P2MR spend from its source account, so the
   * exact size follows from the input and output counts.
   */
  private qbitRecoveryPlanIsStandardSize(plan: QbitRecoveryMigrationPlanVault): boolean {
    let decoded: ReturnType<typeof decodeQbitPsbt>
    try {
      decoded = decodeQbitPsbt(qbitPsbtFromHex(plan.psbtHex))
    } catch {
      // Malformed plans are refused by the intent check before any signing.
      return true
    }
    if (decoded.inputs.length === 0 || decoded.outputs.length === 0) return true
    return isQbitStandardTxSize(qbitP2mrFinalizedVsize(decoded))
  }

  private qbitRecoveryUtxosNeedMigration(
    account: Account,
    utxos: readonly UnspentOutput[],
    destinationAddress: string
  ): boolean {
    if (utxos.length === 0) return false
    if (!account.p2mr) return true
    // A read-only check: an output the sweep would refuse needs attention,
    // as an unreadable source does. Only the sweep itself refuses.
    if (!utxos.every(utxo => isQbitRecoverySweepInput(account, utxo))) return true
    return (
      this.selectQbitRecoverySweepBatches(
        account,
        utxos,
        destinationAddress,
        QBIT_RECOVERY_MIGRATION_RELAY_FEE_RATE
      ).length > 0
    )
  }

  private assertQbitRecoveryAddressDiscoveryComplete(state: QbitRecoveryNetworkVaultState): void {
    if (!state.addressDiscoveryComplete) {
      throw new Error('Qbit recovery address discovery is incomplete')
    }
  }

  /**
   * Resume a truncated restore discovery for a migrating source. A rescan
   * that ends on a complete trailing gap persists discovery completeness so
   * migration can archive; newly discovered activity instead activates those
   * accounts so later passes can sweep them before completion is reconsidered.
   */
  private resumeQbitRecoveryAddressDiscovery = async (
    sourceKeyringIndex: number
  ): Promise<{ discoveredNewAccounts: boolean }> => {
    const chainType = this.getChainType()
    const network = chainTypeToQbitNetworkName(chainType)
    const rawKeyring = keyringService.keyrings[sourceKeyringIndex]
    if (!rawKeyring?.getQbitReceiveAccount) {
      throw new Error('Qbit recovery address discovery is incomplete')
    }
    const sourceKeyring = await this.getQbitKeyringByIndex(sourceKeyringIndex)
    const anchor = sourceKeyring.accounts[0]!
    const deriveAddresses = async (count: number): Promise<string[]> => {
      const addresses: string[] = []
      for (let index = 0; index < count; index += 1) {
        const account = await rawKeyring.getQbitReceiveAccount!(index)
        const address = account?.addresses?.[network]
        if (!address) {
          throw new Error(`derived qbit account is missing a ${network} address`)
        }
        addresses.push(address)
      }
      return addresses
    }

    const discovery = await discoverQbitActiveIndexes(
      this.getQbitApiClient(chainType),
      deriveAddresses,
      {
        maxIndexes: Math.max(
          DEFAULT_QBIT_RESTORE_MAX_INDEXES,
          sourceKeyring.accounts.length + DEFAULT_QBIT_RESTORE_GAP_LIMIT
        ),
      }
    )

    const discoveredNewAccounts = discovery.highestActiveIndex + 1 > sourceKeyring.accounts.length
    if (discoveredNewAccounts) {
      // Newly discovered accounts may carry spent history, and activation
      // seeds them with a zero counter floor. Sign-lock the source before
      // activating them so nothing can sign from that default until the
      // rescan below reconstructs and persists their real floors.
      await keyringService.rearmQbitRestoreFloorsForKeyring(anchor.address)
      while ((await rawKeyring.getAccounts()).length < discovery.highestActiveIndex + 1) {
        await keyringService.addNewAccount(rawKeyring)
      }
    }
    if (discovery.activeIndexes.length > 0) {
      await keyringService.recordQbitReceiveActivity(
        anchor.pubkey,
        network,
        discovery.activeIndexes
      )
    }
    if (!discovery.truncated) {
      await keyringService.completeQbitRecoveryAddressDiscovery(anchor.address, network)
    }
    if (discoveredNewAccounts) {
      await this.performQbitRestoreFloorScan()
    }
    return { discoveredNewAccounts }
  }

  // Sweep plans are signed once and afterwards only rebroadcast
  // byte-for-byte, and the migrating-wallet signing gate blocks the ordinary
  // fee-bump flow; a plan priced at the relay floor could therefore stay
  // unmineable indefinitely whenever the clearing rate is higher. New plans
  // take the live normal estimate, floored at the relay rate, which the
  // unavailable-quote fallback also quotes.
  private resolveQbitRecoveryMigrationFeeRate = async (): Promise<number> => {
    try {
      const feeSummary = await this.getFeeSummary()
      const normalFeeRate = feeSummary.list[1]?.feeRate
      if (isQbitFeeRateWithinPolicy(normalFeeRate)) {
        return Math.max(normalFeeRate, QBIT_RECOVERY_MIGRATION_RELAY_FEE_RATE)
      }
    } catch {
      // An unavailable estimate degrades to the relay floor below.
    }
    return QBIT_RECOVERY_MIGRATION_RELAY_FEE_RATE
  }

  prepareQbitRecoveryMigration = async (
    sourceKeyringIndex: number,
    feeRate?: number,
    sourceAnchorPubkey?: string
  ): Promise<QbitRecoveryMigrationPreparation> =>
    this.enqueueChainStateChange(() =>
      this.performPrepareQbitRecoveryMigration(sourceKeyringIndex, feeRate, sourceAnchorPubkey)
    )

  private performPrepareQbitRecoveryMigration = async (
    requestedSourceIndex: number,
    feeRate?: number,
    sourceAnchorPubkey?: string
  ): Promise<QbitRecoveryMigrationPreparation> => {
    const sourceKeyringIndex = await this.resolveQbitRecoverySourceIndex(
      requestedSourceIndex,
      sourceAnchorPubkey
    )
    const { sourceKeyring, anchor, network, state, destinationKeyringIndex } =
      await this.loadQbitRecoveryMigration(sourceKeyringIndex)
    if (state.status === 'migrated') {
      return { state: await this.getQbitRecoveryState(sourceKeyringIndex), toSignDatas: [] }
    }

    // A plan prepared before sweeps were split into standard-size batches can
    // exceed the standard weight, which no node relays and the keyring will
    // not sign. Unsigned, it has spent nothing. It is never offered for
    // signing; once every other plan is done its inputs are planned again
    // below in batches, and it leaves the vault in the same write that stores
    // them, so a pass that fails first keeps it and the destination account
    // its source reserved.
    const oversizedPlans = state.migration!.plans.filter(
      plan => plan.status === 'prepared' && !this.qbitRecoveryPlanIsStandardSize(plan)
    )
    const oversizedPlanIds = new Set(oversizedPlans.map(plan => plan.id))
    const incompletePlans = state.migration!.plans.filter(
      plan => plan.status !== 'confirmed' && !oversizedPlanIds.has(plan.id)
    )
    if (incompletePlans.length > 0) {
      const prepared = incompletePlans
        .filter(plan => plan.status === 'prepared')
        .slice(0, QBIT_RECOVERY_MIGRATION_PREFLIGHT_BATCH_SIZE)
      return {
        state: await this.getQbitRecoveryState(sourceKeyringIndex),
        toSignDatas: await Promise.all(
          prepared.map(plan =>
            this.qbitRecoveryMigrationToSignData(
              sourceKeyring,
              state,
              plan,
              destinationKeyringIndex
            )
          )
        ),
      }
    }
    const keptPlans = state.migration!.plans.filter(plan => !oversizedPlanIds.has(plan.id))

    const resolvedFeeRate = feeRate ?? (await this.resolveQbitRecoveryMigrationFeeRate())
    if (!resolvedFeeRate || !Number.isFinite(resolvedFeeRate) || resolvedFeeRate <= 0) {
      throw new Error('Unable to determine a valid fee rate.')
    }

    const destinationRawKeyring = keyringService.keyrings[destinationKeyringIndex]
    if (!destinationRawKeyring?.getQbitReceiveAccount) {
      throw new Error('Fresh Qbit migration wallet is unavailable')
    }

    const newPlans: QbitRecoveryMigrationPlanVault[] = []
    const allocatedPlanIds = new Set(state.migration!.plans.map(plan => plan.id))
    // Per-account sweep: each funded source account pays its own destination
    // account, never a shared address a common destination would use to
    // publicly link every source account. Destination indexes are allocated
    // contiguously rather than copied from the source: only funded accounts
    // produce plans, so source history can carry funds at an index (say 50)
    // far beyond the last *funded* predecessor, and a standard gap-limit
    // restore of the fresh seed would stop scanning before reaching a copy of
    // that index. Each plan records the source→destination mapping. A source
    // account that already has a persisted plan keeps its destination account
    // (reopened migrations must not scatter one source across destinations),
    // and indexes the destination's receive ledger already handed out or
    // already carrying on-chain activity are not paid a fresh sweep — a sweep
    // landing on a shared receive address would defeat single-use hygiene
    // from the other side.
    const receiveLedger = destinationRawKeyring.getQbitReceiveState?.(network)
    const ledgerKnownIndexes = new Set<number>([
      ...(receiveLedger?.issuedIndexes ?? []),
      ...(receiveLedger?.usedIndexes ?? []),
    ])
    const occupiedDestinationIndexes = new Set<number>(ledgerKnownIndexes)
    // Indexes a restore scan can anchor on: observed on-chain activity plus
    // every planned sweep — a migration only completes once each plan
    // confirms, so planned indexes will carry activity. Issued-but-unfunded
    // receive intents deliberately stay out: they leave no on-chain trace for
    // a scan of the bare seed to extend past.
    const fundedDestinationIndexes = new Set<number>(receiveLedger?.usedIndexes ?? [])
    const pairedDestinationIndexes = new Map<string, number>()
    for (const plan of keptPlans) {
      // Version-1 consolidated plans without a recorded index paid the anchor,
      // so their source is already publicly linked to destination index 0.
      occupiedDestinationIndexes.add(plan.destinationIndex ?? 0)
      fundedDestinationIndexes.add(plan.destinationIndex ?? 0)
      pairedDestinationIndexes.set(plan.sourcePubkey, plan.destinationIndex ?? 0)
    }
    // A source whose oversized plan is being dropped keeps the destination
    // account that plan reserved, so its batches do not burn a fresh index.
    // Its batches are planned in this pass, so the index counts as funded and
    // the gap fallback never hands it to another source.
    for (const plan of oversizedPlans) {
      if (pairedDestinationIndexes.has(plan.sourcePubkey)) continue
      occupiedDestinationIndexes.add(plan.destinationIndex ?? 0)
      fundedDestinationIndexes.add(plan.destinationIndex ?? 0)
      pairedDestinationIndexes.set(plan.sourcePubkey, plan.destinationIndex ?? 0)
    }
    const nextDestinationIndex = (): number => {
      let candidate = 0
      while (occupiedDestinationIndexes.has(candidate)) candidate += 1
      let previousFunded = -1
      for (const funded of fundedDestinationIndexes) {
        if (funded < candidate && funded > previousFunded) previousFunded = funded
      }
      if (candidate <= previousFunded + QBIT_RECEIVE_GAP_LIMIT) return candidate
      // Every index between the last funded predecessor and the candidate is
      // issued but unfunded, so a sweep at the candidate would sit past the
      // trailing gap a standard restore of the fresh seed scans. Fund the
      // oldest such index instead: reusing a handed-out receive address costs
      // single-use hygiene once, an undiscoverable sweep forfeits the funds
      // in every later restore. The lowest unfunded index always sits within
      // the window (everything below it is funded), and once it is funded the
      // following allocations anchor on it and proceed contiguously. Prefer
      // not to pay the address currently presented on screen.
      const reusable = [...occupiedDestinationIndexes]
        .filter(index => !fundedDestinationIndexes.has(index))
        .sort((left, right) => left - right)
      const preferred = reusable.find(index => index !== receiveLedger?.currentIndex)
      const fallback = preferred ?? reusable[0]
      if (fallback === undefined) {
        // Unreachable: a candidate past the funded window implies unfunded
        // occupied indexes exist below it.
        throw new Error('Qbit migration destination allocation is unavailable')
      }
      return fallback
    }
    let hasDeferredFunds = false
    const deferredSources: QbitRecoveryDeferredSource[] = []
    for (const account of sourceKeyring.accounts) {
      if (!account.p2mr) continue
      const sourceIndex = this.qbitP2mrDerivationIndex(account)
      const sourcePubkey = account.pubkey.toLowerCase()
      const destinationIndex =
        pairedDestinationIndexes.get(sourcePubkey) ?? nextDestinationIndex()
      const destinationAccount = await destinationRawKeyring.getQbitReceiveAccount(destinationIndex)
      const destinationAddress = destinationAccount?.addresses?.[network]
      const destinationPubkey = destinationAccount?.pubkey?.toLowerCase()
      if (typeof destinationAddress !== 'string' || typeof destinationPubkey !== 'string') {
        throw new Error('Fresh Qbit migration wallet has no destination account')
      }
      // The sweep's inputs are classified on this network; the builder
      // below refuses them if the wallet has moved to another one since.
      const utxoChain = this.getChainType()
      const classifiedUtxos = await this.readQbitRecoverySourceUtxos(
        this.getQbitApiClient(utxoChain),
        account.address,
        { deferIncompleteHistory: true }
      )
      if ('reason' in classifiedUtxos) {
        // Its outputs are unknown, so none of them is planned and the
        // migration stays open. The other sources are planned as usual.
        hasDeferredFunds = true
        deferredSources.push(classifiedUtxos)
        continue
      }
      // Immature coinbase rewards cannot enter a sweep plan yet, but they are
      // still source funds: keep the migration open until they mature.
      hasDeferredFunds ||= classifiedUtxos.immature.length > 0
      // An unconfirmed parent can be evicted or replaced, which would strand
      // the immutable signed sweep spending it as permanently `gone` with no
      // conflicting spend for recovery to detect. Only confirmed outputs
      // enter durable plans; pending ones keep the migration open instead.
      hasDeferredFunds ||= classifiedUtxos.unconfirmedSpendable.length > 0
      const rawUtxos = classifiedUtxos.spendable
      const protectedAssetCoverage = await this.getQbitProtectedAssetCoverage(rawUtxos)
      if (protectedAssetCoverage.assetCount > 0) {
        // The code is the UI contract; the message is a log-only fallback.
        throw new WalletError(
          ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS,
          'Protected assets must be moved separately before archiving this wallet'
        )
      }
      const confirmedUtxos = classifiedUtxos.confirmedSpendable
      if (confirmedUtxos.length === 0) continue
      const utxos = this.toQbitRecoveryUnspentOutputs(account, confirmedUtxos)
      const availableUtxos = await this.excludeGuardedQbitUtxos(
        utxoChain,
        account.address,
        utxos
      )
      // One plan per batch: an account holding more outputs than one standard
      // transaction can spend is swept by several plans to the same destination.
      const batches = this.selectQbitRecoverySweepBatches(
        account,
        availableUtxos,
        destinationAddress,
        resolvedFeeRate
      )
      if (batches.length === 0) {
        hasDeferredFunds ||= this.qbitRecoveryUtxosNeedMigration(
          account,
          utxos,
          destinationAddress
        )
        continue
      }
      for (const selectedUtxos of batches) {
        const toSignData = await this.createSendAllQbitPsbtForAccount(
          {
            to: destinationAddress,
            feeRate: resolvedFeeRate,
            qbitUtxos: selectedUtxos,
            qbitUtxoChain: utxoChain,
            qbitUtxoAddress: account.address,
            enableRBF: true,
          },
          account,
          {
            preflight: false,
            reservationsAlreadyFiltered: true,
          }
        )
        const fee = toSignData.estimatedFee
        if (!Number.isSafeInteger(fee) || !fee || fee <= 0) {
          throw new Error('Qbit recovery migration fee is unavailable')
        }
        const preparedPsbt = decodeQbitPsbt(qbitPsbtFromHex(toSignData.psbtHex))
        const amount =
          preparedPsbt.outputs.length === 1 ? Number(preparedPsbt.outputs[0]!.value) : NaN
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new Error('Qbit recovery migration amount is unavailable')
        }
        const planIdPrefix = `${sourcePubkey}:`
        let nextPlanSequence = 0n
        for (const existingPlan of [...state.migration!.plans, ...newPlans]) {
          if (
            existingPlan.sourcePubkey !== sourcePubkey ||
            !existingPlan.id.startsWith(planIdPrefix)
          ) {
            continue
          }
          const suffix = existingPlan.id.slice(planIdPrefix.length)
          if (!/^\d+$/.test(suffix)) continue
          const candidate = BigInt(suffix) + 1n
          if (candidate > nextPlanSequence) nextPlanSequence = candidate
        }
        let planId = `${planIdPrefix}${nextPlanSequence}`
        while (allocatedPlanIds.has(planId)) {
          nextPlanSequence += 1n
          planId = `${planIdPrefix}${nextPlanSequence}`
        }
        if (planId.length > 200) {
          throw new Error('Qbit recovery migration plan identifier is unavailable')
        }
        allocatedPlanIds.add(planId)
        occupiedDestinationIndexes.add(destinationIndex)
        fundedDestinationIndexes.add(destinationIndex)
        pairedDestinationIndexes.set(sourcePubkey, destinationIndex)
        newPlans.push({
          id: planId,
          sourcePubkey,
          sourceAddress: account.address,
          destinationAddress,
          amount,
          fee,
          psbtHex: toSignData.psbtHex,
          status: 'prepared',
          sourceIndex,
          destinationIndex,
          destinationPubkey,
        })
      }
    }

    if (newPlans.length === 0) {
      const client = this.getQbitApiClient(this.getChainType())
      const hasPendingSpenders = (
        await Promise.all(
          sourceKeyring.accounts.map(account =>
            qbitAddressHasUnconfirmedSpends(client, account.address)
          )
        )
      ).some(Boolean)
      if (hasDeferredFunds || hasPendingSpenders) {
        return {
          state: await this.getQbitRecoveryState(sourceKeyringIndex),
          toSignDatas: [],
          deferredSources,
        }
      }
      let completionState = state
      if (!completionState.addressDiscoveryComplete) {
        const { discoveredNewAccounts } =
          await this.resumeQbitRecoveryAddressDiscovery(sourceKeyringIndex)
        if (discoveredNewAccounts) {
          return {
            state: await this.getQbitRecoveryState(sourceKeyringIndex),
            toSignDatas: [],
            deferredSources,
          }
        }
        completionState = (await keyringService.getQbitRecoveryVaultState(anchor.address))
          ?.networks?.[network] as QbitRecoveryNetworkVaultState
      }
      this.assertQbitRecoveryAddressDiscoveryComplete(completionState)
      if (oversizedPlanIds.size > 0) {
        // Nothing is left to sweep, so no batch replaces them.
        await keyringService.replaceQbitRecoveryMigrationPlans(anchor.address, network, keptPlans)
      }
      // The scans above verified completion on-chain (no sweepable UTXOs, no
      // protected assets, no pending spenders), which is what allows archiving
      // past a plan record that lost a malformed entry.
      const completed = await keyringService.markQbitRecoveryMigrated(anchor.address, network, {
        allowIncompletePlanRecord: true,
      })
      await this.activateQbitMigrationDestination(completed)
      return { state: completed, toSignDatas: [], deferredSources }
    }

    // Activate destination accounts up to the highest allocated destination
    // index so the recorded mapping is visible in the destination wallet.
    // Batched plans of one source share its destination index.
    const newDestinationIndexes = [...new Set(newPlans.map(plan => plan.destinationIndex!))]
    const highestDestinationIndex = Math.max(...newDestinationIndexes)
    while ((await destinationRawKeyring.getAccounts()).length <= highestDestinationIndex) {
      await keyringService.addNewAccount(destinationRawKeyring)
    }
    const destinationAnchor = await destinationRawKeyring.getQbitReceiveAccount(0)
    if (typeof destinationAnchor?.pubkey !== 'string') {
      throw new Error('Fresh Qbit migration wallet is unavailable')
    }

    // The destination receive-ledger reservations and the plans that pay them
    // commit as one vault write: reserving first would durably burn the
    // indexes if the conflict check or plan persistence threw, and enough
    // burned indexes would walk later allocations past the window a standard
    // gap-limit restore of the fresh seed scans. The receive flow still never
    // hands out an address a sweep is about to pay — the combined mutation
    // holds the receive-intent lock and re-checks the ledger before
    // committing.
    const planOutpoints = newPlans.flatMap(plan => qbitPsbtOutpoints(qbitPsbtFromHex(plan.psbtHex)))
    // An oversized plan whose source yielded no batch this pass (its outputs
    // guarded by a recent spend, say) stays, so the source keeps its
    // destination account until its batches are planned.
    const replannedSources = new Set(newPlans.map(plan => plan.sourcePubkey))
    const remainingPlans = state.migration!.plans.filter(
      plan => !oversizedPlanIds.has(plan.id) || !replannedSources.has(plan.sourcePubkey)
    )
    const nextState = await this.runWithNoQbitInputConflict(
      this.getChainType(),
      planOutpoints,
      () =>
        keyringService.replaceQbitRecoveryMigrationPlansWithDestinationReservations(
          anchor.address,
          network,
          [...remainingPlans, ...newPlans],
          {
            anchor: destinationAnchor.pubkey,
            // Indexes the destination ledger tracked when allocation started
            // are deliberate reuses (paired re-sweeps, gap-bound fallbacks);
            // everything else must still be fresh at commit time.
            reserveIndexes: newDestinationIndexes.filter(
              index => !ledgerKnownIndexes.has(index)
            ),
            reuseIndexes: newDestinationIndexes.filter(index => ledgerKnownIndexes.has(index)),
          }
        )
    )
    const persistedState = (await keyringService.getQbitRecoveryVaultState(anchor.address))
      ?.networks?.[network] as QbitRecoveryNetworkVaultState
    return {
      state: nextState,
      toSignDatas: await Promise.all(
        newPlans.slice(0, QBIT_RECOVERY_MIGRATION_PREFLIGHT_BATCH_SIZE).map(plan =>
          this.qbitRecoveryMigrationToSignData(
            sourceKeyring,
            persistedState,
            plan,
            destinationKeyringIndex
          )
        )
      ),
      deferredSources,
    }
  }

  private validateQbitRecoveryMigrationSigning = async (
    binding: QbitRecoveryMigrationSigningData,
    toSignData: ToSignData
  ): Promise<{
    account: Account
    anchorAddress: string
    network: QbitReceiveNetworkName
    plan: QbitRecoveryMigrationPlanVault
  }> => {
    const { sourceKeyring, anchor, network, state, destinationKeyringIndex } =
      await this.loadQbitRecoveryMigration(binding.sourceKeyringIndex)
    if (state.status !== 'migrating') {
      throw new Error('Qbit recovery migration is not active')
    }
    const migration = state.migration!
    const plan = migration.plans.find(candidate => candidate.id === binding.planId)
    const account = sourceKeyring.accounts.find(
      candidate => candidate.address === binding.sourceAddress
    )
    if (
      !plan ||
      plan.status !== 'prepared' ||
      !account?.p2mr ||
      binding.destinationKeyringIndex !== destinationKeyringIndex ||
      binding.network !== migration.network ||
      binding.sourceAddress !== plan.sourceAddress ||
      binding.destinationAddress !== plan.destinationAddress ||
      binding.destinationIndex !== plan.destinationIndex ||
      toSignData.psbtHex.toLowerCase() !== plan.psbtHex
    ) {
      throw new Error('Qbit recovery migration signing data changed after review')
    }
    await this.assertQbitRecoveryMigrationPlanDestination(migration, plan, destinationKeyringIndex)
    const { decoded } = this.assertQbitRecoveryMigrationPlanIntent(account, plan)
    const expectedLeafHash = qbitBytesToHex(
      p2mrLeafHash(P2MR_LEAF_VERSION_V1, qbitHexToBytes(account.p2mr.leafScript))
    )
    const signingKeys = toSignData.qbitP2mrSigningKeys || []
    const signingInputs = toSignData.toSignInputs || []
    if (
      signingKeys.length !== decoded.inputs.length ||
      signingInputs.length !== decoded.inputs.length ||
      signingKeys.some(
        (key, index) =>
          key.inputIndex !== index ||
          key.publicKey.toLowerCase() !== plan.sourcePubkey ||
          key.leafHash.toLowerCase() !== expectedLeafHash ||
          key.hashType !== undefined
      ) ||
      signingInputs.some(
        (input, index) =>
          input.index !== index || input.publicKey?.toLowerCase() !== plan.sourcePubkey
      )
    ) {
      throw new Error('Qbit recovery migration signing plan is incomplete')
    }
    return { account, anchorAddress: anchor.address, network, plan }
  }

  private activateQbitMigrationDestination = async (state: QbitRecoveryState): Promise<void> => {
    if (state.status !== 'migrated' || !state.migration) return
    const migration = state.migration
    const destination = await this.getQbitKeyringByIndex(migration.destinationKeyringIndex)
    // Per-account sweeps pay each funded source its own destination account,
    // so the index-0 anchor may have received nothing. Land on the
    // lowest-index destination account a sweep actually paid; the anchor
    // remains for version-1 consolidated plans and sweep-less archives.
    const activationAddress =
      migration.plans
        .filter(plan => plan.destinationIndex !== undefined)
        .sort((a, b) => a.destinationIndex! - b.destinationIndex!)[0]?.destinationAddress ??
      migration.destinationAddress
    const accountIndex = destination.accounts.findIndex(
      account => account.address === activationAddress
    )
    if (accountIndex < 0) throw new Error('Fresh Qbit migration destination is unavailable')
    await this.changeKeyring(destination, accountIndex)
  }

  advanceQbitRecoveryMigration = async (
    sourceKeyringIndex: number,
    sourceAnchorPubkey?: string
  ): Promise<QbitRecoveryState> =>
    this.enqueueChainStateChange(() =>
      this.performAdvanceQbitRecoveryMigration(sourceKeyringIndex, sourceAnchorPubkey)
    )

  private performAdvanceQbitRecoveryMigration = async (
    requestedSourceIndex: number,
    sourceAnchorPubkey?: string
  ): Promise<QbitRecoveryState> => {
    const sourceKeyringIndex = await this.resolveQbitRecoverySourceIndex(
      requestedSourceIndex,
      sourceAnchorPubkey
    )
    let { sourceKeyring, anchor, network, state } =
      await this.loadQbitRecoveryMigration(sourceKeyringIndex)
    if (state.status === 'migrated') {
      const reorged: string[] = []
      for (const plan of state.migration!.plans) {
        if (!plan.txid) continue
        const lifecycle = await this.getQbitTxLifecycleStatus(plan.txid)
        if (lifecycle.state !== 'confirmed') reorged.push(plan.id)
      }
      const newlyReceived = await Promise.all(
        (await this.getQbitKeyringByIndex(sourceKeyringIndex)).accounts.map(async account => {
          const client = this.getQbitApiClient(this.getChainType())
          // Outputs too many to read may be new funds: the migration reopens,
          // and its preparation reports the source. A read that only did not
          // settle is no such evidence, so it fails the check, and nothing
          // reopens.
          const classifiedUtxos = await this.readQbitRecoverySourceUtxos(client, account.address, {
            deferIncompleteHistory: false,
          })
          if ('reason' in classifiedUtxos) {
            return { account, unreadable: true as const }
          }
          const rawUtxos = classifiedUtxos.spendable
          return {
            account,
            protectedAssetCount: (await this.getQbitProtectedAssetCoverage(rawUtxos)).assetCount,
            hasUnconfirmedSpends: await qbitAddressHasUnconfirmedSpends(client, account.address),
            hasImmatureFunds: classifiedUtxos.immature.length > 0,
            utxos: this.toQbitRecoveryUnspentOutputs(account, rawUtxos),
          }
        })
      )
      const needsMigration = newlyReceived.some(
        received =>
          'unreadable' in received ||
          received.protectedAssetCount > 0 ||
          received.hasUnconfirmedSpends ||
          received.hasImmatureFunds ||
          this.qbitRecoveryUtxosNeedMigration(
            received.account,
            received.utxos,
            state.migration!.destinationAddress
          )
      )
      if (reorged.length === 0 && !needsMigration) {
        const completed = await this.getQbitRecoveryState(sourceKeyringIndex)
        await this.activateQbitMigrationDestination(completed)
        return completed
      }
      await keyringService.reopenQbitRecoveryMigration(anchor.address, network, reorged)
      ;({ sourceKeyring, anchor, network, state } =
        await this.loadQbitRecoveryMigration(sourceKeyringIndex))
    }

    const plansToReplan = new Set<string>()
    for (const plan of state.migration!.plans) {
      if (plan.status === 'prepared') continue
      if (!plan.txid || !plan.signedPsbtHex) {
        throw new Error('Signed Qbit recovery migration data is incomplete')
      }
      let lifecycle = await this.getQbitTxLifecycleStatus(plan.txid)
      let planStatus = plan.status
      if (planStatus === 'confirmed' && lifecycle.state !== 'confirmed') {
        await keyringService.updateQbitRecoveryMigrationPlan(anchor.address, network, plan.id, {
          status: 'broadcast',
          signedPsbtHex: plan.signedPsbtHex,
          txid: plan.txid,
        })
        // Fall through with the downgraded status so a transaction that was
        // reorged out entirely is rebroadcast in this same pass.
        planStatus = 'broadcast'
      }
      if ((planStatus === 'signed' || planStatus === 'broadcast') && lifecycle.state === 'gone') {
        try {
          const broadcastTxid = await this.pushTx(plan.signedPsbtHex)
          if (
            typeof broadcastTxid === 'string' &&
            broadcastTxid.toLowerCase() !== plan.txid.toLowerCase()
          ) {
            throw new Error('Qbit recovery migration broadcast returned a different transaction')
          }
        } catch (error) {
          lifecycle = await this.getQbitTxLifecycleStatus(plan.txid)
          if (lifecycle.state === 'gone') {
            // A plan over the standard weight (signed before sweeps were
            // split into batches) can never relay, whatever this attempt's
            // error was: the node refuses it as `tx-size`, or the explorer
            // refuses the request body first. A plan is only ever rebroadcast
            // byte-for-byte, so every later attempt would fail too: retire it
            // and let the next prepare plan its inputs again in batches.
            if (
              isQbitTxSizeBroadcastRejection(error) ||
              !this.qbitRecoveryPlanIsStandardSize(plan)
            ) {
              plansToReplan.add(plan.id)
              continue
            }
            const account = sourceKeyring.accounts.find(
              candidate =>
                candidate.address === plan.sourceAddress &&
                candidate.pubkey.toLowerCase() === plan.sourcePubkey.toLowerCase()
            )
            if (!account?.p2mr) {
              throw new Error('Qbit recovery migration account is unavailable')
            }
            const { psbt } = this.assertQbitRecoveryMigrationPlanIntent(account, plan)
            const spentOutpoints = await observeQbitPqcSpentOutpoints(
              this.getQbitApiClient(this.getChainType()),
              plan.sourceAddress,
              account.p2mr.scriptPubKey
            )
            const planOutpoints = qbitPsbtOutpoints(psbt)
            const hasConflictingSpend = planOutpoints.some(input => {
              const spendingTxid = spentOutpoints.get(`${input.txid.toLowerCase()}:${input.vout}`)
              return spendingTxid !== undefined && spendingTxid !== plan.txid!.toLowerCase()
            })
            // A funding parent reorged out and replaced leaves no spender
            // evidence for its outputs, yet the sweep spending them can never
            // confirm; without this check the permanently failing rebroadcast
            // would pin the incomplete plan forever and block re-planning. An
            // input whose funding transaction no longer exists retires the
            // plan like a conflicting spend does — whatever the source holds
            // now is re-planned by the next prepare, and funds that resurface
            // after archival reopen the migration through the migrated-state
            // rescan.
            let hasVanishedInput = false
            if (!hasConflictingSpend) {
              for (const input of planOutpoints) {
                if (spentOutpoints.has(`${input.txid.toLowerCase()}:${input.vout}`)) continue
                if ((await this.getQbitTxLifecycleStatus(input.txid)).state === 'gone') {
                  hasVanishedInput = true
                  break
                }
              }
            }
            if (!hasConflictingSpend && !hasVanishedInput) throw error
            plansToReplan.add(plan.id)
            continue
          }
        }
        lifecycle = await this.getQbitTxLifecycleStatus(plan.txid)
      }
      if (planStatus === 'signed' && lifecycle.state !== 'gone') {
        await keyringService.updateQbitRecoveryMigrationPlan(anchor.address, network, plan.id, {
          status: 'broadcast',
          signedPsbtHex: plan.signedPsbtHex,
          txid: plan.txid,
        })
        if (lifecycle.state === 'confirmed') {
          await keyringService.updateQbitRecoveryMigrationPlan(anchor.address, network, plan.id, {
            status: 'confirmed',
            signedPsbtHex: plan.signedPsbtHex,
            txid: plan.txid,
          })
        }
      } else if (planStatus === 'broadcast' && lifecycle.state === 'confirmed') {
        await keyringService.updateQbitRecoveryMigrationPlan(anchor.address, network, plan.id, {
          status: 'confirmed',
          signedPsbtHex: plan.signedPsbtHex,
          txid: plan.txid,
        })
      }
    }

    state = (await keyringService.getQbitRecoveryVaultState(anchor.address))?.networks?.[
      network
    ] as QbitRecoveryNetworkVaultState
    if (plansToReplan.size > 0) {
      if (!state.migration) {
        throw new Error('Qbit recovery migration is unavailable')
      }
      await keyringService.replaceQbitRecoveryMigrationPlans(
        anchor.address,
        network,
        state.migration.plans.filter(plan => !plansToReplan.has(plan.id))
      )
      return this.getQbitRecoveryState(sourceKeyringIndex)
    }
    if (state.migration?.plans.every(plan => plan.status === 'confirmed')) {
      const remaining = await Promise.all(
        (await this.getQbitKeyringByIndex(sourceKeyringIndex)).accounts.map(async account => {
          const client = this.getQbitApiClient(this.getChainType())
          const classifiedUtxos = await this.readQbitRecoverySourceUtxos(client, account.address, {
            deferIncompleteHistory: true,
          })
          // A source whose outputs it cannot read is not swept yet;
          // preparation reports it.
          if ('reason' in classifiedUtxos) {
            return { account, unreadable: true as const }
          }
          const rawUtxos = classifiedUtxos.spendable
          return {
            account,
            protectedAssetCount: (await this.getQbitProtectedAssetCoverage(rawUtxos)).assetCount,
            // An in-flight spender (e.g. a reviewed protected-asset move that
            // is not tracked as a migration plan) hides its inputs from the
            // UTXO scan, so archiving must wait until it confirms or is
            // evicted and returns those inputs to the scan.
            hasUnconfirmedSpends: await qbitAddressHasUnconfirmedSpends(client, account.address),
            // Immature coinbase rewards are excluded from the sweepable set,
            // yet archiving with them present would strand source funds.
            hasImmatureFunds: classifiedUtxos.immature.length > 0,
            utxos: this.toQbitRecoveryUnspentOutputs(account, rawUtxos),
          }
        })
      )
      if (
        remaining.every(
          left =>
            !('unreadable' in left) &&
            left.protectedAssetCount === 0 &&
            !left.hasUnconfirmedSpends &&
            !left.hasImmatureFunds &&
            !this.qbitRecoveryUtxosNeedMigration(
              left.account,
              left.utxos,
              state.migration!.destinationAddress
            )
        )
      ) {
        if (!state.addressDiscoveryComplete) {
          const { discoveredNewAccounts } =
            await this.resumeQbitRecoveryAddressDiscovery(sourceKeyringIndex)
          if (discoveredNewAccounts) {
            return this.getQbitRecoveryState(sourceKeyringIndex)
          }
          state = (await keyringService.getQbitRecoveryVaultState(anchor.address))?.networks?.[
            network
          ] as QbitRecoveryNetworkVaultState
          if (!state?.migration) {
            throw new Error('Qbit recovery migration is unavailable')
          }
        }
        this.assertQbitRecoveryAddressDiscoveryComplete(state)
        // The remaining-funds scan just verified completion on-chain, which is
        // what allows archiving past a plan record that lost a malformed entry.
        const completed = await keyringService.markQbitRecoveryMigrated(anchor.address, network, {
          allowIncompletePlanRecord: true,
        })
        await this.activateQbitMigrationDestination(completed)
        return completed
      }
    }
    return this.getQbitRecoveryState(sourceKeyringIndex)
  }

  private enqueueQbitReceiveOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    let result: T
    return this.enqueueChainStateChange(async () => {
      result = await operation()
    }).then(() => result!)
  }

  private loadQbitReceiveContext = async (
    refreshActivity: boolean,
    previousActivityStatus: QbitReceiveState['activityStatus'] = 'cached'
  ): Promise<QbitReceiveControllerContext> => {
    if (!this.isQbitChain()) {
      throw new Error(t('not_supported'))
    }
    const chainType = this.getChainType()
    const network = chainTypeToQbitNetworkName(chainType)
    const keyring = await this.getCurrentKeyring()
    if (!keyring || keyring.type !== KeyringType.QbitHdKeyring) {
      throw new Error(t('not_supported'))
    }
    const anchor = keyring.accounts[0]
    if (!anchor?.p2mr) {
      throw new Error('P2MR receive metadata is unavailable')
    }

    let ledger = (await keyringService.getQbitReceiveState(
      anchor.pubkey,
      network
    )) as QbitReceiveIntentLedger
    let activityStatus = previousActivityStatus
    if (refreshActivity) {
      let activeAddresses: Set<string> | undefined
      try {
        const [activeGroup] = await this.findActiveAddressGroups([
          {
            type: AddressType.P2MR,
            address_arr: keyring.accounts.map(account => account.p2mr?.addresses[network] || ''),
            pubkey_arr: keyring.accounts.map(account => account.pubkey),
          },
        ])
        activeAddresses = new Set(activeGroup?.address_arr || [])
        activityStatus = 'live'
      } catch (error) {
        log.warn('[WalletController] Qbit receive activity refresh failed; using vault cache', error)
      }

      if (this.getChainType() !== chainType) {
        throw new Error('Qbit network changed while preparing the receive screen')
      }
      if (activeAddresses) {
        const observedUsedIndexes = keyring.accounts
          .filter(account => {
            const address = account.p2mr?.addresses[network]
            return Boolean(address && activeAddresses!.has(address))
          })
          .map(account => account.p2mr!.hkdf.index)
        const newlyObserved = observedUsedIndexes.filter(
          index => !ledger.usedIndexes.includes(index)
        )
        if (newlyObserved.length > 0) {
          await keyringService.recordQbitReceiveActivity(anchor.pubkey, network, newlyObserved)
          ledger = (await keyringService.getQbitReceiveState(
            anchor.pubkey,
            network
          )) as QbitReceiveIntentLedger
        }
      }
    }

    const addresses = keyring.accounts.map(account => {
      if (!account.p2mr) {
        throw new Error('P2MR receive metadata is unavailable')
      }
      const counter = account.p2mr.signatureCounter
      const exhausted =
        counter.state === 'exhausted' || counter.remaining <= 0 || counter.count >= counter.limit
      return {
        index: account.p2mr.hkdf.index,
        address: account.p2mr.addresses[network],
        used: ledger.usedIndexes.includes(account.p2mr.hkdf.index),
        signatureCounter: {
          ...counter,
          state: exhausted ? ('exhausted' as const) : counter.state,
          remaining: exhausted ? 0 : counter.remaining,
        },
      }
    })
    const rawKeyring = keyringService.keyrings[keyring.index]

    return {
      network,
      keyring,
      anchor,
      ledger,
      addresses,
      activityStatus,
      floorsPending: rawKeyring?.pqcFloorsPending === true,
      concurrentInstanceHint: rawKeyring?.pqcConcurrentInstanceHint === true,
    }
  }

  private buildQbitReceiveState = (context: QbitReceiveControllerContext): QbitReceiveState => {
    const issuedIndexes = new Set(context.ledger.issuedIndexes)
    const allocationAddresses: QbitReceiveAllocationAddress[] = context.addresses.map(address => ({
      index: address.index,
      issued: issuedIndexes.has(address.index),
      used: address.used,
      exhausted: address.signatureCounter.state === 'exhausted',
    }))
    const gapPlan = planQbitReceiveIntent(allocationAddresses)
    const persistedCurrent = context.addresses.find(
      address => address.index === context.ledger.currentIndex
    )
    const shouldHideAddresses = context.floorsPending || context.activityStatus !== 'live'
    const current =
      !shouldHideAddresses &&
      persistedCurrent &&
      !persistedCurrent.used &&
      persistedCurrent.signatureCounter.state !== 'exhausted'
        ? persistedCurrent
        : null
    const previous = shouldHideAddresses
      ? []
      : context.addresses
          .filter(
            address =>
              (issuedIndexes.has(address.index) || address.used) && address.index !== current?.index
          )
          .sort((left, right) => right.index - left.index)

    return {
      network: context.network,
      current,
      previous,
      gap: {
        limit: QBIT_RECEIVE_GAP_LIMIT,
        highestUsedIndex: gapPlan.highestUsedIndex,
        trailingUnusedCount: gapPlan.trailingUnusedCount,
        remainingIntentCapacity: gapPlan.remainingIntentCapacity,
        canCreate:
          !context.floorsPending && context.activityStatus === 'live' && gapPlan.nextIntent !== null,
      },
      activityStatus: context.activityStatus,
      floorsPending: context.floorsPending,
      concurrentInstanceHint: context.concurrentInstanceHint,
    }
  }

  private adoptQbitReceiveAccount = async (
    context: QbitReceiveControllerContext,
    index: number
  ): Promise<void> => {
    const accountPosition = context.keyring.accounts.findIndex(
      account => account.p2mr?.hkdf.index === index
    )
    if (accountPosition < 0) {
      throw new Error(`P2MR receive account ${index} is unavailable`)
    }
    const account = context.keyring.accounts[accountPosition]!
    const selected = preferenceService.getCurrentAccount()
    if (selected?.key === account.key && selected.address === account.address) return
    await this.changeKeyring(context.keyring, accountPosition)
  }

  private createNextQbitReceiveIntent = async (
    context: QbitReceiveControllerContext
  ): Promise<QbitReceiveState> => {
    if (context.floorsPending) {
      throw new Error('Counter reconstruction must complete before creating a receive address')
    }
    if (context.activityStatus !== 'live') {
      throw new Error('Live activity must be checked before creating a receive address')
    }
    const issuedIndexes = new Set(context.ledger.issuedIndexes)
    const gapPlan = planQbitReceiveIntent(
      context.addresses.map(address => ({
        index: address.index,
        issued: issuedIndexes.has(address.index),
        used: address.used,
        exhausted: address.signatureCounter.state === 'exhausted',
      }))
    )
    if (!gapPlan.nextIntent) {
      throw new Error(
        `Receive address gap limit (${QBIT_RECEIVE_GAP_LIMIT}) reached; wait for activity before creating another address`
      )
    }

    await keyringService.setQbitReceiveIntent(
      context.anchor.pubkey,
      context.network,
      gapPlan.nextIntent.index
    )
    // A mnemonic-restored keyring seeds a newly activated index with a zero
    // counter floor and restored-floor provenance even though the address may
    // carry spent history beyond the original restore gap. Sign-lock the
    // keyring and reconstruct floors before the address is exposed, mirroring
    // manual account derivation; the re-arm has to follow the intent call
    // because setQbitReceiveIntent refuses while floors are pending.
    if (
      gapPlan.nextIntent.activatesIndex &&
      keyringService.keyrings[context.keyring.index]?.pqcRestoredFromMnemonic === true
    ) {
      await keyringService.rearmQbitRestoreFloorsForKeyring(context.anchor.address)
      await this.performQbitRestoreFloorScan()
    }
    // A newly activated index was not part of the live activity check above
    // (it ran before setQbitReceiveIntent derived the account), and another
    // copy of the seed may already have used that address. Re-run the check
    // so its history lands in usedIndexes before the address is exposed;
    // starting from 'cached' keeps a failed refresh from presenting the new
    // address as live-verified.
    const refreshed = gapPlan.nextIntent.activatesIndex
      ? await this.loadQbitReceiveContext(true, 'cached')
      : await this.loadQbitReceiveContext(false, context.activityStatus)
    const state = this.buildQbitReceiveState(refreshed)
    // The recheck can invalidate the index this intent just issued — another
    // copy of the seed already used it, or the refresh failed and the address
    // is no longer live-verified. Only switch the wallet onto an index the
    // state still exposes as the safe current address.
    if (state.current?.index === gapPlan.nextIntent.index) {
      await this.adoptQbitReceiveAccount(refreshed, gapPlan.nextIntent.index)
    }
    return state
  }

  getQbitReceiveState = (): Promise<QbitReceiveState> =>
    this.enqueueQbitReceiveOperation(async () =>
      this.buildQbitReceiveState(await this.loadQbitReceiveContext(true))
    )

  ensureQbitReceiveIntent = (): Promise<QbitReceiveState> =>
    this.enqueueQbitReceiveOperation(async () => {
      const context = await this.loadQbitReceiveContext(true)
      const state = this.buildQbitReceiveState(context)
      if (state.current) {
        await this.adoptQbitReceiveAccount(context, state.current.index)
        return state
      }
      return !state.gap.canCreate ? state : this.createNextQbitReceiveIntent(context)
    })

  createQbitReceiveIntent = (): Promise<QbitReceiveState> =>
    this.enqueueQbitReceiveOperation(async () =>
      this.createNextQbitReceiveIntent(await this.loadQbitReceiveContext(true))
    )

  /**
   * Mnemonic restore for Qbit wallets: gap-limit address discovery on a
   * throwaway keyring (nothing persists if it fails), then a single persisted
   * keyring covering every discovered index with signing gated, then on-chain
   * signature-counter floor reconstruction which lifts the gate. Returns a
   * recovery report for the restore UI; `floorsCompleted: false` means the
   * wallet exists but stays sign-locked until a retry succeeds.
   */
  restoreQbitKeyringWithFloors = (
    mnemonic: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    options?: { gapLimit?: number; maxIndexes?: number } | null
  ) =>
    this.enqueueChainStateChange(() =>
      this.performRestoreQbitKeyringWithFloors(mnemonic, hdPath, passphrase, addressType, options)
    )

  private performRestoreQbitKeyringWithFloors = async (
    mnemonic: string,
    hdPath: string,
    passphrase: string,
    addressType: AddressType,
    options?: { gapLimit?: number; maxIndexes?: number } | null
  ) => {
    if (!this.isQbitChain() || addressType !== AddressType.P2MR) {
      throw new Error(t('not_supported'))
    }
    const chainType = this.getChainType()
    const qbitNetwork = chainTypeToQbitNetworkName(chainType)
    const resolvedHdPath = resolveHdPathForAddressType(addressType, hdPath, chainType)
    const client = this.getQbitApiClient(chainType)

    const tmpKeyring = keyringService.createTmpKeyring(KeyringType.QbitHdKeyring, {
      mnemonic,
      activeIndexes: [],
      hdPath: resolvedHdPath,
      passphrase,
    }) as Keyring & {
      activeAccounts(indexes: number[]): void
      getQbitAccounts(): Promise<{ addresses?: Record<string, string> }[]>
    }
    const deriveAddresses = async (count: number): Promise<string[]> => {
      tmpKeyring.activeAccounts(Array.from({ length: count }, (_value, index) => index))
      const accounts = await tmpKeyring.getQbitAccounts()
      return accounts.map(account => {
        const address = account.addresses?.[qbitNetwork]
        if (!address) {
          throw new Error(`derived qbit account is missing a ${qbitNetwork} address`)
        }
        return address
      })
    }

    const discovery: QbitRestoreDiscovery = await discoverQbitActiveIndexes(
      client,
      deriveAddresses,
      options ?? undefined
    )
    const accountCount = Math.max(discovery.highestActiveIndex + 1, 1)

    const originKeyring = await keyringService.addDiscoveredQbitKeyring(
      tmpKeyring,
      accountCount,
      !discovery.truncated,
      qbitNetwork
    )
    keyringService.removePreMnemonics()
    const displayedKeyring = await keyringService.displayForKeyring(
      originKeyring,
      addressType,
      keyringService.keyrings.length - 1
    )
    const walletKeyring = this.displayedKeyringToWalletKeyring(
      displayedKeyring,
      keyringService.keyrings.length - 1
    )
    await this.changeKeyring(walletKeyring)
    preferenceService.setShowSafeNotice(true)

    if (discovery.activeIndexes.length > 0) {
      const restoredKeyring = keyringService.keyrings[keyringService.keyrings.length - 1]
      const [anchorPubkey] = (await restoredKeyring?.getAccounts()) || []
      if (!anchorPubkey) {
        throw new Error('restored qbit keyring is missing its anchor account')
      }
      await keyringService.recordQbitReceiveActivity(
        anchorPubkey,
        qbitNetwork,
        discovery.activeIndexes
      )
    }

    try {
      const floorScan = await this.performQbitRestoreFloorScan()
      if (await this.getQbitRestoreFloorsPending()) {
        // The scan resolved without lifting the gate (e.g. nothing was
        // scannable); report the restore as incomplete so the UI keeps the
        // retry affordance instead of a false success.
        log.warn('qbit restore floor scan resolved with the signing gate still closed')
        return {
          network: qbitNetwork,
          accountsRestored: accountCount,
          discovery,
          floorsCompleted: false as const,
          floorError: 'restore floor scan did not lift the signing gate',
        }
      }
      return {
        network: qbitNetwork,
        accountsRestored: accountCount,
        discovery,
        floorsCompleted: true as const,
        floorScan,
      }
    } catch (error) {
      log.warn('qbit restore floor scan failed; signing stays locked', error)
      return {
        network: qbitNetwork,
        accountsRestored: accountCount,
        discovery,
        floorsCompleted: false as const,
        floorError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  createKeyringWithColdWallet = async (
    xpub: string,
    addressType: AddressType,
    alianName?: string,
    hdPath?: string,
    accountCount = 1
  ) => {
    if (this.isQbitChain()) {
      // No hardware/cold signer supports qbit's SLH-DSA signatures (D5/#23;
      // vendor support tracked in #44). Every configured chain is a qbit
      // chain, so cold-wallet creation is disabled in V1.
      throw new Error(t('hardware_wallet_not_supported'))
    }
    const accounts = await this.deriveAccountsFromXpub(xpub, addressType, hdPath, accountCount)
    const addresses = accounts.map(acc => acc.address)
    const publicKeys = accounts.map(acc => acc.pubkey)

    const coldWalletKeyring = new ColdWalletKeyring({
      xpub,
      addresses,
      connectionType: 'QR',
      hdPath: hdPath!,
      publicKeys,
    })

    const originKeyring = await keyringService.addKeyring(coldWalletKeyring, addressType)
    const displayedKeyring = await keyringService.displayForKeyring(
      originKeyring,
      addressType,
      keyringService.keyrings.length - 1
    )

    const keyring = this.displayedKeyringToWalletKeyring(
      displayedKeyring,
      keyringService.keyrings.length - 1
    )

    if (alianName) {
      this.setKeyringAlianName(keyring, alianName)
    }

    await this.changeKeyring(keyring)

    preferenceService.setShowSafeNotice(true)
    return keyring
  }

  /**
   * Derive accounts from extended public key (receive chain level only)
   * For paths like m/84'/0'/0'/0, derives m/84'/0'/0'/0/i addresses
   */
  deriveAccountsFromXpub = async (
    xpub: string,
    addressType: AddressType,
    hdPath?: string,
    accountCount = 1
  ): Promise<{ pubkey: string; address: string }[]> => {
    if (this.isQbitChain()) {
      // BIP32 xpubs can only derive secp256k1 addresses, which are not valid
      // qbit P2MR addresses (D5/#23).
      throw new Error(t('hardware_wallet_not_supported'))
    }
    // Validate xpub format
    const validPrefixes = ['xpub', 'tpub', 'ypub', 'zpub']
    if (!validPrefixes.some(prefix => xpub?.startsWith(prefix))) {
      throw new Error('Invalid xpub format')
    }

    const hdPublicKey = new bitcore.HDPublicKey(xpub)
    const networkType = this.getNetworkType()
    const accounts: { pubkey: string; address: string }[] = []

    // Derive addresses: m/84'/0'/0'/0/i
    for (let i = 0; i < accountCount; i++) {
      const addressKey = hdPublicKey.deriveChild(i)
      const publicKeyHex = addressKey.publicKey.toString('hex')
      const address = publicKeyToAddress(publicKeyHex, addressType, networkType)
      accounts.push({ pubkey: publicKeyHex, address })
    }

    return accounts
  }

  // Queued with migration and other chain-state work: a migration start that
  // observed only seed-only-restored state must not interleave with this
  // removal and lose its source or destination mid-creation, so the recovery
  // check below re-reads recovery state immediately before deleting.
  removeKeyring = (keyring: WalletKeyring, options?: QbitRemoveKeyringOptions) =>
    this.enqueueChainStateChange(() => this.performRemoveKeyring(keyring, options))

  // The migration record captures the destination identity under the hd path
  // of the network the migration was created on. When another coin type is
  // active, every keyring's displayed accounts are re-derived under a
  // different path, so the recorded pubkey/address can only be recognized by
  // re-deriving each candidate's anchor account under the stored network's
  // path. Returns undefined only when every candidate was checked and none
  // matched; throws when a candidate cannot be verified, because a missed
  // match could mistake the destination wallet for an unrelated one — the
  // caller surfaces that uncertainty for user confirmation.
  private resolveQbitMigrationDestinationIndex = async (
    migration: QbitRecoveryMigrationVault,
    currentKeyrings: WalletKeyring[]
  ): Promise<number | undefined> => {
    const matchesDestination = (
      pubkey: string | undefined,
      addresses: Record<string, string> | undefined
    ) =>
      pubkey?.toLowerCase() === migration.destinationPubkey.toLowerCase() &&
      Object.values(addresses ?? {}).includes(migration.destinationAddress)

    const displayedMatch = currentKeyrings.find(
      other =>
        other.type === KeyringType.QbitHdKeyring &&
        other.accounts.some(account =>
          matchesDestination(account.pubkey, account.p2mr?.addresses)
        )
    )
    if (displayedMatch) return displayedMatch.index

    const storedHdPath = getQbitHdPathForChainType(
      migration.network === 'mainnet' ? ChainType.QBIT_MAINNET : ChainType.QBIT_TESTNET4
    )
    for (const other of currentKeyrings) {
      if (other.type !== KeyringType.QbitHdKeyring) continue
      const raw = keyringService.keyrings[other.index] as
        | (Keyring & { mnemonic?: string; xpriv?: string; passphrase?: string; hdPath?: string })
        | undefined
      // A keyring already on the stored path was covered by the displayed
      // lookup above: its anchor account is always active.
      if (!raw || raw.type !== KeyringType.QbitHdKeyring || raw.hdPath === storedHdPath) continue
      try {
        const tmpKeyring = keyringService.createTmpKeyring(KeyringType.QbitHdKeyring, {
          ...(raw.mnemonic
            ? { mnemonic: raw.mnemonic, passphrase: raw.passphrase }
            : { xpriv: raw.xpriv }),
          activeIndexes: [0],
          hdPath: storedHdPath,
        }) as Keyring & {
          getQbitAccounts(): Promise<{ pubkey?: string; addresses?: Record<string, string> }[]>
        }
        const [anchor] = await tmpKeyring.getQbitAccounts()
        if (matchesDestination(anchor?.pubkey, anchor?.addresses)) {
          return other.index
        }
      } catch (error) {
        log.warn(
          '[WalletController] Failed to verify a wallet against the recorded migration destination',
          error
        )
        throw new Error('Qbit migration destination could not be verified')
      }
    }
    return undefined
  }

  // A queued chain-state operation captures its WalletKeyring argument before
  // earlier queued work (for example a removal issued from another extension
  // window) compacts keyringService.keyrings, so the captured numeric index
  // can point at an unrelated wallet by the time the operation runs. Match the
  // captured wallet back to a current keyring by its anchor account identity;
  // the captured index only breaks ties between wallets sharing an anchor.
  private resolveQueuedWalletKeyring = (
    currentKeyrings: WalletKeyring[],
    captured: WalletKeyring
  ): WalletKeyring => {
    const anchor = captured.accounts[0]
    const matches = currentKeyrings.filter(candidate => {
      const candidateAnchor = candidate.accounts[0]
      if (candidate.type !== captured.type || !candidateAnchor || !anchor) return false
      return anchor.pubkey
        ? candidateAnchor.pubkey === anchor.pubkey
        : candidateAnchor.address === anchor.address
    })
    const resolved =
      matches.find(candidate => candidate.index === captured.index) ??
      (matches.length === 1 ? matches[0] : undefined)
    if (!resolved) {
      throw new Error('The selected wallet is no longer available')
    }
    return resolved
  }

  // Reports every way removing `target` would touch an active recovery
  // migration; an empty result means the removal is recovery-safe. These
  // reasons feed the UI's risk-confirmation step — a confirmed removal
  // proceeds over all of them, so this never permanently blocks a wallet.
  private collectQbitRecoveryRemovalReasons = async (
    target: WalletKeyring,
    currentKeyrings: WalletKeyring[]
  ): Promise<QbitRecoveryRemovalReason[]> => {
    const reasons: QbitRecoveryRemovalReason[] = []
    for (const candidate of currentKeyrings) {
      const anchor = candidate.accounts[0]
      if (candidate.type !== KeyringType.QbitHdKeyring || !anchor?.p2mr) continue
      const recovery = await keyringService.getQbitRecoveryVaultState(anchor.address)
      if (!recovery) continue
      // Every network's lifecycle covers its own source and destination: a
      // wallet archived on one network may still be mid-migration on another.
      for (const [networkName, record] of Object.entries(recovery.networks ?? {})) {
        if (!record || (record.status !== 'migrating' && record.status !== 'migrated')) {
          continue
        }
        const status = record.status
        const migration = record.migration
        const describe = (role: QbitRecoveryRemovalReason['role']): QbitRecoveryRemovalReason => ({
          role,
          network: (migration?.network ?? networkName) as QbitReceiveNetworkName,
          status,
          ...(migration?.plans.some(
            plan => plan.status === 'signed' || plan.status === 'broadcast'
          )
            ? { hasInflightPlans: true }
            : {}),
        })
        if (candidate.index === target.index) {
          reasons.push(describe('source'))
          // A migration never sweeps a wallet to itself, so this record's
          // destination check cannot also match the target.
          continue
        }
        if (!migration) continue
        // Keyring indexes compact on removal while the vault keeps the index
        // the destination had when migration started, so resolve the
        // destination by its recorded keys and fall back to the persisted
        // index only when no keyring matches (that index only ever flags a
        // removal, never clears one, because a resolved identity match takes
        // precedence).
        try {
          const destinationKeyringIndex =
            (await this.resolveQbitMigrationDestinationIndex(migration, currentKeyrings)) ??
            migration.destinationKeyringIndex
          if (destinationKeyringIndex === target.index) {
            reasons.push(describe('destination'))
          }
        } catch {
          // With the destination unresolvable, the target itself may be the
          // destination: surface that uncertainty for confirmation instead of
          // failing the removal closed.
          reasons.push(describe('unverified'))
        }
      }
    }
    return reasons
  }

  // The risk lines the confirmation popover renders, at its granularity: one
  // line per source status or non-source role, plus one shared in-flight
  // line. The acknowledgement covers exactly these lines, so a confirmed
  // retry compares fresh reasons against them rather than the raw tuples —
  // a network-only change the user cannot see must not re-prompt.
  private qbitRecoveryRemovalRiskKeys = (
    reasons: readonly QbitRecoveryRemovalReason[]
  ): Set<string> => {
    const keys = new Set<string>()
    for (const reason of reasons) {
      keys.add(reason.role === 'source' ? `source:${reason.status ?? 'migrating'}` : reason.role)
      if (reason.hasInflightPlans) keys.add('inflight')
    }
    return keys
  }

  private performRemoveKeyring = async (
    keyring: WalletKeyring,
    options?: QbitRemoveKeyringOptions
  ) => {
    const currentKeyrings = await this.getKeyrings()
    const target = this.resolveQueuedWalletKeyring(currentKeyrings, keyring)
    // An acknowledgement covers the risk lines the user actually saw for this
    // wallet. Recovery state can change while the confirmation is open —
    // another window can reopen an archived source or broadcast a plan — so
    // the confirmed retry re-runs the check and proceeds only when every
    // fresh risk was part of the acknowledged set; anything new re-prompts
    // with the current reasons instead of silently deleting over them.
    // Confirmed removals therefore never hard block: at worst the user
    // re-confirms the updated warning.
    const reasons = await this.collectQbitRecoveryRemovalReasons(target, currentKeyrings)
    const acknowledgedKeys = options?.acknowledgedQbitRecoveryRisks
      ? this.qbitRecoveryRemovalRiskKeys(options.acknowledgedQbitRecoveryReasons ?? [])
      : undefined
    const blocked =
      acknowledgedKeys === undefined
        ? reasons.length > 0
        : [...this.qbitRecoveryRemovalRiskKeys(reasons)].some(key => !acknowledgedKeys.has(key))
    if (blocked) {
      const error = new WalletError(
        ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED,
        t('qbit_recovery_wallets_retained')
      ) as WalletError & { data?: { reasons: QbitRecoveryRemovalReason[] } }
      error.data = { reasons }
      throw error
    }
    await keyringService.removeKeyring(target.index)
    // Nor are the removed accounts' outputs kept; the others are read again.
    this.qbitLatestUtxoReads.clear()
    const keyrings = await this.getKeyrings()
    const nextKeyring = keyrings[keyrings.length - 1]
    if (nextKeyring && nextKeyring.accounts[0]) {
      await this.changeKeyring(nextKeyring)
      return nextKeyring
    }
    return
  }

  getKeyringByType = (type: string) => {
    return keyringService.getKeyringByType(type)
  }

  // Account derivations in flight, keyed by keyring identity. The chain-state
  // queue serializes derivations but does not deduplicate them, and the UI's
  // in-flight lock only spans one screen mount: navigating away and back,
  // reopening the popup, or a second window can each dispatch another derive
  // while a restored wallet's floor scan is still running, and every queued
  // request would add one more account. Reject duplicates instead.
  private pendingAccountDerivations = new Set<string>()

  private accountDerivationKey = (keyring: WalletKeyring): string => {
    // Same identity resolveQueuedWalletKeyring uses, so a captured index that
    // compaction staled still maps to the same in-flight derivation.
    const anchor = keyring.accounts[0]
    return `${keyring.type}:${anchor?.pubkey || anchor?.address || keyring.key}`
  }

  deriveNewAccountFromMnemonic = async (keyring: WalletKeyring, alianName?: string) => {
    if (keyring.type !== KeyringType.HdKeyring && keyring.type !== KeyringType.QbitHdKeyring) {
      throw new Error(t('not_supported'))
    }
    const derivationKey = this.accountDerivationKey(keyring)
    if (this.pendingAccountDerivations.has(derivationKey)) {
      throw new Error(t('account_creation_already_in_progress'))
    }
    this.pendingAccountDerivations.add(derivationKey)
    try {
      // Queue the whole derivation: a concurrently queued floor scan must not
      // observe the re-armed sign-lock below and clear it before the new
      // account exists, or the account would keep its zero floor yet become
      // signable.
      return await this.enqueueChainStateChange(() =>
        this.performDeriveNewAccountFromMnemonic(keyring, alianName)
      )
    } finally {
      this.pendingAccountDerivations.delete(derivationKey)
    }
  }

  private performDeriveNewAccountFromMnemonic = async (
    keyring: WalletKeyring,
    alianName?: string
  ): Promise<DeriveAccountResult> => {
    const resolved = this.resolveQueuedWalletKeyring(await this.getKeyrings(), keyring)
    const _keyring = keyringService.keyrings[resolved.index]!
    // A mnemonic-restored Qbit keyring seeds a manually derived account with a
    // zero counter floor even though its address may carry spent history.
    // Sign-lock the keyring before activation so the new account cannot sign
    // until the floor scan below reconstructs and persists its real floor.
    const rearmRestoredFloors =
      resolved.type === KeyringType.QbitHdKeyring && _keyring.pqcRestoredFromMnemonic === true
    if (rearmRestoredFloors) {
      await keyringService.rearmQbitRestoreFloorsForKeyring(resolved.accounts[0]!.address)
    }
    await keyringService.addNewAccount(_keyring)

    const displayedKeyring = await keyringService.displayForKeyring(
      _keyring,
      resolved.addressType,
      resolved.index
    )
    const newKeyring = this.displayedKeyringToWalletKeyring(displayedKeyring, resolved.index)

    await this.changeKeyring(newKeyring, newKeyring.accounts.length - 1)

    if (alianName) {
      const account = preferenceService.getCurrentAccount() as Account
      preferenceService.setAccountAlianName(account.key, alianName)
      account.alianName = alianName
    }

    if (!rearmRestoredFloors) {
      return { floorScanPending: false }
    }
    // The account is committed and selected above, so from here on a failed
    // scan must not reject the derive: the caller would report a failure for
    // an account that exists and cannot retry without deriving a duplicate.
    // Only a completed scan clears pqcFloorsPending, so the keyring stays
    // sign-locked and the deferred scan on the next unlock or chain switch
    // lifts it; report the pending gate so the UI can say exactly that.
    let floorScanError: string | undefined
    try {
      await this.performQbitRestoreFloorScan()
    } catch (error) {
      log.warn('qbit floor scan failed after deriving an account; signing stays locked', error)
      floorScanError = error instanceof Error ? error.message : String(error)
    }
    if (_keyring.pqcFloorsPending !== true) {
      return { floorScanPending: false }
    }
    return {
      floorScanPending: true,
      floorScanError: floorScanError ?? 'restore floor scan did not lift the signing gate',
    }
  }

  getAccountsCount = async () => {
    const accounts = await keyringService.getAccounts()
    return accounts.filter(x => x).length
  }

  private publishAccountChange = (account: Account): void => {
    sessionService.broadcastEvent(
      SESSION_EVENTS.accountsChanged,
      [account.address],
      undefined,
      this.getChainType()
    )

    bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.ACCOUNTS_CHANGED,
      params: account,
    })
  }

  private refreshDisplayedQbitAccountAfterSigning = async (
    signedAddress: string
  ): Promise<void> => {
    try {
      const account = await this.getCurrentAccount()
      if (!account || account.address !== signedAddress) return

      bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
        method: BUS_METHODS.ACCOUNTS_CHANGED,
        params: account,
      })
    } catch (error) {
      // Signing and counter persistence have already succeeded. A display
      // refresh failure must not turn that safe result into a retryable sign.
      log.warn('failed to refresh displayed qbit signature counter after signing', error)
    }
  }

  changeKeyring = async (
    keyring: WalletKeyringWithStatus,
    accountIndex = 0,
    options: { persistPreference?: boolean; broadcastAccountChange?: boolean } = {}
  ) => {
    if (!this.isUsableKeyring(keyring)) {
      throw new Error('Keyring is corrupted')
    }

    preferenceService.setCurrentKeyringIndex(keyring.index)
    const account = keyring.accounts[accountIndex]!
    preferenceService.setCurrentAccount(account)
    if (options.persistPreference) {
      await preferenceService.persist()
    }
    if (account && options.broadcastAccountChange !== false) {
      this.publishAccountChange(account)
    }

  }

  getAllAddresses = async (keyring: WalletKeyring, index: number) => {
    const networkType = this.getNetworkType()
    const pubkeys = await keyringService.getAllPubkeysByDerivedIndex(keyring, index)
    const addresses = pubkeys.map(v => {
      if (v.type === AddressType.P2MR) {
        const p2mr = keyring.accounts[index]?.p2mr
        const qbitNetwork = chainTypeToQbitNetworkName(this.getChainType())
        return p2mr?.addresses[qbitNetwork] || keyring.accounts[index]?.address || ''
      }
      return publicKeyToAddress(v.pubkey, v.type, networkType)
    })
    return addresses
  }

  changeAddressType = async (addressType: AddressType) => {
    const currentAccount = await this.getCurrentAccount()
    const currentKeyring = await this.getCurrentKeyring()
    if (!getAccountCapabilities(currentKeyring).canChangeAddressType) {
      throw new Error(t('not_supported'))
    }
    const currentKeyringIndex = preferenceService.getCurrentKeyringIndex()
    await keyringService.changeAddressType(currentKeyringIndex, addressType)
    const keyring = await this.getCurrentKeyring()
    if (!keyring) throw new Error('no current keyring')
    await this.changeKeyring(keyring, currentAccount?.index)
  }

  formatOptionsToSignInputs = async (_psbt: string | transactionCore.Psbt, options?: SignPsbtOptions) => {
    const account = await this.getCurrentAccount()
    if (!account) throw null
    assertCanCreateSigningRequest(account)

    let toSignInputs: ToSignInput[] = []
    if (options && options.toSignInputs) {
      // We expect userToSignInputs objects to be similar to ToSignInput interface,
      // but we allow address to be specified in addition to publicKey for convenience.
      toSignInputs = options.toSignInputs.map(input => {
        const index = Number(input.index)
        if (isNaN(index)) throw new Error('invalid index in toSignInput')

        if (
          !(input as AddressUserToSignInput).address &&
          !(input as PublicKeyUserToSignInput).publicKey
        ) {
          throw new Error('no address or public key in toSignInput')
        }

        if (
          (input as AddressUserToSignInput).address &&
          (input as AddressUserToSignInput).address != account.address
        ) {
          throw new Error('invalid address in toSignInput')
        }

        if (
          (input as PublicKeyUserToSignInput).publicKey &&
          (input as PublicKeyUserToSignInput).publicKey != account.pubkey
        ) {
          throw new Error('invalid public key in toSignInput')
        }

        const sighashTypes = input.sighashTypes?.map(Number)
        if (sighashTypes?.some(isNaN)) throw new Error('invalid sighash type in toSignInput')

        let tapLeafHashToSign: string | Buffer | undefined
        if (input.tapLeafHashToSign) {
          if (typeof input.tapLeafHashToSign !== 'string') {
            tapLeafHashToSign = Buffer.from(input.tapLeafHashToSign, 'hex')
          } else if ((input.tapLeafHashToSign as any) instanceof Uint8Array) {
            tapLeafHashToSign = Buffer.from(input.tapLeafHashToSign)
          } else {
            tapLeafHashToSign = input.tapLeafHashToSign
          }

          tapLeafHashToSign = tapLeafHashToSign!.toString('hex')
        }
        return {
          index,
          publicKey: account.pubkey,
          sighashTypes,
          useTweakedSigner: input.useTweakedSigner,
          disableTweakSigner: input.disableTweakSigner,
          tapLeafHashToSign,
        } as any
      })
    } else {
      const networkType = this.getNetworkType()
      const psbtNetwork = toPsbtNetwork(networkType)

      const psbt =
        typeof _psbt === 'string'
          ? transactionCore.Psbt.fromHex(_psbt as string, { network: psbtNetwork })
          : (_psbt as transactionCore.Psbt)
      psbt.data.inputs.forEach((v, index) => {
        let script: any = null
        let value = 0
        if (v.witnessUtxo) {
          script = v.witnessUtxo.script
          value = v.witnessUtxo.value
        } else if (v.nonWitnessUtxo) {
          const tx = transactionCore.Transaction.fromBuffer(v.nonWitnessUtxo)
          const output = tx.outs[psbt.txInputs[index]!.index]!
          script = output.script
          value = output.value
        }
        const isSigned =
          v.finalScriptSig || v.finalScriptWitness || v.tapKeySig || v.partialSig || v.tapScriptSig
        if (script && !isSigned) {
          const address = scriptPkToAddress(script, networkType)
          if (account.address === address) {
            toSignInputs.push({
              index,
              publicKey: account.pubkey,
              sighashTypes: v.sighashType ? [v.sighashType] : undefined,
            })
          }
        }
      })

      if (toSignInputs.length === 0) {
        psbt.data.inputs.forEach((input, index) => {
          // if no toSignInputs, sign all inputs
          toSignInputs.push({
            index: index,
            publicKey: account.pubkey,
          })
        })
      }
    }

    return toSignInputs
  }

  formatPsbt = async (psbt: transactionCore.Psbt, toSignInputs: ToSignInput[], autoFinalized?: boolean) => {
    const account = await this.getCurrentAccount()
    if (!account) throw new Error('no current account')
    assertCanCreateSigningRequest(account)

    const keyring = await this.getCurrentKeyring()
    if (!keyring) throw new Error('no current keyring')
    const networkType = this.getNetworkType()
    const psbtNetwork = toPsbtNetwork(networkType)

    if (!toSignInputs) {
      // When the caller omits an input list, derive all signable inputs.
      toSignInputs = await this.formatOptionsToSignInputs(psbt)
    }

    let willBeSignedInputCount = 0
    psbt.data.inputs.forEach((input, index) => {
      const isSigned =
        input.finalScriptSig ||
        input.finalScriptWitness ||
        input.tapKeySig ||
        input.partialSig ||
        input.tapScriptSig
      if (isSigned) {
        willBeSignedInputCount++
        return
      }

      const isToBeSigned = toSignInputs.some(v => v.index === index)
      if (!isToBeSigned) {
        return
      }
      willBeSignedInputCount++

      let isP2TR = false
      const witnessScript = input.witnessUtxo?.script
      if (witnessScript) {
        try {
          transactionCore.payments.p2tr({ output: witnessScript, network: psbtNetwork })
          isP2TR = true
        } catch (e) {
          // skip
        }
      }

      if (isP2TR) {
        // fix p2tr input data
        let isKeyPathP2TR = false

        try {
          const originXPubkey = toXOnly(Buffer.from(account.pubkey, 'hex')).toString('hex')
          const tapInternalKey = toXOnly(Buffer.from(account.pubkey, 'hex'))
          const { output } = transactionCore.payments.p2tr({
            internalPubkey: tapInternalKey,
            network: psbtNetwork,
          })
          if (input.witnessUtxo?.script.toString('hex') == output?.toString('hex')) {
            isKeyPathP2TR = true
          }
          if (isKeyPathP2TR) {
            input.tapInternalKey = tapInternalKey
          } else {
            // only keypath p2tr can have tapInternalKey
            delete input.tapInternalKey
          }

          if (isKeyPathP2TR) {
            // keypath p2tr should be signed with origin signer
          } else {
            const isToBeSigned: any = toSignInputs.find(v => v.index === index)
            if (
              isToBeSigned.useTweakedSigner == undefined &&
              isToBeSigned.disableTweakSigner == undefined
            ) {
              if (input.tapLeafScript && input.tapLeafScript.length > 0) {
                const script = input.tapLeafScript[0]!.script.toString('hex')
                if (script.includes(originXPubkey)) {
                  // if tapLeafScript contains origin pubkey, use origin signer
                  isToBeSigned.useTweakedSigner = false
                } else {
                  // if tapLeafScript not contains origin pubkey, use tweaked signer
                  isToBeSigned.useTweakedSigner = true
                }
              } else {
                // if no tapLeafScript, use origin signer
                isToBeSigned.useTweakedSigner = false
              }
            }
          }
        } catch (e) {
          // skip
        }
      }
    })

    if (autoFinalized !== false && willBeSignedInputCount === psbt.inputCount) {
      autoFinalized = true
    } else {
      autoFinalized = false
    }

    return {
      psbt,
      toSignInputs,
      autoFinalized,
    }
  }

  _signPsbt = async (psbt: transactionCore.Psbt, toSignInputs: ToSignInput[], autoFinalized: boolean) => {
    const account = await this.getCurrentAccount()
    if (!account) throw new Error('no current account')
    if (getAccountCapabilities(account).signMethod !== AccountSignMethod.Local) {
      throw new Error(t('not_supported'))
    }

    const keyring = await this.getCurrentKeyring()
    if (!keyring) throw new Error('no current keyring')
    const _keyring = keyringService.keyrings[keyring.index]!

    toSignInputs.forEach(v => {
      if (v.tapLeafHashToSign) {
        v.tapLeafHashToSign = Buffer.from(v.tapLeafHashToSign as string, 'hex')
      }
    })
    psbt = await keyringService.signTransaction(_keyring, psbt, toSignInputs as any)

    if (autoFinalized) {
      try {
        toSignInputs.forEach(v => {
          // psbt.validateSignaturesOfInput(v.index, validator);
          psbt.finalizeInput(v.index)
        })
      } catch (e) {
        // ignore
      }
    }
    return psbt
  }

  // abstract wallet function
  signPsbt = async (psbt: transactionCore.Psbt, opts?: SignPsbtOptions): Promise<transactionCore.Psbt> => {
    const res = await this.formatPsbt(psbt, opts?.toSignInputs as any, opts?.autoFinalized as any)
    const signedPsbt = await this._signPsbt(res.psbt, res.toSignInputs, res.autoFinalized)
    return signedPsbt
  }

  // local sign function
  signPsbtV2 = async (toSignData: ToSignData): Promise<SignedData> => {
    // Before the first await: the port the signed bytes are handed back to.
    const uiPort = this.callingUiPort
    if (toSignData.qbitP2mrSigningKeys?.length) {
      const migrationContext = toSignData.qbitRecoveryMigration
        ? await this.validateQbitRecoveryMigrationSigning(
            toSignData.qbitRecoveryMigration,
            toSignData
          )
        : undefined
      const account = migrationContext?.account || preferenceService.getCurrentAccount()
      if (!account) throw new Error('no current account')
      if (getAccountCapabilities(account).signMethod !== AccountSignMethod.Local) {
        throw new Error(t('not_supported'))
      }

      const psbt = qbitPsbtFromHex(toSignData.psbtHex)
      const qbitBroadcastIdentity = this.validatedQbitBroadcastIdentity(
        psbt,
        toSignData.qbitBroadcastIdentity
      )
      const chain = qbitBroadcastIdentity.chain
      const consolidationOutputCounts =
        this.qbitConsolidationBatches.get(qbitBroadcastIdentity.txid) ??
        toSignData.qbitConsolidation?.fundingOutputCounts
      if (consolidationOutputCounts) {
        await this.assertQbitConsolidationInputsUnspent(chain, psbt, consolidationOutputCounts)
      }
      const sign = async (): Promise<SignedData> => {
        const signed = await keyringService.signP2mrPsbtWithCounter(
          account.address,
          {
            psbt,
            keys: qbitSigningKeysFromSerializable(toSignData.qbitP2mrSigningKeys!),
          },
          toSignData.signatureBudget,
          toSignData.qbitApprovedBatchDuplicate === true
        )
        await this.refreshDisplayedQbitAccountAfterSigning(account.address)
        const signedPsbt =
          toSignData.autoFinalized === false ? signed.psbt : finalizeP2mrPsbt(signed.psbt)
        const signedPsbtHex = qbitPsbtToHex(signedPsbt)
        if (migrationContext) {
          const finalized = finalizeP2mrPsbt(signedPsbt)
          const rawTransaction = extractP2mrTransaction(finalized)
          const txid = transactionCore.Transaction.fromBuffer(Buffer.from(rawTransaction)).getId()
          await keyringService.updateQbitRecoveryMigrationPlan(
            migrationContext.anchorAddress,
            migrationContext.network,
            migrationContext.plan.id,
            {
              status: 'signed',
              signedPsbtHex,
              txid,
            }
          )
        }
        return {
          psbtHex: signedPsbtHex,
          qbitBroadcastIdentity,
        }
      }
      const signWithClaim = (claim: QbitSendBroadcastClaim) => async (): Promise<SignedData> => ({
        ...(await sign()),
        qbitSendBroadcastClaim: {
          ...claim,
          outpoints: claim.outpoints.map(outpoint => ({ ...outpoint })),
        },
      })
      // A provider claim belongs to the provider request that approved it,
      // which releases it when the request fails or is rejected, whatever
      // becomes of the approval window; once that request has settled the
      // claim is refused before a signature is spent. Only a claim the
      // wallet mints for its own send is owned by the UI port that receives
      // the signed bytes.
      if (toSignData.qbitSendBroadcastClaim) {
        const providerClaim = this.validatedQbitSendBroadcastClaim(
          psbt,
          toSignData.qbitSendBroadcastClaim,
          toSignData.providerContext,
          account.address
        )
        return qbitSendGuardService.runWithProviderBroadcastClaim(
          providerClaim,
          signWithClaim(providerClaim)
        )
      }
      const claim = this.walletQbitSendBroadcastClaim(
        psbt,
        qbitBroadcastIdentity,
        toSignData,
        account.address
      )
      if (claim) {
        return qbitSendGuardService.runWithBroadcastClaim(claim, signWithClaim(claim), uiPort)
      }
      return this.runWithNoQbitInputConflict(
        chain,
        qbitPsbtOutpoints(psbt),
        sign,
        qbitPsbtTxid(psbt)
      )
    }

    if (toSignData.qbitSendBroadcastClaim) {
      throw new Error('invalid Qbit send broadcast claim')
    }

    const psbt = psbtFromString(toSignData.psbtHex)
    const sign = async () => {
      await this._signPsbt(psbt, toSignData.toSignInputs, toSignData.autoFinalized!)
      return {
        psbtHex: psbt.toHex(),
      }
    }
    if (!this.isQbitChain()) return sign()
    return this.runWithNoQbitInputConflict(
      this.getChainType(),
      transactionPsbtOutpoints(psbt),
      sign
    )
  }

  signMessage = async (params: ToSignMessage): Promise<SignedMessage> => {
    if (!params.text || params.text.length > 10000) {
      throw new Error('Invalid message length')
    }

    if (params.type === SignMessageType.P2MR) {
      return {
        proof: await this.signP2mrMessage(
          params.text,
          params.p2mrAccountAddress,
          params.signatureBudget
        ),
      }
    }

    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    assertCanCreateSigningRequest(account)

    if (getAccountCapabilities(account).signMethod !== AccountSignMethod.Local) {
      throw new Error('Readonly wallet cannot sign messages')
    }

    const networkType = this.getNetworkType()
    if (params.type === SignMessageType.BIP322_SIMPLE) {
      const signature = await signMessageOfBIP322Simple({
        message: params.text,
        address: account.address,
        networkType,
        wallet: this as any,
      })
      return {
        signature,
      }
    } else {
      const signature = await keyringService.signMessage(account.pubkey, account.type, params.text)
      return {
        signature,
      }
    }
  }

  preflightP2mrMessageSigning = async (messages: readonly string[]) => {
    const account = await this.getCurrentAccount()
    if (!account) throw new Error('no current account')
    if (!getAccountCapabilities(account).canSignP2mrMessage || !account.p2mr) {
      throw new Error(t('not_supported'))
    }

    const datasigHashes = messages.map(message => {
      assertValidP2mrMessage(message)
      return qbitDataSigPqcHash(qbitWalletMessageHash(message))
    })
    const signatureBudget = await keyringService.preflightP2mrMessageSigning(
      account.address,
      datasigHashes
    )
    return { accountAddress: account.address, signatureBudget }
  }

  signP2mrMessage = async (
    message: string,
    p2mrAccountAddress?: string,
    expectedBudget?: ToSignMessage['signatureBudget']
  ): Promise<P2mrMessageProof> => {
    assertValidP2mrMessage(message)

    const account = await this.getCurrentAccount()
    if (!account) throw new Error('no current account')
    if (p2mrAccountAddress !== undefined && account.address !== p2mrAccountAddress) {
      throw new Error('P2MR signing account changed after approval')
    }
    const capabilities = getAccountCapabilities(account)
    if (!capabilities.canSignP2mrMessage || !account.p2mr) {
      throw new Error(t('not_supported'))
    }

    const pubkeyHex = account.p2mr.pubkey.toLowerCase()
    if (account.pubkey.toLowerCase() !== pubkeyHex) {
      throw new Error('P2MR account public key metadata mismatch')
    }
    const pubkey = qbitHexToBytes(pubkeyHex)
    const leafScript = singleKeyLeafScript(pubkey)
    if (qbitBytesToHex(leafScript) !== account.p2mr.leafScript.toLowerCase()) {
      throw new Error('P2MR account leaf script metadata mismatch')
    }
    const merkleRoot = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    if (qbitBytesToHex(decodeP2mrAddress(account.address).program) !== qbitBytesToHex(merkleRoot)) {
      throw new Error('P2MR account address metadata mismatch')
    }

    const messageHash = qbitWalletMessageHash(message)
    const datasigHash = qbitDataSigPqcHash(messageHash)
    const signed = await keyringService.signP2mrMessageWithCounter(
      account.address,
      datasigHash,
      expectedBudget
    )
    await this.refreshDisplayedQbitAccountAfterSigning(account.address)
    if (signed.pubkey.toLowerCase() !== pubkeyHex) {
      throw new Error('P2MR signing key does not match the selected account')
    }

    return createP2mrMessageProof({
      message,
      address: account.address,
      pubkey,
      signature: signed.signature,
      leafVersion: P2MR_LEAF_VERSION_V1,
      leafScript,
      controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
    })
  }

  deriveContextHash = async (appName: string, context: string): Promise<string> => {
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    const canonicalNetwork = chainTypeToCanonicalNetwork(preferenceService.getChainType())
    const keyring = await keyringService.getKeyringForAccount(account.pubkey, account.type)
    if (!keyring.deriveContextHash) {
      throw new Error('Current keyring does not support deriveContextHash')
    }
    return keyring.deriveContextHash(account.pubkey, appName, canonicalNetwork, context)
  }

  addContact = async (data: ContactBookItem) => {
    await contactBookService.addContact(data)
  }

  updateContact = async (data: ContactBookItem) => {
    await contactBookService.updateContact(data)
  }

  getContactByAddress = (address: string): ContactBookItem | undefined => {
    return contactBookService.getContactByAddress(address)
  }

  getContactByAddressAndChain = (
    address: string,
    chain: ChainType
  ): ContactBookItem | undefined => {
    return contactBookService.getContactByAddressAndChain(address, chain)
  }

  private _generateAlianName = (type: string, index: number) => {
    return `${BRAND_ALIAN_TYPE_TEXT[type]} ${index}`
  }

  removeContact = async (address: string, chain?: ChainType) => {
    if (chain) {
      await contactBookService.removeContact(address, chain)
    } else {
      console.warn('removeContact called without chain parameter, using old method')
      const contact = contactBookService.getContactByAddress(address)
      if (contact) {
        await contactBookService.removeContact(address, contact.chain)
      }
    }
  }

  replaceContact = async (address: string, chain: ChainType, data: ContactBookItem) => {
    await contactBookService.replaceContact(address, chain, data)
  }

  listContact = (includeAlias = true): ContactBookItem[] => {
    const list = contactBookService.listContacts()
    if (includeAlias) {
      return list
    } else {
      return list.filter(item => !item.isAlias)
    }
  }

  listContacts = (): ContactBookItem[] => {
    return contactBookService.listContacts()
  }

  saveContactsOrder = (contacts: ContactBookItem[]) => {
    return contactBookService.saveContactsOrder(contacts)
  }

  getContactsByMap = (): Record<string, ContactBookItem> => {
    return contactBookService.getContactsByMap()
  }

  getNextAlianName = (keyring: WalletKeyring) => {
    return this._generateAlianName(keyring.type, keyring.accounts.length + 1)
  }

  getHighlightWalletList = () => {
    return preferenceService.getWalletSavedList()
  }

  updateHighlightWalletList = list => {
    return preferenceService.updateWalletSavedList(list)
  }

  getAllAlianName = (): (ContactBookItem | undefined)[] => {
    return contactBookService.listAlias()
  }

  getInitAlianNameStatus = () => {
    return preferenceService.getInitAlianNameStatus()
  }

  updateInitAlianNameStatus = () => {
    preferenceService.changeInitAlianNameStatus()
  }

  getIsFirstOpen = () => {
    return preferenceService.getIsFirstOpen()
  }

  updateIsFirstOpen = () => {
    return preferenceService.updateIsFirstOpen()
  }

  reportErrors = (error: string) => {
    console.error('report not implemented')
  }

  getNetworkType = () => {
    const chainType = this.getChainType()
    return CHAINS_MAP[chainType]!.networkType
  }

  setNetworkType = async (networkType: NetworkType) => {
    if (networkType === NetworkType.MAINNET) {
      await this.setChainType(ChainType.QBIT_MAINNET)
    } else if (networkType === NetworkType.REGTEST) {
      await this.setChainType(ChainType.QBIT_REGTEST)
    } else {
      await this.setChainType(ChainType.QBIT_TESTNET4)
    }
  }

  getNetworkName = () => {
    const networkType = this.getNetworkType()
    return NETWORK_TYPES[networkType]!.name
  }

  getQbitNetworkName = () => chainTypeToQbitNetworkName(this.getChainType())

  setChainType = (chainType: ChainType): Promise<void> => {
    return this.enqueueChainStateChange(() => this.performSetChainType(chainType))
  }

  /**
   * Provider switchChain/switchNetwork: switch the active chain and move the
   * requesting origin's grant onto it in the same queued step, so the chain
   * events already see the moved grant and that origin is never told it lost
   * access. Deliberately absent from the UI allowlist.
   */
  switchProviderChain = (origin: string, chainType: ChainType): Promise<void> => {
    return this.enqueueChainStateChange(() => this.performSetChainType(chainType, origin))
  }

  private grantSnapshot = (origin: string, chain: ChainType) => ({
    connected: permissionService.hasPermission(origin),
    canRead: permissionService.hasPermission(origin, chain),
  })

  /**
   * Tell one origin what changed after its grant was revoked or moved onto or
   * off the active `chain`; no other origin is told anything.
   */
  private announceGrantChange = async (
    origin: string,
    chain: ChainType,
    before: { connected: boolean; canRead: boolean }
  ): Promise<void> => {
    const { connected, canRead } = this.grantSnapshot(origin, chain)
    if (before.connected && !connected) {
      this.announceRevocation(origin)
      return
    }
    if (canRead === before.canRead) return
    if (!canRead) {
      sessionService.broadcastEvent(SESSION_EVENTS.accountsChanged, [], origin)
      return
    }
    const readable = await this.getProviderAccounts()
    if (readable.length > 0) {
      // Delivered only while the grant still matches the chain.
      sessionService.broadcastEvent(SESSION_EVENTS.accountsChanged, readable, origin, chain)
    }
  }

  /** Tell a revoked origin, and only it, that it lost access. */
  private announceRevocation = (origin: string): void => {
    sessionService.broadcastEvent(SESSION_EVENTS.accountsChanged, [], origin, undefined, true)
    sessionService.broadcastEvent(
      SESSION_EVENTS.disconnect,
      ORIGIN_DISCONNECTED,
      origin,
      undefined,
      true
    )
  }

  /** What getAccounts() returns to an origin with a grant for the active chain. */
  private getProviderAccounts = async (): Promise<string[]> => {
    try {
      const account = await this.getCurrentAccount()
      return account?.address ? [account.address] : []
    } catch (error) {
      log.warn('[WalletController] Failed to read the account to announce', summarizeError(error))
      return []
    }
  }

  private performSetChainType = async (
    chainType: ChainType,
    grantOrigin?: string
  ): Promise<void> => {
    chainType = normalizeChainType(chainType)
    const chain = CHAINS_MAP[chainType]!
    if (chain.disable || chain.mainnetReady === false) {
      throw new Error(`${chain.label} is not available yet`)
    }
    // Every path into local regtest (settings UI, dapp switchChain/switchNetwork,
    // network-type helpers) converges here. The background capability re-reads
    // the browser permission and verifies the service identity before any
    // chain, HD-path, endpoint, account or connected-site state is touched.
    if (chainType === ChainType.QBIT_REGTEST) {
      await regtestAccessService.assertAvailable()
    }
    const currentChainType = preferenceService.getChainType()
    const chainChanged = currentChainType !== chainType
    const sameQbitHdPathNetworkChange =
      chainChanged &&
      QBIT_CHAIN_TYPES.some(candidate => candidate === currentChainType) &&
      QBIT_CHAIN_TYPES.some(candidate => candidate === chainType) &&
      getQbitHdPathForChainType(currentChainType) === getQbitHdPathForChainType(chainType)

    const previousAccount = preferenceService.getCurrentAccount()
    const previousKeyringIndex = preferenceService.getCurrentKeyringIndex()
    const currentAccountIndex = previousAccount?.index ?? 0
    if (sameQbitHdPathNetworkChange) {
      try {
        await keyringService.rearmQbitRestoreFloors()
      } catch (error) {
        // The chain is still unchanged, but a conservative in-memory gate may
        // already be armed. Retry its current-network floor scan asynchronously.
        this.kickPendingQbitRestoreFloorScan()
        throw error
      }
    }
    await keyringService.syncQbitHdPath(getQbitHdPathForChainType(chainType))

    try {
      if (chainChanged) {
        preferenceService.setChainType(chainType)
      }
      await walletApiService.setEndpoint(chain.endpoints[0]!)

      const keyring = await this.getCurrentKeyring()
      if (!keyring) throw new Error('no current keyring')
      const selectedAccountIndex = keyring.accounts[currentAccountIndex] ? currentAccountIndex : 0
      // A provider request for the chain that is already active must not
      // re-announce an unchanged account to every origin on that chain.
      const quietReconcile =
        chainChanged ||
        (grantOrigin !== undefined &&
          keyring.accounts[selectedAccountIndex]?.pubkey === previousAccount?.pubkey)
      await this.changeKeyring(keyring, selectedAccountIndex, {
        persistPreference: true,
        ...(quietReconcile ? { broadcastAccountChange: false } : {}),
      })
    } catch (error) {
      try {
        preferenceService.setChainType(currentChainType)
        preferenceService.setCurrentKeyringIndex(previousKeyringIndex)
        preferenceService.setCurrentAccount(previousAccount)
      } catch (rollbackError) {
        log.error('[WalletController] Failed to restore chain preferences in memory', rollbackError)
      }

      try {
        await keyringService.syncQbitHdPath(getQbitHdPathForChainType(currentChainType))
      } catch (rollbackError) {
        log.error('[WalletController] Failed to restore the previous Qbit HD path', rollbackError)
      }

      try {
        await preferenceService.persist()
      } catch (rollbackError) {
        log.error('[WalletController] Failed to persist restored chain preferences', rollbackError)
      }

      try {
        await walletApiService.setEndpoint(CHAINS_MAP[currentChainType]!.endpoints[0]!)
      } catch (rollbackError) {
        log.error('[WalletController] Failed to restore the previous API endpoint', rollbackError)
      }

      // Path rollback or a completed same-path re-arm can leave restored
      // keyrings gated, so lift them again against the unchanged network.
      this.kickPendingQbitRestoreFloorScan()

      throw error
    }

    // The chain is committed. A grant that fails to move still leaves the
    // switch announced, with the origin told it lost access, before the
    // request rejects.
    let grantError: unknown
    // Only a grant moved onto the unchanged active chain is announced on its own.
    const grantBefore =
      grantOrigin !== undefined && !chainChanged
        ? this.grantSnapshot(grantOrigin, chainType)
        : undefined
    if (grantOrigin !== undefined) {
      try {
        await permissionService.updateConnectSite(grantOrigin, { chain: chainType }, true)
      } catch (error) {
        grantError = error
      }
    }

    if (!chainChanged) {
      if (grantBefore !== undefined) {
        await this.announceGrantChange(grantOrigin!, chainType, grantBefore)
      }
      if (grantError !== undefined) throw grantError
      return
    }

    // Restored seeds have unscanned floors on the newly active network; either
    // HD-path sync or the explicit same-path re-arm closed their signing gate.
    this.kickPendingQbitRestoreFloorScan()

    sessionService.broadcastChainChange({
      previousChain: currentChainType,
      chain: chainType,
      network: this.getQbitNetworkName(),
      accounts: await this.getProviderAccounts(),
    })

    bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.CHAIN_CHANGED,
      params: {
        type: chainType,
      },
    })
    if (grantError !== undefined) throw grantError
  }

  getChainType = () => {
    return preferenceService.getChainType()
  }

  /**
   * Wire the platform's loopback-permission adapter into the regtest
   * capability and react to revocation. Called once by the extension
   * background before the startup chain is resolved.
   */
  initRegtestAccess = (options: {
    adapter: RegtestAccessAdapter
    fetch?: RegtestFetch
    ackStore?: RegtestAccessAckStore
    verification?: { timeoutMs?: number; maxBodyBytes?: number }
  }): void => {
    const ackStore: RegtestAccessAckStore = options.ackStore ?? {
      get: () => preferenceService.getRegtestAccessAck(),
      set: async ack => {
        preferenceService.setRegtestAccessAck(ack)
        await preferenceService.persist()
      },
    }
    regtestAccessService.removeAllListeners()
    regtestAccessService.init({
      adapter: options.adapter,
      ackStore,
      logger: log,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.verification ? { verification: options.verification } : {}),
      now: this.now,
    })
    regtestAccessService.on('changed', status => {
      bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
        method: BUS_METHODS.REGTEST_ACCESS_CHANGED,
        params: status,
      })
    })
    regtestAccessService.on('permissionRemoved', () => {
      void this.enqueueChainStateChange(() => this.leaveRegtestFailClosed('permission_removed'))
    })
  }

  /**
   * Capability-aware startup: a persisted regtest selection is honoured only
   * when the browser permission, the acknowledgement and the service identity
   * all check out right now. Otherwise the persisted chain is normalized to
   * mainnet before any API client is initialized or account refreshed.
   */
  prepareStartupChainType = async (): Promise<ChainType> => {
    const persisted = normalizeChainType(preferenceService.getChainType())
    if (persisted !== ChainType.QBIT_REGTEST || !regtestAccessService.isSupported()) {
      return persisted
    }
    let status: RegtestAccessStatus | undefined
    try {
      status = await regtestAccessService.refresh({ verify: true })
    } catch (error) {
      log.warn('[WalletController] Regtest capability check failed at startup', summarizeError(error))
    }
    if (status?.state === 'available') {
      return persisted
    }
    log.warn('[WalletController] Persisted regtest is not usable at startup; using mainnet', {
      state: status?.state,
      reason: status?.reason,
    })
    preferenceService.setChainType(ChainType.QBIT_MAINNET)
    try {
      await preferenceService.persist()
    } catch (error) {
      log.error('[WalletController] Failed to persist the startup mainnet fallback', summarizeError(error))
    }
    this.dropRegtestApiClients()
    return ChainType.QBIT_MAINNET
  }

  /** Cheap status read for the UI: re-reads permission + acknowledgement, no probe, no prompt. */
  getRegtestAccessStatus = (): Promise<RegtestAccessStatus> => {
    return regtestAccessService.refresh({ verify: false })
  }

  /** Explicit retry of the service verification (never prompts the browser). */
  verifyRegtestAccess = (): Promise<RegtestAccessStatus> => {
    return regtestAccessService.refresh({ verify: true })
  }

  /**
   * Record consent after the wallet UI's own gesture obtained the optional
   * permission. The grant is re-read from the browser inside the service; a
   * caller cannot pass a "granted" flag.
   */
  acknowledgeRegtestAccess = (): Promise<RegtestAccessStatus> => {
    return regtestAccessService.acknowledge()
  }

  /**
   * Disable local regtest inside the extension: leave the network first
   * (through the normal serialized transition), clear the app-level
   * acknowledgement and report the locked state. The browser permission is
   * left alone. Chrome refuses `permissions.remove()` for this origin because
   * the extension's `<all_urls>` content script makes the loopback pattern a
   * required scriptable host, so the grant stays until the user removes it
   * from Chrome's extension settings (which locks the capability through
   * `onRemoved`). The acknowledgement is the switch: without it every entry
   * into regtest re-asks for consent.
   */
  disableRegtestAccess = (): Promise<RegtestAccessStatus> =>
    this.enqueueChainStateChange(async () => {
      await this.leaveRegtestFailClosed('disable')
      await regtestAccessService.clearAcknowledgement()
      this.dropRegtestApiClients()
      return regtestAccessService.refresh({ verify: false })
    })

  /**
   * Move off regtest without ever re-entering it. Unlocked wallets go through
   * the full transition (HD path, endpoint, accounts, events); if that fails
   * or the wallet is locked, the persisted chain and API endpoint are pinned
   * to mainnet directly so nothing stays bound to the loopback endpoint.
   */
  private leaveRegtestFailClosed = async (trigger: 'permission_removed' | 'disable'): Promise<void> => {
    if (preferenceService.getChainType() !== ChainType.QBIT_REGTEST) {
      return
    }
    if (this.isUnlocked()) {
      try {
        await this.performSetChainType(ChainType.QBIT_MAINNET)
        this.dropRegtestApiClients()
        return
      } catch (error) {
        log.error(
          `[WalletController] Chain transition off regtest failed (${trigger}); pinning mainnet directly`,
          summarizeError(error)
        )
      }
    }

    preferenceService.setChainType(ChainType.QBIT_MAINNET)
    try {
      await preferenceService.persist()
    } catch (error) {
      log.error('[WalletController] Failed to persist the mainnet fallback', summarizeError(error))
    }
    try {
      await walletApiService.setEndpoint(CHAINS_MAP[ChainType.QBIT_MAINNET]!.endpoints[0]!)
    } catch (error) {
      log.error('[WalletController] Failed to restore the mainnet API endpoint', summarizeError(error))
    }
    this.dropRegtestApiClients()

    // performSetChainType rolls its own failures back onto the *regtest* HD
    // path, so an unlocked keyring can still be deriving m/87'/1' here.
    // Announcing mainnet on top of that would present regtest-derived keys as
    // mainnet addresses, and anything received there would stop being derived
    // once a later unlock restores the real mainnet path. Re-sync the keyring
    // first, and if that cannot be completed, lock the wallet so nothing
    // derives from a path that disagrees with the announced chain.
    let resynced = false
    if (this.isUnlocked()) {
      try {
        await keyringService.syncQbitHdPath(getQbitHdPathForChainType(ChainType.QBIT_MAINNET))
        const keyring = await this.getCurrentKeyring()
        if (!keyring) throw new Error('no current keyring')
        const accountIndex = preferenceService.getCurrentAccount()?.index ?? 0
        await this.changeKeyring(keyring, keyring.accounts[accountIndex] ? accountIndex : 0, {
          persistPreference: true,
          broadcastAccountChange: false,
        })
        resynced = true
      } catch (error) {
        log.error(
          `[WalletController] Failed to move the keyring onto the mainnet path (${trigger}); locking`,
          summarizeError(error)
        )
      }
      if (!resynced) {
        try {
          await this.lockWallet()
        } catch (error) {
          log.error(
            '[WalletController] Failed to lock after an incomplete regtest fallback',
            summarizeError(error)
          )
        }
      }
    }

    sessionService.broadcastChainChange({
      previousChain: ChainType.QBIT_REGTEST,
      chain: ChainType.QBIT_MAINNET,
      network: this.getQbitNetworkName(),
      // Only a keyring moved onto the mainnet path has a mainnet address to give.
      accounts: resynced ? await this.getProviderAccounts() : [],
    })
    bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
      method: BUS_METHODS.CHAIN_CHANGED,
      params: { type: ChainType.QBIT_MAINNET },
    })
  }

  /** Forget cached clients bound to the loopback endpoint. */
  private dropRegtestApiClients(): void {
    for (const key of [...this.qbitApiClients.keys()]) {
      if (key.startsWith(`${ChainType.QBIT_REGTEST}:`)) {
        this.qbitApiClients.delete(key)
      }
    }
  }

  /** The current account's spendable outputs, always read afresh; see `getQbitUtxoSnapshot`. */
  getQbitUtxos = async () => (await this.readQbitUtxoSnapshot(false)).utxos

  /**
   * The current account's spendable outputs on the active network, with the
   * reserved ones excluded, together with that account and network. The UI
   * caches this for its balance card and hands the outputs back when it
   * builds a send; the chain travels with them so the builder can tell a
   * cache loaded before a network switch from outputs that exist on the
   * network it is building for, and the address lets the UI drop an answer
   * for an account it has since left.
   *
   * Past the explorer's output limit the read walks the account's whole
   * history. A send screen opened again meanwhile joins the read already
   * running for the account instead of starting another walk, as long as
   * the address statistics read the same as when that read started. A
   * broadcast, payment or confirmation the explorer has seen since then
   * changes them, so a read asked for after it starts afresh and sees, for
   * example, a send's change; it replaces the running read, which stops,
   * and whose callers are handed the new read's answer instead. The walk
   * itself reads the history again whenever the statistics moved while it
   * ran, and the reservations apply to each answer after the read, so
   * outputs a send took while it ran are still left out. Without
   * statistics the read is not shared.
   *
   * A caller that passes `readId` can stop waiting with
   * `abandonQbitUtxoSnapshot(readId)`, as the send screen does when it is
   * left; so does every read of a page whose UI port disconnects. A walk
   * nothing waits for any more stops reading.
   *
   * A read from history that completes leaves its outputs, before any
   * reservation, behind as the account's latest on that network, with the
   * address statistics its walk verified: past the explorer's limit
   * `getAddressBalanceV2` takes its split from them while the statistics
   * still read the same. A read that started later replaces them, even when
   * it found less history, and a read that fails or stops leaves nothing.
   * Locking the wallet or removing a keyring forgets them.
   */
  getQbitUtxoSnapshot = async (readId?: string | null): Promise<QbitUtxoSnapshot> => {
    // Before the first await: the page this read is tied to.
    const waiter = this.openQbitUtxoSnapshotWaiter(readId)
    try {
      return await this.readQbitUtxoSnapshot(true, waiter?.signal)
    } finally {
      waiter?.close()
    }
  }

  /**
   * The calling page stopped waiting for its `getQbitUtxoSnapshot(readId)`:
   * that call rejects, and the read behind it stops once no other caller
   * waits for it. An id the page has no read under is ignored.
   */
  abandonQbitUtxoSnapshot = async (readId: string): Promise<void> => {
    const waiters = this.qbitUtxoSnapshotWaiters.get(this.callingUiPort)
    if (typeof readId !== 'string') return
    waiters?.get(readId)?.abort(new Error('Qbit output read abandoned'))
  }

  /** Every output read the page behind `uiPort` waits for, which is gone. */
  private abandonQbitUtxoSnapshotsOf(uiPort: QbitSendClaimOwner): void {
    const waiters = this.qbitUtxoSnapshotWaiters.get(uiPort)
    this.qbitUtxoSnapshotWaiters.delete(uiPort)
    for (const waiter of waiters?.values() ?? []) {
      waiter.abort(new Error('Qbit output read abandoned'))
    }
  }

  /**
   * Register a snapshot read the calling page may abandon by `readId`.
   * Undefined, and so not abandonable, without a usable id.
   */
  private openQbitUtxoSnapshotWaiter(
    readId: string | null | undefined
  ): { signal: AbortSignal; close: () => void } | undefined {
    if (typeof readId !== 'string' || readId.length === 0 || readId.length > 64) return undefined
    const owner = this.callingUiPort
    let waiters = this.qbitUtxoSnapshotWaiters.get(owner)
    if (!waiters) {
      waiters = new Map()
      this.qbitUtxoSnapshotWaiters.set(owner, waiters)
    }
    const controller = new AbortController()
    const held = waiters
    held.set(readId, controller)
    return {
      signal: controller.signal,
      close: (): void => {
        if (held.get(readId) !== controller) return
        held.delete(readId)
        if (held.size === 0 && this.qbitUtxoSnapshotWaiters.get(owner) === held) {
          this.qbitUtxoSnapshotWaiters.delete(owner)
        }
      },
    }
  }

  /** The snapshot reads pages wait for, by UI port and the page's read id. */
  private readonly qbitUtxoSnapshotWaiters = new Map<
    QbitSendClaimOwner | undefined,
    Map<string, AbortController>
  >()

  private readQbitUtxoSnapshot = async (
    shareRead: boolean,
    signal?: AbortSignal
  ): Promise<QbitUtxoSnapshot> => {
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')

    const chain = this.getChainType()
    const client = this.getQbitApiClient(chain)
    const activity = shareRead
      ? await Promise.resolve()
          .then(() => client.getAddressStats(account.address, signal ? { signal } : undefined))
          .then(qbitHistoryProgress)
          .catch(() => undefined)
      : undefined
    if (signal?.aborted) throw signal.reason
    const qbitUtxos =
      activity === undefined
        ? await this.qbitAccountUtxosOn(chain, account, client, signal)
        : await this.qbitUtxoSnapshotReads.run(
            client,
            account.address,
            activity,
            readSignal => this.qbitAccountUtxosOn(chain, account, client, readSignal),
            signal
          )
    return {
      address: account.address,
      chain,
      utxos: await this.excludeGuardedQbitUtxos(chain, account.address, qbitUtxos),
    }
  }

  /**
   * The snapshot reads in flight, per API client and address, each at how
   * far the address's history had got when it started; only a read that
   * has got further replaces one.
   */
  private qbitUtxoSnapshotReads = new QbitReplaceableReads<UnspentOutput[], QbitHistoryProgress>(
    isLaterQbitHistoryProgress
  )

  /**
   * The latest completed read of an account's outputs from history per API
   * client and address: what the balance split needs of its outputs
   * (`QbitReadOutput`), before any reservation, with the
   * address statistics (`qbitStatsSnapshot`) its walk verified. A read that
   * started later replaces one that started earlier, even when it found
   * less history, as after an eviction. Kept in memory only, for the
   * `QBIT_LATEST_UTXO_READS_PER_CLIENT` addresses most recently used, and
   * forgotten when the wallet locks or a keyring is removed; see
   * `qbitAccountUtxosOn` and `getAddressBalanceV2`.
   */
  private readonly qbitLatestUtxoReads = new QbitLatestAnswers<{
    stats: string
    utxos: QbitReadOutput[]
    /** The earliest tip height at which a coinbase output the read left out matures. */
    matureAt?: number
    /** The lowest tip height at which every coinbase output the read took in is mature. */
    matureFrom?: number
  }>(QBIT_LATEST_UTXO_READS_PER_CLIENT)

  /**
   * The outputs a send is built from: the ones the caller loaded, or the
   * account's outputs on `chain` when it loaded none. Outputs a caller
   * loaded must name the network they were loaded on, and it must be
   * `chain`. The UI's cache is not keyed by network, and the scriptPubKey
   * filter below cannot tell networks apart, so without this a switch in
   * another window between the cache being read and this request starting
   * would let the builder accept another network's outpoints and stamp the
   * identity with `chain`; the one-time signature would then be spent on a
   * transaction the node has to reject for missing inputs.
   */
  private async qbitSendInputsOn(
    chain: ChainType,
    account: Account,
    providedUtxos: UnspentOutput[] | undefined,
    providedUtxoChain: ChainType | undefined,
    providedUtxoAddress: string | undefined
  ): Promise<UnspentOutput[]> {
    if (providedUtxos === undefined) {
      return this.assertQbitAccountOutputs(account, await this.qbitAccountUtxosOn(chain, account))
    }
    if (providedUtxoChain === undefined) {
      throw new Error('Qbit inputs must name the network they were loaded on')
    }
    if (providedUtxoChain !== chain) {
      throw new Error('Qbit network changed since the inputs were loaded')
    }
    // Nor may another account's outputs, cached before a switch in another
    // window, stand in for the selected account's.
    if (providedUtxoAddress === undefined) {
      throw new Error('Qbit inputs must name the account they were read for')
    }
    if (providedUtxoAddress !== account.address) {
      throw new Error('Qbit account changed since the inputs were loaded')
    }
    return this.assertQbitAccountOutputs(account, providedUtxos)
  }

  /**
   * `outputs`, each the account's own (`isQbitAccountOutput`): an output
   * without a scriptPubKey, or with another, is refused rather than taken
   * for the account's or skipped. Both send builders' inputs pass here.
   */
  private assertQbitAccountOutputs(account: Account, outputs: UnspentOutput[]): UnspentOutput[] {
    const accountScriptPubKey = account.p2mr?.scriptPubKey
    for (const output of outputs) {
      if (!output.scriptPk) {
        throw new Error('Qbit inputs must carry their scriptPubKey')
      }
      if (!isQbitAccountOutput(output, accountScriptPubKey)) {
        throw new Error('Qbit inputs must belong to the selected account')
      }
    }
    return outputs
  }

  /**
   * The account's unspent outputs on `chain`, before any reservation is
   * applied. The read, an over-limit walk included, stops once `signal`
   * aborts. A read from history that completes is kept as the account's
   * latest on `chain` (`qbitLatestUtxoReads`), in the order reads started,
   * under the address statistics its walk verified, not ones read before
   * it, which may have moved since; one that fails or stops leaves nothing,
   * and so does any read while the wallet is locked.
   */
  private async qbitAccountUtxosOn(
    chain: ChainType,
    account: Account,
    client: QbitWalletApiClient = this.getQbitApiClient(chain),
    signal?: AbortSignal
  ): Promise<UnspentOutput[]> {
    const order = this.qbitLatestUtxoReads.start()
    const { utxos, historyStats, matureAt, matureFrom } = await readQbitAddressUtxos(
      client,
      account.address,
      signal ? { signal } : {}
    )
    const outputs = utxos.map(v => ({
      txid: v.txid,
      vout: v.vout,
      satoshis: v.satoshis,
      scriptPk: v.scriptPk,
      addressType: v.addressType,
      pubkey: account.pubkey,
      ...(v.unconfirmed ? { unconfirmed: true, unconfirmedAncestors: v.unconfirmedAncestors } : {}),
    }))
    if (historyStats && this.isUnlocked()) {
      this.qbitLatestUtxoReads.keep(client, account.address, order, {
        stats: qbitStatsSnapshot(historyStats),
        utxos: utxos.map(qbitReadOutput),
        ...(matureAt !== undefined ? { matureAt } : {}),
        ...(matureFrom !== undefined ? { matureFrom } : {}),
      })
    }
    return outputs
  }

  /**
   * `chain` is the network the original is looked up on and the replacement
   * is priced for. A builder captures it before this first await, so a
   * network switched in another window while the lookup or the fee quote is
   * in flight cannot bind the replacement to a network its inputs do not
   * exist on.
   *
   * The explorer's JSON only names the transaction, reports whether it is
   * still pending and supplies the prevouts. Everything the replacement
   * copies comes from raw bytes that hash to `txid`, and only once this
   * account's signature over them verifies on every input, so a backend can
   * neither redirect the original's outputs nor present a send the account
   * never signed.
   *
   * Every explorer read here shares one deadline,
   * `QBIT_FEE_BUMP_ASSESSMENT_DEADLINE_MS`, and these are the slow reads of
   * a bump: they all happen before the user signs. The original's output
   * count goes with the plan, so its broadcast only asks what spends them.
   */
  private assessQbitFeeBump = async (
    txid: string,
    requestedFeeRate?: number,
    chain: ChainType = this.getChainType()
  ): Promise<QbitFeeBumpAssessment> => {
    const operation = new QbitExplorerOperation(QBIT_FEE_BUMP_ASSESSMENT_DEADLINE_MS)
    if (!isQbitChainType(chain) || !isHexByteString(txid, 32)) {
      return { eligible: false, reason: 'unverifiable' }
    }
    const originalTxid = txid.toLowerCase()

    const account = preferenceService.getCurrentAccount()
    const signMethod = getAccountCapabilities(account).signMethod
    if (
      !account?.p2mr ||
      (signMethod !== AccountSignMethod.Local && signMethod !== AccountSignMethod.External)
    ) {
      return { eligible: false, reason: 'not_wallet_transaction' }
    }
    if (
      !isHexByteString(account.p2mr.scriptPubKey) ||
      !isHexByteString(account.p2mr.leafScript) ||
      !isHexByteString(account.p2mr.pubkey || account.pubkey, 32)
    ) {
      return { eligible: false, reason: 'unverifiable' }
    }
    // The signature check proves spends of the single-key leaf of this pubkey,
    // so the stored scripts the replacement is built from must be that leaf.
    const pubkeyLeafScript = singleKeyLeafScript(
      qbitHexToBytes(account.p2mr.pubkey || account.pubkey)
    )
    const pubkeyScriptPubKey = qbitP2mrScriptPubKey(
      p2mrLeafHash(P2MR_LEAF_VERSION_V1, pubkeyLeafScript)
    )
    if (
      qbitBytesToHex(pubkeyLeafScript) !== account.p2mr.leafScript.toLowerCase() ||
      qbitBytesToHex(pubkeyScriptPubKey) !== account.p2mr.scriptPubKey.toLowerCase()
    ) {
      return { eligible: false, reason: 'unverifiable' }
    }

    const client = this.getQbitApiClient(chain)
    let transaction: EsploraTx
    try {
      transaction = await client.getTx(originalTxid, operation.read())
    } catch (error) {
      if (error instanceof QbitApiError && error.kind === 'not_found' && error.status === 404) {
        return { eligible: false, reason: 'gone' }
      }
      throw error
    }

    if (transaction.txid.toLowerCase() !== originalTxid) {
      return { eligible: false, reason: 'unverifiable' }
    }
    if (transaction.status.confirmed) {
      return { eligible: false, reason: 'confirmed' }
    }

    let raw: QbitRawP2mrTransaction | undefined
    try {
      raw = qbitRawP2mrTransaction(
        (await getQbitRawTransaction(client, originalTxid, operation.read())).transaction
      )
    } catch (error) {
      if (error instanceof QbitApiError) {
        if (error.kind === 'not_found' && error.status === 404) {
          return { eligible: false, reason: 'gone' }
        }
        // @qbit-oss/api refuses malformed bytes, and bytes that do not hash
        // to the requested txid, as `parse`.
        if (error.kind === 'parse') {
          return { eligible: false, reason: 'unverifiable' }
        }
        throw error
      }
      // Malformed bytes, or bytes that do not hash to the requested txid.
      return { eligible: false, reason: 'unverifiable' }
    }
    if (!raw) {
      return { eligible: false, reason: 'unverifiable' }
    }
    const original = raw.tx

    if (
      original.inputs.length === 0 ||
      original.outputs.length === 0 ||
      !original.inputs.some(input => input.sequence < 0xfffffffe)
    ) {
      return { eligible: false, reason: 'non_replaceable' }
    }
    if (transaction.vin.length !== original.inputs.length || !isSafeSatoshiValue(transaction.fee)) {
      return { eligible: false, reason: 'unverifiable' }
    }

    const accountScriptPubKey = account.p2mr.scriptPubKey.toLowerCase()
    const seenOutpoints = new Set<string>()
    const spentOutputs: P2mrSpentOutput[] = []
    let totalInput = 0
    for (const [index, input] of original.inputs.entries()) {
      const inputTxid = raw.inputTxids[index]!
      const listed = transaction.vin[index]!
      if (
        typeof listed.txid !== 'string' ||
        listed.txid.toLowerCase() !== inputTxid ||
        listed.vout !== input.prevout.vout
      ) {
        return { eligible: false, reason: 'unverifiable' }
      }
      const prevout = listed.prevout
      const outpoint = `${inputTxid}:${input.prevout.vout}`
      if (
        listed.is_coinbase ||
        !prevout ||
        !isSafeSatoshiValue(prevout.value, 1) ||
        !isHexByteString(prevout.scriptpubkey) ||
        prevout.scriptpubkey.toLowerCase() !== accountScriptPubKey ||
        seenOutpoints.has(outpoint)
      ) {
        return { eligible: false, reason: 'not_wallet_transaction' }
      }
      seenOutpoints.add(outpoint)
      // Explorer-supplied, but committed to by every input's signature below.
      spentOutputs.push({
        value: BigInt(prevout.value),
        scriptPubKey: qbitHexToBytes(prevout.scriptpubkey),
      })
      totalInput += prevout.value
      if (!Number.isSafeInteger(totalInput)) {
        return { eligible: false, reason: 'unverifiable' }
      }
    }

    let totalOutput = 0
    const outputValues: number[] = []
    for (const output of original.outputs) {
      const value = Number(output.value)
      if (!isSafeSatoshiValue(value) || !isQbitFeeBumpCopyableOutput(output)) {
        return { eligible: false, reason: 'unverifiable' }
      }
      outputValues.push(value)
      totalOutput += value
      if (!Number.isSafeInteger(totalOutput)) {
        return { eligible: false, reason: 'unverifiable' }
      }
    }

    const originalFee = totalInput - totalOutput
    if (originalFee < 0 || originalFee !== transaction.fee) {
      return { eligible: false, reason: 'unverifiable' }
    }

    const leafScript = qbitHexToBytes(account.p2mr.leafScript)
    const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
    const outputScripts = original.outputs.map(output => output.scriptPubKey)
    const originalEstimate = estimateQbitP2mrTransaction({
      inputCount: original.inputs.length,
      outputScriptLengths: outputScripts.map(script => script.length),
      leafScriptLength: leafScript.length,
      controlBlockLength: controlBlock.length,
    })
    if (originalEstimate.vsize !== raw.size) {
      return { eligible: false, reason: 'unverifiable' }
    }

    if (
      !qbitP2mrTransactionSignedBy({
        transaction: raw,
        spentOutputs,
        pubkey: qbitHexToBytes(account.p2mr.pubkey || account.pubkey),
      })
    ) {
      return { eligible: false, reason: 'unverifiable' }
    }

    const walletOutputIndexes = outputScripts.flatMap((script, index) =>
      qbitBytesToHex(script) === accountScriptPubKey ? [index] : []
    )
    if (walletOutputIndexes.length === 0) {
      return { eligible: false, reason: 'no_change' }
    }
    const changeOutputIndex = walletOutputIndexes[0]!
    if (
      walletOutputIndexes.length !== 1 ||
      changeOutputIndex !== original.outputs.length - 1 ||
      !outputScripts.some((script, index) => index !== changeOutputIndex && script[0] !== 0x6a)
    ) {
      return { eligible: false, reason: 'unverifiable' }
    }

    const changeBefore = outputValues[changeOutputIndex]!
    if (changeBefore < QBIT_P2MR_DUST) {
      return { eligible: false, reason: 'unverifiable' }
    }

    // A replacement conflicts with every transaction that spends one of the
    // original's outputs, and qbit Core evicts them all once its fee covers
    // theirs. The wallet sends from its own unconfirmed change, so a later
    // payment, the wallet's own or anyone's, would vanish with the bump; it
    // is refused instead. The wallet's own records catch a spend the
    // explorer has not indexed yet; the explorer catches one made elsewhere.
    await this.settleQbitRecentSpends(chain, account.address)
    if (await qbitSendGuardService.hasDependentSpend(chain, originalTxid)) {
      return { eligible: false, reason: 'has_descendants' }
    }
    let spenders: (string | undefined)[]
    try {
      spenders = await getQbitTxSpenders(
        client,
        originalTxid,
        original.outputs.length,
        operation.read()
      )
    } catch (error) {
      if (error instanceof QbitApiError) throw error
      return { eligible: false, reason: 'unverifiable' }
    }
    if (spenders.some(spender => spender !== undefined)) {
      return { eligible: false, reason: 'has_descendants' }
    }

    let feeRate = requestedFeeRate
    if (feeRate === undefined) {
      const feeSummary = await operation.within(this.getFeeSummary(chain))
      feeRate = Math.max(
        ...feeSummary.list
          .map(item => item.feeRate)
          .filter(item => Number.isFinite(item) && item > 0)
      )
    }
    if (!Number.isFinite(feeRate) || feeRate! <= 0) {
      return { eligible: false, reason: 'unverifiable' }
    }

    const originalFeeRate = originalFee / raw.size
    const targetFeeRate = Math.max(feeRate!, Math.floor(originalFeeRate) + 1)
    const withChangeEstimate = estimateQbitP2mrTransaction({
      inputCount: original.inputs.length,
      outputScriptLengths: outputScripts.map(script => script.length),
      leafScriptLength: leafScript.length,
      controlBlockLength: controlBlock.length,
      feeRate: targetFeeRate,
    })
    const targetFee = Math.max(
      originalFee + 1,
      originalFee + withChangeEstimate.vsize,
      withChangeEstimate.fee
    )
    if (!Number.isSafeInteger(targetFee)) {
      return { eligible: false, reason: 'unverifiable' }
    }

    const changeAfterTarget = changeBefore - (targetFee - originalFee)
    let outputs: P2mrTransactionOutput[]
    let replacementFee: number
    let replacementVsize: number
    let changeAfter: number
    let changeDropped: boolean

    if (changeAfterTarget >= QBIT_P2MR_DUST) {
      outputs = original.outputs.map((output, index) => ({
        value: index === changeOutputIndex ? BigInt(changeAfterTarget) : output.value,
        scriptPubKey: output.scriptPubKey,
      }))
      replacementFee = targetFee
      replacementVsize = withChangeEstimate.vsize
      changeAfter = changeAfterTarget
      changeDropped = false
    } else {
      outputs = original.outputs.flatMap((output, index) =>
        index === changeOutputIndex
          ? []
          : [{ value: output.value, scriptPubKey: output.scriptPubKey }]
      )
      const withoutChangeEstimate = estimateQbitP2mrTransaction({
        inputCount: original.inputs.length,
        outputScriptLengths: outputs.map(output => output.scriptPubKey.length),
        leafScriptLength: leafScript.length,
        controlBlockLength: controlBlock.length,
      })
      replacementFee = originalFee + changeBefore
      replacementVsize = withoutChangeEstimate.vsize
      changeAfter = 0
      changeDropped = true
    }

    const feeDelta = replacementFee - originalFee
    const replacementFeeRate = replacementFee / replacementVsize
    if (
      !Number.isSafeInteger(replacementFee) ||
      replacementFee > qbitMaximumTotalFee(replacementVsize) ||
      feeDelta < replacementVsize ||
      replacementFee <= originalFee ||
      replacementFeeRate <= originalFeeRate
    ) {
      return { eligible: false, reason: 'insufficient_change' }
    }

    return {
      eligible: true,
      plan: {
        account,
        original,
        spentOutputs,
        outputs,
        details: {
          originalTxid,
          originalOutputCount: original.outputs.length,
          originalFee,
          replacementFee,
          feeDelta,
          originalFeeRate,
          replacementFeeRate,
          replacementVsize,
          changeBefore,
          changeAfter,
          changeDropped,
        },
      },
    }
  }

  getQbitFeeBumpEligibility = async (txid: string): Promise<QbitFeeBumpEligibility> => {
    try {
      const assessment = await this.assessQbitFeeBump(txid)
      if (!assessment.eligible) return assessment
      return { eligible: true, ...assessment.plan.details }
    } catch (error) {
      log.warn('[WalletController] Unable to verify qbit fee-bump eligibility', error)
      return { eligible: false, reason: 'unverifiable' }
    }
  }

  createBumpFeeQbitPsbt = async ({
    txid,
    feeRate,
  }: {
    txid: string
    feeRate?: number
  }): Promise<ToSignData> => {
    // The original is fetched, and the replacement priced and bound, on the
    // network active when the request starts: its inputs exist nowhere else,
    // and a switch in another window during the lookup or the preflight
    // must not bind it to whichever network is active when they return.
    const chain = this.getChainType()
    let assessment: QbitFeeBumpAssessment
    try {
      assessment = await this.assessQbitFeeBump(txid, feeRate, chain)
    } catch (error) {
      log.warn('[WalletController] Unable to prepare qbit fee replacement', error)
      throw new Error(t('fee_bump_unavailable'))
    }
    if (!assessment.eligible) {
      throw new Error(`${t('fee_bump_unavailable')} (${assessment.reason})`)
    }

    const { account, original, spentOutputs, outputs, details } = assessment.plan
    if (preferenceService.getCurrentAccount()?.address !== account.address) {
      throw new Error(t('fee_bump_unavailable'))
    }

    const pubkey = account.p2mr!.pubkey || account.pubkey
    const leafScript = qbitHexToBytes(account.p2mr!.leafScript)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
    const psbt = createP2mrPsbt({
      version: original.version,
      locktime: original.locktime,
      inputs: original.inputs.map((input, index) => ({
        prevout: input.prevout,
        sequence: input.sequence,
        witnessUtxo: spentOutputs[index]!,
        leafScript,
        controlBlock,
        merkleRoot: leafHash,
      })),
      outputs,
    })

    const builtSummary = decodeQbitPsbt(psbt)
    const builtFee = Number(builtSummary.fee)
    const builtVsize = estimateQbitP2mrTransaction({
      inputCount: builtSummary.inputs.length,
      outputScriptLengths: builtSummary.outputs.map(output => output.scriptPubKey.length),
      leafScriptLength: leafScript.length,
      controlBlockLength: controlBlock.length,
    }).vsize
    if (builtFee !== details.replacementFee || builtVsize !== details.replacementVsize) {
      throw new Error(t('fee_bump_unavailable'))
    }

    const toSignInputs = original.inputs.map((_, index) => ({
      index,
      publicKey: pubkey,
    }))
    const qbitP2mrSigningKeys = original.inputs.map((_, inputIndex) => ({
      inputIndex,
      publicKey: pubkey,
      leafHash: qbitBytesToHex(leafHash),
    }))
    const signatureBudget = await keyringService.preflightP2mrPsbtSigning(account.address, {
      psbt,
      keys: qbitSigningKeysFromSerializable(qbitP2mrSigningKeys),
    })

    // Every output the replacement pays besides change. The user has nothing
    // else to compare the replacement with, so the recipients the original
    // signed for are shown beside the transaction it replaces.
    const network = chainTypeToQbitNetworkName(chain)
    const accountScriptPubKey = account.p2mr!.scriptPubKey.toLowerCase()
    const recipientDetails = outputs.flatMap(output =>
      output.scriptPubKey[0] === 0x6a || qbitBytesToHex(output.scriptPubKey) === accountScriptPubKey
        ? []
        : [
            {
              label: t('to'),
              value: outputScriptToAddress(output.scriptPubKey, network),
              type: PsbtActionDetailType.ADDRESS,
            },
            {
              label: t('amount'),
              value: Number(output.value),
              type: PsbtActionDetailType.SATOSHIS,
            },
          ]
    )

    return {
      psbtHex: qbitPsbtToHex(psbt),
      toSignInputs,
      qbitP2mrSigningKeys,
      // The replacement was verified against the live original on the
      // network captured before the lookup, so it is bound to that network
      // like a fresh send.
      qbitBroadcastIdentity: qbitBroadcastIdentityOf(psbt, chain),
      signatureBudget,
      feeBump: details,
      autoFinalized: true,
      estimatedFee: details.replacementFee,
      action: {
        name: t('bump_fee'),
        description: t('fee_bump_review_description'),
        details: [
          {
            label: t('replaces_transaction'),
            value: details.originalTxid,
            type: PsbtActionDetailType.TEXT,
          },
          ...recipientDetails,
          {
            label: t('original_fee'),
            value: details.originalFee,
            type: PsbtActionDetailType.SATOSHIS,
          },
          {
            label: t('replacement_fee'),
            value: details.replacementFee,
            type: PsbtActionDetailType.SATOSHIS,
          },
          {
            label: t('fee_increase'),
            value: details.feeDelta,
            type: PsbtActionDetailType.SATOSHIS,
            highlight: true,
          },
          {
            label: t('original_fee_rate'),
            value: `${details.originalFeeRate.toFixed(2)} bits/vB`,
            type: PsbtActionDetailType.TEXT,
          },
          {
            label: t('replacement_fee_rate'),
            value: `${details.replacementFeeRate.toFixed(2)} bits/vB`,
            type: PsbtActionDetailType.TEXT,
          },
        ],
        type: PsbtActionType.CUSTOM,
      },
    }
  }

  createSendQbitPsbt = async ({
    to,
    amount,
    feeRate,
    qbitUtxos: providedUtxos,
    qbitUtxoChain: providedUtxoChain,
    qbitUtxoAddress: providedUtxoAddress,
    enableRBF = true,
    memo,
    memos,
  }: {
    to: string
    amount: number
    feeRate?: number
    qbitUtxos?: UnspentOutput[]
    /** Required with `qbitUtxos`: the network they were loaded on. */
    qbitUtxoChain?: ChainType
    /** Required with `qbitUtxos`: the account they were read for; see `qbitSendInputsOn`. */
    qbitUtxoAddress?: string
    enableRBF?: boolean
    memo?: string
    memos?: string[]
  }): Promise<ToSignData> => {
    amount = paramsUtils.formatAmount(amount)
    if (amount < QBIT_P2MR_DUST) {
      throw new Error(`Amount must be at least ${QBIT_P2MR_DUST} sats.`)
    }

    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    assertCanCreateQbitP2mrSend(account)

    if (!account.p2mr) {
      throw new Error('Missing P2MR account metadata')
    }

    const networkType = this.getNetworkType()
    if (!isValidAddress(to, networkType) || getAddressType(to, networkType) !== AddressType.P2MR) {
      throw new Error('Invalid address.')
    }

    // The fee is quoted and the inputs are selected on the network active
    // when the request starts, and they exist nowhere else, so the request
    // carries that network from here on; a switch in another window while
    // the quote or the inputs are in flight cannot rebind it.
    const chain = this.getChainType()
    let resolvedFeeRate = feeRate
    if (resolvedFeeRate === undefined) {
      const feeSummary = await this.getFeeSummary(chain)
      resolvedFeeRate = feeSummary.list[1]?.feeRate // use normal fee rate
    }
    assertQbitFeeRateWithinPolicy(resolvedFeeRate)

    // Every output the send may spend is the selected account's: outputs
    // read for another account are refused, and so is an output without
    // the account's scriptPubKey (`qbitSendInputsOn`).
    const inputs = await this.qbitSendInputsOn(
      chain,
      account,
      providedUtxos,
      providedUtxoChain,
      providedUtxoAddress
    )
    const spendableUtxos = await this.excludeGuardedQbitUtxos(chain, account.address, inputs)
    if (spendableUtxos.length === 0) {
      throw new Error('Insufficient balance.')
    }

    const pubkey = account.p2mr.pubkey || account.pubkey
    const leafScript = qbitHexToBytes(account.p2mr.leafScript)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
    const recipientScriptPubKey = addressToScriptPk(to, networkType)
    const changeScriptPubKey = qbitHexToBytes(account.p2mr.scriptPubKey)
    const memoOutputs = qbitMemoOutputs(memo, memos)
    const memoOutputScriptLengths = memoOutputs.map(output => output.scriptPubKey.length)
    const sequence = enableRBF ? QBIT_P2MR_RBF_SEQUENCE : QBIT_P2MR_NON_RBF_SEQUENCE

    const selection = selectQbitP2mrSendCoins({
      utxos: spendableUtxos,
      amount,
      outputScriptLengths: [recipientScriptPubKey.length, ...memoOutputScriptLengths],
      changeScriptLength: changeScriptPubKey.length,
      leafScriptLength: leafScript.length,
      controlBlockLength: controlBlock.length,
      feeRate: resolvedFeeRate,
    })
    if (!selection.ok) {
      if (selection.reason === 'exceeds_maximum_total_fee') {
        throw new Error('Fee exceeds the wallet safety maximum.')
      }
      if (selection.reason === 'exceeds_standard_size') {
        throw new Error(
          `Amount needs more than ${selection.maxInputCount} inputs, over the standard transaction size; at most ${selection.maxStandardAmount} sats can be sent in one transaction.`
        )
      }
      if (selection.reason === 'exceeds_ancestor_size') {
        throw new Error(t('send_exceeds_ancestor_size'))
      }
      throw new Error('Insufficient balance.')
    }
    const {
      selected: selectedUtxos,
      fee,
      change,
      includeChange,
      changeDroppedSats,
      maximumTotalFee,
    } = selection
    const estimatedVsize = selection.estimate.vsize
    if (fee > maximumTotalFee) {
      throw new Error('Fee exceeds the wallet safety maximum.')
    }

    const outputs: P2mrTransactionOutput[] = [
      {
        value: BigInt(amount),
        scriptPubKey: recipientScriptPubKey,
      },
      ...memoOutputs,
    ]
    if (includeChange) {
      outputs.push({
        value: BigInt(change),
        scriptPubKey: changeScriptPubKey,
      })
    }

    const psbt = createP2mrPsbt({
      inputs: selectedUtxos.map(utxo => ({
        prevout: {
          txid: qbitTxidToInternalBytes(utxo.txid),
          vout: utxo.vout,
        },
        sequence,
        witnessUtxo: {
          value: BigInt(utxo.satoshis),
          scriptPubKey: qbitHexToBytes(utxo.scriptPk),
        },
        leafScript,
        controlBlock,
        merkleRoot: leafHash,
      })),
      outputs,
    })

    const toSignInputs = selectedUtxos.map((_, index) => ({
      index,
      publicKey: pubkey,
    }))
    const qbitP2mrSigningKeys = selectedUtxos.map((_, inputIndex) => ({
      inputIndex,
      publicKey: pubkey,
      leafHash: qbitBytesToHex(leafHash),
    }))
    const signatureBudget =
      getAccountCapabilities(account).signMethod === AccountSignMethod.Local
        ? await keyringService.preflightP2mrPsbtSigning(account.address, {
            psbt,
            keys: qbitSigningKeysFromSerializable(qbitP2mrSigningKeys),
          })
        : {
            required: qbitP2mrSigningKeys.length,
            cached: 0,
            remainingBefore: account.p2mr.signatureCounter.remaining,
            remainingAfter: Math.max(
              0,
              account.p2mr.signatureCounter.remaining - qbitP2mrSigningKeys.length
            ),
            limit: account.p2mr.signatureCounter.limit,
          }

    const title = `${t('send')} ${this.getQbitUnit()}`
    return {
      psbtHex: qbitPsbtToHex(psbt),
      toSignInputs,
      qbitP2mrSigningKeys,
      qbitBroadcastIdentity: qbitBroadcastIdentityOf(psbt, chain),
      signatureBudget,
      autoFinalized: true,
      estimatedFee: fee,
      estimatedVsize,
      inputCount: selectedUtxos.length,
      changeDroppedSats,
      inputsDominateFee: qbitP2mrInputsDominateFee(selection.estimate),
      maximumTotalFee,
      action: {
        name: title,
        description: '',
        details: [
          {
            label: t('to'),
            value: to,
            type: PsbtActionDetailType.ADDRESS,
          },
          {
            label: t('amount'),
            value: amount,
            type: PsbtActionDetailType.SATOSHIS,
          },
        ],
        type: PsbtActionType.CUSTOM,
      },
    }
  }

  private createSendAllQbitPsbtForAccount = async (
    data: {
      to: string
      feeRate: number
      qbitUtxos?: UnspentOutput[]
      /** Required with `qbitUtxos`: the network they were loaded on. */
      qbitUtxoChain?: ChainType
      /** Required with `qbitUtxos`: the account they were read for; see `qbitSendInputsOn`. */
      qbitUtxoAddress?: string
      enableRBF?: boolean
      memo?: string
      memos?: string[]
    },
    account: Account,
    options: {
      preflight?: boolean
      reservationsAlreadyFiltered?: boolean
      /** A consolidation batch of a source no recovery migration can read. */
      migrationConsolidation?: boolean
    } = {}
  ): Promise<ToSignData> => {
    const {
      to,
      qbitUtxos: providedUtxos,
      qbitUtxoChain: providedUtxoChain,
      qbitUtxoAddress: providedUtxoAddress,
      enableRBF = true,
      memo,
      memos,
    } = data
    const {
      preflight = true,
      reservationsAlreadyFiltered = false,
      migrationConsolidation = false,
    } = options
    let { feeRate } = data

    assertCanCreateQbitP2mrSend(account)

    if (!account.p2mr) {
      throw new Error('Missing P2MR account metadata')
    }

    const networkType = this.getNetworkType()
    if (!isValidAddress(to, networkType) || getAddressType(to, networkType) !== AddressType.P2MR) {
      throw new Error('Invalid address.')
    }

    // The fee is quoted and the inputs are selected on the network active
    // when the request starts, and they exist nowhere else, so the request
    // carries that network from here on; a switch in another window while
    // the quote or the inputs are in flight cannot rebind it.
    const chain = this.getChainType()
    if (feeRate === undefined) {
      const feeSummary = await this.getFeeSummary(chain)
      feeRate = feeSummary.list[1]?.feeRate ?? 1 // use normal fee rate or relay-floor fallback
    }
    assertQbitFeeRateWithinPolicy(feeRate)

    const fetchedUtxos = await this.qbitSendInputsOn(
      chain,
      account,
      providedUtxos,
      providedUtxoChain,
      providedUtxoAddress
    )
    // Each one the account's own, as `qbitSendInputsOn` checked.
    const spendableUtxos = reservationsAlreadyFiltered
      ? fetchedUtxos
      : await this.excludeGuardedQbitUtxos(chain, account.address, fetchedUtxos)
    if (spendableUtxos.length === 0) {
      throw new Error('Insufficient balance.')
    }

    const pubkey = account.p2mr.pubkey || account.pubkey
    const leafScript = qbitHexToBytes(account.p2mr.leafScript)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
    const recipientScriptPubKey = addressToScriptPk(to, networkType)
    const memoOutputs = qbitMemoOutputs(memo, memos)
    const sequence = enableRBF ? QBIT_P2MR_RBF_SEQUENCE : QBIT_P2MR_NON_RBF_SEQUENCE
    // Past the standard weight the largest outputs fill the transaction and
    // the rest stay in the account; the result reports them to the user.
    const selection = selectQbitP2mrSendAllCoins({
      utxos: spendableUtxos,
      outputScriptLengths: [
        recipientScriptPubKey.length,
        ...memoOutputs.map(output => output.scriptPubKey.length),
      ],
      leafScriptLength: leafScript.length,
      controlBlockLength: controlBlock.length,
      feeRate,
    })
    const { selected: selectedUtxos, fee, amount, estimate } = selection
    if (!estimate || amount < QBIT_P2MR_DUST) {
      throw new Error('Insufficient balance.')
    }
    if (selection.exceedsAncestorSize) {
      throw new Error(t('send_exceeds_ancestor_size'))
    }

    const psbt = createP2mrPsbt({
      inputs: selectedUtxos.map(utxo => ({
        prevout: {
          txid: qbitTxidToInternalBytes(utxo.txid),
          vout: utxo.vout,
        },
        sequence,
        witnessUtxo: {
          value: BigInt(utxo.satoshis),
          scriptPubKey: qbitHexToBytes(utxo.scriptPk),
        },
        leafScript,
        controlBlock,
        merkleRoot: leafHash,
      })),
      outputs: [
        {
          value: BigInt(amount),
          scriptPubKey: recipientScriptPubKey,
        },
        ...memoOutputs,
      ],
    })

    const toSignInputs = selectedUtxos.map((_, index) => ({
      index,
      publicKey: pubkey,
    }))
    const qbitP2mrSigningKeys = selectedUtxos.map((_, inputIndex) => ({
      inputIndex,
      publicKey: pubkey,
      leafHash: qbitBytesToHex(leafHash),
    }))
    const signingInput = { psbt, keys: qbitSigningKeysFromSerializable(qbitP2mrSigningKeys) }
    const signatureBudget = !preflight
      ? undefined
      : migrationConsolidation
        ? await keyringService.preflightP2mrPsbtSigning(account.address, signingInput, {
            allowMigrationConsolidation: true,
          })
        : await keyringService.preflightP2mrPsbtSigning(account.address, signingInput)

    const title = `${t('send')} ${this.getQbitUnit()}`
    return {
      psbtHex: qbitPsbtToHex(psbt),
      toSignInputs,
      qbitP2mrSigningKeys,
      qbitBroadcastIdentity: qbitBroadcastIdentityOf(psbt, chain),
      ...(signatureBudget ? { signatureBudget } : {}),
      autoFinalized: true,
      estimatedFee: fee,
      estimatedVsize: estimate.vsize,
      inputCount: selectedUtxos.length,
      changeDroppedSats: 0,
      inputsDominateFee: qbitP2mrInputsDominateFee(estimate),
      maximumTotalFee: selection.maximumTotalFee,
      leftBehindInputCount: selection.leftBehind.length,
      leftBehindSats: selection.leftBehindSatoshis,
      action: {
        name: title,
        description: '',
        details: [
          {
            label: t('to'),
            value: to,
            type: PsbtActionDetailType.ADDRESS,
          },
          {
            label: t('amount'),
            value: amount,
            type: PsbtActionDetailType.SATOSHIS,
          },
        ],
        type: PsbtActionType.CUSTOM,
      },
    }
  }

  createSendAllQbitPsbt = async (data: {
    to: string
    feeRate: number
    qbitUtxos?: UnspentOutput[]
    /** Required with `qbitUtxos`: the network they were loaded on. */
    qbitUtxoChain?: ChainType
    /** Required with `qbitUtxos`: the account they were read for; see `qbitSendInputsOn`. */
    qbitUtxoAddress?: string
    enableRBF?: boolean
    memo?: string
    memos?: string[]
  }): Promise<ToSignData> => {
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    return this.createSendAllQbitPsbtForAccount(data, account)
  }

  /** Where the current account stands against the explorer's listing limit. */
  getQbitConsolidationStatus = async (): Promise<QbitConsolidationStatus> => {
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    const chain = this.getChainType()
    if (!isQbitChainType(chain) || !account.p2mr) throw new Error(t('not_supported'))
    const counts = await getQbitAddressOutputCounts(this.getQbitApiClient(chain), account.address)
    return {
      chain,
      address: account.address,
      ...counts,
      outputLimit: QBIT_EXPLORER_DEFAULT_UTXO_LIMIT,
      maxInputCount: this.qbitConsolidationMaxInputCount(account),
    }
  }

  /**
   * The next batch of a consolidation of the current account, which holds
   * more confirmed outputs than the explorer will list: its largest mature
   * confirmed outputs, as many as one standard transaction carries, sent
   * whole to its own address. They come from a walk of the account's
   * history that continues where the previous batch stopped, never from a
   * balance. Each is checked unspent at `/tx/:txid/outspends` here and again
   * before signing, and the ones a send claim, signing lock or recent
   * broadcast holds stay out, so a batch whose broadcast is unresolved is
   * never spent twice and a run cut short resumes from what is still
   * unspent. The batch goes through the ordinary confirm, sign and broadcast
   * flow.
   */
  createQbitConsolidationPsbt = async (
    data: { feeRate?: number; enableRBF?: boolean } = {}
  ): Promise<ToSignData> => {
    // Started once the batch has the account's scan: waiting behind another
    // batch, which its own deadline bounds, spends none of it.
    const operation = new QbitExplorerOperation(QBIT_CONSOLIDATION_BATCH_DEADLINE_MS, undefined, {
      started: false,
    })
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    assertCanCreateQbitP2mrSend(account)
    if (!account.p2mr) throw new Error('Missing P2MR account metadata')
    // The batch's inputs exist on this network only; the builder refuses
    // them if the wallet has moved to another one since.
    const chain = this.getChainType()
    if (!isQbitChainType(chain)) throw new Error(t('not_supported'))
    // Unless given, the normal rate, or the relay floor without a quote.
    const feeRate =
      data.feeRate ?? (await operation.within(this.getFeeSummary(chain))).list[1]?.feeRate ?? 1
    assertQbitFeeRateWithinPolicy(feeRate)

    const client = this.getQbitApiClient(chain)
    const stats = await client.getAddressStats(account.address, operation.read())
    const counts = qbitAddressOutputCounts(stats, account.address)
    if (counts.confirmedUnspent <= QBIT_EXPLORER_DEFAULT_UTXO_LIMIT) {
      throw new Error(t('consolidation_error_within_limit'))
    }
    const maxInputCount = this.qbitConsolidationMaxInputCount(account)
    // A recovery migration cannot read such an account's outputs to plan
    // them, so while one is open the keyring signs its consolidation as well
    // as its plans, until it lists again (#344).
    const migrationConsolidation = isQbitHistoryOverReadLimit(stats)
    // A batch with too few inputs is not a failure of the walk, so it is
    // reported once the walk's operation has settled.
    const batch = await this.withQbitConsolidationScan(chain, account.address, async entry => {
      operation.start()
      const inputs = await this.selectQbitConsolidationInputs(
        chain,
        account,
        client,
        entry,
        maxInputCount,
        feeRate,
        operation
      )
      // One input merges nothing. A walk with history left to read may
      // still find more on the next request.
      if (inputs.length < 2) return { ready: false as const, exhausted: entry.scan.exhausted }
      const built = await this.createSendAllQbitPsbtForAccount(
        {
          to: account.address,
          feeRate,
          qbitUtxos: inputs.map(input => ({
            txid: input.txid,
            vout: input.vout,
            satoshis: input.value,
            scriptPk: input.scriptPk,
            addressType: AddressType.P2MR,
            pubkey: account.pubkey,
          })),
          qbitUtxoChain: chain,
          qbitUtxoAddress: account.address,
          enableRBF: data.enableRBF ?? true,
        },
        account,
        { migrationConsolidation }
      )
      const builtPsbt = qbitPsbtFromHex(built.psbtHex)
      const outpoints = qbitPsbtOutpoints(builtPsbt).map(
        outpoint => `${outpoint.txid.toLowerCase()}:${outpoint.vout}`
      )
      // The builder drops inputs a guard took meanwhile; what is left must
      // still merge. The next request selects around them.
      if (outpoints.length < 2) return { ready: false as const, exhausted: entry.scan.exhausted }
      const outputCounts = new Map<string, number>(
        inputs.map(input => [`${input.txid}:${input.vout}`, input.outputCount])
      )
      // Later batches take other outputs while this one may be signed or in
      // flight; selection returns them once nothing holds them and the
      // explorer shows them unspent (the batch was never signed).
      for (const outpoint of outpoints) {
        const candidate = entry.scan.candidates.get(outpoint)
        if (!candidate) continue
        entry.scan.candidates.delete(outpoint)
        entry.handedOut.set(outpoint, candidate)
      }
      return {
        ready: true as const,
        toSignData: built,
        psbt: builtPsbt,
        fundingOutputCounts: outpoints.map(outpoint => outputCounts.get(outpoint)!),
      }
    })
    if (!batch.ready) {
      throw new Error(
        t(
          batch.exhausted ? 'consolidation_error_nothing_ready' : 'consolidation_error_keep_reading'
        )
      )
    }
    const { toSignData, psbt, fundingOutputCounts } = batch
    this.recordQbitConsolidationBatch(qbitPsbtTxid(psbt), fundingOutputCounts)
    const qbitConsolidation: QbitConsolidationBatch = {
      confirmedOutputCount: counts.confirmedUnspent,
      outputLimit: QBIT_EXPLORER_DEFAULT_UTXO_LIMIT,
      amount: Number(decodeQbitPsbt(psbt).outputs[0]!.value),
      fundingOutputCounts,
    }
    return {
      ...toSignData,
      qbitConsolidation,
      action: {
        ...toSignData.action!,
        name: t('consolidate_outputs'),
      },
    }
  }

  private recordQbitConsolidationBatch(txid: string, fundingOutputCounts: number[]): void {
    this.qbitConsolidationBatches.delete(txid)
    this.qbitConsolidationBatches.set(txid, fundingOutputCounts)
    for (const oldest of this.qbitConsolidationBatches.keys()) {
      if (this.qbitConsolidationBatches.size <= QBIT_CONSOLIDATION_BATCH_RECORD_LIMIT) break
      this.qbitConsolidationBatches.delete(oldest)
    }
  }

  /** The shape of a consolidation batch: a whole-balance send to the account itself. */
  private qbitConsolidationShape(
    account: Account
  ): Parameters<typeof qbitP2mrMaxStandardInputCount>[0] {
    return {
      outputScriptLengths: [qbitHexToBytes(account.p2mr!.scriptPubKey).length],
      leafScriptLength: qbitHexToBytes(account.p2mr!.leafScript).length,
      controlBlockLength: buildControlBlock(P2MR_LEAF_VERSION_V1, []).length,
    }
  }

  /** Inputs one consolidation batch can carry. */
  private qbitConsolidationMaxInputCount(account: Account): number {
    return qbitP2mrMaxStandardInputCount(this.qbitConsolidationShape(account))
  }

  /**
   * The largest unguarded, mature, confirmed outputs the scan holds, up to
   * `maxInputCount`, each confirmed unspent and worth more than the fee its
   * input adds at `feeRate`. The scan first reads further pages until it
   * holds that many, and enough to pay the batch's fee and a dust output, or
   * its page budget runs out, so the largest-first choice spans everything
   * read so far. Outputs found spent leave the scan and the next largest
   * take their place. Empty when what was read cannot make such a batch.
   * Every read runs under `operation`, the batch's deadline.
   */
  private async selectQbitConsolidationInputs(
    chain: ChainType,
    account: Account,
    client: QbitWalletApiClient,
    entry: QbitConsolidationScanEntry,
    maxInputCount: number,
    feeRate: number,
    operation: QbitExplorerOperation
  ): Promise<QbitHistoryOutputCandidate[]> {
    const { scan, handedOut } = entry
    const tipHeight = await client.getTipHeight(operation.read())
    if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
      throw new Error('invalid qbit tip height')
    }
    await this.settleQbitRecentSpends(chain, account.address)
    const reserved = await qbitSendGuardService.getReservedOutpointKeys(chain, account.address)
    const accountScriptPubKey = account.p2mr!.scriptPubKey.toLowerCase()
    const shape = { ...this.qbitConsolidationShape(account), feeRate }
    // An output worth no more than the fee its own input adds would only
    // shrink the merged output; such dust stays where it is.
    const inputFee = qbitP2mrInputFee(shape)
    const usable = (): QbitHistoryOutputCandidate[] =>
      [...scan.candidates.values()].filter(
        candidate =>
          candidate.scriptPk.toLowerCase() === accountScriptPubKey &&
          candidate.value > inputFee &&
          (!candidate.coinbase || isQbitCoinbaseMature(candidate.blockHeight, tipHeight)) &&
          !reserved.has(`${candidate.txid}:${candidate.vout}`)
      )
    type Chosen = QbitHistoryOutputCandidate & { satoshis: number }
    const choose = (): Chosen[] =>
      sortQbitCoinsByValue(
        usable().map(candidate => ({ ...candidate, satoshis: candidate.value }))
      ).slice(0, maxInputCount)
    // Whether a batch of `chosen` merges anything: two inputs or more that
    // pay their fee and leave at least a dust output.
    const affordable = (chosen: readonly Chosen[]): boolean =>
      chosen.length >= 2 &&
      selectQbitP2mrSendAllCoins({ ...shape, utxos: chosen }).amount >= QBIT_P2MR_DUST
    const resetScan = (): void => {
      this.qbitConsolidationScans.delete(`${chain}:${account.address}`)
    }
    // A failure a retry would hit again (a cursor the explorer no longer
    // accepts, a candidate whose transaction a reorg removed) would fail
    // every later batch on this scan; the next batch walks from the top.
    const resettingScanOnLastingFailure = async <T>(operation: Promise<T>): Promise<T> => {
      try {
        return await operation
      } catch (error) {
        if (!isQbitTransientApiError(error)) resetScan()
        throw error
      }
    }
    // Inputs of earlier batches nothing holds any more were spent once their
    // batch went out, or the batch was never signed; the explorer says which,
    // and the unspent ones return to the walk.
    const released = [...handedOut.values()]
      .filter(candidate => !reserved.has(`${candidate.txid}:${candidate.vout}`))
      .slice(0, 2 * maxInputCount)
    if (released.length > 0) {
      const spent = await resettingScanOnLastingFailure(
        findQbitSpentOutpoints(client, released, operation)
      )
      for (const candidate of released) {
        const outpoint = `${candidate.txid}:${candidate.vout}`
        handedOut.delete(outpoint)
        if (spent.has(outpoint)) {
          scan.spent.add(outpoint)
        } else {
          scan.candidates.set(outpoint, candidate)
        }
      }
    }
    let pagesLeft = QBIT_CONSOLIDATION_PAGES_PER_BATCH
    for (let round = 1; ; round += 1) {
      pagesLeft -= await resettingScanOnLastingFailure(
        continueQbitAddressOutputScan(client, scan, {
          operation,
          maxPages: Math.max(1, pagesLeft),
          enough: () => {
            if (pagesLeft <= 0) return true
            const chosen = choose()
            // Past the candidate cap the walk stops growing, unless what it
            // holds cannot make a batch at all.
            return (
              affordable(chosen) &&
              (chosen.length >= maxInputCount ||
                scan.candidates.size >= QBIT_CONSOLIDATION_MAX_CANDIDATES)
            )
          },
        })
      )
      const chosen = choose()
      if (!affordable(chosen)) {
        // Everything read is spent, held, immature or dust. A later batch
        // reads on, or once the history is exhausted starts over and picks
        // up outputs that confirmed or matured since.
        if (scan.exhausted) resetScan()
        return []
      }
      const spent = await resettingScanOnLastingFailure(
        findQbitSpentOutpoints(client, chosen, operation)
      )
      if (spent.size === 0) return chosen
      for (const outpoint of spent) {
        scan.candidates.delete(outpoint)
        scan.spent.add(outpoint)
      }
      if (round >= QBIT_CONSOLIDATION_VERIFY_ROUNDS) {
        throw new Error(t('consolidation_error_outputs_moving'))
      }
    }
  }

  /**
   * Run `operation` on the consolidation scan of `address` on `chain`, one
   * operation per scan at a time, starting a fresh scan when there is none
   * or it has sat unused too long.
   */
  private withQbitConsolidationScan<T>(
    chain: ChainType,
    address: string,
    operation: (entry: QbitConsolidationScanEntry) => Promise<T>
  ): Promise<T> {
    const key = `${chain}:${address}`
    const previous = this.qbitConsolidationQueues.get(key) ?? Promise.resolve()
    const run = previous.then(() => {
      let entry = this.qbitConsolidationScans.get(key)
      const now = this.now()
      if (!entry || now - entry.usedAt > QBIT_CONSOLIDATION_SCAN_TTL_MS) {
        entry = {
          scan: createQbitAddressOutputScan(address),
          handedOut: new Map(),
          usedAt: now,
          failures: 0,
        }
        this.qbitConsolidationScans.set(key, entry)
      }
      entry.usedAt = now
      const current = entry
      return operation(current).then(
        result => {
          current.failures = 0
          return result
        },
        error => {
          current.failures += 1
          if (
            current.failures >= QBIT_CONSOLIDATION_SCAN_FAILURE_LIMIT &&
            this.qbitConsolidationScans.get(key) === current
          ) {
            this.qbitConsolidationScans.delete(key)
          }
          throw error
        }
      )
    })
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.qbitConsolidationQueues.set(key, settled)
    void settled.then(() => {
      if (this.qbitConsolidationQueues.get(key) === settled) {
        this.qbitConsolidationQueues.delete(key)
      }
    })
    return run
  }

  /**
   * Refuse a consolidation batch before any signature counter is reserved
   * when the explorer shows one of its inputs spent, or cannot say: its
   * inputs come from a history walk, so each one's `/tx/:txid/outspends` is
   * read again right before the one-time signatures are spent.
   */
  private async assertQbitConsolidationInputsUnspent(
    chain: ChainType,
    psbt: QbitPsbt,
    fundingOutputCounts: readonly number[]
  ): Promise<void> {
    const outpoints = qbitPsbtOutpoints(psbt)
    if (!Array.isArray(fundingOutputCounts) || fundingOutputCounts.length !== outpoints.length) {
      throw new Error('invalid Qbit consolidation batch')
    }
    const spent = await findQbitSpentOutpoints(
      this.getQbitApiClient(chain),
      outpoints.map((outpoint, index) => ({
        ...outpoint,
        outputCount: fundingOutputCounts[index]!,
      }))
    )
    if (spent.size > 0) {
      throw new Error(t('consolidation_error_input_spent'))
    }
  }

  getToSignData = async ({
    psbtHex,
    options,
    action,
  }: {
    psbtHex: string
    options?: SignPsbtOptions
    action?: PsbtActionInfo
  }): Promise<ToSignData> => {
    const toSignInputs = await this.formatOptionsToSignInputs(psbtHex, options)
    const result = await this.formatPsbt(
      transactionCore.Psbt.fromHex(psbtHex),
      toSignInputs,
      options?.autoFinalized
    )
    return {
      psbtHex: result.psbt.toHex(),
      toSignInputs: result.toSignInputs,
      autoFinalized: result.autoFinalized,
      action: action || {
        name: '',
        description: '',
        type: PsbtActionType.DEFAULT,
      },
    }
  }

  private getQbitMigrationProtectedAssetCount = async (
    account: Account,
    psbt: QbitPsbt,
    signingInputIndexes: ReadonlySet<number>
  ): Promise<number> => {
    const recoveryState = await keyringService.getQbitRecoveryState(
      account.address,
      chainTypeToQbitNetworkName(this.getChainType())
    )
    if (
      recoveryState?.status !== 'migrating' ||
      recoveryState.migration?.network !== chainTypeToQbitNetworkName(this.getChainType())
    ) {
      return 0
    }

    const inputOutpoints = qbitPsbtOutpoints(psbt)
    if (
      signingInputIndexes.size !== inputOutpoints.length ||
      inputOutpoints.some((_, inputIndex) => !signingInputIndexes.has(inputIndex))
    ) {
      return 0
    }
    const signedOutpoints = inputOutpoints
    const currentUtxos = await this.getQbitUtxos()
    const currentUtxoValues = new Map(
      currentUtxos.map(utxo => [`${utxo.txid.toLowerCase()}:${utxo.vout}`, BigInt(utxo.satoshis)])
    )
    if (
      signedOutpoints.length === 0 ||
      signedOutpoints.some(
        outpoint => !currentUtxoValues.has(`${outpoint.txid.toLowerCase()}:${outpoint.vout}`)
      )
    ) {
      return 0
    }
    const coverage = await this.getQbitProtectedAssetCoverage(signedOutpoints)
    if (coverage.protectedOutpoints.size === 0) return 0
    if (coverage.protectedOutpoints.size === signedOutpoints.length) return coverage.assetCount

    // Protected UTXOs are often too small to fund their own move, so ordinary
    // wallet UTXOs may ride along — but only to pay the fee. Any excess must
    // return to this account as change, so external outputs never carry more
    // value than the protected inputs themselves and the escape cannot drain
    // ordinary funds. Input values come from the wallet's own UTXO view; the
    // P2MR sighash commits spent output values, so a PSBT lying about them
    // cannot produce a broadcastable transaction.
    if (!account.p2mr) return 0
    let totalInputValue = 0n
    let ordinaryInputValue = 0n
    for (const outpoint of signedOutpoints) {
      const key = `${outpoint.txid.toLowerCase()}:${outpoint.vout}`
      const value = currentUtxoValues.get(key)!
      totalInputValue += value
      if (!coverage.protectedOutpoints.has(key)) ordinaryInputValue += value
    }
    const accountScriptPubKey = account.p2mr.scriptPubKey.toLowerCase()
    let totalOutputValue = 0n
    let changeValue = 0n
    for (const output of decodeQbitPsbt(psbt).outputs) {
      totalOutputValue += output.value
      if (qbitBytesToHex(output.scriptPubKey) === accountScriptPubKey) {
        changeValue += output.value
      }
    }
    const fee = totalInputValue - totalOutputValue
    if (fee < 0n || ordinaryInputValue > fee + changeValue) return 0
    return coverage.assetCount
  }

  prepareQbitProviderPsbt = async (
    psbtHex: string,
    options: QbitProviderSignPsbtOptions
  ): Promise<ToSignData> => {
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    assertCanCreateQbitP2mrSend(account)
    if (!account.p2mr) {
      throw new Error('active account is not a Qbit P2MR account')
    }

    const psbt = qbitPsbtFromHex(psbtHex)
    // The provider request was already checked against the active network,
    // and the guard looks up its inputs there; the request carries that
    // network so signing stays bound to it.
    const chain = this.getChainType()
    await qbitSendGuardService.assertNoOverlap(chain, qbitPsbtOutpoints(psbt), qbitPsbtTxid(psbt))
    const summary = decodeQbitPsbt(psbt)
    const accountLeafScript = account.p2mr.leafScript.toLowerCase()
    const publicKey = account.p2mr.pubkey.toLowerCase()
    if (account.pubkey.toLowerCase() !== publicKey) {
      throw new Error('P2MR account public key metadata mismatch')
    }

    const qbitP2mrSigningKeys: QbitP2mrSigningKeyInput[] = []
    summary.inputs.forEach((input, inputIndex) => {
      input.leafScripts.forEach(leaf => {
        if (qbitBytesToHex(leaf.script) !== accountLeafScript) return
        const leafHash = qbitBytesToHex(p2mrLeafHash(leaf.leafVersion, leaf.script))
        // Refuses a leaf listed twice, so each leaf is planned once, and one
        // whose control block does not commit, before any counter moves.
        assertQbitP2mrSigningLeafRecord(input, inputIndex, leafHash)
        qbitP2mrSigningKeys.push({ inputIndex, publicKey, leafHash })
      })
    })

    if (qbitP2mrSigningKeys.length === 0) {
      throw new Error('PSBT has no inputs signable by the active Qbit account')
    }

    const signingKeys = qbitSigningKeysFromSerializable(qbitP2mrSigningKeys)
    validateP2mrSigningPlans({ psbt, keys: signingKeys })
    // Decided before the budget preflight, which can issue a restored-floor
    // challenge, so a refusal leaves none for this PSBT; the request's
    // failure cleanup releases those of earlier signPsbts entries.
    const autoFinalized = qbitProviderPsbtAutoFinalized(psbt, signingKeys, options.autoFinalized)

    const protectedAssetCount =
      getAccountCapabilities(account).signMethod === AccountSignMethod.Local
        ? await this.getQbitMigrationProtectedAssetCount(
            account,
            psbt,
            new Set(qbitP2mrSigningKeys.map(key => key.inputIndex))
          )
        : 0
    const signingInput = { psbt, keys: signingKeys }
    const signatureBudget =
      getAccountCapabilities(account).signMethod === AccountSignMethod.Local
        ? protectedAssetCount > 0
          ? await keyringService.preflightP2mrPsbtSigning(account.address, signingInput, {
              allowMigrationProtectedAssetTransfer: true,
            })
          : await keyringService.preflightP2mrPsbtSigning(account.address, signingInput)
        : {
            required: qbitP2mrSigningKeys.length,
            cached: 0,
            remainingBefore: account.p2mr.signatureCounter.remaining,
            remainingAfter: Math.max(
              0,
              account.p2mr.signatureCounter.remaining - qbitP2mrSigningKeys.length
            ),
            limit: account.p2mr.signatureCounter.limit,
          }

    const toSignInputs = [...new Set(qbitP2mrSigningKeys.map(key => key.inputIndex))].map(
      index => ({ index, publicKey })
    )
    return {
      psbtHex: qbitPsbtToHex(psbt),
      toSignInputs,
      qbitP2mrSigningKeys,
      qbitBroadcastIdentity: qbitBroadcastIdentityOf(psbt, chain),
      signatureBudget,
      autoFinalized,
      action:
        protectedAssetCount > 0
          ? {
              name: t('sign_transaction'),
              description: t('qbit_recovery_migration_signing_only'),
              details: [
                {
                  label: t('qbit_recovery_migrating_title'),
                  value: protectedAssetCount,
                  type: PsbtActionDetailType.TEXT,
                  warning: true,
                },
              ],
              type: PsbtActionType.CUSTOM,
            }
          : {
              name: '',
              description: '',
              type: PsbtActionType.DEFAULT,
            },
    }
  }

  /**
   * Parse a signed PSBT or raw transaction into the exact bytes that will be
   * broadcast, plus the txid and outpoints the send guard checks. Everything
   * here runs before any network request, so a failure proves non-submission.
   */
  private prepareQbitBroadcast(
    txData: string,
    chain: ChainType = this.getChainType()
  ): {
    chain: ChainType
    client: QbitWalletApiClient
    rawtx: string
    txid: string
    outpoints: QbitOutpoint[]
  } {
    const client = this.getQbitApiClient(chain)
    return { chain, client, ...qbitSignedTransaction(txData) }
  }

  /**
   * Broadcast signed bytes and throw on failure: a recovery migration's
   * plan. An accepted broadcast records its inputs as recently spent inside
   * the guard. A failure records nothing. The provider's pushTx and pushPsbt
   * broadcast through `broadcastQbitProviderTx`, and its sendQbit under its
   * claim through `broadcastQbitTx`.
   */
  pushTx = async (txData: string, qbitSendBroadcastClaim?: QbitSendBroadcastClaim) => {
    const { chain, client, rawtx, txid, outpoints } = this.prepareQbitBroadcast(txData)
    if (!qbitSendBroadcastClaim) {
      return qbitSendGuardService.broadcastIfAllowed(chain, txid, outpoints, () =>
        client.broadcastTx(rawtx)
      )
    }
    return qbitSendGuardService.broadcastIfAllowed(
      chain,
      txid,
      outpoints,
      async (replaces, replacedOutputCount) => {
        if (replaces) await assertNoExplorerDependentSpend(client, replaces, replacedOutputCount)
        return client.broadcastTx(rawtx)
      },
      qbitSendBroadcastClaim
    )
  }

  /**
   * Broadcast bytes a dapp pushed (the provider's pushTx and pushPsbt) and
   * report the verdict the send path reaches (`broadcastQbitTx`) instead of
   * the bare error: a 2xx must echo the txid; an apparent failure is looked
   * up, and reported as success when the network holds the transaction;
   * `not_sent` is reported only for bytes that never left the wallet or that
   * the node definitively rejected with absence proven; and anything else is
   * `unknown`, naming the network and txid so the dapp can look the
   * transaction up before it retries. Once the active network is read,
   * every outcome is a verdict, never an error.
   *
   * The guard's records follow the verdict only as far as a dapp's bytes can
   * be trusted. An accepted or found transaction records its inputs as
   * recently spent, as for any broadcast. An unknown outcome reserves them
   * only for a transaction the user approved signing for a dapp
   * (`recordQbitProviderSignings`): a push needs no approval, and a dapp can
   * push any bytes over the account's public outputs. A proven rejection
   * forgets nothing on record: a txid does not cover the witness, so a dapp
   * can have the node reject a variant of a transaction the node holds, and
   * lookups that lag the node would then free inputs that transaction
   * spends. The probe cycle frees them once it finds the spender gone.
   */
  broadcastQbitProviderTx = async (txData: string): Promise<QbitBroadcastResult> => {
    const chain = this.getChainType()
    let prepared: ReturnType<WalletController['prepareQbitBroadcast']>
    try {
      prepared = this.prepareQbitBroadcast(txData, chain)
    } catch (error) {
      return this.qbitBroadcastFailure({
        chain,
        outcome: 'not_sent',
        reason: 'invalid_transaction',
        detail: sanitizeQbitBroadcastDetail(qbitBroadcastErrorMessage(error)),
      })
    }
    const { txid, outpoints } = prepared
    try {
      return await this.attemptQbitBroadcast(txData, undefined, chain, txid, undefined, true)
    } catch (error) {
      // attemptQbitBroadcast reports every failure as a verdict; anything it
      // throws is unexpected, and may come after the bytes left, so it is an
      // unknown outcome like any other.
      console.error('Unexpected failure broadcasting a Qbit transaction a dapp pushed', error)
      try {
        await qbitSendGuardService.recordInconclusiveProviderPush(chain, txid, outpoints)
      } catch {
        // The bytes were validated before dispatch; the verdict stands.
      }
      return this.qbitBroadcastFailure({ chain, txid, outcome: 'unknown', reason: 'unexpected' })
    }
  }

  /**
   * Remember the transactions the user just approved signing for a dapp
   * (provider signPsbt and signPsbts), so that the dapp's broadcast of one
   * through `broadcastQbitProviderTx` keeps its inputs reserved when its
   * outcome is unknown. Every record is queued on the send guard before
   * this returns, so a broadcast requested afterwards is decided after it
   * and the caller need not wait. Never rejects: a transaction left
   * unrecorded is treated as any other push.
   */
  recordQbitProviderSignings = (
    identities: readonly (QbitBroadcastIdentity | undefined)[]
  ): Promise<void> =>
    Promise.all(
      identities.map(identity =>
        identity
          ? qbitSendGuardService
              .recordProviderSigning(identity.chain, identity.txid)
              .catch(error => {
                log.warn('Could not record a Qbit transaction signed for a dapp', error)
              })
          : undefined
      )
    ).then(() => undefined)

  /**
   * Pause between the repeated absence probes that follow a definitive node
   * rejection. Instance-level so tests can collapse it without fake timers.
   */
  qbitBroadcastProbeDelayMs = QBIT_BROADCAST_ABSENCE_PROBE_DELAY_MS

  /**
   * Pauses before re-sending the same bytes after an unknown outcome whose
   * lookup missed the transaction; their number bounds the re-sends.
   * Instance-level for the same reason.
   */
  qbitBroadcastResendDelaysMs: readonly number[] = QBIT_BROADCAST_RESEND_DELAYS_MS

  /**
   * UI-facing broadcast that reports a plain, serializable verdict instead of
   * throwing across the extension port (which strips error prototypes); the
   * provider's sendQbit broadcasts its approved claim through it as well, so
   * a dapp gets the same verdicts and its claim the same treatment. The
   * network and expected txid are captured before dispatch and retained on
   * every failure, including the refusals made before the bytes are parsed,
   * so the caller can retry the exact same bytes or probe the network
   * without signing again, and can release the send claim minted for that
   * transaction when it abandons them. A caller that already knows which
   * transaction the bytes must be (the identity fixed when the wallet built
   * the request) passes `expectedTxid`, and bytes for any other transaction
   * are refused before dispatch.
   *
   * Only two situations report `not_sent`: the request never left the wallet
   * (payload, guard, or network-switch failure, observed through the dispatch
   * marker rather than by inspecting the error), or the node definitively
   * rejected the bytes *and* repeated follow-up lookups all found the
   * transaction absent, with no earlier call for them ended `unknown`
   * (see `QbitSendGuardService.hasUnknownBroadcastOutcome`). Every other
   * failure is `unknown`, because a lost
   * response may hide an accepted transaction; the API client never re-sends
   * a submission that may have reached the node, and reports one as
   * `unknown_outcome`. An apparent failure whose lookup finds the
   * transaction pending or confirmed is reported as success, and a transient
   * failure whose lookup misses it is sent again, a few times at most, with
   * exactly the same bytes (see `attemptQbitBroadcast`). One guard
   * refusal is the exception to the first rule: a claim the guard no longer
   * holds for this exact transaction is what an earlier, lost success leaves
   * behind, so that refusal is probed and reported like a lost response.
   * When the probe misses and the guard has no record of the claim at all,
   * which is what a background restart leaves the page holding, the
   * wallet's own claim is restored under the checks minting applies and the
   * retained bytes are dispatched, so recovery needs no second signature.
   * `retryOfUnknownOutcome` is passed only by the wallet's recovery screen,
   * when its verdict for these bytes is `unknown`: a claim restored then
   * counts as an earlier unknown outcome (see
   * `QbitSendGuardService.restoreBroadcastClaim`). The provider never
   * passes it.
   */
  broadcastQbitTx = async (
    txData: string,
    qbitSendBroadcastClaim?: QbitSendBroadcastClaim | null,
    expectedChain?: ChainType | null,
    expectedTxid?: string | null,
    retryOfUnknownOutcome?: boolean | null
  ): Promise<QbitBroadcastResult> => {
    // Before the first await: the port this verdict is handed back to. The
    // attempt is marked in flight synchronously as well, so that port
    // disconnecting mid-broadcast defers to the verdict instead of
    // releasing a claim the node may be consuming right now.
    const uiPort = this.callingUiPort
    const claim = qbitSendBroadcastClaim ?? undefined
    if (claim) qbitSendGuardService.beginBroadcastAttempt(claim, uiPort)
    let verdict: QbitSendClaimVerdict = 'inconclusive'
    try {
      const result = await this.attemptQbitBroadcast(
        txData,
        claim,
        expectedChain,
        expectedTxid,
        uiPort,
        false,
        retryOfUnknownOutcome === true
      )
      verdict = result.success
        ? 'accepted'
        : result.outcome !== 'not_sent'
          ? 'inconclusive'
          : // The lookup marker is present only for verdicts reached after
            // dispatch; a refusal that never left the wallet carries none.
            result.lookup === undefined
            ? 'refused'
            : 'proven_absent'
      return result
    } finally {
      if (claim) await qbitSendGuardService.settleBroadcastAttempt(claim, verdict)
    }
  }

  private attemptQbitBroadcast = async (
    txData: string,
    claim: QbitSendBroadcastClaim | undefined,
    expectedChain?: ChainType | null,
    expectedTxid?: string | null,
    uiPort?: QbitSendClaimOwner,
    providerPush = false,
    retryOfUnknownOutcome = false
  ): Promise<QbitBroadcastResult> => {
    // One deadline for the whole call: every pass, its fee bump check and
    // submission, and every lookup. It starts once the call has the send
    // guard's queue, so a send waiting behind another (which its own
    // deadline bounds) is still tried. Once it passes, a lookup fails, which
    // leaves the verdict unknown, and a pass with too little of it left
    // sends nothing.
    const operation = new QbitExplorerOperation(QBIT_BROADCAST_DEADLINE_MS, undefined, {
      started: false,
    })
    const chain = this.getChainType()
    // Every refusal below happens before dispatch, so nothing was sent and
    // the caller may abandon the retained bytes. The recovery screen releases
    // the send claim only for a verdict that names the claim's own network
    // and txid, so each of these verdicts names the transaction the caller
    // bound the broadcast to: a verdict without it would leave the claim's
    // inputs reserved, and unspendable, until the background restarts.
    const boundTxid = qbitBoundBroadcastTxid(expectedTxid, claim)
    if (expectedChain !== undefined && expectedChain !== null && expectedChain !== chain) {
      return this.qbitBroadcastFailure({
        chain: expectedChain,
        txid: boundTxid,
        outcome: 'not_sent',
        reason: 'chain_changed',
      })
    }

    let prepared: ReturnType<WalletController['prepareQbitBroadcast']>
    try {
      prepared = this.prepareQbitBroadcast(txData, chain)
    } catch (error) {
      return this.qbitBroadcastFailure({
        chain,
        txid: boundTxid,
        outcome: 'not_sent',
        reason: 'invalid_transaction',
        detail: sanitizeQbitBroadcastDetail(qbitBroadcastErrorMessage(error)),
      })
    }
    const { client, rawtx, txid, outpoints } = prepared

    // A local signer can only return the transaction the wallet built, but an
    // external or cold-wallet signer hands back whatever was pasted or
    // scanned, and the UI cannot parse it. The UI therefore names the txid
    // fixed at creation, and bytes for any other transaction are refused
    // here, before dispatch: otherwise a lost answer would leave recovery
    // probing and showing that txid for a transaction that may have gone
    // out under a different one. A send claim binds the txid the same way
    // inside the guard; this check covers the claim-less path as well. The
    // verdict names the expected transaction, never the bytes' own.
    if (expectedTxid !== undefined && expectedTxid !== null) {
      const expected = typeof expectedTxid === 'string' ? expectedTxid.trim().toLowerCase() : ''
      if (expected !== txid.toLowerCase()) {
        return this.qbitBroadcastFailure({
          chain,
          txid: boundTxid,
          outcome: 'not_sent',
          reason: 'invalid_transaction',
          detail: 'signed transaction does not match the approved transaction',
        })
      }
    }

    // Set the moment the guard hands control to the network callback, so a
    // guard rejection (no dispatch) is never confused with a transport error.
    // Every pass starts them over; `firstDispatchAt` is when any pass first
    // handed the bytes to the network.
    let dispatched = false
    let chainChangedBeforeDispatch = false
    let dependentSpendRefused = false
    let deadlineRefused = false
    let firstDispatchAt: number | undefined
    // Re-sends of the same bytes so far (see below), and the verdict the
    // last dispatched pass reached while they are under way, which a
    // re-send refused before dispatch leaves standing.
    let resends = 0
    let unresolved: QbitBroadcastFailure | undefined
    const assertChainUnchanged = (): void => {
      if (this.getChainType() !== chain) {
        chainChangedBeforeDispatch = true
        throw new Error('Qbit network changed before broadcast')
      }
    }
    // A pass is sent only with at least a submission's reply budget of the
    // deadline left: one cut off in flight would only add an unknown outcome.
    const assertTimeToSend = (): void => {
      if (operation.remainingMs() < QBIT_BROADCAST_MIN_PASS_MS) {
        deadlineRefused = true
        throw new Error('Qbit broadcast deadline left no time to send')
      }
    }
    const broadcast = async (replaces?: string, replacedOutputCount?: number): Promise<string> => {
      operation.start()
      assertTimeToSend()
      // The guard queue may hold a re-send past the window it was due in;
      // none starts once the window has passed.
      if (
        resends > 0 &&
        firstDispatchAt !== undefined &&
        Date.now() - firstDispatchAt >= QBIT_BROADCAST_RESEND_WINDOW_MS
      ) {
        throw new Error('Qbit broadcast re-send window has passed')
      }
      // The guard queue may run this later than it was requested; re-check
      // the network right before the bytes leave the wallet.
      assertChainUnchanged()
      // A fee bump was assessed against the payments spending its original
      // when it was built, and the guard has just checked its own records
      // again; a payment made elsewhere since then shows only on the
      // explorer. Asked here, with the guard's queue held, so nothing this
      // wallet does can come in between; a refusal is still pre-dispatch.
      // Only what spends the original is read: its output count comes with
      // the claim, from the bytes the assessment verified before signing.
      if (replaces) {
        try {
          await assertNoExplorerDependentSpend(client, replaces, replacedOutputCount, {
            operation,
          })
        } catch (error) {
          dependentSpendRefused = true
          throw error
        }
        assertChainUnchanged()
      }
      // Before anything is sent: the fee bump check may have spent the rest.
      assertTimeToSend()
      const submission = operation.read()
      dispatched = true
      if (firstDispatchAt === undefined) firstDispatchAt = Date.now()
      const response = await client.broadcastTx(rawtx, submission)
      // Validate inside the guard: `broadcastIfAllowed` consumes the send
      // claim as soon as this callback resolves, so a 2xx that does not echo
      // the txid (a proxy page, an unexpected backend) must reject here to
      // keep the claim reserved for a byte-identical retry. The node may
      // still have accepted the bytes, so the caller lets the lookup decide;
      // the response body never leaves this scope.
      if (typeof response !== 'string' || response.trim().toLowerCase() !== txid.toLowerCase()) {
        throw new QbitBroadcastResponseMismatchError()
      }
      return txid
    }

    // One pass, and one more after the guard's refusal of a claim it has no
    // record of was resolved by restoring that claim, plus one per re-send.
    let restored = false
    for (;;) {
      dispatched = false
      chainChangedBeforeDispatch = false
      dependentSpendRefused = false
      deadlineRefused = false
      try {
        if (claim) {
          await qbitSendGuardService.broadcastIfAllowed(chain, txid, outpoints, broadcast, claim)
        } else {
          await qbitSendGuardService.broadcastIfAllowed(chain, txid, outpoints, broadcast)
        }
        return { success: true, chain, txid, via: 'broadcast' }
      } catch (error) {
        // The guard may refuse a pass in its queue without running it.
        operation.start()
        if (dispatched) {
          const classification = classifyQbitBroadcastError(error)
          // A re-send's rejection says nothing about the pass before it,
          // whose bytes may have reached another node behind the same
          // endpoint: after an unknown outcome, only success may follow,
          // and one lookup is all that can find it. The same holds after
          // an earlier call for these bytes ended unknown: a Retry from the
          // recovery screen is a new call. A dapp's push is left its own
          // verdict: its bytes may not be the ones that went out before (a
          // txid does not cover the witness), and its proven absence
          // forgets nothing.
          const afterUnknown =
            unresolved !== undefined ||
            (classification.definitiveRejection &&
              !providerPush &&
              (await qbitSendGuardService.hasUnknownBroadcastOutcome(chain, txid)))
          const resolved = await this.resolveQbitBroadcastAfterFailure(
            chain,
            txid,
            outpoints,
            afterUnknown ? { ...classification, definitiveRejection: false } : classification,
            claim,
            operation,
            true,
            providerPush
          )
          // The API client never re-sends a submission that may have reached
          // the node, so a transient failure on the way (a 502, a timeout, a
          // reply that is not the txid) leaves the outcome unknown. Once the
          // lookup has reconciled it and missed the transaction, send the
          // very same bytes again, a bounded number of times: the txid is the
          // operation's identity, and a node that already holds it answers
          // with the txid or as already known (-27), which is success. Each
          // re-send passes the guard again, so it goes out only while the
          // claim for exactly this transaction is still held (and, for a
          // claim-less push, while no claim, lock or other broadcast has
          // taken its inputs since), and the network is re-checked as for
          // the first. It stops at the first success, at a node verdict, at
          // a lookup that cannot run and at the end of the window: none of
          // those is a transient failure of this request.
          const delay = this.qbitBroadcastResendDelaysMs[resends]
          if (
            resolved.success === true ||
            resolved.outcome !== 'unknown' ||
            resolved.lookup !== 'gone' ||
            !isQbitBroadcastResendable(error) ||
            delay === undefined ||
            firstDispatchAt === undefined ||
            Date.now() + delay - firstDispatchAt >= QBIT_BROADCAST_RESEND_WINDOW_MS
          ) {
            return resolved
          }
          await qbitBroadcastProbeDelay(delay)
          resends += 1
          unresolved = resolved
          continue
        }
        // A re-send refused before dispatch sent nothing, so the unknown
        // outcome of the pass before it stands, never a "not sent". The
        // transaction is looked up once more first: the guard no longer
        // holding the claim is what that pass landing leaves behind once a
        // lookup elsewhere found it, and the explorer may have caught up
        // during the pause.
        if (unresolved) {
          return (
            (await this.qbitBroadcastFoundAfterRefusal(chain, txid, outpoints, claim, operation)) ??
            unresolved
          )
        }
        // A retry of a fee bump whose earlier dispatch the node took finds
        // its original gone, replaced by the bump itself, and the check
        // above cannot pass again. Look the bump up before refusing: found,
        // it is the success the first answer lost. Anything else leaves
        // this call's refusal standing, as nothing was dispatched.
        if (dependentSpendRefused) {
          const found = await this.qbitBroadcastFoundAfterRefusal(
            chain,
            txid,
            outpoints,
            claim,
            operation
          )
          if (found) return found
        }
        // The guard consumes a send claim the moment its broadcast callback
        // resolves, so a retry whose first answer was lost between the
        // background and the UI presents a claim the guard no longer holds;
        // so does every claim once the background has restarted. Nothing was
        // dispatched by *this* call, but the guard's refusal says nothing
        // about the earlier one, and a "not sent" verdict here would free the
        // inputs of a payment the node may already hold. Probe the network
        // instead: a found transaction is the success that was lost, and
        // anything else stays inconclusive. When the probe misses, a claim
        // the guard never saw (the restart case; a claim it consumed or
        // released is never restored) is restored, once, under the same
        // checks minting applies, and these exact bytes are dispatched under
        // it: otherwise every retry would repeat the probe and recovery
        // would require a second one-time signature.
        if (error instanceof QbitSendBroadcastClaimInactiveError) {
          const resolved = await this.resolveQbitBroadcastAfterFailure(
            chain,
            txid,
            outpoints,
            { reason: 'guard_blocked', definitiveRejection: false, detail: error.message },
            claim,
            operation,
            false
          )
          if (restored || !claim || resolved.success === true || resolved.lookup !== 'gone') {
            return resolved
          }
          const restoration = await this.restoreQbitSendBroadcastClaim(
            claim,
            chain,
            txid,
            outpoints,
            uiPort,
            retryOfUnknownOutcome
          )
          if (restoration === 'restored') {
            restored = true
            continue
          }
          if (restoration === 'account_changed') {
            return { ...resolved, detail: 'Qbit account changed since the transaction was created' }
          }
          return resolved
        }
        const refusal = {
          chain,
          txid,
          reason: chainChangedBeforeDispatch
            ? ('chain_changed' as const)
            : deadlineRefused
              ? ('timeout' as const)
              : ('guard_blocked' as const),
          detail: sanitizeQbitBroadcastDetail(qbitBroadcastErrorMessage(error)),
        }
        // Nothing left the wallet in this call, which says nothing about an
        // earlier call for these bytes whose outcome stayed unknown: a Retry
        // from the recovery screen, a claim restored on its unknown verdict,
        // or one whose last verdict was inconclusive. That outcome stands,
        // and the inputs stay reserved; "not sent" would let the screen free
        // inputs a payment may still be spending. A dapp's push keeps its own
        // verdict, as above.
        if (!providerPush && (await qbitSendGuardService.hasUnknownBroadcastOutcome(chain, txid))) {
          try {
            await qbitSendGuardService.recordInconclusiveBroadcast(
              chain,
              txid,
              outpoints,
              claim,
              false
            )
          } catch {
            // The bytes were validated before dispatch; the verdict stands.
          }
          return this.qbitBroadcastFailure({ ...refusal, outcome: 'unknown' })
        }
        return this.qbitBroadcastFailure({ ...refusal, outcome: 'not_sent' })
      }
    }
  }

  /**
   * Look `txid` up after a refusal that dispatched nothing: a transaction
   * the network holds is the success an earlier dispatch's lost answer
   * hid, and is recorded as accepted. Anything else, a lookup failure
   * included, leaves the refusal standing (`undefined`).
   */
  private async qbitBroadcastFoundAfterRefusal(
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[],
    claim: QbitSendBroadcastClaim | undefined,
    operation: QbitExplorerOperation
  ): Promise<QbitBroadcastResult | undefined> {
    try {
      const lifecycle = await this.probeQbitBroadcastLifecycle(chain, txid, operation)
      if (lifecycle.state === 'gone') return undefined
    } catch {
      return undefined
    }
    await this.recordQbitBroadcastAcceptance(claim, chain, txid, outpoints)
    return { success: true, chain, txid, via: 'lookup' }
  }

  /**
   * Restore, for the broadcast about to be dispatched, a wallet-owned send
   * claim the guard has no record of. The retained bytes and their claim
   * outlive the background worker in the page's memory: after the worker
   * restarts, the guard holds nothing, and a retry would otherwise never
   * dispatch again. Restoring re-files the reservation minting made, so the
   * dispatch consumes it or, failing inconclusively, keeps the inputs
   * reserved, exactly as for a claim that was never lost. Everything
   * minting validated is validated again: the claim is the wallet's own,
   * names the network, txid and inputs of the bytes being dispatched, and
   * belongs to the selected account, whose address a wallet claim is filed
   * under; as for an externally signed reservation, another account being
   * selected refuses the restoration and selecting the building account
   * again accepts it. The guard applies its own checks first (a claim it
   * consumed or released is never restored, whatever the account; no
   * overlap) and marks the attempt in flight.
   */
  private async restoreQbitSendBroadcastClaim(
    claim: QbitSendBroadcastClaim,
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[],
    uiPort: QbitSendClaimOwner | undefined,
    retryOfUnknownOutcome: boolean
  ): Promise<'restored' | 'account_changed' | 'refused'> {
    if (
      claim.origin !== QBIT_WALLET_SEND_CLAIM_ORIGIN ||
      claim.chain !== chain ||
      typeof claim.txid !== 'string' ||
      claim.txid.toLowerCase() !== txid.toLowerCase() ||
      !Array.isArray(claim.outpoints) ||
      !sameQbitOutpoints(claim.outpoints, outpoints)
    ) {
      return 'refused'
    }
    const account = preferenceService.getCurrentAccount()
    if (!account) return 'refused'
    const restoration = await qbitSendGuardService.restoreBroadcastClaim(
      claim,
      account.address,
      uiPort,
      retryOfUnknownOutcome
    )
    return restoration === 'address_mismatch' ? 'account_changed' : restoration
  }

  /**
   * Probe a transaction the UI already tried to broadcast. Reports plain
   * values instead of throwing so a lookup failure stays distinguishable from
   * a definitive absence; neither ever proves the transaction was not sent.
   * The lookup has `QBIT_BROADCAST_STATUS_CHECK_DEADLINE_MS`, past which it
   * is `unavailable`: the recovery screen ignores its exits until then.
   */
  checkQbitBroadcastStatus = async (
    txid: string,
    chain?: ChainType | null,
    qbitSendBroadcastClaim?: QbitSendBroadcastClaim | null
  ): Promise<QbitBroadcastStatusCheck> => {
    const normalized = typeof txid === 'string' ? txid.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      return { found: false, txid: normalized, state: 'unavailable', detail: 'invalid txid' }
    }
    const currentChain = this.getChainType()
    if (chain !== undefined && chain !== null && chain !== currentChain) {
      return {
        found: false,
        txid: normalized,
        state: 'unavailable',
        detail: 'Qbit network changed since the broadcast',
      }
    }
    try {
      const lifecycle = await this.probeQbitBroadcastLifecycle(
        currentChain,
        normalized,
        new QbitExplorerOperation(QBIT_BROADCAST_STATUS_CHECK_DEADLINE_MS)
      )
      if (lifecycle.state === 'gone') return { found: false, txid: normalized, state: 'gone' }
      if (lifecycle.state === 'pending') {
        await qbitSendGuardService.observePendingSpender(currentChain, normalized)
      }
      await this.consumeQbitBroadcastClaimAfterAcceptance(
        qbitSendBroadcastClaim ?? undefined,
        currentChain,
        normalized
      )
      return { found: true, txid: normalized, state: lifecycle.state }
    } catch (error) {
      const detail = sanitizeQbitBroadcastDetail(qbitBroadcastErrorMessage(error))
      return detail === undefined
        ? { found: false, txid: normalized, state: 'unavailable' }
        : { found: false, txid: normalized, state: 'unavailable', detail }
    }
  }

  private async probeQbitBroadcastLifecycle(
    chain: ChainType,
    txid: string,
    operation: QbitExplorerOperation
  ): Promise<{ state: 'confirmed' | 'pending' | 'gone' }> {
    if (this.getChainType() !== chain) {
      throw new Error('Qbit network changed while checking the broadcast')
    }
    return this.qbitTxLifecycleStatusOn(chain, txid, operation)
  }

  /**
   * Decide a broadcast of `txid` (spending `outpoints`) that may have
   * reached the node, and keep the guard's record of its inputs in step: a
   * found transaction consumes its claim and records its inputs as spent,
   * an unknown outcome records them as possibly spent, and proven absence
   * forgets what an earlier attempt recorded, unless a call for these bytes
   * ended unknown, which makes this outcome unknown too. For a dapp's
   * push (`providerPush`, see `broadcastQbitProviderTx`), an unknown
   * outcome records them only for a transaction the user approved signing,
   * and proven absence forgets nothing. The lookups run under `operation`,
   * the broadcast's deadline: one it cuts short is `unavailable`, and the
   * outcome unknown, so the claim and inputs stay reserved.
   */
  private async resolveQbitBroadcastAfterFailure(
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[],
    classification: QbitBroadcastErrorClassification,
    claim: QbitSendBroadcastClaim | undefined,
    operation: QbitExplorerOperation,
    dispatched = true,
    providerPush = false
  ): Promise<QbitBroadcastResult> {
    // A definitive rejection still has to prove absence: the indexer can lag
    // the node, so a single immediate miss is not enough. Every other failure
    // gets one probe that can only upgrade the verdict to success.
    const probes = classification.definitiveRejection ? QBIT_BROADCAST_ABSENCE_PROBES : 1
    let lookup: QbitBroadcastLookup = 'gone'
    for (let attempt = 0; attempt < probes; attempt += 1) {
      if (attempt > 0) await qbitBroadcastProbeDelay(this.qbitBroadcastProbeDelayMs)
      try {
        const lifecycle = await this.probeQbitBroadcastLifecycle(chain, txid, operation)
        if (lifecycle.state !== 'gone') {
          await this.recordQbitBroadcastAcceptance(claim, chain, txid, outpoints)
          return { success: true, chain, txid, via: 'lookup' }
        }
      } catch {
        lookup = 'unavailable'
        break
      }
    }
    let outcome: QbitBroadcastFailure['outcome'] =
      classification.definitiveRejection && lookup === 'gone' ? 'not_sent' : 'unknown'
    try {
      // The absence stands only while no call for these bytes has ended
      // without a verdict, decided in the same step as forgetting what an
      // earlier attempt recorded: one that ended while this call was still
      // looking keeps its unknown outcome and its inputs reserved, and so
      // does this call.
      if (
        outcome === 'not_sent' &&
        !providerPush &&
        !(await qbitSendGuardService.forgetProvenAbsentBroadcast(chain, txid))
      ) {
        outcome = 'unknown'
      }
      if (providerPush) {
        if (outcome === 'unknown') {
          await qbitSendGuardService.recordInconclusiveProviderPush(chain, txid, outpoints)
        }
      } else if (outcome === 'unknown') {
        await qbitSendGuardService.recordInconclusiveBroadcast(
          chain,
          txid,
          outpoints,
          claim,
          dispatched
        )
      }
    } catch {
      // The bytes were validated before dispatch; the verdict stands.
    }
    return this.qbitBroadcastFailure({
      chain,
      txid,
      outcome,
      reason: classification.reason,
      lookup,
      detail: classification.detail,
    })
  }

  /**
   * `broadcastIfAllowed` only consumes a send claim when the broadcast
   * callback resolves. When a lookup proves the node accepted the
   * transaction despite an error response, consume the claim the same way a
   * clean broadcast would have: the inputs are spent now, and stay reserved
   * as recently spent until the explorer can be trusted to show it. Only
   * the claim that authorized this exact transaction on this network is
   * spent by it: a claim supplied for another txid or chain stays active for
   * its own broadcast.
   */
  private async recordQbitBroadcastAcceptance(
    claim: QbitSendBroadcastClaim | undefined,
    chain: ChainType,
    txid: string,
    outpoints: readonly QbitOutpoint[]
  ): Promise<void> {
    try {
      await qbitSendGuardService.recordAcceptedBroadcast(chain, txid, outpoints, claim)
    } catch {
      // The bytes were validated before dispatch; the verdict stands.
    }
  }

  /**
   * The same for a status check, which only has the claim to say which
   * inputs the found transaction spends: a claim the guard still holds is
   * consumed into recently spent inputs, and any other is left alone.
   */
  private async consumeQbitBroadcastClaimAfterAcceptance(
    claim: QbitSendBroadcastClaim | undefined,
    chain: ChainType,
    txid: string
  ): Promise<void> {
    if (!claim) return
    try {
      await qbitSendGuardService.consumeBroadcastClaim(claim, { chain, txid })
    } catch {
      // A malformed or already-consumed claim has nothing left to consume.
    }
  }

  private qbitBroadcastFailure(input: {
    chain?: ChainType | undefined
    txid?: string | undefined
    outcome: QbitBroadcastFailure['outcome']
    reason: QbitBroadcastFailure['reason']
    lookup?: QbitBroadcastLookup | undefined
    detail?: string | undefined
  }): QbitBroadcastFailure {
    const failure: QbitBroadcastFailure = {
      success: false,
      outcome: input.outcome,
      reason: input.reason,
    }
    if (input.chain !== undefined) failure.chain = input.chain
    if (input.txid !== undefined) failure.txid = input.txid
    if (input.lookup !== undefined) failure.lookup = input.lookup
    if (input.detail !== undefined) failure.detail = input.detail
    return failure
  }

  getAccounts = async () => {
    const keyrings = await this.getKeyrings()
    const accounts: Account[] = keyrings.reduce<Account[]>(
      (pre, cur) => pre.concat(cur.accounts),
      []
    )
    return accounts
  }

  displayedKeyringToWalletKeyring = (
    displayedKeyring: DisplayedKeyring,
    index: number,
    initName = true
  ) => {
    const networkType = this.getNetworkType()
    const addressType = displayedKeyring.addressType
    const key = 'keyring_' + index
    const type = displayedKeyring.type
    const accounts: Account[] = []

    for (let j = 0; j < displayedKeyring.accounts.length; j++) {
      let pubkey: string
      let address: string
      let p2mr: Account['p2mr'] | undefined

      if (type === KeyringType.ColdWalletKeyring) {
        // For cold wallets, we might not have pubkey, so we use the address directly
        // The account might be just an address string for cold wallets
        if (typeof displayedKeyring.accounts[j] === 'string') {
          address = displayedKeyring.accounts[j] as unknown as string
          pubkey = ''
        } else {
          const account = displayedKeyring.accounts[j] as any
          pubkey = account.pubkey || ''
          address = account.address || publicKeyToAddress(pubkey, addressType, networkType)
        }
      } else if (type === KeyringType.WatchAddressKeyring) {
        // getAccounts() returns addresses directly for WatchAddressKeyring
        const addressFromKeyring = displayedKeyring.accounts[j]!.pubkey
        pubkey = ''
        address = addressFromKeyring
      } else if (type === KeyringType.QbitHdKeyring || addressType === AddressType.P2MR) {
        const account = displayedKeyring.accounts[j]!
        const accountPubkey = account.pubkey
        const qbitNetwork = chainTypeToQbitNetworkName(this.getChainType())
        const p2mrAccount = account.keyring
        pubkey = accountPubkey
        address = p2mrAccount?.addresses?.[qbitNetwork]
        if (!address) {
          throw new Error('Missing P2MR account address metadata')
        }
        p2mr = {
          pubkey,
          path: p2mrAccount.path,
          scriptPubKey: p2mrAccount.scriptPubKey,
          leafScript: p2mrAccount.leafScript,
          addresses: p2mrAccount.addresses,
          hkdf: p2mrAccount.hkdf,
          signatureCounter: p2mrAccount.signatureCounter,
        }
      } else {
        const { pubkey: accountPubkey } = displayedKeyring.accounts[j]!
        pubkey = accountPubkey
        address = publicKeyToAddress(pubkey, addressType, networkType)
      }

      const accountKey = key + '#' + j
      const defaultName = this._generateAlianName(type, j + 1)
      const alianName = preferenceService.getAccountAlianName(accountKey, defaultName)!
      const flag = preferenceService.getAddressFlag(address)
      const account: Account = {
        type,
        pubkey,
        address,
        alianName,
        index: j,
        key: accountKey,
        flag,
      }
      if (p2mr) {
        account.p2mr = p2mr
      }
      accounts.push(account)
    }
    const hdPath =
      type === KeyringType.HdKeyring || type === KeyringType.QbitHdKeyring
        ? displayedKeyring.keyring.hdPath
        : ''
    const accountIndexDerivation: boolean =
      type === KeyringType.HdKeyring
        ? (displayedKeyring.keyring.accountIndexDerivation ?? false)
        : false
    const alianName = preferenceService.getKeyringAlianName(
      key,
      initName ? `${KEYRING_TYPES[type]?.alianName ?? 'Unsupported Wallet'} #${index + 1}` : ''
    )!
    const keyring: WalletKeyring = {
      index,
      key,
      type,
      addressType,
      accounts,
      alianName,
      hdPath,
      accountIndexDerivation,
      ...(type === KeyringType.QbitHdKeyring && displayedKeyring.keyring.qbitRecovery
        ? { qbitRecovery: displayedKeyring.keyring.qbitRecovery }
        : {}),
    }
    return keyring
  }

  corruptedDisplayedKeyringToWalletKeyring = (
    displayedKeyring: DisplayedKeyring,
    index: number,
    corruptedReason: string,
    initName = true
  ): CorruptedWalletKeyring => {
    const key = 'keyring_' + index
    const type = displayedKeyring.type
    const alianName = preferenceService.getKeyringAlianName(
      key,
      initName ? `${KEYRING_TYPES[type]?.alianName ?? 'Unsupported Wallet'} #${index + 1}` : ''
    )!

    return {
      index,
      key,
      type,
      addressType: displayedKeyring.addressType,
      accounts: [],
      alianName,
      hdPath: '',
      accountIndexDerivation: false,
      isCorrupted: true,
      corruptedReason,
    }
  }

  safeDisplayedKeyringToWalletKeyring = (
    displayedKeyring: DisplayedKeyring | undefined,
    index: number,
    initName = true
  ): WalletKeyringWithStatus | null => {
    if (!displayedKeyring || displayedKeyring.type === KeyringType.Empty) {
      return null
    }

    try {
      const keyring = this.displayedKeyringToWalletKeyring(displayedKeyring, index, initName)
      if (keyring.accounts.length === 0) {
        return this.corruptedDisplayedKeyringToWalletKeyring(
          displayedKeyring,
          index,
          'No account',
          initName
        )
      }
      return keyring
    } catch (e) {
      log.warn('[WalletController] Marking invalid keyring as corrupted', {
        index,
        type: displayedKeyring.type,
        error: e,
      })
      return this.corruptedDisplayedKeyringToWalletKeyring(
        displayedKeyring,
        index,
        'Invalid Public Key',
        initName
      )
    }
  }

  isUsableKeyring = (keyring: WalletKeyringWithStatus | null): keyring is WalletKeyring => {
    return Boolean(keyring && !('isCorrupted' in keyring && keyring.isCorrupted))
  }

  getKeyrings = async (): Promise<WalletKeyringWithStatus[]> => {
    const displayedKeyrings = await keyringService.getAllDisplayedKeyrings()
    const keyrings: WalletKeyring[] = []
    for (let index = 0; index < displayedKeyrings.length; index++) {
      const displayedKeyring = displayedKeyrings[index]!
      if (displayedKeyring.type !== KeyringType.Empty) {
        const keyring = this.safeDisplayedKeyringToWalletKeyring(
          displayedKeyring,
          displayedKeyring.index
        )
        if (keyring) {
          keyrings.push(keyring)
        }
      }
    }

    return keyrings
  }

  getTotalKeyringCount = async () => {
    const displayedKeyrings = await keyringService.getAllDisplayedKeyrings()
    return displayedKeyrings.length
  }

  getCurrentKeyring = async () => {
    let currentKeyringIndex = preferenceService.getCurrentKeyringIndex()
    const displayedKeyrings = await keyringService.getAllDisplayedKeyrings()
    if (currentKeyringIndex === undefined) {
      const currentAccount = preferenceService.getCurrentAccount()
      for (let i = 0; i < displayedKeyrings.length; i++) {
        if (displayedKeyrings[i]!.type !== currentAccount?.type) {
          continue
        }
        const found = displayedKeyrings[i]!.accounts.find(v => v.pubkey === currentAccount?.pubkey)
        if (found) {
          currentKeyringIndex = i
          break
        }
      }
      if (currentKeyringIndex === undefined) {
        currentKeyringIndex = 0
      }
    }

    let currentKeyring = this.safeDisplayedKeyringToWalletKeyring(
      displayedKeyrings[currentKeyringIndex]!,
      currentKeyringIndex
    )

    if (!this.isUsableKeyring(currentKeyring)) {
      for (let i = 0; i < displayedKeyrings.length; i++) {
        if (displayedKeyrings[i]!.type === KeyringType.Empty) {
          continue
        }

        const fallbackKeyring = this.safeDisplayedKeyringToWalletKeyring(displayedKeyrings[i]!, i)
        if (this.isUsableKeyring(fallbackKeyring)) {
          currentKeyringIndex = i
          preferenceService.setCurrentKeyringIndex(currentKeyringIndex)
          preferenceService.setCurrentAccount(fallbackKeyring.accounts[0])
          currentKeyring = fallbackKeyring
          break
        }
      }
    }

    return this.isUsableKeyring(currentKeyring) ? currentKeyring : null
  }

  getCurrentAccount = async () => {
    const currentKeyring = await this.getCurrentKeyring()
    if (!currentKeyring) return null
    const account = preferenceService.getCurrentAccount()
    let currentAccount: Account | undefined = undefined
    currentKeyring.accounts.forEach(v => {
      if (v.pubkey === account?.pubkey) {
        currentAccount = v
      }
    })
    if (!currentAccount) {
      currentAccount = currentKeyring.accounts[0]
    }
    if (currentAccount) {
      currentAccount.flag = preferenceService.getAddressFlag(currentAccount.address)
    }

    return currentAccount
  }

  getEditingKeyring = async () => {
    const editingKeyringIndex = preferenceService.getEditingKeyringIndex()
    const displayedKeyrings = await keyringService.getAllDisplayedKeyrings()
    const displayedKeyring = displayedKeyrings[editingKeyringIndex]!
    return this.displayedKeyringToWalletKeyring(displayedKeyring, editingKeyringIndex)
  }

  setEditingKeyring = async (index: number) => {
    preferenceService.setEditingKeyringIndex(index)
  }

  getEditingAccount = async () => {
    const account = preferenceService.getEditingAccount()
    return account
  }

  setEditingAccount = async (account: Account) => {
    preferenceService.setEditingAccount(account as any)
  }

  getAddressUtxo = async (address: string) => {
    return getQbitAddressUtxos(this.getQbitApiClient(), address)
  }

  getConnectedSites = (): ConnectedSite[] => {
    const data = permissionService.getConnectedSites()
    return data
  }
  setRecentConnectedSites = (sites: ConnectedSite[]) => {
    permissionService.setRecentConnectedSites(sites)
  }
  getRecentConnectedSites = (): ConnectedSite[] => {
    return permissionService.getRecentConnectedSites()
  }
  getCurrentSite = (tabId: number): ConnectedSite | null => {
    const { origin, name, icon } = sessionService.getSession(tabId) || {}
    if (!origin) {
      return null
    }
    const site = permissionService.getSite(origin)
    if (site) {
      return site
    }
    return {
      origin,
      name: name!,
      icon: icon!,
      chain: this.getChainType(),
      isConnected: false,
      isSigned: false,
      isTop: false,
    }
  }
  getCurrentConnectedSite = (tabId: number): ConnectedSite | undefined => {
    const { origin } = sessionService.getSession(tabId) || {}
    return permissionService.getWithoutUpdate(origin!)
  }
  setSite = async (data: ConnectedSite): Promise<void> => {
    await permissionService.setSite(data)
    if (data.isConnected) {
      sessionService.broadcastEvent(
        SESSION_EVENTS.networkChanged,
        this.getQbitNetworkName(),
        data.origin
      )
    }
  }
  updateConnectSite = async (origin: string, data: Partial<ConnectedSite>): Promise<void> => {
    // Site settings such as quick multi-sign change neither the network nor
    // what the origin can read, so they apply at once and announce nothing.
    if (!('chain' in data) && !('isConnected' in data)) {
      await permissionService.updateConnectSite(origin, data, true)
      return
    }
    // A grant change queues behind chain switches, so the origin is told what
    // it can read on a chain it has already been told about.
    return this.enqueueChainStateChange(async () => {
      const chain = this.getChainType()
      const before = this.grantSnapshot(origin, chain)
      await permissionService.updateConnectSite(origin, data, true)
      await this.announceGrantChange(origin, chain, before)
    })
  }

  removeConnectedSite = async (origin: string): Promise<void> => {
    await permissionService.removeConnectedSite(origin)
    this.announceRevocation(origin)
  }

  setKeyringAlianName = (keyring: WalletKeyring, name: string) => {
    preferenceService.setKeyringAlianName(keyring.key, name)
    const newKeyring = Object.assign({}, keyring, { alianName: name })
    return newKeyring
  }

  setAccountAlianName = (account: Account, name: string) => {
    preferenceService.setAccountAlianName(account.key, name)
    account.alianName = name
    return account
  }

  addAddressFlag = (account: Account, flag: AddressFlagType) => {
    account.flag = preferenceService.addAddressFlag(account.address, flag)
    return account
  }
  removeAddressFlag = (account: Account, flag: AddressFlagType) => {
    account.flag = preferenceService.removeAddressFlag(account.address, flag)
    return account
  }

  getFeeSummary = async (chainType: ChainType = this.getChainType()): Promise<FeeSummary> => {
    const { endpoint, apiSurface } = this.getQbitApiEndpoint(chainType)
    const cacheKey = this.getQbitFeeQuoteCacheKey(chainType, apiSurface, endpoint)
    const now = this.now()
    const cached = this.qbitFeeQuoteCache.get(cacheKey)
    const cacheAge = cached ? now - cached.fetchedAt : Number.POSITIVE_INFINITY

    if (cached && cacheAge >= 0 && cacheAge < QBIT_FEE_QUOTE_TTL_MS) {
      const summary = cloneFeeSummary(cached.summary)
      summary.quote = {
        ...summary.quote!,
        freshness: 'cached',
      }
      return summary
    }

    let refresh = this.qbitFeeQuoteRefreshes.get(cacheKey)
    if (!refresh) {
      refresh = (async () => {
        try {
          const feeTiers = await this.getQbitApiClient(chainType).getFeeTiers()
          const fetchedAt = this.now()
          const summary = qbitFeeSummaryFromTiers(feeTiers, apiSurface, {
            freshness: 'live',
            fetchedAt,
          })
          if (summary.quote?.availability === 'available') {
            this.qbitFeeQuoteCache.set(cacheKey, {
              fetchedAt,
              summary: cloneFeeSummary(summary),
            })
          } else {
            this.qbitFeeQuoteCache.delete(cacheKey)
          }
          return summary
        } catch (error) {
          this.qbitFeeQuoteCache.delete(cacheKey)
          log.warn('Failed to refresh qbit fee estimates; using relay-floor fallback:', error)
          return qbitUnavailableFeeSummary(apiSurface, cached ? 'stale' : 'unavailable')
        }
      })()
      this.qbitFeeQuoteRefreshes.set(cacheKey, refresh)
      const clearRefresh = () => {
        if (this.qbitFeeQuoteRefreshes.get(cacheKey) === refresh) {
          this.qbitFeeQuoteRefreshes.delete(cacheKey)
        }
      }
      void refresh.then(clearRefresh, clearRefresh)
    }
    return cloneFeeSummary(await refresh)
  }

  getLowFeeSummary = async () => {
    return this.getFeeSummary()
  }

  /**
   * The current account, the wallet's accounts and the fee quote a PSBT
   * review is relative to, on the network current when the read started.
   */
  private readQbitPsbtReviewContext = async (): Promise<QbitPsbtReviewContext> => {
    const chain = this.getChainType()
    const networkType = this.getNetworkType()
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')
    const [walletAccounts, feeSummary] = await Promise.all([
      this.getAccounts(),
      this.getFeeSummary().catch((e): FeeSummary | undefined => {
        log.warn('Failed to fetch qbit fee summary for PSBT decode:', e)
        return undefined
      }),
    ])
    // The spend summary is relative to the current account and the wallet's
    // accounts read above; an account switch while they were read would
    // describe the PSBT for an account that will not sign it.
    if (preferenceService.getCurrentAccount()?.address !== account.address) {
      throw new Error('The current account changed while the PSBT was decoded')
    }
    return {
      chain,
      networkType,
      account,
      wallet: qbitWalletOwnership([account, ...walletAccounts]),
      feeSummary,
    }
  }

  /**
   * Decode a P2MR PSBT and summarize what its exact bytes do to the wallet.
   * A PSBT a website supplied also has its fee judged without the size
   * estimate; omitted, `suppliedByWebsite` judges it as one the wallet built.
   */
  private reviewQbitP2mrPsbt = (
    psbtHex: string,
    { networkType, account, wallet, feeSummary }: QbitPsbtReviewContext,
    { statedRecipients, suppliedByWebsite = false }: DecodePsbtOptions = {}
  ): DecodedPsbt => {
    const psbt = qbitPsbtFromHex(psbtHex)
    const summary = decodeQbitPsbt(psbt)
    const fee = Number(summary.fee ?? 0n)
    const finalTxVBytes = qbitPsbtReviewVsize(psbt, summary)

    const inputInfos = summary.inputs.map(input => {
      const witnessUtxo = input.witnessUtxo
      return {
        txid: qbitInternalBytesToTxid(input.prevout.txid),
        vout: input.prevout.vout,
        sequence: input.sequence,
        address: witnessUtxo
          ? scriptPkToAddress(qbitBytesToHex(witnessUtxo.scriptPubKey), networkType)
          : '',
        value: Number(witnessUtxo?.value ?? 0n),
        ...(witnessUtxo ? { witnessUtxoScriptHex: qbitBytesToHex(witnessUtxo.scriptPubKey) } : {}),
        sighashType: input.scriptSigs[0]?.signature.hashType ?? 0,
      }
    })
    const outputInfos = summary.outputs.map((output): DecodedPsbt['outputInfos'][number] => {
      const opReturn = decodeOpReturnScript(output.scriptPubKey)
      if (opReturn) {
        return {
          type: 'op_return',
          address: '',
          value: Number(output.value),
          scriptPubKeyHex: qbitBytesToHex(output.scriptPubKey),
          opReturn,
        }
      }

      return {
        address: scriptPkToAddress(qbitBytesToHex(output.scriptPubKey), networkType),
        value: Number(output.value),
        scriptPubKeyHex: qbitBytesToHex(output.scriptPubKey),
      }
    })
    const feeRate = finalTxVBytes > 0 ? fee / finalTxVBytes : 0
    const isCompleted = summary.fee !== undefined
    const { spendSummary, risks, recommendedFeeRate } = summarizeQbitPsbtSpend({
      inputs: inputInfos,
      outputs: outputInfos,
      fee,
      feeRate,
      isCompleted,
      account: account.address,
      wallet,
      statedRecipients,
      feeSummary,
      checkFeeShareWithoutSize: suppliedByWebsite,
    })

    return {
      inputInfos,
      outputInfos,
      feeRate,
      fee,
      features: {
        rbf: summary.inputs.some(input => input.sequence < 0xfffffffe),
      },
      risks,
      isScammer: false,
      recommendedFeeRate: recommendedFeeRate ?? QBIT_MIN_RELAY_FEE_RATE,
      shouldWarnFeeRate: (spendSummary.feeAssessment?.reasons.length ?? 0) > 0,
      isCompleted,
      spendSummary,
    }
  }

  private decodeQbitP2mrPsbt = async (
    psbtHex: string,
    options: DecodePsbtOptions = {}
  ): Promise<DecodedPsbt> => {
    return this.reviewQbitP2mrPsbt(psbtHex, await this.readQbitPsbtReviewContext(), options)
  }

  decodePsbt = async (psbtHex: string, website: string, options?: DecodePsbtOptions) => {
    void website
    try {
      return await this.decodeQbitP2mrPsbt(psbtHex, options)
    } catch (e) {
      log.warn('Failed to decode qbit P2MR PSBT locally:', e)
      throw new Error('Invalid qbit P2MR PSBT')
    }
  }

  /**
   * Each PSBT of a local batch, reviewed as it would be on its own: the same
   * spend summary and risks from its exact bytes, with the recipients its own
   * request names, for one account and quote.
   */
  private analyzeLocalQbitPsbts = (
    toSignDatas: ToSignData[],
    context: QbitPsbtReviewContext
  ): LocalPsbtSummary => {
    let totalFee = 0
    let totalInput = 0
    let completedCount = 0
    let parseErrorCount = 0
    const items: LocalPsbtSummary['items'] = []

    for (const toSignData of toSignDatas) {
      try {
        const decoded = this.reviewQbitP2mrPsbt(
          toSignData.psbtHex,
          context,
          psbtReviewOptions(toSignData)
        )
        const itemTotalInput = decoded.inputInfos.reduce((sum, input) => sum + input.value, 0)
        const { fee, isCompleted } = decoded
        if (isCompleted) {
          totalFee += fee
          totalInput += itemTotalInput
          completedCount++
        }

        items.push({
          inputCount: decoded.inputInfos.length,
          outputCount: decoded.outputInfos.length,
          feeRate: isCompleted ? decoded.feeRate.toFixed(2) : '-',
          fee,
          totalInput: itemTotalInput,
          isCompleted,
          hasSighashNone: false,
          parseError: false,
          risks: decoded.risks,
          spendSummary: decoded.spendSummary,
        })
      } catch (e) {
        log.error('Local qbit PSBT analysis failed:', e)
        parseErrorCount++
        items.push({
          inputCount: 0,
          outputCount: 0,
          feeRate: '-',
          fee: 0,
          totalInput: 0,
          isCompleted: false,
          hasSighashNone: false,
          parseError: true,
          risks: [],
        })
      }
    }

    return {
      totalFee,
      totalInput,
      completedCount,
      hasSighashNone: false,
      parseErrorCount,
      items,
      account: context.account.address,
      chain: context.chain,
    }
  }

  analyzeLocalPsbts = async (toSignDatas: ToSignData[]): Promise<LocalPsbtSummary> => {
    const context = await this.readQbitPsbtReviewContext()
    // The quote and the addresses belong to the network current when the
    // read started; a network switch since would describe the batch for
    // neither network.
    if (this.getChainType() !== context.chain) {
      throw new Error('The network changed while the PSBTs were analyzed')
    }
    return this.analyzeLocalQbitPsbts(toSignDatas, context)
  }

  /**
   * Sign one PSBT of a local (non-provider) batch the user quick-signs, which
   * skips the review each PSBT gets on its own. Its exact bytes are reviewed
   * again here, for the account and network now current. Signing is refused
   * when those are not the ones the batch was analyzed for, when the PSBT
   * does not decode, when it carries a risk the user did not explicitly
   * confirm (an abnormal fee or an unrecognised output), or a critical risk,
   * which no confirmation allows. A provider request is reviewed one PSBT at
   * a time, and a recovery migration signs for its source account in its own
   * flow; neither comes through here.
   */
  signLocalBatchPsbt = async (
    toSignData: ToSignData,
    review: LocalPsbtBatchReview
  ): Promise<SignedData> => {
    // Before the first await: the port the signed bytes are handed back to.
    const uiPort = this.callingUiPort
    if (toSignData?.providerContext) {
      throw new Error('A provider request is signed one transaction at a time')
    }
    if (toSignData?.qbitRecoveryMigration) {
      throw new Error('A recovery migration is signed from its own review')
    }
    if (
      typeof review?.account !== 'string' ||
      typeof review.chain !== 'string' ||
      !Array.isArray(review.confirmedRisks)
    ) {
      throw new TypeError('invalid batch review')
    }
    const context = await this.readQbitPsbtReviewContext()
    const [item] = this.analyzeLocalQbitPsbts([toSignData], context).items
    // Read after the last await, so signPsbtV2 signs for the account and on
    // the network checked here.
    if (
      context.account.address !== review.account ||
      context.chain !== review.chain ||
      preferenceService.getCurrentAccount()?.address !== review.account ||
      this.getChainType() !== review.chain
    ) {
      throw new Error('The current account or network changed after the batch was reviewed')
    }
    if (!item || item.parseError) throw new Error('Invalid qbit P2MR PSBT')
    if (item.risks.some(risk => risk.level === 'critical')) {
      throw new Error('The transaction has a risk that cannot be confirmed')
    }
    if (item.risks.some(risk => !review.confirmedRisks.includes(risk.type))) {
      throw new Error('The transaction has a risk that was not confirmed')
    }
    const sign = () => this.signPsbtV2(toSignData)
    return uiPort === undefined ? sign() : this.runForUiPort(uiPort, sign)
  }

  expireUICachedData = async (address: string) => {
    return preferenceService.expireUICachedData(address)
  }

  getWalletConfig = async () => {
    return walletApiService.config.getWalletConfig()
  }

  getSkippedVersion = async () => {
    return preferenceService.getSkippedVersion()
  }

  setSkippedVersion = async (version: string) => {
    return preferenceService.setSkippedVersion(version)
  }

  /**
   * Check if a website is a known phishing site
   * @param website Website URL or origin to check
   * @returns Object containing check results with isScammer flag and optional warning message
   */
  checkWebsite = async (
    website: string
  ): Promise<WebsiteSafetyResult> => {
    let result: WebsiteSafetyResult
    try {
      result = phishingDetectService.checkWebsite(website)
    } catch (error) {
      log.error('[Phishing] Local website safety check failed:', error)
      result = createUnverifiedWebsiteResult(
        'detector-failure',
        getWebsiteSafetyWarning('detector-failure')
      )
    }

    return result
  }

  getAddressSummary = async (address: string) => {
    return qbitStatsToAddressSummary(await this.getQbitApiClient().getAddressStats(address))
  }

  setPsbtSignNonSegwitEnable(psbt: transactionCore.Psbt, enabled: boolean) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    psbt.__CACHE.__UNSAFE_SIGN_NONSEGWIT = enabled
  }

  getShowSafeNotice = () => {
    return preferenceService.getShowSafeNotice()
  }

  setShowSafeNotice = (show: boolean) => {
    return preferenceService.setShowSafeNotice(show)
  }

  getVersionDetail = (version: string) => {
    return walletApiService.config.getVersionDetail(version)
  }

  getEnableSignData = async () => {
    return preferenceService.getEnableSignData()
  }

  /* Biometric (WebAuthn PRF) unlock. The ceremony and key derivation run in
   * the UI page; the background only stores and invalidates the wrapped
   * record. */
  getBiometricUnlockStatus = async (): Promise<BiometricUnlockStatus> => {
    return biometricUnlockService.getStatus()
  }

  saveBiometricUnlockRecord = async (
    record: BiometricUnlockRecord,
    password: string
  ): Promise<void> => {
    return biometricUnlockService.saveRecord(record, password)
  }

  getBiometricUnlockRecord = async (): Promise<BiometricUnlockRecord | null> => {
    return biometricUnlockService.getRecord()
  }

  clearBiometricUnlock = async (): Promise<void> => {
    return biometricUnlockService.clearRecord()
  }

  setEnableSignData = async (enable: boolean) => {
    return preferenceService.setEnableSignData(enable)
  }

  getAutoLockTimeId = async () => {
    return preferenceService.getAutoLockTimeId()
  }

  setAutoLockTimeId = async (timeId: number) => {
    await preferenceService.setAutoLockTimeId(timeId)
    this._resetTimeout()
  }

  getOpenInSidePanel = async () => {
    return preferenceService.getOpenInSidePanel()
  }

  getDeveloperMode = async () => {
    return preferenceService.getDeveloperMode()
  }

  setDeveloperMode = async (developerMode: boolean) => {
    preferenceService.setDeveloperMode(developerMode)
  }

  getThemeMode = async () => {
    return preferenceService.getThemeMode()
  }

  setThemeMode = async (themeMode: ThemeMode) => {
    preferenceService.setThemeMode(themeMode)
  }

  setOpenInSidePanel = async (openInSidePanel: boolean) => {
    preferenceService.setOpenInSidePanel(openInSidePanel)

    try {
      const chromeWithSidePanel = chrome as any
      if (chromeWithSidePanel.sidePanel) {
        chromeWithSidePanel.sidePanel.setPanelBehavior({ openPanelOnActionClick: openInSidePanel })
      }
    } catch (error) {
      console.error('Failed to update side panel behavior:', error)
    }
  }

  setLastActiveTime = async () => {
    this._resetTimeout()
  }

  private _resetTimeout = () => {
    if (this.timer) {
      clearTimeout(this.timer)
    }

    const timeId = preferenceService.getAutoLockTimeId()
    const timeConfig = getLockTimeInfo(timeId)
    this.timer = setTimeout(() => {
      this.lockWallet()
      bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
        method: BUS_METHODS.AUTO_LOCKED,
        params: {},
      })
    }, timeConfig.time)
  }

  getBlockActiveInfo = () => {
    return walletApiService.utility.getBlockActiveInfo()
  }

  // Rate Us Status
  getRateUsStatus = (): RateUsStatus => {
    return preferenceService.getRateUsStatus()
  }

  setHasRated = (hasRated: boolean) => {
    return preferenceService.setHasRated(hasRated)
  }

  setRatePromptDismissedAt = (timestamp: number | null) => {
    return preferenceService.setRatePromptDismissedAt(timestamp)
  }

  setHasShownSecondPrompt = (hasShown: boolean) => {
    return preferenceService.setHasShownSecondPrompt(hasShown)
  }

  resetRateUsStatus = async () => {
    return preferenceService.resetRateUsStatus()
  }

  getGuideReaded = async () => {
    return preferenceService.getGuideReaded()
  }

  setGuideReaded = async () => {
    preferenceService.setGuideReaded(true)
  }

  getAnnouncements = async (cursor: number, size: number) => {
    return walletApiService.utility.getAnnouncements(cursor, size)
  }

  // get the notifications
  getNotifications = async () => {
    return notificationService.getNotifications()
  }

  // mark the notification as read
  readNotification = async (id: string) => {
    return notificationService.markAsRead(id)
  }

  // mark all notifications as read
  readAllNotifications = async () => {
    return notificationService.readAll()
  }

  // delete the notification
  deleteNotification = async (id: string) => {
    return notificationService.deleteNotification(id)
  }

  getNotificationUnreadCount = (): number => {
    return notificationService.getUnreadCount()
  }

  getAcceptLowFeeMode = async () => {
    return preferenceService.getAcceptLowFeeMode()
  }

  setAcceptLowFeeMode = async (accept: boolean) => {
    preferenceService.setAcceptLowFeeMode(accept)
  }

  getEnableRBF = async () => {
    return preferenceService.getEnableRBF()
  }

  setEnableRBF = async (enableRBF: boolean) => {
    await preferenceService.setEnableRBF(enableRBF)
  }

  createTmpKeyringWithPublicKey = async (publicKey: string, addressType: AddressType) => {
    const networkType = this.getNetworkType()
    if (!canDeriveAddressFromPublicKey(publicKey, addressType, networkType)) {
      throw new Error('Invalid Public Key')
    }

    const originKeyring = keyringService.createTmpKeyring(KeyringType.ReadonlyKeyring, [publicKey])
    const displayedKeyring = await keyringService.displayForKeyring(originKeyring, addressType, -1)
    const tmpKeyring = this.displayedKeyringToWalletKeyring(displayedKeyring, -1, false)
    return tmpKeyring
  }

  createKeyringWithPublicKey = async (
    data: string,
    addressType: AddressType,
    alianName?: string
  ) => {
    let originKeyring: Keyring
    const networkType = this.getNetworkType()
    if (!canDeriveAddressFromPublicKey(data, addressType, networkType)) {
      throw new Error('Invalid Public Key')
    }

    try {
      originKeyring = await keyringService.importPublicKeyOnly(data, addressType as AddressType)
    } catch (e) {
      throw e
    }

    const displayedKeyring = await keyringService.displayForKeyring(
      originKeyring,
      addressType,
      keyringService.keyrings.length - 1
    )
    const keyring = this.displayedKeyringToWalletKeyring(
      displayedKeyring,
      keyringService.keyrings.length - 1
    )
    await this.changeKeyring(keyring)

    preferenceService.setShowSafeNotice(true)
  }

  createTmpKeyringWithAddress = async (address: string) => {
    const networkType = this.getNetworkType()
    if (!isValidAddress(address, networkType)) {
      throw new Error('Invalid address')
    }
    const addressType = getAddressType(address, networkType)
    const originKeyring = keyringService.createTmpKeyring(KeyringType.WatchAddressKeyring, [
      address,
    ])
    const displayedKeyring = await keyringService.displayForKeyring(originKeyring, addressType, -1)
    return this.displayedKeyringToWalletKeyring(displayedKeyring, -1, false)
  }

  createKeyringWithAddress = async (address: string) => {
    const networkType = this.getNetworkType()
    if (!isValidAddress(address, networkType)) {
      throw new Error('Invalid address')
    }
    const addressType = getAddressType(address, networkType)
    const originKeyring = await keyringService.importWatchAddress(address, addressType)
    const displayedKeyring = await keyringService.displayForKeyring(
      originKeyring,
      addressType,
      keyringService.keyrings.length - 1
    )
    const keyring = this.displayedKeyringToWalletKeyring(
      displayedKeyring,
      keyringService.keyrings.length - 1
    )
    await this.changeKeyring(keyring)

    preferenceService.setShowSafeNotice(true)
  }

  createDummyPsbt = async ({
    txType,
  }: {
    txType: DummyTxType
  }): Promise<{
    psbtHex: string
    toSignInputs: ToSignInput[]
  }> => {
    const account = preferenceService.getCurrentAccount()
    if (!account) throw new Error('no current account')

    const { psbt, toSignInputs } = txHelpers.createDummyTx({
      txType,
      address: account.address,
      pubkey: account.pubkey,
    })

    const toSignData = await this.getToSignData({
      psbtHex: psbt.toHex(),
      options: {
        toSignInputs: toSignInputs as any,
        autoFinalized: false,
      },
    })
    return toSignData
  }

  getQbitUnit() {
    const chainType = this.getChainType()
    return CHAINS_MAP[chainType]!.unit
  }
}
export default new WalletController()
