import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUS_METHODS, KeyringType } from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { updateVersion } from '../src/actions/global'
import { createAppStore } from '../src'
import {
  useCurrentAddress,
  useReloadAccounts,
  useSetCurrentAccountCallback,
} from '../src/hooks/accounts'
import { useChainType, useChangeChainTypeCallback } from '../src/hooks/settings'
import { useFeeRateBar, useUiTxCreateScreen } from '../src/hooks/ui'
import { accountActions } from '../src/reducers/accounts'
import { globalActions } from '../src/reducers/global'
import { keyringsActions } from '../src/reducers/keyrings'
import { settingsActions } from '../src/reducers/settings'
import { transactionsActions } from '../src/reducers/transactions'
import { initialState, scopeSendForm, uiActions, type UIState } from '../src/reducers/ui'
import { AccountUpdater } from '../src/updater/accounts'
import { uiEventBus } from '../src/utils/eventBus'
import { createHookTestHarness, createWalletMock } from './ui-hooks/testHelpers'

type Store = ReturnType<typeof createAppStore>
type State = ReturnType<Store['getState']>

const account = (address: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
})

// One account and another, on Testnet4, and the first one's Mainnet address.
const FIRST = account('tq1zfirst')
const SECOND = account('tq1zsecond')
const FIRST_ON_MAINNET = account('qb1zfirst', { key: FIRST.key, pubkey: FIRST.pubkey })

const keyring = (accounts: ReturnType<typeof account>[]) => ({
  key: 'keyring-1',
  index: 0,
  type: KeyringType.QbitHdKeyring,
  addressType: AddressType.P2MR,
  accounts,
  alianName: 'Wallet 1',
  hdPath: '',
})

/** The send form's four parts, as the store holds them. */
function sendForm(state: { ui: UIState }) {
  const { uiTxCreateScreen, feeRateBar, addressInput, amountInput } = state.ui
  return { uiTxCreateScreen, feeRateBar, addressInput, amountInput }
}

const INITIAL_FORM = sendForm({ ui: initialState })

const FILLED_FORM = {
  uiTxCreateScreen: {
    toInfo: { address: 'tq1zrecipient' },
    inputAmount: '0.5',
    enableRBF: false,
    memo: 'rent',
  },
  feeRateBar: {
    feeRate: 3.5,
    feeRateInputVal: '3.5',
    enableLowFeeRate: true,
    feeOptionIndex: 3,
    showCustomInput: true,
    feeRateSource: null,
  },
  addressInput: { address: 'tq1ztyped' },
  amountInput: { amount: '1.25' },
}

/** What a user leaves in the send form. */
function fillSendForm(store: Store): void {
  store.dispatch(uiActions.updateTxCreateScreen(FILLED_FORM.uiTxCreateScreen))
  store.dispatch(uiActions.updateFeeRateBar(FILLED_FORM.feeRateBar))
  store.dispatch(uiActions.updateAddressInput(FILLED_FORM.addressInput))
  store.dispatch(uiActions.updateAmountInput(FILLED_FORM.amountInput))
  expect(sendForm(store.getState())).toEqual(FILLED_FORM)
}

/** A page's store with the first account on Testnet4 selected, and the send form filled in. */
function pageWithFilledForm(): Store {
  const store = createAppStore()
  store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
  store.dispatch(accountActions.setCurrent(FIRST))
  fillSendForm(store)
  return store
}

const scopeOf = (state: State) => ({
  address: state.accounts.current.address,
  chainType: state.settings.chainType,
})

/**
 * Every state the store's subscribers are told of from now on, with the
 * account and network selected in it.
 */
function watch(store: Store) {
  const seen: Array<{ address: string; chainType: ChainType; form: ReturnType<typeof sendForm> }> =
    []
  const unsubscribe = store.subscribe(() => {
    const state = store.getState()
    seen.push({ ...scopeOf(state), form: sendForm(state) })
  })
  return { seen, unsubscribe }
}

