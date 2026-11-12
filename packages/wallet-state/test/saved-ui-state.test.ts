import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyringType } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { createAppStore } from '../src'
import { accountActions } from '../src/reducers/accounts'
import { globalActions } from '../src/reducers/global'
import { settingsActions } from '../src/reducers/settings'
import { initialState, uiActions } from '../src/reducers/ui'
import { NavigationSource } from '../src/types'

// Where the ui state's saved part has always been kept: preferences saved by
// earlier builds load from here.
const SAVED_UI_KEY = 'redux_localstorage_simple_ui'
// The debounce of the save: a change is written this long after it.
const SAVE_DELAY_MS = 1000

const RECIPIENT = 'tq1zdraftrecipient'
const TYPED_ADDRESS = 'tq1ztypedaddress'
const MEMO = 'rent for november'

const account = (address: string) => ({
  type: KeyringType.QbitHdKeyring,
  address,
  brandName: 'Qbit',
  alianName: address,
  displayBrandName: 'Qbit',
  index: 0,
  balance: 0,
  pubkey: `pubkey-${address}`,
  key: `key-${address}`,
  flag: 0,
})

/** The saved value, parsed; undefined when nothing is saved. */
function savedValue(): unknown {
  const stored = localStorage.getItem(SAVED_UI_KEY)
  return stored === null ? undefined : JSON.parse(stored)
}

/** Every value in localStorage, under every key, as one text. */
function everythingStored(): string {
  return Object.keys(localStorage)
    .map(key => `${key}=${localStorage.getItem(key)}`)
    .join('\n')
}

/** What a user leaves in the send form: every field of it, and the fee bar's. */
function fillSendForm(store: ReturnType<typeof createAppStore>): void {
  store.dispatch(
    uiActions.updateTxCreateScreen({
      toInfo: { address: RECIPIENT },
      inputAmount: '0.5',
      enableRBF: false,
      memo: MEMO,
    })
  )
  store.dispatch(
    uiActions.updateFeeRateBar({
      feeRate: 3.5,
      feeRateInputVal: '3.5',
      enableLowFeeRate: true,
      feeOptionIndex: 3,
      showCustomInput: true,
    })
  )
  store.dispatch(uiActions.updateAddressInput({ address: TYPED_ADDRESS }))
  store.dispatch(uiActions.updateAmountInput({ amount: '1.25' }))
  store.dispatch(uiActions.setNavigationSource(NavigationSource.BACK))
}

const DRAFT_TEXTS = [RECIPIENT, TYPED_ADDRESS, MEMO, '0.5', '3.5', '1.25']

function expectNoDraftStored(): void {
  const stored = everythingStored()
  for (const text of DRAFT_TEXTS) expect(stored).not.toContain(text)
  for (const field of [
    'uiTxCreateScreen',
    'feeRateBar',
    'addressInput',
    'amountInput',
    'navigationSource',
    'sendFormScope',
  ]) {
    expect(stored).not.toContain(field)
  }
}

