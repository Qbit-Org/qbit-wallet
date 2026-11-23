import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore, resetWalletState } from '../../src'
import {
  accountActions,
  accountTotalsAsked,
  initialState as accountsInitial,
  storeAccountTotals,
} from '../../src/reducers/accounts'
import { globalActions, initialState as globalInitial } from '../../src/reducers/global'
import { initialState as keyringsInitial, keyringsActions } from '../../src/reducers/keyrings'
import { initialState as settingsInitial, settingsActions } from '../../src/reducers/settings'
import {
  initialState as transactionsInitial,
  transactionsActions,
} from '../../src/reducers/transactions'
import { initialState as uiInitial, uiActions } from '../../src/reducers/ui'

// Where the store saves its display preferences, and nothing of the send form.
const SAVED_UI_KEY = 'redux_localstorage_simple_ui'
const DRAFT_ADDRESS = 'qb1zdraftrecipient'

const account = {
  address: 'qb1zerased',
  key: 'keyring_0#0',
  index: 0,
  type: 'HD Key Tree',
  pubkey: '02',
  flag: 0,
}
const keyring = {
  key: 'keyring_0',
  index: 0,
  type: 'HD Key Tree',
  addressType: 9,
  accounts: [account],
  alianName: 'Savings',
  color: 'pink',
  hdPath: '',
}

// The slices type their actions with an index signature; destructured, they
// need no bracket access.
const { setCurrent: setCurrentAccount, setAccounts } = accountActions
const { setCurrent: setCurrentKeyring, setKeyrings } = keyringsActions
const { setUtxos } = transactionsActions
const { setBalanceHidden, updateFeeRateBar, updateTxCreateScreen } = uiActions
const { updateSettings } = settingsActions

/** A store holding a wallet, a send draft and changed preferences. */
function storeWithAWallet() {
  const store = createAppStore()
  store.dispatch(globalActions.update({ isReady: true, isBooted: true, isUnlocked: true }))
  store.dispatch(setCurrentAccount(account as any))
  store.dispatch(setAccounts([account as any]))
  store.dispatch(setKeyrings([keyring as any]))
  store.dispatch(setCurrentKeyring(keyring as any))
  store.dispatch(
    setUtxos({
      utxos: [{ txid: 'aa', vout: 0 } as any],
      chain: store.getState().settings.chainType,
      address: account.address,
    })
  )
  store.dispatch(
    updateTxCreateScreen({
      toInfo: { address: DRAFT_ADDRESS },
      inputAmount: '2',
      memo: 'rent',
    })
  )
  store.dispatch(updateFeeRateBar({ feeRate: 2, feeRateInputVal: '2' }))
  store.dispatch(setBalanceHidden(true))
  store.dispatch(
    updateSettings({
      locale: 'fr',
      themeMode: 'dark',
      autoLockTimeId: 6,
      developerMode: true,
      skippedVersion: '1.0.8',
    })
  )
  return store
}

describe('resetWalletState', () => {
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('returns every slice to its first-run state, keeping the language, the theme and the ready app', () => {
    const store = storeWithAWallet()

    store.dispatch(resetWalletState())

    const state = store.getState()
    expect(state.accounts).toEqual(accountsInitial)
    expect(state.keyrings).toEqual(keyringsInitial)
    expect(state.transactions).toEqual(transactionsInitial)
    expect(state.ui).toEqual(uiInitial)
    expect(state.global).toEqual({ ...globalInitial, isReady: true })
    expect(state.global.isBooted).toBe(false)
    expect(state.global.isUnlocked).toBe(false)
    expect(state.settings).toEqual({ ...settingsInitial, locale: 'fr', themeMode: 'dark' })
  })

  it('clears the account switcher totals, and drops the answers of the requests made before it', () => {
    const store = storeWithAWallet()
    const chainType = store.getState().settings.chainType
    const answer = (requestId: number) =>
      storeAccountTotals([
        {
          address: account.address,
          chainType,
          requestId,
          totalBalance: 5,
          readAt: 1,
          stale: false,
          settled: true,
        },
      ])
    store.dispatch(accountTotalsAsked(7))
    store.dispatch(answer(6))
    expect(store.getState().accounts.accountTotalsMap[chainType]?.[account.address]).toMatchObject({
      totalBalance: 5,
    })

    store.dispatch(resetWalletState())
    expect(store.getState().accounts.accountTotalsMap).toEqual({})

    // The answer of a request made before the reset, arriving after it.
    store.dispatch(answer(7))
    expect(store.getState().accounts.accountTotalsMap).toEqual({})

    // One made after it is stored.
    store.dispatch(answer(8))
    expect(store.getState().accounts.accountTotalsMap[chainType]?.[account.address]).toMatchObject({
      totalBalance: 5,
    })
  })

  it('resets the whole store in one dispatch, which a second one leaves as it is', () => {
    const store = storeWithAWallet()
    const notified: unknown[] = []
    store.subscribe(() => notified.push(store.getState()))

    store.dispatch(resetWalletState())
    const reset = store.getState()
    store.dispatch(resetWalletState())

    // One notification per dispatch: no render sees one slice reset and
    // another still holding the erased wallet.
    expect(notified).toHaveLength(2)
    expect(notified[0]).toBe(reset)
    expect(store.getState()).toEqual(reset)
  })

  it('saves only the display preferences, the initial ones after the reset, and never the send form', () => {
    vi.useFakeTimers()
    const store = storeWithAWallet()
    vi.advanceTimersByTime(1_100)
    expect(JSON.parse(localStorage.getItem(SAVED_UI_KEY)!)).toEqual({
      isBalanceHidden: true,
      balanceDetailOpen: false,
    })
    expect(store.getState().ui.sendFormScope).toEqual({
      address: account.address,
      chainType: settingsInitial.chainType,
    })

    store.dispatch(resetWalletState())
    vi.advanceTimersByTime(1_100)

    expect(JSON.parse(localStorage.getItem(SAVED_UI_KEY)!)).toEqual({
      isBalanceHidden: uiInitial.isBalanceHidden,
      balanceDetailOpen: uiInitial.balanceDetailOpen,
    })
    expect(localStorage.getItem(SAVED_UI_KEY)).not.toContain(DRAFT_ADDRESS)
    expect(store.getState().ui.sendFormScope).toBeNull()
    expect(createAppStore().getState().ui).toEqual(uiInitial)
  })
})
