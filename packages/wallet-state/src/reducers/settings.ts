import { DEFAULT_LOCKTIME_ID, DEFAULT_THEME_MODE, ThemeMode, WalletConfig } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { createSlice, Slice } from '@reduxjs/toolkit'

import { resetWalletState } from '../actions/global'

export interface SettingsState {
  locale: string
  chainType: ChainType
  walletConfig: WalletConfig
  skippedVersion: string
  autoLockTimeId: number
  developerMode: boolean
  themeMode: ThemeMode
}

export const initialState: SettingsState = {
  locale: 'English',
  chainType: ChainType.QBIT_MAINNET,
  walletConfig: {
    version: '',
    statusMessage: '',
    chainTip: '',
  },
  skippedVersion: '',
  autoLockTimeId: DEFAULT_LOCKTIME_ID,
  developerMode: false,
  themeMode: DEFAULT_THEME_MODE,
}

const slice: Slice<SettingsState> = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    reset(state) {
      return initialState
    },
    updateSettings(
      state,
      action: {
        payload: {
          locale?: string
          walletConfig?: WalletConfig
          skippedVersion?: string
          chainType?: ChainType
          autoLockTimeId?: number
          developerMode?: boolean
          themeMode?: ThemeMode
        }
      }
    ) {
      const { payload } = action
      state = Object.assign({}, state, payload)
      return state
    },
  },
  extraReducers: builder => {
    // The background keeps the language and the theme through a reset and
    // returns every other preference to its default.
    builder.addCase(resetWalletState, state => ({
      ...initialState,
      locale: state.locale,
      themeMode: state.themeMode,
    }))
  },
})

export const settingsActions = slice.actions
export default slice.reducer