/** The ui state saved by 1.0.7 with a send form left filled in (the release fixture's shape). */
const savedByEarlierBuild = (preferences: {
  isBalanceHidden: boolean
  balanceDetailExpanded: boolean
}) =>
  JSON.stringify({
    uiTxCreateScreen: {
      toInfo: { address: RECIPIENT },
      inputAmount: '0.5',
      enableRBF: false,
      memo: MEMO,
    },
    addressInput: { address: TYPED_ADDRESS },
    amountInput: { amount: '1.25' },
    feeRateBar: {
      feeRate: 3.5,
      feeRateInputVal: '3.5',
      enableLowFeeRate: false,
      feeOptionIndex: 3,
      showCustomInput: true,
      feeRateSource: null,
    },
    navigationSource: 1,
    ...preferences,
  })

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  // A save still pending belongs to the test that scheduled it.
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('what a wallet page saves', () => {
  it('handles every ui action in these tests', () => {
    // A ui action added later must be added to the test below too.
    expect(Object.keys(uiActions).sort()).toEqual(
      [
        'reset',
        'resetAddressInput',
        'resetAmountInput',
        'resetFeeRateBar',
        'resetTxCreateScreen',
        'setBalanceDetailExpanded',
        'setBalanceHidden',
        'setNavigationSource',
        'updateAddressInput',
        'updateAmountInput',
        'updateFeeRateBar',
        'updateTxCreateScreen',
      ].sort()
    )
  })

  it('writes only the two display preferences, whatever ui action ran', () => {
    const store = createAppStore()
    store.dispatch(accountActions.setCurrent(account('tq1zaccount')))
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))

    fillSendForm(store)
    store.dispatch(uiActions.setBalanceHidden(true))
    store.dispatch(uiActions.setBalanceDetailExpanded(false))
    // Before the save and after it, nothing of the form is stored.
    expectNoDraftStored()
    vi.advanceTimersByTime(SAVE_DELAY_MS)

    expect(localStorage.getItem(SAVED_UI_KEY)).toBe(
      '{"isBalanceHidden":true,"balanceDetailExpanded":false}'
    )
    expect(Object.keys(localStorage)).toEqual([SAVED_UI_KEY])
    expectNoDraftStored()

    // The resets, and a preference changed after them: still only the two.
    for (const reset of [
      uiActions.resetTxCreateScreen(),
      uiActions.resetFeeRateBar(),
      uiActions.resetAddressInput(),
      uiActions.resetAmountInput(),
    ]) {
      fillSendForm(store)
      store.dispatch(reset)
    }
    store.dispatch(uiActions.setBalanceHidden(false))
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(savedValue()).toEqual({ isBalanceHidden: false, balanceDetailExpanded: false })
    expectNoDraftStored()

    fillSendForm(store)
    store.dispatch(uiActions.reset())
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(savedValue()).toEqual({ isBalanceHidden: false, balanceDetailExpanded: true })
    expectNoDraftStored()
  })

  it('keeps the form only in the page: a new page opens with none of it', () => {
    const page = createAppStore()
    fillSendForm(page)
    page.dispatch(uiActions.setBalanceHidden(true))
    vi.advanceTimersByTime(SAVE_DELAY_MS)

    const reopened = createAppStore()

    expect(reopened.getState().ui).toEqual({ ...initialState, isBalanceHidden: true })
  })

  it('writes nothing for actions that change no preference', () => {
    const store = createAppStore()
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    fillSendForm(store)
    store.dispatch(globalActions.update({ isUnlocked: true }))
    store.dispatch(accountActions.setCurrent(account('tq1zaccount')))
    // Setting a preference to the value it has is no change either.
    store.dispatch(uiActions.setBalanceHidden(false))
    vi.advanceTimersByTime(SAVE_DELAY_MS * 5)

    expect(localStorage.getItem(SAVED_UI_KEY)).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('saves a second after the last change, as before', () => {
    const store = createAppStore()
    store.dispatch(uiActions.setBalanceHidden(true))
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1)
    expect(localStorage.getItem(SAVED_UI_KEY)).toBeNull()

    vi.advanceTimersByTime(1)

    expect(savedValue()).toEqual({ isBalanceHidden: true, balanceDetailExpanded: true })
  })
})

describe('preferences across page loads', () => {
  it.each([
    { isBalanceHidden: true, balanceDetailExpanded: true },
    { isBalanceHidden: true, balanceDetailExpanded: false },
    { isBalanceHidden: false, balanceDetailExpanded: true },
    { isBalanceHidden: false, balanceDetailExpanded: false },
  ])('keeps %o set in one page for the next', preferences => {
    // Saved the other way round first, so that every value is a change.
    localStorage.setItem(
      SAVED_UI_KEY,
      JSON.stringify({
        isBalanceHidden: !preferences.isBalanceHidden,
        balanceDetailExpanded: !preferences.balanceDetailExpanded,
      })
    )
    const first = createAppStore()
    first.dispatch(uiActions.setBalanceHidden(preferences.isBalanceHidden))
    first.dispatch(uiActions.setBalanceDetailExpanded(preferences.balanceDetailExpanded))
    vi.advanceTimersByTime(SAVE_DELAY_MS)

    const second = createAppStore()

    expect(second.getState().ui).toMatchObject(preferences)
    expect(savedValue()).toEqual(preferences)
  })

  it('loads preferences an earlier build saved alone', () => {
    localStorage.setItem(SAVED_UI_KEY, '{"isBalanceHidden":true,"balanceDetailExpanded":false}')

    const store = createAppStore()

    expect(store.getState().ui).toEqual({
      ...initialState,
      isBalanceHidden: true,
      balanceDetailExpanded: false,
    })
  })

  it('leaves preferences saved alone as they are', () => {
    const stored = '{"isBalanceHidden":true,"balanceDetailExpanded":false}'
    localStorage.setItem(SAVED_UI_KEY, stored)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')

    createAppStore()

    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(localStorage.getItem(SAVED_UI_KEY)).toBe(stored)
  })

  it('writes nothing at the start when nothing is saved', () => {
    createAppStore()

    expect(localStorage.getItem(SAVED_UI_KEY)).toBeNull()
  })

  it('starts with the initial preferences when localStorage is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })

    const store = createAppStore()
    store.dispatch(uiActions.setBalanceHidden(true))
    vi.advanceTimersByTime(SAVE_DELAY_MS)

    expect(store.getState().ui).toEqual({ ...initialState, isBalanceHidden: true })
    expect(setItem).toHaveBeenCalled()
  })
})

