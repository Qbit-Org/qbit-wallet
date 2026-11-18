import {
  EsploraClient,
  MempoolQbitClient,
  QbitApiError,
  addressBalanceFromStats,
  feeEstimatesFromMempoolRecommendedFees,
  feeTiersFromEstimates,
} from '@qbit-oss/api'
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
  MempoolRecommendedFees,
  RequestOptions,
} from '@qbit-oss/api'
import { QBIT_COINBASE_MATURITY, addressToScriptPubKey, bytesToHex } from '@qbit-oss/protocol'
import { PQC_WARNING_SIGNATURE_THRESHOLD } from '@qbit/keyring-service'
import { transactionCore } from '@qbit/wallet-core'
import {
  QBIT_FALLBACK_FEE_RATE,
  QBIT_MAX_FEE_RATE,
  QBIT_MIN_RELAY_FEE_RATE,
  QBIT_P2MR_ZERO_DEPTH_CONTROL_BLOCK_BYTES,
  estimateQbitP2mrTransaction,
  isQbitAccountOutput,
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
import {
  QBIT_BALANCE_REUSE_MIN_OUTPUTS,
  QBIT_BALANCE_REUSE_TIP_WAIT_MS,
  type QbitBalanceReuseView,
  type QbitKeptListing,
  type QbitReusableBalance,
} from './qbit-balance-reuse'
import {
  QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS,
  QBIT_EXPLORER_FRESH_READ_PARAM,
  QBIT_EXPLORER_MAX_BODY_BYTES,
  createQbitExplorerFetch,
  isQbitExplorerLargeBodyRoute,
  qbitExplorerFreshReadPath,
  type QbitExplorerOperation,
} from './qbit-explorer-fetch'
import {
  QbitClassificationReads,
  QBIT_BALANCE_RIDE_OUT,
  QBIT_LISTING_RETRY_STATUSES,
  QBIT_SEND_SCREEN_RIDE_OUT,
  QBIT_STATS_RETRY_STATUSES,
  QBIT_TIP_RETRY_STATUSES,
  withQbitReadRetries,
  type QbitFundingFactsView,
  type QbitFundingOutputFacts,
  type QbitFundingTxReads,
  type QbitRideOutSchedule,
} from './qbit-funding-tx-reads'

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

export interface QbitTxOutspendsOptions extends RequestOptions {
  /**
   * Read past every cache: the request goes out on its own, under a URL no
   * other request has used and with `cache: 'no-store'`, never answered by
   * an earlier reply the browser or a cache in front of the explorer kept,
   * nor by an identical read already in flight. See
   * `QBIT_EXPLORER_FRESH_READ_PARAM`.
   */
  fresh?: boolean
}

export interface QbitTxOutspendsClient {
  getTxOutspends(txid: string, options?: QbitTxOutspendsOptions): Promise<QbitTxOutspend[]>
}

/**
 * One page of an address's history, newest first. `afterTxid`, the last row
 * of the previous page, continues the walk. An empty page ends it, except
 * after a mempool row on qbit-electrs (see `readQbitHistoryWalkPage`).
 */
export interface QbitAddressHistoryPageClient {
  getAddressHistoryPage(
    address: string,
    afterTxid?: string,
    options?: RequestOptions
  ): Promise<EsploraTx[]>
}

export type QbitWalletApiClient = EsploraClient &
  QbitTxOutspendsClient &
  QbitAddressHistoryPageClient

/**
 * The wallet's transport budgets for an explorer client (#353): headers and
 * body are timed separately, so a large history page on a slow link loads
 * while a dead connection still fails; see `qbit-explorer-fetch`. A given
 * `fetchFn` is wrapped, not replaced. With no base URL or no fetch at all,
 * the client's own constructor error stands. Its `maxResponseBytes`, by default
 * one that holds a full history page of the largest standard spends, is also
 * the limit the wrapper buffers a reply to.
 */
function withQbitExplorerBudgets<T extends EsploraClientOptions>(
  options: T,
  requests?: QbitAddressRequests
): T & { timeoutMs: number; maxResponseBytes: number } {
  const budgeted = {
    ...options,
    timeoutMs: options.timeoutMs ?? QBIT_EXPLORER_ATTEMPT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? QBIT_EXPLORER_MAX_BODY_BYTES,
  }
  if (typeof options.baseUrl !== 'string') return budgeted
  if (options.fetchFn === undefined && typeof globalThis.fetch !== 'function') return budgeted
  const fetchFn = createQbitExplorerFetch({
    fetchFn: options.fetchFn,
    baseUrl: options.baseUrl,
    maxBodyBytes: budgeted.maxResponseBytes,
  })
  return {
    ...budgeted,
    // Every attempt the client makes goes through it, its own retries included.
    fetchFn: requests
      ? (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          requests.noteSent(input)
          return fetchFn(input, init)
        }
      : fetchFn,
  }
}

/** The most addresses whose requests one client counts (`QbitAddressRequests`). */
const QBIT_STATS_SENT_ADDRESSES = 4_096
/** The statistics route of an address, `/address/:address`, its query aside. */
const QBIT_STATS_ROUTE = /\/address\/([^/?#]+)(?:[?#]|$)/
/** The output listing of an address, `/address/:address/utxo`, its query aside. */
const QBIT_LISTING_ROUTE = /\/address\/([^/?#]+)\/utxo(?:[?#]|$)/

/** What a wallet client counts of one address's requests (`QbitAddressRequests`). */
interface QbitAddressRequestCounts {
  /** Requests for its statistics sent, every attempt counted. */
  stats: number
  /** `stats` as its latest listing request went out, a fresh one aside. */
  statsAtListing: number
  /** Calls for its listing under way, fresh ones aside, which a listing asked for now joins. */
  listingCalls: number
}

/**
 * Where a balance read's statistics count from (`qbitStatsNewerThanListing`):
 * the statistics requests its address had had as its listing went out, and
 * the generation of the counts then.
 */
interface QbitStatsWindow {
  readonly generation: number
  readonly stats: number
}

/**
 * What a wallet client counts of each address's requests, by the address as
 * the path names it: its statistics requests (`/address/:address`), every
 * attempt counted as it goes out, the client's own retries included, which
 * caller soever sent them; that count as its latest listing request went
 * out; and the calls for its listing under way. So a balance read can tell
 * statistics that may be newer than the listing it classifies: one sent
 * after that listing went out, its own retry or another caller's request it
 * joined (`qbitStatsNewerThanListing`). Fresh requests, which no other call
 * joins, are counted neither as statistics nor as listings. Past
 * `QBIT_STATS_SENT_ADDRESSES` addresses the counts start again, under a new
 * generation, which a read under way takes for statistics newer than its
 * listing; an address with a call for its listing under way keeps its
 * counts.
 */
class QbitAddressRequests {
  private counts = new Map<string, QbitAddressRequestCounts>()
  private generation = 0

  noteSent(input: RequestInfo | URL): void {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const listed = QBIT_LISTING_ROUTE.exec(url)?.[1]
    if (listed !== undefined) {
      if (!url.includes(`${QBIT_EXPLORER_FRESH_READ_PARAM}=`)) {
        const counts = this.entry(listed)
        counts.statsAtListing = counts.stats
      }
      return
    }
    // A fresh request for the statistics joins no other call, so no read's
    // statistics can come from one another caller sent; a read's own are
    // fresh only with an answer to reuse, when it lists after them anyway.
    if (url.includes(`${QBIT_EXPLORER_FRESH_READ_PARAM}=`)) return
    const address = QBIT_STATS_ROUTE.exec(url)?.[1]
    if (address !== undefined) this.entry(address).stats += 1
  }

  /**
   * Note a call for the listing whose path names the address `segment`
   * begun, a fresh one aside; the function returned notes it ended.
   */
  listingCall(segment: string): () => void {
    // The entry itself, which a reset of the counts carries over while the
    // call is under way (`startAgain`), so the call's end is always noted.
    const counts = this.entry(segment)
    counts.listingCalls += 1
    let ended = false
    return (): void => {
      if (ended) return
      ended = true
      if (counts.listingCalls > 0) counts.listingCalls -= 1
    }
  }

  /**
   * Where the statistics of a read of `address` asking for its listing now
   * count from: the requests for them sent so far, or, should a call for its
   * listing already be under way, which the read's then joins, as many as
   * when that call's latest request went out. A `fresh` listing joins no
   * call, so it counts from the requests sent so far whatever is under way.
   */
  window(address: string, fresh = false): QbitStatsWindow {
    const counts = this.counts.get(encodeURIComponent(address))
    const stats =
      counts === undefined
        ? 0
        : counts.listingCalls > 0 && !fresh
          ? counts.statsAtListing
          : counts.stats
    return { generation: this.generation, stats }
  }

  /** Whether a request for `address`'s statistics went out since `window`, or the counts started again. */
  statsSince(address: string, window: QbitStatsWindow): boolean {
    if (window.generation !== this.generation) return true
    return (this.counts.get(encodeURIComponent(address))?.stats ?? 0) > window.stats
  }

  private entry(segment: string): QbitAddressRequestCounts {
    let counts = this.counts.get(segment)
    if (!counts) {
      if (this.counts.size >= QBIT_STATS_SENT_ADDRESSES) this.startAgain()
      counts = { stats: 0, statsAtListing: 0, listingCalls: 0 }
      this.counts.set(segment, counts)
    }
    return counts
  }

  /**
   * Start the counts again, under a new generation, but for the addresses
   * with a call for their listing under way: a read may still join that
   * call, and its window must count from when the call's request went out.
   */
  private startAgain(): void {
    const kept = new Map<string, QbitAddressRequestCounts>()
    for (const [segment, counts] of this.counts) {
      if (counts.listingCalls > 0) kept.set(segment, counts)
    }
    this.counts = kept
    this.generation += 1
  }
}

/** Each wallet client's count of its addresses' requests. */
const qbitAddressRequestsByClient = new WeakMap<object, QbitAddressRequests>()

/**
 * `read()`, the read of `path` by a wallet client: a call for an address's
 * listing, a fresh one aside, is noted while it is under way
 * (`QbitAddressRequests.listingCall`).
 */
function qbitNoteListingCall<T>(
  client: object,
  path: string,
  options: QbitTxOutspendsOptions | undefined,
  read: () => Promise<T>
): Promise<T> {
  const requests = qbitAddressRequestsByClient.get(client)
  const segment = options?.fresh === true ? undefined : QBIT_LISTING_ROUTE.exec(path)?.[1]
  if (requests === undefined || segment === undefined) return read()
  const ended = requests.listingCall(segment)
  const reading = read()
  reading.then(ended, ended)
  return reading
}

/**
 * What `EsploraClient.getJson` is handed for one read: a fresh one (see
 * `QbitTxOutspendsOptions.fresh`) under its own URL and on its own, any
 * other unchanged. `getJson` hands `request` only its signal, so freshness
 * travels in the path itself, request by request.
 */
function qbitJsonRead(
  path: string,
  options: QbitTxOutspendsOptions | undefined,
  dedup: boolean | undefined
): [string, RequestOptions | undefined, boolean | undefined] {
  if (options?.fresh !== true) return [path, options, dedup]
  const { fresh: _fresh, ...read } = options
  return [qbitExplorerFreshReadPath(path), read, false]
}

/**
 * A request's options with the ceiling of a large-body read (a history
 * page, a transaction or its hex): `ceilingMs`, the attempt budget, for all
 * its attempts together, within any deadline of the caller's. An attempt cut
 * off at that ceiling while bytes were still arriving is therefore never
 * tried again: the next would be no faster. Every other request keeps the
 * client's retries.
 */
function withQbitLargeReadCeiling(
  path: string,
  method: string,
  options: RequestOptions | undefined,
  ceilingMs: number
): RequestOptions | undefined {
  if (method.toUpperCase() !== 'GET' || !isQbitExplorerLargeBodyRoute(path)) return options
  return { ...options, deadlineMs: Math.min(options?.deadlineMs ?? ceilingMs, ceilingMs) }
}

/** What `EsploraClient.request` is handed besides the path. */
interface QbitClientRequestInit {
  method: string
  body?: string
  headers?: Record<string, string>
  dedup: boolean
}

// `@qbit-oss/api` has no route for a transaction's spenders. Both explorer
// surfaces serve Esplora's `/tx/:txid/outspends` under the endpoint's prefix,
// so the wallet's clients add it. Each also pages history one request at a
// time for walks that may stop early.
export class QbitWalletEsploraClient
  extends EsploraClient
  implements QbitTxOutspendsClient, QbitAddressHistoryPageClient
{
  private readonly largeReadCeilingMs: number

  constructor(options: EsploraClientOptions) {
    const requests = new QbitAddressRequests()
    const budgeted = withQbitExplorerBudgets(options, requests)
    super(budgeted)
    this.largeReadCeilingMs = budgeted.timeoutMs
    qbitAddressRequestsByClient.set(this, requests)
  }

  getTxOutspends(txid: string, options?: QbitTxOutspendsOptions): Promise<QbitTxOutspend[]> {
    return this.getJson<QbitTxOutspend[]>(`/tx/${encodeURIComponent(txid)}/outspends`, options)
  }

  // Confirmed rows only (`/txs/chain`, 25 a page); mempool rows are not paged.
  getAddressHistoryPage(
    address: string,
    afterTxid?: string,
    options?: RequestOptions
  ): Promise<EsploraTx[]> {
    return this.getAddressTxs(address, afterTxid, options)
  }

  // A fresh read (`QbitTxOutspendsOptions.fresh`) goes out under its own URL, on its own.
  protected override getJson<T>(
    path: string,
    options?: QbitTxOutspendsOptions,
    dedup?: boolean
  ): Promise<T> {
    return qbitNoteListingCall(this, path, options, () =>
      super.getJson<T>(...qbitJsonRead(path, options, dedup))
    )
  }

  protected override request(
    path: string,
    init: QbitClientRequestInit,
    options?: RequestOptions
  ): Promise<Response> {
    return super.request(
      path,
      init,
      withQbitLargeReadCeiling(path, init.method, options, this.largeReadCeilingMs)
    )
  }
}

/**
 * mempool-qbit's rates for its first three projected blocks, as
 * `/fees/recommended` gives them but not rounded to whole numbers, so they
 * go below 1 bit/vB, down to the node's relay floor. `@qbit-oss/api` has no
 * call for it.
 */
const QBIT_PRECISE_FEES_PATH = '/fees/precise'

/**
 * The time a precise read has, headers and body, before the quote reads the
 * whole-number tiers instead: a third of the 15 s budget every small reply
 * has (`QBIT_EXPLORER_REPLY_TIMEOUT_MS`). Without it a route that takes the
 * connection and never answers would hold every quote for that whole budget
 * before the fallback is even sent, and the send screen holds Next for a
 * tier's rate until the quote settles.
 */
const QBIT_PRECISE_FEES_TIMEOUT_MS = 5_000

/**
 * How long a client reads the whole-number tiers directly after its precise
 * read failed, by any error, its own deadline included, or with tiers that
 * give no available quote. A route that is missing, throttled or hung would
 * otherwise cost every quote refresh a wasted request, or that deadline,
 * before the fallback: twice the requests to an explorer that is throttling.
 */
const QBIT_PRECISE_FEES_COOL_DOWN_MS = 10 * 60_000

/**
 * Reads `/fees/precise` for `QbitWalletMempoolClient.getFeeTiers`. It is
 * built from that client's options, so the request has the base URL, fetch,
 * timeouts, signal and error types of its `/fees/recommended` read, but it
 * is sent once: a failed precise read is not tried again, and the quote
 * falls back at once to `/fees/recommended`, which keeps the client's retries.
 */
class QbitPreciseFeeReader extends EsploraClient {
  read(options: RequestOptions): Promise<unknown> {
    return this.getJson<unknown>(QBIT_PRECISE_FEES_PATH, options)
  }
}

export class QbitWalletMempoolClient
  extends MempoolQbitClient
  implements QbitTxOutspendsClient, QbitAddressHistoryPageClient
{
  /** The most pages one history read fetches, as the client's `maxAddressHistoryPages`. */
  readonly maxHistoryWalkPages: number
  private readonly largeReadCeilingMs: number
  /** The options the client was built with, for its reader of `/fees/precise`. */
  private readonly preciseFeeReaderOptions: EsploraClientOptions
  private preciseFees: QbitPreciseFeeReader | undefined
  /**
   * When (`Date.now()`) this client's last precise read failed, until one
   * succeeds: see `QBIT_PRECISE_FEES_COOL_DOWN_MS`.
   */
  private preciseFeesFailedAt: number | undefined

  // The client clamps every call's maxPages to this ceiling (default 256), so
  // the two-read budgets above need it raised to match. The history reads
  // below keep to it too.
  constructor(options: MempoolQbitClientOptions) {
    const maxAddressHistoryPages =
      options.maxAddressHistoryPages ??
      DEFAULT_MAX_COUNTER_HISTORY_PAGES * QBIT_ADDRESS_HISTORY_READS
    const requests = new QbitAddressRequests()
    const budgeted = withQbitExplorerBudgets({ ...options, maxAddressHistoryPages }, requests)
    super(budgeted)
    qbitAddressRequestsByClient.set(this, requests)
    this.maxHistoryWalkPages = maxAddressHistoryPages
    this.largeReadCeilingMs = budgeted.timeoutMs
    this.preciseFeeReaderOptions = { ...budgeted, retries: 0 }
  }

  /**
   * Fee-rate tiers for targets 1, 2 and 3 from `/fees/precise` (#182), whose
   * rates go down to the node's relay floor of 0.25 bits/vB where
   * `/fees/recommended` gives whole numbers of at least 1. The reply is
   * checked as the SDK checks that of `/fees/recommended`: an object whose
   * `fastestFee`, `halfHourFee` and `hourFee` are finite numbers above 0 and
   * at most 10,000. Its tiers must also give an available quote
   * (`qbitFeeSummaryFromTiers`).
   *
   * The whole-number tiers of `super.getFeeTiers` are read instead when the
   * precise read fails in any way (any HTTP status, the network, a timeout,
   * a body that is not JSON), takes longer than `QBIT_PRECISE_FEES_TIMEOUT_MS`
   * (5 s), or its tiers fail those checks, so a broken precise endpoint never
   * costs a quote the whole-number one still gives; when that read fails too,
   * its error is the call's. Such a failure also starts a cool-down of
   * `QBIT_PRECISE_FEES_COOL_DOWN_MS` (10 minutes) on this client, during
   * which the call reads the whole-number tiers directly; the first call
   * after it reads the precise tiers again, and a precise read that succeeds
   * ends it. One operation scope (the caller's signal and deadline, and the
   * client's signal) covers both reads: once it aborts, the call rejects
   * with its error, makes no fallback read and starts no cool-down.
   */
  override getFeeTiers(options?: RequestOptions): Promise<FeeRateTier[]> {
    return this.runOperation(options, async signal => {
      const precise = this.preciseFeesCoolingDown()
        ? undefined
        : await this.readPreciseFeeTiers(signal)
      return precise ?? super.getFeeTiers({ signal })
    })
  }

  /** Whether a precise read failed less than `QBIT_PRECISE_FEES_COOL_DOWN_MS` ago. */
  private preciseFeesCoolingDown(): boolean {
    if (this.preciseFeesFailedAt === undefined) return false
    // A clock set back before the failure ends the cool-down rather than lengthen it.
    const age = Date.now() - this.preciseFeesFailedAt
    return age >= 0 && age < QBIT_PRECISE_FEES_COOL_DOWN_MS
  }

  /**
   * The tiers of one `/fees/precise` read, under its own deadline of
   * `QBIT_PRECISE_FEES_TIMEOUT_MS` within the call's, or undefined when they
   * cannot stand in for the whole-number ones, which starts the cool-down.
   * It throws only once `signal` has aborted, with the error the call is
   * aborted with.
   */
  private async readPreciseFeeTiers(signal: AbortSignal): Promise<FeeRateTier[] | undefined> {
    let tiers: FeeRateTier[]
    try {
      const reply = await this.preciseFeeReader().read({
        signal,
        deadlineMs: QBIT_PRECISE_FEES_TIMEOUT_MS,
      })
      tiers = feeTiersFromEstimates(
        feeEstimatesFromMempoolRecommendedFees(reply as MempoolRecommendedFees)
      )
    } catch {
      // An operation scope's signal is aborted with the QbitApiError its call
      // rejects with. The precise read's own deadline does not abort it, and
      // so fails the read like any other error.
      if (signal.aborted) throw signal.reason
      this.preciseFeesFailedAt = Date.now()
      return undefined
    }
    if (qbitFeeSummaryFromTiers(tiers, 'mempool-qbit').quote?.availability !== 'available') {
      this.preciseFeesFailedAt = Date.now()
      return undefined
    }
    this.preciseFeesFailedAt = undefined
    return tiers
  }

  private preciseFeeReader(): QbitPreciseFeeReader {
    this.preciseFees ??= new QbitPreciseFeeReader(this.preciseFeeReaderOptions)
    return this.preciseFees
  }

  getTxOutspends(txid: string, options?: QbitTxOutspendsOptions): Promise<QbitTxOutspend[]> {
    return this.getJson<QbitTxOutspend[]>(`/tx/${encodeURIComponent(txid)}/outspends`, options)
  }

  // The combined route, mempool rows first. `getAddressTxs` would rescan it
  // from the top to find each cursor.
  getAddressHistoryPage(
    address: string,
    afterTxid?: string,
    options?: RequestOptions
  ): Promise<EsploraTx[]> {
    return this.getCombinedHistoryPage(address, afterTxid, options)
  }

  // A fresh read (`QbitTxOutspendsOptions.fresh`) goes out under its own URL, on its own.
  protected override getJson<T>(
    path: string,
    options?: QbitTxOutspendsOptions,
    dedup?: boolean
  ): Promise<T> {
    return qbitNoteListingCall(this, path, options, () =>
      super.getJson<T>(...qbitJsonRead(path, options, dedup))
    )
  }

  protected override request(
    path: string,
    init: QbitClientRequestInit,
    options?: RequestOptions
  ): Promise<Response> {
    return super.request(
      path,
      init,
      withQbitLargeReadCeiling(path, init.method, options, this.largeReadCeilingMs)
    )
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
 * The listing limit the wallet assumes for an explorer that refuses an
 * over-limit address with a bare HTTP 500 and nothing more, as mempool-qbit
 * did before v1.0.0: electrs' default `--utxos-limit`. A newer explorer says
 * that it refuses, and electrs' message states the limit
 * (`qbitUtxoListRefusal`).
 */
export const QBIT_EXPLORER_DEFAULT_UTXO_LIMIT = 500

// qbit-electrs refuses an over-limit listing (`TooManyUtxos`) with HTTP 400
// and "Too many unspent transaction outputs (>N). Contact support to raise
// limits."; mempool-qbit since v1.0.0 relays that reason with HTTP 413, as
// `{"error":"..."}` to a client that accepts JSON.
const QBIT_UTXO_LIMIT_REFUSAL = /Too many unspent transaction outputs(?: \(>(\d{1,15})\))?/
const QBIT_UTXO_LIST_ROUTE = /\/address\/[^/?#]+\/utxo(?:[?#]|$)/

/** The explorer's refusal to list an address's outputs (`qbitUtxoListRefusal`). */
export interface QbitUtxoListRefusal {
  /**
   * Whether the explorer said so itself: electrs' refusal at any status, or
   * an HTTP 413 from the listing. electrs refuses an address whose output set
   * passed its limit at any point since it last cached that set, so a stated
   * refusal holds whatever the address holds now, fewer outputs than the
   * limit included. A bare HTTP 500 is not stated: an older mempool-qbit
   * answers every failure of the route that way.
   */
  stated: boolean
  /** The limit electrs' message states (`(>N)`), when it does. */
  limit?: number
}

/**
 * The explorer's refusal to list an address's outputs, read from `error`, a
 * failure of `/address/:a/utxo` itself, or undefined for any other failure:
 * the classifier's per-output lookups can fail with a 500 of their own.
 */
export function qbitUtxoListRefusal(error: unknown): QbitUtxoListRefusal | undefined {
  if (
    !(error instanceof QbitApiError) ||
    !error.url ||
    !QBIT_UTXO_LIST_ROUTE.test(error.url) ||
    error.status === undefined ||
    error.status < 400
  ) {
    return undefined
  }
  const stated = QBIT_UTXO_LIMIT_REFUSAL.exec(error.responseBody ?? '')
  if (stated) {
    const limit = stated[1] === undefined ? undefined : Number(stated[1])
    return {
      stated: true,
      ...(limit !== undefined && Number.isSafeInteger(limit) && limit > 0 ? { limit } : {}),
    }
  }
  if (error.kind === 'payload_too_large') return { stated: true }
  if (error.kind === 'http' && error.status === 500) return { stated: false }
  return undefined
}

/**
 * Whether a failed UTXO listing is the explorer's UTXO limit. A refusal the
 * explorer states (`qbitUtxoListRefusal`) is, whatever the address's
 * statistics show. A bare HTTP 500 is only for an address whose statistics
 * show more confirmed unspent outputs than the limit the wallet assumes for
 * such an explorer (`QBIT_EXPLORER_DEFAULT_UTXO_LIMIT`). electrs counts the
 * confirmed set before it applies the mempool, so pending spends do not bring
 * an address back under it. A bare 500 for a smaller address stays an
 * ordinary failure, and so does one whose statistics lookup fails as well:
 * the caller reports the listing failure itself. Nothing in a bare 500 says
 * which explorer answered, so one for a larger address counts even from an
 * explorer that states its refusals, where it can only be an outage.
 */
export async function isQbitUtxoListOverExplorerLimit(
  client: Pick<QbitEsploraClient, 'getAddressStats'>,
  address: string,
  error: unknown,
  options: QbitReadCancellation = {}
): Promise<boolean> {
  const refusal = qbitUtxoListRefusal(error)
  if (!refusal) return false
  // A stated refusal needs no statistics to tell it from an outage.
  if (refusal.stated) return true
  return (await qbitUtxoListOverExplorerLimitStats(client, address, error, options)) !== undefined
}

/**
 * The checked address statistics behind a failed UTXO listing that is the
 * explorer's UTXO limit (`isQbitUtxoListOverExplorerLimit`), or undefined
 * when the failure is not it. Statistics that cannot be read leave a bare
 * 500 its own meaning (undefined), and fail a refusal the explorer states
 * with their own error: it is the limit without them, but what the caller
 * reads from them is missing. With `rideOut`, the balance read's schedule,
 * statistics answered with a 502, 503 or 504 are read again on it first.
 */
async function qbitUtxoListOverExplorerLimitStats(
  client: Pick<QbitEsploraClient, 'getAddressStats'>,
  address: string,
  error: unknown,
  options: QbitReadCancellation = {},
  rideOut?: QbitRideOutSchedule
): Promise<EsploraAddressStats | undefined> {
  const refusal = qbitUtxoListRefusal(error)
  if (!refusal) return undefined
  const read = (): Promise<EsploraAddressStats> => client.getAddressStats(address, options)
  let stats: EsploraAddressStats
  try {
    stats = await (rideOut
      ? withQbitReadRetries(read, options.signal, QBIT_STATS_RETRY_STATUSES, { schedule: rideOut })
      : read())
    assertValidQbitStats(stats, address)
  } catch (statsFailure) {
    throwIfQbitReadCancelled(options)
    if (refusal.stated) throw statsFailure
    return undefined
  }
  return qbitRefusalOverLimit(refusal, stats) ? stats : undefined
}

/**
 * Where an address whose listing the explorer refused (`refusal`) stands
 * against its limit, given the address's checked statistics `stats`: over
 * it, with the limit the refusal states, for a refusal the explorer states,
 * whatever the statistics show; for a bare HTTP 500, over the limit the
 * wallet assumes for such an explorer (`QBIT_EXPLORER_DEFAULT_UTXO_LIMIT`)
 * only when the statistics show more confirmed unspent outputs than that.
 * Undefined when the refusal is not the limit. The one rule both the send
 * and the consolidation paths apply.
 */
function qbitRefusalOverLimit(
  refusal: QbitUtxoListRefusal,
  stats: EsploraAddressStats
): Extract<QbitUtxoListLimit, { overLimit: true }> | undefined {
  if (refusal.stated) {
    return { overLimit: true, ...(refusal.limit !== undefined ? { limit: refusal.limit } : {}) }
  }
  const confirmedUnspent = stats.chain_stats.funded_txo_count - stats.chain_stats.spent_txo_count
  return confirmedUnspent > QBIT_EXPLORER_DEFAULT_UTXO_LIMIT
    ? { overLimit: true, limit: QBIT_EXPLORER_DEFAULT_UTXO_LIMIT }
    : undefined
}

/**
 * Where an address stands against the explorer's listing limit, as the
 * explorer answers (`getQbitUtxoListLimit`): it lists the address's outputs,
 * or refuses to, with the limit its refusal states, or for a bare HTTP 500
 * the one the wallet assumes (`QBIT_EXPLORER_DEFAULT_UTXO_LIMIT`). `limit`
 * is absent when a refusal states none.
 */
export type QbitUtxoListLimit = { overLimit: false } | { overLimit: true; limit?: number }

/**
 * Where `address` stands against the explorer's listing limit, by asking it
 * for the address's outputs: the explorer's own answer, which no count
 * stands in for, since electrs keeps refusing an address whose output set
 * passed its limit at any point since it last cached that set. `stats`, the
 * address's statistics, checked, decide a bare HTTP 500 as
 * `isQbitUtxoListOverExplorerLimit` does. Any other failure of the listing
 * is thrown, and so is a reply that is not a list, which a send refuses too.
 */
export async function getQbitUtxoListLimit(
  client: Pick<QbitEsploraClient, 'getAddressUtxos'>,
  address: string,
  stats: EsploraAddressStats,
  options: RequestOptions = {}
): Promise<QbitUtxoListLimit> {
  let utxos: unknown
  try {
    utxos = await client.getAddressUtxos(address, options)
  } catch (error) {
    throwIfQbitReadCancelled(options)
    const refusal = qbitUtxoListRefusal(error)
    const overLimit = refusal && qbitRefusalOverLimit(refusal, stats)
    if (overLimit) return overLimit
    throw error
  }
  if (!Array.isArray(utxos)) throw new Error(`invalid qbit UTXO response for ${address}`)
  return { overLimit: false }
}

/**
 * What the past-limit split needs of an output a read of an address's
 * history found spendable (see `getQbitAddressUtxos`), and no more: a large
 * address can have tens of thousands. `unconfirmed` marks the account's own
 * unconfirmed change.
 */
export type QbitReadOutput = Pick<UTXO, 'txid' | 'vout' | 'satoshis' | 'scriptPk' | 'unconfirmed'>

/**
 * A read the past-limit split takes its outputs from, and the tip heights
 * between which it still says what a send may select. `matureAt`, when the
 * read left an immature coinbase output out, is the earliest tip height at
 * which one matures. `matureFrom`, when it took a coinbase output in, is the
 * lowest tip height at which every one of them is still mature.
 */
export interface QbitOutputRead {
  outputs: readonly QbitReadOutput[]
  matureAt?: number
  matureFrom?: number
}

/** `utxo` as the past-limit split keeps it (`QbitReadOutput`). */
export function qbitReadOutput(utxo: QbitReadOutput): QbitReadOutput {
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    satoshis: utxo.satoshis,
    scriptPk: utxo.scriptPk,
    ...(utxo.unconfirmed ? { unconfirmed: true } : {}),
  }
}

/**
 * How long a balance read (`getQbitSpendableBalanceV2`) may take, every read
 * it makes included: the statistics, the listing, the funding transactions
 * and ancestors, the tip and a statistics read again past the listing limit.
 * The balance card polls every 10 s; an address with thousands of outputs not
 * read before takes several polls to work through, each leaving what it read
 * for the next (see `QbitFundingTxReads`).
 */
export const QBIT_BALANCE_READ_DEADLINE_MS = 20_000

/** `getQbitSpendableBalanceV2`'s options. */
export interface QbitBalanceReadOptions extends QbitClassifyOptions {
  /** The whole read's deadline, in ms: `QBIT_BALANCE_READ_DEADLINE_MS` by default. */
  deadlineMs?: number
  /**
   * The read's place among the answers kept for reuse
   * (`QbitBalanceReuse.begin`), taken when it was asked for, before awaits
   * of its caller's own. Without it, or with a client other than the
   * wallet's own (`QbitWalletEsploraClient`, `QbitWalletMempoolClient`),
   * which alone ask for a read fresh, nothing is kept or reused.
   */
  reuse?: QbitBalanceReuseView
}

/**
 * One balance read's deadline and cancellation. Its `signal`, which every
 * read of it runs under, aborts once the deadline passes, with
 * `timeoutError`, or once the caller's signal aborts, with that reason.
 * `close` clears the timer and lets go of the caller's signal.
 */
class QbitBalanceReadOperation {
  readonly signal: AbortSignal
  readonly timeoutError: QbitApiError
  private readonly controller = new AbortController()
  private expired = false
  private readonly release: () => void
  /** Let go of the read's signal for each of its parts (`part`). */
  private readonly parts: (() => void)[] = []

  constructor(
    deadlineMs: number,
    private readonly callerSignal: AbortSignal | undefined
  ) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 0x7fff_ffff) {
      throw new Error('deadlineMs must be a positive number of milliseconds')
    }
    this.signal = this.controller.signal
    this.timeoutError = new QbitApiError(
      'timeout',
      `qbit balance read exceeded its ${deadlineMs}ms deadline`
    )
    const onCallerAbort = (): void => this.controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) onCallerAbort()
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer = setTimeout(() => {
      this.expired = true
      this.controller.abort(this.timeoutError)
    }, deadlineMs)
    this.release = (): void => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }

  /** Reject with the caller's reason once the caller has given up: that outcome comes first. */
  throwIfCancelled(): void {
    if (this.callerSignal?.aborted) throw this.callerSignal.reason
  }

  /** Whether the deadline passed (and the caller had not given up before). */
  get timedOut(): boolean {
    return this.expired && this.signal.reason === this.timeoutError
  }

  /** Stop every read still running: the read has nothing more to wait for. */
  stop(reason: unknown): void {
    this.controller.abort(reason)
  }

  /** Settle with `promise`, a wait no read of this operation bounds, or reject once `signal` aborts. */
  within<T>(promise: Promise<T>): Promise<T> {
    const { signal } = this
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        value => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }

  /**
   * A part of the read of its own: its signal aborts with the read's, with
   * the same reason, or once `abort` is called; it is let go of with the read.
   */
  part(): { signal: AbortSignal; abort: (reason: unknown) => void } {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(this.signal.reason)
    if (this.signal.aborted) onAbort()
    else this.signal.addEventListener('abort', onAbort, { once: true })
    this.parts.push(() => this.signal.removeEventListener('abort', onAbort))
    return { signal: controller.signal, abort: (reason): void => controller.abort(reason) }
  }

  close(): void {
    this.release()
    for (const release of this.parts.splice(0)) release()
  }
}

/** What a listing a read throws away, as it lists again, is stopped with should it still be in flight. */
const QBIT_BALANCE_LISTED_AGAIN = new QbitApiError(
  'aborted',
  'qbit balance read listed its outputs again'
)

/**
 * The address's balance split the way a send sees it. `readReserved`, when
 * given, is read once the outputs are classified and names the outputs
 * (`txid:vout`) a send must not select (see `QbitSendGuardService`); they
 * count as unavailable rather than available.
 *
 * The whole read has one deadline (`options.deadlineMs`, by default
 * `QBIT_BALANCE_READ_DEADLINE_MS`) and stops once `options.signal` aborts,
 * rejecting with its reason. The total comes from the address statistics, and
 * without them the read rejects: when they fail, or have not answered by the
 * deadline, with a `timeout` `QbitApiError`. Once they are read, an output
 * read that fails or has not finished by the deadline leaves the split
 * unknown (`utxoReadIncomplete`), never 0 and never counted from part of the
 * outputs; what it read is kept for the next read with
 * `options.fundingTxReads`. One that failed also says so (`utxoReadFailed`),
 * so a poll can back off, and so does one that ran out of time without
 * keeping anything the next read is served: not one fact it newly kept of
 * an output the listing reports confirmed is kept still when it answers, as
 * another address's read through the same reader may have pushed them out
 * (without `options.fundingTxReads` nothing is kept). One that ran out of
 * time part of the way through the outputs does not. Nor does a send guard
 * that has not answered by the deadline hold the read: the split is then
 * unknown too.
 *
 * Within that deadline, every read it makes rides out the explorer's server
 * errors (`QBIT_BALANCE_RIDE_OUT`): the statistics, the listing and the tip
 * answered with a 502, 503 or 504, and a transaction lookup answered with a
 * 500, 502, 503 or 504, are read again after 500 ms and then 1,500 ms, while
 * the next attempt would begin within 3 s of the first request, the
 * explorer's 502 with a `Retry-After` past the client's cap included. A bare 500 or a
 * refusal of the listing is judged as before, a 429 is the client's, and an
 * ancestor's walk does not ride them out, as before. Only so many lookups
 * ride out (`QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS`), each attempt in a slot of
 * the limiter of its own, none held through a pause. A lookup that still
 * fails no longer cancels the others: those in flight run to their end, and
 * the read goes on, keeping what it reads for the next one, until
 * `QBIT_BALANCE_READ_FAILED_LOOKUPS` lookups have failed, when it starts no
 * more. It still answers as a failed read always did, the split unknown and
 * failed (see `QbitClassificationReads`).
 *
 * An output confirmed at least a coinbase maturity (1,000 blocks) deep is
 * spendable and mature whatever its transaction says, so for one the read
 * reads no transaction and believes the listing alone: nothing checks the
 * explorer's transaction against it (txid, output index, value, P2MR
 * script), and Available stays bounded by the statistics. Depth is judged
 * from the listing's newest block, and from the tip, asked for once, with
 * the listing, for outputs that block cannot show deep; when the tip cannot
 * be read, or has not answered once nothing else is left to read, those are
 * read as before, so only a coinbase output's maturity ever waits for the
 * tip. Only younger confirmed outputs and unconfirmed ones are read one by
 * one (see `classifyQbitUtxos`), so a cold read of an old account reads few
 * transactions. Reads of outputs for a send, sweep or plan still read every
 * one. Every read of an address whose script is known asks for the tip, one
 * request beside the statistics and the listing, even with no output listed.
 *
 * With a shared reader, an address with more outputs to read one by one,
 * those its listing, and the tip if it has answered by then, cannot show
 * deep, than it keeps facts of (`QbitFundingTxReads.maxOutpoints`, 65,536
 * for the controller's) is not read output by output at all, as each poll
 * would evict what the next needs: no transaction is read, the tip is not
 * waited for, and the answer, at once, is the total with the split unknown,
 * `utxoReadIncomplete` and `utxoReadFailed`, so a poll backs off.
 *
 * Its answer is only totals, so it serves kept "not a coinbase" facts at any
 * confirmed depth (`balanceOnly`, see `classifyQbitUtxos`): after one wrong
 * `is_coinbase` answer it can count a reward younger than 1,000 blocks as
 * Available until a read of outputs or a clear replaces the kept fact. No
 * send can select that reward.
 *
 * Past the explorer's UTXO limit the outputs cannot be listed, and the split
 * is unknown (`utxoLimitExceeded`) unless `readOutputs` has the outputs a read
 * of the address's history found when the address statistics
 * (`qbitStatsSnapshot`) read as they do now; see `getQbitPastLimitSplit`.
 *
 * With `options.reuse` (see `QbitBalanceReuse`) the read asks for the
 * statistics themselves, the same request as for the balance, and keeps
 * the classified outputs of a complete read, one that ran to the end and
 * read the reservations, of a listing of at least
 * `QBIT_BALANCE_REUSE_MIN_OUTPUTS` outputs, every one confirmed, that agrees
 * in count and value with the confirmed statistics read with it, no mempool
 * number of which is above 0 (`qbitReusableListingDigest`), at a tip that
 * answered, each output classified as paying the address's own script, while
 * no fact kept by `options.fundingTxReads` changed or went from before it
 * classified any (`QbitFundingTxReads.factChanges`). Kept first as a
 * candidate, the answer is confirmed by a later read, begun once it was
 * kept, that lists the same outputs under the same statistics in a listing
 * asked for fresh (`QbitTxOutspendsOptions.fresh`), which no cache answers
 * and no other request shares: a read of an address with an answer kept
 * asks for its listing so. A confirmed answer is reused for at most
 * `QBIT_BALANCE_REUSE_MAX_AGE_MS` from when that read began, and only while
 * no kept fact has changed or gone since. A poll with one asks for the
 * statistics, fresh, and the tip, together, and no listing: it reuses the
 * answer when the statistics read as they did for it and the tip, waited
 * for at most `QBIT_BALANCE_REUSE_TIP_WAIT_MS` once the statistics have
 * answered, neither fell below the one it was read at nor reached the height
 * at which an output it counts immature matures, reading the reservations
 * afresh; the split is then what a read of the listing would give (see
 * `reuseQbitBalance`). Otherwise it asks for the listing then, one round
 * trip later, and reads on as above, the reservations read again after the
 * listing. Statistics that no longer read as they did for the answer, a
 * kept fact changed or gone, or a listing that may not be kept forget it, so the next
 * poll asks for the listing with the statistics again; a tip that failed or
 * did not answer in time sets it aside, and polls read as with nothing kept
 * until its age runs out. Without such an answer, or without
 * `options.reuse`, the listing is asked for with the statistics, as it
 * always was.
 */
export async function getQbitSpendableBalanceV2(
  client: QbitEsploraClient,
  address: string,
  p2mrScriptPubKey?: string,
  readReserved?: () => Promise<ReadonlySet<string>>,
  readOutputs?: (stats: string) => QbitOutputRead | undefined,
  options: QbitBalanceReadOptions = {}
): Promise<QbitBalanceSummaryPayload> {
  const operation = new QbitBalanceReadOperation(
    options.deadlineMs ?? QBIT_BALANCE_READ_DEADLINE_MS,
    options.signal
  )
  try {
    const summary = await readQbitSpendableBalance(
      client,
      address,
      p2mrScriptPubKey,
      readReserved,
      readOutputs,
      operation,
      options.fundingTxReads,
      options.reuse
    )
    operation.throwIfCancelled()
    return summary
  } finally {
    operation.close()
  }
}

async function readQbitSpendableBalance(
  client: QbitEsploraClient,
  address: string,
  p2mrScriptPubKey: string | undefined,
  readReserved: (() => Promise<ReadonlySet<string>>) | undefined,
  readOutputs: ((stats: string) => QbitOutputRead | undefined) | undefined,
  operation: QbitBalanceReadOperation,
  fundingTxReads: QbitFundingTxReads | undefined,
  reuse: QbitBalanceReuseView | undefined
): Promise<QbitBalanceSummaryPayload> {
  operation.throwIfCancelled()
  const { signal } = operation
  // Only the wallet's own clients ask for a read fresh, which confirming a
  // kept answer takes (see `getQbitSpendableBalanceV2`).
  const reusing = reuse && qbitClientReadsFresh(client) ? reuse : undefined
  // How many times this client's kept facts had changed or gone as the read
  // began, taken again should it list after giving up a reuse: a kept answer
  // holds only while that has not moved since (see `QbitBalanceReuse`).
  let factsAt = fundingTxReads?.factChanges(client)
  const factsNow = (): number | undefined => fundingTxReads?.factChanges(client)
  // An answer this read may reuse: only then does the listing wait for the
  // statistics.
  const kept = reusing?.reusable(client, address, factsAt)
  // With a place among the kept answers, the statistics themselves, which
  // the balance comes from at no request more; fresh when an answer is to
  // be reused on their word alone. Read again after a 502, 503 or 504, each
  // attempt counted, and every request for them sent too
  // (`qbitStatsNewerThanListing`).
  let statsAttempts = 0
  const statsRead = withQbitReadRetries<EsploraAddressStats | AddressBalance>(
    () => {
      statsAttempts += 1
      return reusing
        ? client.getAddressStats(address, kept ? qbitFreshRead({ signal }) : { signal })
        : client.getAddressBalance(address, { signal })
    },
    signal,
    QBIT_STATS_RETRY_STATUSES,
    { schedule: QBIT_BALANCE_RIDE_OUT }
  )
  const listing = beginQbitBalanceListing(client, address, signal, fundingTxReads)
  // The first listing's own signal, so that a listing thrown away (below)
  // is stopped should it still be in flight.
  const firstListing = operation.part()
  // Taken as the listing is asked for: a request for the statistics sent
  // after it went out, whoever sent it, may be newer than it. A listing
  // that confirms a kept candidate is fresh (`askQbitBalanceListing`), and
  // joins no other caller's call under way.
  const statsWindow = kept
    ? undefined
    : qbitStatsWindow(client, address, reusing?.has(client, address) === true)
  // Asked for with the statistics, as it always was, but classified only
  // once they have answered (below), so that a read classifies one listing
  // at most. What that costs: no lookup starts, and so no fact is kept,
  // while the statistics are still being read, so a read after an outage of
  // theirs starts cold; and when they answer later than the listing, the
  // lookups start that much later. Usually they answer first, and nothing
  // changes. Two reads that share one request for the statistics, answered
  // after both listings, begin classifying in the same turn, and so may each
  // send the first lookups, as 1.0.10 does for two reads begun together,
  // within one reply's time of each other.
  let listed = kept ? undefined : askQbitBalanceListing(listing, reusing, firstListing.signal)
  let stats: EsploraAddressStats | undefined
  let balance: AddressBalance
  try {
    const read = await statsRead
    if (reusing) {
      stats = read as EsploraAddressStats
      balance = addressBalanceFromStats(stats)
    } else {
      balance = read as AddressBalance
    }
  } catch (error) {
    // Nothing can be reported without the total, so the outputs are not
    // read on, nor classified.
    operation.stop(error)
    listing.tip?.close()
    operation.throwIfCancelled()
    throw operation.timedOut ? operation.timeoutError : error
  }
  const aggregateBalance = qbitBalanceToSummary(balance)
  // Statistics that may be newer than the listing, as a request for them
  // went out after it, the read's own later attempt or the client's, or
  // another caller's request the read joined: had a block between them spent
  // a listed output the send guard does not hold and paid the address a
  // young reward, Available would count the spent output. The first listing,
  // which nothing has classified yet, is then thrown away, stopped should it
  // still be in flight, and the listing asked for again now, after the
  // statistics answered, fresh, so that it joins no request sent before
  // (only the wallet's own clients ask so: any other sends it as any read,
  // and it may join the first there); that one is classified, judged as a
  // first listing is. Nothing of such a read is kept for reuse. A request
  // for the statistics another caller sends in that window, which the read
  // did not join, costs one listing more; fresh ones, which no read can
  // join, are not counted. A listing newer than the statistics, as when the
  // listing was the one read again, needs nothing: Available is then bounded
  // by the older statistics' confirmed balance and by what that listing can
  // spend, so it is never above what a fresh read gives.
  //
  // What the rule cannot close: it orders requests by when they went out,
  // not by when the explorer read its state. Statistics asked for before the
  // listing, by the read itself or by another caller whose request it
  // joined, but which the explorer serves after the listing, are still
  // paired with the older listing. 1.0.10 has the same race for every read
  // whose statistics are answered later than its listing.
  const listedAgain =
    listed !== undefined &&
    (statsAttempts > 1 || qbitStatsNewerThanListing(client, address, statsWindow))
  if (listed && listedAgain) {
    firstListing.abort(QBIT_BALANCE_LISTED_AGAIN)
    listed = askQbitBalanceListing(listing, reusing, signal, true)
  }
  if (!listed) {
    const reused =
      kept && reusing && stats
        ? await reuseQbitBalance(
            kept,
            reusing,
            stats,
            aggregateBalance,
            listing,
            p2mrScriptPubKey,
            readReserved,
            operation,
            factsNow
          )
        : undefined
    if (reused) return reused
    // Not reused: the listing is read after all, the tip already asked for.
    // Nothing has been classified yet, so the count is taken again: a fact
    // that changed or went meanwhile, which may be why the answer was not
    // reused, no longer keeps this read's own answer from being kept, as a
    // candidate the next poll may confirm.
    factsAt = fundingTxReads?.factChanges(client)
    listed = askQbitBalanceListing(listing, reusing, signal)
  }
  const { progress } = listing
  let classified: QbitClassifiedUtxos
  try {
    classified = await listQbitBalanceOutputs(listing, listed)
  } catch (error) {
    operation.throwIfCancelled()
    // Cut off by the deadline, it rejects with the deadline's own error;
    // anything else is a failure, even one noticed after the deadline. Cut
    // off with nothing new kept still for the next read, it got no further.
    if (error === operation.timeoutError) {
      const keptStill = progress.kept.some(([txid, vout]) => progress.facts?.has(txid, vout))
      return qbitIncompleteSplit(aggregateBalance, !keptStill)
    }
    // More outputs than the wallet keeps facts of: none read, nothing to build on.
    if (error instanceof QbitOutputsPastFactsCapError) {
      return qbitIncompleteSplit(aggregateBalance, true)
    }
    return qbitSplitPastFailedListing(
      client,
      address,
      error,
      aggregateBalance,
      p2mrScriptPubKey,
      readReserved,
      readOutputs,
      operation
    )
  }
  // Read once the outputs are, as by a read with nothing kept: a reuse given
  // up after reading them read them before the listing, which can take
  // seconds, while a send may reserve outputs.
  let reserved: ReadonlySet<string> | undefined
  if (readReserved) {
    try {
      reserved = await operation.within(readReserved())
    } catch (error) {
      operation.throwIfCancelled()
      // The send guard has not answered by the deadline: without the
      // reservations nothing can count as available, as when the controller
      // stops waiting for it.
      if (operation.timedOut) return qbitUnknownSplit(aggregateBalance)
      throw error
    }
  }
  const split = qbitClassifiedSplit(aggregateBalance, classified, p2mrScriptPubKey, reserved)
  // Kept even when the controller stopped waiting for the send guard and
  // answers the split unknown: a kept answer holds no reservations, and
  // every reuse reads them afresh.
  if (reusing && stats && !listedAgain) {
    keepQbitBalanceRead(reusing, listing, stats, classified, signal, factsAt, factsNow)
  }
  return split
}

/**
 * What a balance read's listing goes with (`listQbitBalanceOutputs`), begun
 * with the read, before its first await: the tip, asked for at once for an
 * address whose script is known (see `classifyQbitUtxos`), whether the
 * listing is asked for with it or after it, and the read's place among the
 * shared reader's clears, so that a clear while the statistics are read
 * counts as well.
 */
interface QbitBalanceListing {
  readonly client: QbitEsploraClient
  readonly address: string
  readonly signal: AbortSignal
  /** The script paying the address, in lower case (`qbitAddressScript`). */
  readonly script: string | undefined
  readonly fundingTxReads: QbitFundingTxReads | undefined
  readonly facts: QbitFundingFactsView | undefined
  readonly tip: QbitTipRead | undefined
  /** What the classification kept for the next read, and the listing it classified. */
  readonly progress: QbitClassifyProgress
  /** Whether the listing was asked for fresh (`QbitTxOutspendsOptions.fresh`). */
  fresh: boolean
}

function beginQbitBalanceListing(
  client: QbitEsploraClient,
  address: string,
  signal: AbortSignal,
  fundingTxReads: QbitFundingTxReads | undefined
): QbitBalanceListing {
  const script = qbitAddressScript(address)
  const tip =
    script !== undefined ? new QbitTipRead(client, signal, QBIT_BALANCE_RIDE_OUT) : undefined
  tip?.start()
  return {
    client,
    address,
    signal,
    script,
    fundingTxReads,
    facts: fundingTxReads?.begin(client),
    tip,
    progress: { kept: [] },
    fresh: false,
  }
}

/**
 * Where a balance read's statistics count from, its listing asked for now,
 * `fresh` or not (`QbitAddressRequests.window`): for the wallet's own
 * clients, which count their requests; undefined for any other.
 */
function qbitStatsWindow(
  client: object,
  address: string,
  fresh: boolean
): QbitStatsWindow | undefined {
  return qbitAddressRequestsByClient.get(client)?.window(address, fresh)
}

/**
 * Whether a request for `address`'s statistics went out after the balance
 * read's listing did (`window`) and before its statistics answered, whoever
 * sent it: the read's own retry, the client's, or another caller's request
 * the read joined; so its statistics may be newer than its listing. Without
 * a window (a client other than the wallet's own) only the read's own
 * attempts tell.
 */
function qbitStatsNewerThanListing(
  client: object,
  address: string,
  window: QbitStatsWindow | undefined
): boolean {
  if (window === undefined) return false
  return qbitAddressRequestsByClient.get(client)?.statsSince(address, window) === true
}

/**
 * The balance read's listing asked for now, under `signal`, for the read to
 * classify once its statistics have answered (`listQbitBalanceOutputs`).
 * With an answer kept for the address (`QbitBalanceReuseView.has`) it is
 * asked for fresh, as a listing that confirms one must be, and so it is
 * with `fresh`.
 */
function askQbitBalanceListing(
  listing: QbitBalanceListing,
  reuse: QbitBalanceReuseView | undefined,
  signal: AbortSignal,
  fresh = false
): Promise<EsploraUtxo[]> {
  listing.fresh = fresh || reuse?.has(listing.client, listing.address) === true
  const listed = listQbitUtxos(listing.client, listing.address, {
    signal,
    balanceOnly: true,
    ...(listing.fresh ? { freshListing: true as const } : {}),
  })
  // Heard by the classification; one thrown away, or left once the
  // statistics fail, fails unheard.
  listed.catch(() => undefined)
  return listed
}

/**
 * `listed`, the balance read's listing (`askQbitBalanceListing`),
 * classified with what `listing` began.
 */
function listQbitBalanceOutputs(
  listing: QbitBalanceListing,
  listed: Promise<EsploraUtxo[]>
): Promise<QbitClassifiedUtxos> {
  // Its answer is a few totals, which no send takes inputs from (see
  // `classifyQbitUtxos`).
  return listAndClassifyQbitUtxos(listing.client, listing.address, {
    signal: listing.signal,
    balanceOnly: true,
    progress: listing.progress,
    listed,
    ...(listing.fundingTxReads ? { fundingTxReads: listing.fundingTxReads } : {}),
    ...(listing.facts ? { facts: listing.facts } : {}),
    ...(listing.tip ? { tip: listing.tip } : {}),
    ...(listing.fresh ? { freshListing: true as const } : {}),
  })
}

/**
 * The split of `kept`, the answer of a complete read this read may reuse
 * (`QbitBalanceReuseView.reusable`), worked out as a read of the listing
 * would work it out, with this read's statistics, `stats`, and
 * reservations; or undefined when it may not be reused, and the listing is
 * read after all. Statistics that no longer read as they did for it
 * (`qbitStatsSnapshot`), or that a payment in the mempool makes it unfit to
 * go with (`qbitReusableStats`), forget it. Otherwise the tip, asked for
 * with the statistics, is waited for at most `QBIT_BALANCE_REUSE_TIP_WAIT_MS`
 * more; failing, late, out of the deadline or not a safe integer, it sets
 * the answer aside (`QbitBalanceReuseView.setAside`), and the listing is
 * read with the tip read handed on. The answer is reused only while it
 * still may be (`QbitBalanceReuseView.stillReusable`, given `facts`, the
 * count of changes to the kept facts now), checked after the tip and after the
 * reservations, once the tip reads a height neither below the tip it was
 * read at, as after a rollback, nor at the lowest height at which an output
 * it counts immature matures: a coinbase output matures with no change to
 * the statistics. The send guard's reservations are read afresh, within the
 * deadline, as after a listing, and past it the split is unknown.
 */
async function reuseQbitBalance(
  kept: QbitReusableBalance,
  reuse: QbitBalanceReuseView,
  stats: EsploraAddressStats,
  aggregateBalance: QbitBalanceSummaryPayload & { availableBalance: number },
  listing: QbitBalanceListing,
  p2mrScriptPubKey: string | undefined,
  readReserved: (() => Promise<ReadonlySet<string>>) | undefined,
  operation: QbitBalanceReadOperation,
  facts: () => number | undefined
): Promise<QbitBalanceSummaryPayload | undefined> {
  const { answer } = kept
  const { tip } = listing
  if (!tip) return undefined
  if (!qbitReusableStats(stats, listing.address) || qbitStatsSnapshot(stats) !== answer.stats) {
    reuse.forget(kept)
    return undefined
  }
  let tipHeight: number | undefined
  try {
    tipHeight = await operation.within(qbitWaitAtMost(tip.start(), QBIT_BALANCE_REUSE_TIP_WAIT_MS))
  } catch {
    operation.throwIfCancelled()
  }
  // Without the tip in time the poll reads the listing late, and so would
  // every poll of a slow or broken tip: set aside, the answer leaves the
  // polls until its age runs out to read as with nothing kept.
  if (tipHeight === undefined || !Number.isSafeInteger(tipHeight)) {
    reuse.setAside(kept)
    return undefined
  }
  if (
    tipHeight < answer.tipHeight ||
    (answer.matureAt !== undefined && tipHeight >= answer.matureAt) ||
    !reuse.stillReusable(kept, facts())
  ) {
    return undefined
  }
  let reserved: ReadonlySet<string> | undefined
  if (readReserved) {
    try {
      reserved = await operation.within(readReserved())
    } catch (error) {
      tip.close()
      operation.throwIfCancelled()
      if (operation.timedOut) return qbitUnknownSplit(aggregateBalance)
      throw error
    }
  }
  // A clear, the end of its age, a read that replaced it, or a kept fact
  // changed or gone, while the send guard answered.
  if (!reuse.stillReusable(kept, facts())) return undefined
  reuse.used(kept)
  tip.close()
  return qbitClassifiedSplit(
    aggregateBalance,
    {
      confirmedSpendable: answer.spendable,
      unconfirmedSpendable: [],
      unconfirmedOwnChange: [],
      immature: answer.immature,
    },
    p2mrScriptPubKey,
    reserved
  )
}

/**
 * Keep the answer of a complete balance read for reuse
 * (`QbitBalanceReuseView.keep`): one read under statistics that may go with
 * one (`qbitReusableStats`) at a tip that answered, with `factsAt` changes
 * to the kept facts before it classified anything and as many still
 * (`factsNow`), from a listing that may be kept (`qbitReusableListingDigest`)
 * every output of which was classified spendable or immature, paying the
 * address's own script, and not stopped since. A read stopped leaves what is
 * kept as it is; any other that may not be kept, its tip without a height
 * included, forgets it. What this takes, the digest last, is worked out only
 * once the read may keep anything.
 */
function keepQbitBalanceRead(
  reuse: QbitBalanceReuseView,
  listing: QbitBalanceListing,
  stats: EsploraAddressStats,
  classified: QbitClassifiedUtxos,
  signal: AbortSignal,
  factsAt: number | undefined,
  factsNow: () => number | undefined
): void {
  const listed = listing.progress.listing
  const tipHeight = listing.tip?.height
  if (signal.aborted || listed === undefined) return
  reuse.keep(listing.client, listing.address, listing.fresh, (): QbitKeptListing | undefined => {
    const { confirmedSpendable, immature, matureAt } = classified
    if (
      tipHeight === undefined ||
      // A kept fact changed or went while the read ran: it may have been classified from it.
      factsNow() !== factsAt ||
      !qbitReusableStats(stats, listing.address) ||
      confirmedSpendable.length + immature.length !== listed.length ||
      (immature.length > 0 && matureAt === undefined) ||
      // Classified from an answer naming another script, which no reader
      // keeps: the right fact, kept later, would replace none and move no count.
      !qbitOutputsPay(confirmedSpendable, listing.script) ||
      !qbitOutputsPay(immature, listing.script)
    ) {
      return undefined
    }
    const listingDigest = qbitReusableListingDigest(stats, listed)
    if (listingDigest === undefined) return undefined
    return {
      answer: {
        stats: qbitStatsSnapshot(stats),
        facts: factsAt,
        tipHeight,
        ...(matureAt !== undefined ? { matureAt } : {}),
        spendable: confirmedSpendable.map(qbitReadOutput),
        immature: immature.map(qbitReadOutput),
      },
      listingDigest,
    }
  })
}

/**
 * Whether every one of `outputs` pays `script`, the address's
 * (`isQbitAccountOutput`); never while the script is unknown, as that check
 * then takes any output that carries one.
 */
function qbitOutputsPay(outputs: readonly QbitReadOutput[], script: string | undefined): boolean {
  return script !== undefined && outputs.every(output => isQbitAccountOutput(output, script))
}

/**
 * Whether `stats`, an address's statistics, may go with an answer kept for
 * reuse, or be compared with a kept one's: valid statistics of `address`
 * (`assertValidQbitStats`), every `mempool_stats` number 0. A transaction in
 * the mempool can be replaced by one with the same sums and counts (#128),
 * which the statistics cannot tell from the one before, so no answer is
 * kept or reused while one is there.
 */
function qbitReusableStats(stats: EsploraAddressStats, address: string): boolean {
  try {
    assertValidQbitStats(stats, address)
  } catch {
    return false
  }
  const mempool = stats.mempool_stats
  return [
    mempool.funded_txo_count,
    mempool.funded_txo_sum,
    mempool.spent_txo_count,
    mempool.spent_txo_sum,
    mempool.tx_count,
  ].every(value => value === 0)
}

/**
 * What `listing` is compared with another by, when a complete read of it
 * under `stats` (`qbitReusableStats`) may be kept: a SHA-256 of its
 * entries, `txid:vout:value:height` each, sorted, so the order the explorer
 * lists them in does not count. Undefined unless the listing holds at least
 * `QBIT_BALANCE_REUSE_MIN_OUTPUTS` outputs, every one confirmed, and as many
 * of them, of the same total value, as the confirmed statistics leave
 * unspent: a listing that disagrees with the statistics read with it is
 * never kept.
 */
function qbitReusableListingDigest(
  stats: EsploraAddressStats,
  listing: readonly EsploraUtxo[]
): string | undefined {
  if (listing.length < QBIT_BALANCE_REUSE_MIN_OUTPUTS) return undefined
  const chain = stats.chain_stats
  if (listing.length !== chain.funded_txo_count - chain.spent_txo_count) return undefined
  let sum = 0
  const entries: string[] = []
  for (const { txid, vout, value, status } of listing) {
    if (status?.confirmed !== true || !Number.isSafeInteger(status.block_height)) return undefined
    sum += value
    entries.push(`${txid.toLowerCase()}:${vout}:${value}:${status.block_height}`)
  }
  if (!Number.isSafeInteger(sum) || sum !== chain.funded_txo_sum - chain.spent_txo_sum) {
    return undefined
  }
  return bytesToHex(transactionCore.crypto.sha256(Buffer.from(entries.sort().join('\n'))))
}

/**
 * Whether `client` asks for a read fresh when told to
 * (`QbitTxOutspendsOptions.fresh`), as the wallet's own clients do: the
 * library's own would send it as any other read.
 */
function qbitClientReadsFresh(client: QbitEsploraClient): boolean {
  return client instanceof QbitWalletEsploraClient || client instanceof QbitWalletMempoolClient
}

/** `options` for a read asked for fresh (`QbitTxOutspendsOptions.fresh`). */
function qbitFreshRead(options: RequestOptions): QbitTxOutspendsOptions {
  return { ...options, fresh: true }
}

/** What `promise` settles with, or undefined once `ms` have passed without it. */
function qbitWaitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([promise, waited]).finally(() => clearTimeout(timer))
}

/** The classes of outputs a balance split is worked out from (`qbitClassifiedSplit`). */
interface QbitSplitOutputs {
  readonly confirmedSpendable: readonly QbitReadOutput[]
  readonly unconfirmedSpendable: readonly QbitReadOutput[]
  readonly unconfirmedOwnChange: readonly QbitReadOutput[]
  readonly immature: readonly QbitReadOutput[]
}

/**
 * The split of the address's classified outputs as a send sees it, against
 * the statistics' totals (`aggregateBalance`), less the outputs `reserved`
 * holds.
 */
function qbitClassifiedSplit(
  aggregateBalance: QbitBalanceSummaryPayload & { availableBalance: number },
  classified: QbitSplitOutputs,
  p2mrScriptPubKey: string | undefined,
  reserved: ReadonlySet<string> | undefined
): QbitBalanceSummaryPayload {
  const unconfirmedSpendableSats = qbitAccountSats(
    classified.unconfirmedSpendable,
    p2mrScriptPubKey
  )
  const ownChangeSats = qbitAccountSats(classified.unconfirmedOwnChange, p2mrScriptPubKey)
  const classifiedImmatureSats = qbitAccountSats(classified.immature, p2mrScriptPubKey)
  const availableBalance = qbitAvailableSats(
    aggregateBalance.totalBalance,
    aggregateBalance.availableBalance,
    qbitAccountSats(classified.confirmedSpendable, p2mrScriptPubKey, reserved),
    qbitAccountSats(classified.unconfirmedOwnChange, p2mrScriptPubKey, reserved)
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

/**
 * The split once the listing or the classification of the outputs failed
 * with `error`, not the deadline: past the explorer's UTXO limit, as
 * `getQbitPastLimitSplit` finds it or unknown (`utxoLimitExceeded`); after
 * any other failure, unknown and failed (`utxoReadIncomplete` and
 * `utxoReadFailed`), a bare 500 whose statistics could not be read again in
 * time included. A refusal the explorer states needs the statistics read
 * again (`qbitUtxoListOverExplorerLimitStats`), so their failure, or their
 * not answering by the deadline, fails the read.
 */
async function qbitSplitPastFailedListing(
  client: QbitEsploraClient,
  address: string,
  error: unknown,
  aggregateBalance: QbitBalanceSummaryPayload & { availableBalance: number },
  p2mrScriptPubKey: string | undefined,
  readReserved: (() => Promise<ReadonlySet<string>>) | undefined,
  readOutputs: ((stats: string) => QbitOutputRead | undefined) | undefined,
  operation: QbitBalanceReadOperation
): Promise<QbitBalanceSummaryPayload> {
  let stats: EsploraAddressStats | undefined
  try {
    stats = await qbitUtxoListOverExplorerLimitStats(
      client,
      address,
      error,
      { signal: operation.signal },
      QBIT_BALANCE_RIDE_OUT
    )
  } catch (statsFailure) {
    operation.throwIfCancelled()
    if (!operation.timedOut) throw statsFailure
    // A bare 500 whose statistics did not answer stays an ordinary failure.
    if (qbitUtxoListRefusal(error)?.stated) throw operation.timeoutError
    return qbitIncompleteSplit(aggregateBalance, true)
  }
  if (!stats) return qbitIncompleteSplit(aggregateBalance, true)
  // The split takes the statistics this check read: one read, so the two
  // can never disagree.
  const split = readOutputs
    ? await getQbitPastLimitSplit(
        client,
        stats,
        p2mrScriptPubKey,
        readReserved,
        readOutputs,
        operation
      )
    : undefined
  if (split) return split
  // The statistics still give the total. With no output list none of it
  // can be classified, so the split is unknown rather than 0, and none of
  // it can be selected until a send reads the outputs from history.
  return { ...qbitUnknownSplit(aggregateBalance), utxoLimitExceeded: true }
}

/** The total with its split unknown: none of it counts as available. */
function qbitUnknownSplit(aggregateBalance: QbitBalanceSummaryPayload): QbitBalanceSummaryPayload {
  const totalBalance = Math.max(0, aggregateBalance.totalBalance)
  return {
    availableBalance: null,
    unavailableBalance: totalBalance,
    totalBalance,
    immatureBalance: null,
    pendingBalance: null,
  }
}

/**
 * The total with its split unknown, as the outputs were not read in full
 * (`utxoReadIncomplete`): `failed` when the read got no further
 * (`utxoReadFailed`), as it stopped on a failure or ran out of time with
 * nothing new kept for the next read.
 */
function qbitIncompleteSplit(
  aggregateBalance: QbitBalanceSummaryPayload,
  failed: boolean
): QbitBalanceSummaryPayload {
  return {
    ...qbitUnknownSplit(aggregateBalance),
    utxoReadIncomplete: true,
    ...(failed ? { utxoReadFailed: true } : {}),
  }
}

/**
 * The split of an address over the explorer's UTXO limit from the outputs a
 * read of its history found, or `undefined` (unknown) without a read made
 * against `stats`, the statistics as they read now: any new transaction for
 * the address changes them, nor once a coinbase output the read left out as
 * immature has matured, or one it took in is immature again. The total and
 * the confirmed balance come from
 * those same statistics, and Available is bounded by them as on the listing
 * path (`qbitAvailableSats`), less the outputs `readReserved` names;
 * Unavailable is the rest. The read leaves immature and pending outputs
 * out, so those stay unknown. The tip and the send guard are read within
 * `operation`'s deadline; past it the split is unknown too.
 */
async function getQbitPastLimitSplit(
  client: QbitEsploraClient,
  stats: EsploraAddressStats,
  p2mrScriptPubKey: string | undefined,
  readReserved: (() => Promise<ReadonlySet<string>>) | undefined,
  readOutputs: (stats: string) => QbitOutputRead | undefined,
  operation: QbitBalanceReadOperation
): Promise<QbitBalanceSummaryPayload | undefined> {
  let balance: AddressBalance
  try {
    balance = addressBalanceFromStats(stats)
  } catch {
    return undefined
  }
  const read = readOutputs(qbitStatsSnapshot(stats))
  if (!read) return undefined
  // A coinbase output matures with no change to the statistics, and turns
  // immature again when the chain rolls back: once one the read left out
  // has matured, or one it took in is immature again, the read is out of
  // date. The tip is read only for a read with coinbase outputs.
  if (read.matureAt !== undefined || read.matureFrom !== undefined) {
    let tipHeight: number
    try {
      tipHeight = await withQbitReadRetries(
        () => client.getTipHeight({ signal: operation.signal }),
        operation.signal,
        QBIT_TIP_RETRY_STATUSES,
        { schedule: QBIT_BALANCE_RIDE_OUT }
      )
    } catch {
      operation.throwIfCancelled()
      return undefined
    }
    if (
      !Number.isSafeInteger(tipHeight) ||
      (read.matureAt !== undefined && tipHeight >= read.matureAt) ||
      (read.matureFrom !== undefined && tipHeight < read.matureFrom)
    ) {
      return undefined
    }
  }
  const { outputs } = read
  let reserved: ReadonlySet<string> | undefined
  if (readReserved) {
    try {
      reserved = await operation.within(readReserved())
    } catch (error) {
      operation.throwIfCancelled()
      if (operation.timedOut) return undefined
      throw error
    }
  }
  // One pass over what may be tens of thousands of outputs, on every poll.
  let confirmedSelectableSats = 0
  let ownChangeSelectableSats = 0
  for (const output of outputs) {
    if (!isQbitSelectableOutput(output, p2mrScriptPubKey, reserved)) continue
    if (output.unconfirmed) ownChangeSelectableSats += output.satoshis
    else confirmedSelectableSats += output.satoshis
  }
  const totalBalance = Math.max(0, balance.totalSats)
  const availableBalance = qbitAvailableSats(
    totalBalance,
    balance.confirmedSats,
    confirmedSelectableSats,
    ownChangeSelectableSats
  )
  return {
    availableBalance,
    unavailableBalance: totalBalance - availableBalance,
    totalBalance,
    immatureBalance: null,
    pendingBalance: null,
    utxoLimitExceeded: true,
  }
}

/**
 * The value of the account's own outputs among `outputs`, less the ones
 * `reserved` holds (`isQbitSelectableOutput`).
 */
function qbitAccountSats(
  outputs: readonly QbitReadOutput[],
  p2mrScriptPubKey: string | undefined,
  reserved?: ReadonlySet<string>
): number {
  let sats = 0
  for (const output of outputs) {
    if (isQbitSelectableOutput(output, p2mrScriptPubKey, reserved)) sats += output.satoshis
  }
  return sats
}

/**
 * Whether a send may select `output`: the account's own
 * (`isQbitAccountOutput`), and not held by `reserved`, which names
 * outpoints as `txid:vout`, the txid in lower case (`QbitSendGuardService`).
 */
function isQbitSelectableOutput(
  output: QbitReadOutput,
  p2mrScriptPubKey: string | undefined,
  reserved: ReadonlySet<string> | undefined
): boolean {
  return (
    isQbitAccountOutput(output, p2mrScriptPubKey) &&
    !reserved?.has(`${output.txid.toLowerCase()}:${output.vout}`)
  )
}

/**
 * Available as a send sees it (see `getQbitAddressUtxos`), on either balance
 * path: the confirmed outputs a send may select, never more than the
 * confirmed balance, plus the selectable unconfirmed change of this
 * script's own transactions, never more than the total.
 */
function qbitAvailableSats(
  totalSats: number,
  confirmedSats: number,
  confirmedSelectableSats: number,
  ownChangeSelectableSats: number
): number {
  return Math.min(
    Math.max(0, totalSats),
    Math.min(Math.max(0, confirmedSats), confirmedSelectableSats) + ownChangeSelectableSats
  )
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
  /** With `immature` outputs: the earliest tip height at which one of them matures. */
  matureAt?: number
  /**
   * With coinbase outputs in `spendable`: the lowest tip height at which
   * every one of them is still mature. Below it, as after a rollback, one
   * is immature again.
   */
  matureFrom?: number
  /**
   * Outputs read from history only: the address statistics the walk
   * verified. They read the same before and after it, and its outputs
   * reconcile with them.
   */
  historyStats?: EsploraAddressStats
}

/**
 * A read that its caller can cancel: `signal` reaches every request it
 * makes and every pause between them, so a read nothing waits for any more
 * stops (an over-limit walk can run for minutes).
 */
export type QbitReadCancellation = Pick<RequestOptions, 'signal'>

/**
 * A classification of an address's outputs that its caller can cancel, and
 * the shared reader its reads go through, when given (see
 * `QbitFundingTxReads`): the read limiter of every classification through
 * the same client, and the facts of funding transactions read before, which
 * spare a read of each confirmed output already classified. Without one its
 * reads still go through a limiter of its own, and nothing is kept.
 */
export interface QbitClassifyOptions extends QbitReadCancellation {
  fundingTxReads?: QbitFundingTxReads
  /**
   * A view of `fundingTxReads` the caller began (`QbitFundingTxReads.begin`)
   * when it was asked for these outputs, before awaits of its own: the read
   * takes its place among the reader's clears from it, so a clear since then
   * (a lock, a keyring removal) leaves it keeping and served nothing. It sets
   * that place alone: what may be served or kept stays the classifier's rule,
   * and a view another reader began is refused.
   */
  facts?: QbitFundingFactsView
}

/** Throw the abort reason once `options.signal` has aborted: a failure then is the cancellation. */
function throwIfQbitReadCancelled(options: QbitReadCancellation): void {
  if (options.signal?.aborted) throw options.signal.reason
}

/** Only the cancellation of `options`, as a request takes it. */
function qbitReadOptions(options: QbitReadCancellation): QbitReadCancellation {
  return options.signal ? { signal: options.signal } : {}
}

/**
 * `options` with the view of the shared reader of a read beginning now, made
 * before its first request, so that a clear while it lists the outputs, reads
 * the statistics or walks the history, not only while it classifies them,
 * leaves it keeping and served nothing (`QbitFundingTxReads.clear`). A view
 * begun earlier (`options.facts`) keeps its place, through `client`.
 */
function qbitClassifyStarted<T extends QbitClassifyOptions>(
  client: QbitEsploraClient,
  options: T
): T {
  if (options.fundingTxReads === undefined) return options
  return { ...options, facts: options.fundingTxReads.begin(client, options.facts) }
}

/**
 * The address's listed outputs, classified (see `QbitClassifiedUtxos`) from
 * each one's funding transaction, which must agree with the listing: the
 * txid, the output's value, a P2MR script. See `classifyQbitUtxos` for how
 * the reads behind it are bounded, shared and kept; this read of outputs,
 * like every other, keeps the strict rule for kept "not a coinbase" facts.
 * Once `options.signal` aborts it rejects with its reason.
 */
export async function getQbitAddressUtxosClassified(
  client: QbitEsploraClient,
  address: string,
  options: QbitClassifyOptions = {}
): Promise<QbitClassifiedUtxos> {
  return listAndClassifyQbitUtxos(client, address, {
    ...qbitReadOptions(options),
    ...(options.fundingTxReads ? { fundingTxReads: options.fundingTxReads } : {}),
    ...(options.facts ? { facts: options.facts } : {}),
  })
}

/**
 * What a classification kept for the next one, noted as it keeps facts: the
 * outputs the listing reports confirmed whose facts were not kept already,
 * which a later balance read is served while they stay kept. Facts kept
 * again, and those of unconfirmed outputs, which are read afresh every time,
 * are not noted. Another address's read through the same reader can push
 * them out before this one answers, so whether any is kept still is asked of
 * `facts`, the view the classification kept them through. `listing` is the
 * listing it classified, noted as soon as it is read, for the balance read
 * to keep (see `keepQbitBalanceRead`).
 */
interface QbitClassifyProgress {
  readonly kept: [txid: string, vout: number][]
  facts?: QbitFundingFactsView | undefined
  listing?: readonly EsploraUtxo[]
}

/**
 * What no exported read takes from its caller: `balanceOnly`, `progress`,
 * `tip` and `freshListing`, which only the balance read sets (see
 * `classifyQbitUtxos`; `tip` is the one it asked for before the listing,
 * with its statistics, and `freshListing` asks for the listing fresh,
 * `QbitTxOutspendsOptions.fresh`), `spendCandidates`, which only the
 * candidate read of outputs a send may select sets (`readQbitAddressUtxos`),
 * and `rideOutServerErrors`, which only `readQbitAddressUtxosRidingOut`
 * sets: its lookups, listing and tip ride out the explorer's server errors
 * (`withQbitReadRetries`), where every
 * other read fails on one at once, the balance read aside: with
 * `balanceOnly` they ride them out on a shorter schedule of its own
 * (`QBIT_BALANCE_RIDE_OUT`), and its classification keeps what it read when
 * a group fails (`QbitClassificationReads`).
 */
interface QbitClassifyInternals {
  balanceOnly?: true
  progress?: QbitClassifyProgress
  /** With `balanceOnly`, the listing the read asked for already (`askQbitBalanceListing`). */
  listed?: Promise<EsploraUtxo[]>
  spendCandidates?: true
  rideOutServerErrors?: true
  tip?: QbitTipRead
  freshListing?: true
}

/**
 * `getQbitAddressUtxosClassified`, and the balance read's classification,
 * which alone sets `balanceOnly` and `progress` (see `QbitClassifyInternals`).
 */
async function listAndClassifyQbitUtxos(
  client: QbitEsploraClient,
  address: string,
  begun: QbitClassifyOptions & QbitClassifyInternals
): Promise<QbitClassifiedUtxos> {
  const options = qbitClassifyStarted(client, begun)
  const addressScript = qbitAddressScript(address)
  // Asked for with the listing, as one small request, when the
  // classification may judge outputs by it (the deep outputs of the balance
  // read and of the candidate read, or kept facts with a shared reader), so
  // that it has usually answered before any output needs it (see
  // `classifyQbitOutputs`). Without the address's script neither applies: it
  // is asked for only once a coinbase output's maturity needs it, as before.
  const judgesByTip =
    options.balanceOnly === true ||
    options.spendCandidates === true ||
    options.fundingTxReads !== undefined
  const tip =
    options.tip ??
    (addressScript !== undefined && judgesByTip
      ? new QbitTipRead(client, options.signal, qbitRideOutSchedule(options))
      : undefined)
  tip?.start()
  let utxos: EsploraUtxo[]
  try {
    utxos = await (options.listed ?? listQbitUtxos(client, address, options))
  } catch (error) {
    // Nothing is classified: the tip is not read on.
    tip?.close()
    throw error
  }
  if (options.progress) options.progress.listing = utxos
  return classifyQbitUtxos(client, utxos, {
    ...options,
    ...(addressScript !== undefined ? { addressScript } : {}),
    ...(tip ? { tip } : {}),
  })
}

/**
 * The schedule on which a classification's listing and tip ride out the
 * explorer's server errors (`withQbitReadRetries`): the Send screen's with
 * `rideOutServerErrors`, the balance read's with `balanceOnly`, and none for
 * any other read.
 */
function qbitRideOutSchedule(
  options: Pick<QbitClassifyInternals, 'rideOutServerErrors' | 'balanceOnly'>
): QbitRideOutSchedule | undefined {
  if (options.rideOutServerErrors) return QBIT_SEND_SCREEN_RIDE_OUT
  return options.balanceOnly ? QBIT_BALANCE_RIDE_OUT : undefined
}

/**
 * The address's listed outputs, each checked, and none listed twice. A
 * listing whose body could not be read is asked for again, and with
 * `rideOutServerErrors` or `balanceOnly` one the explorer answered with a
 * 502, 503 or 504, on that read's schedule (`qbitRideOutSchedule`); any
 * other failure, a bare 500 and a refusal the explorer states included, is
 * the caller's to judge as before. With `freshListing` each request is a
 * fresh read (`QbitTxOutspendsOptions.fresh`).
 */
async function listQbitUtxos(
  client: QbitEsploraClient,
  address: string,
  options: QbitReadCancellation &
    Pick<QbitClassifyInternals, 'rideOutServerErrors' | 'balanceOnly' | 'freshListing'>
): Promise<EsploraUtxo[]> {
  const schedule = qbitRideOutSchedule(options)
  let utxos: EsploraUtxo[]
  try {
    utxos = await withQbitReadRetries(
      () =>
        client.getAddressUtxos(
          address,
          options.freshListing ? qbitFreshRead(qbitReadOptions(options)) : qbitReadOptions(options)
        ),
      options.signal,
      schedule ? QBIT_LISTING_RETRY_STATUSES : undefined,
      schedule ? { schedule } : {}
    )
  } catch (error) {
    throwIfQbitReadCancelled(options)
    throw error
  }
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
  return utxos
}

/**
 * The chain tip, asked for at most once for one classification
 * (`classifyQbitOutputs`), under its own signal: that aborts with `signal`,
 * the caller's, and once `close` is called, when the classification has
 * ended or its listing failed, as nothing waits for a tip that has not
 * answered by then. `settled` once it has answered or failed, its further
 * attempts included; `height`, its answer, when that is a height.
 */
class QbitTipRead {
  settled = false
  height: number | undefined
  private read: Promise<number> | undefined
  private readonly controller = new AbortController()
  private readonly release: () => void

  constructor(
    private readonly client: QbitEsploraClient,
    signal: AbortSignal | undefined,
    private readonly rideOut?: QbitRideOutSchedule
  ) {
    const onAbort = (): void => this.controller.abort(signal?.reason)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    this.release = (): void => signal?.removeEventListener('abort', onAbort)
  }

  /**
   * The tip, asked for on the first call: one request, so not held to the
   * limiter, made again as a lookup is after a body lost, and with `rideOut`
   * after a 502, 503 or 504, on that schedule (`withQbitReadRetries`), under
   * its own signal, so that `close` ends a pause at once.
   */
  start(): Promise<number> {
    if (!this.read) {
      // Asked for at once, so it is in flight before the listing it goes with.
      const { signal } = this.controller
      const read = withQbitReadRetries(
        () => this.client.getTipHeight({ signal }),
        signal,
        this.rideOut ? QBIT_TIP_RETRY_STATUSES : undefined,
        this.rideOut ? { schedule: this.rideOut } : {}
      )
      read.then(
        height => {
          if (Number.isSafeInteger(height) && height >= 0) this.height = height
          this.settled = true
        },
        () => {
          this.settled = true
        }
      )
      this.read = read
    }
    return this.read
  }

  /** Abort it unless it has answered, and let go of the caller's signal. */
  close(): void {
    this.release()
    this.controller.abort(new QbitApiError('aborted', 'qbit tip read no longer needed'))
  }
}

/**
 * A balance read has more outputs to read one by one, those its listing, and
 * the tip if it has answered, cannot show a coinbase maturity deep, than its
 * shared reader keeps facts of (`QbitFundingTxReads.maxOutpoints`), so it
 * reads none of them (see `getQbitSpendableBalanceV2`).
 */
class QbitOutputsPastFactsCapError extends Error {
  constructor(outputs: number, maxOutpoints: number) {
    super(`${outputs} outputs to read, more than the ${maxOutpoints} the wallet keeps facts of`)
    this.name = 'QbitOutputsPastFactsCapError'
  }
}

/**
 * The class of a listed output the listing reports confirmed at least a
 * coinbase maturity deep, from the listing alone (the balance read's
 * shortcut, see `classifyQbitUtxos`): spendable and mature whether or not its
 * transaction is a coinbase, with the listed value and `script`, the script
 * of the address read.
 */
function qbitDeepOutputClass(utxo: EsploraUtxo, script: string): QbitOutputClass {
  return {
    confirmed: true,
    immature: false,
    ownAncestry: undefined,
    utxo: {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.value,
      scriptPk: script,
      addressType: AddressType.P2MR,
    },
  }
}

/**
 * The script paying `address`, in lower-case hex, as every output its
 * listing names pays it; undefined for an address that is not a P2MR address
 * of a qbit network, for which nothing is kept or served (see
 * `classifyQbitUtxos`).
 */
function qbitAddressScript(address: string): string | undefined {
  try {
    return bytesToHex(addressToScriptPubKey(address)).toLowerCase()
  } catch {
    return undefined
  }
}

/** A listed output, with its place in the listing. */
interface QbitListedOutput {
  index: number
  vout: number
  utxo: EsploraUtxo
}

/** What the classification makes of one listed output (`classifyQbitOutput`). */
interface QbitOutputClass {
  utxo: UTXO
  confirmed: boolean
  immature: boolean
  /** A coinbase output's: the lowest tip height at which it is mature. */
  matureAt?: number
  ownAncestry: Map<string, number> | undefined
}

/**
 * Classify listed outputs as `getQbitAddressUtxosClassified` describes.
 * Each funding transaction is read once, however many of its outputs are
 * listed, and checked against each of them before it is classified;
 * `historyTxs`, from a read of the address's history, supplies the
 * confirmed ones instead.
 *
 * Every read goes through a limiter (`QbitClassificationReads`): at most
 * `QBIT_CLASSIFY_MAX_READS_IN_FLIGHT` in flight, funding transactions and
 * ancestors together, shared with every other classification through the
 * same client when `options.fundingTxReads` is given. Outputs are taken in
 * turn by that many workers, each starting its next read only once its last
 * one has ended, so a long read never queues thousands ahead of another's;
 * once a classification has started `QBIT_CLASSIFY_BURST_LOOKUPS` lookups,
 * it holds its own reads to `QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT` in
 * flight, its other workers waiting for their turn with no slot held.
 * A read whose reply's body could not be read, as when the connection is
 * lost in the middle of it, is made again twice at most, and with
 * `rideOutServerErrors` a read of a transaction for its own outputs that the
 * explorer answered with a server error four times over about 14 s, in the
 * slot it holds (`withQbitReadRetries`); only then does it count as failed.
 * With `balanceOnly` such a read is made again twice, after 500 ms and
 * 1,500 ms, each attempt in a slot of its own, for at most
 * `QBIT_BALANCE_READ_RIDE_OUT_LOOKUPS` lookups (`QBIT_BALANCE_RIDE_OUT`).
 * The first failure, or the caller's signal, stops it: no read starts any
 * more, those in flight are cancelled, and it rejects with that failure or
 * `signal.reason`. The balance read's alone (`balanceOnly`) goes on past a
 * failure, keeping what the lookups in flight and those after it read, until
 * `QBIT_BALANCE_READ_FAILED_LOOKUPS` lookups have failed, and only then
 * rejects with the first failure; its caller's signal stops it at once.
 *
 * With a shared reader, an output the listing reports confirmed is
 * classified from the facts an earlier read of its transaction left
 * (`QbitFundingOutputFacts`), checked against the listing as the read was;
 * the facts of each output read are kept as soon as they are checked, so
 * reads that complete stay useful whatever happens to the rest. Kept facts
 * that say a transaction is a coinbase always serve, its maturity judged
 * from the fresh listing and tip. Kept facts that say it is not serve a
 * read of outputs (anything a send, sweep or plan may spend) only for an
 * output the fresh listing puts at least as deep as a coinbase output must
 * be to mature (`qbitKeptFactsServe`): until then one wrong answer would let
 * a send spend an immature reward, so the transaction is read afresh. Depth
 * is measured from the highest block the listing itself puts an output in,
 * which the tip has reached, and from the tip, read once a classification,
 * only for outputs that block cannot show deep: those are judged by it once
 * it has answered, and set aside until then. A worker left with nothing else
 * to take before it has answered reads them afresh at once, as when the tip
 * cannot be read, so nothing but a coinbase output's maturity ever waits for
 * the tip, and the tip is not read on once the classification has ended. A
 * read of outputs that may judge outputs by the tip, a balance read or one
 * with a shared reader of an address whose script is known, asks for it with
 * the listing (`options.tip`), so it has usually answered before any output
 * needs it; others ask for it once one does. An unconfirmed output's
 * transaction is always read afresh too: its ownership walk reads the
 * transaction's inputs and size, which its txid does not fix, and whether an
 * ancestor is confirmed is never kept. A transaction another classification
 * is reading for its facts is taken last, by when it is usually kept.
 *
 * Facts are kept, and served, only with the script of the address read
 * (`addressScript`): every output its listing names pays that script, so an
 * answer giving another is wrong for this read, used for it alone as any
 * fresh answer is, and not kept; the next read reads the transaction again.
 * Without `addressScript` (an address that cannot be decoded) nothing is
 * kept or served.
 *
 * `balanceOnly`, which only the balance read sets (`getQbitSpendableBalanceV2`),
 * lets kept "not a coinbase" facts serve at any confirmed depth, so a poll of
 * an unchanged address reads no transaction: its answer is a few totals,
 * which no send, sweep or plan takes inputs from. The residual: after one
 * wrong `is_coinbase` answer the balance can count a reward younger than
 * 1,000 blocks as Available until a read of outputs or a clear replaces the
 * kept fact. No send can select it, as every read of outputs keeps the rule
 * above, and its fresh answer replaces the kept one.
 *
 * With `balanceOnly` and `addressScript`, an output the listing reports
 * confirmed at least a coinbase maturity (1,000 blocks) deep is classified
 * from the fresh listing alone, as spendable and mature with the listed value
 * and the address's script: a coinbase or not, it is mature. Its transaction
 * is not read, and no facts are served, kept, counted or marked used for it.
 * So for such an output nothing checks the explorer's transaction against
 * its listing (txid, output index, value, P2MR script): the listing alone is
 * believed, and Available stays bounded by the address statistics
 * (`qbitAvailableSats`). Its coinbase standing is unknown, so it adds nothing
 * to `matureFrom`, which the balance does not use. Depth is judged as for
 * kept facts: from the listing's newest block, then from the tip for outputs
 * that block cannot show deep and no kept facts serve, which are set aside
 * while the tip is read and read as before when it cannot be read, or has
 * not answered by the time a worker has nothing else left to take. Younger
 * and unconfirmed outputs are classified as before. Past `maxOutpoints`
 * outputs still to read one by one, those the listing, and the tip if it has
 * answered by then, cannot show deep, it rejects with
 * `QbitOutputsPastFactsCapError` before reading any, without waiting for the
 * tip: no output may be read before that is settled, so the workers would
 * have nothing to do while waiting for it.
 *
 * `spendCandidates`, which only the candidate read of the outputs a send may
 * select sets (`readQbitAddressUtxos`), takes that same shortcut for its
 * deep outputs, and nothing else of `balanceOnly`: its kept facts serve by
 * the strict rule above, it has no `maxOutpoints` bound, and its younger and
 * unconfirmed outputs are read and classified as before. Its deep outputs
 * are candidates, nothing checked: every input a transaction spends is read
 * and checked against its funding transaction before the first signature
 * over it (`checkQbitSpendInputs`), whatever read listed it. No other read
 * of outputs takes this path: the recovery sources and `getQbitAddressUtxos`
 * still read and check every funding transaction.
 */
async function classifyQbitUtxos(
  client: QbitEsploraClient,
  utxos: readonly EsploraUtxo[],
  options: QbitClassifyOptions &
    QbitClassifyInternals & {
      historyTxs?: ReadonlyMap<string, EsploraTx>
      addressScript?: string
      /** The tip, asked for with the listing; otherwise asked for once an output needs it. */
      tip?: QbitTipRead
    } = {}
): Promise<QbitClassifiedUtxos> {
  const rideOut = options.rideOutServerErrors === true
  const tip = options.tip ?? new QbitTipRead(client, options.signal, qbitRideOutSchedule(options))
  let reads: QbitClassificationReads | undefined
  try {
    // The balance read's keeps what it read when a group fails.
    reads = new QbitClassificationReads(
      client,
      options.fundingTxReads,
      options.signal,
      options.facts,
      rideOut,
      false,
      options.balanceOnly === true
    )
    return qbitClassifiedFrom(
      await classifyQbitOutputs(
        utxos,
        reads,
        tip,
        options.historyTxs,
        options.balanceOnly === true,
        options.progress,
        options.addressScript,
        options.balanceOnly ? options.fundingTxReads?.maxOutpoints : undefined,
        options.spendCandidates === true
      )
    )
  } finally {
    reads?.close()
    tip.close()
  }
}

/** Each listed output's class, in listing order (`classifyQbitUtxos`). */
async function classifyQbitOutputs(
  utxos: readonly EsploraUtxo[],
  reads: QbitClassificationReads,
  tip: QbitTipRead,
  historyTxs: ReadonlyMap<string, EsploraTx> | undefined,
  balanceOnly: boolean,
  progress: QbitClassifyProgress | undefined,
  addressScript: string | undefined,
  maxOutpoints: number | undefined,
  spendCandidates: boolean
): Promise<(QbitOutputClass | undefined)[]> {
  // The listed outputs of each funding transaction, with their place in the listing.
  const groups = new Map<string, QbitListedOutput[]>()
  utxos.forEach((utxo, index) => {
    const txid = utxo.txid.toLowerCase()
    const group = groups.get(txid)
    if (group) group.push({ index, vout: utxo.vout, utxo })
    else groups.set(txid, [{ index, vout: utxo.vout, utxo }])
  })
  const classes = new Array<QbitOutputClass | undefined>(utxos.length)
  // The coinbase maturity check waits for the tip, and for nothing else.
  const getTipHeightOnce = (): Promise<number> => tip.start()
  // The tip is at least as high as the highest block the fresh listing puts
  // a confirmed output in, so that block alone shows most kept outputs deep
  // enough to serve (`qbitKeptFactsServe`).
  const listedTipFloor = utxos.reduce(
    (highest, { status }) =>
      status.confirmed && status.block_height !== undefined
        ? Math.max(highest, status.block_height)
        : highest,
    -1
  )
  // The height the tip is known to have reached: the listing's, or the
  // tip's own once it has answered.
  const tipFloor = (): number =>
    tip.height === undefined ? listedTipFloor : Math.max(listedTipFloor, tip.height)
  // The tip itself, for outputs that floor cannot show deep, asked for if
  // it was not with the listing: whether it has answered, and the floor it
  // shows. When it cannot be read, or has not answered once nothing else is
  // left to do, those outputs are read afresh rather than failing, or
  // holding up, a classification that may need no tip. Nothing waits for it
  // but the coinbase maturity check, which takes the tip alone
  // (`getTipHeightOnce`), never a floor.
  const readFactsTipOnce = (): { settled: boolean; floor: number } => {
    tip.start()
    return { settled: tip.settled, floor: tipFloor() }
  }
  // The shortcut of the balance read and of the candidate read (see
  // `classifyQbitUtxos`): with the script of the address read, an output
  // confirmed at least a coinbase maturity deep is classified from the
  // listing alone, and its transaction is not read.
  const deepScript = (balanceOnly || spendCandidates) && !historyTxs ? addressScript : undefined
  const deepBelow = (listed: readonly QbitListedOutput[], tipFloor: number): boolean =>
    listed.every(
      ({ utxo: { status } }) =>
        status.confirmed &&
        status.block_height !== undefined &&
        isQbitCoinbaseMature(status.block_height, tipFloor)
    )
  const classifyDeep = (listed: readonly QbitListedOutput[], script: string): void => {
    for (const { index, utxo } of listed) classes[index] = qbitDeepOutputClass(utxo, script)
  }
  if (deepScript !== undefined) {
    for (const [txid, listed] of groups) {
      if (!deepBelow(listed, listedTipFloor)) continue
      classifyDeep(listed, deepScript)
      groups.delete(txid)
    }
    // Only the outputs still to read one by one need facts kept: past what
    // the shared reader keeps, each poll would push out what the next needs
    // and never finish, so none is read. Those only the tip could show deep
    // count too unless it has answered by now, as it usually has, asked for
    // with the listing: it is not waited for, as no output may be read before
    // this is settled, so the workers would have nothing to do meanwhile,
    // and were the tip not to answer they would read those at once.
    if (maxOutpoints !== undefined) {
      const floor = tipFloor()
      let count = 0
      for (const listed of groups.values()) {
        if (!deepBelow(listed, floor)) count += listed.length
      }
      if (count > maxOutpoints) throw new QbitOutputsPastFactsCapError(count, maxOutpoints)
    }
  }
  // Every kept output of the listing counts as used before any is read
  // afresh, so what this read keeps pushes out other addresses' facts first,
  // never those of its own it has yet to come to: otherwise, after a switch
  // between accounts that fit only one at a time, each output read afresh
  // would push out one further along, and the whole listing would be read.
  // The outputs classified from the listing alone use no facts.
  for (const txid of groups.keys()) reads.facts?.touch(txid)
  if (progress) progress.facts = reads.facts
  // Transactions this classification found confirmed: an ownership walk that
  // reaches one needs no read of it.
  const confirmed = new Set<string>(historyTxs?.keys())
  const ancestors = new Map<string, Promise<EsploraTx | undefined>>()
  const getAncestorOnce = (txid: string): Promise<EsploraTx | undefined> => {
    let ancestor = ancestors.get(txid)
    if (!ancestor) {
      ancestor = confirmed.has(txid)
        ? Promise.resolve(qbitConfirmedAncestor(txid))
        : getQbitAncestorTx(reads, txid)
      ancestors.set(txid, ancestor)
    }
    return ancestor
  }
  // Groups only the tip can show deep enough, set aside while it is being
  // read so that no worker waits for it.
  const awaitingTip: [string, QbitListedOutput[]][] = []
  /**
   * Classify a group. One only the tip can show deep enough is set aside
   * while the tip is being read, unless taken `last`, from those set aside:
   * then it is judged by the tip once that has answered, and read afresh at
   * once if it has not, rather than waiting for it.
   */
  const classifyGroup = async (
    txid: string,
    listed: QbitListedOutput[],
    last: boolean
  ): Promise<void> => {
    const historyTx = historyTxs?.get(txid)
    // Only facts with the script of the address read serve it.
    const found =
      addressScript !== undefined && !historyTx && listed.every(({ utxo }) => utxo.status.confirmed)
        ? reads.facts?.get(txid, listed)
        : undefined
    const kept = found?.every(({ facts }) => facts.script.toLowerCase() === addressScript)
      ? found
      : undefined
    // Kept "not a coinbase" answers skip the maturity check, so one wrong
    // answer would let a send spend an immature reward for as long as it is
    // kept. For a read of outputs they serve only an output buried as deep as
    // a coinbase must be to mature, where the answer no longer matters; a
    // younger one is read afresh, as every read was before facts were kept.
    // The balance read, which nothing spends from, takes them at any depth.
    let known = kept && (balanceOnly || qbitKeptFactsServe(kept, listedTipFloor)) ? kept : undefined
    if (kept && !known) {
      const tip = readFactsTipOnce()
      if (!tip.settled && !last) {
        awaitingTip.push([txid, listed])
        return
      }
      if (tip.settled && qbitKeptFactsServe(kept, tip.floor)) known = kept
    }
    // A confirmed output of the balance read that its listing cannot show
    // deep, and no kept facts serve: the tip may, and otherwise it is read.
    if (!known && deepScript !== undefined && listed.every(({ utxo }) => utxo.status.confirmed)) {
      const tip = readFactsTipOnce()
      if (!tip.settled && !last) {
        awaitingTip.push([txid, listed])
        return
      }
      if (tip.settled && deepBelow(listed, tip.floor)) {
        classifyDeep(listed, deepScript)
        return
      }
    }
    if (known) {
      confirmed.add(txid)
      for (const {
        output: { index, utxo },
        facts,
      } of known) {
        if (facts.value !== utxo.value) {
          // Not served, and not kept: the next read of it reads it afresh.
          reads.facts?.forget(txid)
          throw qbitUtxoValueMismatchError(utxo)
        }
        classes[index] = await classifyQbitOutput(
          utxo,
          facts,
          undefined,
          getTipHeightOnce,
          getAncestorOnce
        )
      }
      return
    }
    // An unconfirmed funding transaction is read whole every time, as the
    // ownership walk behind its change reads every prevout.
    const tx = historyTx ?? (await reads.tx(txid, true))
    for (const { index, utxo } of listed) {
      let facts: QbitFundingOutputFacts
      try {
        facts = qbitFundingOutputFacts(tx, utxo)
      } catch (error) {
        // A fresh answer that fails the checks cost a request and keeps nothing.
        if (!historyTx) reads.answerRefused()
        throw error
      }
      // An answer with another script is used for this read alone.
      if (
        !historyTx &&
        facts.script.toLowerCase() === addressScript &&
        reads.facts?.keep(txid, utxo.vout, facts) &&
        utxo.status.confirmed
      ) {
        progress?.kept.push([txid, utxo.vout])
      }
      classes[index] = await classifyQbitOutput(utxo, facts, tx, getTipHeightOnce, getAncestorOnce)
    }
    if (!historyTx && tx.status?.confirmed === true) {
      // Nothing more reads it but a walk reaching it, which needs no more
      // than that it is confirmed.
      confirmed.add(txid)
      reads.forget(txid)
    }
  }

  const pending = groups.entries()
  const deferred: [string, QbitListedOutput[]][] = []
  let nextDeferred = 0
  let nextAwaitingTip = 0
  // The groups in turn: those another classification is reading come after
  // the rest, and those set aside for the tip as soon as it has answered, or
  // last of all, when only they are left: then each is read at once if the
  // tip has still not answered, as it was before facts were kept, rather
  // than leave the worker waiting for a tip that may hang. Were they taken
  // only last, a balance's outputs judged by the tip would wait behind every
  // unconfirmed one, read afresh each time, and a read cut off by its
  // deadline would keep none of them.
  const nextGroup = (): { group: [string, QbitListedOutput[]]; last: boolean } | undefined => {
    const ready = tip.settled ? awaitingTip[nextAwaitingTip] : undefined
    if (ready) {
      nextAwaitingTip += 1
      return { group: ready, last: true }
    }
    for (let next = pending.next(); !next.done; next = pending.next()) {
      const [txid, listed] = next.value
      if (
        !historyTxs?.has(txid) &&
        reads.facts?.fetchingElsewhere(txid) &&
        listed.every(({ utxo }) => utxo.status.confirmed)
      ) {
        deferred.push(next.value)
        continue
      }
      return { group: next.value, last: false }
    }
    const later = deferred[nextDeferred++]
    if (later) return { group: later, last: false }
    const waiting = awaitingTip[nextAwaitingTip++]
    return waiting ? { group: waiting, last: true } : undefined
  }
  // As many workers as the bound allows in flight, as 1.0.9 read: past its
  // burst the classification holds its lookups to the sustained rate itself
  // (`QbitClassificationReads`), where 256 and then 96 held for as long met
  // bursts of the explorer's 502s. Groups its kept facts serve cost no
  // request, so a worker takes the next one at once.
  const workers = Math.min(reads.limiter.maxInFlight, groups.size)
  await reads.run(workers, async () => {
    for (let next = nextGroup(); next; next = nextGroup()) {
      if (!reads.taking) {
        // Left unread: the balance read's then fails (see `QbitClassificationReads`).
        reads.groupUntaken()
        break
      }
      // The balance read's goes on past a group that fails, and keeps what
      // the others read.
      if (!reads.keeping) await classifyGroup(next.group[0], next.group[1], next.last)
      else await classifyGroup(next.group[0], next.group[1], next.last).catch(reads.groupFailed)
    }
  })
  return classes
}

/**
 * Whether kept facts may stand in for a read of their transaction in a read
 * of outputs, given `tipFloor`, a height the tip is known to have reached
 * (the listing's highest block, or the tip itself; -1 when nothing is
 * known). Kept coinbase answers always may: the maturity of a coinbase output
 * is judged afterwards from the tip alone, never from this floor. Every
 * output a kept "not a coinbase" answer covers must be, by the fresh listing,
 * at least as far below `tipFloor` as a coinbase output must be to mature,
 * where the answer no longer matters.
 */
function qbitKeptFactsServe(
  kept: readonly { output: QbitListedOutput; facts: QbitFundingOutputFacts }[],
  tipFloor: number
): boolean {
  return kept.every(
    ({ output: { utxo }, facts }) =>
      facts.coinbase ||
      (utxo.status.block_height !== undefined &&
        isQbitCoinbaseMature(utxo.status.block_height, tipFloor))
  )
}

/** The classes of listed outputs (`classifyQbitOutputs`), bucketed as `QbitClassifiedUtxos`. */
function qbitClassifiedFrom(
  classes: readonly (QbitOutputClass | undefined)[]
): QbitClassifiedUtxos {
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
  let matureAt: number | undefined
  let matureFrom: number | undefined
  for (const entry of classes) {
    if (!entry) continue
    if (entry.immature) {
      immature.push(entry.utxo)
      if (entry.matureAt !== undefined) matureAt = Math.min(matureAt ?? Infinity, entry.matureAt)
    } else {
      if (entry.matureAt !== undefined) {
        matureFrom = Math.max(matureFrom ?? -Infinity, entry.matureAt)
      }
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
  return {
    spendable,
    confirmedSpendable,
    unconfirmedSpendable,
    unconfirmedOwnChange,
    immature,
    ...(matureAt !== undefined ? { matureAt } : {}),
    ...(matureFrom !== undefined ? { matureFrom } : {}),
  }
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
 * the client's page ceiling cuts short. The transactions the walk does not
 * hold whole (an unconfirmed output's, the ancestors of the account's own
 * change) are read as `classifyQbitUtxos` reads them, through
 * `options.fundingTxReads` when given.
 */
export async function getQbitAddressUtxosClassifiedFromHistory(
  client: QbitEsploraClient,
  address: string,
  options: QbitSnapshotStabilityRetryOptions & {
    maxTransactions?: number
  } & QbitClassifyOptions = {}
): Promise<QbitClassifiedUtxos> {
  return classifyQbitUtxosFromHistory(client, address, options, false)
}

/**
 * `getQbitAddressUtxosClassifiedFromHistory`, for a read that may have begun
 * its view already, its lookups riding out server errors with `rideOut`.
 */
async function classifyQbitUtxosFromHistory(
  client: QbitEsploraClient,
  address: string,
  begun: QbitSnapshotStabilityRetryOptions & {
    maxTransactions?: number
  } & QbitClassifyOptions,
  rideOut: boolean
): Promise<QbitClassifiedUtxos> {
  const options = qbitClassifyStarted(client, begun)
  const maxTransactions = options.maxTransactions ?? QBIT_UTXO_HISTORY_MAX_TRANSACTIONS
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1) {
    throw new Error('maxTransactions must be a positive integer')
  }
  const retry = resolveQbitSnapshotStabilityRetries({
    stabilityRetries: options.stabilityRetries ?? QBIT_UTXO_HISTORY_STABILITY_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? QBIT_UTXO_HISTORY_RETRY_BASE_DELAY_MS,
  })
  const read: QbitReadCancellation = options.signal ? { signal: options.signal } : {}
  const addressScript = qbitAddressScript(address)
  const { stats, unspent } = await loadQbitSnapshotWithStabilityRetries(
    retry,
    () => readQbitUnspentOutputsFromHistory(client, address, maxTransactions, read),
    read
  )
  const confirmedTxs = new Map(
    unspent
      .filter(({ tx }) => tx.status.confirmed)
      .map(({ tx }) => [tx.txid.toLowerCase(), tx] as const)
  )
  const classified = await classifyQbitUtxos(
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
    {
      ...read,
      ...(options.fundingTxReads ? { fundingTxReads: options.fundingTxReads } : {}),
      ...(options.facts ? { facts: options.facts } : {}),
      ...(addressScript !== undefined ? { addressScript } : {}),
      ...(rideOut ? { rideOutServerErrors: true as const } : {}),
      historyTxs: confirmedTxs,
    }
  )
  return { ...classified, historyStats: stats }
}

/** The address's unspent outputs read from its history, and the statistics the walk verified. */
async function readQbitUnspentOutputsFromHistory(
  client: QbitEsploraClient,
  address: string,
  maxTransactions: number,
  options: QbitReadCancellation
): Promise<{ stats: EsploraAddressStats; unspent: { tx: EsploraTx; vout: number }[] }> {
  const statsBefore = await client.getAddressStats(address, options)
  assertValidQbitStats(statsBefore, address)
  if (qbitHistoryOverReadLimit(statsBefore, maxTransactions)) {
    throw new QbitUtxoHistoryTooLargeError(address, maxTransactions)
  }
  let history: AddressHistory
  try {
    history = await client.getAddressHistory(address, {
      ...options,
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
  const statsAfter = await client.getAddressStats(address, options)
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
  return {
    stats: statsBefore,
    unspent: [...funded].filter(([outpoint]) => !spent.has(outpoint)).map(([, output]) => output),
  }
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
  address: string,
  options: QbitClassifyOptions = {}
): Promise<QbitClassifiedUtxos> {
  return classifyQbitUtxosPastLimit(client, address, options, false)
}

/**
 * `getQbitAddressUtxosClassifiedPastLimit`, riding out server errors with
 * `rideOut`, and with `candidates` the candidate read of a listed address
 * (`spendCandidates`); a read from history is classified as before.
 */
async function classifyQbitUtxosPastLimit(
  client: QbitEsploraClient,
  address: string,
  options: QbitClassifyOptions,
  rideOut: boolean,
  candidates = false
): Promise<QbitClassifiedUtxos> {
  // One view for the listing, the statistics and the walk alike.
  const begun = qbitClassifyStarted(client, {
    ...qbitReadOptions(options),
    ...(options.fundingTxReads ? { fundingTxReads: options.fundingTxReads } : {}),
    ...(options.facts ? { facts: options.facts } : {}),
  })
  try {
    return await listAndClassifyQbitUtxos(client, address, {
      ...begun,
      ...(rideOut ? { rideOutServerErrors: true as const } : {}),
      ...(candidates ? { spendCandidates: true as const } : {}),
    })
  } catch (error) {
    throwIfQbitReadCancelled(options)
    if (
      !(await isQbitUtxoListOverExplorerLimit(client, address, error, qbitReadOptions(options)))
    ) {
      throw error
    }
  }
  return classifyQbitUtxosFromHistory(client, address, begun, rideOut)
}

/**
 * The outputs a send may select, confirmed ones first and the rest marked
 * `unconfirmed` so that selection prefers the confirmed ones: mature
 * confirmed outputs, then the unconfirmed change of this script's own
 * transactions. An unconfirmed payment from anyone else stays out until it
 * confirms. qbit Core is full-RBF, so its payer can replace it at any time,
 * and that evicts every send built on top of it. An address over the
 * explorer's UTXO limit is read from its history, and that walk stops once
 * `options.signal` aborts. The outputs need every funding transaction, so a
 * failed read fails the call; with `options.fundingTxReads` its reads are
 * bounded and kept as for the balance (see `classifyQbitUtxos`). Unlike
 * `readQbitAddressUtxos`, which lists deep outputs as candidates, it reads
 * and checks the funding transaction of every output.
 */
export async function getQbitAddressUtxos(
  client: QbitEsploraClient,
  address: string,
  options: QbitClassifyOptions = {}
): Promise<UTXO[]> {
  return (await qbitAddressUtxosRead(client, address, options, false, false)).utxos
}

/** What `readQbitAddressUtxos` answers. */
export interface QbitAddressUtxosRead {
  utxos: UTXO[]
  historyStats?: EsploraAddressStats
  matureAt?: number
  matureFrom?: number
}

/**
 * The outputs a send may select, as `getQbitAddressUtxos` lists them, but as
 * candidates (`spendCandidates`, see `classifyQbitUtxos`): an output the
 * listing, or the tip read with it, puts at least a coinbase maturity deep is
 * listed with the address's own script and the listed value, and its funding
 * transaction is not read; younger and unconfirmed outputs are read and
 * classified as by `getQbitAddressUtxos`. Nothing it lists is checked: every
 * input a transaction spends is checked before it is signed
 * (`checkQbitSpendInputs`). With the address statistics the walk verified
 * when the outputs were read from history (`QbitClassifiedUtxos.historyStats`),
 * a read that takes no shortcut, and the coinbase maturity heights it depends
 * on (`QbitClassifiedUtxos.matureAt` and `matureFrom`).
 */
export async function readQbitAddressUtxos(
  client: QbitEsploraClient,
  address: string,
  options: QbitClassifyOptions = {}
): Promise<QbitAddressUtxosRead> {
  return qbitAddressUtxosRead(client, address, options, false, true)
}

/**
 * `readQbitAddressUtxos` for a read that can wait out the explorer's server
 * errors and that its caller can give up on meanwhile, as the Send screen's
 * read of outputs is, which shows a usable form with a note while it runs.
 * Its transaction lookups ride out a 500, 502, 503 or 504, and its listing
 * and tip a 502, 503 or 504 (`withQbitReadRetries`, after
 * `QBIT_SERVER_ERROR_RETRY_PAUSES_MS` and within
 * `QBIT_SERVER_ERROR_RIDE_OUT_MS`), where every other read of outputs fails
 * on one as fast as the client alone (the balance read rides them out on a
 * shorter schedule of its own). An ancestor of the account's own change is
 * read as every other read reads it, once the client has made its own
 * attempts: its walk takes a failure as the output not being own change.
 * Its lookups pause inside their slots of the limiter, so in a burst of
 * 502s every other read through the same client waits behind it while it
 * holds as many as 256 slots in its own burst: each for about 14 s to
 * 18.5 s when the explorer answers at once with no `Retry-After` the client
 * follows, and for up to two client calls where the client waits on one or
 * the replies are slow, 36.5 s and 38.3 s as measured. A known limit,
 * described at `QBIT_SERVER_ERROR_RETRY_PAUSES_MS`.
 */
export async function readQbitAddressUtxosRidingOut(
  client: QbitEsploraClient,
  address: string,
  options: QbitClassifyOptions = {}
): Promise<QbitAddressUtxosRead> {
  return qbitAddressUtxosRead(client, address, options, true, true)
}

async function qbitAddressUtxosRead(
  client: QbitEsploraClient,
  address: string,
  options: QbitClassifyOptions,
  rideOut: boolean,
  candidates: boolean
): Promise<QbitAddressUtxosRead> {
  const { confirmedSpendable, unconfirmedOwnChange, historyStats, matureAt, matureFrom } =
    await classifyQbitUtxosPastLimit(client, address, options, rideOut, candidates)
  return {
    utxos: [
      ...confirmedSpendable,
      ...unconfirmedOwnChange.map(utxo => ({ ...utxo, unconfirmed: true })),
    ],
    ...(historyStats ? { historyStats } : {}),
    ...(matureAt !== undefined ? { matureAt } : {}),
    ...(matureFrom !== undefined ? { matureFrom } : {}),
  }
}

/** The address's output counts from its statistics. */
export interface QbitAddressOutputCounts {
  /**
   * Confirmed outputs not spent in a block. electrs refuses to list an
   * address whose set passed its limit at any point since it last cached
   * that set, so this count alone does not say whether it lists them.
   */
  confirmedUnspent: number
  /** Outputs mempool transactions spend; they leave the count once those confirm. */
  pendingSpent: number
  /** Outputs mempool transactions create; they join the count once those confirm. */
  pendingFunded: number
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
  cursor: QbitHistoryWalkCursor,
  options?: RequestOptions
): Promise<QbitHistoryWalkPage> {
  const page = await client.getAddressHistoryPage(address, cursor.afterTxid, options)
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
 * Each page is read under `operation`'s deadline, when given.
 */
export async function continueQbitAddressOutputScan(
  client: QbitAddressHistoryPageClient,
  scan: QbitAddressOutputScan,
  options: {
    maxPages: number
    enough?: (scan: QbitAddressOutputScan) => boolean
    operation?: QbitExplorerOperation
  }
): Promise<number> {
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1) {
    throw new Error('maxPages must be a positive integer')
  }
  let read = 0
  while (read < options.maxPages && !scan.exhausted && !options.enough?.(scan)) {
    const { rows, txids, next, ended } = await readQbitHistoryWalkPage(
      client,
      scan.address,
      scan,
      options.operation?.read()
    )
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

/** The most `/tx/:txid/outspends` reads `findQbitOutpointSpenders` has in flight at once. */
export const QBIT_OUTSPENDS_CONCURRENCY = 8

/**
 * The outpoints of `outputs` that a transaction spends, as `txid:vout` with
 * a lowercase txid: `findQbitOutpointSpenders` without the spenders.
 */
export async function findQbitSpentOutpoints(
  client: QbitTxOutspendsClient,
  outputs: readonly { txid: string; vout: number; outputCount: number }[],
  operation?: QbitExplorerOperation
): Promise<Set<string>> {
  return new Set((await findQbitOutpointSpenders(client, outputs, { operation })).keys())
}

/**
 * The transactions `findQbitOutpointSpenders` reads for `outputs`: each
 * distinct one they are outputs of, once.
 */
export function qbitOutspendsReadCount(outputs: readonly { txid: string }[]): number {
  return new Set(outputs.map(output => normalizeQbitTxid(output.txid))).size
}

/**
 * The txid spending each output of `outputs` that a transaction spends,
 * keyed `txid:vout` with lowercase txids, from one `/tx/:txid/outspends`
 * answer per transaction they are outputs of, at most
 * `QBIT_OUTSPENDS_CONCURRENCY` at a time. With the `outputCount` of that
 * transaction, `vout` must be below it and the answer must hold exactly one
 * well-formed entry per output (see `getQbitTxSpenders`). Without it (the
 * inputs of a transaction the wallet holds only signed bytes of), the answer
 * must hold a well-formed entry at each `vout`. A failed or malformed answer
 * throws, so an output is only ever reported unspent on the explorer's
 * explicit word. Each answer is read under `operation`'s deadline, when
 * given, and fresh (`QbitTxOutspendsOptions.fresh`) with `fresh`.
 *
 * The first failure, of a read or of an answer, starts no further read and
 * is handed to `onFailure` at once, so the caller can abort the reads still
 * in flight under `operation`'s signal: this throws only once they settle.
 */
export async function findQbitOutpointSpenders(
  client: QbitTxOutspendsClient,
  outputs: readonly { txid: string; vout: number; outputCount?: number | undefined }[],
  options: {
    operation?: QbitExplorerOperation | undefined
    fresh?: boolean
    onFailure?: (error: unknown) => void
  } = {}
): Promise<Map<string, string>> {
  const { operation, fresh = false, onFailure } = options
  const byTxid = new Map<string, { outputCount: number | undefined; vouts: number[] }>()
  for (const output of outputs) {
    const txid = normalizeQbitTxid(output.txid)
    const { outputCount, vout } = output
    if (
      (outputCount !== undefined && !Number.isSafeInteger(outputCount)) ||
      !Number.isSafeInteger(vout) ||
      vout < 0 ||
      (outputCount !== undefined && vout >= outputCount)
    ) {
      throw new Error(`invalid qbit outpoint ${txid}:${vout}`)
    }
    const entry = byTxid.get(txid) ?? { outputCount, vouts: [] }
    if (entry.outputCount !== outputCount) {
      throw new Error(`inconsistent output count for qbit transaction ${txid}`)
    }
    entry.vouts.push(vout)
    byTxid.set(txid, entry)
  }
  const read = (txid: string): Promise<unknown> => {
    const deadline = operation?.read()
    if (fresh) return client.getTxOutspends(txid, { ...deadline, fresh: true })
    return deadline === undefined
      ? client.getTxOutspends(txid)
      : client.getTxOutspends(txid, deadline)
  }
  const entries = [...byTxid]
  // Each answer is validated as it arrives, so a malformed one fails like a
  // failed read.
  const answered = await mapQbitWithConcurrency(
    entries,
    QBIT_OUTSPENDS_CONCURRENCY,
    async ([txid, { outputCount, vouts }]) => {
      try {
        const answer = await read(txid)
        if (outputCount !== undefined) {
          const all = qbitTxSpendersFromOutspends(answer, txid, outputCount)
          return vouts.map(vout => all[vout])
        }
        return vouts.map(vout =>
          qbitOutspendSpender(Array.isArray(answer) ? answer[vout] : undefined, txid)
        )
      } catch (error) {
        onFailure?.(error)
        throw error
      }
    }
  )
  const spenders = new Map<string, string>()
  entries.forEach(([txid, { vouts }], index) => {
    vouts.forEach((vout, at) => {
      const spender = answered[index]![at]
      if (spender !== undefined) spenders.set(`${txid}:${vout}`, spender)
    })
  })
  return spenders
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
  outputCount: number,
  options?: QbitTxOutspendsOptions
): Promise<(string | undefined)[]> {
  const normalizedTxid = normalizeQbitTxid(txid)
  if (!Number.isSafeInteger(outputCount) || outputCount < 1) {
    throw new Error('invalid qbit transaction output count')
  }
  const outspends =
    options === undefined
      ? await client.getTxOutspends(normalizedTxid)
      : await client.getTxOutspends(normalizedTxid, options)
  return qbitTxSpendersFromOutspends(outspends, normalizedTxid, outputCount)
}

/**
 * `getQbitTxSpenders` from `outspends`, the `/tx/:txid/outspends` answer
 * for `txid` (lowercase): anything other than one well-formed entry per
 * output throws.
 */
export function qbitTxSpendersFromOutspends(
  outspends: unknown,
  txid: string,
  outputCount: number
): (string | undefined)[] {
  if (!Array.isArray(outspends) || outspends.length !== outputCount) {
    throw new Error(`invalid qbit outspends for ${txid}`)
  }
  return outspends.map(outspend => qbitOutspendSpender(outspend, txid))
}

/**
 * The lowercase txid spending an output of `txid` (lowercase), from that
 * output's entry in its `/tx/:txid/outspends` answer, or undefined when
 * nothing spends it. Anything but a well-formed entry throws (a missing
 * one included), so an output is never read as unspent without the
 * explorer's explicit word.
 */
export function qbitOutspendSpender(outspend: unknown, txid: string): string | undefined {
  const { spent, txid: spender } = (
    outspend && typeof outspend === 'object' ? outspend : {}
  ) as Partial<QbitTxOutspend>
  if (typeof spent !== 'boolean') throw new Error(`invalid qbit outspends for ${txid}`)
  if (!spent) return undefined
  if (
    typeof spender !== 'string' ||
    !QBIT_TXID_PATTERN.test(spender) ||
    spender.toLowerCase() === txid
  ) {
    throw new Error(`invalid qbit outspends for ${txid}`)
  }
  return spender.toLowerCase()
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

/**
 * What `tx`, read as the funding transaction of the listed output `utxo`,
 * says of that output once checked against the listing: the txid, an input
 * list whose every input says whether it is a coinbase, the output itself,
 * with the listed value and a P2MR script. Throws on any mismatch, before
 * anything of it is classified or kept.
 */
function qbitFundingOutputFacts(tx: EsploraTx, utxo: EsploraUtxo): QbitFundingOutputFacts {
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
    throw qbitUtxoValueMismatchError(utxo)
  }
  if (
    typeof output.scriptpubkey !== 'string' ||
    !QBIT_P2MR_SCRIPT_PATTERN.test(output.scriptpubkey)
  ) {
    throw new Error(`qbit UTXO has invalid P2MR output script for ${utxo.txid}:${utxo.vout}`)
  }
  return {
    coinbase: tx.vin.some(input => input.is_coinbase),
    value: output.value,
    script: output.scriptpubkey,
  }
}

function qbitUtxoValueMismatchError(utxo: EsploraUtxo): Error {
  return new Error(`qbit UTXO output value mismatch for ${utxo.txid}:${utxo.vout}`)
}

/**
 * Classify the listed output `utxo` from its funding transaction's checked
 * `facts`; whether it is confirmed, and at what height, comes from the
 * listing. `tx`, the transaction read afresh, is needed only for an
 * unconfirmed output (the ownership walk of its change), whose transaction
 * is always read so. Undefined for a coinbase output the listing does not
 * report confirmed, which no send may select.
 */
async function classifyQbitOutput(
  utxo: EsploraUtxo,
  facts: QbitFundingOutputFacts,
  tx: EsploraTx | undefined,
  getTipHeight: () => Promise<number>,
  getAncestor: (txid: string) => Promise<EsploraTx | undefined>
): Promise<QbitOutputClass | undefined> {
  let immature = false
  let matureAt: number | undefined
  if (facts.coinbase) {
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
    matureAt = blockHeight + QBIT_COINBASE_MATURITY - 1
  }

  const ownAncestry =
    !utxo.status.confirmed && !facts.coinbase && tx
      ? await qbitOwnUnconfirmedAncestry(tx, facts.script, getAncestor)
      : undefined

  return {
    confirmed: utxo.status.confirmed,
    immature,
    ...(matureAt !== undefined ? { matureAt } : {}),
    ownAncestry,
    utxo: {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.value,
      scriptPk: facts.script,
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
 * ancestor limit. `refusal`, when given, is told why it is undefined:
 * `unreadable`, an answer the walk cannot read (no input, an input without
 * the script it spends or with no valid txid, an ancestor not produced or
 * not sized); `foreign`, an input that is someone else's (another script, or
 * a coinbase's); `limit`, the ancestor limit reached.
 */
async function qbitOwnUnconfirmedAncestry(
  tx: EsploraTx,
  scriptPubKey: string,
  getAncestor: (txid: string) => Promise<EsploraTx | undefined>,
  refusal?: { why?: 'unreadable' | 'foreign' | 'limit' }
): Promise<Map<string, number> | undefined> {
  const refuse = (why: 'unreadable' | 'foreign' | 'limit'): undefined => {
    if (refusal) refusal.why = why
    return undefined
  }
  const script = scriptPubKey.toLowerCase()
  const vsize = qbitTxVsize(tx)
  if (vsize === undefined) return refuse('unreadable')
  const unconfirmed = new Map([[tx.txid.toLowerCase(), vsize]])
  const pending = [tx]
  for (let current = pending.pop(); current; current = pending.pop()) {
    if (current.vin.length === 0) return refuse('unreadable')
    for (const input of current.vin) {
      if (
        typeof input.prevout?.scriptpubkey !== 'string' ||
        typeof input.txid !== 'string' ||
        !QBIT_TXID_PATTERN.test(input.txid)
      ) {
        return refuse(input.is_coinbase ? 'foreign' : 'unreadable')
      }
      if (input.is_coinbase || input.prevout.scriptpubkey.toLowerCase() !== script) {
        return refuse('foreign')
      }
      const parentTxid = input.txid.toLowerCase()
      if (unconfirmed.has(parentTxid)) continue
      const parent = await getAncestor(parentTxid)
      if (!parent) return refuse('unreadable')
      if (parent.status.confirmed) continue
      const parentVsize = qbitTxVsize(parent)
      if (parentVsize === undefined) return refuse('unreadable')
      unconfirmed.set(parentTxid, parentVsize)
      if (unconfirmed.size >= QBIT_MEMPOOL_ANCESTOR_LIMIT) return refuse('limit')
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
 * An ancestor of an unconfirmed output, read afresh through the
 * classification's `reads`, or undefined when the explorer cannot produce it
 * in a shape the ownership walk can read. The output then counts as someone
 * else's for this read: it is left out of what a send may select, and the
 * confirmed outputs stay readable. Only a stopped classification turns a
 * failed read into a failure of its own. Nor is a failed read kept: when the
 * ancestor is listed too, the read for its own outputs reads it afresh
 * rather than failing with this one, whether it asks after this read failed
 * or had joined it before (the walks share this outcome through
 * `getAncestorOnce`).
 */
async function getQbitAncestorTx(
  reads: QbitClassificationReads,
  txid: string
): Promise<EsploraTx | undefined> {
  const read = reads.tx(txid)
  let tx: EsploraTx
  try {
    tx = await read
  } catch {
    throwIfQbitReadCancelled(reads)
    reads.forget(txid, read)
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

/**
 * An ancestor the classification already found confirmed, with what the
 * ownership walk reads of a confirmed one: that it is.
 */
function qbitConfirmedAncestor(txid: string): EsploraTx {
  return { txid, vin: [], vout: [], status: { confirmed: true } } as unknown as EsploraTx
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

/**
 * How long one check of the inputs a transaction spends may run, every read
 * of it included: its lookups, the tip and the ancestry of unconfirmed
 * change (`checkQbitSpendInputs`). Past it the check fails as `unchecked`,
 * and nothing is signed. Long enough for a check that rides out the
 * explorer's server errors (`QBIT_SERVER_ERROR_RIDE_OUT_MS`, and the last
 * attempt after it), which a send plan's check does.
 */
export const QBIT_SPEND_CHECK_DEADLINE_MS = 60_000

/**
 * How much longer a check may run for each funding transaction it looks up,
 * past `QBIT_SPEND_CHECK_DEADLINE_MS`: a send plan checks every input of its
 * steps in one pass before it signs, thousands of lookups for the largest,
 * most of them past the burst at the sustained rate
 * (`QBIT_CLASSIFY_SUSTAINED_READS_IN_FLIGHT`).
 */
export const QBIT_SPEND_CHECK_MS_PER_LOOKUP = 20

/** The deadline of a check that looks up `lookups` funding transactions. */
export function qbitSpendCheckDeadlineMs(lookups: number): number {
  return QBIT_SPEND_CHECK_DEADLINE_MS + Math.max(0, lookups) * QBIT_SPEND_CHECK_MS_PER_LOOKUP
}

/** An input a transaction spends, as its signature commits to it. */
export interface QbitSpendInput {
  txid: string
  vout: number
  /** The value of the output it spends, which the signature commits to. */
  satoshis: number
  /** The script of the output it spends, in hex, which the signature commits to. */
  scriptPk: string
}

/**
 * Why an input failed its check (`checkQbitSpendInputs`):
 * - `mismatch`: its funding transaction, as the explorer gives it, is not
 *   the output it spends: another txid, no output at its index, another
 *   value, or a script that is not the account's own; or the input itself
 *   is no output (a malformed txid, index or value, or an output spent
 *   twice), which is refused before any read;
 * - `not_spendable`: a coinbase output not mature by a tip read for the
 *   check, or confirmed nowhere yet; an unconfirmed output that is not the
 *   account's own change; or own change with as many unconfirmed
 *   transactions before it as qbit Core allows;
 * - `not_found`: the explorer does not have its funding transaction;
 * - `unchecked`: it could not be checked: a read failed or timed out, the
 *   check ran past its deadline, an answer could not be read (an ancestry
 *   the walk cannot follow among them), or the tip read is below the block
 *   of the coinbase it judges. An unknown outcome, never taken for a
 *   mismatch, and never for a pass.
 */
export type QbitSpendInputProblem = 'mismatch' | 'not_spendable' | 'not_found' | 'unchecked'

/** An input that failed its check, and why (`QbitSpendInputProblem`). */
export class QbitSpendInputCheckError extends Error {
  constructor(
    readonly problem: QbitSpendInputProblem,
    readonly txid: string,
    readonly vout: number,
    detail: string
  ) {
    super(`qbit input ${txid}:${vout} failed its check (${problem}): ${detail}`)
    this.name = 'QbitSpendInputCheckError'
  }
}

/** The inputs one check read and checked (`checkQbitSpendInputs`), as each was checked. */
export interface QbitCheckedSpend {
  readonly inputs: readonly Readonly<QbitSpendInput>[]
  /**
   * The unconfirmed transactions behind each unconfirmed input, by its
   * outpoint (`txid:vout`, txid in lower case): its own transaction and each
   * unconfirmed ancestor, with its vsize, as `UTXO.unconfirmedAncestors`
   * lists them.
   */
  readonly unconfirmedAncestors: ReadonlyMap<string, readonly { txid: string; vsize: number }[]>
}

/** Every result `checkQbitSpendInputs` made: nothing else adds to it. */
const qbitCheckedSpends = new WeakSet<object>()

/** Whether `value` is a result of `checkQbitSpendInputs`, which alone makes one. */
export function isQbitCheckedSpend(value: unknown): value is QbitCheckedSpend {
  return typeof value === 'object' && value !== null && qbitCheckedSpends.has(value)
}

/**
 * Read and check the funding transaction of every input a transaction
 * spends, immediately before its first signature, as the account `address`
 * signs it: one lookup per distinct funding transaction, through the shared
 * reader's limiter (`options.fundingTxReads`), at the rates of any other
 * classification. Each input must be an output of `address`'s own script,
 * and its funding transaction, as the explorer gives it, must have that
 * txid, an output at its index of exactly the value the signature commits
 * to and that script. A coinbase output must be mature by a tip read for
 * this check (`isQbitCoinbaseMature`), never one a listing gave; an
 * unconfirmed output must be the account's own change all the way down
 * (`qbitOwnUnconfirmedAncestry`), whose ancestors are read as well. A kept
 * fact never serves it: its funding transaction is read whatever the shared
 * reader keeps, as a fact can serve only an output a fresh listing shows
 * deep, and a check has no listing. What it reads is kept as every
 * classification keeps it, through a view begun as it starts, so a clear
 * while it runs keeps nothing.
 *
 * An input of `options.ownTransactions` is checked against that transaction
 * instead, with no lookup: a transaction the caller holds, keyed by its txid
 * (lower case), whose outputs are given in output order.
 *
 * Every read runs under one signal, which aborts once `options.signal`
 * does, or once `options.deadlineMs` (`QBIT_SPEND_CHECK_DEADLINE_MS`) have
 * passed; with `rideOutServerErrors` its lookups and the tip ride out the
 * explorer's server errors (`withQbitReadRetries`). Resolves to a
 * `QbitCheckedSpend` of every input; rejects with the first
 * `QbitSpendInputCheckError`, or with the reason of `options.signal` once
 * it aborts. Nothing it started is left running when it settles.
 */
export async function checkQbitSpendInputs(
  client: QbitEsploraClient,
  address: string,
  inputs: readonly QbitSpendInput[],
  options: QbitClassifyOptions & {
    rideOutServerErrors?: true
    ownTransactions?: ReadonlyMap<string, readonly { value: number; script: string }[]>
    deadlineMs?: number
  } = {}
): Promise<QbitCheckedSpend> {
  const script = qbitAddressScript(address)
  if (script === undefined) throw new Error(`not a qbit P2MR address: ${address}`)
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('a qbit transaction spends at least one input')
  }
  const checked = new Array<Readonly<QbitSpendInput>>(inputs.length)
  // The inputs whose funding transaction is read, by txid, with their places.
  const toRead = new Map<string, { index: number; input: QbitSpendInput }[]>()
  const seen = new Set<string>()
  inputs.forEach((input, index) => {
    // An input no output can be: refused as a mismatch before any read,
    // named by what of it can be named.
    if (
      !input ||
      typeof input.txid !== 'string' ||
      !QBIT_TXID_PATTERN.test(input.txid) ||
      !Number.isSafeInteger(input.vout) ||
      input.vout < 0 ||
      input.vout > MAX_OUTPUT_INDEX ||
      !Number.isSafeInteger(input.satoshis) ||
      input.satoshis < 0 ||
      typeof input.scriptPk !== 'string'
    ) {
      const named = input && typeof input.txid === 'string' ? input.txid.toLowerCase() : ''
      const vout = input && Number.isSafeInteger(input.vout) ? input.vout : -1
      throw new QbitSpendInputCheckError('mismatch', named, vout, `input ${index} is malformed`)
    }
    const txid = input.txid.toLowerCase()
    const outpoint = `${txid}:${input.vout}`
    if (seen.has(outpoint)) {
      throw new QbitSpendInputCheckError('mismatch', txid, input.vout, 'it is spent twice')
    }
    seen.add(outpoint)
    const fail = (detail: string): QbitSpendInputCheckError =>
      new QbitSpendInputCheckError('mismatch', txid, input.vout, detail)
    // Before any read: a transaction the account signs alone spends only
    // the account's own outputs.
    if (input.scriptPk.toLowerCase() !== script) throw fail('it spends another script')
    const own = options.ownTransactions?.get(txid)
    if (own) {
      const output = own[input.vout]
      if (!output) throw fail('no output at its index')
      if (output.value !== input.satoshis) throw fail('another value')
      if (output.script.toLowerCase() !== script) throw fail('another script')
      checked[index] = { txid, vout: input.vout, satoshis: input.satoshis, scriptPk: script }
      return
    }
    const listed = toRead.get(txid)
    if (listed) listed.push({ index, input })
    else toRead.set(txid, [{ index, input }])
  })
  const unconfirmedAncestors = new Map<string, { txid: string; vsize: number }[]>()
  if (toRead.size > 0) {
    await readQbitSpendInputs(client, script, toRead, checked, unconfirmedAncestors, options)
  }
  const spend: QbitCheckedSpend = Object.freeze({
    inputs: Object.freeze(checked.map(input => Object.freeze({ ...input }))),
    unconfirmedAncestors,
  })
  qbitCheckedSpends.add(spend)
  return spend
}

/** The reads of `checkQbitSpendInputs`: the inputs of `toRead`, checked into `checked`. */
async function readQbitSpendInputs(
  client: QbitEsploraClient,
  script: string,
  toRead: ReadonlyMap<string, readonly { index: number; input: QbitSpendInput }[]>,
  checked: Readonly<QbitSpendInput>[],
  unconfirmedAncestors: Map<string, { txid: string; vsize: number }[]>,
  options: QbitClassifyOptions & { rideOutServerErrors?: true; deadlineMs?: number }
): Promise<void> {
  const callerSignal = options.signal
  const deadlineMs = options.deadlineMs ?? QBIT_SPEND_CHECK_DEADLINE_MS
  // One signal for every read: the caller's, and the check's own deadline.
  const operation = new AbortController()
  const onCallerAbort = (): void => operation.abort(callerSignal?.reason)
  if (callerSignal?.aborted) onCallerAbort()
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const deadline = setTimeout(
    () =>
      operation.abort(
        new QbitApiError('timeout', `qbit input check exceeded its ${deadlineMs}ms deadline`)
      ),
    deadlineMs
  )
  const rideOut = options.rideOutServerErrors === true
  let tip: QbitTipRead | undefined
  let reads: QbitClassificationReads | undefined
  // The first input not yet checked: the one an unknown outcome is named by.
  const unchecked = (): { txid: string; vout: number } => {
    let first: { txid: string; vout: number } | undefined
    for (const listed of toRead.values()) {
      for (const { index, input } of listed) {
        const outpoint = { txid: input.txid.toLowerCase(), vout: input.vout }
        first ??= outpoint
        if (!checked[index]) return outpoint
      }
    }
    return first ?? { txid: '', vout: 0 }
  }
  // Everything after the deadline and the caller's listener is set up in
  // here, so that whatever throws, the `finally` below removes both.
  try {
    // Its place among the shared reader's clears: a clear while it runs
    // leaves it keeping nothing. A fact is never served to it.
    const { facts } = qbitClassifyStarted(client, {
      ...(options.fundingTxReads ? { fundingTxReads: options.fundingTxReads } : {}),
      ...(options.facts ? { facts: options.facts } : {}),
    })
    // Read for this check alone, with the lookups, under the same signal.
    tip = new QbitTipRead(client, operation.signal, rideOut ? QBIT_SEND_SCREEN_RIDE_OUT : undefined)
    const tipRead = tip
    tipRead.start()
    // With `rideOut`, an ancestor's read rides out server errors as a
    // lookup does: a plan's check must not stop on one 502 for an ancestor
    // of its own unconfirmed change (a classification's walk does not).
    const shared = new QbitClassificationReads(
      client,
      options.fundingTxReads,
      operation.signal,
      facts,
      rideOut,
      rideOut
    )
    reads = shared
    // The funding transactions found confirmed, each let go of once its
    // inputs are checked, as a classification lets go of them: an answer
    // holds every witness of its transaction, and a plan's one pass checks
    // thousands of inputs, so the check holds no more answers than it has
    // reads in flight and unconfirmed transactions. A walk that reaches one
    // needs no more of it than that it is confirmed.
    const confirmed = new Set<string>()
    const groups = [...toRead]
    let next = 0
    await shared.run(Math.min(shared.limiter.maxInFlight, groups.length), async () => {
      for (let group = groups[next++]; group && !shared.stopped; group = groups[next++]) {
        await checkQbitSpendGroup(
          shared,
          tipRead,
          script,
          group[0],
          group[1],
          checked,
          unconfirmedAncestors,
          confirmed
        )
      }
    })
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason
    if (error instanceof QbitSpendInputCheckError) throw error
    const { txid, vout } = unchecked()
    throw new QbitSpendInputCheckError('unchecked', txid, vout, qbitCheckFailureDetail(error))
  } finally {
    clearTimeout(deadline)
    callerSignal?.removeEventListener('abort', onCallerAbort)
    reads?.close()
    tip?.close()
  }
}

/** Check the inputs `listed` of funding transaction `txid` (`checkQbitSpendInputs`). */
async function checkQbitSpendGroup(
  reads: QbitClassificationReads,
  tip: QbitTipRead,
  script: string,
  txid: string,
  listed: readonly { index: number; input: QbitSpendInput }[],
  checked: Readonly<QbitSpendInput>[],
  unconfirmedAncestors: Map<string, { txid: string; vsize: number }[]>,
  confirmed: Set<string>
): Promise<void> {
  const first = listed[0]?.input
  if (!first) return
  const failure = (
    problem: QbitSpendInputProblem,
    vout: number,
    detail: string
  ): QbitSpendInputCheckError => new QbitSpendInputCheckError(problem, txid, vout, detail)
  let tx: EsploraTx
  try {
    tx = await reads.tx(txid, true)
  } catch (error) {
    if (reads.stopped) throw error
    if (error instanceof QbitApiError && error.kind === 'not_found' && error.status === 404) {
      throw failure('not_found', first.vout, 'the explorer does not have its transaction')
    }
    throw failure('unchecked', first.vout, qbitCheckFailureDetail(error))
  }
  if (!tx || typeof tx.txid !== 'string' || !QBIT_TXID_PATTERN.test(tx.txid)) {
    throw failure('unchecked', first.vout, 'its transaction could not be read')
  }
  if (tx.txid.toLowerCase() !== txid) {
    throw failure('mismatch', first.vout, 'another transaction id')
  }
  const status = tx.status
  if (
    !Array.isArray(tx.vin) ||
    !tx.vin.every(input => input && typeof input.is_coinbase === 'boolean') ||
    !Array.isArray(tx.vout) ||
    !status ||
    typeof status.confirmed !== 'boolean' ||
    (status.confirmed &&
      (!Number.isSafeInteger(status.block_height) || (status.block_height ?? -1) < 0))
  ) {
    throw failure('unchecked', first.vout, 'its transaction could not be read')
  }
  const coinbase = tx.vin.some(input => input.is_coinbase)
  for (const { index, input } of listed) {
    const output = tx.vout[input.vout]
    if (!output) throw failure('mismatch', input.vout, 'no output at its index')
    if (
      !Number.isSafeInteger(output.value) ||
      output.value < 0 ||
      typeof output.scriptpubkey !== 'string'
    ) {
      throw failure('unchecked', input.vout, 'its output could not be read')
    }
    if (output.value !== input.satoshis) throw failure('mismatch', input.vout, 'another value')
    if (output.scriptpubkey.toLowerCase() !== script) {
      throw failure('mismatch', input.vout, 'another script')
    }
    if (coinbase) {
      if (!status.confirmed) throw failure('not_spendable', input.vout, 'an unconfirmed coinbase')
      let tipHeight: number
      try {
        tipHeight = await tip.start()
      } catch (error) {
        if (reads.stopped) throw error
        throw failure('unchecked', input.vout, `the tip: ${qbitCheckFailureDetail(error)}`)
      }
      if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
        throw failure('unchecked', input.vout, 'the tip could not be read')
      }
      // Its height was read as a safe integer above.
      const height = status.block_height ?? -1
      // A tip below the block that holds it: one of the two answers is
      // wrong, so maturity is unknown, not refused.
      if (tipHeight < height) {
        throw failure('unchecked', input.vout, 'the tip is below its block')
      }
      if (!isQbitCoinbaseMature(height, tipHeight)) {
        throw failure('not_spendable', input.vout, 'an immature coinbase')
      }
    } else if (!status.confirmed) {
      if (qbitTxVsize(tx) === undefined) {
        throw failure('unchecked', input.vout, 'its transaction has no size')
      }
      const refusal: { why?: 'unreadable' | 'foreign' | 'limit' } = {}
      const ancestry = await qbitOwnUnconfirmedAncestry(
        tx,
        script,
        parentTxid =>
          confirmed.has(parentTxid)
            ? Promise.resolve(qbitConfirmedAncestor(parentTxid))
            : qbitCheckedAncestor(reads, parentTxid, input.vout, failure),
        refusal
      )
      if (!ancestry) {
        // What the walk could not read is an unknown outcome; someone
        // else's input, or the ancestor limit, is an output that cannot be
        // spent yet.
        if (refusal.why === 'foreign') {
          throw failure('not_spendable', input.vout, 'not the account’s own change')
        }
        if (refusal.why === 'limit') {
          throw failure('not_spendable', input.vout, 'too many unconfirmed ancestors')
        }
        throw failure('unchecked', input.vout, 'its ancestry could not be read')
      }
      unconfirmedAncestors.set(
        `${txid}:${input.vout}`,
        [...ancestry].map(([ancestor, vsize]) => ({ txid: ancestor, vsize }))
      )
    }
    reads.facts?.keep(txid, input.vout, {
      coinbase,
      value: output.value,
      script: output.scriptpubkey,
    })
    checked[index] = { txid, vout: input.vout, satoshis: input.satoshis, scriptPk: script }
  }
  if (status.confirmed) {
    // Nothing more reads it but a walk reaching it, which needs no more
    // than that it is confirmed.
    confirmed.add(txid)
    reads.forget(txid)
  }
}

/**
 * An ancestor of an unconfirmed input the check walks (`checkQbitSpendGroup`):
 * a read that fails, or an answer the walk cannot read, is an unknown
 * outcome (`unchecked`), never an input that is not own change.
 */
async function qbitCheckedAncestor(
  reads: QbitClassificationReads,
  txid: string,
  vout: number,
  failure: (problem: QbitSpendInputProblem, vout: number, detail: string) => Error
): Promise<EsploraTx> {
  let tx: EsploraTx
  try {
    tx = await reads.tx(txid)
  } catch (error) {
    if (reads.stopped) throw error
    throw failure('unchecked', vout, `an ancestor: ${qbitCheckFailureDetail(error)}`)
  }
  if (
    !tx ||
    typeof tx.txid !== 'string' ||
    tx.txid.toLowerCase() !== txid ||
    !Array.isArray(tx.vin) ||
    !tx.vin.every(input => input && typeof input.is_coinbase === 'boolean') ||
    typeof tx.status?.confirmed !== 'boolean' ||
    (!tx.status.confirmed && qbitTxVsize(tx) === undefined)
  ) {
    throw failure('unchecked', vout, 'an ancestor could not be read')
  }
  return tx
}

/** What a failed read of the check says, for its error: never the request's address. */
function qbitCheckFailureDetail(error: unknown): string {
  if (QbitApiError.is(error)) {
    return `${error.kind}${error.status !== undefined ? ` ${error.status}` : ''}`
  }
  return error instanceof Error ? error.name : 'unknown failure'
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
 * than that, whatever the back-off says. A cancelled read is not retried,
 * and its back-off ends at once.
 */
async function loadQbitSnapshotWithStabilityRetries<T>(
  retry: { stabilityRetries: number; retryBaseDelayMs: number },
  load: () => Promise<T>,
  options: QbitReadCancellation = {}
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load()
    } catch (error) {
      throwIfQbitReadCancelled(options)
      if (!isQbitSnapshotUnstableError(error) || attempt >= retry.stabilityRetries) {
        throw error
      }
      const minRetryDelayMs =
        error instanceof QbitHistorySnapshotUnstableError ? error.minRetryDelayMs : 0
      const delayMs = Math.min(
        Math.max(retry.retryBaseDelayMs * 2 ** attempt, minRetryDelayMs),
        MAX_QBIT_SNAPSHOT_RETRY_DELAY_MS
      )
      if (delayMs > 0) await qbitCancellableDelay(delayMs, options)
    }
  }
}

/** Wait `ms`, or reject with the abort reason as soon as `options.signal` aborts. */
export function qbitCancellableDelay(ms: number, options: QbitReadCancellation): Promise<void> {
  const { signal } = options
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms))
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
  txid: string,
  options?: RequestOptions
): Promise<{ hex: string; transaction: transactionCore.Transaction }> {
  const normalizedTxid = normalizeQbitTxid(txid)
  const hex =
    options === undefined
      ? await client.getTxHex(normalizedTxid)
      : await client.getTxHex(normalizedTxid, options)
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

/**
 * The summary offered without a usable estimate: every tier at
 * `QBIT_FALLBACK_FEE_RATE`, the rate the wallet sends at without one, not
 * the relay floor, since the wallet then cannot see that the mempool's
 * minimum has risen.
 */
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
      feeRate: QBIT_FALLBACK_FEE_RATE,
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

/**
 * The provider's tiers as the wallet quotes them, or why there are none.
 * Each target is a whole number of blocks from 1 to 1,008, given once, with
 * a finite rate above 0 and, as sent, at most `QBIT_MAX_FEE_RATE`. A rate
 * below the relay floor is raised to `QBIT_MIN_RELAY_FEE_RATE`, and every
 * rate is rounded up to hundredths of a bit/vB: the Custom rate input takes
 * rates in hundredths and every screen shows them so, so a tier is a rate
 * the user sees and can type exactly, and rounding up never offers less
 * than the provider asked for. A slower target must not cost more than a
 * faster one once both are rounded.
 */
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
      feeRate: ceilQbitFeeRateToHundredths(Math.max(QBIT_MIN_RELAY_FEE_RATE, tier.feeRate!)),
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

/**
 * The smallest whole number of hundredths of a bit/vB that is not below
 * `feeRate`, a positive finite rate. `feeRate * 100` can land on either side
 * of a whole number in binary (1.1 * 100 is 110.00000000000001, 0.29 * 100
 * is 28.999999999999996), so the candidate is checked against `feeRate`
 * itself: `n / 100` is the same number as the decimal `n / 100` a user types
 * or a provider sends, so a rate already in hundredths comes back unchanged.
 */
function ceilQbitFeeRateToHundredths(feeRate: number): number {
  let hundredths = Math.ceil(feeRate * 100)
  while (hundredths / 100 < feeRate) hundredths += 1
  while ((hundredths - 1) / 100 >= feeRate) hundredths -= 1
  return hundredths / 100
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
