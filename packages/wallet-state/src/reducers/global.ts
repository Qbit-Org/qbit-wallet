import { createSlice, PayloadAction, SliceCaseReducers } from '@reduxjs/toolkit'

import { resetWalletState } from '../actions/global'

export interface GlobalState {
  isUnlocked: boolean
  isReady: boolean
  isBooted: boolean
  switchChainModalVisible: boolean
}

export const initialState: GlobalState = {
  isUnlocked: false,
  isReady: false,
  isBooted: false,
  switchChainModalVisible: false,
}

const reducers: SliceCaseReducers<GlobalState> = {
  reset: state => initialState,
  update: (
    state,
    action: PayloadAction<{
      isUnlocked?: boolean
      isReady?: boolean
      isBooted?: boolean
      switchChainModalVisible?: boolean
    }>
  ) => {
    const { payload } = action
    state = Object.assign({}, state, payload)
    return state
  },
}

const slice = createSlice({
  name: 'global',
  initialState,
  reducers,
  extraReducers: builder => {
    // No wallet and no password are left: not booted, not unlocked. The app
    // stays mounted (isReady) while the page goes to the first-run screen.
    builder.addCase(resetWalletState, state => ({ ...initialState, isReady: state.isReady }))
  },
})

export const globalActions = slice.actions as any

export default slice.reducer
