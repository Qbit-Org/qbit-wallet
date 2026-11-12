import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../src'
import { initialState, uiActions } from '../src/reducers/ui'
import {
  CAPTURE_SEND_AMOUNT,
  FIRST_RELEASE_SAVING_PREFERENCES_ONLY,
  RELEASES,
  SAVED_UI_KEY,
  readReleaseStorage,
  releaseSavedUi,
  savedWholeUi,
} from '../../../tests/fixtures/release-storage/release-storage'

/**
 * What a release left in the extension origin's `localStorage` after the
 * capture's steps, and the contact's address that step 10 typed on its send
 * screen.
 */
interface LeftByRelease {
  release: string
  items: Record<string, string>
  contactAddress: string
}

function captured(release: (typeof RELEASES)[number]): LeftByRelease {
  const dump = readReleaseStorage(release)
  return { release, items: dump.localStorage, contactAddress: dump.wallet.contacts[0]!.address }
}

// The contact of every capture: the first testnet account of the public test
// phrase `abandon` x11 `about`.
const CONTACT_ADDRESS = 'tq1zzlm3x4dfumw7g298at7n7au9k02nup28llq9s5c4gez6qxx89wysy7hx66'

/**
 * What a release from 1.0.9 on leaves after the capture's steps, built here
 * as none is captured yet: the two display preferences alone, as such a
 * release saves nothing typed on the send screen. The balance card is
 * collapsed, unlike in the initial state, so that loading it shows.
 */
function preferencesOnly(release = FIRST_RELEASE_SAVING_PREFERENCES_ONLY): LeftByRelease {
  return {
    release,
    items: {
      i18nextLng: 'es',
      [SAVED_UI_KEY]: JSON.stringify({ isBalanceHidden: true, balanceDetailExpanded: false }),
      version_detail: JSON.stringify({ version: release }),
      themeMode: 'dark',
      userSelectedLanguage: 'true',
    },
    contactAddress: CONTACT_ADDRESS,
  }
}

function loadStore({ items }: LeftByRelease) {
  for (const [key, value] of Object.entries(items)) {
    localStorage.setItem(key, value)
  }
  return createAppStore()
}

/** Every path to a value in `value`, such as `feeRateBar.feeRate`. */
function leafPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) =>
    item !== null && typeof item === 'object'
      ? leafPaths(item, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  )
}

beforeEach(() => {
  // Fake, and never run: what a page leaves behind at once is checked.
  vi.useFakeTimers()
})

