import { numUtils } from '@qbit/base-utils'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { AppState, uiActions } from 'src'
import { useI18n } from '../context'
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

export function useBalanceCardLogic() {
  const { t } = useI18n()

  const accountBalance = useAccountBalance()
  const balanceStatus = useAccountBalanceStatus()
  const chain = useChain()
  const dispatch = useDispatch()

  const fetchBalance = useFetchBalanceCallback()

  const qbitUnit = useQbitUnit()

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  const isCurrentChainBalance = chain.enum == accountBalance.chainType

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
  // Without the output list Available is unknown (`null`), and so is how
  // much of the total is unavailable: both show `--` rather than a measured
  // 0 and the whole total. The send screen shows Available as `--` too.
  const availableUnknown = accountBalance.availableBalance === null
  const balanceSplitUnknown = isCurrentChainBalance && availableUnknown
  const balanceSplitUnknownText = useMemo(() => t('utxo_limit_exceeded_balance_detail'), [t])

  const totalBalance = accountBalance.totalBalance
  const availableBalance = accountBalance.availableBalance
  const unavailableBalance = availableUnknown ? null : accountBalance.unavailableBalance

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
