import { numUtils } from '@qbit/base-utils'
import type { QbitBalanceSummary } from '@qbit/wallet-shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { AppState, uiActions } from 'src'
import { useI18n } from '../context'
import { hasAccountBalanceRead } from '../reducers/accounts'
import {
  useAccountBalance,
  useAccountBalanceStatus,
  useBalanceCardDetailExpanded,
  useChain,
  useFetchBalanceCallback,
  useQbitUnit,
  useToggleBalanceCardDetailExpanded,
} from '../hooks'

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
const POLL_READ_GIVE_UP = 60_000

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
  read(): Promise<unknown>
  /** Clears the timer and the listener, and lets go of the reads in flight. */
  stop(): void
}

/** A card read in flight that still holds the poll. */
interface HeldRead {
  readonly startedAt: number
  /** Rejects the promise its caller holds, unless the read has settled it. */
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
 * Only the card's own reads count here. Other reads of the balance (the
 * account updater's, a refresh after a broadcast) neither wait for these nor
 * join them: the request id the reducer orders replies by already keeps an
 * older reply from replacing a newer one.
 *
 * Exported for its tests; the package exports only `useBalanceCardLogic`.
 */
export function startBalancePoll(
  fetchBalance: () => Promise<QbitBalanceSummary | undefined>
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
  // A new account or network counts from when its cadence starts.
  let lastStartAt = Date.now()
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
    if (stopped || isHidden()) return
    let at = dueAt
    for (const held of holding) at = Math.min(at, held.startedAt + POLL_READ_GIVE_UP)
    const delay = Math.min(Math.max(0, at - Date.now()), pollInterval(failures))
    timer = setTimeout(tick, delay)
  }

  const scheduleAt = (at: number): void => {
    dueAt = at
    arm()
  }

  const read = (): Promise<QbitBalanceSummary | undefined> => {
    let release: (error: BalanceReadGaveUpError) => void = () => undefined
    const held: HeldRead = { startedAt: Date.now(), release: error => release(error) }
    holding.add(held)
    lastStartAt = held.startedAt
    // It answers a tick that fell due before it.
    tickMissed = false
    scheduleAt(lastStartAt + pollInterval(failures))
    const reading = fetchBalance()
    const settle = (failed: boolean): void => {
      // Stopped, or given up on: what it does changes nothing here.
      if (stopped || !holding.delete(held)) return
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
    return new Promise((resolve, reject) => {
      release = reject
      reading.then(resolve, reject)
    })
  }

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
        // waiting too: Try again's button is free again.
        holding.delete(held)
        held.release(
          new BalanceReadGaveUpError(`balance read gave up after ${POLL_READ_GIVE_UP / 1000} s`)
        )
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
    // waiting for it to settle. Otherwise the cadence carries on where it was.
    if (Date.now() >= dueAt) {
      tick()
    } else {
      scheduleAt(dueAt)
    }
  }

  visibility?.addEventListener('visibilitychange', onVisibilityChange)
  scheduleAt(dueAt)

