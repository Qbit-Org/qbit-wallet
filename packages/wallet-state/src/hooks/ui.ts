import { useCallback } from 'react'

import { AppState } from '..'
import { useAppDispatch, useAppSelector } from '../hooks/base'
import { uiActions } from '../reducers/ui'
export function useUIState(): AppState['ui'] {
  return useAppSelector(state => state.ui)
}

export function useUiTxCreateScreen() {
  const uiState = useUIState()
  return uiState.uiTxCreateScreen
}

export function useUpdateUiTxCreateScreen() {
  const dispatch = useAppDispatch()
  return useCallback(
    ({
      toInfo,
      inputAmount,
      enableRBF,
      memo,
    }: {
      toInfo?: { address: string }
      inputAmount?: string
      enableRBF?: boolean
      memo?: string
    }) => {
      dispatch(
        (uiActions as any).updateTxCreateScreen({
          toInfo,
          inputAmount,
          enableRBF,
          memo,
        })
      )
    },
    [dispatch]
  )
}

export function useFeeRateBar() {
  const uiState = useUIState()
  return uiState.feeRateBar
}

export function useUpdateFeeRateBar() {
  const dispatch = useAppDispatch()
  return useCallback(
    ({
      feeRate,
      feeRateInputVal,
      enableLowFeeRate,
      feeOptionIndex,
      showCustomInput,
    }: {
      feeRate?: number
      feeRateInputVal?: string
      enableLowFeeRate?: boolean
      feeOptionIndex?: number
      showCustomInput?: boolean
    }) => {
      dispatch(
        (uiActions as any).updateFeeRateBar({
          feeRate,
          feeRateInputVal,
          enableLowFeeRate,
          feeOptionIndex,
          showCustomInput,
        })
      )
    },
    [dispatch]
  )
}

export function useResetFeeRateBar() {
  const dispatch = useAppDispatch()
  return useCallback(() => {
    dispatch((uiActions as any).resetFeeRateBar())
  }, [dispatch])
}

export function useAddressInput() {
  const uiState = useUIState()
  return uiState.addressInput
}

export function useUpdateAddressInput() {
  const dispatch = useAppDispatch()
  return useCallback(
    ({ address }: { address?: string }) => {
      dispatch(
        (uiActions as any).updateAddressInput({
          address,
        })
      )
    },
    [dispatch]
  )
}

export function useResetAddressInput() {
  const dispatch = useAppDispatch()
  return useCallback(() => {
    dispatch((uiActions as any).resetAddressInput())
  }, [dispatch])
}

export function useAmountInput() {
  const uiState = useUIState()
  return uiState.amountInput
}

export function useUpdateAmountInput() {
  const dispatch = useAppDispatch()
  return useCallback(
    ({ amount }: { amount?: string }) => {
      dispatch(
        (uiActions as any).updateAmountInput({
          amount,
        })
      )
    },
    [dispatch]
  )
}

export function useResetAmountInput() {
  const dispatch = useAppDispatch()
  return useCallback(() => {
    dispatch((uiActions as any).resetAmountInput())
  }, [dispatch])
}

export function useResetTxState() {
  const dispatch = useAppDispatch()
  return useCallback(() => {
    dispatch((uiActions as any).resetTxCreateScreen())
    dispatch((uiActions as any).resetFeeRateBar())
  }, [dispatch])
}

export function useResetUiTxCreateScreen() {
  const dispatch = useAppDispatch()
  return useCallback(() => {
    dispatch((uiActions as any).resetTxCreateScreen())
  }, [dispatch])
}

export const useThrottle = (callback, delay, lastCallRef) => {
  return useCallback(
    (...args) => {
      const now = Date.now()
      if (now - lastCallRef.current > delay) {
        lastCallRef.current = now
        callback(...args)
      }
    },
    [callback, delay, lastCallRef]
  )
}

export const useIsInExpandView = () => {
  return typeof window !== 'undefined' && window.innerWidth > 156 * 3
}


export function useBalanceCardDetailExpanded() {
  const uiState = useUIState()
  return uiState.balanceDetailExpanded
}

export function useToggleBalanceCardDetailExpanded() {
  const { balanceDetailExpanded } = useUIState()
  const dispatch = useAppDispatch()
  return useCallback(() => {
    dispatch((uiActions as any).setBalanceDetailExpanded(!balanceDetailExpanded))
  }, [dispatch, balanceDetailExpanded])
}
