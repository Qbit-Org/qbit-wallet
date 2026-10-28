import { numUtils } from '@qbit/base-utils'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { AppState, uiActions } from 'src'
import { useI18n } from '../context'
import {
  useAccountBalance,
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
  const chain = useChain()
  const dispatch = useDispatch()

  const fetchBalance = useFetchBalanceCallback()

  const qbitUnit = useQbitUnit()

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Detail expand state
  const isDetailExpanded = useBalanceCardDetailExpanded()
  const toggleBalanceCardDetailExpanded = useToggleBalanceCardDetailExpanded()
  const handleExpandToggle = () => {
    toggleBalanceCardDetailExpanded()
  }

  // Balance visibility
  const isBalanceHidden = useSelector((state: AppState) => state.ui.isBalanceHidden)
  const handleHiddenToggle = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    dispatch(uiActions['setBalanceHidden'](!isBalanceHidden))
  }

  const isCurrentChainBalance = chain.enum == accountBalance.chainType
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

  const totalBalance = accountBalance.totalBalance
  const availableBalance = accountBalance.availableBalance
  const unavailableBalance = accountBalance.unavailableBalance

  const totalAmount = numUtils.satoshisToAmount(accountBalance.totalBalance)
  const availableAmount = numUtils.satoshisToAmount(accountBalance.availableBalance)
  const unavailableAmount = numUtils.satoshisToAmount(accountBalance.unavailableBalance)

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

    isDetailExpanded,
    handleExpandToggle,

    isBalanceHidden,
    handleHiddenToggle,

    refreshBalance,
    qbitUnit,

    chain,
    t,
  }
}
