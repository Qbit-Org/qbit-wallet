import { EsploraClient, MempoolQbitClient, QbitApiError } from '@qbit-oss/api'
import type {
  AddressHistory,
  AddressHistoryOptions,
  AddressBalance,
  EsploraAddressStats,
  EsploraClientOptions,
  EsploraTx,
  EsploraTxStatus,
  EsploraUtxo,
  FeeRateTier,
  MempoolQbitClientOptions,
  RequestOptions,
} from '@qbit-oss/api'
import { QBIT_COINBASE_MATURITY } from '@qbit-oss/protocol'
import { PQC_WARNING_SIGNATURE_THRESHOLD } from '@qbit/keyring-service'
import { transactionCore } from '@qbit/wallet-core'
import {
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  estimateQbitP2mrTransaction,
} from '@qbit/wallet-shared'
import type {
  AddressSummary,
  FeeQuoteFallbackReason,
  FeeQuoteFreshness,
  QbitBalance,
  QbitBalanceSummary,
  QbitRestoreFloorSource,
  FeeSummary,
  TxHistoryItem,
  UTXO,
} from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'
import { QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS, createQbitExplorerFetch } from './qbit-explorer-fetch'

const SATS_PER_QBIT = 100_000_000n
const DEFAULT_MAX_COUNTER_HISTORY_PAGES = 256
const DEFAULT_MAX_COUNTER_HISTORY_TRANSACTIONS = 6_400
// Esplora's `/address/:address/txs/mempool` lists at most this many rows, so a
// larger pending set cannot be enumerated from it. mempool-qbit pages its
// pending rows instead.
const ESPLORA_ADDRESS_MEMPOOL_LIST_LIMIT = 50
// @qbit-oss/api's getAddressHistory reads an address a second time when its
// stats move during the first read, and counts both reads against maxPages
// and maxTransactions. The wallet's budgets are for one read, so each call
// passes twice its budget; the stats checks before each call keep the bound.
const QBIT_ADDRESS_HISTORY_READS = 2
const MAX_ESPLORA_FEE_TARGET_BLOCKS = 1_008
const DEFAULT_MAX_ACCOUNT_HISTORY_TRANSACTIONS = 25_600
// Permit common two-owned-address overlap without allowing raw work to scale
// with the number of addresses in the account.
const QBIT_ACCOUNT_HISTORY_RAW_ROW_MULTIPLIER = 2
const MAX_QBIT_HISTORY_PREVOUT_HYDRATIONS = 1_024
const QBIT_HISTORY_PREVOUT_HYDRATION_CONCURRENCY = 8
const QBIT_HISTORY_ADDRESS_REQUEST_CONCURRENCY = 8
// An address read from its history can carry thousands of outputs.
const QBIT_PROTECTED_ASSET_LOOKUP_CONCURRENCY = 16
const QBIT_HISTORY_REVISION_CONFIRMED_WINDOW = 25
export const MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES = 32
const MAX_QBIT_FEE_RATE = 10_000
// qbit Core caps a serialized block at 2,000,000 bytes. A transaction cannot
// validly exceed its containing block, so reject larger explorer responses
// before running the hex regex or allocating through Transaction.fromHex.
const MAX_QBIT_RAW_TRANSACTION_HEX_LENGTH = 2_000_000 * 2
const MAX_OUTPUT_INDEX = 0xffff_ffff
const QBIT_TXID_PATTERN = /^[0-9a-f]{64}$/i
const QBIT_HEX_PATTERN = /^[0-9a-f]+$/i
const QBIT_P2MR_SCRIPT_PATTERN = /^5220[0-9a-f]{64}$/i
// qbit Core refuses a transaction whose in-mempool ancestors, itself
// included, would number more than this (DEFAULT_ANCESTOR_LIMIT).
const QBIT_MEMPOOL_ANCESTOR_LIMIT = 25

type QbitBalanceSummaryPayload = Omit<QbitBalanceSummary, 'chainType'>
type AddressGroup = {
  type: number
  address_arr: string[]
  pubkey_arr?: string[]
  satoshis_arr?: number[]
}

export type QbitEsploraClient = Pick<
  EsploraClient,
  | 'getAddressBalance'
  | 'getAddressMempoolTxs'
  | 'getAddressStats'
  | 'getAddressTxs'
  | 'getAddressUtxos'
  | 'getAddressHistory'
  | 'getFeeTiers'
  | 'getTipHash'
  | 'getTipHeight'
  | 'getTx'
  | 'getTxHex'
  | 'getTxStatus'
>

export type QbitPqcHistoryClient = QbitEsploraClient

/**
 * The part of a `/tx/:txid/outspends` entry the wallet reads: whether that
 * output of the transaction is spent and, when it is, by which transaction.
 */
export interface QbitTxOutspend {
  spent: boolean
  txid?: string
}

export interface QbitTxOutspendsClient {
  getTxOutspends(txid: string): Promise<QbitTxOutspend[]>
}

/**
 * One page of an address's history, newest first. `afterTxid`, the last row
 * of the previous page, continues the walk. An empty page ends it, except
 * after a mempool row on qbit-electrs (see `readQbitHistoryWalkPage`).
 */
export interface QbitAddressHistoryPageClient {
  getAddressHistoryPage(address: string, afterTxid?: string): Promise<EsploraTx[]>
}

export type QbitWalletApiClient = EsploraClient &
  QbitTxOutspendsClient &
  QbitAddressHistoryPageClient

/**
 * The wallet's transport budgets for an explorer client (#353): headers and
 * body are timed separately, so a large history page on a slow link loads
 * while a dead connection still fails; see `qbit-explorer-fetch`. A given
 * `fetchFn` is wrapped, not replaced. With no base URL or no fetch at all,
 * the client's own constructor error stands.
 */
function withQbitExplorerBudgets<T extends EsploraClientOptions>(options: T): T {
  const budgeted = { ...options, timeoutMs: options.timeoutMs ?? QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS }
  if (typeof options.baseUrl !== 'string') return budgeted
  if (options.fetchFn === undefined && typeof globalThis.fetch !== 'function') return budgeted
  return {
    ...budgeted,
    fetchFn: createQbitExplorerFetch({ fetchFn: options.fetchFn, baseUrl: options.baseUrl }),
  }
}

// `@qbit-oss/api` has no route for a transaction's spenders. Both explorer
// surfaces serve Esplora's `/tx/:txid/outspends` under the endpoint's prefix,
// so the wallet's clients add it. Each also pages history one request at a
// time for walks that may stop early.
export class QbitWalletEsploraClient
  extends EsploraClient
  implements QbitTxOutspendsClient, QbitAddressHistoryPageClient
{
  constructor(options: EsploraClientOptions) {
    super(withQbitExplorerBudgets(options))
  }

  getTxOutspends(txid: string): Promise<QbitTxOutspend[]> {
    return this.getJson<QbitTxOutspend[]>(`/tx/${encodeURIComponent(txid)}/outspends`)
  }

  // Confirmed rows only (`/txs/chain`, 25 a page); mempool rows are not paged.
  getAddressHistoryPage(address: string, afterTxid?: string): Promise<EsploraTx[]> {
    return this.getAddressTxs(address, afterTxid)
  }
}

export class QbitWalletMempoolClient
  extends MempoolQbitClient
  implements QbitTxOutspendsClient, QbitAddressHistoryPageClient
{
  /** The most pages one history read fetches, as the client's `maxAddressHistoryPages`. */
  readonly maxHistoryWalkPages: number

  // The client clamps every call's maxPages to this ceiling (default 256), so
  // the two-read budgets above need it raised to match. The history reads
  // below keep to it too.
  constructor(options: MempoolQbitClientOptions) {
    const maxAddressHistoryPages =
      options.maxAddressHistoryPages ??
      DEFAULT_MAX_COUNTER_HISTORY_PAGES * QBIT_ADDRESS_HISTORY_READS
    super(withQbitExplorerBudgets({ ...options, maxAddressHistoryPages }))
    this.maxHistoryWalkPages = maxAddressHistoryPages
  }

  getTxOutspends(txid: string): Promise<QbitTxOutspend[]> {
    return this.getJson<QbitTxOutspend[]>(`/tx/${encodeURIComponent(txid)}/outspends`)
  }

  // The combined route, mempool rows first. `getAddressTxs` would rescan it
  // from the top to find each cursor.
  getAddressHistoryPage(address: string, afterTxid?: string): Promise<EsploraTx[]> {
    return this.getCombinedHistoryPage(address, afterTxid)
  }

  /**
   * `MempoolQbitClient.getAddressHistory`, read past the empty page
   * qbit-electrs answers after a whole page of mempool rows, where the
   * library's walk ends and so rejects an address with confirmed history:
   * see `walkQbitCombinedAddressHistory`. As there, one operation scope (the
   * client's signal, and the caller's signal and deadline) covers the whole
   * call, and `maxPages` defaults to and is clamped by the client's ceiling.
   */
  override getAddressHistory(
    address: string,
    options: AddressHistoryOptions = {}
  ): Promise<AddressHistory> {
    return this.runOperation(options, signal =>
      walkQbitCombinedAddressHistory(this.combinedRoute(address, signal), address, {
        maxPages: Math.min(
          positiveQbitHistoryLimit(options.maxPages, this.maxHistoryWalkPages, 'maxPages'),
          this.maxHistoryWalkPages
        ),
        maxTransactions: positiveQbitHistoryLimit(
          options.maxTransactions,
          MEMPOOL_QBIT_DEFAULT_MAX_HISTORY_TRANSACTIONS,
          'maxTransactions'
        ),
      })
    )
  }

  /**
   * `MempoolQbitClient.getAddressTxs`, read past the same empty page: see
   * `walkQbitCombinedConfirmedTxs`. One operation scope covers the call.
   */
  override getAddressTxs(
    address: string,
    afterTxid?: string,
    options?: RequestOptions
  ): Promise<EsploraTx[]> {
    return this.runOperation(options, signal =>
      walkQbitCombinedConfirmedTxs(
        this.combinedRoute(address, signal),
        address,
        afterTxid,
        this.maxHistoryWalkPages
      )
    )
  }

  private getCombinedHistoryPage(
    address: string,
    afterTxid?: string,
    options?: RequestOptions
  ): Promise<EsploraTx[]> {
    const suffix = afterTxid ? `?after_txid=${encodeURIComponent(afterTxid)}` : ''
    return this.getJson<EsploraTx[]>(
      `/address/${encodeURIComponent(address)}/txs${suffix}`,
      options
    )
  }

  /** The combined route and statistics of `address`, each request under `signal`. */
  private combinedRoute(address: string, signal: AbortSignal): QbitCombinedRoute {
    return {
      getAddressHistoryPage: (_address, afterTxid) =>
        this.getCombinedHistoryPage(address, afterTxid, { signal }),
      // On its own, like the library's: a read already in flight may predate the walk.
      getAddressStats: () =>
        this.getJson<EsploraAddressStats>(
          `/address/${encodeURIComponent(address)}`,
          { signal },
          false
        ),
    }
  }
}

export type QbitFeeSummaryApiSurface = 'esplora' | 'mempool-qbit'

/** One expected qbit block. A cached quote expires at this exact age. */
export const QBIT_FEE_QUOTE_TTL_MS = 60_000

const QBIT_FEE_TARGETS: Record<
  QbitFeeSummaryApiSurface,
  { slow: number; normal: number; fast: number }
> = {
  // Esplora exposes every target from 1 through 25, then long-horizon buckets.
  esplora: { slow: 20, normal: 6, fast: 2 },
  // @qbit-oss/api maps mempool-qbit's projected blocks to exact targets 1, 2, and 3.
  'mempool-qbit': { slow: 3, normal: 2, fast: 1 },
}

export interface QbitFeeSummaryOptions {
  freshness?: Exclude<FeeQuoteFreshness, 'fallback'>
  fetchedAt?: number
}

export interface QbitPqcSignatureActivity {
  observedSignatures: number
  hasActivity: boolean
  floorSource: QbitRestoreFloorSource
}

interface QbitPqcHistorySnapshot extends Omit<QbitPqcSignatureActivity, 'floorSource'> {
  spentOutpoints: ReadonlyMap<string, string>
}

/**
 * Bounded retry policy for snapshots that change while they are being read.
 * Retries are capped at 5 with exponential back-off from `retryBaseDelayMs`,
 * so an endlessly churning history fails rather than hangs.
 */
export interface QbitSnapshotStabilityRetryOptions {
  stabilityRetries?: number
  retryBaseDelayMs?: number
}

export interface QbitPqcSignatureActivityOptions extends QbitSnapshotStabilityRetryOptions {
  maxHistoryPages?: number
  maxHistoryTransactions?: number
  /**
   * Minimum wait before an address whose observation straddled a chain-tip
   * advance is observed again. The address endpoints cannot show whether
   * their index has caught up with the block the tip endpoint reports, so
   * the retry has to give it time; the ordinary back-off (tuned for mempool
   * churn) is too short for that. Capped at 30 s; defaults to no extra wait.
   */
  tipAdvanceSettleMs?: number
}

export const DEFAULT_QBIT_RESTORE_GAP_LIMIT = 20
export const DEFAULT_QBIT_RESTORE_MAX_INDEXES = 100

export interface QbitRestoreDiscoveryOptions {
  gapLimit?: number
  maxIndexes?: number
}

export interface QbitRestoreDiscovery {
  /** Indexes (0-based, contiguous derivation order) with balance or any history. */
  activeIndexes: number[]
  /** Highest active index, or -1 when the seed shows no activity at all. */
  highestActiveIndex: number
  /** How many indexes were derived and queried. */
  scannedCount: number
  /** True when the scan hit maxIndexes before observing a full trailing gap. */
  truncated: boolean
}

/**
 * Gap-limit address discovery for mnemonic restore. Extends the scan until
 * `gapLimit` consecutive unused indexes follow the last active one (or
 * `maxIndexes` is reached), so funds and spent-only history beyond the first
 * window are recovered. Derivation is injected so this stays testable and free
 * of keyring dependencies; `deriveAddresses(count)` must return addresses for
 * indexes `[0, count)` on the active network.
 */
export async function discoverQbitActiveIndexes(
  client: QbitEsploraClient,
  deriveAddresses: (count: number) => Promise<string[]> | string[],
  options: QbitRestoreDiscoveryOptions = {}
): Promise<QbitRestoreDiscovery> {
  const gapLimit = options.gapLimit ?? DEFAULT_QBIT_RESTORE_GAP_LIMIT
  if (!Number.isInteger(gapLimit) || gapLimit < 1) {
    throw new Error('gapLimit must be a positive integer')
  }
  const maxIndexes = options.maxIndexes ?? DEFAULT_QBIT_RESTORE_MAX_INDEXES
  if (!Number.isInteger(maxIndexes) || maxIndexes < gapLimit) {
    throw new Error('maxIndexes must be an integer >= gapLimit')
  }

  const activeByIndex: boolean[] = []
  let scannedCount = 0
  let targetCount = gapLimit

  while (scannedCount < targetCount) {
    const nextCount = Math.min(targetCount, maxIndexes)
    const addresses = await deriveAddresses(nextCount)
    if (!Array.isArray(addresses) || addresses.length < nextCount) {
      throw new Error('deriveAddresses returned fewer addresses than requested')
    }
    const batch = addresses.slice(scannedCount, nextCount)
    const stats = await Promise.all(
      batch.map(async rawAddress => {
        const address = rawAddress.trim()
        if (!address) {
          throw new Error('deriveAddresses returned an empty address')
        }
        const item = await client.getAddressStats(address)
        assertValidQbitStats(item, address)
        return item
      })
    )
    for (const item of stats) {
      activeByIndex[scannedCount] =
        qbitStatsHaveActivity(item) || qbitStatsToAddressSummary(item).totalSatoshis > 0
      scannedCount += 1
    }

    const highestActive = activeByIndex.lastIndexOf(true)
    const desiredCount = highestActive === -1 ? gapLimit : highestActive + 1 + gapLimit
    targetCount = Math.min(desiredCount, maxIndexes)
  }

  const highestActiveIndex = activeByIndex.lastIndexOf(true)
  const activeIndexes: number[] = []
  activeByIndex.forEach((active, index) => {
    if (active) activeIndexes.push(index)
  })
  const trailingGap = scannedCount - 1 - highestActiveIndex

  return {
    activeIndexes,
    highestActiveIndex,
    scannedCount,
    truncated: scannedCount >= maxIndexes && trailingGap < gapLimit,
  }
}

export function isQbitChainType(chainType: ChainType): boolean {
  return (
    chainType === ChainType.QBIT_MAINNET ||
    chainType === ChainType.QBIT_TESTNET4 ||
    chainType === ChainType.QBIT_REGTEST
  )
}

export function qbitAmountFromSats(sats: number): string {
  const value = BigInt(Math.trunc(sats))
  const sign = value < 0n ? '-' : ''
  const abs = value < 0n ? -value : value
  const whole = abs / SATS_PER_QBIT
  const fraction = (abs % SATS_PER_QBIT).toString().padStart(8, '0')
  return `${sign}${whole.toString()}.${fraction}`
}

export function qbitBalanceToWalletBalance(balance: AddressBalance): QbitBalance {
  return {
    confirm_amount: qbitAmountFromSats(balance.confirmedSats),
    pending_amount: qbitAmountFromSats(balance.mempoolSats),
    amount: qbitAmountFromSats(balance.totalSats),
  }
}

// The address balance is always measured, so its figures are never unknown.
export function qbitBalanceToSummary(
  balance: AddressBalance
): QbitBalanceSummaryPayload & { availableBalance: number } {
  return {
    availableBalance: balance.confirmedSats,
    unavailableBalance: balance.mempoolSats,
    totalBalance: balance.totalSats,
  }
}

