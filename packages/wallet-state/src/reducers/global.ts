import { createSlice, PayloadAction, SliceCaseReducers } from '@reduxjs/toolkit'

import { updateVersion } from '../actions/global'
import { TabOption } from '../types'

export interface GlobalState {
  tab: TabOption
  isUnlocked: boolean
  isReady: boolean
  isBooted: boolean
  screenState?: {
    type: string
    options: any
  }
  isRefresh: boolean
  backRefresh: boolean
  wallRefresh: boolean
  wallTabRefresh: boolean
  unlockRefres: boolean
  unlockRead: boolean
  layerState: boolean
  isUnlockTimeRefres: boolean
  infiniteListScrollOffset: number
  infiniteListScrollDirection: 'up' | 'down'
  infiniteListScrollActiveTime: number
  isScrollViewTop: number
  isScrollViewBot: number
  isBiometricsSupported: boolean
  hasBiometricsKey: boolean
  wallTabFocusRefresh: 0
  goBackRefresh: 0
  switchChainModalVisible: boolean
  isLockedOverlayVisible: boolean
}

export const initialState: GlobalState = {
  tab: 'home',
  isUnlocked: false,
  isReady: false,
  isBooted: false,
  screenState: undefined,
  isRefresh: false,
  backRefresh: false,
  wallRefresh: false,
  wallTabRefresh: false,
  unlockRefres: false,
  unlockRead: false,
  layerState: false,
  isUnlockTimeRefres: false,
  infiniteListScrollOffset: 0,
  infiniteListScrollDirection: 'down',
  infiniteListScrollActiveTime: 0,
  isScrollViewTop: 0,
  isScrollViewBot: 0,
  isBiometricsSupported: false,
  hasBiometricsKey: false,
  wallTabFocusRefresh: 0,
  goBackRefresh: 0,
  switchChainModalVisible: false,
  isLockedOverlayVisible: false,
}

const reducers: SliceCaseReducers<GlobalState> = {
  reset: state => initialState,
  update: (
    state,
    action: PayloadAction<{
      tab?: TabOption
      isUnlocked?: boolean
      isReady?: boolean
      isBooted?: boolean
      screenState?: {
        type: string
        options: any
      }
      isRefresh?: boolean
      backRefresh?: boolean
      wallRefresh?: boolean
      wallTabRefresh?: boolean
      unlockRefres?: boolean
      layerState?: boolean
      unlockRead?: boolean
      isUnlockTimeRefres?: boolean
      infiniteListScrollOffset?: number
      infiniteListScrollDirection?: 'up' | 'down'
      infiniteListScrollActiveTime?: number
      isScrollViewTop?: number
      isScrollViewBot?: number
      isBiometricsSupported?: boolean
      hasBiometricsKey?: boolean
      wallTabFocusRefresh?: number
      goBackRefresh?: number
      switchChainModalVisible?: boolean
      lockedOverlayVisible?: boolean
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
    builder.addCase(updateVersion, state => {
      // todo
    })
  },
})

export const globalActions = slice.actions as any

export default slice.reducer
