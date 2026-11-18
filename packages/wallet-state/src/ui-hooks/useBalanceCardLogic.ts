import { numUtils } from '@qbit/base-utils'
import type { Account, QbitBalanceSummary } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { AppState, uiActions } from 'src'
import { useI18n } from '../context'
import { useWallet } from '../context/WalletContext'
import {
  balanceReadGivenUp,
  balanceReadJoinedByUser,
  hasAccountBalanceRead,
  hasCompleteBalanceRead,
  isCompleteBalance,
  setBalanceKept,
  type BalanceReadRecord,
  type KeptBalanceEntry,
} from '../reducers/accounts'
import {
  useBalanceCardDetailExpanded,
  useChain,
  useQbitUnit,
  useStartBalanceReadCallback,
  useToggleBalanceCardDetailExpanded,
  type FetchBalanceOptions,
} from '../hooks'
import {
  BALANCE_READ_GIVE_UP_MS,
  balanceFailureShown,
  balanceReadInFlight,
  forgetBalanceRead,
  lastBalanceReadBegun,
  noteBalanceFailureShown,
  registerBalanceCard,
  setBalanceCardWaiting,
} from '../hooks/balanceReads'
import { qbitSendPlanCountFormat } from '../utils/qbit-send-plan'

const DEBOUNCE_DELAY = 1000

// The card reads the balance every 10 seconds while reads succeed. After a
// failed read it waits 10, 20, 40 seconds and so on, at most 2 minutes,
// counted from when that read ended, until a read succeeds again.
const POLL_INTERVAL = 10_000
const MAX_POLL_INTERVAL = 120_000
// A tick that fell due while one of the card's reads was in flight runs this
// long after the reads settle, or when the back-off allows if that is later.
// An account with thousands of outputs takes several reads of up to 20
// seconds each to read through: they then follow each other closely instead
// of an idle interval apart.
const POLL_CATCH_UP_DELAY = 2_000
// A card read in flight this long no longer holds the poll: three times the
// background's own 20-second deadline, so only a read whose answer is lost is
// given up on. It counts as a failed read that ended when it got stuck, so the
// next read comes the back-off after that, beside it if it is still open;
// whatever it does later changes nothing in the cadence, and the reducer's
// request ids keep its late answer from replacing a newer one.
const POLL_READ_GIVE_UP = BALANCE_READ_GIVE_UP_MS
// While this page shows no complete answer of its own for the account (the
// first read, or every one since, brought none: it failed, was rejected, ran
// out of time part of the way through the outputs, or found the send guard
// busy), the next read follows the one that ended this soon, then this, then
// this, and only then the 10 s cadence and the back-off above, which count
// from there as after a first failure. A healthy read takes 0.4 to 1.5 s and
// a lookup that failed once usually answers a second later: 1.5 s lets the
// explorer breathe, and the doubling makes four reads in the first ~10 s, so
// that most passing failures heal well inside the 30 s before the card shows
// one (`BALANCE_ESCALATE_AFTER_MS`), at three extra reads at most per stretch.
const POLL_QUICK_RETRY_DELAYS = [1_500, 3_000, 6_000] as const
// Over a complete answer shown, the first read that fails is followed by one
// more this soon after it ended, before the back-off: a passing failure then
// leaves the shown value dimmed for a moment only.
const POLL_RETRY_AFTER_FIRST_FAILURE = 2_000
// A page shown again with a failure counted reads at once, but never sooner
// than this after the previous read began: switching tabs back and forth
// during an outage sends no burst of requests.
const POLL_SHOWN_AGAIN_GAP = 2_000
// A card shown this soon after the page began a read of the account that has
// brought a complete answer (the account updater's, at an unlock in the
// page, answered before the home screen mounted) takes that read as its
// first, and reads next one interval after it began, instead of again at
// once.
const BALANCE_JUST_READ_MS = 2_000

function pollInterval(failures: number): number {
  return Math.min(POLL_INTERVAL * 2 ** Math.max(0, failures - 1), MAX_POLL_INTERVAL)
}

/**
 * The document whose visibility pauses the poll. A platform without a DOM
 * has none, and there the poll never pauses.
 */
function visibilityDocument(): Document | undefined {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return undefined
  }
  return document
}

/**
 * What the promise of a card read rejects with once the poll no longer waits
 * for its answer: it gave up on the read (`POLL_READ_GIVE_UP`), or it
 * stopped. The read itself goes on, and what it does later reaches no one.
 */
class BalanceReadGaveUpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BalanceReadGaveUpError'
  }
}

interface BalancePoll {
  /**
   * Reads the balance now, as one of the card's reads. Settles as the read
   * does, or rejects with `BalanceReadGaveUpError` once the poll gives up on
   * it or stops, whichever comes first.
   */
  read(options?: FetchBalanceOptions): Promise<QbitBalanceSummary | undefined>
  /**
   * Takes `reading`, a read of this account another caller of this page
   * began at `startedAt` (the account updater's, at open), as one of the
   * card's reads, as if the poll had begun it then: it holds the poll and
   * paces the next read as `read` does.
   */
  adopt(reading: Promise<QbitBalanceSummary | undefined>, startedAt?: number): Promise<unknown>
  /**
   * What the callers of `reading`, one of the poll's reads in flight, wait
   * for: the read's outcome, or the poll letting go of it first (it gives up
   * on it, or stops). Undefined if the poll does not hold that read.
   */
  join(reading: Promise<unknown>): Promise<QbitBalanceSummary | undefined> | undefined
  /**
   * When the poll's next read is due, in ms since the epoch: undefined while
   * one of its reads is in flight, the page is hidden, or it has stopped.
   */
  nextReadAt(): number | undefined
  /** Clears the timer and the listener, and lets go of the reads in flight. */
  stop(): void
}

/** `startBalancePoll`'s options. */
export interface BalancePollOptions {
  /**
   * Whether this page shows no complete answer of its own for the account
   * on this network (`hasCompleteBalanceRead`), asked as each read ends,
   * after its answer is stored: until it does, a read that ends is followed
   * quickly (`POLL_QUICK_RETRY_DELAYS`).
   */
  showsNoCompleteAnswer?: () => boolean
  /**
   * When the read the poll takes as its first, already settled, began: the
   * next read is one interval after it rather than after the poll starts.
   */
  lastReadStartedAt?: number
  /**
   * Told of each read the poll gives up on (`POLL_READ_GIVE_UP`), by the
   * promise it held, which the poll no longer waits for.
   */
  onGiveUp?: (reading: Promise<QbitBalanceSummary | undefined>) => void
  /**
   * Whether the card counts a failed read now, asked as the page is shown
   * again: if it does, the poll reads at once, whatever its back-off (but
   * not within `POLL_SHOWN_AGAIN_GAP` of the previous read's start), so a
   * failure shown before the page was hidden is decided again soon.
   */
  readsWhenShownAgain?: () => boolean
  /**
   * Told whenever the poll's schedule changes (a read begins or settles, the
   * next read is due at another time), so a caller showing `nextReadAt`
   * renders again.
   */
  onScheduleChange?: () => void
}

/** A card read in flight that still holds the poll. */
interface HeldRead {
  readonly startedAt: number
  /** The read's own promise, as `begin` gave it. */
  reading?: Promise<QbitBalanceSummary | undefined>
  /** What its callers wait for: the read's outcome, or the poll letting go of it. */
  promise?: Promise<QbitBalanceSummary | undefined>
  /** Rejects `promise`, unless the read has settled it. */
  readonly release: (error: BalanceReadGaveUpError) => void
}

