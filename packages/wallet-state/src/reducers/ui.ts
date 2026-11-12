import { createSlice, Slice } from '@reduxjs/toolkit'
import { QBIT_FALLBACK_FEE_RATE } from '@qbit/wallet-shared'
import type { ChainType } from '@qbit/wallet-types'

import { resetWalletState, updateVersion } from '../actions/global'
import { NavigationSource } from '../types'

/** The quote read, and the option, from which a fee bar chose its rate. */
export interface FeeRateSource {
  /** The `read` of the quote, as useFeeQuoteRead names it. */
  quoteRead: string
  optionIndex: number
}

/** An account on a network: `accounts.current.address` and `settings.chainType`. */
export interface SendFormScope {
  address: string
  chainType: ChainType
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
  /**
   * The account and network the send form's values were entered under: the
   * last ones the store knew, null before it knew any (`scopeSendForm`).
   */
  sendFormScope: SendFormScope | null
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
    // No fee bar has chosen a rate yet; a screen waits until one does.
    feeRate: QBIT_FALLBACK_FEE_RATE,
    feeRateInputVal: '',
    enableLowFeeRate: false,
    feeOptionIndex: 1, // Default to AVG
    showCustomInput: false,
    feeRateSource: null,
  },
  navigationSource: NavigationSource.NORMAL,
  isBalanceHidden: false,
  balanceDetailExpanded: true,
  sendFormScope: null,
}

/**
 * The ui state once the store selects the account at `address` on
 * `chainType`. The send form (`uiTxCreateScreen`), the fee bar and the
 * address and amount inputs hold what was entered for the account and
 * network that `sendFormScope` records. When a known account and network
 * replace those with different ones, the four take their initial values,
 * and the new ones are recorded. An empty address is no account yet, as
 * before the accounts load: it changes nothing, so the values stay for an
 * account and network that come back unchanged. The first account and
 * network known are recorded as they are, with nothing cleared.
 */
export function scopeSendForm(state: UIState, address: string, chainType: ChainType): UIState {
  if (!address) return state
  const scope = state.sendFormScope
  if (scope?.address === address && scope.chainType === chainType) return state
  const sendFormScope = { address, chainType }
  if (!scope) return { ...state, sendFormScope }
  return {
    ...state,
    uiTxCreateScreen: initialState.uiTxCreateScreen,
    addressInput: initialState.addressInput,
    amountInput: initialState.amountInput,
    feeRateBar: initialState.feeRateBar,
    sendFormScope,
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The part of the ui state a wallet page saves: its display preferences. */
export type SavedUiState = Pick<UIState, 'isBalanceHidden' | 'balanceDetailExpanded'>

function ownBoolean(fields: Record<string, unknown>, key: keyof SavedUiState): boolean | undefined {
  const value = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The display preferences of `ui`, and nothing else of it. A preference that
 * `ui` does not hold as a boolean of its own takes its initial value, as both
 * do when `ui` is not an object.
 */
export function savedUiState(ui: unknown): SavedUiState {
  const fields = isPlainObject(ui) ? ui : {}
  return {
    isBalanceHidden: ownBoolean(fields, 'isBalanceHidden') ?? initialState.isBalanceHidden,
    balanceDetailExpanded:
      ownBoolean(fields, 'balanceDetailExpanded') ?? initialState.balanceDetailExpanded,
  }
}

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
      // A ui state that a store preloads without some fields: anything it
      // lacks takes its initial value, so no reducer meets a missing object,
      // and a fee rate without its source has none. createAppStore preloads
      // a complete state (the saved preferences over the initial one), so
      // this is for a store that preloads one of its own, such as a state an
      // earlier build saved.
      if (!isPlainObject(state)) return initialState
      fillMissing(state, initialState)
      return state
    })
    // Drafts such as the send form belong to the erased wallets.
    builder.addCase(resetWalletState, () => initialState)
  },
})

export const uiActions = slice.actions
export default slice.reducer
