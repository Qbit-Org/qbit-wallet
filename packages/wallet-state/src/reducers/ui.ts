import { createSlice, Slice } from '@reduxjs/toolkit'

import { updateVersion } from '../actions/global'
import { NavigationSource } from '../types'

/** The quote read, and the option, from which a fee bar chose its rate. */
export interface FeeRateSource {
  /** The `read` of the quote, as useFeeQuoteRead names it. */
  quoteRead: string
  optionIndex: number
}

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
    /**
     * Where `feeRate` came from: null for a Custom rate and for a rate no
     * fee bar chose, such as the default.
     */
    feeRateSource: FeeRateSource | null
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
    feeRateSource: null,
  },
  navigationSource: NavigationSource.NORMAL,
  isBalanceHidden: false,
  balanceDetailExpanded: true,
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Give `target` every field of `defaults` it lacks, at every depth. A field
 * that should hold an object but holds something else counts as missing.
 * Fields that `defaults` does not have are kept.
 */
function fillMissing(target: Record<string, unknown>, defaults: object): void {
  for (const [key, value] of Object.entries(defaults)) {
    const stored = target[key]
    if (isPlainObject(value)) {
      if (isPlainObject(stored)) fillMissing(stored, value)
      else target[key] = value
    } else if (stored === undefined) {
      target[key] = value
    }
  }
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
          feeRateSource?: FeeRateSource | null
        }
      }
    ) {
      if (action.payload.feeRate !== undefined) {
        state.feeRateBar.feeRate = action.payload.feeRate
        // A rate written without its source has none.
        state.feeRateBar.feeRateSource = action.payload.feeRateSource ?? null
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
      // The state saved by any earlier build: anything it lacks takes its
      // initial value, so no reducer meets a missing object. A fee rate
      // stored before rates recorded their source has none.
      if (!isPlainObject(state)) return initialState
      fillMissing(state, initialState)
      return state
    })
  },
})

export const uiActions = slice.actions
export default slice.reducer
