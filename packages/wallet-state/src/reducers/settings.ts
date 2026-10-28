import { DEFAULT_LOCKTIME_ID, DEFAULT_THEME_MODE, ThemeMode, WalletConfig } from '@qbit/wallet-shared'
import { ChainType, NetworkType } from '@qbit/wallet-types'
import { createSlice, Slice } from '@reduxjs/toolkit'

import { updateVersion } from '../actions/global'

export interface SettingsState {
  locale: string
  networkType: NetworkType
  chainType: ChainType
  walletConfig: WalletConfig
  skippedVersion: string
  autoLockTimeId: number
  developerMode: boolean
  themeMode: ThemeMode
}

export const initialState: SettingsState = {
  locale: 'English',
  networkType: NetworkType.MAINNET,
  chainType: ChainType.QBIT_MAINNET,
  walletConfig: {
    version: '',
    moonPayEnabled: true,
    statusMessage: '',
    endpoint: '',
    chainTip: '',
    disableUtxoTools: true,
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
          networkType?: NetworkType
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
    builder.addCase(updateVersion, state => {
      // todo
      if (!state.networkType) {
        state.networkType = NetworkType.MAINNET
      }
    })
  },
})

export const settingsActions = slice.actions
export default slice.reducer