/** No state told of shows an account and network other than the first ones with the form filled in. */
function expectNoMix(seen: ReturnType<typeof watch>['seen']): void {
  for (const state of seen) {
    const first = state.address === FIRST.address && state.chainType === ChainType.QBIT_TESTNET4
    if (state.address && !first) expect(state.form).toEqual(INITIAL_FORM)
  }
}

/** A background for AccountUpdater and the account and network hooks, selecting `selection`. */
function background(selection: { account: ReturnType<typeof account>; chainType: ChainType }) {
  return {
    ...createWalletMock(),
    getKeyrings: vi.fn(async () => [keyring([selection.account])]),
    getCurrentKeyring: vi.fn(async () => keyring([selection.account])),
    getAccounts: vi.fn(async () => [selection.account]),
    getCurrentAccount: vi.fn(async () => selection.account),
    getWalletConfig: vi.fn(async () => ({})),
    getAddressSummary: vi.fn(async () => ({})),
    getAddressBalanceV2: vi.fn(async () => ({
      availableBalance: 0,
      unavailableBalance: 0,
      totalBalance: 0,
      chainType: selection.chainType,
    })),
    setChainType: vi.fn(async (chainType: ChainType) => {
      selection.chainType = chainType
    }),
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  // A save a test scheduled on fake timers runs within that test.
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  }
  localStorage.clear()
})

describe('the send form when the account or network changes', () => {
  it('records the first account and network without clearing anything', () => {
    const store = createAppStore()
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    expect(store.getState().ui.sendFormScope).toBeNull()

    store.dispatch(accountActions.setCurrent(FIRST))

    expect(store.getState().ui.sendFormScope).toEqual({
      address: FIRST.address,
      chainType: ChainType.QBIT_TESTNET4,
    })
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
  })

  it('clears the form, the fee bar and the inputs when another account is selected', () => {
    const store = pageWithFilledForm()

    store.dispatch(accountActions.setCurrent(SECOND))

    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
    expect(store.getState().ui.sendFormScope).toEqual({
      address: SECOND.address,
      chainType: ChainType.QBIT_TESTNET4,
    })
  })

  it('clears the form when the network changes', () => {
    const store = pageWithFilledForm()

    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))

    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
    expect(store.getState().ui.sendFormScope).toEqual({
      address: FIRST.address,
      chainType: ChainType.QBIT_MAINNET,
    })
  })

  it('clears the form when the settings are reset to another network', () => {
    const store = pageWithFilledForm()

    store.dispatch(settingsActions.reset())

    expect(store.getState().settings.chainType).toBe(ChainType.QBIT_MAINNET)
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
  })

  it('clears the form for another account selected after the accounts were reset', () => {
    const store = pageWithFilledForm()

    store.dispatch(accountActions.reset())
    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
    store.dispatch(accountActions.setCurrent(SECOND))

    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
  })

  it('keeps what is typed for the new account afterwards', () => {
    const store = pageWithFilledForm()
    store.dispatch(accountActions.setCurrent(SECOND))

    fillSendForm(store)
    store.dispatch(accountActions.setCurrent({ ...SECOND, balance: 10 }))

    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
  })

  it('clears it for a switch in another window that reaches this page', async () => {
    const selection = { account: FIRST, chainType: ChainType.QBIT_TESTNET4 }
    const wallet = background(selection)
    const store = pageWithFilledForm()
    store.dispatch(globalActions.update({ isUnlocked: true }))
    const { wrapper } = createHookTestHarness({ wallet, store })
    renderHook(() => AccountUpdater(), { wrapper })
    await waitFor(() => expect(wallet.getCurrentAccount).toHaveBeenCalled())
    expect(sendForm(store.getState())).toEqual(FILLED_FORM)

    selection.account = SECOND
    act(() => {
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, SECOND)
    })
    expect(store.getState().accounts.current.address).toBe(SECOND.address)
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)

    fillSendForm(store)
    selection.chainType = ChainType.QBIT_MAINNET
    selection.account = FIRST_ON_MAINNET
    act(() => {
      uiEventBus.emit(BUS_METHODS.CHAIN_CHANGED, { type: ChainType.QBIT_MAINNET })
    })
    expect(store.getState().settings.chainType).toBe(ChainType.QBIT_MAINNET)
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
    await waitFor(() =>
      expect(store.getState().accounts.current.address).toBe(FIRST_ON_MAINNET.address)
    )
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
  })

  it('clears it for a switch made in this page', async () => {
    const selection = { account: FIRST, chainType: ChainType.QBIT_TESTNET4 }
    const wallet = background(selection)
    const store = pageWithFilledForm()
    const { wrapper } = createHookTestHarness({ wallet, store })
    const { result } = renderHook(
      () => ({
        setCurrentAccount: useSetCurrentAccountCallback(),
        changeChainType: useChangeChainTypeCallback(),
      }),
      { wrapper }
    )

    act(() => {
      result.current.setCurrentAccount(SECOND)
    })
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)

    fillSendForm(store)
    await act(async () => {
      await result.current.changeChainType(ChainType.QBIT_MAINNET)
    })
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
  })
})

