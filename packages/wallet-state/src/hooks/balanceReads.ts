import type { QbitBalanceReadProgress, QbitBalanceSummary } from '@qbit/wallet-shared'
import { QBIT_BALANCE_READ_PROGRESS } from '@qbit/wallet-shared'
import type { AnyAction, Dispatch } from '@reduxjs/toolkit'

import { balanceReadProgress } from '../reducers/accounts'
import { uiEventBus } from '../utils/eventBus'

/** A balance read this page has in flight for an address. */
export interface BalanceReadInFlight {
  readonly requestId: number
  readonly reading: Promise<QbitBalanceSummary | undefined>
  /** When it began, in ms since the epoch, and the network the page showed then. */
  readonly startedAt: number
  readonly chainType: string
  /** Stops recording the read's progress events (`followBalanceRead`). */
  readonly unfollow?: () => void
}

/** What reads the selected account's balance for the balance card (its poll). */
export interface BalanceCardReader {
  /** Reads now, as one of the card's reads. */
  read(options?: { byUser?: boolean }): Promise<QbitBalanceSummary | undefined>
}

/**
 * One page's balance reads: the newest in flight per address, from whichever
 * caller began it, a read asked for to begin after it, and the balance
 * card's poll per address while the card is shown. One read of an account
 * at a time: the page opens with one read of the selected account, and it
 * is the card's (the account updater hands its read to the card's poll when
 * the card is shown, and a card shown while the updater's read is in flight
 * takes that read as its own first one, see `useBalanceCardLogic`); a read
 * the user asks for joins the one in flight; a read asked for from
 * elsewhere (a refresh after a broadcast) begins once the one in flight has
 * settled (`requestBalanceRead`). A read leaves the reads in flight as it
 * settles, once the card gives up on it after 60 s (`forgetBalanceRead`), or
 * once a read queued behind it finds it lost, with no card to give up on it
 * (`requestBalanceRead`).
 */
interface PageBalanceReads {
  readonly inFlight: Map<string, BalanceReadInFlight>
  /** The newest read begun per address, settled or not. */
  readonly lastBegun: Map<string, BalanceReadInFlight>
  /** A read asked for to begin once the one in flight has settled, per address. */
  readonly queued: Map<string, QueuedBalanceRead>
  readonly cards: Map<string, BalanceCardReader>
  /**
   * The addresses whose card waits for the selected account to be the new
   * network's (`setBalanceCardWaiting`): nothing reads them meanwhile.
   */
  readonly waiting: Set<string>
  /**
   * Per network and address, the trouble whose failure the card has shown
   * (by its first failed read's request id), so a page shown again, or a
   * card shown again, keeps it on screen (`noteBalanceFailureShown`).
   */
  readonly failuresShown: Map<string, number>
}

/**
 * How long a read of the page may stay unanswered before it is taken as
 * lost: the balance card's poll gives up on one of its reads this old, and
 * counts it as failed, the one owner of that give-up (`useBalanceCardLogic`).
 */
export const BALANCE_READ_GIVE_UP_MS = 60_000

// A read asked for while another is in flight waits for it at most until it
// is this much older than the give-up: strictly after the card's own give-up
// on a read it holds, so a card shown always gives up first, and the queued
// read's own deadline matters only where no card does (a page without the
// card, or the card hidden, its poll paused).
const QUEUED_READ_WAITS_PAST_GIVE_UP_MS = 1_000

// Every read the page began, by its promise, while the promise is held: so
// the card's give-up finds the read it holds even once another read has
// taken its place in flight.
const readsBegun = new WeakMap<Promise<unknown>, BalanceReadInFlight>()

/**
 * A read asked for while another was in flight (`requestBalanceRead`): it
 * begins once that one settles, once the card gives up on it
 * (`forgetBalanceRead`), or once that one is past the give-up with no card
 * to give up on it, whichever comes first.
 */
interface QueuedBalanceRead {
  /** What its callers wait for. */
  readonly reading: Promise<QbitBalanceSummary | undefined>
  /** The read it waits for. */
  readonly after: Promise<QbitBalanceSummary | undefined>
  /** Begins it, once. */
  readonly start: () => void
}

const pages = new WeakMap<object, PageBalanceReads>()

