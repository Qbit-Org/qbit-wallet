import { afterEach, describe, expect, it } from 'vitest'

import { createAppStore } from '../src'
import { initialState, uiActions } from '../src/reducers/ui'
import {
  RELEASES,
  readReleaseStorage,
} from '../../../tests/fixtures/release-storage/release-storage'

// Where redux-localstorage-simple keeps the persisted `ui` slice.
const SAVED_UI_KEY = 'redux_localstorage_simple_ui'

function loadStore(release: (typeof RELEASES)[number]) {
  const dump = readReleaseStorage(release)
  for (const [key, value] of Object.entries(dump.localStorage)) {
    localStorage.setItem(key, value)
  }
  const saved = JSON.parse(dump.localStorage[SAVED_UI_KEY]!)
  return { dump, saved, store: createAppStore() }
}

/** Every path to a value in `value`, such as `feeRateBar.feeRate`. */
function leafPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) =>
    item !== null && typeof item === 'object'
      ? leafPaths(item, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  )
}

afterEach(() => {
  localStorage.clear()
})

describe.each(RELEASES)('the ui state saved by %s', release => {
  it('loads with everything the release saved', () => {
    const { dump, saved, store } = loadStore(release)
    const { ui } = store.getState()

    expect(ui).toMatchObject(saved)
    expect(ui.uiTxCreateScreen.toInfo.address).toBe(dump.wallet.contacts[0]!.address)
    expect(ui.isBalanceHidden).toBe(true)
  })

  it('loads with every field this build reads', () => {
    const { store } = loadStore(release)
    const { ui } = store.getState()

    for (const path of leafPaths(initialState)) {
      const value = path.split('.').reduce<any>((item, key) => item?.[key], ui)
      expect(value, path).not.toBeUndefined()
    }
  })

  it('takes every ui change after loading', () => {
    const { store } = loadStore(release)

    store.dispatch(uiActions.updateAddressInput({ address: 'tq1typed' }))
    store.dispatch(uiActions.updateAmountInput({ amount: '1.5' }))
    store.dispatch(uiActions.updateTxCreateScreen({ inputAmount: '2', memo: 'after update' }))
    store.dispatch(uiActions.updateFeeRateBar({ feeRate: 9, feeOptionIndex: 2 }))
    store.dispatch(uiActions.setBalanceHidden(false))

    expect(store.getState().ui).toMatchObject({
      addressInput: { address: 'tq1typed' },
      amountInput: { amount: '1.5' },
      uiTxCreateScreen: { inputAmount: '2', memo: 'after update' },
      feeRateBar: { feeRate: 9, feeOptionIndex: 2, feeRateSource: null },
      isBalanceHidden: false,
    })
  })
})
