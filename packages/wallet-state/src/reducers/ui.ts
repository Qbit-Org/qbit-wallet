import { createSlice, Slice } from '@reduxjs/toolkit'

import { updateVersion } from '../actions/global'
import { NavigationSource } from '../types'

export interface UIState {
  uiTxCreateScreen: {
    toInfo: {
      address: string
    }
    inputAmount: string
    enableRBF: boolean
    memo: string
  }
  addressInput: {
    address: string
  }
  amountInput: {
    amount: string
  }
  feeRateBar: {
    feeRate: number
    feeRateInputVal: string
    enableLowFeeRate: boolean
    feeOptionIndex: number
    showCustomInput: boolean
  }
  navigationSource: NavigationSource
  isBalanceHidden: boolean
  balanceDetailExpanded: boolean
}

export const initialState: UIState = {
  uiTxCreateScreen: {
    toInfo: {
      address: '',
    },
    inputAmount: '',
    enableRBF: true,
    memo: '',
  },
  addressInput: {
    address: '',
  },
  amountInput: {
    amount: '',
  },
  feeRateBar: {
    feeRate: 1,
    feeRateInputVal: '',
    enableLowFeeRate: false,
    feeOptionIndex: 1, // Default to AVG
    showCustomInput: false,
  },
  navigationSource: NavigationSource.NORMAL,
  isBalanceHidden: false,
  balanceDetailExpanded: true,
}

const slice: Slice<UIState> = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    reset(state) {
      return initialState
    },
    updateTxCreateScreen(
      state,
      action: {
        payload: {
          toInfo?: {
            address: string
          }
          inputAmount?: string
          enableRBF?: boolean
          memo?: string
        }
      }
    ) {
      if (action.payload.toInfo !== undefined) {
        state.uiTxCreateScreen.toInfo = action.payload.toInfo
      }
      if (action.payload.inputAmount !== undefined) {
        state.uiTxCreateScreen.inputAmount = action.payload.inputAmount
      }
      if (action.payload.enableRBF !== undefined) {
        state.uiTxCreateScreen.enableRBF = action.payload.enableRBF
      }
      if (action.payload.memo !== undefined) {
        state.uiTxCreateScreen.memo = action.payload.memo
      }

      state.uiTxCreateScreen = { ...state.uiTxCreateScreen }
    },
    updateFeeRateBar(
      state,
      action: {
        payload: {
          feeRate?: number
          feeRateInputVal?: string
          enableLowFeeRate?: boolean
          feeOptionIndex?: number
          showCustomInput?: boolean
        }
      }
    ) {
      if (action.payload.feeRate !== undefined) {
        state.feeRateBar.feeRate = action.payload.feeRate
      }
      if (action.payload.feeRateInputVal !== undefined) {
        state.feeRateBar.feeRateInputVal = action.payload.feeRateInputVal
      }
      if (action.payload.enableLowFeeRate !== undefined) {
        state.feeRateBar.enableLowFeeRate = action.payload.enableLowFeeRate
      }
      if (action.payload.feeOptionIndex !== undefined) {
        state.feeRateBar.feeOptionIndex = action.payload.feeOptionIndex
      }
      if (action.payload.showCustomInput !== undefined) {
        state.feeRateBar.showCustomInput = action.payload.showCustomInput
      }
      state.feeRateBar = { ...state.feeRateBar }
    },
    resetFeeRateBar(state) {
      state.feeRateBar = initialState.feeRateBar
    },

    updateAddressInput(
      state,
      action: {
        payload: {
          address?: string
        }
      }
    ) {
      if (action.payload.address !== undefined) {
        state.addressInput.address = action.payload.address
      }
      state.addressInput = { ...state.addressInput }
    },

    resetAddressInput(state) {
      state.addressInput = initialState.addressInput
    },

    updateAmountInput(
      state,
      action: {
        payload: {
          amount?: string
        }
      }
    ) {
      if (action.payload.amount !== undefined) {
        state.amountInput.amount = action.payload.amount
      }
      state.amountInput = { ...state.amountInput }
    },

    resetAmountInput(state) {
      state.amountInput = initialState.amountInput
    },

    resetTxCreateScreen(state) {
      state.uiTxCreateScreen = initialState.uiTxCreateScreen
    },
    setNavigationSource(state, action: { payload: NavigationSource }) {
      state.navigationSource = action.payload
    },
    setBalanceHidden(state, action: { payload: boolean }) {
      state.isBalanceHidden = action.payload
    },
    setBalanceDetailExpanded(state, action: { payload: boolean }) {
      state.balanceDetailExpanded = action.payload
    },
  },
  extraReducers: builder => {
    builder.addCase(updateVersion, state => {
      if (!state.uiTxCreateScreen) {
        state.uiTxCreateScreen = initialState.uiTxCreateScreen
      } else if (state.uiTxCreateScreen.enableRBF === undefined) {
        state.uiTxCreateScreen.enableRBF = true
      }
      if (state.uiTxCreateScreen.memo === undefined) {
        state.uiTxCreateScreen.memo = ''
      }
      if (!state.feeRateBar) {
        state.feeRateBar = initialState.feeRateBar
      }
      if (state.isBalanceHidden === undefined) {
        state.isBalanceHidden = false
      }
      if (state.balanceDetailExpanded === undefined) {
        state.balanceDetailExpanded = true
      }
    })
  },
})

export const uiActions = slice.actions
export default slice.reducer