/**
 * The card's reads of one account's balance on one network, and the poll
 * between them. Each read is one interval after the last one started; a read
 * that fails, by rejecting or with an answer whose read of the outputs failed
 * (`utxoReadFailed`), is followed by the back-off, counted from when it
 * ended. An answer that ran out of time part of the way through is progress,
 * and keeps the pace. A tick never runs beside one of the card's reads, so
 * slow reads cannot pile up behind each other: one that falls due meanwhile
 * is remembered (one, however many fall due) and runs a short pause after
 * the reads settle, or when the back-off allows if that is later. A read in
 * flight for `POLL_READ_GIVE_UP` no longer holds the poll, and counts as a
 * failed read from then. While the page is hidden nothing is read; shown
 * again, it reads at once if a tick is due.
 *
 * While the page shows no complete answer of its own for the account
 * (`options.showsNoCompleteAnswer`), a read that ends with none is followed
 * 1.5, 3 and then 6 s after it ended (`POLL_QUICK_RETRY_DELAYS`), these not
 * counting as failures for the back-off; past them the cadence above goes
 * on. A complete answer shown starts the quick reads over for the next
 * stretch without one.
 *
 * Only the card's own reads count here, the account updater's and a refresh
 * after a broadcast among them, which come through this poll while the card
 * is shown (`pageBalanceReads`); a read the user asks for joins the one in
 * flight. The request id the reducer orders replies by keeps an older reply
 * from replacing a newer one.
 *
 * Exported for its tests; the package exports only `useBalanceCardLogic`.
 */
export function startBalancePoll(
  fetchBalance: (options?: FetchBalanceOptions) => Promise<QbitBalanceSummary | undefined>,
  options: BalancePollOptions = {}
): BalancePoll {
  const visibility = visibilityDocument()
  const isHidden = (): boolean => visibility?.hidden === true
  let stopped = false
  // Failed reads in a row, given-up ones included; an answer that ran out of
  // time part of the way through is not one, since each such read takes the
  // background further through the outputs.
  let failures = 0
  // The card's reads in flight that still hold the poll.
  const holding = new Set<HeldRead>()
  // A tick fell due while a read was in flight, and runs once the reads settle.
  let tickMissed = false
  // Quick reads made since the page last showed a complete answer of its own.
  let quickRetries = 0
  // The read after the first failure over a complete answer came quickly
  // (`POLL_RETRY_AFTER_FIRST_FAILURE`); until a read succeeds again.
  let retriedAfterFailure = false
  // A new account or network counts from when its cadence starts.
  let lastStartAt = Math.min(Date.now(), options.lastReadStartedAt ?? Date.now())
  let dueAt = lastStartAt + pollInterval(failures)
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  // Runs the next tick at `dueAt`, or when the oldest read in flight is to be
  // given up on if that comes first, whatever the interval; while the page is
  // shown, and never later than one interval from now, whatever the clock did
  // in between.
  const arm = (): void => {
    clearTimer()
    if (stopped) return
    if (!isHidden()) {
      let at = dueAt
      for (const held of holding) at = Math.min(at, held.startedAt + POLL_READ_GIVE_UP)
      const delay = Math.min(Math.max(0, at - Date.now()), pollInterval(failures))
      timer = setTimeout(tick, delay)
    }
    options.onScheduleChange?.()
  }

  const scheduleAt = (at: number): void => {
    dueAt = at
    arm()
  }

  const hold = (
    begin: () => Promise<QbitBalanceSummary | undefined>,
    startedAt = Date.now()
  ): Promise<QbitBalanceSummary | undefined> => {
    let release: (error: BalanceReadGaveUpError) => void = () => undefined
    const held: HeldRead = {
      startedAt: Math.min(startedAt, Date.now()),
      release: error => release(error),
    }
    holding.add(held)
    lastStartAt = held.startedAt
    // It answers a tick that fell due before it.
    tickMissed = false
    scheduleAt(lastStartAt + pollInterval(failures))
    const reading = begin()
    held.reading = reading
    const settle = (failed: boolean): void => {
      // Stopped, or given up on: what it does changes nothing here.
      if (stopped || !holding.delete(held)) return
      if (!failed) retriedAfterFailure = false
      if (options.showsNoCompleteAnswer?.() !== true) {
        quickRetries = 0
        if (failed && failures === 0 && !retriedAfterFailure && holding.size === 0) {
          // The first failure over a complete answer: once more, soon.
          retriedAfterFailure = true
          tickMissed = false
          scheduleAt(Date.now() + POLL_RETRY_AFTER_FIRST_FAILURE)
          return
        }
      } else if (holding.size === 0 && quickRetries < POLL_QUICK_RETRY_DELAYS.length) {
        // Nothing complete shown yet: read again soon, counted from now.
        // The ticks missed meanwhile are answered by that read.
        const delay = POLL_QUICK_RETRY_DELAYS[quickRetries] ?? POLL_INTERVAL
        quickRetries += 1
        tickMissed = false
        scheduleAt(Date.now() + delay)
        return
      }
      const before = pollInterval(failures)
      failures = failed ? failures + 1 : 0
      const after = pollInterval(failures)
      if (failed) {
        // The back-off counts from when the failed read ended. A tick missed
        // meanwhile stays remembered: another read still in flight that
        // answers last ends the back-off, and runs it as after any answer.
        scheduleAt(Date.now() + after)
      } else if (tickMissed && holding.size === 0) {
        // The tick missed runs after a short pause, or one interval after
        // the last read started if that is later.
        tickMissed = false
        scheduleAt(Math.max(Date.now() + POLL_CATCH_UP_DELAY, lastStartAt + after))
      } else if (after !== before) {
        // The tick waiting moves by as much as the interval changed.
        scheduleAt(dueAt + after - before)
      } else {
        // It no longer holds the poll, nor sets when the timer runs.
        arm()
      }
    }
    reading.then(
      answer => settle(answer?.utxoReadFailed === true),
      () => settle(true)
    )
    // What the caller waits for: the read's outcome, or the poll letting go
    // of it first, after which that outcome reaches no one.
    const promise = new Promise<QbitBalanceSummary | undefined>((resolve, reject) => {
      release = reject
      reading.then(resolve, reject)
    })
    held.promise = promise
    return promise
  }

  const read = (readOptions?: FetchBalanceOptions): Promise<QbitBalanceSummary | undefined> =>
    hold(() => fetchBalance(readOptions))

  const poll = (): void => {
    read().catch(() => {
      // Recorded in the balance status; the next tick tries again.
    })
  }

  function tick(): void {
    timer = undefined
    if (stopped || isHidden()) return
    const now = Date.now()
    // When the latest of the reads given up on here got stuck.
    let stuckSince: number | undefined
    for (const held of holding) {
      const stuckAt = held.startedAt + POLL_READ_GIVE_UP
      if (now >= stuckAt) {
        // Stuck: it no longer holds the poll, and counts as a failed read,
        // one per read, ending when it got stuck however late this tick
        // notices (the page may have been hidden since). Its caller stops
        // waiting too: a press of the refresh control that joined it is over.
        holding.delete(held)
        held.release(
          new BalanceReadGaveUpError(`balance read gave up after ${POLL_READ_GIVE_UP / 1000} s`)
        )
        if (held.reading) options.onGiveUp?.(held.reading)
        failures += 1
        stuckSince = Math.max(stuckSince ?? stuckAt, stuckAt)
      }
    }
    if (holding.size > 0) {
      // Not beside a read: remembered for when the reads settle. The timer
      // runs sooner if the oldest of them is to be given up on first.
      tickMissed = true
      scheduleAt(now + pollInterval(failures))
      return
    }
    if (stuckSince !== undefined && stuckSince + pollInterval(failures) > now) {
      // As after a failed read, the back-off counts from when it ended.
      scheduleAt(stuckSince + pollInterval(failures))
      return
    }
    poll()
  }

  const onVisibilityChange = (): void => {
    if (stopped) return
    if (isHidden()) {
      clearTimer()
      return
    }
    // Due: the tick runs now, reading or, beside a read still in flight,
    // waiting for it to settle. So it does, whatever the back-off, while the
    // card counts a failure. Otherwise the cadence carries on where it was.
    // A failure counted: read now, or as soon as the gap after the
    // previous read allows.
    const readAgain = (): void => {
      const at = lastStartAt + POLL_SHOWN_AGAIN_GAP
      if (Date.now() >= at) poll()
      else scheduleAt(Math.min(dueAt, at))
    }
    if (Date.now() >= dueAt) {
      tick()
      // A read it gave up on as it was shown counts as failed: read now.
      if (!stopped && holding.size === 0 && options.readsWhenShownAgain?.() === true) readAgain()
    } else if (holding.size === 0 && options.readsWhenShownAgain?.() === true) {
      readAgain()
    } else {
      scheduleAt(dueAt)
    }
  }

  visibility?.addEventListener('visibilitychange', onVisibilityChange)
  scheduleAt(dueAt)

  return {
    read,
    adopt: (reading, startedAt) => hold(() => reading, startedAt),
    join(reading) {
      for (const held of holding) if (held.reading === reading) return held.promise
      return undefined
    },
    nextReadAt(): number | undefined {
      if (stopped || isHidden() || holding.size > 0) return undefined
      return dueAt
    },
    stop(): void {
      stopped = true
      clearTimer()
      visibility?.removeEventListener('visibilitychange', onVisibilityChange)
      // Nothing here waits for the reads in flight any more, nor their callers.
      for (const held of holding) {
        held.release(new BalanceReadGaveUpError('balance read gave up: the card stopped polling'))
      }
      holding.clear()
    },
  }
}