describe('a ui state saved by an earlier build, with a send form in it', () => {
  it.each([
    { isBalanceHidden: true, balanceDetailExpanded: false },
    { isBalanceHidden: false, balanceDetailExpanded: true },
  ])('loads its preferences %o and none of the form', preferences => {
    localStorage.setItem(SAVED_UI_KEY, savedByEarlierBuild(preferences))

    const store = createAppStore()

    expect(store.getState().ui).toEqual({ ...initialState, ...preferences })
  })

  it('is removed when it cannot be replaced, and its preferences still load', () => {
    localStorage.setItem(
      SAVED_UI_KEY,
      savedByEarlierBuild({ isBalanceHidden: true, balanceDetailExpanded: false })
    )
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    const store = createAppStore()

    expect(localStorage.getItem(SAVED_UI_KEY)).toBeNull()
    expectNoDraftStored()
    expect(store.getState().ui).toEqual({
      ...initialState,
      isBalanceHidden: true,
      balanceDetailExpanded: false,
    })
  })

  it('still makes the store when it can be neither replaced nor removed', () => {
    localStorage.setItem(
      SAVED_UI_KEY,
      savedByEarlierBuild({ isBalanceHidden: true, balanceDetailExpanded: false })
    )
    for (const method of ['setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      })
    }

    const store = createAppStore()

    expect(store.getState().ui).toEqual({
      ...initialState,
      isBalanceHidden: true,
      balanceDetailExpanded: false,
    })
  })

  it('is replaced with the preferences alone before any timer runs', () => {
    localStorage.setItem(
      SAVED_UI_KEY,
      savedByEarlierBuild({ isBalanceHidden: true, balanceDetailExpanded: false })
    )

    createAppStore()

    // The timers are fake and none has been run: this is what a popup closed
    // now leaves behind.
    expect(localStorage.getItem(SAVED_UI_KEY)).toBe(
      '{"isBalanceHidden":true,"balanceDetailExpanded":false}'
    )
    expectNoDraftStored()
  })
})

describe('a saved value that is not a ui state', () => {
  const INITIAL_PREFERENCES = '{"isBalanceHidden":false,"balanceDetailExpanded":true}'

  it.each([
    ['text that is no JSON', '{"isBalanceHidden":true,'],
    ['an empty text', ''],
    ['JSON null', 'null'],
    ['a number', '42'],
    ['false', 'false'],
    ['a string', '"isBalanceHidden"'],
    ['an array', '[true,false]'],
  ])('is replaced with the initial preferences when it is %s', (_, stored) => {
    localStorage.setItem(SAVED_UI_KEY, stored)

    const store = createAppStore()

    expect(store.getState().ui).toEqual(initialState)
    expect(localStorage.getItem(SAVED_UI_KEY)).toBe(INITIAL_PREFERENCES)
  })

  it.each([
    [
      { isBalanceHidden: 'true', balanceDetailExpanded: false },
      { isBalanceHidden: false, balanceDetailExpanded: false },
    ],
    [
      { isBalanceHidden: true, balanceDetailExpanded: 0 },
      { isBalanceHidden: true, balanceDetailExpanded: true },
    ],
    [
      { isBalanceHidden: null, balanceDetailExpanded: {} },
      { isBalanceHidden: false, balanceDetailExpanded: true },
    ],
    [
      { isBalanceHidden: 1, balanceDetailExpanded: [false] },
      { isBalanceHidden: false, balanceDetailExpanded: true },
    ],
    [{ balanceDetailExpanded: false }, { isBalanceHidden: false, balanceDetailExpanded: false }],
  ])('gives a preference of another type its initial value: %o', (saved, loaded) => {
    localStorage.setItem(SAVED_UI_KEY, JSON.stringify(saved))

    const store = createAppStore()

    expect(store.getState().ui).toEqual({ ...initialState, ...loaded })
    expect(savedValue()).toEqual(loaded)
  })

  it('drops fields that are not preferences', () => {
    localStorage.setItem(
      SAVED_UI_KEY,
      JSON.stringify({ isBalanceHidden: true, balanceDetailExpanded: false, theme: 'dark', x: 1 })
    )

    const store = createAppStore()

    expect(store.getState().ui).toEqual({
      ...initialState,
      isBalanceHidden: true,
      balanceDetailExpanded: false,
    })
    expect(localStorage.getItem(SAVED_UI_KEY)).toBe(
      '{"isBalanceHidden":true,"balanceDetailExpanded":false}'
    )
  })

  it('takes no preference from, and keeps no, field named like an Object.prototype member', () => {
    // As stored: JSON.parse keeps `__proto__` as an own field.
    localStorage.setItem(
      SAVED_UI_KEY,
      '{"__proto__":{"isBalanceHidden":true,"polluted":true},' +
        '"constructor":{"prototype":{"polluted":true}},"balanceDetailExpanded":false}'
    )

    const store = createAppStore()

    const { ui } = store.getState()
    expect(ui).toEqual({ ...initialState, balanceDetailExpanded: false })
    expect(Object.prototype.hasOwnProperty.call(ui, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(ui)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(localStorage.getItem(SAVED_UI_KEY)).toBe(
      '{"isBalanceHidden":false,"balanceDetailExpanded":false}'
    )
  })

  it('reads a preference only from the saved value itself, not from what it inherits', () => {
    localStorage.setItem(SAVED_UI_KEY, '{"balanceDetailExpanded":false}')
    // Not enumerable, so that it reaches only lookups, as a polluted
    // prototype's member would, and no loop over keys.
    Object.defineProperty(Object.prototype, 'isBalanceHidden', {
      value: true,
      configurable: true,
      writable: true,
    })
    try {
      const store = createAppStore()

      expect(store.getState().ui.isBalanceHidden).toBe(false)
      expect(localStorage.getItem(SAVED_UI_KEY)).toBe(
        '{"isBalanceHidden":false,"balanceDetailExpanded":false}'
      )
    } finally {
      delete (Object.prototype as Record<string, unknown>).isBalanceHidden
    }
  })
})

describe('two pages open at once', () => {
  // Each page saves on its own timer in the browser; here the pages share
  // one, so each step lets the save it scheduled run before the next.
  it('does not put back a preference another page changed, unless it changes one itself', () => {
    const popup = createAppStore()
    const tab = createAppStore()

    popup.dispatch(uiActions.setBalanceHidden(true))
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(savedValue()).toEqual({ isBalanceHidden: true, balanceDetailExpanded: true })

    // The tab, which still shows balances, works on: its actions save nothing.
    fillSendForm(tab)
    tab.dispatch(accountActions.setCurrent(account('tq1zaccount')))
    tab.dispatch(globalActions.update({ isUnlocked: true }))
    vi.advanceTimersByTime(SAVE_DELAY_MS * 5)
    expect(savedValue()).toEqual({ isBalanceHidden: true, balanceDetailExpanded: true })
    expect(createAppStore().getState().ui.isBalanceHidden).toBe(true)

    // A preference changed in the tab saves the tab's two, its older one too.
    tab.dispatch(uiActions.setBalanceDetailExpanded(false))
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(savedValue()).toEqual({ isBalanceHidden: false, balanceDetailExpanded: false })
  })
})