describe('the send form while the account and network stay the same', () => {
  it('stays through a lock and an unlock', async () => {
    const selection = { account: FIRST, chainType: ChainType.QBIT_TESTNET4 }
    const wallet = background(selection)
    const store = pageWithFilledForm()
    store.dispatch(globalActions.update({ isUnlocked: true }))
    const { wrapper } = createHookTestHarness({ wallet, store })
    renderHook(() => AccountUpdater(), { wrapper })
    await waitFor(() => expect(wallet.getCurrentAccount).toHaveBeenCalled())

    act(() => {
      uiEventBus.emit(BUS_METHODS.LOCKED)
    })
    expect(store.getState().global.isUnlocked).toBe(false)
    act(() => {
      uiEventBus.emit(BUS_METHODS.UNLOCKED)
    })
    expect(store.getState().global.isUnlocked).toBe(true)
    await act(async () => undefined)

    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
  })

  it('stays when the accounts are read again and find the same account', async () => {
    const selection = {
      account: { ...FIRST, balance: 42, flag: 1 },
      chainType: ChainType.QBIT_TESTNET4,
    }
    const wallet = background(selection)
    const store = pageWithFilledForm()
    const { wrapper } = createHookTestHarness({ wallet, store })
    const { result } = renderHook(() => useReloadAccounts(), { wrapper })

    await act(async () => {
      await result.current()
    })

    expect(store.getState().accounts.current).toEqual(selection.account)
    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
  })

  it('stays through the actions that update the selected account in place', () => {
    const store = pageWithFilledForm()

    store.dispatch(accountActions.setCurrent({ ...FIRST, alianName: 'Renamed', balance: 7 }))
    store.dispatch(accountActions.setCurrentAccountName('Renamed again'))
    store.dispatch(accountActions.setCurrentAddressFlag(2))
    store.dispatch(accountActions.updateAccountName({ ...FIRST, alianName: 'Third name' }))
    store.dispatch(accountActions.setAccounts([FIRST, SECOND]))

    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
  })

  it('stays through a keyring reload', () => {
    const store = pageWithFilledForm()

    store.dispatch(keyringsActions.setKeyrings([keyring([FIRST, SECOND])]))
    store.dispatch(keyringsActions.setCurrent(keyring([FIRST, SECOND])))
    store.dispatch(keyringsActions.setCurrent(keyring([FIRST])))

    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
  })

  it('stays when the store passes through no account and comes back to the same one', () => {
    const store = pageWithFilledForm()

    store.dispatch(accountActions.setCurrent(undefined as never))
    expect(store.getState().accounts.current.address).toBe('')
    store.dispatch(accountActions.setCurrent(FIRST))
    store.dispatch(accountActions.reset())
    // With no account, the network can come and go as well.
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    store.dispatch(accountActions.setCurrent(FIRST))

    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
    expect(store.getState().ui.sendFormScope).toEqual({
      address: FIRST.address,
      chainType: ChainType.QBIT_TESTNET4,
    })
  })

  it('stays through every other action of every slice', () => {
    // The preferences changed below are saved a second later.
    vi.useFakeTimers()
    const store = pageWithFilledForm()

    for (const action of [
      updateVersion(),
      settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }),
      settingsActions.updateSettings({
        locale: 'es',
        walletConfig: { version: '', statusMessage: '', chainTip: '', disableUtxoTools: true },
        skippedVersion: '1.0.9',
        autoLockTimeId: 3,
        developerMode: true,
      }),
      globalActions.update({ isReady: true, isBooted: true, tab: 'home' }),
      globalActions.reset(),
      accountActions.pendingLogin(),
      accountActions.rejectLogin(),
      accountActions.setAddressSummary({ address: FIRST.address, totalSatoshis: 1 }),
      accountActions.setBalanceV2({
        address: FIRST.address,
        balance: {
          availableBalance: 1,
          unavailableBalance: 0,
          totalBalance: 1,
          chainType: ChainType.QBIT_TESTNET4,
        },
        requestId: 1,
      }),
      accountActions.setBalanceError({ address: FIRST.address, requestId: 2 }),
      accountActions.setHistory({ address: FIRST.address, list: [], total: 0 }),
      accountActions.setHistoryError({ address: FIRST.address }),
      accountActions.expireHistory(),
      transactionsActions.setUtxos({
        address: FIRST.address,
        chain: ChainType.QBIT_TESTNET4,
        utxos: [],
      }),
      uiActions.setNavigationSource(0),
      uiActions.setBalanceHidden(true),
      uiActions.setBalanceDetailExpanded(false),
    ]) {
      store.dispatch(action)
      expect(sendForm(store.getState()), action.type).toEqual(FILLED_FORM)
    }
  })

  it('stays from the page start, in the order the page loads its account and network', async () => {
    const selection = { account: FIRST, chainType: ChainType.QBIT_TESTNET4 }
    const wallet = background(selection)
    const store = createAppStore()

    // MainRoute's start: the account first, while the network is still the
    // store's initial Mainnet, then the network and the other settings.
    store.dispatch(accountActions.setCurrent(FIRST))
    store.dispatch(accountActions.setAccounts([FIRST]))
    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    store.dispatch(settingsActions.updateSettings({ locale: 'en' }))
    store.dispatch(globalActions.update({ isReady: true }))
    store.dispatch(globalActions.update({ isBooted: true }))
    store.dispatch(globalActions.update({ isUnlocked: true }))
    // The placeholder network gave way to the real one before any screen
    // showed the form: it has its initial values, the very same objects.
    expect(sendForm(store.getState())).toEqual(INITIAL_FORM)
    expect(store.getState().ui.uiTxCreateScreen).toBe(initialState.uiTxCreateScreen)
    expect(store.getState().ui.feeRateBar).toBe(initialState.feeRateBar)

    fillSendForm(store)
    // AccountUpdater reads the accounts again once the page is unlocked.
    const { wrapper } = createHookTestHarness({ wallet, store })
    renderHook(() => AccountUpdater(), { wrapper })
    await waitFor(() => expect(wallet.getWalletConfig).toHaveBeenCalled())
    await act(async () => undefined)

    expect(store.getState().accounts.current).toEqual(FIRST)
    expect(sendForm(store.getState())).toEqual(FILLED_FORM)
  })
})