// A background poll over a complete answer shows nothing for this long, so
// the card does not flicker every 10 s; past it the shown value dims and the
// card says it is updating.
export const BALANCE_QUIET_POLL_MS = 1_000
// A refresh the user asked for, or of a value read before (the background's
// kept answer, or this page's from before a lock), dims only once it has run
// this long: a fast answer never flashes the dimming. The refresh control
// turns from the start. 400 ms is above a warm read on a healthy explorer's
// usual 0.1-0.4 s and well under a second, so a slow one still says so soon.
// Only over a value the card showed undimmed until then: one it has shown
// dimmed stays dimmed until a fresh complete answer.
export const BALANCE_QUIET_REFRESH_MS = 400
// A value the card has dimmed stays dimmed at least this long, so an answer
// that lands just past the quiet start does not flash the dimming.
export const BALANCE_DIMMED_AT_LEAST_MS = 400
// A read of the outputs shows how far it has got once it has run this long.
export const BALANCE_PROGRESS_AFTER_MS = 3_000
// A failure shows once this many reads have failed since the trouble began,
// the latest of them begun at least `BALANCE_ESCALATE_SPREAD_MS` after the
// first; or once one has failed and `BALANCE_ESCALATE_AFTER_MS` have passed
// since the first failed read began. Only time the page was shown counts. See
// `balanceCardStatus`.
export const BALANCE_ESCALATE_AFTER_FAILURES = 2
export const BALANCE_ESCALATE_SPREAD_MS = 10_000
export const BALANCE_ESCALATE_AFTER_MS = 30_000
// The background's own deadline for a read: the 30 s rule waits for a read
// begun after the latest failure while it is within it, as it may answer.
export const BALANCE_READ_DEADLINE_MS = 20_000
// A read due this soon counts as under way: the card says it is busy (the
// ring, "Updating…").
export const BALANCE_READ_SOON_MS = 1_000
// After a network switch the card waits at most this long for the selected
// account to be the new network's, then reads the account selected, as when
// the reload of accounts fails. That reload is four calls to the background,
// tens of milliseconds as a rule: 5 s covers a busy background many times
// over, and keeps a reload that never ends from leaving the card loading, its
// refresh control disabled, for longer than the poll's own first interval.
export const BALANCE_ACCOUNT_WAIT_MS = 5_000
// A read due this soon counts as about to begin for the 30 s rule, which
// waits for it rather than put up a failure that read may end at once. It
// covers the read 2 s after a first failure over a shown value
// (`POLL_RETRY_AFTER_FIRST_FAILURE`) and the first two quick reads (1.5 and
// 3 s, `POLL_QUICK_RETRY_DELAYS`). The third quick read, 6 s on, comes after
// three failures, the last of them 4.5 s and more after the first: the
// failure after it is decided by the 10 s spread as it settles, so the 30 s
// rule need not wait for it.
export const BALANCE_READ_ABOUT_TO_BEGIN_MS = 3_000

/** How a shown value's Available and Unavailable stand. */
export type BalanceCardSplit =
  | { kind: 'known'; available: number; unavailable: number }
  /** Unknown for a passing reason (outputs still being read, the send guard busy): loaders stand in. */
  | { kind: 'loading' }
  /** Unknown past the explorer's listing limit, a lasting cause the card states: `--` with its note. */
  | { kind: 'limit' }

/** The value the card shows, and where it comes from. */
export interface BalanceCardShown {
  /** In sats. */
  total: number
  split: BalanceCardSplit
  /** The explorer would not list the account's outputs: the total comes from its statistics. */
  limitExceeded: boolean
  /**
   * `own`: a complete answer this page read, the newest it has; `last`: the
   * last complete answer this page read, under a newer passing answer with
   * the same total (outputs not all read, the send guard busy); `early`: the
   * total of this page's newest read, its outputs not read yet, or an
   * answer's total without its split; `kept`: the last complete answer the
   * background kept, from before this page read its own.
   */
  source: 'own' | 'last' | 'early' | 'kept'
}

/** How far the read in flight has read the account's outputs. */
export interface BalanceReadCount {
  read: number
  total: number
}

/**
 * Why the card shows a value dimmed as being refreshed: it is the
 * background's kept answer (`cached`); the user asked for a read (`user`);
 * the last read brought no complete answer and the wallet reads again by
 * itself (`retry`); or a background poll has run longer than
 * `BALANCE_QUIET_POLL_MS` (`poll`).
 */
export type BalanceCardRefreshReason = 'cached' | 'user' | 'retry' | 'poll'

/**
 * Everything the balance card shows about loading, in one status:
 * - `loading`: nothing known yet (first load); loaders stand in for every number.
 * - `total`: the total is known, the split is loading.
 * - `ready`: a complete answer is shown.
 * - `refreshing`: a shown value is being refreshed, and why.
 * - `failed`: reads keep failing over a shown value. Over a complete value,
 *   one message, the value dimmed; over a total whose outputs could not be
 *   read (its split `loading`), a note that they could not be, and the total
 *   dimmed only if it is not the newest read's own (`totalCurrent`).
 * - `failed-empty`: reads keep failing and nothing is shown: the neutral card and one message.
 * The refresh control reads again in every state.
 * Two lasting facts are not failures: past the explorer's listing limit
 * (`shown.limitExceeded`, the split `limit`), and a hidden balance (`hidden`).
 * `busy` is whether the card is working: the refresh control spins and the
 * card says it is busy.
 */
export type BalanceCardStatus = (
  | { kind: 'loading'; progress?: BalanceReadCount }
  | { kind: 'total'; shown: BalanceCardShown; progress?: BalanceReadCount }
  | { kind: 'ready'; shown: BalanceCardShown }
  | {
      kind: 'refreshing'
      shown: BalanceCardShown
      reason: BalanceCardRefreshReason
      progress?: BalanceReadCount
    }
  | {
      kind: 'failed'
      shown: BalanceCardShown
      /**
       * The total shown is the one the newest settled read told (its
       * statistics answered, and only its outputs failed): not out of date.
       */
      totalCurrent: boolean
    }
  | { kind: 'failed-empty' }
) & { hidden: boolean; busy: boolean }

