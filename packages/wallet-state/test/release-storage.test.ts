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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Where `saved` does not have the shape of `initial`, path by path: a field
 * the current state does not have, or a value of another type than the
 * initial one. A primitive may also be null. A field whose initial value is
 * null, such as feeRateBar.feeRateSource, may hold anything.
 */
function shapeProblems(saved: unknown, initial: unknown, path = 'ui'): string[] {
  if (initial === null) return []
  if (isObject(initial)) {
    if (!isObject(saved)) return [`${path} holds ${JSON.stringify(saved)}, not an object`]
    return Object.entries(saved).flatMap(([key, value]) =>
      Object.prototype.hasOwnProperty.call(initial, key)
        ? shapeProblems(value, initial[key], `${path}.${key}`)
        : [`${path}.${key} is not a field of the current ui state`]
    )
  }
  if (saved === null || typeof saved === typeof initial) return []
  return [`${path} holds ${JSON.stringify(saved)}, not a ${typeof initial}`]
}

afterEach(() => {
  localStorage.clear()
})

it('reports a saved field named like an Object.prototype member', () => {
  // JSON.parse keeps `__proto__` as an own field, as it would be stored.
  const saved = JSON.parse('{"constructor": null, "__proto__": {"polluted": true}}')

  expect(shapeProblems(saved, initialState)).toEqual([
    'ui.constructor is not a field of the current ui state',
    'ui.__proto__ is not a field of the current ui state',
  ])
})

describe.each(RELEASES)('the ui state saved by %s', release => {
  // A field this build renamed would still load, kept under its old name,
  // and the field under its new name would get its initial value. A field
  // whose type changed would load as saved, and reach reducers that expect
  // the new type.
  it('holds only fields this build still reads, of the types it reads', () => {
    const saved = JSON.parse(readReleaseStorage(release).localStorage[SAVED_UI_KEY]!)

    expect(shapeProblems(saved, initialState)).toEqual([])
  })

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

  // No captured ui state lacks addressInput or amountInput, so this cannot
  // reach the updateAddressInput crash that the fill on load prevents;
  // test/reducers/ui.test.ts covers that with states built by hand.
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