  return {
    read,
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

export function useBalanceCardLogic() {
  const { t } = useI18n()

  const accountBalance = useAccountBalance()
  const balanceStatus = useAccountBalanceStatus()
  const chain = useChain()
  const chainType = chain.enum
  const dispatch = useDispatch()

  const fetchBalance = useFetchBalanceCallback()

  const qbitUnit = useQbitUnit()

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // A balance read for this account on this network, not the stand-in zeros
  // from before the first one succeeded (they show as `--`, not 0).
  const isCurrentChainBalance = useSelector((state: AppState) =>
    hasAccountBalanceRead(state.accounts, state.accounts.current.address, chainType)
  )

  // The latest refresh failed. Without a loaded balance the card shows the
  // error in place of a zero total; otherwise the last known balance stays,
  // labelled as possibly out of date.
  const hasLoadedBalance = balanceStatus.loaded && isCurrentChainBalance
  const balanceLoadFailed = balanceStatus.error && !hasLoadedBalance
  const balanceRefreshFailed = balanceStatus.error && hasLoadedBalance
  const balanceErrorText = useMemo(() => {
    if (balanceLoadFailed) return t('balance_load_error')
    if (balanceRefreshFailed) return t('balance_refresh_error')
    return undefined
  }, [balanceLoadFailed, balanceRefreshFailed, t])

  // balanceV2Map is not persisted, so until this account's first balance for the
  // current chain lands, accountBalance is a zero placeholder: show it as loading,
  // never as an empty balance. A failed first load ends loading with the error.
  const balanceLoading = !hasLoadedBalance && !balanceStatus.error

  // Detail expand state
  const isDetailExpanded = useBalanceCardDetailExpanded()
  const toggleBalanceCardDetailExpanded = useToggleBalanceCardDetailExpanded()
  const handleExpandToggle = () => {
    // There is no breakdown to show until a balance loads.
    if (balanceLoading || balanceLoadFailed) return
    toggleBalanceCardDetailExpanded()
  }

  // Balance visibility
  const isBalanceHidden = useSelector((state: AppState) => state.ui.isBalanceHidden)
  const handleHiddenToggle = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    dispatch(uiActions['setBalanceHidden'](!isBalanceHidden))
  }

  const balanceValue = useMemo(() => {
    if (!hasLoadedBalance) {
      return '--'
    }
    return numUtils.satoshisToAmount(accountBalance.totalBalance)
  }, [accountBalance.totalBalance, hasLoadedBalance])

  const unavailableTipText = useMemo(() => t('unavailable_tooltip'), [t])

  // The explorer could not list this account's outputs; the total comes from
  // the address statistics and is labelled so it is not read as spendable.
  const utxoLimitExceeded = isCurrentChainBalance && accountBalance.utxoLimitExceeded === true
  const utxoLimitExceededText = useMemo(() => t('utxo_limit_exceeded_balance'), [t])
  // The background read the address statistics but not yet every output (an
  // account with thousands of them takes several reads): the total is
  // measured, the split is not, and the next read carries on. The note says
  // so without blaming the explorer, which does list the outputs.
  const utxoReadIncomplete = isCurrentChainBalance && accountBalance.utxoReadIncomplete === true
  const utxoReadIncompleteText = useMemo(() => t('balance_outputs_incomplete'), [t])
  const utxoReadIncompleteDetailText = useMemo(() => t('balance_outputs_incomplete_detail'), [t])
  // Without the output list Available is unknown (`null`), and so is how
  // much of the total is unavailable: both show `--` rather than a measured
  // 0 and the whole total, as they do before any read. The send screen
  // shows Available as `--` too. The note names the explorer's limit, so it
  // shows only when that limit is the cause, not for another unknown split.
  const availableUnknown =
    !isCurrentChainBalance || accountBalance.availableBalance === null || utxoReadIncomplete
  const balanceSplitUnknown = utxoLimitExceeded && availableUnknown
  const balanceSplitUnknownText = useMemo(() => t('utxo_limit_exceeded_balance_detail'), [t])

  const totalBalance = accountBalance.totalBalance
  const availableBalance = availableUnknown ? null : accountBalance.availableBalance
  const unavailableBalance = availableUnknown ? null : accountBalance.unavailableBalance

  const totalAmount = numUtils.satoshisToAmount(accountBalance.totalBalance)
  const availableAmount =
    availableBalance === null ? '--' : numUtils.satoshisToAmount(availableBalance)
  const unavailableAmount =
    unavailableBalance === null ? '--' : numUtils.satoshisToAmount(unavailableBalance)

  const totalAmountMainPart = totalAmount.slice(0, -8)
  const totalAmountSubPart = totalAmount.slice(-8)

  // Retry from the error state runs at once rather than debounced, one at a
  // time so repeated taps do not stack requests on a failing explorer.
  const [isRetryingBalance, setIsRetryingBalance] = useState(false)
  const retryingRef = useRef<object | undefined>(undefined)

  // The poll for the selected account on the selected network. Another
  // account or network starts a cadence of its own: no read in flight, back
  // off or pending refresh carries over, and no tick of the old one runs.
  const pollRef = useRef<BalancePoll | null>(null)
  useEffect(() => {
    setIsRetryingBalance(false)
    const balancePoll = startBalancePoll(fetchBalance)
    pollRef.current = balancePoll
    return (): void => {
      balancePoll.stop()
      pollRef.current = null
      retryingRef.current = undefined
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [fetchBalance, chainType])

  // The balance shown when the card mounts was read before whatever moved
  // funds since, possibly minutes earlier on another screen (a send plan
  // holding, combining or spending the account's outputs, a payment going
  // out): read it again at once, not at the first poll. Once per mount, and
  // not while no balance is shown, when the first read is on its way.
  const mountReadRef = useRef(false)
  useEffect(() => {
    if (mountReadRef.current) return
    mountReadRef.current = true
    if (!hasLoadedBalance) return
    pollRef.current?.read().catch(() => {
      // A failed read keeps the last balance; the poll retries.
    })
  }, [hasLoadedBalance])

  const refreshBalance = useCallback((e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation()
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      pollRef.current?.read().catch(() => {
        // A failed refresh keeps the last balance; the poll retries.
      })
    }, DEBOUNCE_DELAY)
  }, [])

  const retryBalance = useCallback((e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation()
    }
    const balancePoll = pollRef.current
    if (!balancePoll || retryingRef.current) return
    const retry = {}
    retryingRef.current = retry
    setIsRetryingBalance(true)
    balancePoll
      .read()
      .catch(() => {
        // Recorded in the balance status; the error state stays up.
      })
      .finally(() => {
        // A retry for an account or network no longer shown leaves the
        // current one's button alone.
        if (retryingRef.current !== retry) return
        retryingRef.current = undefined
        setIsRetryingBalance(false)
      })
  }, [])

  return {
    // state
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
    utxoReadIncomplete,
    utxoReadIncompleteText,
    utxoReadIncompleteDetailText,
    balanceLoading,
    balanceLoadFailed,
    balanceRefreshFailed,
    balanceErrorText,

    isDetailExpanded,
    handleExpandToggle,

    isBalanceHidden,
    handleHiddenToggle,

    refreshBalance,
    retryBalance,
    isRetryingBalance,
    qbitUnit,

    chain,
    t,
  }
}