describe('what readers of the store see of a switch', () => {
  it('never the new account with the old form', () => {
    const store = pageWithFilledForm()
    const { seen, unsubscribe } = watch(store)

    store.dispatch(accountActions.setCurrent(SECOND))
    unsubscribe()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      address: SECOND.address,
      chainType: ChainType.QBIT_TESTNET4,
      form: INITIAL_FORM,
    })
  })

  it('never the new network with the old form', () => {
    const store = pageWithFilledForm()
    const { seen, unsubscribe } = watch(store)

    store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_MAINNET }))
    store.dispatch(accountActions.setCurrent(FIRST_ON_MAINNET))
    unsubscribe()

    expect(seen).toHaveLength(2)
    expectNoMix(seen)
  })

  it('never the new account with the old form after the store had no account', () => {
    const store = pageWithFilledForm()
    const { seen, unsubscribe } = watch(store)

    store.dispatch(accountActions.reset())
    store.dispatch(accountActions.setCurrent(SECOND))
    unsubscribe()

    expect(seen.map(state => state.address)).toEqual(['', SECOND.address])
    expectNoMix(seen)
  })

  it('never a mix in a render, for a switch from another window', async () => {
    const selection = { account: FIRST, chainType: ChainType.QBIT_TESTNET4 }
    const wallet = background(selection)
    const store = pageWithFilledForm()
    store.dispatch(globalActions.update({ isUnlocked: true }))
    const { wrapper } = createHookTestHarness({ wallet, store })
    const renders: ReturnType<typeof watch>['seen'] = []
    const { seen, unsubscribe } = watch(store)
    renderHook(
      () => {
        AccountUpdater()
        const address = useCurrentAddress()
        const chainType = useChainType()
        const uiTxCreateScreen = useUiTxCreateScreen()
        const feeRateBar = useFeeRateBar()
        renders.push({
          address,
          chainType,
          form: { ...sendForm(store.getState()), uiTxCreateScreen, feeRateBar },
        })
      },
      { wrapper }
    )
    await waitFor(() => expect(wallet.getCurrentAccount).toHaveBeenCalled())

    selection.chainType = ChainType.QBIT_MAINNET
    selection.account = FIRST_ON_MAINNET
    act(() => {
      uiEventBus.emit(BUS_METHODS.CHAIN_CHANGED, { type: ChainType.QBIT_MAINNET })
    })
    await waitFor(() =>
      expect(store.getState().accounts.current.address).toBe(FIRST_ON_MAINNET.address)
    )
    selection.account = SECOND
    act(() => {
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, SECOND)
    })
    unsubscribe()

    expect(renders.some(render => render.address === SECOND.address)).toBe(true)
    expect(renders.some(render => render.chainType === ChainType.QBIT_MAINNET)).toBe(true)
    expectNoMix(renders)
    expectNoMix(seen)
  })
})