/**
 * Spans of time the page was hidden, in ms since the epoch: from, and until
 * (absent while it still is). A third number stands for several spans
 * folded into one, from the first's start to the last's end: how long of it
 * the page was hidden in all.
 */
export type BalanceCardHiddenSpans = ReadonlyArray<
  readonly [number, number | undefined] | readonly [number, number, number]
>

/** What `balanceCardStatus` works from: the store's facts for the selected account on the selected network. */
export interface BalanceCardFacts {
  chainType: string
  /** The balance stored for the account (`balanceV2Map`), whatever its network. */
  own: QbitBalanceSummary | undefined
  /** The background's kept answer for the account (`balanceKeptMap`). */
  kept: KeptBalanceEntry | undefined
  /** This page's reads of the account (`balanceReadMap`). */
  record: BalanceReadRecord | undefined
  hidden: boolean
  /** When the page was hidden: that time does not count toward a failure. */
  hiddenSpans?: BalanceCardHiddenSpans
  /**
   * When the card last began to be seen again: the page shown again after
   * being hidden, the card shown (mounted) or the account or network it
   * shows selected, whichever is latest. Nothing escalates on a failure
   * older than this until a read begun since has settled.
   */
  shownAt?: number
  /**
   * The card has shown its value dimmed since this time, and no fresh
   * complete answer has come since (kept by the card as it renders): the
   * value then stays dimmed, with no quiet start, until one does, and at
   * least `BALANCE_DIMMED_AT_LEAST_MS`. With the reason it was last dimmed for.
   */
  dimmed?: { since: number; reason: BalanceCardRefreshReason }
  /**
   * The card has shown the failure of the trouble going on (kept by the
   * page as the card renders, whatever screen or account it showed since):
   * it then stays until the trouble ends.
   */
  failureShown?: boolean
  /** When the card's next read is due, if one is (`BalancePoll.nextReadAt`). */
  nextReadAt?: number
}

/**
 * How long of `[from, to)` the page was hidden. Spans folded into one count
 * in proportion to how much of them the interval covers.
 */
export function hiddenWithin(spans: BalanceCardHiddenSpans, from: number, to: number): number {
  let hidden = 0
  for (const span of spans) {
    const [start, end] = span
    const overlap = Math.min(end ?? to, to) - Math.max(start, from)
    if (overlap <= 0) continue
    const folded = span.length === 3 ? span[2] : undefined
    if (folded === undefined) {
      hidden += overlap
    } else if (end !== undefined && end > start) {
      hidden += (folded * overlap) / (end - start)
    }
  }
  return hidden
}

function shownFrom(
  balance: QbitBalanceSummary,
  source: BalanceCardShown['source']
): BalanceCardShown {
  const limitExceeded = balance.utxoLimitExceeded === true
  let split: BalanceCardSplit
  if (typeof balance.availableBalance === 'number' && balance.utxoReadIncomplete !== true) {
    split = {
      kind: 'known',
      available: balance.availableBalance,
      unavailable: balance.unavailableBalance,
    }
  } else {
    split = limitExceeded ? { kind: 'limit' } : { kind: 'loading' }
  }
  return { total: balance.totalBalance, split, limitExceeded, source }
}

function totalOnly(total: number, source: 'own' | 'early'): BalanceCardShown {
  return { total, split: { kind: 'loading' }, limitExceeded: false, source }
}

/**
 * The card's status at `now` (ms since the epoch), and the next time it
 * changes by the clock alone, if it does: the one place that decides what
 * the card says.
 *
 * What is shown, newest first: a complete answer this page read, unless a
 * newer read has settled with a total that differs from it; else the last
 * complete split the page has (its own last complete answer, or the
 * background's kept one), dimmed, while the newest total it knows (the
 * newest read's early total, or the total of the newest settled read)
 * equals that split's total or none is known; else that newest total, its
 * split loading (a total that differs would not add up with the old split);
 * else nothing. A complete answer shown is never replaced by a total in
 * flight, so a poll changes nothing visible until it settles.
 *
 * A failure is shown (escalated) while the failed reads since the trouble
 * began (`BalanceReadRecord.failed`: rejected, given up on, or
 * `utxoReadFailed`) are at least `BALANCE_ESCALATE_AFTER_FAILURES` and the
 * latest of them began at least `BALANCE_ESCALATE_SPREAD_MS` after the
 * first, which is decided as a read settles, never by a timer; or while one
 * has failed and `BALANCE_ESCALATE_AFTER_MS` have passed since the first
 * failed read began, unless a read begun after the latest failure is in
 * flight within the background's deadline (`BALANCE_READ_DEADLINE_MS`):
 * then it waits for that read. Only time the page was shown counts, in
 * both. On a failure older than when the card was last seen again (the page
 * shown again, the card shown, the account or network selected), nothing
 * escalates until a read begun since has settled. The trouble, and the
 * failed state with it, ends only when a read begun after the newest failed
 * read settles without failing; until then a failed state stays as it is,
 * whatever a read in flight reports.
 *
 * Dimming: a value shown as out of date (the background's kept answer, an
 * answer from before a lock, the last split under a passing answer, or a
 * read that brought no complete answer) is dimmed; a read over a value
 * shown undimmed until then dims it only after a quiet start. Once the card
 * has dimmed a value (`facts.dimmed`), it stays dimmed until a fresh
 * complete answer, and for at least `BALANCE_DIMMED_AT_LEAST_MS`.
 */