/** The balance reads of the page whose store is `store`. */
export function pageBalanceReads(store: object): PageBalanceReads {
  let page = pages.get(store)
  if (page === undefined) {
    page = {
      inFlight: new Map(),
      lastBegun: new Map(),
      queued: new Map(),
      cards: new Map(),
      waiting: new Set(),
      failuresShown: new Map(),
    }
    pages.set(store, page)
  }
  return page
}

/** The newest read in flight for `address` on the page of `store`, if any. */
export function balanceReadInFlight(
  store: object,
  address: string
): BalanceReadInFlight | undefined {
  return pageBalanceReads(store).inFlight.get(address)
}

/** Note `read` as the newest in flight for `address` until it settles. */
export function noteBalanceReadInFlight(
  store: object,
  address: string,
  read: BalanceReadInFlight
): void {
  const { inFlight, lastBegun } = pageBalanceReads(store)
  inFlight.set(address, read)
  lastBegun.set(address, read)
  readsBegun.set(read.reading, read)
  const settled = (): void => {
    // A newer read for the address stays noted.
    if (inFlight.get(address) === read) inFlight.delete(address)
  }
  read.reading.then(settled, settled)
}

/**
 * Stop counting `reading` as the read in flight for `address`, as when the
 * card gave up on it, and stop recording its progress; the entry it had,
 * whether it was still the one in flight or another read has taken its
 * place since (one queued behind it, begun once it was lost).
 */
export function forgetBalanceRead(
  store: object,
  address: string,
  reading: Promise<unknown>
): BalanceReadInFlight | undefined {
  const { inFlight, queued } = pageBalanceReads(store)
  const read = readsBegun.get(reading)
  if (read === undefined) return undefined
  if (inFlight.get(address) === read) inFlight.delete(address)
  read.unfollow?.()
  // A read asked for after it no longer waits for it: it begins, once the
  // caller that gave up has done so (the card's poll counts the failure first).
  const next = queued.get(address)
  if (next !== undefined && next.after === reading) {
    void Promise.resolve().then(() => next.start())
  }
  return read
}

/**
 * Mark the card of `address` as waiting for the selected account to be the
 * new network's, until the returned function is called: meanwhile a read
 * asked for from elsewhere is refused (`requestBalanceRead`).
 */
export function setBalanceCardWaiting(store: object, address: string): () => void {
  const { waiting } = pageBalanceReads(store)
  waiting.add(address)
  return () => {
    waiting.delete(address)
  }
}

/** Whether the card of `address` waits for the selected account to be the new network's. */
export function balanceCardWaiting(store: object, address: string): boolean {
  return pageBalanceReads(store).waiting.has(address)
}

/**
 * The card has shown a failure for the trouble whose first failed read is
 * `firstFailed` (a request id), for `address` on `chainType`.
 */
export function noteBalanceFailureShown(
  store: object,
  address: string,
  chainType: string,
  firstFailed: number
): void {
  pageBalanceReads(store).failuresShown.set(`${chainType}:${address}`, firstFailed)
}

/**
 * Whether the card has shown a failure for the trouble whose first failed
 * read is `firstFailed`, for `address` on `chainType`.
 */
export function balanceFailureShown(
  store: object,
  address: string,
  chainType: string,
  firstFailed: number
): boolean {
  return pageBalanceReads(store).failuresShown.get(`${chainType}:${address}`) === firstFailed
}

/**
 * A read of `address` that begins now, by `begin`, unless one is in flight:
 * then one that begins once it has settled, once the card has given up on it
 * (`forgetBalanceRead`), or, where no card gives up on it, once it is past
 * `BALANCE_READ_GIVE_UP_MS`: then it is dropped from the reads in flight
 * (unless a newer read has taken its place) and the request is made again,
 * by these same rules. Shared by every caller that asks meanwhile. So a
 * refresh after a broadcast always reads after the call, never beside
 * another read of the account, and a read that never answers holds up none.
 * While the card waits for the selected account to be the new network's
 * (`setBalanceCardWaiting`), nothing is read: the request is refused,
 * resolving with nothing.
 */