afterEach(() => {
  // A save still pending belongs to the test that scheduled it.
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('what each release saved of its ui state', () => {
  it('is the whole ui state for every release before 1.0.9, and the two preferences from 1.0.9', () => {
    // 1.0.5, 1.0.6 and 1.0.7 are captured: each must hold its send form.
    expect(['1.0.5', '1.0.6', '1.0.7', '1.0.8'].map(savedWholeUi)).toEqual([true, true, true, true])
    expect(['1.0.9', '1.0.10', '1.1.0', '2.0.0'].some(savedWholeUi)).toBe(false)
  })

  it('is told by a release version alone', () => {
    expect(() => savedWholeUi('v1.0.9')).toThrow('not a release version')
    expect(() => savedWholeUi('1.0')).toThrow('not a release version')
  })

  // What the capture refuses to write, and the tests to read.
  it.each([
    [
      'a release before 1.0.9 that holds the two preferences alone',
      preferencesOnly('1.0.7'),
      'does not hold the send form typed in step 10',
    ],
    [
      'a release before 1.0.9 with another send form',
      {
        ...preferencesOnly('1.0.8'),
        items: {
          [SAVED_UI_KEY]: JSON.stringify({
            uiTxCreateScreen: { toInfo: { address: CONTACT_ADDRESS }, inputAmount: '0.0002' },
            isBalanceHidden: true,
            balanceDetailExpanded: true,
          }),
        },
      },
      'does not hold the send form typed in step 10',
    ],
    [
      'a release from 1.0.9 that holds a send form',
      {
        ...preferencesOnly(),
        items: {
          [SAVED_UI_KEY]: JSON.stringify({
            uiTxCreateScreen: {
              toInfo: { address: CONTACT_ADDRESS },
              inputAmount: CAPTURE_SEND_AMOUNT,
            },
            isBalanceHidden: true,
            balanceDetailExpanded: true,
          }),
        },
      },
      'not the two display preferences alone',
    ],
    [
      'a release from 1.0.9 with a third field',
      {
        ...preferencesOnly('1.1.0'),
        items: {
          [SAVED_UI_KEY]:
            '{"isBalanceHidden":true,"balanceDetailExpanded":true,"navigationSource":1}',
        },
      },
      'not the two display preferences alone',
    ],
    [
      'balances that are not hidden',
      {
        ...preferencesOnly(),
        items: { [SAVED_UI_KEY]: '{"isBalanceHidden":false,"balanceDetailExpanded":true}' },
      },
      'does not hold the two preferences',
    ],
    [
      'a preference that is not a boolean',
      {
        ...preferencesOnly(),
        items: { [SAVED_UI_KEY]: '{"isBalanceHidden":true,"balanceDetailExpanded":"true"}' },
      },
      'does not hold the two preferences',
    ],
    ['nothing saved', { ...preferencesOnly(), items: {} }, 'is missing'],
    ['no JSON', { ...preferencesOnly(), items: { [SAVED_UI_KEY]: '{' } }, 'is not JSON'],
    [
      'no JSON object',
      { ...preferencesOnly('1.0.7'), items: { [SAVED_UI_KEY]: '[true,true]' } },
      'is not a JSON object',
    ],
  ])('refuses %s', (_, left, error) => {
    expect(() => releaseSavedUi(left.release, left.items, left.contactAddress)).toThrow(error)
  })
})

// Each capture, and a release from 1.0.9 on built here, as none is captured
// yet. A release is taken as one that saved its whole ui state, or not, from
// its version alone (savedWholeUi), never from what its capture holds.
const LEFT_BY: [string, () => LeftByRelease][] = [
  ...RELEASES.map((release): [string, () => LeftByRelease] => [release, () => captured(release)]),
  [`${FIRST_RELEASE_SAVING_PREFERENCES_ONLY}, built here`, () => preferencesOnly()],
]

describe.each(LEFT_BY)('the ui state saved by %s', (_, leftByRelease) => {
  it('holds the send form step 10 typed up to 1.0.8, and the two preferences alone from 1.0.9', () => {
    const left = leftByRelease()
    const saved = releaseSavedUi(left.release, left.items, left.contactAddress)

    expect(saved.stored).toBe(left.items[SAVED_UI_KEY])
    expect(saved.sendForm).toEqual(
      savedWholeUi(left.release)
        ? { address: left.contactAddress, amount: CAPTURE_SEND_AMOUNT }
        : null
    )
    // Step 10 hid the balances.
    expect(saved.preferences.isBalanceHidden).toBe(true)
  })

  it('loads with its display preferences and none of its send form', () => {
    const left = leftByRelease()
    const { preferences } = releaseSavedUi(left.release, left.items, left.contactAddress)
    const { ui } = loadStore(left).getState()

    expect(ui).toEqual({ ...initialState, ...preferences })
    expect(ui.uiTxCreateScreen).toEqual(initialState.uiTxCreateScreen)
    // The capture hid the balances: that carries over.
    expect(ui.isBalanceHidden).toBe(true)
  })

  it('is replaced on disk with the two preferences alone up to 1.0.8, and left as it is from 1.0.9, as the store is made', () => {
    const left = leftByRelease()
    const saved = releaseSavedUi(left.release, left.items, left.contactAddress)
    for (const [key, value] of Object.entries(left.items)) localStorage.setItem(key, value)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')

    createAppStore()

    // No timer has run.
    expect(localStorage.getItem(SAVED_UI_KEY)).toBe(JSON.stringify(saved.preferences))
    expect(setItem.mock.calls).toEqual(
      savedWholeUi(left.release) ? [[SAVED_UI_KEY, JSON.stringify(saved.preferences)]] : []
    )
    expect(removeItem).not.toHaveBeenCalled()
    const everything = Object.values({ ...localStorage }).join('\n')
    expect(everything).not.toContain(left.contactAddress)
    expect(everything).not.toContain('uiTxCreateScreen')
    expect(everything).not.toContain('feeRateBar')
    // The release's other keys stay as they were.
    for (const [key, value] of Object.entries(left.items)) {
      if (key !== SAVED_UI_KEY) expect(localStorage.getItem(key), key).toBe(value)
    }
  })

  it('loads with every field this build reads', () => {
    const { ui } = loadStore(leftByRelease()).getState()

    for (const path of leafPaths(initialState)) {
      const value = path.split('.').reduce<any>((item, key) => item?.[key], ui)
      expect(value, path).not.toBeUndefined()
    }
  })

  it('takes every ui change after loading, and saves only the preferences', () => {
    const store = loadStore(leftByRelease())

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
    vi.runOnlyPendingTimers()
    expect(JSON.parse(localStorage.getItem(SAVED_UI_KEY)!)).toEqual({
      isBalanceHidden: false,
      balanceDetailExpanded: store.getState().ui.balanceDetailExpanded,
    })
  })
})