export function balanceCardStatus(
  facts: BalanceCardFacts,
  now: number
): { status: BalanceCardStatus; nextChangeAt?: number } {
  const { chainType, record, hidden } = facts
  const own = facts.own?.chainType === chainType ? facts.own : undefined
  const kept = facts.kept?.balance.chainType === chainType ? facts.kept : undefined
  const outcome = record?.outcome?.chainType === chainType ? record.outcome : undefined
  const reading = record?.reading?.chainType === chainType ? record.reading : undefined
  const early = record?.early?.chainType === chainType ? record.early : undefined
  const split = record?.split?.chainType === chainType ? record.split : undefined
  const settledTotal =
    record?.settledTotal?.chainType === chainType ? record.settledTotal : undefined
  const failedReads = record?.failed?.chainType === chainType ? record.failed.reads : []
  let nextChangeAt: number | undefined
  const changesAt = (at: number): void => {
    nextChangeAt = nextChangeAt === undefined ? at : Math.min(nextChangeAt, at)
  }

  // A read under way: in flight, or due within `BALANCE_READ_SOON_MS` (late
  // by as much at most).
  const { nextReadAt } = facts
  const dueSoon =
    reading === undefined &&
    nextReadAt !== undefined &&
    nextReadAt >= now - BALANCE_READ_SOON_MS &&
    nextReadAt <= now + BALANCE_READ_SOON_MS
  if (
    reading === undefined &&
    nextReadAt !== undefined &&
    nextReadAt - BALANCE_READ_SOON_MS > now
  ) {
    changesAt(nextReadAt - BALANCE_READ_SOON_MS)
  }
  const reads = reading !== undefined || dueSoon
  const aboutToBegin =
    reading === undefined &&
    nextReadAt !== undefined &&
    nextReadAt >= now - BALANCE_READ_SOON_MS &&
    nextReadAt <= now + BALANCE_READ_ABOUT_TO_BEGIN_MS

  let escalated = false
  const starts = failedReads
    .map(read => read.startedAt)
    .filter((at): at is number => typeof at === 'number')
  if (starts.length > 0 && facts.failureShown === true) {
    // On screen already: it stays until the trouble ends, whatever is read
    // meanwhile, and wherever the user went and came back from.
    escalated = true
  } else if (starts.length > 0) {
    const first = Math.min(...starts)
    const latest = Math.max(...starts)
    const newestFailed = Math.max(...failedReads.map(read => read.requestId))
    const spans = facts.hiddenSpans ?? []
    const lastSpan = spans[spans.length - 1]
    const hiddenNow = lastSpan !== undefined && lastSpan[1] === undefined
    const seenSince = facts.shownAt
    const waitingForSeenRead =
      seenSince !== undefined && seenSince > first && (outcome?.startedAt ?? -Infinity) < seenSince
    if (!waitingForSeenRead) {
      const spread = latest - first - hiddenWithin(spans, first, latest)
      if (
        failedReads.length >= BALANCE_ESCALATE_AFTER_FAILURES &&
        spread >= BALANCE_ESCALATE_SPREAD_MS
      ) {
        escalated = true
      } else if (!hiddenNow) {
        const elapsed = now - first - hiddenWithin(spans, first, now)
        // A read that may end the trouble, begun since the latest failure and
        // within the background's deadline, or about to begin: the rule
        // waits for it, and decides as it settles.
        const deadline =
          reading !== undefined && reading.requestId > newestFailed
            ? reading.startedAt + BALANCE_READ_DEADLINE_MS
            : undefined
        if (elapsed < BALANCE_ESCALATE_AFTER_MS) {
          changesAt(now + BALANCE_ESCALATE_AFTER_MS - elapsed)
        } else if (deadline !== undefined && now < deadline) {
          changesAt(deadline)
        } else if (aboutToBegin && nextReadAt !== undefined) {
          changesAt(Math.max(now + 1, nextReadAt + BALANCE_READ_SOON_MS))
        } else {
          escalated = true
        }
      }
    }
  }

  // An answer of this page's from before a lock: shown as read before.
  const beforeLock =
    record?.staleUpTo !== undefined &&
    !(split?.source === 'own' && split.requestId > record.staleUpTo)

  // The early total of the read in flight; not while a failure is shown,
  // which stays as it is until a read settles.
  const inFlightEarly =
    !escalated && early !== undefined && early.requestId > (outcome?.requestId ?? -Infinity)
      ? early.totalBalance
      : undefined
  // The total of a read newer than the complete answer stored.
  const ownCompleteId = split?.source === 'own' ? split.requestId : undefined
  const newerTotal =
    settledTotal !== undefined &&
    (ownCompleteId === undefined || settledTotal.requestId > ownCompleteId)
      ? settledTotal.totalBalance
      : undefined
  let shown: BalanceCardShown | undefined
  if (
    own !== undefined &&
    isCompleteBalance(own) &&
    (newerTotal === undefined || newerTotal === own.totalBalance)
  ) {
    shown = shownFrom(own, 'own')
  } else {
    const newestTotal = inFlightEarly ?? newerTotal ?? own?.totalBalance
    const last =
      split?.source === 'own'
        ? shownFrom(split.balance, 'last')
        : kept !== undefined
          ? shownFrom(kept.balance, 'kept')
          : split !== undefined
            ? shownFrom(split.balance, 'kept')
            : undefined
    if (last !== undefined && (newestTotal === undefined || newestTotal === last.total)) {
      shown = last
    } else if (newestTotal !== undefined) {
      shown = totalOnly(newestTotal, inFlightEarly !== undefined ? 'early' : 'own')
    }
  }

  if (escalated) {
    const busy = reads
    const totalCurrent =
      shown !== undefined &&
      settledTotal !== undefined &&
      settledTotal.requestId === outcome?.requestId &&
      settledTotal.totalBalance === shown.total
    return {
      status: shown
        ? { kind: 'failed', shown, totalCurrent, hidden, busy }
        : { kind: 'failed-empty', hidden, busy },
      nextChangeAt,
    }
  }

  let progress: BalanceReadCount | undefined
  if (
    reading !== undefined &&
    early?.requestId === reading.requestId &&
    early.read !== undefined &&
    early.total !== undefined
  ) {
    const at = reading.startedAt + BALANCE_PROGRESS_AFTER_MS
    if (now >= at) progress = { read: early.read, total: early.total }
    else changesAt(at)
  }
  const withProgress = progress ? { progress } : {}
  // Busy, and the ring turning, only while a read is under way.
  const busy = { hidden, busy: reads }

  if (shown === undefined)
    return { status: { kind: 'loading', ...withProgress, ...busy }, nextChangeAt }
  if (shown.split.kind === 'loading') {
    // A total read before a lock, and none since: shown as read before.
    const totalFrom =
      inFlightEarly !== undefined
        ? early?.requestId
        : newerTotal !== undefined
          ? settledTotal?.requestId
          : undefined
    const staleUpTo = record?.staleUpTo
    if (
      beforeLock &&
      staleUpTo !== undefined &&
      (totalFrom === undefined || totalFrom <= staleUpTo)
    ) {
      return {
        status: { kind: 'refreshing', shown, reason: 'cached', ...withProgress, ...busy },
        nextChangeAt,
      }
    }
    return { status: { kind: 'total', shown, ...withProgress, ...busy }, nextChangeAt }
  }
  // A read that may still answer quickly shows only the turning control at
  // first (`busy`), dimming nothing: a fast answer never flashes. Not over a
  // value the card has dimmed already: that stays dimmed.
  const dimmed = facts.dimmed
  const quiet = (ms: number): boolean => {
    if (reading === undefined || dimmed !== undefined) return false
    const at = reading.startedAt + ms
    if (now >= at) return false
    changesAt(at)
    return true
  }
  const cached = shown.source === 'kept' || beforeLock
  const retrying =
    !cached && (shown.source === 'last' || (outcome !== undefined && outcome.kind !== 'complete'))
  let reason: BalanceCardRefreshReason | undefined
  let turning = false
  if (cached) {
    // Only the background's kept answer, at open, gets a quiet start: a value
    // from before a lock is dimmed at once.
    if (!beforeLock && quiet(BALANCE_QUIET_REFRESH_MS)) turning = true
    else reason = 'cached'
  } else if (reading !== undefined) {
    if (reading.byUser) {
      if (quiet(BALANCE_QUIET_REFRESH_MS)) turning = true
      else reason = 'user'
    } else if (retrying) reason = 'retry'
    else if (!quiet(BALANCE_QUIET_POLL_MS)) reason = 'poll'
  } else if (retrying) {
    // The last read brought no complete answer; the poll reads again soon.
    reason = 'retry'
  }
  if (reason === undefined && dimmed !== undefined) {
    // Fresh, but dimmed only a moment ago: it stays dimmed a little longer,
    // with nothing turning, as nothing is read.
    const until = dimmed.since + BALANCE_DIMMED_AT_LEAST_MS
    if (now < until) {
      changesAt(until)
      return {
        status: { kind: 'refreshing', shown, reason: dimmed.reason, hidden, busy: turning },
        nextChangeAt,
      }
    }
  }
  if (reason === undefined) {
    return { status: { kind: 'ready', shown, hidden, busy: turning }, nextChangeAt }
  }
  return {
    status: { kind: 'refreshing', shown, reason, ...withProgress, ...busy },
    nextChangeAt,
  }
}

/**
 * The one transient message the card shows, by precedence: a failure, then
 * how far a long read has got, then that it is updating; at most one.
 * `load-error` is the box on the neutral card with nothing shown,
 * `refresh-error` the box under a complete value, dimmed, and
 * `outputs-unread` the note under a total whose outputs could not be read
 * (where the limit note sits, no box), with `--` for Available and
 * Unavailable and a second note under them: each only once reads keep
 * failing (`failed`, `failed-empty`). `progress` and `updating` are the
 * short line beside the refresh control. The explorer's listing limit is no
 * message: its notes belong to the value shown, and stay as they are
 * whatever the status.
 */