export function requestBalanceRead(
  store: object,
  address: string,
  begin: () => Promise<QbitBalanceSummary | undefined>
): Promise<QbitBalanceSummary | undefined> {
  const { inFlight, queued, waiting: waitingForAccount } = pageBalanceReads(store)
  if (waitingForAccount.has(address)) return Promise.resolve(undefined)
  const read = inFlight.get(address)
  if (read === undefined) return begin()
  const waiting = queued.get(address)
  if (waiting !== undefined) return waiting.reading
  let resolve: (reading: Promise<QbitBalanceSummary | undefined>) => void = () => undefined
  const reading = new Promise<QbitBalanceSummary | undefined>(settle => {
    resolve = settle
  })
  let started = false
  const start = (readLost: boolean): void => {
    if (started) return
    started = true
    clearTimeout(lost)
    if (queued.get(address) === entry) queued.delete(address)
    if (readLost) {
      // Lost, and no card gave up on it: no longer in flight, unless a newer
      // read has taken its place, and its progress no longer recorded.
      if (inFlight.get(address) === read) inFlight.delete(address)
      read.unfollow?.()
    }
    // Asked again: refused during the wait for the new network's account,
    // behind a newer read in flight, else at once.
    resolve(requestBalanceRead(store, address, begin))
  }
  const entry: QueuedBalanceRead = { reading, after: read.reading, start: () => start(false) }
  const settled = (): void => start(false)
  read.reading.then(settled, settled)
  const lost = setTimeout(
    () => start(true),
    Math.max(
      0,
      read.startedAt + BALANCE_READ_GIVE_UP_MS + QUEUED_READ_WAITS_PAST_GIVE_UP_MS - Date.now()
    )
  )
  queued.set(address, entry)
  return reading
}

/** The newest read this page began for `address`, settled or not, if any. */
export function lastBalanceReadBegun(
  store: object,
  address: string
): BalanceReadInFlight | undefined {
  return pageBalanceReads(store).lastBegun.get(address)
}

/**
 * Hand the balance card's reads of `address` to `card` until the returned
 * function is called; the card shown last for an address holds them.
 */
export function registerBalanceCard(
  store: object,
  address: string,
  card: BalanceCardReader
): () => void {
  const { cards } = pageBalanceReads(store)
  cards.set(address, card)
  return () => {
    if (cards.get(address) === card) cards.delete(address)
  }
}

/** The balance card reading `address` on the page of `store`, while one is shown. */
export function balanceCardFor(store: object, address: string): BalanceCardReader | undefined {
  return pageBalanceReads(store).cards.get(address)
}

let progressIdSequence = 0

/** A fresh id that matches the background's `progressId` rule (1 to 64 of `[A-Za-z0-9_-]`). */
export function newBalanceProgressId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return random
  progressIdSequence += 1
  return `balance-${Date.now().toString(36)}-${progressIdSequence.toString(36)}`
}

interface FollowedRead {
  address: string
  requestId: number
  dispatch: Dispatch<AnyAction>
}

/** This page's balance reads in flight that asked for their progress, by `progressId`. */
const followed = new Map<string, FollowedRead>()
let listening = false

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * A `QBIT_BALANCE_READ_PROGRESS` event: recorded against the read of this
 * page that asked for it, under that read's request id, so that the reducer
 * orders it against the answers (`balanceReadProgress`). An event of another
 * page's read, or of a read settled since, names no read here and is
 * dropped.
 */
function onBalanceReadProgress(event?: Partial<QbitBalanceReadProgress>): void {
  if (!event || typeof event.progressId !== 'string') return
  const read = followed.get(event.progressId)
  if (read === undefined || event.address !== read.address) return
  if (typeof event.chainType !== 'string') return
  const base = { address: read.address, requestId: read.requestId, chainType: event.chainType }
  if (event.kind === 'total' && isCount(event.totalBalance)) {
    read.dispatch(balanceReadProgress({ ...base, totalBalance: event.totalBalance }))
  } else if (
    event.kind === 'outputs' &&
    isCount(event.read) &&
    isCount(event.total) &&
    event.read <= event.total
  ) {
    read.dispatch(balanceReadProgress({ ...base, read: event.read, total: event.total }))
  }
}

/**
 * Record the progress events of the read `progressId` against `read` until
 * the returned function is called, which the read calls as it settles.
 */
export function followBalanceRead(progressId: string, read: FollowedRead): () => void {
  if (!listening) {
    listening = true
    uiEventBus.addEventListener(QBIT_BALANCE_READ_PROGRESS, onBalanceReadProgress)
  }
  followed.set(progressId, read)
  return () => {
    if (followed.get(progressId) === read) followed.delete(progressId)
  }
}
