import { save } from 'redux-localstorage-simple'

import {
  combineReducers,
  configureStore,
  type AnyAction,
  type Dispatch,
  type Middleware,
} from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/dist/query/react/index.js'

import accounts from './reducers/accounts'
import { updateVersion } from './actions/global'
import global from './reducers/global'
import keyrings from './reducers/keyrings'
import settings from './reducers/settings'
import transactions from './reducers/transactions'
import ui, {
  initialState as uiInitialState,
  savedUiState,
  scopeSendForm,
  type SavedUiState,
} from './reducers/ui'

const PERSISTED_KEYS: string[] = ['ui']

/**
 * Where redux-localstorage-simple keeps the saved `ui` state: its default
 * namespace, `_`, then the state's path.
 */
const SAVED_UI_KEY = 'redux_localstorage_simple_ui'

/**
 * The display preferences saved under `SAVED_UI_KEY`, for a page that starts.
 * Earlier builds saved the whole `ui` state there, the send form's values
 * included. Only the preferences are read, and the stored value is replaced at
 * once with them alone, not at the next save: a page closed right after it
 * opens leaves nothing else behind. A value that is no JSON object is
 * replaced the same way, with the initial preferences, and a value that
 * cannot be replaced is removed. A missing value stays missing, and one that
 * holds just the preferences is left as it is.
 */
function loadSavedUiState(): SavedUiState {
  let stored: string | null
  try {
    stored = localStorage.getItem(SAVED_UI_KEY)
  } catch {
    // Storage can be denied by privacy settings: nothing is saved then.
    return savedUiState(undefined)
  }
  if (stored === null) return savedUiState(undefined)
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    parsed = undefined
  }
  const preferences = savedUiState(parsed)
  const kept = JSON.stringify(preferences)
  if (stored !== kept) {
    try {
      localStorage.setItem(SAVED_UI_KEY, kept)
    } catch {
      // Not written: the stored value is removed instead, so that no send
      // form it holds stays behind. The preferences go with it; this page
      // still loads them from what it read, and saves them when one changes.
      try {
        localStorage.removeItem(SAVED_UI_KEY)
      } catch {
        // Storage refuses this too: nothing more can be done from here.
      }
    }
  }
  return preferences
}

/**
 * Saves the display preferences, and nothing else of the store, under
 * `SAVED_UI_KEY` with redux-localstorage-simple, a second after the last
 * action that changed one of them. An action that changes neither writes
 * nothing, so a page does not put its older preferences back over a change
 * another page saved, unless it changes one itself.
 */
const saveUiState: Middleware = api => {
  // redux-localstorage-simple's middleware saves the `ui` of what this
  // `getState` returns. Handed an action, it passes it on, here to nothing,
  // and saves a second later unless another action comes first.
  const passNowhere: Dispatch = action => action
  const saveSoon = save({ states: PERSISTED_KEYS, debounce: 1000 })({
    dispatch: api.dispatch,
    getState: () => ({ ui: savedUiState(api.getState().ui) }),
  })(passNowhere)
  return next => action => {
    const { isBalanceHidden, balanceDetailExpanded } = api.getState().ui
    const result = next(action)
    const { ui } = api.getState()
    if (
      ui.isBalanceHidden !== isBalanceHidden ||
      ui.balanceDetailExpanded !== balanceDetailExpanded
    ) {
      saveSoon(action)
    }
    return result
  }
}

const sliceReducer = combineReducers({
  accounts,
  transactions,
  settings,
  global,
  keyrings,
  ui,
})

type SliceState = ReturnType<typeof sliceReducer>

/**
 * Every slice's reducer, then `scopeSendForm`: an action that changes the
 * selected account or network clears the send form in the same update, so no
 * reader of the store sees the new account or network with the old form.
 */
function rootReducer(state: SliceState | undefined, action: AnyAction): SliceState {
  const next = sliceReducer(state, action)
  const scoped = scopeSendForm(next.ui, next.accounts.current.address, next.settings.chainType)
  return scoped === next.ui ? next : { ...next, ui: scoped }
}

export function createAppStore() {
  const store = configureStore({
    reducer: rootReducer,
    middleware: getDefaultMiddleware => getDefaultMiddleware({ thunk: true }).concat(saveUiState),
    // Of the saved `ui` state, only the display preferences: everything else
    // starts at its initial value.
    preloadedState: { ui: { ...uiInitialState, ...loadSavedUiState() } },
  })

  store.dispatch(updateVersion())
  setupListeners(store.dispatch)

  return store
}

export type AppStore = ReturnType<typeof createAppStore>
export type AppState = ReturnType<AppStore['getState']>
export type AppDispatch = AppStore['dispatch']

export * from './biometric'
export * from './context'
export * from './hooks'
export * from './updater'
export * from './reducers'
export * from './types'
export * from './ui-hooks'
export { uiEventBus } from './utils/eventBus'
export { formatFeeRate } from './utils/fee-rate-text'
export { useAsyncEffect } from './utils/ui-utils'