export type BalanceCardMessage =
  | 'load-error'
  | 'refresh-error'
  | 'outputs-unread'
  | 'progress'
  | 'updating'

export function balanceCardMessage(status: BalanceCardStatus): BalanceCardMessage | undefined {
  switch (status.kind) {
    case 'failed-empty':
      return 'load-error'
    case 'failed':
      return status.shown.split.kind === 'loading' ? 'outputs-unread' : 'refresh-error'
    case 'refreshing':
      // The word follows the reading; the value stays dimmed between reads.
      return status.progress ? 'progress' : status.busy ? 'updating' : undefined
    case 'loading':
    case 'total':
      return status.progress ? 'progress' : undefined
    default:
      return undefined
  }
}

/**
 * Whether this page shows a complete answer of its own for `address` on
 * `chainType`: the one stored, or the last one under a passing answer
 * (`BalanceReadRecord.split`). Until it does, the poll reads again quickly.
 */
function showsCompleteAnswerOfItsOwn(
  accounts: AppState['accounts'],
  address: string,
  chainType: string
): boolean {
  if (hasCompleteBalanceRead(accounts, address, chainType)) return true
  const split = accounts.balanceReadMap[address]?.split
  return split?.source === 'own' && split.chainType === chainType
}

/** A span the page was hidden: see `BalanceCardHiddenSpans`. */
type HiddenSpan = [number, number | undefined] | [number, number, number]

/** The page's visibility history, for `balanceCardStatus`: spans hidden and when last shown again. */
export interface VisibilityHistory {
  spans: HiddenSpan[]
  shownAt?: number
}

// Spans of hidden time kept one by one; older ones are folded into one sum
// (`BalanceCardHiddenSpans`), so no hidden time is ever lost.
const MAX_HIDDEN_SPANS = 32

function spanHidden(span: HiddenSpan): number {
  return span.length === 3 ? span[2] : (span[1] ?? span[0]) - span[0]
}

/**
 * Drops the spans that ended before `from`, which no failure still counted
 * can reach, and folds the oldest of the rest into one while there are more
 * than `MAX_HIDDEN_SPANS`. Exported for its tests.
 */
export function pruneHiddenSpans(history: VisibilityHistory, from: number): void {
  const spans = history.spans.filter(span => span[1] === undefined || span[1] >= from)
  while (spans.length > MAX_HIDDEN_SPANS) {
    const [a, b] = spans
    if (a === undefined || b === undefined || b[1] === undefined) break
    spans.splice(0, 2, [a[0], b[1], spanHidden(a) + spanHidden(b)])
  }
  history.spans = spans
}

/**
 * The address `account` has on the Qbit network of `chainType`, where the
 * account says (`Account.p2mr.addresses`), as the background reads it.
 */
function qbitAddressOn(account: Account | undefined, chainType: string): string | undefined {
  const addresses = account?.p2mr?.addresses
  if (!addresses) return undefined
  if (chainType === ChainType.QBIT_MAINNET) return addresses.mainnet
  if (chainType === ChainType.QBIT_REGTEST) return addresses.regtest
  if (chainType === ChainType.QBIT_TESTNET4) return addresses.testnet4
  return undefined
}

