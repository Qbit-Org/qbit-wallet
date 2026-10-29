import { numUtils } from '@qbit/base-utils'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { AppState, uiActions } from 'src'
import { useI18n } from '../context'
import { hasAccountBalanceRead } from '../reducers/accounts'
import {
  getQbitP2mrSpendableSatoshis,
  useAccountBalance,
  useAccountBalanceStatus,
  useBalanceCardDetailExpanded,
  useChain,
  useCurrentAccount,
  useFetchBalanceCallback,
  useQbitUnit,
  useToggleBalanceCardDetailExpanded,
  useUtxos,
  useUtxosLoaded,
} from '../hooks'

const DEBOUNCE_DELAY = 1000

/**
 * How long after it lands the card takes its split from the send screen's
 * read of the outputs. Only broadcasts from this window make a read out of
 * date at once; a send from another window or a website's approval window
 * does not, so the read is also given up once it is this old.
 */
export const BALANCE_CARD_OUTPUT_READ_MAX_AGE_MS = 2 * 60 * 1000

export function useBalanceCardLogic() {
  const { t } = useI18n()

  const accountBalance = useAccountBalance()
  const balanceStatus = useAccountBalanceStatus()
  const chain = useChain()
  const dispatch = useDispatch()

  const fetchBalance = useFetchBalanceCallback()

  const qbitUnit = useQbitUnit()

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // A balance read for this account on this network, not the stand-in zeros
  // from before the first one succeeded (they show as `--`, not 0).
  const isCurrentChainBalance = useSelector((state: AppState) =>
    hasAccountBalanceRead(state.accounts, state.accounts.current.address, chain.enum)
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

  // Detail expand state
  const isDetailExpanded = useBalanceCardDetailExpanded()
  const toggleBalanceCardDetailExpanded = useToggleBalanceCardDetailExpanded()
  const handleExpandToggle = () => {
    // There is no breakdown to show until a balance loads.
    if (balanceLoadFailed) return
    toggleBalanceCardDetailExpanded()
  }

  // Balance visibility
  const isBalanceHidden = useSelector((state: AppState) => state.ui.isBalanceHidden)
  const handleHiddenToggle = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    dispatch(uiActions['setBalanceHidden'](!isBalanceHidden))
  }

  const balanceValue = useMemo(() => {
    if (!isCurrentChainBalance) {
      return '--'
    }
    return numUtils.satoshisToAmount(accountBalance.totalBalance)
  }, [accountBalance.totalBalance, isCurrentChainBalance])

  const unavailableTipText = useMemo(() => t('unavailable_tooltip'), [t])

  // The explorer could not list this account's outputs; the total comes from
  // the address statistics and is labelled so it is not read as spendable.
  const utxoLimitExceeded = isCurrentChainBalance && accountBalance.utxoLimitExceeded === true
  const utxoLimitExceededText = useMemo(() => t('utxo_limit_exceeded_balance'), [t])
  // The send screen reads the outputs from the account's history past the
  // limit. The cache holds that read only for this account on this network
  // (`useUtxosLoaded`), and the card takes it while no broadcast from this
  // window came after the read started and it is recent.
  const currentAccount = useCurrentAccount()
  const utxos = useUtxos()
  const utxosLoaded = useUtxosLoaded()
  const utxosReadAt = useSelector((state: AppState) => state.transactions.utxosReadAt)
  const utxosReadBeforeBroadcast = useSelector(
    (state: AppState) => state.transactions.utxosBroadcasts !== state.transactions.broadcasts
  )
  // Marks the read too old when its time is up, which also re-renders the
  // card, even if the timer fires a moment before the clock says so.
  const [expiredUtxosReadAt, setExpiredUtxosReadAt] = useState(0)
  useEffect(() => {
    if (!utxosReadAt) return undefined
    const timer = setTimeout(
      () => setExpiredUtxosReadAt(utxosReadAt),
      Math.max(0, utxosReadAt + BALANCE_CARD_OUTPUT_READ_MAX_AGE_MS - Date.now())
    )
    return () => clearTimeout(timer)
  }, [utxosReadAt])
  const utxosReadCurrent =
    utxosLoaded &&
    utxosReadAt > 0 &&
    !utxosReadBeforeBroadcast &&
    expiredUtxosReadAt !== utxosReadAt &&
    Date.now() - utxosReadAt < BALANCE_CARD_OUTPUT_READ_MAX_AGE_MS

  // Without the output list Available is unknown (`null`), and so is how
  // much of the total is unavailable: both show `--` rather than a measured
  // 0 and the whole total, as they do before any read. The send screen
  // shows them as `--` too. Past the explorer's limit a current read of the
  // outputs gives the split instead, never more Available than the total.
  // The note names the explorer's limit, so it shows only when that limit
  // is the cause, not for another unknown split.
  const availableUnknown = !isCurrentChainBalance || accountBalance.availableBalance === null
  const totalBalance = accountBalance.totalBalance
  const readAvailableBalance =
    utxoLimitExceeded && availableUnknown && utxosReadCurrent
      ? Math.min(getQbitP2mrSpendableSatoshis(utxos, currentAccount), Math.max(0, totalBalance))
      : null
  const balanceSplitUnknown = utxoLimitExceeded && availableUnknown && readAvailableBalance === null
  const balanceSplitUnknownText = useMemo(() => t('utxo_limit_exceeded_balance_detail'), [t])

  const availableBalance =
    readAvailableBalance ?? (availableUnknown ? null : accountBalance.availableBalance)
  const unavailableBalance =
    readAvailableBalance !== null
      ? Math.max(0, totalBalance) - readAvailableBalance
      : availableUnknown
        ? null
        : accountBalance.unavailableBalance

  const totalAmount = numUtils.satoshisToAmount(accountBalance.totalBalance)
  const availableAmount =
    availableBalance === null ? '--' : numUtils.satoshisToAmount(availableBalance)
  const unavailableAmount =
    unavailableBalance === null ? '--' : numUtils.satoshisToAmount(unavailableBalance)

  const totalAmountMainPart = totalAmount.slice(0, -8)
  const totalAmountSubPart = totalAmount.slice(-8)

  // Passive refresh every 10 seconds
  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchBalance().catch(() => {
        // A failed poll keeps the last balance; the next tick retries.
      })
    }, 10000)

    return () => clearInterval(intervalId)
  }, [dispatch, fetchBalance])

  const refreshBalance = useCallback(
    (e?: React.MouseEvent) => {
      if (e) {
        e.stopPropagation()
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      debounceTimerRef.current = setTimeout(() => {
        fetchBalance().catch(() => {
          // A failed refresh keeps the last balance; the poll retries.
        })
        debounceTimerRef.current = null
      }, DEBOUNCE_DELAY)
    },
    [dispatch, fetchBalance]
  )

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  // Retry from the error state runs at once rather than debounced, one at a
  // time so repeated taps do not stack requests on a failing explorer.
  const [isRetryingBalance, setIsRetryingBalance] = useState(false)
  const isRetryingBalanceRef = useRef(false)
  const retryBalance = useCallback(
    (e?: React.MouseEvent) => {
      if (e) {
        e.stopPropagation()
      }
      if (isRetryingBalanceRef.current) return
      isRetryingBalanceRef.current = true
      setIsRetryingBalance(true)
      fetchBalance()
        .catch(() => {
          // Recorded in the balance status; the error state stays up.
        })
        .finally(() => {
          isRetryingBalanceRef.current = false
          setIsRetryingBalance(false)
        })
    },
    [fetchBalance]
  )

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
