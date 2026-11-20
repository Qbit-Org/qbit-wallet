import { createAction, createSlice, Slice } from '@reduxjs/toolkit'
import {
  Account,
  QbitBalanceSummary,
  TxHistoryItem,
  isCompleteQbitBalance,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { resetWalletState } from '../actions/global'

/**
 * An account's total as the account switcher last showed it on one network,
 * kept for the page's lifetime so that the switcher, opened again, shows it
 * at once while the background is asked again.
 */
export interface AccountTotalEntry {
  /** In sats; `null` when no answer has carried one. */
  totalBalance: number | null
  /** When the background measured that total, in ms since the epoch. */
  readAt: number | null
  /**
   * `totalBalance` may not be the account's total now: the latest answer
   * for the account measured none on this network (its read failed,
   * answered none, or answered for another network), so it is an earlier
   * one, or the read says it may be from before a transaction the wallet
   * submitted. An answer that is not settled (a kept total to be read
   * again) does not clear it: only a settled one does.
   */
  stale: boolean
  /**
   * No other answer is to come for the request that stored it: a read's
   * answer or failure, or a kept total fresh enough not to be read again. A
   * kept total that is to be read again is not settled.
   */
  settled: boolean
  /** The request the latest answer stored here answered; see `storeAccountTotals`. */
  requestId: number
}

/** One answer of the account switcher's requests, as `storeAccountTotals` stores it. */
export interface AccountTotalUpdate {
  address: string
  /** The network it is stored under. */
  chainType: ChainType
  /** The request it answers; request ids grow with every request a page makes. */
  requestId: number
  /** In sats, or `null` when the answer measured none. */
  totalBalance: number | null
  readAt: number | null
  /**
   * The total may not be current: the latest read failed, or it may be from
   * before a transaction the wallet submitted. See `AccountTotalEntry.stale`.
   */
  stale: boolean
  /** See `AccountTotalEntry.settled`. */
  settled: boolean
}

const CHAIN_TYPES: ReadonlySet<string> = new Set(Object.values(ChainType))

/** Whether `value` names one of the wallet's networks. */
export function isChainType(value: unknown): value is ChainType {
  return typeof value === 'string' && CHAIN_TYPES.has(value)
}

/** Whether `value` is a number of sats: a safe integer, 0 or more. */
export function isSatoshiAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Stores `update`, unless its request was made before the latest reset or an
 * answer of a newer request is stored already. An answer without a total
 * keeps the total stored before it, marked as stale. An answer that is not
 * settled, a kept total that is to be read again, vouches for nothing: it
 * keeps a stale mark stored before it, so the total stays stale until a
 * settled answer (a read's, or a fresh kept total) says otherwise. The
 * addresses of each network are kept in an object without a prototype, so
 * that no address, whatever it is, can reach a built-in.
 */
function storeAccountTotal(state: AccountsState, update: AccountTotalUpdate): void {
  const { address, chainType, requestId } = update
  if (!isChainType(chainType) || typeof address !== 'string' || address === '') return
  if (typeof requestId !== 'number' || requestId <= state.accountTotalsFloor) return
  let totals = state.accountTotalsMap[chainType]
  if (totals === undefined) {
    totals = Object.create(null) as Record<string, AccountTotalEntry>
    state.accountTotalsMap[chainType] = totals
  }
  const stored = totals[address]
  if (stored !== undefined && requestId < stored.requestId) return
  if (isSatoshiAmount(update.totalBalance)) {
    const settled = update.settled === true
    totals[address] = {
      totalBalance: update.totalBalance,
      readAt: typeof update.readAt === 'number' ? update.readAt : null,
      stale: update.stale === true || (!settled && stored?.stale === true),
      settled,
      requestId,
    }
    return
  }
  totals[address] = {
    totalBalance: stored?.totalBalance ?? null,
    readAt: stored?.readAt ?? null,
    stale: true,
    settled: update.settled === true,
    requestId,
  }
}

/**
 * Answers of the account switcher's requests, stored together (see
 * `storeAccountTotal`). Answers that arrive close together come in one
 * action, so that a page shows them in one update.
 */
export const storeAccountTotals = createAction<AccountTotalUpdate[]>('accounts/storeAccountTotals')

/**
 * The account switcher made the requests up to `requestId`. A reset drops
 * the answers of every request made before it, so a total read for an erased
 * wallet never comes back.
 */
export const accountTotalsAsked = createAction<number>('accounts/accountTotalsAsked')

/**
 * The state a reset leaves: the initial one, except that the answers of the
 * requests made before it are dropped when they arrive.
 */
function resetAccounts(state: AccountsState): AccountsState {
  return {
    ...initialState,
    accountTotalsFloor: state.accountTotalsAsked,
    accountTotalsAsked: state.accountTotalsAsked,
  }
}

export interface BalanceRefreshStatus {
  requestId: number
  error: boolean
  /**
   * The refresh whose balance balanceV2Map holds, once one is stored. Only a
   * newer balance replaces it, and a newer failure does not; an older one
   * does only to put a split in place of an answer that could not read every
   * output (see `setBalanceV2`).
   */
  balanceRequestId?: number
}

function isStaleBalanceRequest(state: AccountsState, address: string, requestId?: number): boolean {
  const latest = state.balanceStatusMap[address]
  return requestId !== undefined && latest !== undefined && requestId < latest.requestId
}

/**
 * Records that the refresh `requestId` failed, unless a newer refresh has
 * already settled. The last known-good balance, if any, stays in
 * balanceV2Map.
 */
function recordBalanceFailure(state: AccountsState, address: string, requestId: number): void {
  if (isStaleBalanceRequest(state, address, requestId)) return
  state.balanceStatusMap[address] = {
    ...state.balanceStatusMap[address],
    requestId,
    error: true,
  }
}

/**
 * Whether `balance` has a split: its Available is known, and it is not an
 * answer that could not read every output. A total alone (past the
 * explorer's limit with no split, or while the send guard held) has none.
 */
function hasBalanceSplit(balance: QbitBalanceSummary | undefined): boolean {
  return typeof balance?.availableBalance === 'number' && balance.utxoReadIncomplete !== true
}

/**
 * Whether the balance stored for `address` has a split a read measured on
 * `chainType`: a read for that network stored it, and it has a split.
 */
function hasKnownBalanceSplit(state: AccountsState, address: string, chainType: string): boolean {
  return (
    hasAccountBalanceRead(state, address, chainType) && hasBalanceSplit(state.balanceV2Map[address])
  )
}

/**
 * Whether the balance stored for `address` is an answer read on `chainType`
 * that could not read every output: stored for its total, as no split for
 * that network was known when it arrived.
 */
function hasIncompleteBalance(state: AccountsState, address: string, chainType: string): boolean {
  return (
    hasAccountBalanceRead(state, address, chainType) &&
    state.balanceV2Map[address]?.utxoReadIncomplete === true
  )
}

/**
 * How a balance read ended, for the card (`BalanceReadRecord.outcome`):
 * `complete`, an answer whose split is known, or that is past the explorer's
 * listing limit, which is lasting and stated (`isCompleteBalance`);
 * `failed`, a read that rejected, that the card gave up on, or whose read of
 * the outputs got no further (`utxoReadFailed`); `partial`, any other
 * answer, whose split is unknown for a passing reason: the outputs not all
 * read yet, or the send guard busy.
 */
export type BalanceReadOutcomeKind = 'complete' | 'partial' | 'failed'

/** A failed read of the address, as `BalanceReadRecord.failed` counts it. */
export interface BalanceFailedRead {
  requestId: number
  /** When it began, in ms since the epoch; absent when the caller did not say. */
  startedAt?: number
}

/**
 * What the balance card knows of this page's reads of one address beyond
 * the answers themselves: the read in progress, what it reported before its
 * answer, the newest settled read, the failed reads no complete answer has
 * answered since, and the last complete split it can show. Ordered by the
 * same request ids as `balanceStatusMap` (see "Ordering" at
 * `balanceReadMap`).
 */
export interface BalanceReadRecord {
  /**
   * The newest read this page began, until a read at least as new settles:
   * the network the page showed as it began, when, and whether the user
   * asked for it (the refresh control), began it or joined it.
   */
  reading?: {
    requestId: number
    chainType: string
    startedAt: number
    byUser: boolean
  }
  /**
   * What the newest read reported before its answer
   * (`QBIT_BALANCE_READ_PROGRESS`), on the network it read: its total, once
   * the statistics answered, and how many of the outputs listed it has read.
   * Never from a read older than the newest settled one. An answer of that
   * read or of a newer one replaces it, and so does a newer read's report;
   * a failure does not: the total stays the newest the page has.
   */
  early?: {
    requestId: number
    chainType: string
    totalBalance?: number
    read?: number
    total?: number
  }
  /** The newest settled read, by request id: how it ended, and when it began. */
  outcome?: {
    requestId: number
    chainType: string
    kind: BalanceReadOutcomeKind
    startedAt?: number
  }
  /**
   * The failed reads on `chainType` since the trouble began, in request
   * order, whatever order they arrived in: what the card's failure rule
   * counts (see `balanceCardStatus`). The trouble ends, and the list with
   * it, when a read begun after the newest of them settles without failing:
   * with a complete answer, or an incomplete one that did not fail. Nothing
   * else ends it, an early total or a count of a read in flight included.
   */
  failed?: {
    chainType: string
    reads: BalanceFailedRead[]
  }
  /**
   * The total of the newest settled read that told one, on `chainType`: its
   * answer's, or, for a read that failed after its statistics answered, its
   * early total. The card shows it in place of an older complete answer
   * whose total differs, which the answers' maps keep in place (an answer
   * that could not read every output replaces no split there).
   */
  settledTotal?: {
    requestId: number
    chainType: string
    totalBalance: number
  }
  /**
   * The last complete split the card can show for the address on
   * `chainType`: the newest complete answer of this page's own (`own`, its
   * request id), or else the background's kept answer (`kept`, request id
   * -1), which a passing answer of the page's own left in its place. A
   * passing answer (outputs not all read, the send guard busy) with the same
   * total leaves it shown, dimmed, until a complete answer replaces it.
   */
  split?: {
    chainType: string
    source: 'own' | 'kept'
    requestId: number
    balance: QbitBalanceSummary
  }
  /**
   * The wallet locked after this page's reads up to this request id began
   * (`balanceReadsLocked`): an answer of those is from before the lock, and
   * shows as being refreshed until a complete answer of a read begun after
   * the lock replaces it.
   */
  staleUpTo?: number
}

/** A balance the background kept from an earlier read (`getKeptAddressBalance`). */
export interface KeptBalanceEntry {
  balance: QbitBalanceSummary
  /** When the read that answered it began, in ms since the epoch. */
  readAt: number
}

/**
 * Whether `balance` is complete: its split is known, or it is past the
 * explorer's listing limit, a lasting cause the card states. Anything else is
 * a split unknown for a passing reason. See `isCompleteQbitBalance`.
 */
export function isCompleteBalance(balance: QbitBalanceSummary | undefined): boolean {
  return isCompleteQbitBalance(balance)
}

/** How a read that answered `balance` ended (`BalanceReadOutcomeKind`). */
export function balanceReadOutcome(balance: QbitBalanceSummary): BalanceReadOutcomeKind {
  if (balance.utxoReadFailed === true) return 'failed'
  return isCompleteBalance(balance) ? 'complete' : 'partial'
}

function balanceReadRecord(state: AccountsState, address: string): BalanceReadRecord {
  let record = state.balanceReadMap[address]
  if (record === undefined) {
    record = {}
    state.balanceReadMap[address] = record
  }
  return record
}

/** The newest request id the record has seen settle. */
function newestSettled(record: BalanceReadRecord | undefined): number {
  return record?.outcome?.requestId ?? -Infinity
}

// Failures counted at most: the card's rule needs the count, the first and the latest.
const MAX_FAILED_READS = 16

/**
 * Counts the read `requestId` on `chainType` as failed, unless a complete
 * answer at least as new was stored for that network already.
 */
function noteFailedRead(
  record: BalanceReadRecord,
  chainType: string,
  requestId: number,
  startedAt: number | undefined
): void {
  const { split } = record
  if (split?.source === 'own' && split.chainType === chainType && split.requestId >= requestId) {
    return
  }
  if (record.failed?.chainType !== chainType) record.failed = { chainType, reads: [] }
  const { reads } = record.failed
  if (reads.some(read => read.requestId === requestId)) return
  reads.push({ requestId, ...(startedAt !== undefined ? { startedAt } : {}) })
  reads.sort((a, b) => a.requestId - b.requestId)
  // Keep the first and the newest.
  if (reads.length > MAX_FAILED_READS) reads.splice(1, reads.length - MAX_FAILED_READS)
}

/**
 * The complete answer of the read `requestId` on `chainType`, whenever it
 * arrives: the split to show from now on unless a newer complete answer is,
 * and, if it was begun after the lock, the end of what was read before it.
 */
function noteCompleteAnswer(
  record: BalanceReadRecord,
  chainType: string,
  requestId: number,
  balance: QbitBalanceSummary
): void {
  const { split } = record
  if (
    split === undefined ||
    split.chainType !== chainType ||
    split.source === 'kept' ||
    split.requestId < requestId
  ) {
    record.split = { chainType, source: 'own', requestId, balance: { ...balance } }
  }
  if (record.staleUpTo !== undefined && requestId > record.staleUpTo) delete record.staleUpTo
}

/**
 * Ends the trouble on `chainType` (`BalanceReadRecord.failed`) if the read
 * `requestId`, which settled without failing, was begun after every failed
 * read counted (or is the newest of them, answering after the card gave up
 * on it).
 */
function noteReadNotFailed(record: BalanceReadRecord, chainType: string, requestId: number): void {
  const failed = record.failed
  if (failed?.chainType !== chainType) return
  if (failed.reads.every(read => read.requestId <= requestId)) delete record.failed
}

/**
 * Records that the read `requestId` settled with `kind` on `chainType`, with
 * `balance` when it answered. A failure counts unless a newer read has
 * settled or a newer complete answer was stored; an answer that did not fail
 * ends the trouble if it is newer than every failure counted
 * (`BalanceReadRecord.failed`); a complete answer, whatever the order of
 * arrival, becomes the split to show unless a newer complete answer is; an
 * answer of the page's own drops the kept answer of its network (a passing
 * one leaves its split shown, see `BalanceReadRecord.split`). Then, unless a
 * newer read has settled already, it becomes the newest settled read: the
 * read in progress no newer than it is over, its total (or the early total
 * of a read that failed) is the newest settled one, and an answer replaces
 * the early report of every read no newer than it.
 */
function settleBalanceRead(
  state: AccountsState,
  address: string,
  settled: {
    requestId: number
    chainType: string | undefined
    kind: BalanceReadOutcomeKind
    startedAt?: number
    /** The answer; absent for a read that rejected or was given up on. */
    balance?: QbitBalanceSummary
  }
): void {
  const { requestId, kind, balance } = settled
  if (typeof requestId !== 'number') return
  const record = balanceReadRecord(state, address)
  const chainType = settled.chainType ?? record.reading?.chainType ?? ''
  const startedAt = typeof settled.startedAt === 'number' ? settled.startedAt : undefined
  const kept = state.balanceKeptMap[address]
  if (balance !== undefined && kept?.balance.chainType === chainType) {
    if (kind !== 'complete' && record.split?.chainType !== chainType) {
      record.split = { chainType, source: 'kept', requestId: -1, balance: kept.balance }
    }
    delete state.balanceKeptMap[address]
  }
  // A failure that arrives after a newer read settled is not counted: that
  // read says more of how the explorer answers now.
  const late = requestId < newestSettled(record)
  if (kind === 'failed' && !late) noteFailedRead(record, chainType, requestId, startedAt)
  if (kind !== 'failed' && balance !== undefined) noteReadNotFailed(record, chainType, requestId)
  if (kind === 'complete' && balance !== undefined) {
    noteCompleteAnswer(record, chainType, requestId, balance)
  }
  if (late) return
  const told =
    balance !== undefined
      ? { requestId, totalBalance: balance.totalBalance }
      : record.early !== undefined &&
          record.early.requestId <= requestId &&
          record.early.chainType === chainType
        ? { requestId: record.early.requestId, totalBalance: record.early.totalBalance }
        : undefined
  if (told !== undefined && isSatoshiAmount(told.totalBalance)) {
    record.settledTotal = {
      requestId: told.requestId,
      chainType,
      totalBalance: told.totalBalance,
    }
  }
  if (record.reading !== undefined && record.reading.requestId <= requestId) delete record.reading
  if (balance !== undefined && record.early !== undefined && record.early.requestId <= requestId) {
    delete record.early
  }
  record.outcome = { requestId, chainType, kind, ...(startedAt !== undefined ? { startedAt } : {}) }
}

/**
 * The card gave up on the read `requestId` of `address` (no answer within
 * its 60 s): it counts as a failed read, as a rejection does, but it is no
 * outcome of the answers (`balanceStatusMap` is left as it is).
 */
export const balanceReadGivenUp = createAction<{
  address: string
  requestId: number
  chainType: string
  startedAt?: number
}>('accounts/balanceReadGivenUp')

/**
 * The wallet locked, after this page began the reads up to `before`: every
 * answer of those is from before the lock (`BalanceReadRecord.staleUpTo`).
 */
export const balanceReadsLocked = createAction<{ before: number }>('accounts/balanceReadsLocked')

/**
 * The page (re)loaded its accounts for `chainType` (`useReloadAccounts`),
 * whether the load succeeded or not: see `AccountsState.accountsLoaded`.
 * `seq` orders the loads by when they began; a load that began before the
 * one recorded, ending after it, is not recorded. 0, or none, for the
 * accounts the page started with (`AccountUpdater`).
 */
export const accountsReloaded = createAction<{ chainType: string; seq?: number }>(
  'accounts/accountsReloaded'
)

/** A balance card shows `total`, replacing what any card published before. */
export const balanceCardTotalShown = createAction<BalanceCardTotal>(
  'accounts/balanceCardTotalShown'
)

/** The card `owner` shows no total any more: what it published is withdrawn. */
export const balanceCardTotalWithdrawn = createAction<{ owner: number }>(
  'accounts/balanceCardTotalWithdrawn'
)

/** The user asked for the read `requestId` of `address` in flight: see `BalanceReadRecord.reading`. */
export const balanceReadJoinedByUser = createAction<{ address: string; requestId: number }>(
  'accounts/balanceReadJoinedByUser'
)

/** This page began the read `requestId` of `address`: see `BalanceReadRecord.reading`. */
export const balanceReadStarted = createAction<{
  address: string
  requestId: number
  chainType: string
  startedAt: number
  byUser?: boolean
}>('accounts/balanceReadStarted')

function storeBalanceReadStarted(
  state: AccountsState,
  payload: ReturnType<typeof balanceReadStarted>['payload']
): void {
  const { address, requestId, chainType, startedAt } = payload
  const record = balanceReadRecord(state, address)
  if (requestId <= newestSettled(record)) return
  if (record.reading !== undefined && requestId <= record.reading.requestId) return
  record.reading = { requestId, chainType, startedAt, byUser: payload.byUser === true }
}

/**
 * What the read `requestId` of `address` reported before its answer: its
 * total, or how many outputs it has read. See `BalanceReadRecord.early`.
 */
export const balanceReadProgress = createAction<{
  address: string
  requestId: number
  chainType: string
  totalBalance?: number
  read?: number
  total?: number
}>('accounts/balanceReadProgress')

function storeBalanceReadProgress(
  state: AccountsState,
  payload: ReturnType<typeof balanceReadProgress>['payload']
): void {
  const { address, requestId, chainType, totalBalance, read, total } = payload
  const record = balanceReadRecord(state, address)
  if (requestId <= newestSettled(record)) return
  if (record.reading !== undefined && requestId < record.reading.requestId) return
  if (record.early !== undefined && requestId < record.early.requestId) return
  const same =
    record.early !== undefined &&
    record.early.requestId === requestId &&
    record.early.chainType === chainType
      ? record.early
      : undefined
  const early: NonNullable<BalanceReadRecord['early']> = { ...same, requestId, chainType }
  if (isSatoshiAmount(totalBalance)) early.totalBalance = totalBalance
  if (isSatoshiAmount(read) && isSatoshiAmount(total) && read <= total) {
    // Within a read the count never goes back, should its outputs be listed again.
    early.read = same?.total === total && same.read !== undefined ? Math.max(same.read, read) : read
    early.total = total
  }
  record.early = early
}

/**
 * The balance the background kept for `address` (`getKeptAddressBalance`):
 * stored only while this page has no answer of its own for the address on
 * that network, and over an older kept one only.
 */
export const setBalanceKept = createAction<{ address: string } & KeptBalanceEntry>(
  'accounts/setBalanceKept'
)

function storeBalanceKept(
  state: AccountsState,
  payload: ReturnType<typeof setBalanceKept>['payload']
): void {
  const { address, balance, readAt } = payload
  if (typeof address !== 'string' || address === '' || typeof readAt !== 'number') return
  if (!isCompleteBalance(balance) || !isChainType(balance.chainType)) return
  if (hasAccountBalanceRead(state, address, balance.chainType)) return
  const stored = state.balanceKeptMap[address]
  if (
    stored !== undefined &&
    stored.balance.chainType === balance.chainType &&
    stored.readAt > readAt
  ) {
    return
  }
  state.balanceKeptMap[address] = { balance, readAt }
}

export interface AccountsState {
  accounts: Account[]
  current: Account
  balanceV2Map: {
    [key: string]: QbitBalanceSummary
  }
  /**
   * Outcome of the latest balance refresh per address. On `error` the
   * balanceV2Map entry, if any, is the last known-good balance. `requestId`
   * orders refreshes so a slower, older response cannot replace the outcome
   * of a newer one, or a newer balance. An older balance that arrives after a
   * newer refresh failed is still the newest balance read: it is stored, and
   * the failure stays the outcome. An answer that could not read every
   * output is such a failure wherever a split for its network was read,
   * before or after it (see `setBalanceV2`).
   */
  balanceStatusMap: {
    [key: string]: BalanceRefreshStatus
  }
  /**
   * The balance card's record of this page's reads per address
   * (`BalanceReadRecord`), beside the answers: never read by any other
   * screen, and it changes nothing in `balanceV2Map` or `balanceStatusMap`.
   *
   * Ordering. An early total, a progress report, a kept answer and an
   * answer may arrive in any order, and from reads of different ages; the
   * request ids, which grow with every read a page begins, order them:
   * - An answer or a failure orders the answers as `balanceStatusMap`
   *   describes, and settles the record unless a newer read settled first:
   *   a late, older one changes no outcome, and drops nothing newer.
   * - An early total or a progress report of read R is kept only while R is
   *   newer than every settled read and no older than the newest read
   *   begun or reported, and only beside the answers: it never replaces one.
   *   An answer of R, or of a newer read, drops it.
   * - A read begun becomes the read in progress only if it is newer than
   *   every read begun and settled before it.
   * - A kept answer (`balanceKeptMap`) is never stored over an answer this
   *   page read for the address on that network, and such an answer drops
   *   it, so it never stands in for one.
   */
  balanceReadMap: {
    [address: string]: BalanceReadRecord
  }
  /**
   * The last complete answer the background kept for an address
   * (`getKeptAddressBalance`), shown dimmed until this page has an answer of
   * its own for that network (see `balanceReadMap` for how it is ordered).
   * Only the balance card reads it.
   */
  balanceKeptMap: {
    [address: string]: KeptBalanceEntry
  }
  historyMap: {
    [key: string]: {
      list: TxHistoryItem[]
      expired: boolean
      /** Absent only in state written before history totals were retained. */
      total?: number
      /** Txids from the remote first page paired with the stored total. */
      firstPageTxids?: string[]
      /** Carried pending txids verified by the node to still be in the API total. */
      verifiedPendingTxids?: string[]
      /** Opaque background snapshot used to keep later Qbit pages stable. */
      snapshotId?: string
      /** The last refresh failed; the last known-good list remains intact. */
      error?: boolean
    }
  }
  /**
   * The account switcher's totals, per network and then per address, from
   * the background's answers (`storeAccountTotals`). Like the rest of this
   * slice, never saved.
   */
  accountTotalsMap: {
    [chainType: string]: { [address: string]: AccountTotalEntry }
  }
  /** The latest request the account switcher made (`accountTotalsAsked`). */
  accountTotalsAsked: number
  /** Answers of requests up to this one, made before the latest reset, are dropped. */
  accountTotalsFloor: number
  /**
   * The network the page last (re)loaded its accounts for, and how many
   * loads it has made (`accountsReloaded`), succeeded or not. The balance
   * card, after a network switch, waits for the selected account to be the
   * new network's: until a load for that network ends, at the latest.
   */
  accountsLoaded?: { chainType: string; count: number; seq?: number }
  /**
   * The total the balance card shows, as it last published it
   * (`balanceCardTotalShown`), until it shows none, the balance is hidden,
   * or the card goes: the account switcher's row of the selected account
   * shows it (`useCurrentAccountBalanceTotal`).
   */
  balanceCardTotal?: BalanceCardTotal
}

/** The total a balance card shows, for one address on one network. */
export interface BalanceCardTotal {
  /** The card that shows it: only that card withdraws it. */
  owner: number
  address: string
  chainType: string
  /** In sats. */
  totalBalance: number
  /**
   * The total is the newest read's own (the early total of the read in
   * flight, or the total the newest settled read told), so a failed refresh
   * does not make it out of date.
   */
  totalCurrent: boolean
}

const initialAccount = {
  type: '',
  address: '',
  brandName: '',
  alianName: '',
  displayBrandName: '',
  index: 0,
  balance: 0,
  pubkey: '',
  key: '',
  flag: 0,
}

export const initialState: AccountsState = {
  accounts: [],
  current: initialAccount,
  balanceV2Map: {},
  balanceStatusMap: {},
  balanceReadMap: {},
  balanceKeptMap: {},
  historyMap: {},
  accountTotalsMap: {},
  accountTotalsAsked: 0,
  accountTotalsFloor: 0,
}

const slice: Slice<AccountsState> = createSlice({
  name: 'accounts',
  initialState,
  reducers: {
    setCurrent(state, action: { payload: Account }) {
      const { payload } = action
      state.current = payload || initialAccount
    },
    setAccounts(state, action: { payload: Account[] }) {
      const { payload } = action
      state.accounts = payload
    },
    setBalanceV2(
      state,
      action: {
        payload: {
          address: string
          balance: QbitBalanceSummary
          /** Orders this result against other refreshes; see balanceStatusMap. */
          requestId?: number
          /** When the read began, in ms since the epoch: see `BalanceReadRecord.outcome`. */
          startedAt?: number
        }
      }
    ) {
      settleBalanceRead(state, action.payload.address, {
        requestId:
          action.payload.requestId ??
          state.balanceStatusMap[action.payload.address]?.requestId ??
          0,
        chainType: action.payload.balance.chainType,
        kind: balanceReadOutcome(action.payload.balance),
        startedAt: action.payload.startedAt,
        balance: action.payload.balance,
      })
      const {
        payload: {
          balance: {
            availableBalance,
            unavailableBalance,
            totalBalance,
            immatureBalance,
            pendingBalance,
            utxoLimitExceeded,
            utxoReadIncomplete,
            chainType,
          },
          address,
          requestId,
        },
      } = action
      const latest = state.balanceStatusMap[address]
      if (
        requestId !== undefined &&
        latest?.balanceRequestId !== undefined &&
        requestId < latest.balanceRequestId
      ) {
        // Older than the balance stored, it replaces nothing, except where
        // the stored balance is an answer that could not read every output
        // and this one has the split for its network. Then it is the newest
        // split read, and lands as an older balance does after a newer
        // failure: it is stored, and the newer read stays the outcome, now
        // as a failed refresh. The store ends as it would have had the two
        // arrived in order.
        if (
          !hasBalanceSplit(action.payload.balance) ||
          !hasIncompleteBalance(state, address, chainType)
        ) {
          return
        }
        latest.balanceRequestId = requestId
        latest.error = true
      } else if (utxoReadIncomplete === true && hasKnownBalanceSplit(state, address, chainType)) {
        // An answer that could not read every output, where a split is
        // already stored for this account on this network, replaces nothing:
        // it is recorded as a refresh that failed, under the same ordering,
        // so the split stays, marked out of date, and nothing of the answer
        // is kept. Only where no split is known (the first read, or a total
        // alone) is it stored, for its total, until a split arrives.
        recordBalanceFailure(state, address, requestId ?? latest?.requestId ?? 0)
        return
      } else if (latest !== undefined && isStaleBalanceRequest(state, address, requestId)) {
        // A newer refresh failed first: keep its failure as the outcome.
        latest.balanceRequestId = requestId
      } else {
        const outcomeRequestId = requestId ?? latest?.requestId ?? 0
        state.balanceStatusMap[address] = {
          requestId: outcomeRequestId,
          error: false,
          balanceRequestId: outcomeRequestId,
        }
      }
      state.balanceV2Map[address] = state.balanceV2Map[address] || {
        availableBalance: 0,
        unavailableBalance: 0,
        totalBalance: 0,
        chainType,
      }
      state.balanceV2Map[address].availableBalance = availableBalance
      state.balanceV2Map[address].unavailableBalance = unavailableBalance
      state.balanceV2Map[address].totalBalance = totalBalance
      state.balanceV2Map[address].immatureBalance = immatureBalance
      state.balanceV2Map[address].pendingBalance = pendingBalance
      state.balanceV2Map[address].utxoLimitExceeded = utxoLimitExceeded
      state.balanceV2Map[address].utxoReadIncomplete = utxoReadIncomplete
      state.balanceV2Map[address].chainType = chainType
    },
    setBalanceError(
      state,
      action: {
        payload: {
          address: string
          requestId: number
          /** The network the page showed as the read began. */
          chainType?: string
          /** When the read began, in ms since the epoch. */
          startedAt?: number
        }
      }
    ) {
      const { address, requestId } = action.payload
      settleBalanceRead(state, address, {
        requestId,
        chainType: action.payload.chainType,
        kind: 'failed',
        startedAt: action.payload.startedAt,
      })
      recordBalanceFailure(state, address, requestId)
    },
    setHistory(
      state,
      action: {
        payload: {
          address: string
          list: TxHistoryItem[]
          total?: number
          firstPageTxids?: string[]
          verifiedPendingTxids?: string[]
          snapshotId?: string
        }
      }
    ) {
      const {
        payload: { address, list, total, firstPageTxids, verifiedPendingTxids, snapshotId },
      } = action
      state.historyMap[address] = state.historyMap[address] || {
        list: [],
        expired: true,
        total: 0,
      }
      state.historyMap[address].list = list
      state.historyMap[address].firstPageTxids = firstPageTxids
      state.historyMap[address].verifiedPendingTxids = verifiedPendingTxids
      state.historyMap[address].snapshotId = snapshotId
      state.historyMap[address].error = false
      if (total !== undefined) {
        state.historyMap[address].total = total
      }
      state.historyMap[address].expired = false
    },
    setHistoryError(state, action: { payload: { address: string } }) {
      const { address } = action.payload
      state.historyMap[address] = state.historyMap[address] || {
        list: [],
        expired: true,
        total: 0,
      }
      state.historyMap[address].error = true
    },
    setCurrentAddressFlag(state, action: { payload: number }) {
      const { payload } = action
      state.current.flag = payload
      const account = state.accounts.find(v => v.address === state.current.address)
      if (account) {
        account.flag = payload
      }
    },
    reset(state) {
      return resetAccounts(state)
    },
    updateAccountName(
      state,
      action: {
        payload: Account
      }
    ) {
      const account = action.payload
      if (state.current.key === account.key) {
        state.current.alianName = account.alianName!
      }
      state.accounts.forEach(v => {
        if (v.key === account.key) {
          v.alianName = account.alianName!
        }
      })
    },
  },
  extraReducers: builder => {
    builder.addCase(balanceReadStarted, (state, action) => {
      storeBalanceReadStarted(state, action.payload)
    })
    builder.addCase(balanceReadProgress, (state, action) => {
      storeBalanceReadProgress(state, action.payload)
    })
    builder.addCase(setBalanceKept, (state, action) => {
      storeBalanceKept(state, action.payload)
    })
    builder.addCase(balanceReadGivenUp, (state, action) => {
      const { address, requestId, chainType, startedAt } = action.payload
      settleBalanceRead(state, address, { requestId, chainType, kind: 'failed', startedAt })
    })
    builder.addCase(balanceReadsLocked, (state, action) => {
      const { before } = action.payload
      if (typeof before !== 'number') return
      for (const record of Object.values(state.balanceReadMap)) {
        record.staleUpTo = Math.max(record.staleUpTo ?? before, before)
      }
    })
    builder.addCase(accountsReloaded, (state, action) => {
      const { chainType } = action.payload
      if (typeof chainType !== 'string') return
      const seq = typeof action.payload.seq === 'number' ? action.payload.seq : 0
      // An older load ending late: the newer one recorded stands.
      if (seq < (state.accountsLoaded?.seq ?? 0)) return
      state.accountsLoaded = { chainType, count: (state.accountsLoaded?.count ?? 0) + 1, seq }
    })
    builder.addCase(balanceCardTotalShown, (state, action) => {
      state.balanceCardTotal = { ...action.payload }
    })
    builder.addCase(balanceCardTotalWithdrawn, (state, action) => {
      if (state.balanceCardTotal?.owner === action.payload.owner) delete state.balanceCardTotal
    })
    builder.addCase(balanceReadJoinedByUser, (state, action) => {
      const reading = state.balanceReadMap[action.payload.address]?.reading
      if (reading?.requestId === action.payload.requestId) reading.byUser = true
    })
    builder.addCase(storeAccountTotals, (state, action) => {
      for (const update of action.payload) storeAccountTotal(state, update)
    })
    builder.addCase(accountTotalsAsked, (state, action) => {
      if (typeof action.payload === 'number' && action.payload > state.accountTotalsAsked) {
        state.accountTotalsAsked = action.payload
      }
    })
    builder.addCase(resetWalletState, state => resetAccounts(state))
  },
})

export const accountActions = slice.actions
export default slice.reducer

/**
 * Whether the balance stored for `address` is a complete answer this page
 * read on `chainType` (`isCompleteBalance`).
 */
export function hasCompleteBalanceRead(
  state: AccountsState,
  address: string,
  chainType: string
): boolean {
  return (
    hasAccountBalanceRead(state, address, chainType) &&
    isCompleteBalance(state.balanceV2Map[address])
  )
}

/**
 * Whether a balance read for `address` on `chainType` has succeeded: only a
 * successful read stores one. Until then `useAccountBalance` stands in
 * zeros, which are no measurement and show as unknown (`--`), unlike a 0 a
 * read returned.
 */
export function hasAccountBalanceRead(
  state: AccountsState,
  address: string,
  chainType: string
): boolean {
  return state.balanceV2Map[address]?.chainType === chainType
}