export function useBalanceCardLogic() {
  const { t } = useI18n()

  const store = useStore<AppState>()
  const wallet = useWallet()
  const chain = useChain()
  const chainType = chain.enum
  const dispatch = useDispatch()
  const address = useSelector((state: AppState) => state.accounts.current.address)
  const own = useSelector((state: AppState) => state.accounts.balanceV2Map[address])
  const kept = useSelector((state: AppState) => state.accounts.balanceKeptMap[address])
  const record = useSelector((state: AppState) => state.accounts.balanceReadMap[address])
  // Whether the selected account is known to be this network's (see the
  // poll below): its address there, as the account says, and the page's
  // last load of its accounts.
  const addressOnNetwork = useSelector((state: AppState) =>
    qbitAddressOn(state.accounts.current, chainType)
  )
  const accountsLoaded = useSelector((state: AppState) => state.accounts.accountsLoaded)

  const startRead = useStartBalanceReadCallback()

  const qbitUnit = useQbitUnit()

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // A balance read for this account on this network, not the stand-in zeros
  // from before the first one succeeded (they show as `--`, not 0).
  const isCurrentChainBalance = useSelector((state: AppState) =>
    hasAccountBalanceRead(state.accounts, state.accounts.current.address, chainType)
  )

  // Balance visibility
  const isBalanceHidden = useSelector((state: AppState) => state.ui.isBalanceHidden)
  const handleHiddenToggle = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    dispatch(uiActions['setBalanceHidden'](!isBalanceHidden))
  }

  // The status at this render, and a render again when the clock alone
  // changes it (a quiet poll turning into an update, a long read showing its
  // progress, a failure escalating), or when the page is hidden or shown.
  const [clock, setClock] = useState(0)
  const visibilityRef = useRef<VisibilityHistory>({ spans: [] })
  useEffect(() => {
    const visibility = visibilityDocument()
    if (!visibility) return undefined
    const history = visibilityRef.current
    const note = (): void => {
      const now = Date.now()
      const last = history.spans[history.spans.length - 1]
      if (visibility.hidden) {
        if (last === undefined || last[1] !== undefined) history.spans.push([now, undefined])
      } else if (last !== undefined && last[1] === undefined) {
        last[1] = now
        history.shownAt = now
      }
    }
    note()
    const onVisibilityChange = (): void => {
      note()
      setClock(value => value + 1)
    }
    visibility.addEventListener('visibilitychange', onVisibilityChange)
    return (): void => visibility.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])
  // When the card began showing this account on this network (the start of
  // the read it began with), and since when it has shown the value dimmed:
  // each kept for one account on one network.
  const seenRef = useRef<{ address: string; chainType: string; at: number } | undefined>(undefined)
  const dimmedRef = useRef<
    | { address: string; chainType: string; since: number; reason: BalanceCardRefreshReason }
    | undefined
  >(undefined)
  const isThisAccount = (entry?: { address: string; chainType: string }): boolean =>
    entry?.address === address && entry.chainType === chainType
  const now = Date.now()
  // Until the card has begun with an account (its first render of it), it
  // is being seen as of now.
  const seen = isThisAccount(seenRef.current) ? (seenRef.current?.at ?? now) : now
  const shownAgainAt = visibilityRef.current.shownAt
  const seenAt = shownAgainAt === undefined ? seen : Math.max(seen, shownAgainAt)
  const dimmed = isThisAccount(dimmedRef.current) ? dimmedRef.current : undefined
  // The trouble going on, by its first failed read, and whether the card
  // has shown its failure (on any screen or account since).
  const firstFailed =
    record?.failed?.chainType === chainType ? record.failed.reads[0]?.requestId : undefined
  const failureShown =
    address !== '' &&
    firstFailed !== undefined &&
    balanceFailureShown(store, address, chainType, firstFailed)
  // The card's poll (below), and when its next read is due.
  const pollRef = useRef<BalancePoll | null>(null)
  const nextReadAt = pollRef.current?.nextReadAt()
  const { status, nextChangeAt } = balanceCardStatus(
    {
      chainType,
      own,
      kept,
      record,
      hidden: isBalanceHidden,
      hiddenSpans: visibilityRef.current.spans,
      shownAt: seenAt,
      ...(dimmed !== undefined ? { dimmed: { since: dimmed.since, reason: dimmed.reason } } : {}),
      ...(failureShown ? { failureShown } : {}),
      ...(nextReadAt !== undefined ? { nextReadAt } : {}),
    },
    now
  )
  // Armed again after each run (`clock`), so a timer that fires early, or a
  // clock that steps back, waits again for the time still to come.
  useEffect(() => {
    if (nextChangeAt === undefined) return undefined
    const timer = setTimeout(
      () => setClock(value => value + 1),
      Math.max(0, nextChangeAt - Date.now())
    )
    return (): void => clearTimeout(timer)
  }, [nextChangeAt, clock])

  const shown =
    status.kind === 'loading' || status.kind === 'failed-empty' ? undefined : status.shown
  const message = balanceCardMessage(status)
  // Counts are grouped as balances are, the same way in every language.
  const countFormat = useMemo(() => qbitSendPlanCountFormat('en'), [])
  const progress =
    status.kind === 'loading' || status.kind === 'total' || status.kind === 'refreshing'
      ? status.progress
      : undefined
  // The full sentence, for the refresh control's name and title, and the
  // short form shown beside the control, where the row has room for it.
  const statusText =
    message === 'progress' && progress
      ? t('balance_reading_outputs', [countFormat(progress.read), countFormat(progress.total)])
      : message === 'updating'
        ? t('balance_updating')
        : undefined
  const statusShortText =
    message === 'progress' && progress
      ? `${countFormat(progress.read)} / ${countFormat(progress.total)}`
      : statusText
  // What a screen reader is told, politely, when it changes: that the card
  // is updating, as a read begins and not again while that read goes on
  // (through counts and reasons); never for a background poll alone, and
  // nothing while no read is under way.
  const liveRef = useRef(false)
  const live =
    status.busy &&
    ((status.kind === 'refreshing' && status.reason !== 'poll') ||
      (status.kind === 'total' && progress !== undefined) ||
      (liveRef.current && (status.kind === 'refreshing' || status.kind === 'total')))
  const liveText = live ? t('balance_updating') : undefined

  // What this render showed, for the next ones: whether the value is dimmed
  // and since when (a fresh complete answer, or no value, ends it), whether
  // the card is telling that it updates, and which hidden spans a failure
  // can still reach (from the oldest failure counted, the read in flight,
  // or a read the poll may still give up on).
  useEffect(() => {
    // A failure the user has seen stays on screen until the trouble ends.
    if (
      (status.kind === 'failed' || status.kind === 'failed-empty') &&
      firstFailed !== undefined &&
      visibilityDocument()?.hidden !== true
    ) {
      noteBalanceFailureShown(store, address, chainType, firstFailed)
    }
    if (status.kind === 'refreshing' || status.kind === 'failed') {
      const reason = status.kind === 'refreshing' ? status.reason : 'retry'
      const entry = dimmedRef.current
      if (entry !== undefined && entry.address === address && entry.chainType === chainType) {
        entry.reason = reason
      } else {
        dimmedRef.current = { address, chainType, since: now, reason }
      }
    } else if (status.kind !== 'total') {
      dimmedRef.current = undefined
    }
    liveRef.current = live
    const reach = [now - POLL_READ_GIVE_UP]
    if (record?.failed?.chainType === chainType) {
      for (const read of record.failed.reads) {
        if (typeof read.startedAt === 'number') reach.push(read.startedAt)
      }
    }
    if (record?.reading !== undefined) reach.push(record.reading.startedAt)
    pruneHiddenSpans(visibilityRef.current, Math.min(...reach))
  })
  // The box, for a failure over a complete value or over nothing; the two
  // notes, on the card and under the split, for a total whose outputs could
  // not be read.
  const balanceErrorText =
    message === 'load-error'
      ? t('balance_load_error')
      : message === 'refresh-error'
        ? t('balance_refresh_error')
        : undefined
  const outputsUnread = message === 'outputs-unread'
  const outputsUnreadText = outputsUnread ? t('balance_outputs_incomplete') : undefined
  const outputsUnreadDetailText = outputsUnread ? t('balance_outputs_incomplete_detail') : undefined
  // The total is dimmed while it is out of date: being refreshed, or under a
  // failure, unless it is the newest read's own and only its outputs failed.
  const totalDimmed =
    status.kind === 'refreshing' ||
    (status.kind === 'failed' && !(outputsUnread && status.totalCurrent))
  const splitDimmed = status.kind === 'refreshing' || (status.kind === 'failed' && !outputsUnread)

  // Detail expand state
  const isDetailExpanded = useBalanceCardDetailExpanded()
  const toggleBalanceCardDetailExpanded = useToggleBalanceCardDetailExpanded()
  const handleExpandToggle = () => {
    // There is no breakdown to show while nothing could be loaded.
    if (status.kind === 'failed-empty') return
    toggleBalanceCardDetailExpanded()
  }

  const balanceValue = shown ? numUtils.satoshisToAmount(shown.total) : '--'

  const unavailableTipText = useMemo(() => t('unavailable_tooltip'), [t])

  // The explorer could not list this account's outputs; the total comes from
  // the address statistics and is labelled so it is not read as spendable.
  // Without the output list Available is unknown, and so is how much of the
  // total is unavailable: both show `--` with a note naming the limit, the
  // one lasting cause the card states.
  const utxoLimitExceeded = shown?.limitExceeded === true
  const utxoLimitExceededText = useMemo(() => t('utxo_limit_exceeded_balance'), [t])
  const balanceSplitUnknown = shown?.split.kind === 'limit'
  const balanceSplitUnknownText = useMemo(() => t('utxo_limit_exceeded_balance_detail'), [t])

  const totalBalance = shown?.total ?? 0
  const availableBalance = shown?.split.kind === 'known' ? shown.split.available : null
  const unavailableBalance = shown?.split.kind === 'known' ? shown.split.unavailable : null

  const totalAmount = numUtils.satoshisToAmount(totalBalance)
  const availableAmount =
    availableBalance === null ? '--' : numUtils.satoshisToAmount(availableBalance)
  const unavailableAmount =
    unavailableBalance === null ? '--' : numUtils.satoshisToAmount(unavailableBalance)

  const totalAmountMainPart = totalAmount.slice(0, -8)
  const totalAmountSubPart = totalAmount.slice(-8)

  // The poll for the selected account on the selected network. Another
  // account or network starts a cadence of its own: no read in flight, back
  // off or pending refresh carries over, and no tick of the old one runs.
  //
  // It begins with one read, the page's only one at open: this page's read
  // of the account in flight, if any (the account updater's, for an account
  // newly selected or the wallet just unlocked), which becomes the card's
  // own; else none if this page began, less than `BALANCE_JUST_READ_MS` ago,
  // the very read whose complete answer is stored (the updater's at an
  // unlock in the page, answered before this screen mounted): that read is
  // the first, and the next comes an interval after it began; else one at
  // once if this page has read the account before, as the balance shown was
  // read before whatever moved funds since, possibly minutes earlier on
  // another screen (a send plan holding, combining or spending the account's
  // outputs, a payment going out), or that read failed; else none: the
  // account updater's read, about to begin, comes to this poll
  // (`registerBalanceCard`).
  //
  // On a network switch the network changes first and the selected account
  // after it: while the account is still the previous network's, the card
  // starts no poll, registers no reader and asks for no kept answer, so
  // nothing reads the previous network's address on the new one. The wait
  // ends once the account is known to be the new network's: another
  // address selected, the account's own address on the new network being
  // the one selected (an address the same on both), or the page's load of
  // its accounts for the new network ended, succeeded or not (if it
  // failed, the card reads the account selected rather than wait for ever).
  // A card shown afresh after the switch (Settings, Switch network) waits
  // alike: the page's last load of its accounts was for another network.
  // The account and network the card last polled, and the page's count of
  // account loads when it began to.
  const polledRef = useRef<{ address: string; chainType: string; loads: number } | undefined>(
    undefined
  )
  const polled = polledRef.current
  const sawTheSwitch =
    polled !== undefined &&
    polled.address === address &&
    polled.chainType !== chainType &&
    !(accountsLoaded?.chainType === chainType && accountsLoaded.count > polled.loads)
  const loadedForAnotherNetwork =
    accountsLoaded !== undefined && accountsLoaded.chainType !== chainType
  const mayWait =
    address !== '' && addressOnNetwork !== address && (sawTheSwitch || loadedForAnotherNetwork)
  // The wait lasts `BALANCE_ACCOUNT_WAIT_MS` at most, from when it began for
  // this account and network: then the card reads the account selected, as
  // when the reload of accounts fails.
  const waitRef = useRef<{ key: string; since: number } | undefined>(undefined)
  const waitKey = `${chainType}:${address}`
  if (!mayWait) waitRef.current = undefined
  else if (waitRef.current?.key !== waitKey) waitRef.current = { key: waitKey, since: now }
  const waitEndsAt = mayWait ? (waitRef.current?.since ?? now) + BALANCE_ACCOUNT_WAIT_MS : undefined
  const waitingForAccount = waitEndsAt !== undefined && now < waitEndsAt
  // Armed again after each run (`clock`), as the status timer is, so a timer
  // that fires early, or a clock that steps back, still ends the wait.
  useEffect(() => {
    if (waitEndsAt === undefined || !waitingForAccount) return undefined
    const timer = setTimeout(
      () => setClock(value => value + 1),
      Math.max(0, waitEndsAt - Date.now())
    )
    return (): void => clearTimeout(timer)
  }, [waitEndsAt, waitingForAccount, clock])
  // A refresh asked for from elsewhere is refused meanwhile
  // (`requestBalanceRead`), and the account updater reads nothing.
  useEffect(() => {
    if (!address || !waitingForAccount) return undefined
    return setBalanceCardWaiting(store, address)
  }, [store, address, waitingForAccount])
  useEffect(() => {
    if (waitingForAccount) return undefined
    const { accounts } = store.getState()
    polledRef.current = { address, chainType, loads: accounts.accountsLoaded?.count ?? 0 }
    // A read in flight of this address on this network: one begun on
    // another network is no read of this account.
    const found = address ? balanceReadInFlight(store, address) : undefined
    const inFlight = found?.chainType === chainType ? found : undefined
    const last = address ? lastBalanceReadBegun(store, address) : undefined
    const justRead =
      !inFlight &&
      last !== undefined &&
      last.chainType === chainType &&
      Date.now() - last.startedAt < BALANCE_JUST_READ_MS &&
      accounts.balanceStatusMap[address]?.balanceRequestId === last.requestId &&
      hasCompleteBalanceRead(accounts, address, chainType)
    const balancePoll = startBalancePoll(startRead, {
      showsNoCompleteAnswer: () =>
        !showsCompleteAnswerOfItsOwn(store.getState().accounts, address, chainType),
      onGiveUp: reading => {
        // A read the card gave up on counts as a failed read, and is no
        // longer this page's read in flight.
        const given = address ? forgetBalanceRead(store, address, reading) : undefined
        if (given) {
          dispatch(
            balanceReadGivenUp({
              address,
              requestId: given.requestId,
              chainType: given.chainType,
              startedAt: given.startedAt,
            })
          )
        }
      },
      onScheduleChange: () => setClock(value => value + 1),
      readsWhenShownAgain: () => {
        const failed = store.getState().accounts.balanceReadMap[address]?.failed
        return failed?.chainType === chainType && failed.reads.length > 0
      },
      ...(justRead ? { lastReadStartedAt: last.startedAt } : {}),
    })
    pollRef.current = balancePoll
    const unregister = address
      ? registerBalanceCard(store, address, { read: options => balancePoll.read(options) })
      : undefined
    const ignore = (): void => {
      // Recorded in the store; the status says what the card shows.
    }
    // When the card began to be seen for this account: the start of the
    // read it begins with (`BalanceCardFacts.shownAt`).
    let seenAt = Date.now()
    if (inFlight) {
      seenAt = Math.min(seenAt, inFlight.startedAt)
      balancePoll.adopt(inFlight.reading, inFlight.startedAt).catch(ignore)
    } else if (justRead) {
      // The page has just read it: that read is the card's first.
      seenAt = Math.min(seenAt, last.startedAt)
    } else if (
      address &&
      (accounts.balanceStatusMap[address] !== undefined ||
        accounts.balanceV2Map[address] !== undefined)
    ) {
      balancePoll.read().catch(ignore)
    }
    seenRef.current = { address, chainType, at: seenAt }
    return (): void => {
      unregister?.()
      balancePoll.stop()
      pollRef.current = null
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [startRead, chainType, store, address, dispatch, waitingForAccount])

  // The background's last complete answer for the account, kept from before
  // this page opened, shown dimmed while this page has none of its own for
  // the network (the reducer drops it once one arrives). Not while the
  // account is still the previous network's (see above).
  useEffect(() => {
    if (!address || waitingForAccount) return undefined
    if (typeof wallet.getKeptAddressBalance !== 'function') return undefined
    if (hasAccountBalanceRead(store.getState().accounts, address, chainType)) return undefined
    let live = true
    wallet.getKeptAddressBalance(address).then(
      answer => {
        if (!live || !answer) return
        dispatch(setBalanceKept({ address, balance: answer.balance, readAt: answer.readAt }))
      },
      () => {
        // Nothing kept to show: the card loads as without it.
      }
    )
    return (): void => {
      live = false
    }
  }, [wallet, store, dispatch, address, chainType, waitingForAccount])

  /**
   * A read the user asked for: the read of the account in flight, if any,
   * which then shows as theirs, waited for as the card's poll waits for it
   * (so it ends when the poll gives up on it); else one the card's poll
   * begins now. Never a second read beside one in flight.
   */
  const readForUser = useCallback((): Promise<unknown> | undefined => {
    const balancePoll = pollRef.current
    if (!balancePoll || !address) return undefined
    const inFlight = balanceReadInFlight(store, address)
    if (inFlight && inFlight.chainType === chainType) {
      dispatch(balanceReadJoinedByUser({ address, requestId: inFlight.requestId }))
      return balancePoll.join(inFlight.reading) ?? inFlight.reading
    }
    return balancePoll.read({ byUser: true })
  }, [store, dispatch, address, chainType])

  // A press of the refresh control reads once the presses stop for a
  // second; under a failure, at once. Either way it joins the read in flight,
  // if any (`readForUser`).
  const failing = status.kind === 'failed' || status.kind === 'failed-empty'
  const refreshBalance = useCallback(
    (e?: React.MouseEvent) => {
      if (e) {
        e.stopPropagation()
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      const read = (): void => {
        readForUser()?.catch(() => {
          // Recorded in the store; the status says what the card shows.
        })
      }
      if (failing) {
        read()
        return
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        read()
      }, DEBOUNCE_DELAY)
    },
    [readForUser, failing]
  )

  return {
    // state
    status,
    statusText,
    statusShortText,
    liveText,
    balanceErrorText,
    outputsUnread,
    outputsUnreadText,
    outputsUnreadDetailText,
    totalDimmed,
    splitDimmed,

    totalBalance,
    availableBalance,
    unavailableBalance,

    totalAmount,
    availableAmount,
    unavailableAmount,

    totalAmountMainPart,
    totalAmountSubPart,

    balanceValue,
    unavailableTipText,
    isCurrentChainBalance,
    utxoLimitExceeded,
    utxoLimitExceededText,
    balanceSplitUnknown,
    balanceSplitUnknownText,

    isDetailExpanded,
    handleExpandToggle,

    isBalanceHidden,
    handleHiddenToggle,

    refreshBalance,
    // The refresh control reads nothing while the account is still the
    // previous network's: a press neither turns it nor starts its cooldown.
    canRefresh: address !== '' && !waitingForAccount,
    qbitUnit,

    chain,
    t,
  }
}