describe('scopeSendForm', () => {
  const filled: UIState = {
    ...initialState,
    ...FILLED_FORM,
    sendFormScope: { address: FIRST.address, chainType: ChainType.QBIT_TESTNET4 },
  }

  it('returns the same state for the recorded account and network, and for no account', () => {
    expect(scopeSendForm(filled, FIRST.address, ChainType.QBIT_TESTNET4)).toBe(filled)
    expect(scopeSendForm(filled, '', ChainType.QBIT_MAINNET)).toBe(filled)
  })

  it('clears only the form, the fee bar and the inputs for another account', () => {
    const state = { ...filled, isBalanceHidden: true, navigationSource: 0 }

    expect(scopeSendForm(state, SECOND.address, ChainType.QBIT_TESTNET4)).toEqual({
      ...state,
      ...INITIAL_FORM,
      sendFormScope: { address: SECOND.address, chainType: ChainType.QBIT_TESTNET4 },
    })
  })

  it('treats a state without a recorded scope as having none', () => {
    const { sendFormScope: _, ...unscoped } = filled

    expect(scopeSendForm(unscoped as UIState, SECOND.address, ChainType.QBIT_MAINNET)).toEqual({
      ...filled,
      sendFormScope: { address: SECOND.address, chainType: ChainType.QBIT_MAINNET },
    })
  })
})