/**
 * electrs refuses to list the outputs of an address holding more than its
 * `--utxos-limit` (500 unless configured otherwise) confirmed unspent outputs,
 * and mempool-qbit relays that refusal as a bare HTTP 500 while the address
 * statistics still answer.
 */
export const QBIT_EXPLORER_DEFAULT_UTXO_LIMIT = 500

/**
 * Whether a failed UTXO listing is the explorer's UTXO limit: an HTTP 500
 * from `/address/:a/utxo` for an address whose statistics show more
 * confirmed unspent outputs than
 * the limit. electrs counts the confirmed set before it applies the mempool,
 * so pending spends do not bring an address back under it.
 * A 500 for a smaller address stays an ordinary failure, so an outage is
 * never presented as this state. A statistics lookup that fails as well
 * answers false, so the caller reports the listing failure itself.
 */
export async function isQbitUtxoListOverExplorerLimit(
  client: Pick<QbitEsploraClient, 'getAddressStats'>,
  address: string,
  error: unknown
): Promise<boolean> {
  // Only the listing request itself: the classifier's per-output lookups
  // can fail with a 500 of their own.
  if (
    !(error instanceof QbitApiError) ||
    error.kind !== 'http' ||
    error.status !== 500 ||
    !error.url ||
    !/\/address\/[^/?#]+\/utxo(?:[?#]|$)/.test(error.url)
  ) {
    return false
  }
  let stats: EsploraAddressStats
  try {
    stats = await client.getAddressStats(address)
    assertValidQbitStats(stats, address)
  } catch {
    // Without statistics the listing failure keeps its own meaning.
    return false
  }
  const confirmedUnspentOutputs =
    stats.chain_stats.funded_txo_count - stats.chain_stats.spent_txo_count
  return confirmedUnspentOutputs > QBIT_EXPLORER_DEFAULT_UTXO_LIMIT
}

/**
 * The address's balance split the way a send sees it. `readReserved`, when
 * given, is read once the outputs are listed and names the outputs
 * (`txid:vout`) a send must not select (see `QbitSendGuardService`); they
 * count as unavailable rather than available.
 */
export async function getQbitSpendableBalanceV2(
  client: QbitEsploraClient,
  address: string,
  p2mrScriptPubKey?: string,
  readReserved?: () => Promise<ReadonlySet<string>>
): Promise<QbitBalanceSummaryPayload> {
  const [balanceResult, classifiedResult] = await Promise.allSettled([
    client.getAddressBalance(address),
    getQbitAddressUtxosClassified(client, address),
  ])
  if (balanceResult.status === 'rejected') throw balanceResult.reason
  const balance = balanceResult.value
  const aggregateBalance = qbitBalanceToSummary(balance)
  if (classifiedResult.status === 'rejected') {
    if (!(await isQbitUtxoListOverExplorerLimit(client, address, classifiedResult.reason))) {
      throw classifiedResult.reason
    }
    // The statistics still give the total. With no output list none of it
    // can be classified, so the split is unknown rather than 0, and none of
    // it can be selected until a send reads the outputs from history.
    const totalBalance = Math.max(0, aggregateBalance.totalBalance)
    return {
      availableBalance: null,
      unavailableBalance: totalBalance,
      totalBalance,
      immatureBalance: null,
      pendingBalance: null,
      utxoLimitExceeded: true,
    }
  }
  const classified = classifiedResult.value
  const reserved = readReserved ? await readReserved() : undefined
  const matchesScript = (utxo: UTXO) =>
    !p2mrScriptPubKey || utxo.scriptPk.toLowerCase() === p2mrScriptPubKey.toLowerCase()
  const selectable = (utxo: UTXO) =>
    matchesScript(utxo) && !reserved?.has(`${utxo.txid.toLowerCase()}:${utxo.vout}`)
  const confirmedSpendableSats = classified.confirmedSpendable
    .filter(selectable)
    .reduce((sum, utxo) => sum + utxo.satoshis, 0)
  const unconfirmedSpendableSats = classified.unconfirmedSpendable
    .filter(matchesScript)
    .reduce((sum, utxo) => sum + utxo.satoshis, 0)
  const ownChangeSats = classified.unconfirmedOwnChange
    .filter(matchesScript)
    .reduce((sum, utxo) => sum + utxo.satoshis, 0)
  const selectableOwnChangeSats = classified.unconfirmedOwnChange
    .filter(selectable)
    .reduce((sum, utxo) => sum + utxo.satoshis, 0)
  const classifiedImmatureSats = classified.immature
    .filter(matchesScript)
    .reduce((sum, utxo) => sum + utxo.satoshis, 0)
  // Available is what a send may select (see `getQbitAddressUtxos`): the
  // confirmed outputs, plus the unconfirmed change of this script's own
  // transactions, less the reserved ones.
  const availableBalance = Math.min(
    Math.max(0, aggregateBalance.totalBalance),
    Math.min(Math.max(0, aggregateBalance.availableBalance), confirmedSpendableSats) +
      selectableOwnChangeSats
  )
  const unavailableBalance = Math.max(0, aggregateBalance.totalBalance - availableBalance)
  const immatureBalance = Math.min(classifiedImmatureSats, unavailableBalance)
  // Pending is the unconfirmed value a send waits for: what others paid this
  // script, and change past the ancestor budget or of unreadable ancestry.
  const pendingBalance = Math.min(
    unconfirmedSpendableSats - ownChangeSats,
    Math.max(0, unavailableBalance - immatureBalance)
  )
  return {
    availableBalance,
    unavailableBalance,
    totalBalance: aggregateBalance.totalBalance,
    immatureBalance,
    pendingBalance,
  }
}

export function qbitStatsToAddressSummary(stats: EsploraAddressStats): AddressSummary {
  const confirmed =
    stats.chain_stats.funded_txo_sum -
    stats.chain_stats.spent_txo_sum +
    stats.mempool_stats.funded_txo_sum -
    stats.mempool_stats.spent_txo_sum
  return {
    address: stats.address,
    totalSatoshis: confirmed,
    spendableSatoshis: confirmed,
  }
}

function qbitStatsHaveActivity(stats: EsploraAddressStats): boolean {
  return [stats.chain_stats, stats.mempool_stats].some(
    item =>
      item.tx_count > 0 ||
      item.funded_txo_count > 0 ||
      item.spent_txo_count > 0 ||
      item.funded_txo_sum > 0 ||
      item.spent_txo_sum > 0
  )
}

function assertValidQbitStats(stats: EsploraAddressStats, address: string): void {
  if (!stats || stats.address !== address) {
    throw new Error(`invalid qbit address stats for ${address}`)
  }
  for (const [scope, item] of [
    ['chain', stats.chain_stats],
    ['mempool', stats.mempool_stats],
  ] as const) {
    if (!item || typeof item !== 'object') {
      throw new Error(`invalid ${scope} stats for qbit address ${address}`)
    }
    for (const field of [
      'funded_txo_count',
      'funded_txo_sum',
      'spent_txo_count',
      'spent_txo_sum',
      'tx_count',
    ] as const) {
      const value = item[field]
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid ${scope} ${field} for qbit address ${address}`)
      }
    }
    if (
      (item.funded_txo_count === 0 && item.funded_txo_sum !== 0) ||
      (item.spent_txo_count === 0 && item.spent_txo_sum !== 0) ||
      (item.tx_count === 0 &&
        (item.funded_txo_count !== 0 ||
          item.funded_txo_sum !== 0 ||
          item.spent_txo_count !== 0 ||
          item.spent_txo_sum !== 0))
    ) {
      throw new Error(`inconsistent ${scope} stats for qbit address ${address}`)
    }
  }
}

/** The address statistics as one comparable value; it changes with any new activity. */
export function qbitStatsSnapshot(stats: EsploraAddressStats): string {
  return JSON.stringify(
    [stats.chain_stats, stats.mempool_stats].flatMap(item => [
      item.funded_txo_count,
      item.funded_txo_sum,
      item.spent_txo_count,
      item.spent_txo_sum,
      item.tx_count,
    ])
  )
}

function assertValidQbitTipHash(tipHash: string): void {
  if (!/^[0-9a-f]{64}$/i.test(tipHash)) {
    throw new Error('invalid qbit chain tip hash')
  }
}

function qbitMempoolSnapshot(txs: EsploraTx[], address: string): string {
  if (!Array.isArray(txs)) {
    throw new Error(`invalid qbit mempool history for ${address}`)
  }
  const txids = new Set<string>()
  for (const tx of txs) {
    assertValidQbitHistoryTransaction(tx)
    if (tx.status.confirmed) {
      throw new Error(`confirmed transaction returned in qbit mempool history for ${address}`)
    }
    if (!tx.txid) {
      throw new Error(`transaction without txid returned in qbit mempool history for ${address}`)
    }
    const txid = tx.txid.toLowerCase()
    if (txids.has(txid)) {
      throw new Error(`duplicate transaction returned in qbit mempool history for ${address}`)
    }
    txids.add(txid)
  }
  return JSON.stringify([...txids].sort())
}

function qbitAccountMempoolSnapshot(
  addresses: readonly string[],
  mempoolTxs: readonly EsploraTx[][]
): string {
  if (mempoolTxs.length !== addresses.length) {
    throw new Error('incomplete qbit account mempool history')
  }
  const txids = new Set<string>()
  mempoolTxs.forEach((txs, index) => {
    qbitMempoolSnapshot(txs, addresses[index]!)
    txs.forEach(tx => txids.add(tx.txid.toLowerCase()))
  })
  return JSON.stringify([...txids].sort())
}

function qbitTxidSetSnapshot(txids: readonly string[]): string {
  if (!Array.isArray(txids)) {
    throw new Error('invalid qbit transaction id set')
  }
  return JSON.stringify([...new Set(txids.map(normalizeQbitTxid))].sort())
}

function qbitRecentConfirmedSnapshot(
  txs: EsploraTx[],
  stats: EsploraAddressStats,
  address: string
): string {
  const expectedTransactionCount = Math.min(
    stats.chain_stats.tx_count,
    QBIT_HISTORY_REVISION_CONFIRMED_WINDOW
  )
  if (
    !Array.isArray(txs) ||
    txs.length !== expectedTransactionCount
  ) {
    throw new Error(`invalid recent qbit confirmed history window for ${address}`)
  }
  const txids = new Set<string>()
  const snapshot = txs.map(tx => {
    assertValidQbitHistoryTransaction(tx)
    if (!tx.status.confirmed) {
      throw new Error(`unconfirmed transaction returned in recent qbit history for ${address}`)
    }
    const txid = tx.txid.toLowerCase()
    if (txids.has(txid)) {
      throw new Error(`duplicate transaction returned in recent qbit history for ${address}`)
    }
    txids.add(txid)
    return [
      txid,
      tx.status.block_height,
      tx.status.block_hash?.toLowerCase() ?? null,
      tx.status.block_time ?? null,
    ]
  })
  return JSON.stringify(snapshot)
}

function qbitAccountHistoryRevision(
  addresses: readonly string[],
  stats: readonly EsploraAddressStats[],
  mempoolTxs: readonly EsploraTx[][],
  recentConfirmedTxs: readonly EsploraTx[][],
  tipHeight: number,
  tipHash: string,
  confirmedTransactions: readonly EsploraTx[]
): QbitAccountHistoryRevision {
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new Error('invalid qbit tip height')
  }
  assertValidQbitTipHash(tipHash)
  if (
    stats.length !== addresses.length ||
    mempoolTxs.length !== addresses.length ||
    recentConfirmedTxs.length !== addresses.length
  ) {
    throw new Error('incomplete qbit account history revision')
  }

  const activity = addresses.map((address, index) => {
    const itemStats = stats[index]!
    assertValidQbitStats(itemStats, address)
    const itemMempool = mempoolTxs[index]!
    const mempoolSnapshot = qbitMempoolSnapshot(itemMempool, address)
    if (itemMempool.length !== itemStats.mempool_stats.tx_count) {
      throw new Error(`incomplete qbit mempool history for ${address}`)
    }
    return [
      normalizeQbitAddress(address),
      qbitStatsSnapshot(itemStats),
      mempoolSnapshot,
      qbitRecentConfirmedSnapshot(recentConfirmedTxs[index]!, itemStats, address),
    ]
  })
  const confirmedHistory = confirmedTransactions.filter(tx => tx.status.confirmed)
  confirmedHistory.forEach(assertValidQbitHistoryTransaction)
  const confirmedBlockHashesByHeight = new Map<number, string>()
  for (const tx of confirmedHistory) {
    const blockHash = tx.status.block_hash?.toLowerCase()
    if (blockHash === undefined) continue
    const blockHeight = tx.status.block_height!
    const previousBlockHash = confirmedBlockHashesByHeight.get(blockHeight)
    if (previousBlockHash !== undefined && previousBlockHash !== blockHash) {
      throw new QbitHistorySnapshotUnstableError(
        `conflicting qbit confirmed block hashes at height ${blockHeight}`
      )
    }
    confirmedBlockHashesByHeight.set(blockHeight, blockHash)
  }
  const highestConfirmedHeight = confirmedHistory.reduce(
    (highest, tx) => Math.max(highest, tx.status.block_height ?? -1),
    -1
  )
  const highestConfirmedTransactions = confirmedHistory.filter(
    tx => tx.status.block_height === highestConfirmedHeight
  )
  const highestConfirmedBlockHashes = new Set(
    highestConfirmedTransactions.map(tx => tx.status.block_hash?.toLowerCase())
  )
  const anchorTransaction = [...highestConfirmedTransactions].sort((left, right) =>
    left.txid.localeCompare(right.txid)
  )[0]
  const anchorBlockHash = [...highestConfirmedBlockHashes][0]
  const confirmedHistoryAnchor =
    highestConfirmedHeight >= 0 &&
    highestConfirmedBlockHashes.size === 1 &&
    anchorBlockHash !== undefined &&
    anchorTransaction
      ? {
          txid: anchorTransaction.txid.toLowerCase(),
          blockHeight: highestConfirmedHeight,
          blockHash: anchorBlockHash,
        }
      : undefined

  return {
    activityFingerprint: JSON.stringify(activity),
    tipHeight,
    tipHash: tipHash.toLowerCase(),
    hasConfirmedHistory: confirmedHistory.length > 0,
    ...(confirmedHistoryAnchor ? { confirmedHistoryAnchor } : {}),
  }
}

/** The chain tip and address statistics an observation began with. */
interface QbitPqcObservationAnchor {
  tipHash: string
  stats: EsploraAddressStats
}

/**
 * The address statistics show a history the scan does not enumerate: more
 * transactions than it reads, or more pending ones than the caller's mempool
 * listing returns. `anchor` holds the tip and statistics that showed it, so
 * the statistics read can continue the same observation.
 */
class QbitPqcHistoryLimitError extends Error {
  readonly anchor: QbitPqcObservationAnchor

  constructor(message: string, anchor: QbitPqcObservationAnchor) {
    super(message)
    this.name = 'QbitPqcHistoryLimitError'
    this.anchor = anchor
  }
}

function resolveQbitTipAdvanceSettleMs(options: QbitPqcSignatureActivityOptions): number {
  const tipAdvanceSettleMs = options.tipAdvanceSettleMs ?? 0
  if (
    !Number.isSafeInteger(tipAdvanceSettleMs) ||
    tipAdvanceSettleMs < 0 ||
    tipAdvanceSettleMs > MAX_QBIT_SNAPSHOT_RETRY_DELAY_MS
  ) {
    throw new Error(
      `tipAdvanceSettleMs must be an integer between 0 and ${MAX_QBIT_SNAPSHOT_RETRY_DELAY_MS}`
    )
  }
  return tipAdvanceSettleMs
}

/**
 * `mempoolListLimit`, when given, is the most pending transactions the
 * history may hold before it counts as too long to enumerate. `started`
 * receives the chain tip the read began at, even when the read then fails.
 */
async function observeQbitPqcHistorySnapshot(
  client: QbitPqcHistoryClient,
  address: string,
  scriptPubKey: string,
  options: QbitPqcSignatureActivityOptions = {},
  mempoolListLimit?: number,
  started: { tipHash?: string } = {}
): Promise<QbitPqcHistorySnapshot> {
  const maxHistoryTransactions =
    options.maxHistoryTransactions ?? DEFAULT_MAX_COUNTER_HISTORY_TRANSACTIONS
  if (!Number.isSafeInteger(maxHistoryTransactions) || maxHistoryTransactions < 1) {
    throw new Error('maxHistoryTransactions must be a positive integer')
  }
  // Enough pages for an Esplora walk to reach the transaction cap, counting
  // the empty page that ends it.
  const maxHistoryPages =
    options.maxHistoryPages ??
    Math.ceil(maxHistoryTransactions / QBIT_UTXO_HISTORY_ROWS_PER_PAGE) + 1
  if (!Number.isSafeInteger(maxHistoryPages) || maxHistoryPages < 1) {
    throw new Error('maxHistoryPages must be a positive integer')
  }
  if (!scriptPubKey) {
    throw new Error('scriptPubKey is required to observe qbit signature activity')
  }
  const tipAdvanceSettleMs = resolveQbitTipAdvanceSettleMs(options)

  const tipHashBefore = await client.getTipHash()
  assertValidQbitTipHash(tipHashBefore)
  started.tipHash = tipHashBefore
  const statsBefore = await client.getAddressStats(address)
  assertValidQbitStats(statsBefore, address)
  const hasActivity = qbitStatsHaveActivity(statsBefore)
  const anchor = { tipHash: tipHashBefore, stats: statsBefore }

  const expectedHistoryTransactions =
    statsBefore.chain_stats.tx_count + statsBefore.mempool_stats.tx_count
  if (expectedHistoryTransactions > maxHistoryTransactions) {
    throw new QbitPqcHistoryLimitError(
      `qbit address history exceeds the ${maxHistoryTransactions}-transaction limit for ${address}`,
      anchor
    )
  }
  if (mempoolListLimit !== undefined && statsBefore.mempool_stats.tx_count > mempoolListLimit) {
    throw new QbitPqcHistoryLimitError(
      `qbit address mempool exceeds the ${mempoolListLimit}-transaction listing limit for ${address}`,
      anchor
    )
  }

  const history = await client.getAddressHistory(address, {
    maxPages: maxHistoryPages * QBIT_ADDRESS_HISTORY_READS,
    maxTransactions: maxHistoryTransactions * QBIT_ADDRESS_HISTORY_READS,
  })
  const mempoolTxs = history.mempool
  const confirmedTxs = history.confirmed
  const mempoolSnapshot = qbitMempoolSnapshot(mempoolTxs, address)
  const confirmedTxids = new Set<string>()
  for (const tx of confirmedTxs) {
    if (!tx.status.confirmed) {
      throw new Error(`unconfirmed transaction returned in qbit chain history for ${address}`)
    }
    if (!tx.txid) {
      throw new Error(`transaction without txid returned in qbit chain history for ${address}`)
    }
    if (confirmedTxids.has(tx.txid)) {
      throw new Error(`duplicate transaction returned in qbit chain history for ${address}`)
    }
    confirmedTxids.add(tx.txid)
  }

  const mempoolTxids = new Set(mempoolTxs.map(tx => tx.txid))

  // Stats and history come from separate index views; a count mismatch is
  // normally the indexer lagging one of them (the account history loader
  // classifies it the same way), so the bounded retry may take another look.
  if (confirmedTxids.size !== statsBefore.chain_stats.tx_count) {
    throw new QbitHistorySnapshotUnstableError(`incomplete qbit confirmed history for ${address}`)
  }
  if (mempoolTxids.size !== statsBefore.mempool_stats.tx_count) {
    throw new QbitHistorySnapshotUnstableError(`incomplete qbit mempool history for ${address}`)
  }

  const statsAfter = await client.getAddressStats(address)
  assertValidQbitStats(statsAfter, address)
  const mempoolTxsAfter = await client.getAddressMempoolTxs(address)
  const mempoolSnapshotAfter = qbitMempoolSnapshot(mempoolTxsAfter, address)
  const tipHashAfter = await client.getTipHash()
  assertValidQbitTipHash(tipHashAfter)
  if (
    qbitStatsSnapshot(statsAfter) !== qbitStatsSnapshot(statsBefore) ||
    mempoolSnapshotAfter !== mempoolSnapshot
  ) {
    throw new QbitHistorySnapshotUnstableError(
      `qbit address history changed while scanning ${address}`
    )
  }
  // The tip is global, so most blocks that land inside a window do not touch
  // this address. An advance still fails the observation: the address
  // endpoints cannot show whether their index has caught up with the block
  // the tip endpoint already reports, so re-reading the address right away
  // and finding it unchanged would not rule out a spend in that block.
  // Failing as unstable hands the advance to the bounded per-address
  // back-off, and the settle floor keeps that retry from firing before the
  // index has had time to include the block (the ordinary back-off is tuned
  // for mempool churn and starts far sooner).
  if (tipHashAfter !== tipHashBefore) {
    throw new QbitHistorySnapshotUnstableError(
      `qbit address history changed while scanning ${address}`,
      { minRetryDelayMs: tipAdvanceSettleMs }
    )
  }

  const normalizedScriptPubKey = scriptPubKey.toLowerCase()
  let observedSignatures = 0
  const spentOutpoints = new Map<string, string>()
  const transactions = new Map<string, EsploraTx>()
  for (const tx of [...mempoolTxs, ...confirmedTxs]) {
    transactions.set(tx.txid, tx)
  }
  for (const tx of transactions.values()) {
    for (const input of tx.vin) {
      if (input.is_coinbase) continue
      if (!input.prevout) {
        throw new Error(`missing prevout while scanning qbit transaction ${tx.txid}`)
      }
      if (input.prevout.scriptpubkey.toLowerCase() === normalizedScriptPubKey) {
        if (
          !QBIT_TXID_PATTERN.test(tx.txid) ||
          !QBIT_TXID_PATTERN.test(input.txid) ||
          !Number.isSafeInteger(input.vout) ||
          input.vout < 0 ||
          input.vout > MAX_OUTPUT_INDEX
        ) {
          throw new Error(`invalid spent outpoint while scanning qbit transaction ${tx.txid}`)
        }
        const outpoint = `${input.txid.toLowerCase()}:${input.vout}`
        if (spentOutpoints.has(outpoint)) {
          throw new Error(`duplicate spent outpoint ${outpoint} in qbit history for ${address}`)
        }
        spentOutpoints.set(outpoint, tx.txid.toLowerCase())
        observedSignatures += 1
      }
    }
  }

  const expectedSpentInputs =
    statsBefore.chain_stats.spent_txo_count + statsBefore.mempool_stats.spent_txo_count
  if (observedSignatures !== expectedSpentInputs) {
    throw new Error(`incomplete qbit spent-input history for ${address}`)
  }

  return { observedSignatures, hasActivity, spentOutpoints }
}

/**
 * Count signatures already made by a P2MR account. The result is a safe
 * counter floor only when Esplora returns a complete, stable history snapshot.
 *
 * When the address statistics show a history too long to enumerate (past
 * the transaction cap, or, on an Esplora surface, more pending transactions
 * than its mempool listing returns), the floor is read from those statistics
 * instead (`floorSource: 'address-stats'`); see `observeQbitPqcStatsFloor`.
 * Any other failure still fails the observation, including a walk that hits
 * the client's page or transaction ceiling while the statistics say the
 * history fits: the two disagree, and the statistics may be the stale side.
 */
export async function observeQbitPqcSignatureActivity(
  client: QbitPqcHistoryClient,
  address: string,
  scriptPubKey: string,
  options: QbitPqcSignatureActivityOptions = {}
): Promise<QbitPqcSignatureActivity> {
  const retry = resolveQbitSnapshotStabilityRetries(options)
  const tipAdvanceSettleMs = resolveQbitTipAdvanceSettleMs(options)
  return loadQbitSnapshotWithStabilityRetries<QbitPqcSignatureActivity>(retry, async () => {
    const started: { tipHash?: string } = {}
    try {
      return await observeQbitPqcFloorOnce(
        client,
        address,
        scriptPubKey,
        options,
        tipAdvanceSettleMs,
        started
      )
    } catch (error) {
      throw await qbitTipAdvanceSettledError(client, error, started.tipHash, tipAdvanceSettleMs)
    }
  })
}

async function observeQbitPqcFloorOnce(
  client: QbitPqcHistoryClient,
  address: string,
  scriptPubKey: string,
  options: QbitPqcSignatureActivityOptions,
  tipAdvanceSettleMs: number,
  started: { tipHash?: string }
): Promise<QbitPqcSignatureActivity> {
  try {
    const { observedSignatures, hasActivity } = await observeQbitPqcHistorySnapshot(
      client,
      address,
      scriptPubKey,
      options,
      client instanceof MempoolQbitClient ? undefined : ESPLORA_ADDRESS_MEMPOOL_LIST_LIMIT,
      started
    )
    return { observedSignatures, hasActivity, floorSource: 'history' }
  } catch (error) {
    if (!(error instanceof QbitPqcHistoryLimitError)) throw error
    return observeQbitPqcStatsFloor(client, address, tipAdvanceSettleMs, error.anchor)
  }
}

/**
 * The error to retry an unstable floor observation with. However the
 * instability showed (statistics that moved, a count mismatch, a shifted
 * history page), a chain tip that advanced since the attempt began holds the
 * retry for `tipAdvanceSettleMs`: a pending spend can leave the mempool
 * before the address index holds the block that confirmed it, and a quick
 * reread would find the index still lagging. A tip that cannot be read
 * counts as advanced.
 */
async function qbitTipAdvanceSettledError(
  client: QbitPqcHistoryClient,
  error: unknown,
  startTipHash: string | undefined,
  tipAdvanceSettleMs: number
): Promise<unknown> {
  if (
    startTipHash === undefined ||
    tipAdvanceSettleMs === 0 ||
    !isQbitSnapshotUnstableError(error) ||
    (error instanceof QbitHistorySnapshotUnstableError &&
      error.minRetryDelayMs >= tipAdvanceSettleMs)
  ) {
    return error
  }
  try {
    const tipHashNow = await client.getTipHash()
    assertValidQbitTipHash(tipHashNow)
    if (tipHashNow === startTipHash) return error
  } catch {
    // Unknown: settle as for an advance.
  }
  return new QbitHistorySnapshotUnstableError((error as Error).message, {
    minRetryDelayMs: tipAdvanceSettleMs,
    cause: error,
  })
}

/**
 * The signature floor of an address whose history cannot be enumerated, read
 * from its statistics: each of its outputs spent so far, confirmed or
 * pending, carries one signature by its key. The enumerated read accepts a
 * floor only when its count equals this one, so the two trust the same
 * explorer and agree wherever both can run. As there, the statistics and the
 * chain tip must read the same before and after, and a tip advance holds the
 * retry for `tipAdvanceSettleMs`. The read continues from the `anchor` the
 * history read began with. Statistics that spend more than the address was
 * paid, or list more outputs than their transactions can carry, fail the
 * read, as does a floor at the warning threshold
 * (`assertQbitStatsFloorBelowWarningThreshold`).
 */
async function observeQbitPqcStatsFloor(
  client: QbitPqcHistoryClient,
  address: string,
  tipAdvanceSettleMs: number,
  anchor: QbitPqcObservationAnchor
): Promise<QbitPqcSignatureActivity> {
  const { tipHash: tipHashBefore, stats: statsBefore } = anchor
  assertQbitStatsFloorConsistent(statsBefore, address)
  const observedSignatures = safeQbitValueSum(
    [statsBefore.chain_stats.spent_txo_count, statsBefore.mempool_stats.spent_txo_count],
    `spent output count of ${address}`
  )
  assertQbitStatsFloorBelowWarningThreshold(observedSignatures, `qbit address ${address} stats`)
  const statsAfter = await client.getAddressStats(address)
  assertValidQbitStats(statsAfter, address)
  const tipHashAfter = await client.getTipHash()
  assertValidQbitTipHash(tipHashAfter)
  if (qbitStatsSnapshot(statsAfter) !== qbitStatsSnapshot(statsBefore)) {
    throw new QbitHistorySnapshotUnstableError(
      `qbit address statistics changed while reading ${address}`
    )
  }
  if (tipHashAfter !== tipHashBefore) {
    throw new QbitHistorySnapshotUnstableError(
      `qbit address statistics changed while reading ${address}`,
      { minRetryDelayMs: tipAdvanceSettleMs }
    )
  }
  return {
    observedSignatures,
    hasActivity: qbitStatsHaveActivity(statsBefore),
    floorSource: 'address-stats',
  }
}

/**
 * Refuses a floor read in whole or in part from address statistics once it
 * reaches `PQC_WARNING_SIGNATURE_THRESHOLD`: no path lowers a floor, and one
 * that an explorer inflated would keep the account from signing until the
 * wallet is restored again. `subject` names what claims the floor.
 */
export function assertQbitStatsFloorBelowWarningThreshold(
  observedSignatures: number,
  subject: string
): void {
  if (observedSignatures >= PQC_WARNING_SIGNATURE_THRESHOLD) {
    throw new Error(
      `${subject} claim ${observedSignatures} signatures, at or above the ${PQC_WARNING_SIGNATURE_THRESHOLD}-signature warning threshold`
    )
  }
}

/**
 * The most outputs paying, and inputs spending, one P2MR address that a
 * single transaction can carry. A transaction cannot outgrow the
 * 2,000,000-byte block that holds it (`MAX_QBIT_RAW_TRANSACTION_HEX_LENGTH`),
 * and with `WITNESS_SCALE_FACTOR = 1` its witness counts in full. An output
 * paying the address is 43 bytes: an 8-byte value, a 1-byte length and the
 * 34-byte script (`QBIT_P2MR_SCRIPT_PATTERN`). An input spending it carries
 * a signature; `estimateQbitP2mrTransaction` sizes it with the default
 * signature, an empty leaf script and a zero-depth control block, so no real
 * spend is smaller than its 3,728 bytes. That allows 46,511 outputs and 536
 * inputs.
 */
function qbitP2mrTransactionCapacity(): { outputs: number; inputs: number } {
  const maxTransactionBytes = MAX_QBIT_RAW_TRANSACTION_HEX_LENGTH / 2
  const p2mrScriptBytes = 34
  const { inputVsize } = estimateQbitP2mrTransaction({
    inputCount: 1,
    outputScriptLengths: [p2mrScriptBytes],
    leafScriptLength: 0,
    controlBlockLength: QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  })
  return {
    outputs: Math.floor(maxTransactionBytes / (8 + 1 + p2mrScriptBytes)),
    inputs: Math.floor(maxTransactionBytes / inputVsize),
  }
}

/**
 * `assertValidQbitStats`, plus what a floor read from the statistics alone
 * relies on. Every transaction in an address's history pays or spends it, so
 * neither scope may list more transactions than it has funded and spent
 * outputs. Nor may the address spend more outputs or value than it was paid:
 * a confirmed spend can only spend a confirmed output, a pending one either.
 * Nor may a scope list more funded or spent outputs than its transactions
 * can carry (`qbitP2mrTransactionCapacity`).
 */
function assertQbitStatsFloorConsistent(stats: EsploraAddressStats, address: string): void {
  assertValidQbitStats(stats, address)
  const chain = stats.chain_stats
  const mempool = stats.mempool_stats
  for (const [scope, item] of [
    ['chain', chain],
    ['mempool', mempool],
  ] as const) {
    const touchingOutputs = safeQbitValueSum(
      [item.funded_txo_count, item.spent_txo_count],
      `${scope} output count of qbit address ${address}`
    )
    if (item.tx_count > touchingOutputs) {
      throw new Error(
        `qbit address ${address} ${scope} stats list more transactions than outputs it funded or spent`
      )
    }
  }
  const total = (field: keyof typeof chain): number =>
    safeQbitValueSum([chain[field], mempool[field]], `${field} of qbit address ${address}`)
  if (
    chain.spent_txo_count > chain.funded_txo_count ||
    chain.spent_txo_sum > chain.funded_txo_sum ||
    total('spent_txo_count') > total('funded_txo_count') ||
    total('spent_txo_sum') > total('funded_txo_sum')
  ) {
    throw new Error(`qbit address ${address} stats spend more than it was paid`)
  }
  const capacity = qbitP2mrTransactionCapacity()
  for (const [scope, item] of [
    ['chain', chain],
    ['mempool', mempool],
  ] as const) {
    if (
      item.funded_txo_count > item.tx_count * capacity.outputs ||
      item.spent_txo_count > item.tx_count * capacity.inputs
    ) {
      throw new Error(
        `qbit address ${address} ${scope} stats list more outputs than its transactions can carry`
      )
    }
  }
}

/**
 * Per-address stability retry, as `observeQbitPqcSignatureActivity` retries
 * for restore floor scans. Retrying per address rather than around a whole
 * scan keeps one churning address from restarting every other address's
 * observation; the cap keeps an endlessly churning mempool from hanging a
 * derivation.
 */
async function observeStableQbitPqcHistorySnapshot(
  client: QbitPqcHistoryClient,
  address: string,
  scriptPubKey: string,
  options: QbitPqcSignatureActivityOptions
): Promise<QbitPqcHistorySnapshot> {
  const retry = resolveQbitSnapshotStabilityRetries(options)
  return loadQbitSnapshotWithStabilityRetries(retry, () =>
    observeQbitPqcHistorySnapshot(client, address, scriptPubKey, options)
  )
}

/**
 * True when a mempool transaction spends one of the address's outputs.
 * Esplora's UTXO listing hides outputs spent by unconfirmed transactions,
 * so completion checks that scan UTXOs must treat a pending spender as
 * unresolved until it either confirms or drops back out of the mempool.
 */
export async function qbitAddressHasUnconfirmedSpends(
  client: QbitEsploraClient,
  address: string
): Promise<boolean> {
  const stats = await client.getAddressStats(address)
  assertValidQbitStats(stats, address)
  return stats.mempool_stats.spent_txo_count > 0
}

/**
 * Return direct spender evidence for a P2MR account's outpoints. Missing
 * outpoints are intentionally not treated as spent.
 */
export async function observeQbitPqcSpentOutpoints(
  client: QbitPqcHistoryClient,
  address: string,
  scriptPubKey: string,
  options: QbitPqcSignatureActivityOptions = {}
): Promise<ReadonlyMap<string, string>> {
  return (await observeStableQbitPqcHistorySnapshot(client, address, scriptPubKey, options))
    .spentOutpoints
}

export async function getQbitAddressSummaries(
  client: QbitEsploraClient,
  addresses: string
): Promise<AddressSummary[]> {
  return Promise.all(
    addresses.split(',').map(async rawAddress => {
      const address = rawAddress.trim()
      if (!address) {
        return { address, totalSatoshis: 0, spendableSatoshis: 0 }
      }
      return qbitStatsToAddressSummary(await client.getAddressStats(address))
    })
  )
}

export async function findActiveQbitAddressGroups<T extends AddressGroup>(
  client: QbitEsploraClient,
  groups: T[]
): Promise<
  { type: number; address_arr: string[]; pubkey_arr: string[]; satoshis_arr: number[] }[]
> {
  return Promise.all(
    groups.map(async group => {
      const stats = await Promise.all(
        group.address_arr.map(async rawAddress => {
          const address = rawAddress.trim()
          if (!address) return undefined
          const item = await client.getAddressStats(address)
          assertValidQbitStats(item, address)
          return item
        })
      )
      const activeIndexes = stats
        .map((item, index) => ({
          balance: item ? qbitStatsToAddressSummary(item) : undefined,
          hasActivity: item ? qbitStatsHaveActivity(item) : false,
          index,
        }))
        .filter(item => (item.balance?.totalSatoshis ?? 0) > 0 || item.hasActivity)

      return {
        type: group.type,
        address_arr: activeIndexes.map(item => group.address_arr[item.index]!),
        pubkey_arr:
          group.pubkey_arr && group.pubkey_arr.length > 0
            ? activeIndexes.map(item => group.pubkey_arr?.[item.index] ?? '')
            : [],
        satoshis_arr: activeIndexes.map(item => item.balance?.totalSatoshis ?? 0),
      }
    })
  )
}

export interface QbitClassifiedUtxos {
  /**
   * Policy-spendable now, including confirmed and unconfirmed non-coinbase
   * outputs. Sends select from a narrower set; see `getQbitAddressUtxos`.
   */
  spendable: UTXO[]
  /** Confirmed subset of spendable. */
  confirmedSpendable: UTXO[]
  /** Unconfirmed subset of spendable. */
  unconfirmedSpendable: UTXO[]
  /**
   * The subset of unconfirmedSpendable that is change: every input of its
   * transaction spends an output of this same script.
   */
  unconfirmedOwnChange: UTXO[]
  /** Confirmed coinbase outputs still inside the 1,000-block maturity window. */
  immature: UTXO[]
}

export async function getQbitAddressUtxosClassified(
  client: QbitEsploraClient,
  address: string
): Promise<QbitClassifiedUtxos> {
  const utxos = await client.getAddressUtxos(address)
  if (!Array.isArray(utxos)) {
    throw new Error(`invalid qbit UTXO response for ${address}`)
  }
  const seenOutpoints = new Set<string>()
  utxos.forEach((utxo, index) => {
    assertValidQbitUtxo(utxo, index)
    const outpoint = `${utxo.txid.toLowerCase()}:${utxo.vout}`
    if (seenOutpoints.has(outpoint)) {
      throw new Error(`duplicate qbit UTXO ${outpoint}`)
    }
    seenOutpoints.add(outpoint)
  })
  return classifyQbitUtxos(client, utxos, txid => client.getTx(txid))
}

/**
 * Classify listed outputs as `getQbitAddressUtxosClassified` describes.
 * `getFundingTx` supplies each output's transaction, checked against the
 * output before it is classified.
 */
async function classifyQbitUtxos(
  client: QbitEsploraClient,
  utxos: readonly EsploraUtxo[],
  getFundingTx: (txid: string) => Promise<EsploraTx>
): Promise<QbitClassifiedUtxos> {
  let tipHeightPromise: Promise<number> | undefined
  const getTipHeightOnce = () => (tipHeightPromise ??= client.getTipHeight())
  const ancestors = new Map<string, Promise<EsploraTx | undefined>>()
  const getAncestorOnce = (txid: string) => {
    let ancestor = ancestors.get(txid)
    if (!ancestor) {
      ancestor = getQbitAncestorTx(client, txid)
      ancestors.set(txid, ancestor)
    }
    return ancestor
  }
  const walletUtxos = await Promise.all(
    utxos.map(utxo => qbitUtxoToWalletUtxo(getFundingTx, utxo, getTipHeightOnce, getAncestorOnce))
  )
  const spendable: UTXO[] = []
  const confirmedSpendable: UTXO[] = []
  const unconfirmedSpendable: UTXO[] = []
  const unconfirmedOwnChange: UTXO[] = []
  const immature: UTXO[] = []
  // A send may select any of the change outputs together, so their
  // unconfirmed ancestors share one budget under qbit Core's count limit.
  // Each output carries its ancestors' sizes, which coin selection keeps
  // within the ancestor size limit for the outputs it actually spends.
  let ownChangeAncestors = new Set<string>()
  for (const entry of walletUtxos) {
    if (!entry) continue
    if (entry.immature) {
      immature.push(entry.utxo)
    } else {
      spendable.push(entry.utxo)
      if (entry.confirmed) {
        confirmedSpendable.push(entry.utxo)
      } else {
        unconfirmedSpendable.push(entry.utxo)
        if (entry.ownAncestry) {
          const ancestors = new Set([...ownChangeAncestors, ...entry.ownAncestry.keys()])
          if (ancestors.size < QBIT_MEMPOOL_ANCESTOR_LIMIT) {
            ownChangeAncestors = ancestors
            unconfirmedOwnChange.push({
              ...entry.utxo,
              unconfirmedAncestors: [...entry.ownAncestry].map(([txid, vsize]) => ({
                txid,
                vsize,
              })),
            })
          }
        }
      }
    }
  }
  return { spendable, confirmedSpendable, unconfirmedSpendable, unconfirmedOwnChange, immature }
}

/**
 * The most transactions the wallet reads to derive the outputs of an address
 * the explorer will not list. Past it they stay unknown.
 */
export const QBIT_UTXO_HISTORY_MAX_TRANSACTIONS = 10_000
// Esplora pages confirmed history 25 rows at a time and ends on an empty
// page. mempool-qbit's pages are larger and its own page ceiling applies.
const QBIT_UTXO_HISTORY_ROWS_PER_PAGE = 25
// Retries 5 s and then 10 s later, so the second one lands past electrs'
// 10 s response cache, which would otherwise hand a lagging index's answer back.
const QBIT_UTXO_HISTORY_STABILITY_RETRIES = 2
const QBIT_UTXO_HISTORY_RETRY_BASE_DELAY_MS = 5_000

/**
 * The address's history is longer than the wallet reads to derive its
 * outputs, so they are unknown. Nothing smaller stands in for them.
 */
export class QbitUtxoHistoryTooLargeError extends Error {
  readonly maxTransactions: number

  constructor(address: string, maxTransactions: number) {
    super(
      `qbit address ${address} has more than ${maxTransactions} transactions, too many to read its outputs from its history`
    )
    this.name = 'QbitUtxoHistoryTooLargeError'
    this.maxTransactions = maxTransactions
  }
}

/**
 * `getQbitAddressUtxosClassified` for an address the explorer will not list,
 * read from its complete history instead: every output paying the address,
 * less every one a transaction in that history spends. A spend of one of the
 * address's outputs is itself in the address's history, so the history
 * alone decides.
 *
 * The read fails closed and never returns a smaller set. The address
 * statistics must read the same before and after the walk, and the walk
 * must hold exactly their transaction counts. The outputs it finds funded
 * and spent must match their counts and sums. A history that moved or does
 * not reconcile is read again a bounded number of times, then throws. A
 * history longer than `maxTransactions` throws
 * `QbitUtxoHistoryTooLargeError` before any page is read, and so does one
 * the client's page ceiling cuts short.
 */
export async function getQbitAddressUtxosClassifiedFromHistory(
  client: QbitEsploraClient,
  address: string,
  options: QbitSnapshotStabilityRetryOptions & { maxTransactions?: number } = {}
): Promise<QbitClassifiedUtxos> {
  const maxTransactions = options.maxTransactions ?? QBIT_UTXO_HISTORY_MAX_TRANSACTIONS
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1) {
    throw new Error('maxTransactions must be a positive integer')
  }
  const retry = resolveQbitSnapshotStabilityRetries({
    stabilityRetries: options.stabilityRetries ?? QBIT_UTXO_HISTORY_STABILITY_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? QBIT_UTXO_HISTORY_RETRY_BASE_DELAY_MS,
  })
  const unspent = await loadQbitSnapshotWithStabilityRetries(retry, () =>
    readQbitUnspentOutputsFromHistory(client, address, maxTransactions)
  )
  const confirmedTxs = new Map(
    unspent
      .filter(({ tx }) => tx.status.confirmed)
      .map(({ tx }) => [tx.txid.toLowerCase(), tx] as const)
  )
  return classifyQbitUtxos(
    client,
    unspent.map(({ tx, vout }) => ({
      txid: tx.txid,
      vout,
      value: tx.vout[vout]!.value,
      status: tx.status,
    })),
    // An unconfirmed funding transaction is fetched whole, as for a listed
    // output: the ownership walk behind its change reads every prevout,
    // which a history row may omit.
    txid => {
      const tx = confirmedTxs.get(txid.toLowerCase())
      return tx ? Promise.resolve(tx) : client.getTx(txid)
    }
  )
}

async function readQbitUnspentOutputsFromHistory(
  client: QbitEsploraClient,
  address: string,
  maxTransactions: number
): Promise<{ tx: EsploraTx; vout: number }[]> {
  const statsBefore = await client.getAddressStats(address)
  assertValidQbitStats(statsBefore, address)
  if (qbitHistoryOverReadLimit(statsBefore, maxTransactions)) {
    throw new QbitUtxoHistoryTooLargeError(address, maxTransactions)
  }
  let history: AddressHistory
  try {
    history = await client.getAddressHistory(address, {
      maxPages:
        (Math.ceil(maxTransactions / QBIT_UTXO_HISTORY_ROWS_PER_PAGE) + 1) *
        QBIT_ADDRESS_HISTORY_READS,
      maxTransactions: maxTransactions * QBIT_ADDRESS_HISTORY_READS,
    })
  } catch (error) {
    if (error instanceof QbitApiError && error.kind === 'pagination_limit') {
      throw new QbitUtxoHistoryTooLargeError(address, maxTransactions)
    }
    throw error
  }
  const statsAfter = await client.getAddressStats(address)
  assertValidQbitStats(statsAfter, address)
  if (qbitStatsSnapshot(statsAfter) !== qbitStatsSnapshot(statsBefore)) {
    throw new QbitHistorySnapshotUnstableError(
      `qbit address history changed while reading the outputs of ${address}`
    )
  }
  const transactions = assertCompleteQbitAddressHistory(history, statsBefore, address)

  const funded = new Map<string, { tx: EsploraTx; vout: number }>()
  let fundedSats = 0
  for (const tx of transactions) {
    tx.vout.forEach((output, vout) => {
      if (!qbitOutputPaysAddress(output, address)) return
      funded.set(`${tx.txid.toLowerCase()}:${vout}`, { tx, vout })
      fundedSats = safeQbitValueSum([fundedSats, output.value], `funded total of ${address}`)
    })
  }
  const spent = new Set<string>()
  let spentSats = 0
  for (const tx of transactions) {
    for (const input of tx.vin) {
      if (input.is_coinbase) continue
      const outpoint = `${input.txid.toLowerCase()}:${input.vout}`
      const output = funded.get(outpoint)
      if (!output) continue
      if (spent.has(outpoint)) {
        throw new Error(`qbit history of ${address} spends ${outpoint} twice`)
      }
      spent.add(outpoint)
      spentSats = safeQbitValueSum(
        [spentSats, output.tx.vout[output.vout]!.value],
        `spent total of ${address}`
      )
    }
  }
  const chain = statsBefore.chain_stats
  const mempool = statsBefore.mempool_stats
  if (
    funded.size !== chain.funded_txo_count + mempool.funded_txo_count ||
    fundedSats !== chain.funded_txo_sum + mempool.funded_txo_sum ||
    spent.size !== chain.spent_txo_count + mempool.spent_txo_count ||
    spentSats !== chain.spent_txo_sum + mempool.spent_txo_sum
  ) {
    // An index that lags its own statistics can settle; the retry decides.
    throw new QbitHistorySnapshotUnstableError(
      `qbit history of ${address} does not reconcile with its statistics`
    )
  }
  return [...funded].filter(([outpoint]) => !spent.has(outpoint)).map(([, output]) => output)
}

function qbitHistoryOverReadLimit(stats: EsploraAddressStats, maxTransactions: number): boolean {
  return stats.chain_stats.tx_count > maxTransactions - stats.mempool_stats.tx_count
}

/**
 * Whether checked address statistics (`qbitAddressOutputCounts` checks them)
 * show a history longer than `getQbitAddressUtxosClassifiedFromHistory`
 * reads, so the address's outputs cannot be read once the explorer refuses
 * to list them.
 */
export function isQbitHistoryOverReadLimit(stats: EsploraAddressStats): boolean {
  return qbitHistoryOverReadLimit(stats, QBIT_UTXO_HISTORY_MAX_TRANSACTIONS)
}

/**
 * `getQbitAddressUtxosClassified`, or for an address over the explorer's
 * UTXO limit (`isQbitUtxoListOverExplorerLimit`) the same classification
 * read from its history (`getQbitAddressUtxosClassifiedFromHistory`). Any
 * other listing failure keeps its own meaning.
 */
export async function getQbitAddressUtxosClassifiedPastLimit(
  client: QbitEsploraClient,
  address: string
): Promise<QbitClassifiedUtxos> {
  try {
    return await getQbitAddressUtxosClassified(client, address)
  } catch (error) {
    if (!(await isQbitUtxoListOverExplorerLimit(client, address, error))) throw error
  }
  return getQbitAddressUtxosClassifiedFromHistory(client, address)
}

/**
 * The outputs a send may select, confirmed ones first and the rest marked
 * `unconfirmed` so that selection prefers the confirmed ones: mature
 * confirmed outputs, then the unconfirmed change of this script's own
 * transactions. An unconfirmed payment from anyone else stays out until it
 * confirms. qbit Core is full-RBF, so its payer can replace it at any time,
 * and that evicts every send built on top of it. An address over the
 * explorer's UTXO limit is read from its history.
 */
export async function getQbitAddressUtxos(
  client: QbitEsploraClient,
  address: string
): Promise<UTXO[]> {
  const { confirmedSpendable, unconfirmedOwnChange } = await getQbitAddressUtxosClassifiedPastLimit(
    client,
    address
  )
  return [
    ...confirmedSpendable,
    ...unconfirmedOwnChange.map(utxo => ({ ...utxo, unconfirmed: true })),
  ]
}

/** The address's output counts from its statistics, as the explorer's limit sees them. */
export interface QbitAddressOutputCounts {
  /** Confirmed outputs not spent in a block: what electrs counts against its limit. */
  confirmedUnspent: number
  /** Outputs mempool transactions spend; they leave the count once those confirm. */
  pendingSpent: number
  /** Outputs mempool transactions create; they join the count once those confirm. */
  pendingFunded: number
}

export async function getQbitAddressOutputCounts(
  client: Pick<QbitEsploraClient, 'getAddressStats'>,
  address: string
): Promise<QbitAddressOutputCounts> {
  return qbitAddressOutputCounts(await client.getAddressStats(address), address)
}

/** The output counts in `stats`, the statistics of `address`, which it checks first. */
export function qbitAddressOutputCounts(
  stats: EsploraAddressStats,
  address: string
): QbitAddressOutputCounts {
  assertValidQbitStats(stats, address)
  const confirmedUnspent = stats.chain_stats.funded_txo_count - stats.chain_stats.spent_txo_count
  if (confirmedUnspent < 0) {
    throw new Error(`inconsistent chain stats for qbit address ${address}`)
  }
  return {
    confirmedUnspent,
    pendingSpent: stats.mempool_stats.spent_txo_count,
    pendingFunded: stats.mempool_stats.funded_txo_count,
  }
}

/** A confirmed output paying the scanned address that no walked transaction spends. */
export interface QbitHistoryOutputCandidate {
  txid: string
  vout: number
  value: number
  scriptPk: string
  /** How many outputs the funding transaction has, for `getQbitTxSpenders`. */
  outputCount: number
  blockHeight: number
  coinbase: boolean
}

/**
 * Where a newest-first walk of one address's history stands, from one page
 * to the next (`readQbitHistoryWalkPage`). The empty object starts at the
 * top of the history.
 */
export interface QbitHistoryWalkCursor {
  /** The row the next page continues after: the last row read, or the one before it. */
  afterTxid?: string | undefined
  /**
   * Set while `afterTxid` is a mempool row: the cursor that lists that row
   * first, the row read before it or the top of the history.
   */
  beforeMempoolCursor?: { afterTxid: string | undefined } | undefined
  /** A row already walked that the next page must start with, and that it skips. */
  overlapTxid?: string | undefined
}

/** One page of a history walk, checked whole. */
interface QbitHistoryWalkPage {
  /** How many rows the page held, a row the walk stepped back over included. */
  size: number
  /** The rows the walk had not read yet, newest first. */
  rows: EsploraTx[]
  /** Their txids, lowercase. */
  txids: string[]
  /** Where the walk goes on from. */
  next: QbitHistoryWalkCursor
  /** The empty page that ends the history. */
  ended: boolean
}

/**
 * Read the page of `address`'s history after `cursor`, and check it whole,
 * without changing `cursor`. A malformed page, or one that repeats its
 * cursor, throws.
 *
 * An empty page after a mempool row does not end the history. qbit-electrs
 * answers a cursor that is the last mempool row with an empty page instead
 * of the confirmed rows after it (`src/rest.rs:992-998` in
 * Qbit-Org/qbit-electrs@53102e9), so an address whose mempool rows fill
 * whole pages would look as if it had no confirmed history. The walk then
 * steps back one row: the page after the row before it starts with that
 * mempool row again and goes on into the confirmed rows. If that page holds
 * the mempool row alone, the history has no confirmed rows and ends there;
 * if it starts with any other row, the mempool moved and it throws
 * `invalid_cursor`, as `@qbit-oss/api`'s own history walk does.
 */
async function readQbitHistoryWalkPage(
  client: QbitAddressHistoryPageClient,
  address: string,
  cursor: QbitHistoryWalkCursor
): Promise<QbitHistoryWalkPage> {
  const page = await client.getAddressHistoryPage(address, cursor.afterTxid)
  if (!Array.isArray(page)) {
    throw new Error(`invalid qbit history page for ${address}`)
  }
  page.forEach(assertValidQbitHistoryTransaction)
  const pageTxids = page.map(tx => tx.txid.toLowerCase())
  const after = cursor.afterTxid?.toLowerCase()
  if (
    new Set(pageTxids).size !== pageTxids.length ||
    (after !== undefined && pageTxids.includes(after))
  ) {
    throw new QbitApiError('invalid_cursor', `qbit history page repeated rows for ${address}`)
  }
  const overlap = cursor.overlapTxid?.toLowerCase()
  if (overlap !== undefined && pageTxids[0] !== overlap) {
    throw new QbitApiError(
      'invalid_cursor',
      `qbit history of ${address} moved while the walk stepped back over a mempool row`
    )
  }
  if (page.length === 0 && cursor.beforeMempoolCursor) {
    return {
      size: 0,
      rows: [],
      txids: [],
      next: { afterTxid: cursor.beforeMempoolCursor.afterTxid, overlapTxid: cursor.afterTxid },
      ended: false,
    }
  }
  const rows = overlap === undefined ? page : page.slice(1)
  const txids = overlap === undefined ? pageTxids : pageTxids.slice(1)
  if (rows.length === 0) {
    return {
      size: page.length,
      rows,
      txids,
      next: { afterTxid: cursor.afterTxid, beforeMempoolCursor: cursor.beforeMempoolCursor },
      ended: true,
    }
  }
  const last = rows[rows.length - 1]!
  return {
    size: page.length,
    rows,
    txids,
    next: {
      afterTxid: last.txid,
      beforeMempoolCursor: last.status.confirmed
        ? undefined
        : { afterTxid: page.length > 1 ? page[page.length - 2]!.txid : cursor.afterTxid },
    },
    ended: false,
  }
}

// As `@qbit-oss/api`'s mempool-qbit reads: `getAddressHistory` reads at
// most this many rows by default, `getAddressTxs` returns this many, and a
// combined page holds at least this many unless it is the last.
const MEMPOOL_QBIT_DEFAULT_MAX_HISTORY_TRANSACTIONS = 6_400
const MEMPOOL_QBIT_ADDRESS_TXS_ROWS = 25
const MEMPOOL_QBIT_MIN_PAGE_ROWS = 10
// Walks repeated because the address statistics changed during the previous one.
const MEMPOOL_QBIT_HISTORY_REWALKS = 1

/** One address's combined history pages and statistics, as one call reads them. */
type QbitCombinedRoute = QbitAddressHistoryPageClient & Pick<QbitEsploraClient, 'getAddressStats'>

function positiveQbitHistoryLimit(
  value: number | undefined,
  defaultValue: number,
  name: keyof AddressHistoryOptions
): number {
  const limit = value ?? defaultValue
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new QbitApiError('http', `${name} must be a positive integer`)
  }
  return limit
}

/**
 * The complete history of an address on mempool-qbit's combined route, as
 * `@qbit-oss/api`'s walk returns it, but read past the empty page
 * qbit-electrs answers after a whole page of mempool rows
 * (`readQbitHistoryWalkPage`). The library's walk takes that page for the
 * end, so it rejects with `invalid_cursor` an address with confirmed history
 * whose pending rows fill whole pages.
 *
 * Otherwise it keeps the library's contract. Each row must be well formed,
 * touch the address and appear once. The address statistics are read before
 * and after, and the history is returned only if both reads agree and it
 * holds exactly their transaction counts; otherwise it rejects with
 * `invalid_cursor`. A walk during which the statistics changed is repeated
 * once, from the later read. `maxPages` page fetches and `maxTransactions`
 * rows cover both walks; past either it throws `pagination_limit`.
 */
async function walkQbitCombinedAddressHistory(
  route: QbitCombinedRoute,
  address: string,
  limits: { maxPages: number; maxTransactions: number }
): Promise<AddressHistory> {
  const budget = { pages: 0, rows: 0 }
  let before = await readQbitCombinedRouteStats(route, address)
  for (let walks = 1; ; walks += 1) {
    const history = await walkQbitCombinedAddressHistoryOnce(route, address, limits, budget)
    const after = await readQbitCombinedRouteStats(route, address)
    if (qbitStatsSnapshot(after) !== qbitStatsSnapshot(before)) {
      if (walks > MEMPOOL_QBIT_HISTORY_REWALKS) {
        throw new QbitApiError(
          'invalid_cursor',
          `mempool-qbit address stats changed during each of ${walks} history walks: ${address}`
        )
      }
      before = after
      continue
    }
    const confirmed = after.chain_stats.tx_count
    const mempool = after.mempool_stats.tx_count
    if (history.confirmed.length !== confirmed || history.mempool.length !== mempool) {
      throw new QbitApiError(
        'invalid_cursor',
        `mempool-qbit address history returned ${history.confirmed.length} confirmed and ${history.mempool.length} mempool transactions, but the address stats count ${confirmed} and ${mempool}: ${address}`
      )
    }
    return history
  }
}

async function readQbitCombinedRouteStats(
  route: QbitCombinedRoute,
  address: string
): Promise<EsploraAddressStats> {
  const stats = await route.getAddressStats(address)
  assertValidQbitStats(stats, address)
  return stats
}

async function walkQbitCombinedAddressHistoryOnce(
  route: QbitCombinedRoute,
  address: string,
  limits: { maxPages: number; maxTransactions: number },
  budget: { pages: number; rows: number }
): Promise<AddressHistory> {
  const history: AddressHistory = { confirmed: [], mempool: [] }
  const seen = new Set<string>()
  let cursor: QbitHistoryWalkCursor = {}
  for (;;) {
    if (budget.pages >= limits.maxPages) {
      throw new QbitApiError(
        'pagination_limit',
        `mempool-qbit address history exceeded ${limits.maxPages} pages: ${address}`
      )
    }
    budget.pages += 1
    const page = await readQbitHistoryWalkPage(route, address, cursor)
    budget.rows += page.size
    if (budget.rows > limits.maxTransactions) {
      throw new QbitApiError(
        'pagination_limit',
        `mempool-qbit address history exceeded ${limits.maxTransactions} transactions: ${address}`
      )
    }
    if (page.ended) return history
    page.rows.forEach((tx, index) => {
      const txid = page.txids[index]!
      if (seen.has(txid)) {
        throw new QbitApiError(
          'invalid_cursor',
          `mempool-qbit address history repeated transaction ${txid}: ${address}`
        )
      }
      if (!qbitTransactionTouchesAddress(tx, address)) {
        throw new QbitApiError(
          'parse',
          `mempool-qbit address history transaction ${txid} did not touch ${address}`
        )
      }
      seen.add(txid)
      ;(tx.status.confirmed ? history.confirmed : history.mempool).push(tx)
    })
    cursor = page.next
  }
}

/**
 * The newest confirmed transactions of an address on mempool-qbit's combined
 * route, after the confirmed row `afterTxid` when it is given, as
 * `@qbit-oss/api`'s `getAddressTxs` returns them: at most 25, each once,
 * a row a later page repeats skipped. It reads from the top and past the
 * empty page after a whole page of mempool rows
 * (`readQbitHistoryWalkPage`), where the library's read rejects. Like that
 * read it stops at a page shorter than a full one (10 rows), since nothing
 * follows it. A cursor it does not find among the confirmed rows rejects
 * with `invalid_cursor`; more than `maxPages` pages, with `pagination_limit`.
 */
async function walkQbitCombinedConfirmedTxs(
  route: QbitAddressHistoryPageClient,
  address: string,
  afterTxid: string | undefined,
  maxPages: number
): Promise<EsploraTx[]> {
  const after = afterTxid?.toLowerCase()
  const staleCursor = () =>
    new QbitApiError(
      'invalid_cursor',
      `mempool-qbit address history cursor is stale or not confirmed: ${afterTxid} (${address})`
    )
  const confirmed: EsploraTx[] = []
  const seen = new Set<string>()
  let continued = after === undefined
  let cursor: QbitHistoryWalkCursor = {}
  for (let pages = 0; confirmed.length < MEMPOOL_QBIT_ADDRESS_TXS_ROWS; pages += 1) {
    if (pages >= maxPages) {
      throw new QbitApiError(
        'pagination_limit',
        `mempool-qbit address history exceeded ${maxPages} pages: ${address}`
      )
    }
    const page = await readQbitHistoryWalkPage(route, address, cursor)
    if (page.ended) break
    page.rows.forEach((tx, index) => {
      const txid = page.txids[index]!
      if (!continued) {
        if (tx.status.confirmed) seen.add(txid)
        if (txid !== after) return
        if (!tx.status.confirmed) throw staleCursor()
        continued = true
        return
      }
      if (!tx.status.confirmed || seen.has(txid)) return
      seen.add(txid)
      confirmed.push(tx)
    })
    // The empty page the walk steps back over has no rows and is not the last.
    if (page.rows.length > 0 && page.size < MEMPOOL_QBIT_MIN_PAGE_ROWS) break
    cursor = page.next
  }
  if (!continued) throw staleCursor()
  return confirmed.slice(0, MEMPOOL_QBIT_ADDRESS_TXS_ROWS)
}

/**
 * A newest-first walk of one address's history that can stop after any page
 * and continue later from `afterTxid`. It changes only once a page has been
 * read and checked whole, so a failed page leaves it where it was.
 *
 * Candidates are a subset to spend from, never a balance. A spend comes no
 * earlier in the walk than the output it spends, except within one block,
 * so the walk drops most spent outputs itself. An output can still be spent
 * by a row the walk has not reached, or after it was read, so only
 * `findQbitSpentOutpoints` clears one for spending.
 */
export interface QbitAddressOutputScan extends QbitHistoryWalkCursor {
  readonly address: string
  /** The empty page that ends the history has been read. */
  exhausted: boolean
  pagesRead: number
  /** By `txid:vout`, lowercase txid. */
  candidates: Map<string, QbitHistoryOutputCandidate>
  /** Outpoints walked transactions spend, as `txid:vout`. */
  spent: Set<string>
}

export function createQbitAddressOutputScan(address: string): QbitAddressOutputScan {
  return { address, exhausted: false, pagesRead: 0, candidates: new Map(), spent: new Set() }
}

/**
 * Read up to `maxPages` more pages of `scan`, stopping early once `enough`
 * holds or the history ends, and return how many were read. A malformed
 * page, or one that repeats its cursor, throws before anything changes. An
 * empty page after a mempool row steps the walk back one row rather than
 * ending it, and counts as a page read (see `readQbitHistoryWalkPage`).
 */
export async function continueQbitAddressOutputScan(
  client: QbitAddressHistoryPageClient,
  scan: QbitAddressOutputScan,
  options: { maxPages: number; enough?: (scan: QbitAddressOutputScan) => boolean }
): Promise<number> {
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1) {
    throw new Error('maxPages must be a positive integer')
  }
  let read = 0
  while (read < options.maxPages && !scan.exhausted && !options.enough?.(scan)) {
    const { rows, txids, next, ended } = await readQbitHistoryWalkPage(client, scan.address, scan)
    read += 1
    scan.pagesRead += 1
    scan.afterTxid = next.afterTxid
    scan.beforeMempoolCursor = next.beforeMempoolCursor
    scan.overlapTxid = next.overlapTxid
    if (ended) {
      scan.exhausted = true
      break
    }
    rows.forEach((tx, index) => {
      for (const input of tx.vin) {
        if (input.is_coinbase) continue
        // A row may omit prevouts; an unknown one counts as this address's.
        if (input.prevout && !qbitOutputPaysAddress(input.prevout, scan.address)) continue
        const outpoint = `${input.txid.toLowerCase()}:${input.vout}`
        scan.spent.add(outpoint)
        scan.candidates.delete(outpoint)
      }
      if (!tx.status.confirmed) return
      const coinbase = tx.vin.some(input => input.is_coinbase)
      tx.vout.forEach((output, vout) => {
        if (
          !qbitOutputPaysAddress(output, scan.address) ||
          !QBIT_P2MR_SCRIPT_PATTERN.test(output.scriptpubkey)
        ) {
          return
        }
        const outpoint = `${txids[index]}:${vout}`
        if (scan.spent.has(outpoint)) return
        scan.candidates.set(outpoint, {
          txid: txids[index]!,
          vout,
          value: output.value,
          scriptPk: output.scriptpubkey,
          outputCount: tx.vout.length,
          blockHeight: tx.status.block_height!,
          coinbase,
        })
      })
    })
  }
  return read
}

const QBIT_OUTSPENDS_CONCURRENCY = 8

/**
 * The outpoints of `outputs` that a transaction spends, as `txid:vout` with
 * a lowercase txid, from one `getQbitTxSpenders` answer per funding
 * transaction, at most eight at a time. A failed or malformed answer throws,
 * so an output is only ever reported unspent on the explorer's explicit word.
 */
export async function findQbitSpentOutpoints(
  client: QbitTxOutspendsClient,
  outputs: readonly { txid: string; vout: number; outputCount: number }[]
): Promise<Set<string>> {
  const byTxid = new Map<string, { outputCount: number; vouts: number[] }>()
  for (const output of outputs) {
    const txid = normalizeQbitTxid(output.txid)
    if (
      !Number.isSafeInteger(output.outputCount) ||
      !Number.isSafeInteger(output.vout) ||
      output.vout < 0 ||
      output.vout >= output.outputCount
    ) {
      throw new Error(`invalid qbit outpoint ${txid}:${output.vout}`)
    }
    const entry = byTxid.get(txid) ?? { outputCount: output.outputCount, vouts: [] }
    if (entry.outputCount !== output.outputCount) {
      throw new Error(`inconsistent output count for qbit transaction ${txid}`)
    }
    entry.vouts.push(output.vout)
    byTxid.set(txid, entry)
  }
  const entries = [...byTxid]
  const spenders = await mapQbitWithConcurrency(
    entries,
    QBIT_OUTSPENDS_CONCURRENCY,
    ([txid, entry]) => getQbitTxSpenders(client, txid, entry.outputCount)
  )
  const spent = new Set<string>()
  entries.forEach(([txid, entry], index) => {
    for (const vout of entry.vouts) {
      if (spenders[index]![vout] !== undefined) spent.add(`${txid}:${vout}`)
    }
  })
  return spent
}

/**
 * The txid spending each output of `txid`, which has `outputCount` outputs,
 * or undefined for an output nothing spends. Anything other than one
 * well-formed entry per output throws, so a short or malformed answer is
 * never read as unspent.
 */
export async function getQbitTxSpenders(
  client: QbitTxOutspendsClient,
  txid: string,
  outputCount: number
): Promise<(string | undefined)[]> {
  const normalizedTxid = normalizeQbitTxid(txid)
  if (!Number.isSafeInteger(outputCount) || outputCount < 1) {
    throw new Error('invalid qbit transaction output count')
  }
  const outspends = await client.getTxOutspends(normalizedTxid)
  if (!Array.isArray(outspends) || outspends.length !== outputCount) {
    throw new Error(`invalid qbit outspends for ${normalizedTxid}`)
  }
  return outspends.map(outspend => {
    if (!outspend || typeof outspend.spent !== 'boolean') {
      throw new Error(`invalid qbit outspends for ${normalizedTxid}`)
    }
    if (!outspend.spent) return undefined
    if (
      typeof outspend.txid !== 'string' ||
      !QBIT_TXID_PATTERN.test(outspend.txid) ||
      outspend.txid.toLowerCase() === normalizedTxid
    ) {
      throw new Error(`invalid qbit outspends for ${normalizedTxid}`)
    }
    return outspend.txid.toLowerCase()
  })
}

export interface QbitProtectedAssetOutpoint {
  txid: string
  vout: number
}

export interface QbitProtectedAssetCoverage {
  /** Total protected assets found across the requested outpoints. */
  assetCount: number
  /** Lowercase `txid:vout` keys of outpoints carrying at least one asset. */
  protectedOutpoints: ReadonlySet<string>
}

/**
 * Classify protected-asset coverage for the requested outpoints from
 * authoritative chain data.
 *
 * qbit defines no protected-asset layer today: consensus restricts every
 * value-bearing output to a plain P2MR script (restricted-output mode), and
 * no configured explorer surface indexes a secondary asset protocol —
 * electrs-qbit compiles its asset routes out, mempool-qbit serves chain and
 * fee data only, and `@qbit-oss/api` deliberately carries no asset endpoints. The
 * former centralized `/v5/utxo/assets-by-outpoints` route does not exist on
 * any of them.
 *
 * An outpoint is therefore classified asset-free only after it is
 * affirmatively verified against its funding transaction as a well-formed,
 * plain P2MR value output. Everything else fails closed: an unavailable
 * explorer, a missing transaction or output index, a mismatched transaction
 * id, a duplicated request, or an output script this wallet cannot fully
 * characterize (reserved future witness versions included) throws instead of
 * classifying, so unknown outputs are never silently treated as asset-free.
 */
export async function classifyQbitProtectedAssetCoverage(
  client: Pick<QbitEsploraClient, 'getTx'>,
  outpoints: readonly QbitProtectedAssetOutpoint[]
): Promise<QbitProtectedAssetCoverage> {
  if (outpoints.length === 0) return { assetCount: 0, protectedOutpoints: new Set() }

  const requested = new Map<string, QbitProtectedAssetOutpoint>()
  for (const outpoint of outpoints) {
    if (
      !outpoint ||
      typeof outpoint.txid !== 'string' ||
      !QBIT_TXID_PATTERN.test(outpoint.txid) ||
      !Number.isSafeInteger(outpoint.vout) ||
      outpoint.vout < 0 ||
      outpoint.vout > MAX_OUTPUT_INDEX
    ) {
      throw new Error('Qbit protected-asset lookup received an invalid outpoint')
    }
    const txid = outpoint.txid.toLowerCase()
    const key = `${txid}:${outpoint.vout}`
    if (requested.has(key)) {
      throw new Error('Qbit protected-asset lookup contains duplicate outpoints')
    }
    requested.set(key, { txid, vout: outpoint.vout })
  }

  const fundingTxids = [...new Set([...requested.values()].map(outpoint => outpoint.txid))]
  const fundingTxs = new Map(
    await mapQbitWithConcurrency(
      fundingTxids,
      QBIT_PROTECTED_ASSET_LOOKUP_CONCURRENCY,
      async txid => {
        const tx = await client.getTx(txid)
        if (
          !tx ||
          typeof tx.txid !== 'string' ||
          tx.txid.toLowerCase() !== txid ||
          !Array.isArray(tx.vout)
        ) {
          throw new Error(
            `Qbit protected-asset lookup returned an invalid transaction for ${txid}`
          )
        }
        return [txid, tx] as const
      }
    )
  )

  let classified = 0
  for (const [key, outpoint] of requested) {
    const output = fundingTxs.get(outpoint.txid)?.vout[outpoint.vout]
    if (!output) {
      throw new Error(`Qbit protected-asset lookup could not resolve outpoint ${key}`)
    }
    if (!Number.isSafeInteger(output.value) || output.value < 0) {
      throw new Error(`Qbit protected-asset lookup returned an invalid output value for ${key}`)
    }
    if (
      typeof output.scriptpubkey !== 'string' ||
      !QBIT_P2MR_SCRIPT_PATTERN.test(output.scriptpubkey)
    ) {
      throw new Error(`Qbit protected-asset coverage cannot classify the non-P2MR output at ${key}`)
    }
    classified += 1
  }
  if (classified !== requested.size) {
    throw new Error('Qbit protected-asset lookup omitted a requested outpoint')
  }

  // Every requested outpoint is now proven to be a plain P2MR value output;
  // no qbit asset protocol exists that could attach a protected asset to one.
  return { assetCount: 0, protectedOutpoints: new Set() }
}

async function qbitUtxoToWalletUtxo(
  getFundingTx: (txid: string) => Promise<EsploraTx>,
  utxo: EsploraUtxo,
  getTipHeight: () => Promise<number>,
  getAncestor: (txid: string) => Promise<EsploraTx | undefined>
): Promise<
  | {
      utxo: UTXO
      confirmed: boolean
      immature: boolean
      ownAncestry: Map<string, number> | undefined
    }
  | undefined
> {
  const tx = await getFundingTx(utxo.txid)
  if (
    !tx ||
    !QBIT_TXID_PATTERN.test(tx.txid) ||
    tx.txid.toLowerCase() !== utxo.txid.toLowerCase()
  ) {
    throw new Error(`qbit UTXO transaction id mismatch for ${utxo.txid}:${utxo.vout}`)
  }
  if (
    !Array.isArray(tx.vin) ||
    !tx.vin.every(input => input && typeof input.is_coinbase === 'boolean') ||
    !Array.isArray(tx.vout)
  ) {
    throw new Error(`invalid qbit transaction detail for ${utxo.txid}`)
  }

  const output = tx.vout[utxo.vout]
  if (!output) {
    throw new Error(`qbit UTXO missing output ${utxo.txid}:${utxo.vout}`)
  }
  if (!Number.isSafeInteger(output.value) || output.value < 0 || output.value !== utxo.value) {
    throw new Error(`qbit UTXO output value mismatch for ${utxo.txid}:${utxo.vout}`)
  }
  if (
    typeof output.scriptpubkey !== 'string' ||
    !QBIT_P2MR_SCRIPT_PATTERN.test(output.scriptpubkey)
  ) {
    throw new Error(`qbit UTXO has invalid P2MR output script for ${utxo.txid}:${utxo.vout}`)
  }

  const isCoinbase = tx.vin.some(input => input.is_coinbase)
  let immature = false
  if (isCoinbase) {
    const blockHeight = utxo.status.block_height
    if (!utxo.status.confirmed || blockHeight === undefined) {
      return undefined
    }

    // Spendable at confirmations >= maturity: the exact height where a spend
    // becomes mempool-acceptable (mined at tip+1). qbit Core's own wallet
    // waits one extra block to survive a 1-block reorg; we offer the output
    // at the earliest consensus-valid tip, and a reorged spend stays
    // rebroadcastable from the same signed bytes.
    const tipHeight = await getTipHeight()
    if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
      throw new Error('invalid qbit tip height')
    }
    immature = !isQbitCoinbaseMature(blockHeight, tipHeight)
  }

  const ownAncestry =
    !utxo.status.confirmed && !isCoinbase
      ? await qbitOwnUnconfirmedAncestry(tx, output.scriptpubkey, getAncestor)
      : undefined

  return {
    confirmed: utxo.status.confirmed,
    immature,
    ownAncestry,
    utxo: {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.value,
      scriptPk: output.scriptpubkey,
      addressType: AddressType.P2MR,
    },
  }
}

/** Whether a coinbase output confirmed at `blockHeight` is spendable with the chain at `tipHeight`. */
export function isQbitCoinbaseMature(blockHeight: number, tipHeight: number): boolean {
  return tipHeight - blockHeight + 1 >= QBIT_COINBASE_MATURITY
}

/**
 * The unconfirmed transactions behind an output of the unconfirmed `tx`,
 * `tx` included, each with its vsize, when it is change of `scriptPubKey` all
 * the way down: each input spends an output of that same script from a
 * transaction that is confirmed or, in turn, such change. Only then can no
 * one but this wallet replace `tx` or an ancestor, which would evict a send
 * built on the output. Undefined otherwise, when the explorer does not size
 * one of them, or when a send spending the output would exceed qbit Core's
 * ancestor limit.
 */
async function qbitOwnUnconfirmedAncestry(
  tx: EsploraTx,
  scriptPubKey: string,
  getAncestor: (txid: string) => Promise<EsploraTx | undefined>
): Promise<Map<string, number> | undefined> {
  const script = scriptPubKey.toLowerCase()
  const vsize = qbitTxVsize(tx)
  if (vsize === undefined) return undefined
  const unconfirmed = new Map([[tx.txid.toLowerCase(), vsize]])
  const pending = [tx]
  for (let current = pending.pop(); current; current = pending.pop()) {
    if (current.vin.length === 0) return undefined
    for (const input of current.vin) {
      if (
        input.is_coinbase ||
        typeof input.prevout?.scriptpubkey !== 'string' ||
        input.prevout.scriptpubkey.toLowerCase() !== script ||
        typeof input.txid !== 'string' ||
        !QBIT_TXID_PATTERN.test(input.txid)
      ) {
        return undefined
      }
      const parentTxid = input.txid.toLowerCase()
      if (unconfirmed.has(parentTxid)) continue
      const parent = await getAncestor(parentTxid)
      if (!parent) return undefined
      if (parent.status.confirmed) continue
      const parentVsize = qbitTxVsize(parent)
      if (parentVsize === undefined) return undefined
      unconfirmed.set(parentTxid, parentVsize)
      if (unconfirmed.size >= QBIT_MEMPOOL_ANCESTOR_LIMIT) return undefined
      pending.push(parent)
    }
  }
  return unconfirmed
}

/**
 * A transaction's vsize as qbit Core counts it against the ancestor size
 * limit: its serialized size, since `WITNESS_SCALE_FACTOR = 1` makes weight
 * and vsize equal to it. The explorer's `weight` is not read, as an indexer
 * computing it with a scale factor of 4 would overstate it. Undefined
 * unless the size is a positive integer.
 */
function qbitTxVsize(tx: EsploraTx): number | undefined {
  return Number.isSafeInteger(tx.size) && tx.size > 0 ? tx.size : undefined
}

/**
 * An ancestor of an unconfirmed output, or undefined when the explorer cannot
 * produce it in a shape the ownership walk can read. The output then counts
 * as someone else's for this read: it is left out of what a send may select,
 * and the confirmed outputs stay readable.
 */
async function getQbitAncestorTx(
  client: Pick<QbitEsploraClient, 'getTx'>,
  txid: string
): Promise<EsploraTx | undefined> {
  let tx: EsploraTx
  try {
    tx = await client.getTx(txid)
  } catch {
    return undefined
  }
  if (
    !tx ||
    typeof tx.txid !== 'string' ||
    tx.txid.toLowerCase() !== txid ||
    !Array.isArray(tx.vin) ||
    !tx.vin.every(input => input && typeof input.is_coinbase === 'boolean') ||
    typeof tx.status?.confirmed !== 'boolean'
  ) {
    return undefined
  }
  return tx
}

function assertValidQbitUtxo(utxo: EsploraUtxo, index: number): void {
  const status = utxo?.status
  if (
    !utxo ||
    !QBIT_TXID_PATTERN.test(utxo.txid) ||
    !Number.isSafeInteger(utxo.vout) ||
    utxo.vout < 0 ||
    utxo.vout > MAX_OUTPUT_INDEX ||
    !Number.isSafeInteger(utxo.value) ||
    utxo.value < 0 ||
    !status ||
    typeof status.confirmed !== 'boolean' ||
    (status.confirmed &&
      (!Number.isSafeInteger(status.block_height) || (status.block_height ?? -1) < 0))
  ) {
    throw new Error(`invalid qbit UTXO at index ${index}`)
  }
}

export async function getQbitAddressHistory(
  client: QbitEsploraClient,
  address: string,
  params: { start: number; limit: number }
): Promise<{ start: number; total: number; detail: TxHistoryItem[] }> {
  const result = await getQbitAccountHistory(client, [address], params)
  return {
    start: result.start,
    total: result.total,
    detail: result.detail,
  }
}

export interface QbitAccountHistoryOptions extends QbitSnapshotStabilityRetryOptions {
  maxTransactions?: number
}

export interface QbitConfirmedHistoryAnchor {
  txid: string
  blockHeight: number
  blockHash: string
}

export interface QbitAccountHistoryRevision {
  /**
   * Opaque public-chain activity fingerprint. Tip identity is intentionally
   * separate so confirmations can advance without rebuilding membership.
   */
  activityFingerprint: string
  tipHeight: number
  tipHash: string
  hasConfirmedHistory: boolean
  /** Highest confirmed block represented by the complete account snapshot. */
  confirmedHistoryAnchor?: QbitConfirmedHistoryAnchor
}

export interface QbitAccountHistoryAncestryProbe {
  revision: QbitAccountHistoryRevision
  cachedConfirmedHistoryActive: boolean
  cachedMempoolMembershipActive: boolean
}

export interface QbitAccountHistoryResult {
  start: number
  total: number
  detail: TxHistoryItem[]
  revision: QbitAccountHistoryRevision
}

const MAX_QBIT_SNAPSHOT_RETRY_DELAY_MS = 30_000

/**
 * The snapshot moved while it was being read; a fresh read may succeed.
 * `minRetryDelayMs` lets a cause that needs settling time (a chain-tip
 * advance the address index may not have caught up with) hold the retry
 * back beyond the ordinary back-off.
 */
export class QbitHistorySnapshotUnstableError extends Error {
  readonly minRetryDelayMs: number
  /** The failure this one restates, when it adds a retry delay to it. */
  readonly cause?: unknown

  constructor(message: string, options: { minRetryDelayMs?: number; cause?: unknown } = {}) {
    super(message)
    this.name = 'QbitHistorySnapshotUnstableError'
    this.minRetryDelayMs = options.minRetryDelayMs ?? 0
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * True for failures that only mean the snapshot moved while it was being
 * read: an explicit instability, or Esplora pagination that shifted under a
 * multi-page history read (`invalid_cursor`). Every bounded stability retry
 * classifies with this so a churning address is retried the same way whether
 * it is loading account history or being observed for a floor scan. Once
 * those retries are spent, the history could not be read in full.
 */
export function isQbitSnapshotUnstableError(error: unknown): boolean {
  return (
    error instanceof QbitHistorySnapshotUnstableError ||
    (error instanceof QbitApiError && error.kind === 'invalid_cursor')
  )
}

function resolveQbitSnapshotStabilityRetries(options: QbitSnapshotStabilityRetryOptions): {
  stabilityRetries: number
  retryBaseDelayMs: number
} {
  const stabilityRetries = options.stabilityRetries ?? 0
  if (!Number.isSafeInteger(stabilityRetries) || stabilityRetries < 0 || stabilityRetries > 5) {
    throw new Error('stabilityRetries must be an integer between 0 and 5')
  }
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 0
  if (
    !Number.isSafeInteger(retryBaseDelayMs) ||
    retryBaseDelayMs < 0 ||
    retryBaseDelayMs > 10_000
  ) {
    throw new Error('retryBaseDelayMs must be an integer between 0 and 10000')
  }
  return { stabilityRetries, retryBaseDelayMs }
}

/**
 * Load a snapshot, retrying a bounded number of times with exponential
 * back-off when it fails only because the snapshot moved while being read.
 * An instability that names a minimum retry delay is never retried sooner
 * than that, whatever the back-off says.
 */
async function loadQbitSnapshotWithStabilityRetries<T>(
  retry: { stabilityRetries: number; retryBaseDelayMs: number },
  load: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load()
    } catch (error) {
      if (!isQbitSnapshotUnstableError(error) || attempt >= retry.stabilityRetries) {
        throw error
      }
      const minRetryDelayMs =
        error instanceof QbitHistorySnapshotUnstableError ? error.minRetryDelayMs : 0
      const delayMs = Math.min(
        Math.max(retry.retryBaseDelayMs * 2 ** attempt, minRetryDelayMs),
        MAX_QBIT_SNAPSHOT_RETRY_DELAY_MS
      )
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
}

function mapQbitHistoryAddressesWithConcurrency<T>(
  addresses: readonly string[],
  load: (address: string) => Promise<T>
): Promise<T[]> {
  return mapQbitWithConcurrency(addresses, QBIT_HISTORY_ADDRESS_REQUEST_CONCURRENCY, load)
}

/** `load` over `items`, at most `concurrency` at a time; the first failure stops it and throws. */
async function mapQbitWithConcurrency<I, T>(
  items: readonly I[],
  concurrency: number,
  load: (item: I) => Promise<T>
): Promise<T[]> {
  const results = new Array<T>(items.length)
  let nextIndex = 0
  let failed = false
  let firstError: unknown
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      try {
        results[index] = await load(items[index]!)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw firstError
  return results
}

/**
 * Read a bounded, stability-checked account revision without exhausting
 * address history. This intentionally fingerprints only public chain data.
 */
export async function probeQbitAccountHistoryRevision(
  client: QbitEsploraClient,
  addresses: readonly string[]
): Promise<QbitAccountHistoryRevision> {
  const accountAddresses = normalizeQbitAccountAddresses(addresses)
  if (accountAddresses.length > MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES) {
    throw new Error(
      `qbit account history revision probe exceeds the ${MAX_QBIT_HISTORY_REVISION_PROBE_ADDRESSES}-address limit`
    )
  }
  const tipHashBefore = await client.getTipHash()
  assertValidQbitTipHash(tipHashBefore)

  const tipHeight = await client.getTipHeight()
  const statsBefore = await mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
    client.getAddressStats(address)
  )
  const mempoolBefore = await mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
    client.getAddressMempoolTxs(address)
  )
  const recentConfirmedBefore = await mapQbitHistoryAddressesWithConcurrency(
    accountAddresses,
    address => client.getAddressTxs(address)
  )
  const revisionBefore = qbitAccountHistoryRevision(
    accountAddresses,
    statsBefore,
    mempoolBefore,
    recentConfirmedBefore,
    tipHeight,
    tipHashBefore,
    recentConfirmedBefore.flat()
  )

  const statsAfter = await mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
    client.getAddressStats(address)
  )
  const mempoolAfter = await mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
    client.getAddressMempoolTxs(address)
  )
  const recentConfirmedAfter = await mapQbitHistoryAddressesWithConcurrency(
    accountAddresses,
    address => client.getAddressTxs(address)
  )
  const tipHashAfter = await client.getTipHash()
  assertValidQbitTipHash(tipHashAfter)
  const revisionAfter = qbitAccountHistoryRevision(
    accountAddresses,
    statsAfter,
    mempoolAfter,
    recentConfirmedAfter,
    tipHeight,
    tipHashAfter,
    recentConfirmedAfter.flat()
  )

  if (
    tipHashAfter !== tipHashBefore ||
    revisionAfter.activityFingerprint !== revisionBefore.activityFingerprint
  ) {
    throw new QbitHistorySnapshotUnstableError(
      'qbit account history changed while probing its revision'
    )
  }
  return revisionAfter
}

/**
 * Check a cached account's confirmed-chain ancestry and stable mempool
 * membership. Confirmed-chain work is independent of account size; mempool
 * requests cover every address with bounded concurrency. An unchanged tip
 * proves the whole cached chain; otherwise one highest-block transaction
 * anchors every cached confirmed block below it.
 */
export async function probeQbitAccountHistoryAncestry(
  client: Pick<
    QbitEsploraClient,
    'getAddressMempoolTxs' | 'getTipHash' | 'getTipHeight' | 'getTxStatus'
  >,
  cached: QbitAccountHistoryRevision,
  addresses: readonly string[],
  cachedPendingTxids: readonly string[]
): Promise<QbitAccountHistoryAncestryProbe> {
  const accountAddresses = normalizeQbitAccountAddresses(addresses)
  const cachedMempoolSnapshot = qbitTxidSetSnapshot(cachedPendingTxids)
  const tipHashBefore = await client.getTipHash()
  assertValidQbitTipHash(tipHashBefore)
  const normalizedTipHash = tipHashBefore.toLowerCase()
  const tipHeight = await client.getTipHeight()
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new Error('invalid qbit tip height')
  }

  let cachedConfirmedHistoryActive =
    tipHeight === cached.tipHeight && normalizedTipHash === cached.tipHash
  const anchor = cached.confirmedHistoryAnchor
  if (!cachedConfirmedHistoryActive && anchor && tipHeight > cached.tipHeight) {
    try {
      const status = await client.getTxStatus(anchor.txid)
      cachedConfirmedHistoryActive = qbitConfirmedHistoryAnchorMatches(status, anchor)
    } catch (error) {
      if (!(error instanceof QbitApiError) || error.kind !== 'not_found') throw error
      cachedConfirmedHistoryActive = false
    }
  }

  let cachedMempoolMembershipActive = false
  if (cachedConfirmedHistoryActive) {
    const mempoolBefore = await mapQbitHistoryAddressesWithConcurrency(
      accountAddresses,
      address => client.getAddressMempoolTxs(address)
    )
    const mempoolSnapshotBefore = qbitAccountMempoolSnapshot(accountAddresses, mempoolBefore)
    const mempoolAfter = await mapQbitHistoryAddressesWithConcurrency(
      accountAddresses,
      address => client.getAddressMempoolTxs(address)
    )
    const mempoolSnapshotAfter = qbitAccountMempoolSnapshot(accountAddresses, mempoolAfter)
    cachedMempoolMembershipActive =
      mempoolSnapshotAfter === mempoolSnapshotBefore &&
      mempoolSnapshotAfter === cachedMempoolSnapshot
  }
  const tipHashAfter = await client.getTipHash()
  assertValidQbitTipHash(tipHashAfter)
  if (tipHashAfter.toLowerCase() !== normalizedTipHash) {
    throw new QbitHistorySnapshotUnstableError(
      'qbit chain tip changed while probing account history ancestry'
    )
  }

  return {
    revision: {
      ...cached,
      tipHeight,
      tipHash: normalizedTipHash,
    },
    cachedConfirmedHistoryActive,
    cachedMempoolMembershipActive,
  }
}

function qbitConfirmedHistoryAnchorMatches(
  status: EsploraTxStatus,
  anchor: QbitConfirmedHistoryAnchor
): boolean {
  if (!status || typeof status.confirmed !== 'boolean') {
    throw new Error('invalid qbit confirmed history anchor status')
  }
  if (!status.confirmed) return false
  if (
    !Number.isSafeInteger(status.block_height) ||
    status.block_height !== anchor.blockHeight ||
    typeof status.block_hash !== 'string'
  ) {
    return false
  }
  assertValidQbitTipHash(status.block_hash)
  return status.block_hash.toLowerCase() === anchor.blockHash
}

/**
 * Build one complete, stability-checked account snapshot before applying an
 * offset. The caller can retain this result as an immutable pagination source.
 */
export async function getQbitAccountHistory(
  client: QbitEsploraClient,
  addresses: readonly string[],
  params: { start: number; limit: number },
  options: QbitAccountHistoryOptions = {}
): Promise<QbitAccountHistoryResult> {
  const start = assertHistoryPageValue(params.start, 'start', true)
  const limit = assertHistoryPageValue(params.limit, 'limit', true)
  const maxTransactions = options.maxTransactions ?? DEFAULT_MAX_ACCOUNT_HISTORY_TRANSACTIONS
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1) {
    throw new Error('maxTransactions must be a positive integer')
  }
  const maxRawHistoryRows =
    maxTransactions > Number.MAX_SAFE_INTEGER / QBIT_ACCOUNT_HISTORY_RAW_ROW_MULTIPLIER
      ? Number.MAX_SAFE_INTEGER
      : maxTransactions * QBIT_ACCOUNT_HISTORY_RAW_ROW_MULTIPLIER
  const retry = resolveQbitSnapshotStabilityRetries(options)

  const accountAddresses = normalizeQbitAccountAddresses(addresses)
  return loadQbitSnapshotWithStabilityRetries(retry, () =>
    loadQbitAccountHistorySnapshot(
      client,
      accountAddresses,
      start,
      limit,
      maxTransactions,
      maxRawHistoryRows
    )
  )
}

async function loadQbitAccountHistorySnapshot(
  client: QbitEsploraClient,
  accountAddresses: readonly string[],
  start: number,
  limit: number,
  maxTransactions: number,
  maxRawHistoryRows: number
): Promise<QbitAccountHistoryResult> {
  const [tipHashBefore, tipHeight, statsBefore] = await Promise.all([
    client.getTipHash(),
    client.getTipHeight(),
    mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
      client.getAddressStats(address)
    ),
  ])
  assertValidQbitTipHash(tipHashBefore)
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new Error('invalid qbit tip height')
  }
  let reportedRawHistoryRows = 0
  statsBefore.forEach((stats, index) => {
    const address = accountAddresses[index]!
    assertValidQbitStats(stats, address)
    const chainTransactionCount = stats.chain_stats.tx_count
    const mempoolTransactionCount = stats.mempool_stats.tx_count
    if (
      chainTransactionCount > maxTransactions ||
      mempoolTransactionCount > maxTransactions - chainTransactionCount
    ) {
      throw new Error(
        `qbit address history exceeds the ${maxTransactions}-transaction limit for ${address}`
      )
    }
    const reportedTransactionCount = chainTransactionCount + mempoolTransactionCount
    if (reportedTransactionCount > maxRawHistoryRows - reportedRawHistoryRows) {
      throw new Error(`qbit account history exceeds the aggregate ${maxRawHistoryRows}-row limit`)
    }
    reportedRawHistoryRows += reportedTransactionCount
  })

  let loadedRawHistoryRows = 0
  const histories = await mapQbitHistoryAddressesWithConcurrency(
    accountAddresses,
    async address => {
      const history = await client.getAddressHistory(address, {
        maxPages: DEFAULT_MAX_COUNTER_HISTORY_PAGES * QBIT_ADDRESS_HISTORY_READS,
        maxTransactions: DEFAULT_MAX_COUNTER_HISTORY_TRANSACTIONS * QBIT_ADDRESS_HISTORY_READS,
      })
      const rawTransactionCount =
        (Array.isArray(history?.confirmed) ? history.confirmed.length : 0) +
        (Array.isArray(history?.mempool) ? history.mempool.length : 0)
      if (rawTransactionCount > maxTransactions) {
        throw new Error(
          `qbit address history exceeds the ${maxTransactions}-transaction limit for ${address}`
        )
      }
      if (rawTransactionCount > maxRawHistoryRows - loadedRawHistoryRows) {
        throw new Error(`qbit account history exceeds the aggregate ${maxRawHistoryRows}-row limit`)
      }
      loadedRawHistoryRows += rawTransactionCount
      return history
    }
  )

  const [tipHashAfter, statsAfter, mempoolTxsAfter, recentConfirmedAfter] = await Promise.all([
    client.getTipHash(),
    mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
      client.getAddressStats(address)
    ),
    mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
      client.getAddressMempoolTxs(address)
    ),
    mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
      client.getAddressTxs(address)
    ),
  ])
  assertValidQbitTipHash(tipHashAfter)
  statsAfter.forEach((stats, index) => assertValidQbitStats(stats, accountAddresses[index]!))
  const mempoolSnapshotsAfter = mempoolTxsAfter.map((txs, index) =>
    qbitMempoolSnapshot(txs, accountAddresses[index]!)
  )
  if (tipHashAfter !== tipHashBefore) {
    throw new QbitHistorySnapshotUnstableError('qbit account history changed while scanning')
  }
  statsBefore.forEach((stats, index) => {
    if (qbitStatsSnapshot(statsAfter[index]!) !== qbitStatsSnapshot(stats)) {
      throw new QbitHistorySnapshotUnstableError(
        `qbit address history changed while scanning ${accountAddresses[index]}`
      )
    }
  })
  const validatedHistories = histories.map((history, index) => {
    const address = accountAddresses[index]!
    return {
      transactions: assertCompleteQbitAddressHistory(history, statsBefore[index]!, address),
      mempoolSnapshot: qbitMempoolSnapshot(history.mempool, address),
    }
  })
  validatedHistories.forEach((history, index) => {
    if (mempoolSnapshotsAfter[index] !== history.mempoolSnapshot) {
      throw new QbitHistorySnapshotUnstableError(
        `qbit address history changed while scanning ${accountAddresses[index]}`
      )
    }
  })
  recentConfirmedAfter.forEach((recent, index) => {
    const address = accountAddresses[index]!
    const recentSnapshot = qbitRecentConfirmedSnapshot(recent, statsBefore[index]!, address)
    const historySnapshot = qbitRecentConfirmedSnapshot(
      histories[index]!.confirmed.slice(0, recent.length),
      statsBefore[index]!,
      address
    )
    if (recentSnapshot !== historySnapshot) {
      throw new QbitHistorySnapshotUnstableError(
        `qbit recent confirmed history changed while scanning ${address}`
      )
    }
  })

  const addressTransactions = validatedHistories.flatMap((history, index) => {
    const address = accountAddresses[index]!
    return history.transactions.map(tx => ({
      address,
      tx,
    }))
  })
  const uniqueTransactionIds = new Set(addressTransactions.map(({ tx }) => tx.txid.toLowerCase()))
  if (uniqueTransactionIds.size > maxTransactions) {
    throw new Error(`qbit account history exceeds the ${maxTransactions}-transaction limit`)
  }
  const needsPrevoutHydration = addressTransactions.some(({ tx }) =>
    tx.vin.some(input => !input.is_coinbase && input.prevout === null)
  )
  const resolvedTransactions = await resolveQbitHistoryPrevouts(
    client,
    addressTransactions.map(item => item.tx)
  )
  if (needsPrevoutHydration) {
    const [tipHashAfterPrevouts, statsAfterPrevouts, mempoolTxsAfterPrevouts] = await Promise.all([
      client.getTipHash(),
      mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
        client.getAddressStats(address)
      ),
      mapQbitHistoryAddressesWithConcurrency(accountAddresses, address =>
        client.getAddressMempoolTxs(address)
      ),
    ])
    assertValidQbitTipHash(tipHashAfterPrevouts)
    statsAfterPrevouts.forEach((stats, index) =>
      assertValidQbitStats(stats, accountAddresses[index]!)
    )
    const mempoolSnapshotsAfterPrevouts = mempoolTxsAfterPrevouts.map((txs, index) =>
      qbitMempoolSnapshot(txs, accountAddresses[index]!)
    )
    if (tipHashAfterPrevouts !== tipHashBefore) {
      throw new QbitHistorySnapshotUnstableError(
        'qbit account history changed while resolving prevouts'
      )
    }
    statsBefore.forEach((stats, index) => {
      if (qbitStatsSnapshot(statsAfterPrevouts[index]!) !== qbitStatsSnapshot(stats)) {
        throw new QbitHistorySnapshotUnstableError(
          `qbit address history changed while resolving prevouts ${accountAddresses[index]}`
        )
      }
      if (mempoolSnapshotsAfterPrevouts[index] !== mempoolSnapshotsAfter[index]) {
        throw new QbitHistorySnapshotUnstableError(
          `qbit address history changed while resolving prevouts ${accountAddresses[index]}`
        )
      }
    })
  }

  const transactions = new Map<string, { fingerprint: string; tx: EsploraTx }>()
  resolvedTransactions.forEach((tx, index) => {
    const address = addressTransactions[index]!.address
    if (!qbitTransactionTouchesAddress(tx, address)) {
      throw new Error(`qbit history transaction ${tx.txid} does not touch ${address}`)
    }
    const txid = tx.txid.toLowerCase()
    const fingerprint = qbitTransactionFingerprint(tx)
    const previous = transactions.get(txid)
    if (previous && previous.fingerprint !== fingerprint) {
      throw new Error(`conflicting qbit history payloads for transaction ${txid}`)
    }
    if (!previous) transactions.set(txid, { fingerprint, tx })
  })

  const sortedTransactions = [...transactions.values()]
    .map(item => item.tx)
    .sort(compareQbitHistoryTransactions)
  const sorted = sortedTransactions.map(tx => qbitTxToHistoryItem(tx, accountAddresses, tipHeight))
  const revision = qbitAccountHistoryRevision(
    accountAddresses,
    statsBefore,
    mempoolTxsAfter,
    recentConfirmedAfter,
    tipHeight,
    tipHashAfter,
    sortedTransactions
  )
  return {
    start,
    total: sorted.length,
    detail: sorted.slice(start, start + limit),
    revision,
  }
}

async function resolveQbitHistoryPrevouts(
  client: Pick<QbitEsploraClient, 'getTx'>,
  transactions: readonly EsploraTx[]
): Promise<EsploraTx[]> {
  const parentTransactionIds = new Set<string>()
  // A shared transaction can appear once per owned address. Count an exact
  // child-input reference once, while keeping conflicting references distinct.
  const hydrationInputIdentities = new Set<string>()
  transactions.forEach(tx => {
    tx.vin.forEach((input, inputIndex) => {
      if (input.is_coinbase || input.prevout !== null) return
      hydrationInputIdentities.add(
        JSON.stringify([tx.txid.toLowerCase(), inputIndex, input.txid.toLowerCase(), input.vout])
      )
      if (hydrationInputIdentities.size > MAX_QBIT_HISTORY_PREVOUT_HYDRATIONS) {
        throw new Error(
          `qbit history exceeds the ${MAX_QBIT_HISTORY_PREVOUT_HYDRATIONS}-prevout hydration limit`
        )
      }
      parentTransactionIds.add(input.txid.toLowerCase())
    })
  })

  const parentTransactions = new Map<string, EsploraTx>()
  const normalizedParentTransactionIds = [...parentTransactionIds]
  for (
    let start = 0;
    start < normalizedParentTransactionIds.length;
    start += QBIT_HISTORY_PREVOUT_HYDRATION_CONCURRENCY
  ) {
    const batch = await Promise.all(
      normalizedParentTransactionIds
        .slice(start, start + QBIT_HISTORY_PREVOUT_HYDRATION_CONCURRENCY)
        .map(async normalizedTxid => {
          const transaction = await client.getTx(normalizedTxid)
          assertValidQbitHistoryTransaction(transaction)
          if (transaction.txid.toLowerCase() !== normalizedTxid) {
            throw new Error(`mismatched qbit prevout transaction ${normalizedTxid}`)
          }
          return [normalizedTxid, transaction] as const
        })
    )
    batch.forEach(([txid, transaction]) => parentTransactions.set(txid, transaction))
  }

  return transactions.map(tx => {
    const vin = tx.vin.map(input => {
      if (input.is_coinbase || input.prevout !== null) return input
      const normalizedTxid = input.txid.toLowerCase()
      const parent = parentTransactions.get(normalizedTxid)
      if (!parent) {
        throw new Error(`missing qbit prevout transaction ${normalizedTxid}`)
      }
      const prevout = parent.vout[input.vout]
      if (!prevout) {
        throw new Error(
          `missing output ${input.vout} in qbit prevout transaction ${normalizedTxid}`
        )
      }
      return { ...input, prevout }
    })
    return vin.every((input, index) => input === tx.vin[index]) ? tx : { ...tx, vin }
  })
}

export function qbitTxToHistoryItem(
  tx: EsploraTx,
  address: string | readonly string[],
  tipHeight: number
): TxHistoryItem {
  assertValidQbitHistoryTransaction(tx)
  const missingPrevoutIndex = tx.vin.findIndex(input => !input.is_coinbase && input.prevout === null)
  if (missingPrevoutIndex !== -1) {
    throw new Error(`missing prevout for input ${missingPrevoutIndex} of qbit transaction ${tx.txid}`)
  }
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new Error('invalid qbit tip height')
  }
  const ownedAddresses = new Set(
    normalizeQbitAccountAddresses(typeof address === 'string' ? [address] : address).map(
      normalizeQbitAddress
    )
  )
  const confirmations =
    tx.status.confirmed && tx.status.block_height !== undefined
      ? Math.max(1, tipHeight - tx.status.block_height + 1)
      : 0
  const timestamp = tx.status.block_time ?? 0
  const outputValue = safeQbitValueSum(
    tx.vout.map(output => output.value),
    `transaction ${tx.txid} output total`
  )
  const vin = tx.vin.map((input, index) => {
    const prevout = input.prevout ?? undefined
    const inputAddress = prevout?.scriptpubkey_address
    const owned = Boolean(inputAddress && ownedAddresses.has(normalizeQbitAddress(inputAddress)))
    return {
      index,
      ...(inputAddress ? { address: inputAddress } : {}),
      ...(prevout ? { value: prevout.value } : {}),
      ...(prevout?.scriptpubkey ? { scriptPubKey: prevout.scriptpubkey } : {}),
      ...(prevout?.scriptpubkey_type ? { scriptType: prevout.scriptpubkey_type } : {}),
      owned,
      coinbase: input.is_coinbase,
      ...(!input.is_coinbase ? { prevTxid: input.txid.toLowerCase(), prevVout: input.vout } : {}),
      prevoutMissing: !input.is_coinbase && !prevout,
    }
  })
  const baseVout = tx.vout.map((output, index) => {
    const outputAddress = output.scriptpubkey_address
    return {
      index,
      ...(outputAddress ? { address: outputAddress } : {}),
      value: output.value,
      scriptPubKey: output.scriptpubkey,
      scriptType: output.scriptpubkey_type,
      owned: Boolean(outputAddress && ownedAddresses.has(normalizeQbitAddress(outputAddress))),
    }
  })
  const ownedInputValue = safeQbitValueSum(
    vin.filter(input => input.owned).map(input => input.value ?? 0),
    `transaction ${tx.txid} owned input total`
  )
  const ownedOutputValue = safeQbitValueSum(
    baseVout.filter(output => output.owned).map(output => output.value),
    `transaction ${tx.txid} owned output total`
  )
  const externalOutputValue = safeQbitValueSum(
    baseVout.filter(output => !output.owned).map(output => output.value),
    `transaction ${tx.txid} external output total`
  )
  const relevantInputs = vin.filter(input => !input.coinbase)
  const hasOwnedInput = relevantInputs.some(input => input.owned)
  const hasExternalInput = relevantInputs.some(input => !input.owned)
  const mixedFunding = hasOwnedInput && hasExternalInput
  const hasNonOwnedOutput = baseVout.some(output => !output.owned)
  const netAmount = ownedOutputValue - ownedInputValue
  const direction = mixedFunding
    ? netAmount < 0
      ? ('send' as const)
      : ('receive' as const)
    : !hasOwnedInput && ownedOutputValue > 0
      ? ('receive' as const)
      : hasOwnedInput && !hasExternalInput && !hasNonOwnedOutput && ownedOutputValue > 0
        ? ('self' as const)
        : ('send' as const)
  const vout = baseVout.map(output => ({
    ...output,
    ...(output.owned && direction === 'self' ? { internal: true } : {}),
  }))
  const classifiedVin = vin.map(input => ({
    ...input,
    ...(input.owned && direction === 'self' ? { internal: true } : {}),
  }))
  const counterparties = uniqueQbitAddresses(
    mixedFunding
      ? [
          ...classifiedVin.filter(input => !input.owned).map(input => input.address),
          ...vout.filter(output => !output.owned).map(output => output.address),
        ]
      : direction === 'receive'
        ? classifiedVin.filter(input => !input.owned).map(input => input.address)
        : direction === 'send'
          ? vout.filter(output => !output.owned).map(output => output.address)
          : vout.filter(output => output.owned).map(output => output.address)
  )
  const amount = mixedFunding
    ? Math.abs(netAmount)
    : direction === 'receive'
      ? ownedOutputValue
      : direction === 'send'
        ? externalOutputValue
        : ownedOutputValue
  // BIP125: a tx signals replaceability while unconfirmed if any input's
  // sequence is below 0xfffffffe. A confirmed tx is never replaceable.
  const replaceable =
    !tx.status.confirmed &&
    tx.vin.some(input => typeof input.sequence === 'number' && input.sequence < 0xfffffffe)
  return {
    txid: tx.txid.toLowerCase(),
    confirmations,
    height: tx.status.block_height ?? 0,
    timestamp,
    size: tx.size,
    feeRate: tx.size > 0 ? tx.fee / tx.size : 0,
    fee: tx.fee,
    outputValue,
    vin: classifiedVin,
    vout,
    types: [],
    methods: [],
    direction,
    amount,
    netAmount,
    ownedInputValue,
    ownedOutputValue,
    counterparties,
    replaceable,
  }
}

export async function getQbitRawTransactionHex(
  client: Pick<QbitEsploraClient, 'getTxHex'>,
  txid: string
): Promise<string> {
  return (await getQbitRawTransaction(client, txid)).hex
}

/**
 * The raw transaction for `txid`, parsed, after its bytes are shown to hash
 * to that txid. The txid excludes witnesses, so this binds inputs, outputs,
 * version and locktime but not the signatures that authorize them.
 */
export async function getQbitRawTransaction(
  client: Pick<QbitEsploraClient, 'getTxHex'>,
  txid: string
): Promise<{ hex: string; transaction: transactionCore.Transaction }> {
  const normalizedTxid = normalizeQbitTxid(txid)
  const hex = await client.getTxHex(normalizedTxid)
  if (
    typeof hex !== 'string' ||
    hex.length === 0 ||
    hex.length > MAX_QBIT_RAW_TRANSACTION_HEX_LENGTH ||
    hex.length % 2 !== 0 ||
    !QBIT_HEX_PATTERN.test(hex)
  ) {
    throw new Error(`invalid raw qbit transaction hex for ${normalizedTxid}`)
  }
  let transaction: transactionCore.Transaction
  let rawTransactionTxid: string
  try {
    transaction = transactionCore.Transaction.fromHex(hex)
    rawTransactionTxid = transaction.getId()
  } catch {
    throw new Error(`invalid raw qbit transaction hex for ${normalizedTxid}`)
  }
  if (rawTransactionTxid !== normalizedTxid) {
    throw new Error(`raw qbit transaction txid mismatch for ${normalizedTxid}`)
  }
  return { hex, transaction }
}

export function normalizeQbitTxid(txid: string): string {
  if (typeof txid !== 'string' || !QBIT_TXID_PATTERN.test(txid)) {
    throw new Error('invalid qbit transaction id')
  }
  return txid.toLowerCase()
}

function assertHistoryPageValue(value: number, name: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return value
}

function normalizeQbitAccountAddresses(addresses: readonly string[]): string[] {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('qbit account history requires at least one address')
  }
  const unique = new Map<string, string>()
  for (const value of addresses) {
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
      throw new Error('qbit account history contains an invalid address')
    }
    const normalized = normalizeQbitAddress(value)
    if (unique.has(normalized)) {
      throw new Error(`qbit account history contains duplicate address ${value}`)
    }
    unique.set(normalized, value)
  }
  return [...unique.values()]
}

function normalizeQbitAddress(address: string): string {
  return address.toLowerCase()
}

function uniqueQbitAddresses(addresses: readonly (string | undefined)[]): string[] {
  const unique = new Map<string, string>()
  for (const address of addresses) {
    if (address) unique.set(normalizeQbitAddress(address), address)
  }
  return [...unique.values()]
}

function assertCompleteQbitAddressHistory(
  history: AddressHistory,
  stats: EsploraAddressStats,
  address: string
): EsploraTx[] {
  if (!history || !Array.isArray(history.confirmed) || !Array.isArray(history.mempool)) {
    throw new Error(`invalid qbit address history for ${address}`)
  }
  if (history.confirmed.length !== stats.chain_stats.tx_count) {
    throw new QbitHistorySnapshotUnstableError(`incomplete qbit confirmed history for ${address}`)
  }
  if (history.mempool.length !== stats.mempool_stats.tx_count) {
    throw new QbitHistorySnapshotUnstableError(`incomplete qbit mempool history for ${address}`)
  }
  const seen = new Set<string>()
  for (const [source, rows] of [
    ['confirmed', history.confirmed],
    ['mempool', history.mempool],
  ] as const) {
    for (const tx of rows) {
      assertValidQbitHistoryTransaction(tx)
      if ((source === 'confirmed') !== tx.status.confirmed) {
        throw new Error(`invalid ${source} qbit history status for ${tx.txid}`)
      }
      const txid = tx.txid.toLowerCase()
      if (seen.has(txid)) {
        throw new Error(`duplicate qbit transaction ${txid} for ${address}`)
      }
      seen.add(txid)
    }
  }
  return [...history.mempool, ...history.confirmed]
}

function assertValidQbitHistoryTransaction(tx: EsploraTx): void {
  if (
    !tx ||
    !QBIT_TXID_PATTERN.test(tx.txid) ||
    !Number.isSafeInteger(tx.version) ||
    !Number.isSafeInteger(tx.locktime) ||
    tx.locktime < 0 ||
    tx.locktime > MAX_OUTPUT_INDEX ||
    !Array.isArray(tx.vin) ||
    !Array.isArray(tx.vout) ||
    !Number.isSafeInteger(tx.size) ||
    tx.size <= 0 ||
    !Number.isSafeInteger(tx.weight) ||
    tx.weight <= 0 ||
    !Number.isSafeInteger(tx.fee) ||
    tx.fee < 0 ||
    !tx.status ||
    typeof tx.status.confirmed !== 'boolean'
  ) {
    throw new Error('invalid qbit history transaction')
  }
  if (
    tx.status.confirmed &&
    (!Number.isSafeInteger(tx.status.block_height) || (tx.status.block_height ?? -1) < 0)
  ) {
    throw new Error(`invalid confirmed qbit history status for ${tx.txid}`)
  }
  if (
    tx.status.block_time !== undefined &&
    (!Number.isSafeInteger(tx.status.block_time) || tx.status.block_time < 0)
  ) {
    throw new Error(`invalid qbit block time for ${tx.txid}`)
  }
  if (tx.status.block_hash !== undefined && !QBIT_TXID_PATTERN.test(tx.status.block_hash)) {
    throw new Error(`invalid qbit block hash for ${tx.txid}`)
  }
  tx.vin.forEach((input, index) => {
    if (
      !input ||
      !QBIT_TXID_PATTERN.test(input.txid) ||
      !Number.isSafeInteger(input.vout) ||
      input.vout < 0 ||
      input.vout > MAX_OUTPUT_INDEX ||
      typeof input.scriptsig !== 'string' ||
      !isEvenQbitHex(input.scriptsig) ||
      typeof input.scriptsig_asm !== 'string' ||
      typeof input.is_coinbase !== 'boolean' ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      input.sequence > MAX_OUTPUT_INDEX ||
      (input.witness !== undefined &&
        (!Array.isArray(input.witness) ||
          !input.witness.every(item => typeof item === 'string' && isEvenQbitHex(item))))
    ) {
      throw new Error(`invalid qbit history input ${index} for ${tx.txid}`)
    }
    if (input.prevout !== null) {
      assertValidQbitHistoryOutput(input.prevout, `input ${index} prevout`, tx.txid)
    }
  })
  tx.vout.forEach((output, index) =>
    assertValidQbitHistoryOutput(output, `output ${index}`, tx.txid)
  )
  safeQbitValueSum(
    tx.vout.map(output => output.value),
    `transaction ${tx.txid} output total`
  )
}

function assertValidQbitHistoryOutput(
  output: EsploraTx['vout'][number],
  label: string,
  txid: string
): void {
  if (
    !output ||
    typeof output.scriptpubkey !== 'string' ||
    !isEvenQbitHex(output.scriptpubkey) ||
    typeof output.scriptpubkey_asm !== 'string' ||
    typeof output.scriptpubkey_type !== 'string' ||
    (output.scriptpubkey_address !== undefined &&
      (typeof output.scriptpubkey_address !== 'string' ||
        output.scriptpubkey_address.length === 0)) ||
    !Number.isSafeInteger(output.value) ||
    output.value < 0
  ) {
    throw new Error(`invalid qbit history ${label} for ${txid}`)
  }
}

function isEvenQbitHex(value: string): boolean {
  return value.length % 2 === 0 && (value.length === 0 || QBIT_HEX_PATTERN.test(value))
}

function safeQbitValueSum(values: readonly number[], label: string): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
      throw new Error(`invalid ${label}`)
    }
    total += value
  }
  return total
}

function qbitOutputPaysAddress(output: EsploraTx['vout'][number], address: string): boolean {
  return (
    typeof output.scriptpubkey_address === 'string' &&
    normalizeQbitAddress(output.scriptpubkey_address) === normalizeQbitAddress(address)
  )
}

function qbitTransactionTouchesAddress(tx: EsploraTx, address: string): boolean {
  const normalizedAddress = normalizeQbitAddress(address)
  return (
    tx.vin.some(
      input =>
        input.prevout?.scriptpubkey_address &&
        normalizeQbitAddress(input.prevout.scriptpubkey_address) === normalizedAddress
    ) ||
    tx.vout.some(
      output =>
        output.scriptpubkey_address &&
        normalizeQbitAddress(output.scriptpubkey_address) === normalizedAddress
    )
  )
}

function qbitTransactionFingerprint(tx: EsploraTx): string {
  return JSON.stringify({
    txid: tx.txid.toLowerCase(),
    version: tx.version,
    locktime: tx.locktime,
    vin: tx.vin.map(input => ({
      txid: input.txid.toLowerCase(),
      vout: input.vout,
      prevout: input.prevout,
      scriptsig: input.scriptsig,
      scriptsig_asm: input.scriptsig_asm,
      witness: input.witness,
      is_coinbase: input.is_coinbase,
      sequence: input.sequence,
    })),
    vout: tx.vout,
    size: tx.size,
    weight: tx.weight,
    fee: tx.fee,
    status: tx.status,
  })
}

function compareQbitHistoryTransactions(left: EsploraTx, right: EsploraTx): number {
  if (left.status.confirmed !== right.status.confirmed) {
    return left.status.confirmed ? 1 : -1
  }
  const heightDelta = (right.status.block_height ?? 0) - (left.status.block_height ?? 0)
  if (heightDelta !== 0) return heightDelta
  const timeDelta = (right.status.block_time ?? 0) - (left.status.block_time ?? 0)
  if (timeDelta !== 0) return timeDelta
  return left.txid.toLowerCase().localeCompare(right.txid.toLowerCase())
}

export function qbitFeeSummaryFromTiers(
  tiers: unknown,
  apiSurface: QbitFeeSummaryApiSurface = 'esplora',
  options: QbitFeeSummaryOptions = {}
): FeeSummary {
  const normalized = normalizeQbitFeeTiers(tiers)
  if (!normalized.valid) {
    return qbitUnavailableFeeSummary(apiSurface, normalized.reason)
  }
  const targets = QBIT_FEE_TARGETS[apiSurface]
  const slowFeeRate = feeRateForTarget(normalized.tiers, targets.slow)
  const normalFeeRate = feeRateForTarget(normalized.tiers, targets.normal)
  const fastFeeRate = feeRateForTarget(normalized.tiers, targets.fast)
  if (slowFeeRate === undefined || normalFeeRate === undefined || fastFeeRate === undefined) {
    return qbitUnavailableFeeSummary(apiSurface, 'invalid')
  }
  const quote = {
    source: apiSurface,
    availability: 'available' as const,
    freshness: options.freshness ?? ('live' as const),
    ...(isValidFeeQuoteTime(options.fetchedAt) ? { fetchedAt: options.fetchedAt } : {}),
  }

  return {
    list: [
      {
        title: 'Slow',
        desc: qbitFeeTargetDescription(targets.slow),
        feeRate: slowFeeRate,
        targetBlocks: targets.slow,
      },
      {
        title: 'Normal',
        desc: qbitFeeTargetDescription(targets.normal),
        feeRate: normalFeeRate,
        targetBlocks: targets.normal,
      },
      {
        title: 'Fast',
        desc: qbitFeeTargetDescription(targets.fast),
        feeRate: fastFeeRate,
        targetBlocks: targets.fast,
      },
    ],
    quote,
  }
}

export function qbitUnavailableFeeSummary(
  apiSurface: QbitFeeSummaryApiSurface,
  fallbackReason: FeeQuoteFallbackReason
): FeeSummary {
  const targets = QBIT_FEE_TARGETS[apiSurface]
  return {
    list: [
      { title: 'Slow', targetBlocks: targets.slow },
      { title: 'Normal', targetBlocks: targets.normal },
      { title: 'Fast', targetBlocks: targets.fast },
    ].map(tier => ({
      ...tier,
      desc: qbitFeeTargetDescription(tier.targetBlocks),
      feeRate: QBIT_MIN_RELAY_FEE_RATE,
    })),
    quote: {
      source: apiSurface,
      availability: 'unavailable',
      freshness: 'fallback',
      fallbackReason,
    },
  }
}

type NormalizedQbitFeeTiers =
  | { valid: true; tiers: FeeRateTier[] }
  | { valid: false; reason: 'empty' | 'invalid' }

function normalizeQbitFeeTiers(tiers: unknown): NormalizedQbitFeeTiers {
  if (!Array.isArray(tiers)) {
    return { valid: false, reason: 'invalid' }
  }
  if (tiers.length === 0) {
    return { valid: false, reason: 'empty' }
  }

  const targets = new Set<number>()
  const normalized: FeeRateTier[] = []
  for (const value of tiers) {
    const tier = value as Partial<FeeRateTier> | null
    if (
      !tier ||
      !Number.isSafeInteger(tier.target) ||
      tier.target! < 1 ||
      tier.target! > MAX_ESPLORA_FEE_TARGET_BLOCKS ||
      !Number.isFinite(tier.feeRate) ||
      tier.feeRate! <= 0 ||
      tier.feeRate! > QBIT_MAX_FEE_RATE ||
      targets.has(tier.target!)
    ) {
      return { valid: false, reason: 'invalid' }
    }
    targets.add(tier.target!)
    normalized.push({
      target: tier.target!,
      feeRate: Math.max(QBIT_MIN_RELAY_FEE_RATE, tier.feeRate!),
    })
  }

  normalized.sort((a, b) => a.target - b.target)
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index - 1]!.feeRate < normalized[index]!.feeRate) {
      return { valid: false, reason: 'invalid' }
    }
  }
  return { valid: true, tiers: normalized }
}

function feeRateForTarget(tiers: FeeRateTier[], target: number): number | undefined {
  // A lower confirmation target is conservative for the requested window.
  return tiers.filter(tier => tier.target <= target).at(-1)?.feeRate
}

function qbitFeeTargetDescription(targetBlocks: number): string {
  const blockLabel = targetBlocks === 1 ? 'block' : 'blocks'
  return `~${targetBlocks} min (${targetBlocks} ${blockLabel})`
}

function isValidFeeQuoteTime(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! >= 0
}
