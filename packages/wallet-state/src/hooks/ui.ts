import { useCallback } from 'react'

import { AppState } from '..'
import { useAppDispatch, useAppSelector } from '../hooks/base'
import { uiActions, type FeeRateSource } from '../reducers/ui'
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
      feeOptionIndex,
      showCustomInput,
      feeRateSource,
    }: {
      feeRate?: number
      feeRateInputVal?: string
      feeOptionIndex?: number
      showCustomInput?: boolean
      /** Where `feeRate` came from; a rate written without one has none. */
      feeRateSource?: FeeRateSource | null
    }) => {
      dispatch(
        (uiActions as any).updateFeeRateBar({
          feeRate,
          feeRateInputVal,
          feeOptionIndex,
          showCustomInput,
          feeRateSource,
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

export function useBalanceCardDetailExpanded() {
  const uiState = useUIState()
  return uiState.balanceDetailOpen
}

export function useToggleBalanceCardDetailExpanded() {
  const { balanceDetailOpen } = useUIState()
  const dispatch = useAppDispatch()
  return useCallback(() => {
    dispatch((uiActions as any).setBalanceDetailOpen(!balanceDetailOpen))
  }, [dispatch, balanceDetailOpen])
}
